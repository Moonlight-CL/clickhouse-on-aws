import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { CfnCustomResource, CfnResource, Fn } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/** Pinned versions of what the installer deploys (Helm charts and the Helm CLI). */
export const OPERATOR_CHART_VERSION = '0.27.4'; // Altinity clickhouse-operator
export const LBC_CHART_VERSION = '3.6.0'; // AWS Load Balancer Controller v3.6.0
export const HELM_VERSION = 'v3.22.0';

const INSTALLER_FILES = ['install.sh', 'render.py', 'ch-backup.sh', 'ch-log-ttl.sh', 'ch-cw-metrics.sh'];

/** The installer scripts as one gzip+base64 JSON bundle {file: content} (the template stays self-contained). */
export function installerBundle(): string {
  const files = Object.fromEntries(INSTALLER_FILES.map((f) => [f, fs.readFileSync(path.join(__dirname, 'installer', f), 'utf8')]));
  return zlib.gzipSync(JSON.stringify(files), { level: 9 }).toString('base64');
}

export interface InstallerProps {
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly eksClusterName: string;
  readonly eksClusterArn: string;
  readonly clusterSecurityGroupId: string;
  readonly secretArns: string[];
  readonly logGroupName: string;
  /** CloudFormation properties of the custom resource = the installer CONFIG (strings only). */
  readonly config: Record<string, string>;
  readonly dependsOn: CfnResource[];
}

export interface Installer {
  readonly resource: CfnCustomResource;
  readonly role: iam.CfnRole;
  readonly project: codebuild.CfnProject;
}

/**
 * CloudFormation waits at most this long (seconds, the maximum) for the installer's answer. The installer stops its waits
 * DEADLINE_MARGIN seconds earlier and reports a failure itself.
 */
export const SERVICE_TIMEOUT = 3600;
const DEADLINE_MARGIN = 240;

// Starts the CodeBuild installer and returns; the build reports to CloudFormation itself. Only a failure to start
// the build is reported from here.
const LAMBDA_CODE = `import json, os, time, urllib.request
import boto3

def send(e, status, reason):
    body = json.dumps({"Status": status, "Reason": reason, "PhysicalResourceId": e.get("PhysicalResourceId") or os.environ["PHYSICAL_ID"],
                       "StackId": e["StackId"], "RequestId": e["RequestId"], "LogicalResourceId": e["LogicalResourceId"]}).encode()
    urllib.request.urlopen(urllib.request.Request(e["ResponseURL"], data=body, method="PUT", headers={"Content-Type": ""}))

def handler(e, c):
    try:
        props = {k: v for k, v in e["ResourceProperties"].items() if k not in ("ServiceToken", "ServiceTimeout")}
        env = {"REQUEST_TYPE": e["RequestType"], "RESPONSE_URL": e["ResponseURL"], "STACK_ID": e["StackId"],
               "REQUEST_ID": e["RequestId"], "LOGICAL_ID": e["LogicalResourceId"],
               "PHYSICAL_ID": e.get("PhysicalResourceId") or os.environ["PHYSICAL_ID"], "CONFIG": json.dumps(props),
               # the installer must answer before the ServiceTimeout (counted from now) expires
               "DEADLINE": str(int(time.time()) + ${SERVICE_TIMEOUT - DEADLINE_MARGIN})}
        b = boto3.client("codebuild").start_build(projectName=os.environ["PROJECT"],
            environmentVariablesOverride=[{"name": k, "value": v, "type": "PLAINTEXT"} for k, v in env.items()])
        print("started build", b["build"]["id"], "for", e["RequestType"])
    except Exception as x:
        print("failed:", x)
        send(e, "FAILED", "could not start the installer build: " + str(x)[:500])
`;

/**
 * Lambda-backed custom resource that runs the CodeBuild installer (kubectl/helm against the EKS API from inside
 * the VPC, so a private-only API endpoint works). Create/Update install or upgrade, Delete uninstalls.
 */
export function createInstaller(scope: Construct, p: InstallerProps): Installer {
  const sg = new ec2.CfnSecurityGroup(scope, 'InstallerSecurityGroup', {
    groupDescription: 'ClickHouse installer (CodeBuild) - egress only',
    vpcId: p.vpcId,
    securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
  });
  new ec2.CfnSecurityGroupIngress(scope, 'InstallerToEksApi', {
    groupId: p.clusterSecurityGroupId, sourceSecurityGroupId: sg.attrGroupId,
    ipProtocol: 'tcp', fromPort: 443, toPort: 443, description: 'ClickHouse installer to the EKS API',
  });

  const role = new iam.CfnRole(scope, 'InstallerRole', {
    assumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'codebuild.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    },
    policies: [{
      policyName: 'installer',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['eks:DescribeCluster'], Resource: p.eksClusterArn },
          { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: p.secretArns },
          {
            Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: Fn.sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${G}:*', { G: p.logGroupName }),
          },
          {
            Effect: 'Allow',
            Action: ['ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:DescribeDhcpOptions',
              'ec2:DescribeNetworkInterfaces', 'ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'],
            Resource: '*',
          },
          {
            Effect: 'Allow', Action: 'ec2:CreateNetworkInterfacePermission',
            Resource: Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:network-interface/*'),
            Condition: { StringEquals: { 'ec2:AuthorizedService': 'codebuild.amazonaws.com' } },
          },
        ],
      },
    }],
  });

  const buildspec = [
    'version: 0.2',
    'phases:',
    '  build:',
    '    commands:',
    '      - mkdir -p /tmp/installer && cd /tmp/installer',
    `      - python3 -c "import base64,gzip,json; [open(k,'w').write(v) for k,v in json.loads(gzip.decompress(base64.b64decode('${installerBundle()}'))).items()]"`,
    '      - bash /tmp/installer/install.sh',
    '  post_build:',
    '    commands:',
    // the build failed before install.sh could report (e.g. killed): tell CloudFormation instead of letting it wait
    "      - '[ -f /tmp/responded ] || bash /tmp/installer/install.sh report-failure'",
    '',
  ].join('\n');

  const project = new codebuild.CfnProject(scope, 'InstallerProject', {
    description: Fn.sub('Installs/upgrades/removes the ClickHouse cluster on EKS cluster ${C}', { C: p.eksClusterName }),
    serviceRole: role.attrArn,
    source: { type: 'NO_SOURCE', buildSpec: buildspec },
    artifacts: { type: 'NO_ARTIFACTS' },
    environment: {
      type: 'LINUX_CONTAINER', computeType: 'BUILD_GENERAL1_SMALL',
      image: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
    },
    timeoutInMinutes: 60,
    vpcConfig: { vpcId: p.vpcId, subnets: p.subnetIds, securityGroupIds: [sg.attrGroupId] },
    logsConfig: { cloudWatchLogs: { status: 'ENABLED', groupName: p.logGroupName, streamName: 'installer' } },
  });

  const fnRole = new iam.CfnRole(scope, 'InstallerTriggerRole', {
    assumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    },
    managedPolicyArns: [Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
    policies: [{
      policyName: 'start-build',
      policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'codebuild:StartBuild', Resource: project.attrArn }] },
    }],
  });
  const fn = new lambda.CfnFunction(scope, 'InstallerTrigger', {
    runtime: 'python3.13', handler: 'index.handler', timeout: 60, role: fnRole.attrArn,
    code: { zipFile: LAMBDA_CODE },
    environment: { variables: { PROJECT: project.ref, PHYSICAL_ID: Fn.sub('${AWS::StackName}-clickhouse') } },
  });

  const resource = new CfnCustomResource(scope, 'ClusterInstall', { serviceToken: fn.attrArn });
  resource.addPropertyOverride('ServiceTimeout', SERVICE_TIMEOUT);
  // a new template version with changed installer scripts re-runs the installer
  resource.addPropertyOverride('InstallerVersion', crypto.createHash('sha256').update(installerBundle()).digest('hex').slice(0, 16));
  for (const [k, v] of Object.entries(p.config)) resource.addPropertyOverride(k, v);
  for (const d of p.dependsOn) resource.addResourceDependency(d);
  return { resource, role, project };
}
