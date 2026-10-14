import * as fs from 'fs';
import * as path from 'path';
import { Aws, CfnResource, Fn } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/** Versions of the Prometheus components installed on the nodes in Prometheus monitoring mode. */
export const PROMETHEUS_VERSION = '3.15.0';
export const NODE_EXPORTER_VERSION = '1.12.1';
/** Timeout of the node-config run on one node (the document step timeout). */
const NODE_TIMEOUT_SECONDS = 3600;

/** Shell script of lib/userdata without comment/blank lines and indentation (keeps the launch templates small). */
export function readScript(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'userdata', name), 'utf8')
    .split('\n')
    .map((l) => l.trimStart())
    .filter((l) => l !== '' && !/^#(?!!)/.test(l))
    .join('\n');
}

export interface NodeConfigProps {
  readonly clickHouseVersion: string;
  readonly clusterName: string;
  readonly shardCount: string;
  readonly replicaCount: string;
  readonly keeperCount: string;
  readonly monitoringMode: string;
  readonly systemLogRetentionDays: string;
  /** '' when backups are disabled. */
  readonly backupBucket: string;
  readonly backupTimeUtc: string;
  /** '' unless Prometheus mode. */
  readonly ampRemoteWriteUrl: string;
  /** '' unless CloudWatch mode. */
  readonly logGroupName: string;
  readonly secretArn: string;
  readonly metricNamespace: string;
  /** Largest possible number of nodes (servers + keepers): the association runs on them one at a time. */
  readonly maxNodes: number;
  /** The association runs after these resources (the always-present node slots) are ready. */
  readonly dependsOn: CfnResource[];
}

/**
 * Day-2 configuration of all nodes: an SSM Command document (lib/nodeconfig/node-config.sh) applied by a State
 * Manager association to every instance tagged ch-stack=<stack name>, one node at a time, stopping at the first
 * failure. Changing any of the related stack parameters updates the association, which re-runs it on the running
 * nodes (rolling ClickHouse upgrades, cluster topology, monitoring, backups, log TTL); the instances themselves are
 * never replaced. It also re-runs every hour to repair drift, and runs on nodes added later.
 */
export function createNodeConfig(scope: Construct, p: NodeConfigProps): ssm.CfnAssociation {
  // `# @include <file>` lines are replaced by lib/userdata/<file> (in the same form as in the boot user data): the
  // association always runs the current template's version of the shared helpers, never the copy a node booted with.
  const script = fs.readFileSync(path.join(__dirname, 'nodeconfig', 'node-config.sh'), 'utf8')
    .replace(/^# @include (\S+)$/gm, (_, file: string) => readScript(file))
    .split('\n');
  const param = (description: string, def?: string) => ({ type: 'String', description, ...(def !== undefined ? { default: def } : {}) });
  const document = new ssm.CfnDocument(scope, 'NodeConfigDocument', {
    documentType: 'Command',
    content: {
      schemaVersion: '2.2',
      description: 'Day-2 configuration of a ClickHouse / ClickHouse Keeper node (monitoring agents, system log TTL, backups).',
      parameters: {
        ClickHouseVersion: param('Target ClickHouse / Keeper version; nodes on another version are upgraded one at a time'),
        ClusterName: param('ClickHouse cluster name'),
        ShardCount: param('Number of shards'),
        ReplicaCount: param('Number of replicas per shard'),
        KeeperCount: param('Number of Keeper nodes'),
        MonitoringMode: { ...param('None | CloudWatch | Prometheus'), allowedValues: ['None', 'CloudWatch', 'Prometheus'] },
        SystemLogRetentionDays: param('TTL in days of the system.*_log tables', '30'),
        BackupBucket: param('S3 bucket for backups, empty = backups disabled', ''),
        BackupTimeUTC: param('Daily backup time HH:MM (UTC)', '03:00'),
        AmpRemoteWriteUrl: param('Amazon Managed Prometheus remote-write URL', ''),
        LogGroupName: param('CloudWatch Logs group for node logs', ''),
        ClusterId: param('Cluster id used as metric dimension / label (the stack name)'),
        Region: param('AWS region'),
        SecretArn: param('Secrets Manager secret with the default user password'),
        MetricNamespace: param('CloudWatch metric namespace', p.metricNamespace),
        PrometheusVersion: param('Prometheus version (agent mode)', PROMETHEUS_VERSION),
        NodeExporterVersion: param('node_exporter version', NODE_EXPORTER_VERSION),
      },
      mainSteps: [{
        action: 'aws:runShellScript',
        name: 'configureNode',
        inputs: { timeoutSeconds: String(NODE_TIMEOUT_SECONDS), runCommand: script },
      }],
    },
    tags: [{ key: 'Name', value: Fn.sub('${AWS::StackName}-node-config') }],
  });

  const association = new ssm.CfnAssociation(scope, 'NodeConfigAssociation', {
    name: document.ref,
    associationName: Fn.sub('${AWS::StackName}-node-config'),
    targets: [{ key: 'tag:ch-stack', values: [Aws.STACK_NAME] }],
    parameters: {
      ClickHouseVersion: [p.clickHouseVersion],
      ClusterName: [p.clusterName],
      ShardCount: [p.shardCount],
      ReplicaCount: [p.replicaCount],
      KeeperCount: [p.keeperCount],
      MonitoringMode: [p.monitoringMode],
      SystemLogRetentionDays: [p.systemLogRetentionDays],
      BackupBucket: [p.backupBucket],
      BackupTimeUTC: [p.backupTimeUtc],
      AmpRemoteWriteUrl: [p.ampRemoteWriteUrl],
      LogGroupName: [p.logGroupName],
      ClusterId: [Aws.STACK_NAME],
      Region: [Aws.REGION],
      SecretArn: [p.secretArn],
      MetricNamespace: [p.metricNamespace],
    },
    maxConcurrency: '1',
    maxErrors: '0',
    scheduleExpression: 'rate(1 hour)',
    complianceSeverity: 'HIGH',
    // every node runs for at most NODE_TIMEOUT_SECONDS (node-config.sh bounds its upgrade waits below that), one
    // node at a time: wait for the largest cluster (18 nodes = 64800 s; the CloudFormation maximum is 172800 s)
    waitForSuccessTimeoutSeconds: p.maxNodes * NODE_TIMEOUT_SECONDS,
  });
  for (const d of p.dependsOn) association.addResourceDependency(d);
  return association;
}
