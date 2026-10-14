import {
  Aws, CfnCondition, CfnDeletionPolicy, CfnMapping, CfnOutput, CfnParameter, CfnResource, CfnWaitCondition, Fn,
  ICfnConditionExpression, Stack, StackProps, Validations,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { createBackupBucket } from './backup';
import { ALL_INSTANCE_TYPES, CLICKHOUSE_INSTANCE_TYPES, KEEPER_INSTANCE_TYPES, archOf } from './instance-types';
import { METRIC_NAMESPACE, NodeSlot, createCloudWatchAlarms, createMonitoringInfra } from './monitoring';
import { createNodeConfig, readScript } from './node-config';
import { createUpdateGuard, dependOnUpdateGuard } from './update-guard';

/** Upper bounds of the one-click template; every slot up to these is declared and gated by a Condition. */
export const MAX_SHARDS = 5;
export const MAX_REPLICAS = 3;
export const KEEPER_COUNTS = [1, 3];
const MAX_KEEPERS = Math.max(...KEEPER_COUNTS);

const CLUSTER_PORTS = [9000, 8123, 9009, 9181, 9234];
const CLIENT_PORTS = [8123, 9000];

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export class ClickHouseClusterStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.templateOptions.description =
      'ClickHouse cluster on Amazon EC2 with ClickHouse Keeper (shards x replicas, optional multi-AZ).';

    // ---------------------------------------------------------------- parameters
    const clusterName = new CfnParameter(this, 'ClusterName', {
      type: 'String',
      default: 'clickhouse',
      allowedPattern: '^[a-z][a-z0-9]{1,30}$',
      description: 'Cluster name used in remote_servers, macros and the private DNS zone <name>.clickhouse.internal (lowercase letters/digits).',
    });
    const version = new CfnParameter(this, 'ClickHouseVersion', {
      type: 'String',
      default: '26.8.24.9',
      allowedPattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
      description: 'Exact ClickHouse version (see https://github.com/ClickHouse/ClickHouse/releases), e.g. 26.8.24.9. Also used for Keeper.',
    });
    const chInstanceType = new CfnParameter(this, 'ClickHouseInstanceType', {
      type: 'String',
      default: 'm7g.2xlarge',
      allowedValues: CLICKHOUSE_INSTANCE_TYPES,
      description: 'EC2 instance type of ClickHouse server nodes (Graviton *g types use arm64 AMIs automatically).',
    });
    const keeperInstanceType = new CfnParameter(this, 'KeeperInstanceType', {
      type: 'String',
      default: 't4g.medium',
      allowedValues: KEEPER_INSTANCE_TYPES,
      description: 'EC2 instance type of ClickHouse Keeper nodes.',
    });
    const shardCount = new CfnParameter(this, 'ShardCount', {
      type: 'String',
      default: '1',
      allowedValues: range(1, MAX_SHARDS).map(String),
      description: 'Number of shards.',
    });
    const replicaCount = new CfnParameter(this, 'ReplicaCount', {
      type: 'String',
      default: '2',
      allowedValues: range(1, MAX_REPLICAS).map(String),
      description: 'Number of replicas per shard.',
    });
    const keeperCount = new CfnParameter(this, 'KeeperCount', {
      type: 'String',
      default: '3',
      allowedValues: KEEPER_COUNTS.map(String),
      description: 'Number of dedicated ClickHouse Keeper nodes: 3 for HA (Raft quorum), 1 for dev/test.',
    });
    const vpcId = new CfnParameter(this, 'VpcId', {
      type: 'AWS::EC2::VPC::Id',
      description: 'Existing VPC (DNS support and DNS hostnames must be enabled).',
    });
    const subnetIds = new CfnParameter(this, 'SubnetIds', {
      type: 'List<AWS::EC2::Subnet::Id>',
      description:
        'Subnets of the VPC, preferably private with NAT egress (nodes download packages). MultiAZ=true: give one subnet per AZ, '
        + 'at least max(ReplicaCount, KeeperCount); replica N and keeper N go to the N-th subnet. MultiAZ=false: only the first subnet is used.',
    });
    const multiAz = new CfnParameter(this, 'MultiAZ', {
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
      description: 'Spread replicas and Keeper nodes across the subnets (AZs) listed in SubnetIds.',
    });
    const systemVolumeSize = new CfnParameter(this, 'SystemVolumeSize', {
      type: 'Number',
      default: 30,
      minValue: 20,
      maxValue: 1024,
      description: 'Size (GiB) of the encrypted gp3 system (root) volume of every node: OS, packages, logs. Data is never stored here.',
    });
    const dataVolumeSize = new CfnParameter(this, 'DataVolumeSize', {
      type: 'Number',
      default: 200,
      minValue: 20,
      maxValue: 16384,
      description: 'Size (GiB) of the separate encrypted gp3 data volume mounted at /var/lib/clickhouse on each ClickHouse node.',
    });
    const dataVolumeIops = new CfnParameter(this, 'DataVolumeIops', {
      type: 'Number',
      default: 3000,
      minValue: 3000,
      maxValue: 80000,
      description: 'Provisioned IOPS of each ClickHouse data volume (gp3 baseline 3000; at most 500 IOPS per GiB).',
    });
    const dataVolumeThroughput = new CfnParameter(this, 'DataVolumeThroughput', {
      type: 'Number',
      default: 125,
      minValue: 125,
      maxValue: 2000,
      description: 'Throughput (MiB/s) of each ClickHouse data volume (gp3 baseline 125; at most 0.25 MiB/s per IOPS).',
    });
    const keeperDataVolumeSize = new CfnParameter(this, 'KeeperDataVolumeSize', {
      type: 'Number',
      default: 20,
      minValue: 10,
      maxValue: 1024,
      description: 'Size (GiB) of the separate encrypted gp3 volume for Keeper Raft logs/snapshots on each Keeper node.',
    });
    const clientCidr = new CfnParameter(this, 'ClientCidr', {
      type: 'String',
      allowedPattern: '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$',
      constraintDescription: 'must be an IPv4 CIDR such as 10.1.0.0/16',
      description: 'Required. CIDR allowed to reach ClickHouse HTTP (8123) and native (9000) ports: the application subnets, at most the VPC CIDR.',
    });
    const armAmi = new CfnParameter(this, 'Arm64AmiId', {
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      description: 'Amazon Linux 2023 arm64 AMI (SSM parameter) for Graviton instances.',
    });
    const x86Ami = new CfnParameter(this, 'X86AmiId', {
      type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      description: 'Amazon Linux 2023 x86_64 AMI (SSM parameter) for Intel/AMD instances.',
    });

    // operations: data protection
    const terminationProtection = new CfnParameter(this, 'EnableTerminationProtection', {
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
      description: 'EC2 termination protection on all nodes (set to false, update the stack, then delete it when you really want to remove the cluster).',
    });
    const systemLogRetention = new CfnParameter(this, 'SystemLogRetentionDays', {
      type: 'Number',
      default: 30,
      minValue: 1,
      maxValue: 3650,
      description: 'TTL (days) of the system.*_log tables (query_log, part_log, metric_log, trace_log, ...), which otherwise grow forever.',
    });
    // operations: monitoring
    const monitoringMode = new CfnParameter(this, 'Monitoring', {
      type: 'String',
      default: 'CloudWatch',
      allowedValues: ['None', 'CloudWatch', 'Prometheus'],
      description: 'CloudWatch: CloudWatch agent + ClickHouse health metrics, alarms, dashboard, logs. '
        + 'Prometheus: Amazon Managed Service for Prometheus (+ alert rules) fed by a Prometheus agent on every node, optional Amazon Managed Grafana. '
        + 'Can be changed later with a stack update (nodes are re-configured in place).',
    });
    const alarmEmail = new CfnParameter(this, 'AlarmEmail', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^[^@\\s]+@[^@\\s]+$',
      description: 'Optional e-mail address subscribed to the alarm SNS topic (confirm the subscription e-mail).',
    });
    const diskAlarmPercent = new CfnParameter(this, 'DiskUsageAlarmPercent', {
      type: 'Number',
      default: 80,
      minValue: 10,
      maxValue: 99,
      description: 'Alarm when a data volume is fuller than this percentage.',
    });
    const logRetention = new CfnParameter(this, 'LogRetentionDays', {
      type: 'Number',
      default: 30,
      allowedValues: ['1', '3', '5', '7', '14', '30', '60', '90', '120', '150', '180', '365', '400', '545', '731', '1827', '3653'],
      description: 'CloudWatch mode: retention of the node log group /clickhouse/<stack>.',
    });
    const createGrafana = new CfnParameter(this, 'CreateGrafanaWorkspace', {
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
      description: 'Prometheus mode: also create an Amazon Managed Grafana workspace (Prometheus + CloudWatch data sources).',
    });
    const grafanaAuth = new CfnParameter(this, 'GrafanaAuthProvider', {
      type: 'String',
      default: 'SAML',
      allowedValues: ['SAML', 'AWS_SSO'],
      description: 'Grafana sign-in. SAML (default) works in any account; connect your IdP after creation. AWS_SSO only if IAM Identity Center is enabled for this account/organization (any region), otherwise the workspace fails to create.',
    });
    // operations: backups
    const enableBackup = new CfnParameter(this, 'EnableBackup', {
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
      description: 'Daily ClickHouse BACKUP to a new S3 bucket (full on Sundays, incremental otherwise), taken on replica 1 of each shard.',
    });
    const backupRetention = new CfnParameter(this, 'BackupRetentionDays', {
      type: 'Number',
      default: 35,
      minValue: 8,
      maxValue: 3650,
      description: 'Backups expire after this many days (S3 lifecycle). Incrementals need their full backup, so the restorable window is this minus 7 days.',
    });
    const backupTime = new CfnParameter(this, 'BackupTimeUTC', {
      type: 'String',
      default: '03:00',
      allowedPattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
      description: 'Daily backup time (HH:MM, UTC).',
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          { Label: { default: 'Cluster' }, Parameters: ['ClusterName', 'ClickHouseVersion', 'ShardCount', 'ReplicaCount', 'KeeperCount'] },
          { Label: { default: 'Compute' }, Parameters: ['ClickHouseInstanceType', 'KeeperInstanceType'] },
          {
            Label: { default: 'Storage (system and data volumes are separate EBS volumes)' },
            Parameters: ['SystemVolumeSize', 'DataVolumeSize', 'DataVolumeIops', 'DataVolumeThroughput', 'KeeperDataVolumeSize'],
          },
          { Label: { default: 'Network' }, Parameters: ['VpcId', 'SubnetIds', 'MultiAZ', 'ClientCidr'] },
          { Label: { default: 'Data protection' }, Parameters: ['EnableTerminationProtection', 'EnableBackup', 'BackupRetentionDays', 'BackupTimeUTC', 'SystemLogRetentionDays'] },
          {
            Label: { default: 'Monitoring and alarms' },
            Parameters: ['Monitoring', 'AlarmEmail', 'DiskUsageAlarmPercent', 'LogRetentionDays', 'CreateGrafanaWorkspace', 'GrafanaAuthProvider'],
          },
          { Label: { default: 'Advanced' }, Parameters: ['Arm64AmiId', 'X86AmiId'] },
        ],
      },
    };

    // ---------------------------------------------------------------- mappings & conditions
    const archMap = new CfnMapping(this, 'InstanceArch', {
      mapping: Object.fromEntries(ALL_INSTANCE_TYPES.map((t) => [t, { Arch: archOf(t) }])),
    });
    const chArm = new CfnCondition(this, 'ClickHouseIsArm64', {
      expression: Fn.conditionEquals(archMap.findInMap(chInstanceType.valueAsString, 'Arch'), 'arm64'),
    });
    const keeperArm = new CfnCondition(this, 'KeeperIsArm64', {
      expression: Fn.conditionEquals(archMap.findInMap(keeperInstanceType.valueAsString, 'Arch'), 'arm64'),
    });
    const isMultiAz = new CfnCondition(this, 'IsMultiAZ', {
      expression: Fn.conditionEquals(multiAz.valueAsString, 'true'),
    });

    const atLeast = (param: CfnParameter, n: number, max: number): ICfnConditionExpression => {
      const eqs = range(n, max).map((v) => Fn.conditionEquals(param.valueAsString, String(v)));
      return eqs.length === 1 ? eqs[0] : Fn.conditionOr(...eqs);
    };
    const shardsAtLeast = new Map<number, CfnCondition>();
    for (const s of range(2, MAX_SHARDS)) {
      shardsAtLeast.set(s, new CfnCondition(this, `ShardsAtLeast${s}`, { expression: atLeast(shardCount, s, MAX_SHARDS) }));
    }
    const replicasAtLeast = new Map<number, CfnCondition>();
    for (const r of range(2, MAX_REPLICAS)) {
      replicasAtLeast.set(r, new CfnCondition(this, `ReplicasAtLeast${r}`, { expression: atLeast(replicaCount, r, MAX_REPLICAS) }));
    }
    const threeKeepers = new CfnCondition(this, 'ThreeKeepers', {
      expression: Fn.conditionEquals(keeperCount.valueAsString, '3'),
    });
    const isCloudWatch = new CfnCondition(this, 'MonitoringCloudWatch', { expression: Fn.conditionEquals(monitoringMode.valueAsString, 'CloudWatch') });
    const isPrometheus = new CfnCondition(this, 'MonitoringPrometheus', { expression: Fn.conditionEquals(monitoringMode.valueAsString, 'Prometheus') });
    const monitoringOn = new CfnCondition(this, 'MonitoringEnabled', { expression: Fn.conditionNot(Fn.conditionEquals(monitoringMode.valueAsString, 'None')) });
    const grafanaOn = new CfnCondition(this, 'GrafanaEnabled', {
      expression: Fn.conditionAnd(isPrometheus, Fn.conditionEquals(createGrafana.valueAsString, 'true')),
    });
    const alarmEmailSet = new CfnCondition(this, 'AlarmEmailSet', { expression: Fn.conditionNot(Fn.conditionEquals(alarmEmail.valueAsString, '')) });
    const backupOn = new CfnCondition(this, 'BackupEnabled', { expression: Fn.conditionEquals(enableBackup.valueAsString, 'true') });
    const protectNodes = new CfnCondition(this, 'TerminationProtection', { expression: Fn.conditionEquals(terminationProtection.valueAsString, 'true') });
    // number of ClickHouse servers = ShardCount x ReplicaCount (for "all servers up" alert rules)
    const nodeCount = new CfnMapping(this, 'ServerCount', {
      mapping: Object.fromEntries(range(1, MAX_SHARDS).map((s) => [String(s), Object.fromEntries(range(1, MAX_REPLICAS).map((r) => [String(r), String(s * r)]))])),
    });
    const expectedServers = nodeCount.findInMap(shardCount.valueAsString, replicaCount.valueAsString);

    const zoneName = Fn.sub('${ClusterName}.clickhouse.internal');
    const fqdn = (host: string) => Fn.sub(`${host}.\${ClusterName}.clickhouse.internal`);
    const subnetFor = (index: number): string => (index === 1
      ? Fn.select(0, subnetIds.valueAsList)
      : Fn.conditionIf(isMultiAz.logicalId, Fn.select(index - 1, subnetIds.valueAsList), Fn.select(0, subnetIds.valueAsList)).toString());

    // ---------------------------------------------------------------- shared resources
    const secret = new secretsmanager.CfnSecret(this, 'AdminPassword', {
      description: Fn.sub('Password of the ClickHouse "default" user of stack ${AWS::StackName}'),
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const sg = new ec2.CfnSecurityGroup(this, 'ClusterSecurityGroup', {
      groupDescription: 'ClickHouse cluster nodes',
      vpcId: vpcId.valueAsString,
      securityGroupIngress: CLIENT_PORTS.map((port) => ({
        ipProtocol: 'tcp', fromPort: port, toPort: port, cidrIp: clientCidr.valueAsString, description: `ClickHouse client port ${port}`,
      })),
    });
    for (const port of CLUSTER_PORTS) {
      new ec2.CfnSecurityGroupIngress(this, `ClusterSelfIngress${port}`, {
        groupId: sg.attrGroupId,
        sourceSecurityGroupId: sg.attrGroupId,
        ipProtocol: 'tcp', fromPort: port, toPort: port,
        description: `ClickHouse intra-cluster port ${port}`,
      });
    }

    // ---------------------------------------------------------------- monitoring infrastructure and backup bucket
    const monitoringProps = {
      cloudWatch: isCloudWatch, prometheus: isPrometheus, enabled: monitoringOn, grafana: grafanaOn,
      alarmEmailSet, backupEnabled: backupOn,
      alarmEmail: alarmEmail.valueAsString,
      logRetentionDays: logRetention.valueAsNumber,
      grafanaAuthProvider: grafanaAuth.valueAsString,
      diskUsageAlarmPercent: diskAlarmPercent.valueAsString,
      expectedServers,
      expectedKeepers: keeperCount.valueAsString,
      platform: 'ec2' as const,
    };
    const monitoring = createMonitoringInfra(this, monitoringProps);
    const backupBucket = createBackupBucket(this, { enabled: backupOn, retentionDays: backupRetention.valueAsNumber });
    const noValue = Aws.NO_VALUE;

    const role = new iam.CfnRole(this, 'NodeRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      },
      managedPolicyArns: [
        Fn.sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'),
        // CloudWatch agent: metrics (incl. the node health metrics) and logs
        Fn.conditionIf(isCloudWatch.logicalId, Fn.sub('arn:${AWS::Partition}:iam::aws:policy/CloudWatchAgentServerPolicy'), noValue).toString(),
      ],
      policies: [{
        policyName: 'clickhouse-node',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secret.ref },
            { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: Fn.sub('arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/clickhouse/${AWS::StackName}/*') },
            { Effect: 'Allow', Action: 'cloudformation:SignalResource', Resource: Aws.STACK_ID },
            Fn.conditionIf(isPrometheus.logicalId,
              { Effect: 'Allow', Action: 'aps:RemoteWrite', Resource: monitoring.workspace.attrArn }, noValue),
            Fn.conditionIf(backupOn.logicalId,
              { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: backupBucket.attrArn }, noValue),
            Fn.conditionIf(backupOn.logicalId, {
              Effect: 'Allow',
              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
              Resource: Fn.join('', [backupBucket.attrArn, '/*']),
            }, noValue),
          ],
        },
      }],
    });
    const profile = new iam.CfnInstanceProfile(this, 'NodeInstanceProfile', { roles: [role.ref] });

    const zone = new route53.CfnHostedZone(this, 'PrivateZone', {
      name: zoneName,
      vpcs: [{ vpcId: vpcId.valueAsString, vpcRegion: Aws.REGION }],
      hostedZoneConfig: { comment: Fn.sub('ClickHouse cluster node names for stack ${AWS::StackName}') },
    });

    // ---------------------------------------------------------------- launch templates
    // Cluster settings live in an SSM parameter read by the boot script, not in the launch template: the
    // template's user data never changes, instances pin launch-template version 1, and stack updates never
    // replace running nodes (rolling upgrades / topology changes are applied in place by the node-config association).
    const clusterConfig = new ssm.CfnParameter(this, 'ClusterConfig', {
      name: Fn.sub('/clickhouse/${AWS::StackName}/cluster-config'),
      type: 'String',
      description: 'ClickHouse cluster settings read by node boot scripts (managed by CloudFormation)',
      value: Fn.sub(
        "CH_VERSION='${Version}'\nCH_CLUSTER='${Cluster}'\nCH_ZONE='${Cluster}.clickhouse.internal'\n"
        + "CH_SHARDS='${Shards}'\nCH_REPLICAS='${Replicas}'\nCH_KEEPERS='${Keepers}'\nCH_SECRET_ARN='${Secret}'",
        {
          Cluster: clusterName.valueAsString,
          Version: version.valueAsString,
          Shards: shardCount.valueAsString,
          Replicas: replicaCount.valueAsString,
          Keepers: keeperCount.valueAsString,
          Secret: secret.ref,
        },
      ),
    });
    const header = Fn.sub(
      "#!/bin/bash\nexport CH_STACK='${AWS::StackName}' CH_REGION='${AWS::Region}' CH_CONFIG_PARAM='${Param}'\n",
      { Param: clusterConfig.ref },
    );
    const common = readScript('common.sh');
    const userData = (...scripts: string[]) => Fn.base64(Fn.join('', [header, common, '\n', ...scripts.map(readScript).join('\n')]));

    // System (root) and data are always separate EBS volumes: /dev/xvda holds OS/packages/logs,
    // /dev/sdb is formatted xfs and mounted at /var/lib/clickhouse by the boot script.
    // The launch templates only hold the root (system) volume; each node's data volume is a separate
    // AWS::EC2::Volume resource (see node()), so data survives instance replacement and stack deletion.
    const launchTemplate = (
      id: string, instanceType: string, isArm: CfnCondition, scripts: string[],
    ) => new ec2.CfnLaunchTemplate(this, id, {
      launchTemplateData: {
        imageId: Fn.conditionIf(isArm.logicalId, armAmi.valueAsString, x86Ami.valueAsString).toString(),
        instanceType,
        iamInstanceProfile: { arn: profile.attrArn },
        metadataOptions: {
          httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1, instanceMetadataTags: 'enabled',
        },
        blockDeviceMappings: [{
          deviceName: '/dev/xvda',
          ebs: { volumeSize: systemVolumeSize.valueAsNumber, volumeType: 'gp3', encrypted: true, deleteOnTermination: true },
        }],
        userData: userData(...scripts),
      },
    });
    const chTemplate = launchTemplate('ClickHouseLaunchTemplate', chInstanceType.valueAsString, chArm, ['node-lib.sh', 'cluster-xml.sh', 'clickhouse-node.sh']);
    const keeperTemplate = launchTemplate('KeeperLaunchTemplate', keeperInstanceType.valueAsString, keeperArm, ['node-lib.sh', 'keeper-node.sh']);
    for (const lt of [chTemplate, keeperTemplate]) {
      Validations.of(lt).acknowledge({
        id: 'CloudFormation-Validate::E1152',
        reason: 'ImageId comes from an AWS::SSM::Parameter::Value<AWS::EC2::Image::Id> parameter, resolved to an AMI id at deploy time',
      });
    }

    // ---------------------------------------------------------------- node slots
    // Shard/replica/keeper ids are encoded in the logical id (ChS<s>R<r>, Keeper<k>) which the boot
    // script reads from the instance tag ch-logical-id.
    //
    // Data safety:
    //  * instances pin launch-template version 1, and the template only holds settings that are fixed for a
    //    node's lifetime (AMI, instance type, root volume, generic boot script). Later template changes - e.g. a
    //    newer AL2023 AMI resolved by the SSM parameter - never replace running nodes. ClickHouse version and
    //    topology are read from the ClusterConfig SSM parameter at boot and rolled out to running nodes by the
    //    node-config association; instance type changes are a per-node runbook (docs/operations-guide.md).
    //  * the data volume is its own resource with DeletionPolicy/UpdateReplacePolicy Snapshot; size, IOPS and
    //    throughput changes are applied online.
    //  * optional EC2 termination protection.
    //  * the instance signals the WaitCondition <id>Ready once ClickHouse/Keeper is healthy on the attached volume.
    const slots: NodeSlot[] = [];
    const readiness: CfnResource[] = [];
    const node = (
      logicalId: string, host: string, role: NodeSlot['role'], subnetId: string, template: ec2.CfnLaunchTemplate,
      data: { size: number; iops?: number; throughput?: number }, condition?: CfnCondition,
    ) => {
      const eni = new ec2.CfnNetworkInterface(this, `${logicalId}Eni`, { subnetId, groupSet: [sg.attrGroupId] });
      const instance = new ec2.CfnInstance(this, logicalId, {
        launchTemplate: { launchTemplateId: template.ref, version: '1' },
        networkInterfaces: [{ networkInterfaceId: eni.ref, deviceIndex: '0' }],
        disableApiTermination: Fn.conditionIf(protectNodes.logicalId, true, false) as unknown as boolean,
        tags: [
          { key: 'Name', value: Fn.sub(`\${ClusterName}-${host}`) },
          { key: 'ch-logical-id', value: logicalId },
          { key: 'ch-stack', value: Aws.STACK_NAME },
        ],
      });
      instance.addResourceDependency(monitoring.logGroup);
      const volume = new ec2.CfnVolume(this, `${logicalId}Data`, {
        availabilityZone: instance.attrAvailabilityZone,
        size: data.size,
        volumeType: 'gp3',
        iops: data.iops,
        throughput: data.throughput,
        encrypted: true,
        tags: [
          { key: 'Name', value: Fn.sub(`\${ClusterName}-${host}-data`) },
          { key: 'ch-logical-id', value: logicalId },
        ],
      });
      volume.cfnOptions.deletionPolicy = CfnDeletionPolicy.SNAPSHOT;
      volume.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.SNAPSHOT;
      const attachment = new ec2.CfnVolumeAttachment(this, `${logicalId}DataAttachment`, {
        instanceId: instance.ref, volumeId: volume.ref, device: '/dev/sdf',
      });
      const ready = new CfnWaitCondition(this, `${logicalId}Ready`, {});
      ready.cfnOptions.creationPolicy = { resourceSignal: { count: 1, timeout: 'PT40M' } };
      ready.addResourceDependency(attachment);
      const record = new route53.CfnRecordSet(this, `${logicalId}Dns`, {
        hostedZoneId: zone.ref,
        name: fqdn(host),
        type: 'A',
        ttl: '60',
        resourceRecords: [eni.attrPrimaryPrivateIpAddress],
      });
      if (condition) {
        for (const r of [eni, instance, volume, attachment, ready, record]) r.cfnOptions.condition = condition;
      } else {
        readiness.push(ready);
      }
      slots.push({ logicalId, host, role, condition, ready });
      return instance;
    };

    for (const k of range(1, MAX_KEEPERS)) {
      node(`Keeper${k}`, `keeper-${k}`, 'keeper', subnetFor(k), keeperTemplate,
        { size: keeperDataVolumeSize.valueAsNumber }, k === 1 ? undefined : threeKeepers);
    }

    let firstNode: ec2.CfnInstance | undefined;
    for (const s of range(1, MAX_SHARDS)) {
      for (const r of range(1, MAX_REPLICAS)) {
        const shardCond = shardsAtLeast.get(s);
        const replicaCond = replicasAtLeast.get(r);
        const condition = shardCond && replicaCond
          ? new CfnCondition(this, `SlotS${s}R${r}`, { expression: Fn.conditionAnd(shardCond, replicaCond) })
          : shardCond ?? replicaCond;
        const instance = node(`ChS${s}R${r}`, `ch-s${s}-r${r}`, 'clickhouse', subnetFor(r), chTemplate, {
          size: dataVolumeSize.valueAsNumber, iops: dataVolumeIops.valueAsNumber, throughput: dataVolumeThroughput.valueAsNumber,
        }, condition);
        firstNode ??= instance;
      }
    }

    // ---------------------------------------------------------------- day-2 configuration and alarms
    const nodeConfig = createNodeConfig(this, {
      clickHouseVersion: version.valueAsString,
      clusterName: clusterName.valueAsString,
      shardCount: shardCount.valueAsString,
      replicaCount: replicaCount.valueAsString,
      keeperCount: keeperCount.valueAsString,
      monitoringMode: monitoringMode.valueAsString,
      systemLogRetentionDays: systemLogRetention.valueAsString,
      backupBucket: Fn.conditionIf(backupOn.logicalId, backupBucket.ref, '').toString(),
      backupTimeUtc: backupTime.valueAsString,
      ampRemoteWriteUrl: Fn.conditionIf(isPrometheus.logicalId,
        Fn.join('', [monitoring.workspace.attrPrometheusEndpoint, 'api/v1/remote_write']), '').toString(),
      logGroupName: Fn.conditionIf(isCloudWatch.logicalId, monitoring.logGroup.ref, '').toString(),
      secretArn: secret.ref,
      metricNamespace: METRIC_NAMESPACE,
      maxNodes: MAX_SHARDS * MAX_REPLICAS + MAX_KEEPERS,
      dependsOn: readiness,
    });
    createCloudWatchAlarms(this, monitoring, monitoringProps, slots, nodeConfig);

    // ---------------------------------------------------------------- outputs
    const passwordCmd = Fn.join('', [
      'aws secretsmanager get-secret-value --region ', Aws.REGION, ' --secret-id ', secret.ref, ' --query SecretString --output text',
    ]);
    new CfnOutput(this, 'ClusterNameOutput', { key: 'ClusterName', value: clusterName.valueAsString, description: "Use in DDL: ON CLUSTER '<name>'" });
    new CfnOutput(this, 'PrivateHostedZone', { value: zoneName });
    new CfnOutput(this, 'ClickHouseEndpoint', {
      value: fqdn('ch-s1-r1'),
      description: 'First ClickHouse node (HTTP 8123, native 9000). Others: ch-s<shard>-r<replica>.<zone>',
    });
    new CfnOutput(this, 'KeeperEndpoints', {
      value: Fn.conditionIf(threeKeepers.logicalId,
        Fn.sub('keeper-1.${ClusterName}.clickhouse.internal:9181,keeper-2.${ClusterName}.clickhouse.internal:9181,'
          + 'keeper-3.${ClusterName}.clickhouse.internal:9181'),
        fqdn('keeper-1')).toString(),
    });
    new CfnOutput(this, 'AdminPasswordSecretArn', { value: secret.ref, description: 'Secrets Manager secret with the password of user "default"' });
    new CfnOutput(this, 'PasswordCommand', { value: passwordCmd });
    new CfnOutput(this, 'FirstNodeInstanceId', { value: firstNode!.ref });
    new CfnOutput(this, 'ConnectCommand', {
      value: Fn.join('', ['aws ssm start-session --region ', Aws.REGION, ' --target ', firstNode!.ref,
        '  then on the node: CLICKHOUSE_PASSWORD="$(', passwordCmd, ')" clickhouse-client']),
    });
    new CfnOutput(this, 'MonitoringMode', { value: monitoringMode.valueAsString });
    new CfnOutput(this, 'AlarmTopicArn', { value: monitoring.topic.ref, condition: monitoringOn, description: 'SNS topic receiving all alarms/alerts' });
    new CfnOutput(this, 'CloudWatchDashboardUrl', {
      condition: isCloudWatch,
      value: Fn.sub('https://${AWS::Region}.console.aws.amazon.com/cloudwatch/home?region=${AWS::Region}#dashboards/dashboard/${AWS::StackName}-clickhouse'),
    });
    new CfnOutput(this, 'CloudWatchLogGroup', { condition: isCloudWatch, value: monitoring.logGroup.ref });
    new CfnOutput(this, 'PrometheusWorkspaceId', { condition: isPrometheus, value: monitoring.workspace.attrWorkspaceId });
    new CfnOutput(this, 'PrometheusQueryEndpoint', {
      condition: isPrometheus,
      value: Fn.join('', [monitoring.workspace.attrPrometheusEndpoint, 'api/v1/query']),
      description: 'SigV4-signed PromQL endpoint (service aps)',
    });
    new CfnOutput(this, 'GrafanaUrl', {
      condition: grafanaOn,
      value: Fn.join('', ['https://', monitoring.grafanaWorkspace.attrEndpoint]),
      description: 'Import docs/grafana/clickhouse-cluster-dashboard.json and add the Amazon Managed Prometheus data source',
    });
    new CfnOutput(this, 'BackupBucketName', { condition: backupOn, value: backupBucket.ref });
    new CfnOutput(this, 'BackupLocation', {
      condition: backupOn,
      value: Fn.join('', ['s3://', backupBucket.ref, '/', Aws.STACK_NAME, '/shard-<N>/<timestamp>-<full|incremental>/']),
    });

    // ---------------------------------------------------------------- update guard (must stay last)
    // Rejects stack updates that would lose data or cannot be applied in place (instances pin launch-template v1):
    // see docs/operations-guide.md. Every other resource depends on it, so a rejected update touches nothing else.
    const guard = createUpdateGuard(this, {
      immutable: {
        ClusterName: clusterName.valueAsString,
        KeeperCount: keeperCount.valueAsString,
        VpcId: vpcId.valueAsString,
        SubnetIds: Fn.join(',', subnetIds.valueAsList),
        MultiAZ: multiAz.valueAsString,
        ClickHouseInstanceType: chInstanceType.valueAsString,
        KeeperInstanceType: keeperInstanceType.valueAsString,
        SystemVolumeSize: systemVolumeSize.valueAsString,
      },
      noDecrease: {
        ShardCount: shardCount.valueAsString,
        ReplicaCount: replicaCount.valueAsString,
        DataVolumeSize: dataVolumeSize.valueAsString,
        KeeperDataVolumeSize: keeperDataVolumeSize.valueAsString,
      },
      noDowngrade: { ClickHouseVersion: version.valueAsString },
    });
    dependOnUpdateGuard(this, guard);
  }
}
