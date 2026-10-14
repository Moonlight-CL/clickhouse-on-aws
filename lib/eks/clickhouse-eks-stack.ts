import * as fs from 'fs';
import * as path from 'path';
import {
  Aws, CfnCondition, CfnMapping, CfnOutput, CfnParameter, CfnResource, CfnRule, Fn, ICfnConditionExpression, Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { createBackupBucket } from '../backup';
import { ALL_INSTANCE_TYPES, CLICKHOUSE_INSTANCE_TYPES, KEEPER_INSTANCE_TYPES, archOf } from '../instance-types';
import { HEALTH_QUERY, METRIC_NAMESPACE, NodeSlot, createCloudWatchAlarms, createMonitoringInfra } from '../monitoring';
import { createUpdateGuard, dependOnUpdateGuard } from '../update-guard';
import { HELM_VERSION, LBC_CHART_VERSION, OPERATOR_CHART_VERSION, createInstaller } from './installer';
import { createVpc } from './vpc';

export const EKS_MAX_SHARDS = 5;
export const EKS_MAX_REPLICAS = 3;
export const KUBERNETES_VERSIONS = ['1.34', '1.35', '1.36', '1.37'];
const DEFAULT_KUBERNETES_VERSION = '1.36';
/**
 * ClusterName = CHI name = cluster name. The operator truncates the cluster part of object names to 15 characters, and the
 * longest generated name, the per-host ConfigMap volume chi-<name>-deploy-confd-<name>-<shard>-<replica> (2n + 22), must be a
 * DNS label (<= 63). With n <= 15 the StatefulSet chi-<name>-<name>-<s>-<r> is 2n + 9 <= 39 (<= 52 for the
 * controller-revision-hash label) and the host Services stay far below 63.
 */
export const CLUSTER_NAME_MAX_LENGTH = 15;
/** Strict IPv4 CIDR (octets 0-255, prefix 0-32). */
const CIDR_PATTERN = '^((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)/(3[0-2]|[12]?\\d)$';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** EKS Pod Identity trust policy (no OIDC provider / IRSA). */
const POD_IDENTITY_TRUST = {
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow', Principal: { Service: 'pods.eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'],
    Condition: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
  }],
};

export class ClickHouseEksStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.templateOptions.description =
      'ClickHouse cluster on Amazon EKS (Altinity operator, ClickHouse Keeper, EBS gp3, EKS Pod Identity), optional new VPC.';

    // ---------------------------------------------------------------- parameters
    const param = (name: string, o: ConstructorParameters<typeof CfnParameter>[2]) => new CfnParameter(this, name, o);
    const clusterName = param('ClusterName', {
      type: 'String', default: 'clickhouse', allowedPattern: `^[a-z][a-z0-9]{1,${CLUSTER_NAME_MAX_LENGTH - 1}}$`,
      description: `ClickHouse cluster name (ClickHouseInstallation and remote_servers cluster name; lowercase letters/digits, 2-${CLUSTER_NAME_MAX_LENGTH} characters). Cannot be changed after creation.`,
    });
    const version = param('ClickHouseVersion', {
      type: 'String', default: '26.8.24.9', allowedPattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
      description: 'clickhouse/clickhouse-server and clickhouse/clickhouse-keeper image tag. Changing it performs a rolling upgrade.',
    });
    const shardCount = param('ShardCount', { type: 'String', default: '1', allowedValues: range(1, EKS_MAX_SHARDS).map(String), description: 'Number of shards.' });
    const replicaCount = param('ReplicaCount', { type: 'String', default: '2', allowedValues: range(1, EKS_MAX_REPLICAS).map(String), description: 'Replicas per shard (replica N runs in the N-th subnet / AZ).' });
    const keeperCount = param('KeeperCount', { type: 'String', default: '3', allowedValues: ['1', '3'], description: 'ClickHouse Keeper nodes: 3 (HA quorum, one per AZ) or 1 (dev/test).' });

    const k8sVersion = param('KubernetesVersion', { type: 'String', default: DEFAULT_KUBERNETES_VERSION, allowedValues: KUBERNETES_VERSIONS, description: 'EKS Kubernetes version (control plane and node groups; upgrade one minor version at a time).' });
    const publicEndpoint = param('EksPublicEndpoint', { type: 'String', default: 'false', allowedValues: ['true', 'false'], description: 'Also expose the EKS API endpoint publicly (restricted to EksPublicAccessCidrs). The private endpoint is always on.' });
    const publicCidrs = param('EksPublicAccessCidrs', { type: 'CommaDelimitedList', default: '', description: 'CIDRs allowed to reach the public EKS API endpoint (required with EksPublicEndpoint=true; no default).' });
    const adminRoleArn = param('EksAdminRoleArn', { type: 'String', default: '', allowedPattern: '^$|^arn:aws[a-z-]*:iam::\\d{12}:role/.+$', description: 'Optional IAM role ARN granted cluster-admin through an EKS access entry (the stack creator always is).' });

    const chInstanceType = param('ClickHouseInstanceType', { type: 'String', default: 'm7g.2xlarge', allowedValues: CLICKHOUSE_INSTANCE_TYPES, description: 'Instance type of the ClickHouse server node groups (one ClickHouse pod per node).' });
    const keeperInstanceType = param('KeeperInstanceType', { type: 'String', default: 'm7g.large', allowedValues: KEEPER_INSTANCE_TYPES, description: 'Instance type of the Keeper node groups (one Keeper pod per node).' });
    const systemInstanceType = param('SystemInstanceType', { type: 'String', default: 'm7g.large', allowedValues: KEEPER_INSTANCE_TYPES, description: 'Instance type of the 2 system nodes (operator, CoreDNS, controllers, backup/ops jobs).' });
    const serverCpu = param('ClickHouseCpu', { type: 'String', default: 'auto', allowedPattern: '^auto$|^\\d+(\\.\\d+)?$|^\\d+m$', description: 'CPU of each ClickHouse pod (requests = limits, Guaranteed QoS). auto = node allocatable minus 800m for DaemonSets.' });
    const serverMemory = param('ClickHouseMemory', { type: 'String', default: 'auto', allowedPattern: '^auto$|^\\d+(Mi|Gi)$', description: 'Memory of each ClickHouse pod (requests = limits). auto = node allocatable minus 2Gi.' });
    const keeperCpu = param('KeeperCpu', { type: 'String', default: 'auto', allowedPattern: '^auto$|^\\d+(\\.\\d+)?$|^\\d+m$', description: 'CPU of each Keeper pod (requests = limits). auto = node allocatable minus 800m.' });
    const keeperMemory = param('KeeperMemory', { type: 'String', default: 'auto', allowedPattern: '^auto$|^\\d+(Mi|Gi)$', description: 'Memory of each Keeper pod (requests = limits). auto = node allocatable minus 2Gi.' });

    const dataVolumeSize = param('DataVolumeSize', { type: 'Number', default: 200, minValue: 20, maxValue: 16384, description: 'Size (GiB) of each ClickHouse data volume (gp3 PVC, expandable online).' });
    const dataVolumeIops = param('DataVolumeIops', { type: 'Number', default: 3000, minValue: 3000, maxValue: 80000, description: 'gp3 IOPS of each data volume (changed online via a VolumeAttributesClass).' });
    const dataVolumeThroughput = param('DataVolumeThroughput', { type: 'Number', default: 125, minValue: 125, maxValue: 2000, description: 'gp3 throughput (MiB/s) of each data volume.' });
    const keeperVolumeSize = param('KeeperDataVolumeSize', { type: 'Number', default: 20, minValue: 10, maxValue: 1024, description: 'Size (GiB) of each Keeper volume (Raft log + snapshots).' });
    const rootVolumeSize = param('NodeRootVolumeSize', { type: 'Number', default: 30, minValue: 20, maxValue: 1024, description: 'Root volume (GiB) of every EKS node (OS, images, logs; no ClickHouse data).' });

    const createVpcParam = param('CreateVpc', { type: 'String', default: 'false', allowedValues: ['true', 'false'], description: 'true: create a new 3-AZ VPC (public + private subnets, NAT, S3 endpoint). false: use VpcId / SubnetIds.' });
    const vpcCidr = param('VpcCidr', { type: 'String', default: '10.20.0.0/16', allowedPattern: '^(\\d{1,3}\\.){3}\\d{1,3}/16$', description: 'CreateVpc=true: CIDR (/16) of the new VPC.' });
    const natGateways = param('NatGateways', { type: 'String', default: 'PerAz', allowedValues: ['PerAz', 'Single'], description: 'CreateVpc=true: one NAT gateway per AZ (HA) or a single one (cheaper).' });
    const vpcId = param('VpcId', { type: 'String', default: '', description: 'CreateVpc=false: existing VPC (DNS hostnames and support enabled).' });
    const subnetIds = param('SubnetIds', { type: 'CommaDelimitedList', default: '', description: 'CreateVpc=false: private subnets with NAT egress, one per AZ, at least 2 (EKS) and max(ReplicaCount, KeeperCount) with MultiAZ. Replica N / keeper N use the N-th subnet.' });
    const multiAz = param('MultiAZ', { type: 'String', default: 'true', allowedValues: ['true', 'false'], description: 'Spread replicas and Keeper nodes across the subnets (AZs); false puts them all in the first subnet.' });
    const clientCidr = param('ClientCidr', { type: 'String', allowedPattern: CIDR_PATTERN, constraintDescription: 'an IPv4 CIDR such as 10.1.0.0/16', description: 'Required: CIDR of ClickHouse clients (8123/9000, internal NLB and pod IPs).' });
    const clientLb = param('ClientLoadBalancer', { type: 'String', default: 'true', allowedValues: ['true', 'false'], description: 'Internal Network Load Balancer for clients (AWS Load Balancer Controller, IP targets, cross-zone).' });

    const enableBackup = param('EnableBackup', { type: 'String', default: 'true', allowedValues: ['true', 'false'], description: 'Daily ClickHouse BACKUP of each shard to a new S3 bucket (full on Sundays, incremental otherwise).' });
    const backupRetention = param('BackupRetentionDays', { type: 'Number', default: 35, minValue: 8, maxValue: 3650, description: 'Backups expire after this many days (restorable window: this minus 7 days).' });
    const backupTime = param('BackupTimeUTC', { type: 'String', default: '03:00', allowedPattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Daily backup time (HH:MM, UTC).' });
    const systemLogRetention = param('SystemLogRetentionDays', { type: 'Number', default: 30, minValue: 1, maxValue: 3650, description: 'TTL (days) of the system.*_log tables.' });

    const monitoringMode = param('Monitoring', {
      type: 'String', default: 'CloudWatch', allowedValues: ['None', 'CloudWatch', 'Prometheus'],
      description: 'CloudWatch: Container Insights (metrics + logs) and ClickHouse health metrics with alarms and a dashboard. '
        + 'Prometheus: Amazon Managed Service for Prometheus with an agentless managed scraper, alert rules, optional Amazon Managed Grafana.',
    });
    const alarmEmail = param('AlarmEmail', { type: 'String', default: '', allowedPattern: '^$|^[^@\\s]+@[^@\\s]+$', description: 'Optional e-mail subscribed to the alarm SNS topic.' });
    const diskAlarmPercent = param('DiskUsageAlarmPercent', { type: 'Number', default: 80, minValue: 10, maxValue: 99, description: 'Alarm when a data volume is fuller than this percentage.' });
    const logRetention = param('LogRetentionDays', {
      type: 'Number', default: 30,
      allowedValues: ['1', '3', '5', '7', '14', '30', '60', '90', '120', '150', '180', '365', '400', '545', '731', '1827', '3653'],
      description: 'Retention of the stack log group /clickhouse/<stack> (installer logs).',
    });
    const createGrafana = param('CreateGrafanaWorkspace', { type: 'String', default: 'true', allowedValues: ['true', 'false'], description: 'Prometheus mode: also create an Amazon Managed Grafana workspace.' });
    const grafanaAuth = param('GrafanaAuthProvider', {
      type: 'String', default: 'SAML', allowedValues: ['SAML', 'AWS_SSO'],
      description: 'Grafana sign-in. SAML (default) works in any account; AWS_SSO only if IAM Identity Center is enabled for the account/organization.',
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          { Label: { default: 'ClickHouse cluster' }, Parameters: ['ClusterName', 'ClickHouseVersion', 'ShardCount', 'ReplicaCount', 'KeeperCount'] },
          { Label: { default: 'Network' }, Parameters: ['CreateVpc', 'VpcCidr', 'NatGateways', 'VpcId', 'SubnetIds', 'MultiAZ', 'ClientCidr', 'ClientLoadBalancer'] },
          { Label: { default: 'EKS' }, Parameters: ['KubernetesVersion', 'EksPublicEndpoint', 'EksPublicAccessCidrs', 'EksAdminRoleArn'] },
          { Label: { default: 'Compute (one ClickHouse / Keeper pod per node, Guaranteed QoS)' }, Parameters: ['ClickHouseInstanceType', 'KeeperInstanceType', 'SystemInstanceType', 'ClickHouseCpu', 'ClickHouseMemory', 'KeeperCpu', 'KeeperMemory'] },
          { Label: { default: 'Storage' }, Parameters: ['DataVolumeSize', 'DataVolumeIops', 'DataVolumeThroughput', 'KeeperDataVolumeSize', 'NodeRootVolumeSize'] },
          { Label: { default: 'Data protection' }, Parameters: ['EnableBackup', 'BackupRetentionDays', 'BackupTimeUTC', 'SystemLogRetentionDays'] },
          { Label: { default: 'Monitoring and alarms' }, Parameters: ['Monitoring', 'AlarmEmail', 'DiskUsageAlarmPercent', 'LogRetentionDays', 'CreateGrafanaWorkspace', 'GrafanaAuthProvider'] },
        ],
      },
    };

    // ---------------------------------------------------------------- conditions
    const cond = (name: string, expression: ICfnConditionExpression) => new CfnCondition(this, name, { expression });
    const eq = (p: CfnParameter, v: string) => Fn.conditionEquals(p.valueAsString, v);
    const newVpc = cond('CreateNewVpc', eq(createVpcParam, 'true'));
    const natPerAz = cond('NatPerAz', Fn.conditionAnd(newVpc, eq(natGateways, 'PerAz')));
    const isMultiAz = cond('IsMultiAZ', eq(multiAz, 'true'));
    const isPublic = cond('EksPublic', eq(publicEndpoint, 'true'));
    const hasAdminRole = cond('HasEksAdminRole', Fn.conditionNot(eq(adminRoleArn, '')));
    const lbOn = cond('ClientLoadBalancerEnabled', eq(clientLb, 'true'));
    const isCloudWatch = cond('MonitoringCloudWatch', eq(monitoringMode, 'CloudWatch'));
    const isPrometheus = cond('MonitoringPrometheus', eq(monitoringMode, 'Prometheus'));
    const monitoringOn = cond('MonitoringEnabled', Fn.conditionNot(eq(monitoringMode, 'None')));
    const grafanaOn = cond('GrafanaEnabled', Fn.conditionAnd(isPrometheus, eq(createGrafana, 'true')));
    const alarmEmailSet = cond('AlarmEmailSet', Fn.conditionNot(eq(alarmEmail, '')));
    const backupOn = cond('BackupEnabled', eq(enableBackup, 'true'));
    const threeKeepers = cond('ThreeKeepers', eq(keeperCount, '3'));
    const atLeast = (p: CfnParameter, n: number, max: number) => {
      const eqs = range(n, max).map((v) => eq(p, String(v)));
      return eqs.length === 1 ? eqs[0] : Fn.conditionOr(...eqs);
    };
    const replicasAtLeast = new Map(range(2, EKS_MAX_REPLICAS).map((r) => [r, cond(`ReplicasAtLeast${r}`, atLeast(replicaCount, r, EKS_MAX_REPLICAS))]));
    const shardsAtLeast = new Map(range(2, EKS_MAX_SHARDS).map((s) => [s, cond(`ShardsAtLeast${s}`, atLeast(shardCount, s, EKS_MAX_SHARDS))]));

    new CfnRule(this, 'ExistingVpcNeedsIds', {
      ruleCondition: Fn.conditionEquals(createVpcParam.valueAsString, 'false'),
      assertions: [
        { assert: Fn.conditionNot(Fn.conditionEquals(vpcId.valueAsString, '')), assertDescription: 'CreateVpc=false requires VpcId.' },
        { assert: Fn.conditionNot(Fn.conditionEachMemberEquals(subnetIds.valueAsList, '')), assertDescription: 'CreateVpc=false requires SubnetIds.' },
      ],
    });
    new CfnRule(this, 'PublicEndpointNeedsCidrs', {
      ruleCondition: Fn.conditionEquals(publicEndpoint.valueAsString, 'true'),
      assertions: [{
        assert: Fn.conditionNot(Fn.conditionEachMemberEquals(publicCidrs.valueAsList, '')),
        assertDescription: 'EksPublicEndpoint=true requires EksPublicAccessCidrs (the CIDRs allowed to reach the public EKS API).',
      }],
    });

    const archMap = new CfnMapping(this, 'InstanceArch', {
      mapping: Object.fromEntries(ALL_INSTANCE_TYPES.map((t) => [t, { AmiType: archOf(t) === 'arm64' ? 'AL2023_ARM_64_STANDARD' : 'AL2023_x86_64_STANDARD' }])),
    });
    const serverCountMap = new CfnMapping(this, 'ServerCount', {
      mapping: Object.fromEntries(range(1, EKS_MAX_SHARDS).map((s) => [String(s), Object.fromEntries(range(1, EKS_MAX_REPLICAS).map((r) => [String(r), String(s * r)]))])),
    });

    // ---------------------------------------------------------------- network
    const eksName = Aws.STACK_NAME;
    const vpc = createVpc(this, { create: newVpc, natPerAz, cidr: vpcCidr.valueAsString, eksClusterName: eksName });
    const vpcIdEff = Fn.conditionIf(newVpc.logicalId, vpc.vpc.ref, vpcId.valueAsString).toString();
    const baseSubnet = (i: number) => Fn.conditionIf(newVpc.logicalId, vpc.privateSubnets[i].ref, Fn.select(i, subnetIds.valueAsList)).toString();
    /** Subnet of replica / keeper slot n (1-based). */
    const slotSubnet = (n: number) => (n === 1 ? baseSubnet(0) : Fn.conditionIf(isMultiAz.logicalId, baseSubnet(n - 1), baseSubnet(0)).toString());
    const allSubnets = Fn.conditionIf(newVpc.logicalId, vpc.privateSubnets.map((s) => s.ref), subnetIds.valueAsList) as unknown as string[];
    const allSubnetsCsv = Fn.conditionIf(newVpc.logicalId, Fn.join(',', vpc.privateSubnets.map((s) => s.ref)), Fn.join(',', subnetIds.valueAsList)).toString();

    // ---------------------------------------------------------------- secrets and keys
    const adminSecret = new secretsmanager.CfnSecret(this, 'AdminPassword', {
      description: Fn.sub('Password of the ClickHouse "default" user of stack ${AWS::StackName}'),
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });
    const operatorSecret = new secretsmanager.CfnSecret(this, 'OperatorPassword', {
      description: Fn.sub('Password of the clickhouse_operator user (Altinity operator) of stack ${AWS::StackName}'),
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });
    const secretsKey = new kms.CfnKey(this, 'EksSecretsKey', {
      description: Fn.sub('Envelope encryption of Kubernetes secrets of EKS cluster ${AWS::StackName}'),
      enableKeyRotation: true,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [{ Sid: 'AccountAdmin', Effect: 'Allow', Principal: { AWS: Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') }, Action: 'kms:*', Resource: '*' }],
      },
    });

    // ---------------------------------------------------------------- EKS cluster
    const managed = (name: string) => Fn.sub(`arn:\${AWS::Partition}:iam::aws:policy/${name}`);
    const clusterRole = new iam.CfnRole(this, 'EksClusterRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'] }],
      },
      managedPolicyArns: [managed('AmazonEKSClusterPolicy')],
    });
    const cluster = new eks.CfnCluster(this, 'EksCluster', {
      name: eksName,
      version: k8sVersion.valueAsString,
      roleArn: clusterRole.attrArn,
      resourcesVpcConfig: {
        subnetIds: allSubnets,
        endpointPrivateAccess: true,
        endpointPublicAccess: Fn.conditionIf(isPublic.logicalId, true, false) as unknown as boolean,
        publicAccessCidrs: Fn.conditionIf(isPublic.logicalId, publicCidrs.valueAsList, Aws.NO_VALUE) as unknown as string[],
      },
      accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: true },
      bootstrapSelfManagedAddons: false,
      encryptionConfig: [{ provider: { keyArn: secretsKey.attrArn }, resources: ['secrets'] }],
      logging: { clusterLogging: { enabledTypes: [{ type: 'api' }, { type: 'audit' }, { type: 'authenticator' }] } },
      tags: [{ key: 'ch-stack', value: Aws.STACK_NAME }],
    });
    const clusterSg = cluster.attrClusterSecurityGroupId;
    for (const port of [8123, 9000]) {
      new ec2.CfnSecurityGroupIngress(this, `ClientIngress${port}`, {
        groupId: clusterSg, cidrIp: clientCidr.valueAsString, ipProtocol: 'tcp', fromPort: port, toPort: port,
        description: `ClickHouse clients (pod IPs) port ${port}`,
      });
    }
    const adminEntry = new eks.CfnAccessEntry(this, 'EksAdminAccess', {
      clusterName: cluster.ref, principalArn: adminRoleArn.valueAsString,
      accessPolicies: [{ policyArn: Fn.sub('arn:${AWS::Partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy'), accessScope: { type: 'cluster' } }],
    });
    adminEntry.cfnOptions.condition = hasAdminRole;

    // ---------------------------------------------------------------- Pod Identity roles
    const podRole = (id: string, policies: object[] = [], managedPolicies: string[] = []) => new iam.CfnRole(this, id, {
      assumeRolePolicyDocument: POD_IDENTITY_TRUST,
      managedPolicyArns: managedPolicies.length ? managedPolicies : undefined,
      policies: policies.length ? [{ policyName: 'pod', policyDocument: { Version: '2012-10-17', Statement: policies } }] : undefined,
    });
    const cniRole = podRole('VpcCniRole', [], [managed('AmazonEKS_CNI_Policy')]);
    const ebsRole = podRole('EbsCsiRole', [{
      // encrypted volumes with the default aws/ebs key
      Effect: 'Allow', Action: ['kms:CreateGrant', 'kms:Decrypt', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:DescribeKey'], Resource: '*',
      Condition: { StringLike: { 'kms:ViaService': Fn.sub('ec2.${AWS::Region}.amazonaws.com') } },
    }], [managed('service-role/AmazonEBSCSIDriverPolicy')]);
    const cwAgentRole = podRole('CloudWatchAgentRole', [], [managed('CloudWatchAgentServerPolicy'), managed('AWSXrayWriteOnlyAccess')]);
    cwAgentRole.cfnOptions.condition = isCloudWatch;

    const backupBucket = createBackupBucket(this, { enabled: backupOn, retentionDays: backupRetention.valueAsNumber });
    const clickhouseRole = podRole('ClickHouseRole', [
      { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: backupBucket.attrArn },
      {
        Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        Resource: Fn.join('', [backupBucket.attrArn, '/*']),
      },
    ]);
    clickhouseRole.cfnOptions.condition = backupOn;
    const metricsRole = podRole('MetricsPublisherRole', [{
      Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*',
      Condition: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } },
    }]);
    metricsRole.cfnOptions.condition = isCloudWatch;
    const lbcPolicy = JSON.parse(fs.readFileSync(path.join(__dirname, 'policies', 'aws-load-balancer-controller.json'), 'utf8'));
    const lbcRole = podRole('LoadBalancerControllerRole', lbcPolicy.Statement);
    lbcRole.cfnOptions.condition = lbOn;

    const podIdentity = (id: string, namespace: string, serviceAccount: string, role: iam.CfnRole, condition?: CfnCondition) => {
      const a = new eks.CfnPodIdentityAssociation(this, id, { clusterName: cluster.ref, namespace, serviceAccount, roleArn: role.attrArn });
      if (condition) a.cfnOptions.condition = condition;
      return a;
    };
    podIdentity('ClickHousePodIdentity', 'clickhouse', 'clickhouse', clickhouseRole, backupOn);
    podIdentity('MetricsPublisherPodIdentity', 'clickhouse', 'ch-cw-metrics', metricsRole, isCloudWatch);
    const lbcIdentity = podIdentity('LoadBalancerControllerPodIdentity', 'kube-system', 'aws-load-balancer-controller', lbcRole, lbOn);

    // ---------------------------------------------------------------- add-ons needed before nodes can join
    const addon = (id: string, name: string, extra: Partial<eks.CfnAddonProps> = {}) => new eks.CfnAddon(this, id, {
      clusterName: cluster.ref, addonName: name, resolveConflicts: 'OVERWRITE', ...extra,
    });
    const podIdentityAgent = addon('PodIdentityAgentAddon', 'eks-pod-identity-agent');
    const vpcCni = addon('VpcCniAddon', 'vpc-cni', { podIdentityAssociations: [{ serviceAccount: 'aws-node', roleArn: cniRole.attrArn }] });
    vpcCni.addResourceDependency(podIdentityAgent);
    const kubeProxy = addon('KubeProxyAddon', 'kube-proxy');

    // ---------------------------------------------------------------- node groups
    const nodeRole = new iam.CfnRole(this, 'NodeRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      // no CNI policy here: the VPC CNI gets its permissions through EKS Pod Identity
      managedPolicyArns: [managed('AmazonEKSWorkerNodePolicy'), managed('AmazonEC2ContainerRegistryPullOnly'), managed('AmazonSSMManagedInstanceCore')],
    });
    const launchTemplate = (id: string, instanceType: string | undefined, role: string) => new ec2.CfnLaunchTemplate(this, id, {
      launchTemplateData: {
        instanceType,
        blockDeviceMappings: [{ deviceName: '/dev/xvda', ebs: { volumeSize: rootVolumeSize.valueAsNumber, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
        // IMDSv2 only; hop limit 2 so that non-host-network agents (Container Insights) can read instance metadata
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 2, httpEndpoint: 'enabled' },
        tagSpecifications: [{ resourceType: 'instance', tags: [{ key: 'Name', value: Fn.sub(`\${AWS::StackName}-${role}`) }, { key: 'ch-stack', value: Aws.STACK_NAME }] }],
      },
    });
    const ltSystem = launchTemplate('SystemLaunchTemplate', systemInstanceType.valueAsString, 'system');
    // keeper / server: the instance type is a node group property, so changing it replaces the node group (blue/green: the
    // installer moves the pods to the new nodes one at a time before CloudFormation deletes the old group). An in-place
    // rolling update with a smaller type would deadlock: the drained pods' requests do not fit the new nodes.
    const ltKeeper = launchTemplate('KeeperLaunchTemplate', undefined, 'keeper');
    const ltServer = launchTemplate('ServerLaunchTemplate', undefined, 'server');

    const nodegroups: eks.CfnNodegroup[] = [];
    const nodegroup = (id: string, o: {
      lt: ec2.CfnLaunchTemplate; instanceType: string; subnets: string[]; size: string | number; maxSize?: string | number;
      role: string; slot?: number; condition?: CfnCondition; after?: CfnResource;
    }) => {
      // no NodegroupName: CloudFormation generates a new one, so a replacement can be created next to the old group
      const ng = new eks.CfnNodegroup(this, id, {
        clusterName: cluster.ref,
        nodeRole: nodeRole.attrArn,
        subnets: o.subnets,
        amiType: archMap.findInMap(o.instanceType, 'AmiType'),
        instanceTypes: o.role === 'system' ? undefined : [o.instanceType],
        version: k8sVersion.valueAsString,
        launchTemplate: { id: o.lt.ref, version: o.lt.attrLatestVersionNumber },
        scalingConfig: { minSize: o.size as number, desiredSize: o.size as number, maxSize: (o.maxSize ?? o.size) as number },
        updateConfig: { maxUnavailable: 1 },
        labels: { 'clickhouse-on-aws/role': o.role, ...(o.slot ? { 'clickhouse-on-aws/slot': String(o.slot) } : {}) },
        taints: o.role === 'system' ? undefined : [{ key: 'clickhouse-on-aws/dedicated', value: o.role, effect: 'NO_SCHEDULE' }],
        tags: { 'ch-stack': Aws.STACK_NAME },
      });
      ng.addResourceDependency(vpcCni);
      ng.addResourceDependency(kubeProxy);
      if (o.condition) ng.cfnOptions.condition = o.condition;
      // one node group of a role at a time (rolling updates, replacements); the previous slot exists whenever this one
      // does (slot n's condition implies slot n-1's), so the DependsOn never points at a resource whose condition is false
      if (o.after) ng.addResourceDependency(o.after);
      nodegroups.push(ng);
      return ng;
    };
    const systemNg = nodegroup('SystemNodeGroup', { lt: ltSystem, instanceType: systemInstanceType.valueAsString, subnets: allSubnets, size: 2, maxSize: 4, role: 'system' });
    let prevKeeper: CfnResource | undefined;
    for (const k of range(1, 3)) {
      // one node group per AZ: a replaced node comes back in the AZ of its EBS volume
      prevKeeper = nodegroup(`KeeperNodeGroup${k}`, {
        lt: ltKeeper, instanceType: keeperInstanceType.valueAsString, subnets: [slotSubnet(k)], size: 1, role: 'keeper', slot: k,
        condition: k === 1 ? undefined : threeKeepers, after: prevKeeper,
      });
    }
    let prevServer: CfnResource | undefined;
    for (const r of range(1, EKS_MAX_REPLICAS)) {
      prevServer = nodegroup(`ServerNodeGroup${r}`, {
        lt: ltServer, instanceType: chInstanceType.valueAsString, subnets: [slotSubnet(r)], size: shardCount.valueAsString,
        maxSize: EKS_MAX_SHARDS, role: 'server', slot: r, condition: replicasAtLeast.get(r), after: prevServer,
      });
    }

    // ---------------------------------------------------------------- add-ons that need nodes
    const coreDns = addon('CoreDnsAddon', 'coredns', { configurationValues: JSON.stringify({ nodeSelector: { 'clickhouse-on-aws/role': 'system' } }) });
    coreDns.addResourceDependency(systemNg);
    const ebsCsi = addon('EbsCsiAddon', 'aws-ebs-csi-driver', {
      podIdentityAssociations: [{ serviceAccount: 'ebs-csi-controller-sa', roleArn: ebsRole.attrArn }],
      configurationValues: JSON.stringify({ controller: { nodeSelector: { 'clickhouse-on-aws/role': 'system' } } }),
    });
    ebsCsi.addResourceDependency(systemNg);
    const snapshotController = addon('SnapshotControllerAddon', 'snapshot-controller');
    snapshotController.addResourceDependency(systemNg);
    const metricsServer = addon('MetricsServerAddon', 'metrics-server');
    metricsServer.addResourceDependency(systemNg);
    const cwObservability = addon('CloudWatchObservabilityAddon', 'amazon-cloudwatch-observability', {
      podIdentityAssociations: [{ serviceAccount: 'cloudwatch-agent', roleArn: cwAgentRole.attrArn }],
    });
    cwObservability.cfnOptions.condition = isCloudWatch;
    cwObservability.addResourceDependency(systemNg);

    // ---------------------------------------------------------------- monitoring infrastructure
    const ci = (metric: string) => [{
      expression: `SEARCH('{ContainerInsights,ClusterName,Namespace,PodName} MetricName="${metric}" ClusterName="${Aws.STACK_NAME}" Namespace="clickhouse"', 'Average', 60)`,
      id: `ci${metric.replace(/[^a-z]/g, '')}`,
    }];
    const monitoringProps = {
      cloudWatch: isCloudWatch, prometheus: isPrometheus, enabled: monitoringOn, grafana: grafanaOn,
      alarmEmailSet, backupEnabled: backupOn,
      alarmEmail: alarmEmail.valueAsString,
      logRetentionDays: logRetention.valueAsNumber,
      grafanaAuthProvider: grafanaAuth.valueAsString,
      diskUsageAlarmPercent: diskAlarmPercent.valueAsString,
      expectedServers: serverCountMap.findInMap(shardCount.valueAsString, replicaCount.valueAsString),
      expectedKeepers: keeperCount.valueAsString,
      platform: 'eks' as const,
      diskUsedExpr: '100 * (1 - ClickHouseAsyncMetrics_DiskAvailable{disk="default"} / ClickHouseAsyncMetrics_DiskTotal{disk="default"})',
      cpuMemoryWidgets: { cpu: [ci('pod_cpu_utilization_over_pod_limit')], memory: [ci('pod_memory_utilization_over_pod_limit')] },
    };
    const monitoring = createMonitoringInfra(this, monitoringProps);

    // agentless Prometheus collection: AWS managed scraper inside the VPC (no Prometheus or credentials in the cluster;
    // ops_monitor is password-less and only accepted from the VPC CIDRs)
    const scrapeConfig = Fn.sub(SCRAPE_CONFIG_YAML);
    const scraper = new aps.CfnScraper(this, 'PrometheusScraper', {
      alias: Fn.sub('${AWS::StackName}-clickhouse'),
      source: { eksConfiguration: { clusterArn: cluster.attrArn, subnetIds: allSubnets, securityGroupIds: [clusterSg] } },
      destination: { ampConfiguration: { workspaceArn: monitoring.workspace.attrArn } },
      scrapeConfiguration: { configurationBlob: scrapeConfig },
    });
    scraper.cfnOptions.condition = isPrometheus;

    // ---------------------------------------------------------------- installer (Helm charts + ClickHouse manifests)
    const installer = createInstaller(this, {
      vpcId: vpcIdEff,
      subnetIds: [slotSubnet(1), baseSubnet(1)],
      eksClusterName: cluster.ref,
      eksClusterArn: cluster.attrArn,
      clusterSecurityGroupId: clusterSg,
      secretArns: [adminSecret.ref, operatorSecret.ref],
      logGroupName: monitoring.logGroup.ref,
      config: {
        Region: Aws.REGION, StackName: Aws.STACK_NAME, EksClusterName: cluster.ref, KubernetesVersion: k8sVersion.valueAsString,
        VpcId: vpcIdEff, SubnetIds: allSubnetsCsv,
        ClusterName: clusterName.valueAsString, ClickHouseVersion: version.valueAsString,
        ShardCount: shardCount.valueAsString, ReplicaCount: replicaCount.valueAsString, KeeperCount: keeperCount.valueAsString,
        ServerCpu: serverCpu.valueAsString, ServerMemory: serverMemory.valueAsString,
        KeeperCpu: keeperCpu.valueAsString, KeeperMemory: keeperMemory.valueAsString,
        DataVolumeSize: dataVolumeSize.valueAsString, DataVolumeIops: dataVolumeIops.valueAsString,
        DataVolumeThroughput: dataVolumeThroughput.valueAsString, KeeperDataVolumeSize: keeperVolumeSize.valueAsString,
        ClientCidr: clientCidr.valueAsString, ClientLoadBalancer: clientLb.valueAsString,
        EnableBackup: enableBackup.valueAsString,
        BackupBucket: Fn.conditionIf(backupOn.logicalId, backupBucket.ref, '').toString(),
        BackupTimeUTC: backupTime.valueAsString, SystemLogRetentionDays: systemLogRetention.valueAsString,
        Monitoring: monitoringMode.valueAsString, MetricNamespace: METRIC_NAMESPACE,
        AdminSecretArn: adminSecret.ref, OperatorSecretArn: operatorSecret.ref,
        OperatorChartVersion: OPERATOR_CHART_VERSION, LbcChartVersion: LBC_CHART_VERSION, HelmVersion: HELM_VERSION,
        // the installer computes 'auto' resources from, and moves the pods to, nodes of these types in these node groups
        KeeperInstanceType: keeperInstanceType.valueAsString, ClickHouseInstanceType: chInstanceType.valueAsString,
        // names of the current node groups (a replaced group gets a new name, so the installer re-runs); the references
        // are also the dependencies on node groups that exist only under a condition
        NodeGroups: Fn.join(',', nodegroups.map((ng) => (ng.cfnOptions.condition
          ? Fn.conditionIf(ng.cfnOptions.condition.logicalId, ng.attrNodegroupName, '').toString() : ng.attrNodegroupName))),
      },
      dependsOn: [coreDns, ebsCsi, snapshotController, metricsServer],
    });
    const installerAccess = new eks.CfnAccessEntry(this, 'InstallerAccess', {
      clusterName: cluster.ref, principalArn: installer.role.attrArn,
      accessPolicies: [{ policyArn: Fn.sub('arn:${AWS::Partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy'), accessScope: { type: 'cluster' } }],
    });
    installer.resource.addResourceDependency(installerAccess);
    installer.resource.addResourceDependency(this.node.findChild('InstallerToEksApi') as CfnResource);
    // the installer needs the Pod Identity of the load balancer controller (when enabled); it is deleted first, so
    // AWS resources created from inside Kubernetes (NLB) are removed while the controller still runs.
    // (the reference creates the dependency only when the association exists)
    installer.resource.addPropertyOverride('LoadBalancerControllerIdentity', Fn.conditionIf(lbOn.logicalId, lbcIdentity.attrAssociationArn, ''));

    // ---------------------------------------------------------------- CloudWatch alarms + dashboard (same as EC2)
    const slots: NodeSlot[] = [];
    for (let k = 1; k <= 3; k++) slots.push({ logicalId: `Keeper${k}`, host: `keeper-${k}`, role: 'keeper', condition: k === 1 ? undefined : threeKeepers });
    for (let s = 1; s <= EKS_MAX_SHARDS; s++) {
      for (let r = 1; r <= EKS_MAX_REPLICAS; r++) {
        const sc = s === 1 ? undefined : shardsAtLeast.get(s)!;
        const rc = r === 1 ? undefined : replicasAtLeast.get(r)!;
        const condition = sc && rc ? cond(`SlotS${s}R${r}`, Fn.conditionAnd(sc, rc)) : (sc ?? rc);
        slots.push({ logicalId: `ChS${s}R${r}`, host: `ch-s${s}-r${r}`, role: 'clickhouse', condition });
      }
    }
    createCloudWatchAlarms(this, monitoring, monitoringProps, slots, installer.resource);

    // ---------------------------------------------------------------- outputs
    const out = (id: string, value: string, description: string, condition?: CfnCondition) =>
      new CfnOutput(this, id, { value, description, condition });
    out('EksClusterName', cluster.ref, 'EKS cluster');
    out('KubeconfigCommand', Fn.sub('aws eks update-kubeconfig --region ${AWS::Region} --name ${EksCluster}'), 'kubectl access (from inside the VPC, or with EksPublicEndpoint=true)');
    out('ClickHouseEndpoint', installer.resource.getAtt('Endpoint').toString(), 'Client endpoint (internal NLB DNS name, or in-cluster service) on ports 8123 (HTTP) and 9000 (native)');
    out('AdminPasswordSecretArn', adminSecret.ref, 'Secrets Manager secret with the password of the "default" user');
    out('PasswordCommand', Fn.sub('aws secretsmanager get-secret-value --region ${AWS::Region} --secret-id ${AdminPassword} --query SecretString --output text'), 'Prints the "default" user password');
    out('VpcIdOutput', vpcIdEff, 'VPC of the cluster');
    out('InstallerProjectName', installer.project.ref, 'CodeBuild project that installs/upgrades the ClickHouse cluster (logs: /clickhouse/<stack>, stream installer/...)');
    out('MonitoringMode', monitoringMode.valueAsString, 'Selected monitoring mode');
    out('AlarmTopicArn', monitoring.topic.ref, 'SNS topic of all alarms', monitoringOn);
    out('CloudWatchDashboardUrl', Fn.sub('https://${AWS::Region}.console.aws.amazon.com/cloudwatch/home?region=${AWS::Region}#dashboards/dashboard/${AWS::StackName}-clickhouse'), 'ClickHouse dashboard', isCloudWatch);
    out('ContainerInsightsUrl', Fn.sub('https://${AWS::Region}.console.aws.amazon.com/cloudwatch/home?region=${AWS::Region}#container-insights:infrastructure/map?~(query~(controls~(CW*3a*3aEKS.cluster~(~\'${EksCluster})))~context~())'), 'Container Insights of the EKS cluster', isCloudWatch);
    out('PrometheusWorkspaceId', monitoring.workspace.attrWorkspaceId, 'Amazon Managed Service for Prometheus workspace', isPrometheus);
    out('PrometheusQueryEndpoint', Fn.join('', [monitoring.workspace.attrPrometheusEndpoint, 'api/v1/query']), 'PromQL query endpoint (SigV4, service aps)', isPrometheus);
    out('GrafanaUrl', Fn.join('', ['https://', monitoring.grafanaWorkspace.attrEndpoint]), 'Amazon Managed Grafana (import docs/grafana/clickhouse-cluster-dashboard.json)', grafanaOn);
    out('BackupBucketName', backupBucket.ref, 'S3 bucket with the backups (retained when the stack is deleted)', backupOn);
    out('BackupLocation', Fn.sub('s3://${BackupBucket}/${AWS::StackName}/shard-<N>/'), 'Backups of shard N', backupOn);

    // ---------------------------------------------------------------- update guard (updated, and checked, before anything else)
    // immutable: renaming the CHI renames every host (new empty cluster); KeeperCount changes the Raft membership; the network
    // parameters and MultiAZ select the subnet (= AZ) of each keeper / replica node group, and the EBS volumes cannot follow a
    // pod into another AZ (it would stay Pending).
    const guard = createUpdateGuard(this, {
      immutable: {
        ClusterName: clusterName.valueAsString, KeeperCount: keeperCount.valueAsString, CreateVpc: createVpcParam.valueAsString,
        VpcCidr: vpcCidr.valueAsString, VpcId: vpcId.valueAsString, SubnetIds: Fn.join(',', subnetIds.valueAsList),
        MultiAZ: multiAz.valueAsString,
      },
      noDecrease: {
        ShardCount: shardCount.valueAsString, DataVolumeSize: dataVolumeSize.valueAsString, KeeperDataVolumeSize: keeperVolumeSize.valueAsString,
      },
      noDowngrade: { ClickHouseVersion: version.valueAsString, KubernetesVersion: k8sVersion.valueAsString },
    });
    dependOnUpdateGuard(this, guard);
  }
}

// AWS managed scraper configuration: ClickHouse servers and Keepers expose /metrics on 9363 (the pods are selected by
// the ch-role label and their first container port); replica 1 of each shard also serves /ops-metrics (backup age);
// clickhouse-health runs HEALTH_QUERY on every server. kubelet (PVC usage) and cAdvisor (container memory, OOM kills,
// restarts, I/O) are scraped through the API server proxy, as in the AWS sample configuration (the aps-collector-role
// ClusterRole of install.sh grants nodes/proxy and nodes/metrics); only the series of namespace clickhouse are kept.
const kubeletJob = (job: string, path: string, keep: string) => `  - job_name: ${job}
    scheme: https
    authorization: { type: Bearer, credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token }
    kubernetes_sd_configs: [{ role: node }]
    relabel_configs:
      - { target_label: __address__, replacement: 'kubernetes.default.svc:443' }
      - { source_labels: [__meta_kubernetes_node_name], regex: '(.+)', target_label: __metrics_path__, replacement: '/api/v1/nodes/$1/proxy${path}' }
      - { source_labels: [__meta_kubernetes_node_name], target_label: instance }
      - { source_labels: [__meta_kubernetes_node_label_clickhouse_on_aws_role], target_label: node_role }
      - { target_label: cluster, replacement: '\${AWS::StackName}' }
    metric_relabel_configs:
      - { source_labels: [__name__, namespace], regex: '${keep};clickhouse', action: keep }
`;
const SCRAPE_CONFIG_YAML = `global:
  scrape_interval: 30s
scrape_configs:
  - job_name: clickhouse
    kubernetes_sd_configs: [{ role: pod }]
    relabel_configs:
      - { source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_pod_label_ch_role, __meta_kubernetes_pod_container_port_number], regex: 'clickhouse;server;8123', action: keep }
      - { source_labels: [__meta_kubernetes_pod_ip], target_label: __address__, replacement: '$1:9363' }
      - { source_labels: [__meta_kubernetes_pod_label_ch_node], target_label: node }
      - { target_label: cluster, replacement: '\${AWS::StackName}' }
  - job_name: keeper
    kubernetes_sd_configs: [{ role: pod }]
    relabel_configs:
      - { source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_pod_label_ch_role, __meta_kubernetes_pod_container_port_number], regex: 'clickhouse;keeper;2181', action: keep }
      - { source_labels: [__meta_kubernetes_pod_ip], target_label: __address__, replacement: '$1:9363' }
      - { source_labels: [__meta_kubernetes_pod_label_ch_node], target_label: node }
      - { target_label: cluster, replacement: '\${AWS::StackName}' }
  - job_name: clickhouse-ops
    metrics_path: /ops-metrics
    params: { user: [ops_monitor] }
    kubernetes_sd_configs: [{ role: pod }]
    relabel_configs:
      - { source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_pod_label_ch_backup_host, __meta_kubernetes_pod_container_port_number], regex: 'clickhouse;true;8123', action: keep }
      - { source_labels: [__meta_kubernetes_pod_label_ch_node], target_label: node }
      - { target_label: cluster, replacement: '\${AWS::StackName}' }
  - job_name: clickhouse-health
    metrics_path: /
    params: { user: [ops_monitor], query: ["${HEALTH_QUERY}"] }
    kubernetes_sd_configs: [{ role: pod }]
    relabel_configs:
      - { source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_pod_label_ch_role, __meta_kubernetes_pod_container_port_number], regex: 'clickhouse;server;8123', action: keep }
      - { source_labels: [__meta_kubernetes_pod_label_ch_node], target_label: node }
      - { target_label: cluster, replacement: '\${AWS::StackName}' }
${kubeletJob('kubelet', '/metrics', 'kubelet_volume_stats_(capacity|available|used)_bytes')}${kubeletJob('cadvisor', '/metrics/cadvisor',
    '(container_cpu_usage_seconds_total|container_memory_working_set_bytes|container_spec_memory_limit_bytes|container_oom_events_total'
    + '|container_start_time_seconds|container_fs_reads_bytes_total|container_fs_writes_bytes_total)')}`;
