import { Aws, CfnCondition, CfnResource, Fn, Stack } from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** CloudWatch namespace of all custom metrics (node health + CloudWatch agent host metrics). */
export const METRIC_NAMESPACE = 'ClickHouse';

export interface NodeSlot {
  readonly logicalId: string;
  readonly host: string;
  readonly role: 'clickhouse' | 'keeper';
  /** Condition under which the slot exists (undefined = always). */
  readonly condition?: CfnCondition;
  /** Resource that is ready once the slot's node is healthy (same condition as the slot): its alarms are created after it. */
  readonly ready?: CfnResource;
}

export interface MonitoringProps {
  readonly cloudWatch: CfnCondition;
  readonly prometheus: CfnCondition;
  /** Monitoring != None */
  readonly enabled: CfnCondition;
  readonly grafana: CfnCondition;
  readonly alarmEmailSet: CfnCondition;
  readonly backupEnabled: CfnCondition;
  readonly alarmEmail: string;
  readonly logRetentionDays: number;
  readonly grafanaAuthProvider: string;
  readonly diskUsageAlarmPercent: string;
  /** Number of ClickHouse servers / Keeper nodes the cluster should have (strings, from mappings/parameters). */
  readonly expectedServers: string;
  readonly expectedKeepers: string;
  /**
   * ec2: host metrics from the metrics publisher (CloudWatch) / node_exporter (Prometheus).
   * eks: pod metrics from Container Insights (CloudWatch) / ClickHouse OS metrics, kubelet and cAdvisor (Prometheus).
   */
  readonly platform: 'ec2' | 'eks';
  /** PromQL of the data volume usage % per `node` (default: node_exporter filesystem metrics of the EC2 nodes). */
  readonly diskUsedExpr?: string;
  /** Dashboard widgets for CPU and memory (default: the publisher's CpuUsedPercent / MemoryUsedPercent of the EC2 nodes). */
  readonly cpuMemoryWidgets?: { cpu: object[][]; memory: object[][] };
}

/** Alarm thresholds that are not stack parameters. */
export const THRESHOLDS = {
  cpuPercent: 90, memoryPercent: 90, rootDiskPercent: 85, failedQueriesPer5m: 100, keeperErrorsPer5m: 10,
  distributedFilesToInsert: 1000, keeperLatencyMs: 100, keeperOutstandingRequests: 100, logTtlJobAgeHours: 3,
};

const EC2_DISK_USED_EXPR = '100 * (1 - node_filesystem_avail_bytes{mountpoint="/var/lib/clickhouse"} / node_filesystem_size_bytes{mountpoint="/var/lib/clickhouse"})';

/** PromQL of host / pod usage per `node`; rootDisk = '' means no such rule. */
const HOST_EXPRS = {
  ec2: {
    cpu: '100 * (1 - avg by (node) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
    memory: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    rootDisk: '100 * (1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})',
  },
  eks: {
    // one ClickHouse / Keeper pod per node: the OS metrics of the server / keeper process are those of its node
    cpu: '100 * (ClickHouseAsyncMetrics_OSUserTimeNormalized + ClickHouseAsyncMetrics_OSSystemTimeNormalized)',
    // memory against the pod limit (cAdvisor), labelled with the pod name
    memory: 'label_replace(100 * container_memory_working_set_bytes{namespace="clickhouse", container=~"clickhouse|clickhouse-keeper"}'
      + ' / container_spec_memory_limit_bytes{namespace="clickhouse", container=~"clickhouse|clickhouse-keeper"}, "node", "$1", "pod", "(.+)")',
    rootDisk: '',
  },
};

export interface MonitoringInfra {
  readonly topic: sns.CfnTopic;
  readonly logGroup: logs.CfnLogGroup;
  readonly workspace: aps.CfnWorkspace;
  readonly grafanaWorkspace: grafana.CfnWorkspace;
  readonly ruleGroups: aps.CfnRuleGroupsNamespace[];
}

const withCondition = <T extends { cfnOptions: { condition?: CfnCondition } }>(r: T, c: CfnCondition): T => {
  r.cfnOptions.condition = c;
  return r;
};

/** SNS alarm topic, CloudWatch log group, Amazon Managed Prometheus workspace (rules + alert manager), Grafana. */
export function createMonitoringInfra(scope: Construct, p: MonitoringProps): MonitoringInfra {
  const topic = withCondition(new sns.CfnTopic(scope, 'AlarmTopic', {
    displayName: Fn.sub('ClickHouse ${AWS::StackName} alarms'),
  }), p.enabled);
  const subscriptionCondition = new CfnCondition(scope, 'AlarmEmailSubscription', {
    expression: Fn.conditionAnd(p.enabled, p.alarmEmailSet),
  });
  withCondition(new sns.CfnSubscription(scope, 'AlarmEmailSubscriptionResource', {
    topicArn: topic.ref, protocol: 'email', endpoint: p.alarmEmail,
  }), subscriptionCondition);
  // CloudWatch alarms (same account) and Amazon Managed Prometheus alert manager publish to the topic
  withCondition(new sns.CfnTopicPolicy(scope, 'AlarmTopicPolicy', {
    topics: [topic.ref],
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AccountOwner', Effect: 'Allow', Principal: { AWS: Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') },
          Action: ['sns:Publish', 'sns:Subscribe', 'sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:ListSubscriptionsByTopic'],
          Resource: topic.ref,
        },
        {
          Sid: 'MonitoringServices', Effect: 'Allow',
          Principal: { Service: ['cloudwatch.amazonaws.com', 'aps.amazonaws.com'] },
          Action: ['sns:Publish', 'sns:GetTopicAttributes'], Resource: topic.ref,
          Condition: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
        },
      ],
    },
  }), p.enabled);

  // Not conditional: every node depends on it, so on stack deletion it is removed only after the nodes'
  // CloudWatch agents are gone (an agent still running would re-create a deleted group). Empty groups cost nothing.
  const logGroup = new logs.CfnLogGroup(scope, 'NodeLogGroup', {
    logGroupName: Fn.sub('/clickhouse/${AWS::StackName}'),
    retentionInDays: p.logRetentionDays,
  });

  // ---------------------------------------------------------------- Amazon Managed Service for Prometheus
  const workspace = withCondition(new aps.CfnWorkspace(scope, 'PrometheusWorkspace', {
    alias: Fn.sub('${AWS::StackName}-clickhouse'),
    alertManagerDefinition: Fn.sub(ALERT_MANAGER_YAML, { TopicArn: topic.ref }),
  }), p.prometheus);
  const rules = withCondition(new aps.CfnRuleGroupsNamespace(scope, 'PrometheusAlertRules', {
    workspace: workspace.attrArn,
    name: 'clickhouse-alerts',
    data: Fn.sub(alertRulesYaml(p.platform, p.diskUsedExpr ?? EC2_DISK_USED_EXPR), {
      ExpectedServers: p.expectedServers,
      ExpectedKeepers: p.expectedKeepers,
      DiskThreshold: p.diskUsageAlarmPercent,
    }),
  }), p.prometheus);
  // backup-age rule only when backups are enabled (otherwise the metric stays at the install time and would alert forever)
  const backupRules = withCondition(new aps.CfnRuleGroupsNamespace(scope, 'PrometheusBackupAlertRules', {
    workspace: workspace.attrArn,
    name: 'clickhouse-backup-alerts',
    data: BACKUP_RULES_YAML,
  }), new CfnCondition(scope, 'PrometheusBackupAlerts', { expression: Fn.conditionAnd(p.prometheus, p.backupEnabled) }));

  // ---------------------------------------------------------------- Amazon Managed Grafana (optional)
  const grafanaRole = withCondition(new iam.CfnRole(scope, 'GrafanaRole', {
    assumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow', Principal: { Service: 'grafana.amazonaws.com' }, Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
      }],
    },
    managedPolicyArns: [
      Fn.sub('arn:${AWS::Partition}:iam::aws:policy/AmazonPrometheusQueryAccess'),
      Fn.sub('arn:${AWS::Partition}:iam::aws:policy/CloudWatchReadOnlyAccess'),
    ],
  }), p.grafana);
  const grafanaWorkspace = withCondition(new grafana.CfnWorkspace(scope, 'GrafanaWorkspace', {
    name: Fn.sub('${AWS::StackName}-clickhouse'),
    description: Fn.sub('ClickHouse cluster ${AWS::StackName}'),
    accountAccessType: 'CURRENT_ACCOUNT',
    authenticationProviders: [p.grafanaAuthProvider],
    permissionType: 'CUSTOMER_MANAGED',
    roleArn: grafanaRole.attrArn,
    dataSources: ['PROMETHEUS', 'CLOUDWATCH'],
    grafanaVersion: '12.4',
  }), p.grafana);

  return { topic, logGroup, workspace, grafanaWorkspace, ruleGroups: [rules, backupRules] };
}

/**
 * CloudWatch alarms (per node slot: down and disk usage; cluster-wide alarms for the rest) and a CloudWatch dashboard.
 * Alarms and the Prometheus alert rules are created after `metricsPublisher` (the node-config association / installer that
 * starts the metric publisher / deploys the cluster: "no leader" style rules would fire before any series exists),
 * per-slot alarms also after the slot's `ready` resource: otherwise "missing = breaching" alarms fire, and notify,
 * before the first datapoint arrives (e.g. a node added by a scale-out is still booting).
 * Metrics that an older ClickHouse version does not have are published as 0, and every "too high" alarm treats missing
 * data as not breaching, so they never alarm on missing data.
 */
export function createCloudWatchAlarms(stack: Stack, infra: MonitoringInfra, p: MonitoringProps, nodes: NodeSlot[],
  metricsPublisher: CfnResource): void {
  for (const r of infra.ruleGroups) r.addResourceDependency(metricsPublisher);
  const cluster = { name: 'Cluster', value: Aws.STACK_NAME };
  const alarm = (id: string, o: {
    metric: string; stat: string; op: string; threshold: number | string; period: number; periods: number;
    missing: 'breaching' | 'notBreaching'; description: string; node?: string; condition: CfnCondition;
    /** other namespace / dimensions than ClickHouse + Cluster(+Node) */
    namespace?: string; dimensions?: { name: string; value: string }[]; after?: CfnResource;
  }) => {
    const a = withCondition(new cloudwatch.CfnAlarm(stack, id, {
    alarmName: Fn.join('-', [Aws.STACK_NAME, o.node ?? 'cluster', o.metric]),
    alarmDescription: o.description,
    namespace: o.namespace ?? METRIC_NAMESPACE,
    metricName: o.metric,
    dimensions: o.dimensions ?? (o.node ? [cluster, { name: 'Node', value: o.node }] : [cluster]),
    statistic: o.stat,
    period: o.period,
    evaluationPeriods: o.periods,
    datapointsToAlarm: o.periods,
    threshold: o.threshold as number,
    comparisonOperator: o.op,
    treatMissingData: o.missing,
    alarmActions: [infra.topic.ref],
    okActions: [infra.topic.ref],
  }), o.condition);
    a.addResourceDependency(metricsPublisher);
    if (o.after) a.addResourceDependency(o.after);
    return a;
  };

  const conditions = new Map<CfnCondition, CfnCondition>();
  for (const n of nodes) {
    let cond = p.cloudWatch;
    if (n.condition) {
      cond = conditions.get(n.condition) ?? new CfnCondition(stack, `${n.logicalId}AlarmCondition`, {
        expression: Fn.conditionAnd(p.cloudWatch, n.condition),
      });
      conditions.set(n.condition, cond);
    }
    alarm(`${n.logicalId}DownAlarm`, {
      metric: n.role === 'clickhouse' ? 'ServerUp' : 'KeeperUp', stat: 'Minimum', op: 'LessThanThreshold', threshold: 1,
      period: 60, periods: 3, missing: 'breaching', node: n.host, condition: cond, after: n.ready,
      description: `${n.host} is down or not reporting (no successful health check for 3 minutes).`,
    });
    // per node, so that a second full volume is not hidden behind an alarm that is already in ALARM
    alarm(`${n.logicalId}DataDiskAlarm`, {
      metric: 'DataDiskUsedPercent', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: p.diskUsageAlarmPercent,
      period: 300, periods: 2, missing: 'notBreaching', node: n.host, condition: cond, after: n.ready,
      description: n.role === 'clickhouse'
        ? `The data volume of ${n.host} is fuller than the threshold: grow DataVolumeSize (online) or delete/TTL data.`
        : `The data volume of ${n.host} (Raft log + snapshots) is fuller than the threshold: grow KeeperDataVolumeSize (online).`,
    });
    if (p.platform === 'ec2') {
      alarm(`${n.logicalId}RootDiskAlarm`, {
        metric: 'RootDiskUsedPercent', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.rootDiskPercent,
        period: 300, periods: 2, missing: 'notBreaching', node: n.host, condition: cond, after: n.ready,
        description: `The root volume of ${n.host} is more than ${THRESHOLDS.rootDiskPercent}% full (logs in /var/log/clickhouse-*): grow SystemVolumeSize on the volume (online) or clean up logs.`,
      });
    }
  }
  const cw = p.cloudWatch;
  // host / pod usage: publisher metrics (EC2), Container Insights (EKS)
  const ci = (metric: string, namespace?: boolean) => ({
    metric, namespace: 'ContainerInsights',
    dimensions: [{ name: 'ClusterName', value: Aws.STACK_NAME }, ...(namespace ? [{ name: 'Namespace', value: 'clickhouse' }] : [])],
  });
  const eks = p.platform === 'eks';
  alarm('CpuHighAlarm', {
    ...(eks ? ci('pod_cpu_utilization_over_pod_limit', true) : { metric: 'CpuUsedPercent' }),
    stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.cpuPercent,
    period: 300, periods: 3, missing: 'notBreaching', condition: cw,
    description: eks
      ? `A pod in namespace clickhouse uses more than ${THRESHOLDS.cpuPercent}% of its CPU limit for 15 minutes (Container Insights).`
      : `A node uses more than ${THRESHOLDS.cpuPercent}% CPU for 15 minutes (see the dashboard for which one).`,
  });
  alarm('MemoryHighAlarm', {
    ...(eks ? ci('pod_memory_utilization_over_pod_limit', true) : { metric: 'MemoryUsedPercent' }),
    stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.memoryPercent,
    period: 300, periods: 3, missing: 'notBreaching', condition: cw,
    description: eks
      ? `A pod in namespace clickhouse uses more than ${THRESHOLDS.memoryPercent}% of its memory limit for 15 minutes (OOM kill risk).`
      : `A node uses more than ${THRESHOLDS.memoryPercent}% of its memory for 15 minutes.`,
  });
  if (eks) {
    alarm('NodeRootDiskAlarm', {
      ...ci('node_filesystem_utilization'),
      stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.rootDiskPercent,
      period: 300, periods: 2, missing: 'notBreaching', condition: cw,
      description: `The root volume of an EKS node is more than ${THRESHOLDS.rootDiskPercent}% full (images, logs): grow NodeRootVolumeSize.`,
    });
    alarm('OomKilledAlarm', {
      ...ci('pod_container_status_terminated_reason_oom_killed'),
      stat: 'Maximum', op: 'GreaterThanOrEqualToThreshold', threshold: 1,
      period: 300, periods: 1, missing: 'notBreaching', condition: cw,
      description: 'A container of the EKS cluster was OOM-killed (Container Insights): check pod memory limits (ClickHouseMemory / KeeperMemory).',
    });
    alarm('LogTtlJobAlarm', {
      metric: 'LogTtlJobAgeHours', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.logTtlJobAgeHours,
      period: 300, periods: 1, missing: 'notBreaching', condition: cw,
      description: 'The hourly CronJob clickhouse-log-ttl has not succeeded for 3 hours (kubectl -n clickhouse get jobs; logs of the failed job).',
    });
  }
  alarm('TooManyPartsAlarm', {
    metric: 'MaxPartsPerPartition', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 600,
    period: 300, periods: 1, missing: 'notBreaching', condition: cw,
    description: 'A partition has > 600 active parts (inserts are delayed at 1000 and rejected at 3000): batch inserts or use async_insert.',
  });
  alarm('DelayedInsertsAlarm', {
    metric: 'DelayedInserts', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 0,
    period: 60, periods: 3, missing: 'notBreaching', condition: cw,
    description: 'Inserts are being throttled because of too many parts.',
  });
  alarm('ReplicaDelayAlarm', {
    metric: 'MaxReplicaDelaySeconds', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 300,
    period: 300, periods: 3, missing: 'notBreaching', condition: cw,
    description: 'A replica is more than 5 minutes behind for 15 minutes.',
  });
  alarm('ReadonlyReplicaAlarm', {
    metric: 'ReadonlyReplicas', stat: 'Maximum', op: 'GreaterThanOrEqualToThreshold', threshold: 1,
    period: 60, periods: 2, missing: 'notBreaching', condition: cw,
    description: 'A replicated table is read-only (usually lost connection to ClickHouse Keeper).',
  });
  alarm('ReplicationQueueAlarm', {
    metric: 'ReplicationQueueSize', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 1000,
    period: 300, periods: 3, missing: 'notBreaching', condition: cw,
    description: 'The replication queue of a node is above 1000 entries for 15 minutes.',
  });
  alarm('KeeperSessionAlarm', {
    metric: 'KeeperSessionUp', stat: 'Minimum', op: 'LessThanThreshold', threshold: 1,
    period: 60, periods: 3, missing: 'notBreaching', condition: cw,
    description: 'A ClickHouse server has no session to ClickHouse Keeper.',
  });
  alarm('KeeperNoLeaderAlarm', {
    metric: 'KeeperIsLeader', stat: 'Maximum', op: 'LessThanThreshold', threshold: 1,
    period: 60, periods: 3, missing: 'breaching', condition: cw,
    description: 'The ClickHouse Keeper ensemble has no leader (no quorum): replicated tables are read-only.',
  });
  alarm('FailedMutationsAlarm', {
    metric: 'FailedMutations', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 0,
    period: 300, periods: 1, missing: 'notBreaching', condition: cw,
    description: 'An ALTER mutation keeps failing (see system.mutations.latest_fail_reason).',
  });
  alarm('RejectedInsertsAlarm', {
    metric: 'RejectedInserts', stat: 'Sum', op: 'GreaterThanThreshold', threshold: 0,
    period: 300, periods: 1, missing: 'notBreaching', condition: cw,
    description: 'INSERTs were rejected with "Too many parts" (clients got errors): batch inserts or use async_insert.',
  });
  alarm('DistributedQueueAlarm', {
    metric: 'DistributedFilesToInsert', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.distributedFilesToInsert,
    period: 300, periods: 3, missing: 'notBreaching', condition: cw,
    description: `More than ${THRESHOLDS.distributedFilesToInsert} files of asynchronous Distributed inserts are queued on a node for 15 minutes (a shard unreachable or too slow; see system.distribution_queue).`,
  });
  alarm('FailedQueriesAlarm', {
    metric: 'FailedQueries', stat: 'Sum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.failedQueriesPer5m,
    period: 300, periods: 2, missing: 'notBreaching', condition: cw,
    description: `More than ${THRESHOLDS.failedQueriesPer5m} queries per 5 minutes failed in the cluster for 10 minutes (system.query_log, type = 'Exception*').`,
  });
  alarm('KeeperErrorsAlarm', {
    metric: 'KeeperHardwareExceptions', stat: 'Sum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.keeperErrorsPer5m,
    period: 300, periods: 2, missing: 'notBreaching', condition: cw,
    description: 'ClickHouse servers keep losing their connection / session to ClickHouse Keeper (ZooKeeperHardwareExceptions) for 10 minutes.',
  });
  alarm('ServerRestartAlarm', {
    metric: 'ServerRestarts', stat: 'Sum', op: 'GreaterThanOrEqualToThreshold', threshold: 1,
    period: 300, periods: 1, missing: 'notBreaching', condition: cw,
    description: 'A ClickHouse server restarted without a version change (crash, OOM kill, node replacement); see the ServerRestarts graph for the node.',
  });
  alarm('KeeperLatencyAlarm', {
    metric: 'KeeperAvgLatencyMs', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.keeperLatencyMs,
    period: 300, periods: 2, missing: 'notBreaching', condition: cw,
    description: `The average request latency of a Keeper node is above ${THRESHOLDS.keeperLatencyMs} ms for 10 minutes (slow disk, overload).`,
  });
  alarm('KeeperOutstandingRequestsAlarm', {
    metric: 'KeeperOutstandingRequests', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: THRESHOLDS.keeperOutstandingRequests,
    period: 60, periods: 5, missing: 'notBreaching', condition: cw,
    description: `A Keeper node has more than ${THRESHOLDS.keeperOutstandingRequests} outstanding requests for 5 minutes (overloaded).`,
  });
  alarm('BackupStaleAlarm', {
    metric: 'BackupAgeHours', stat: 'Maximum', op: 'GreaterThanThreshold', threshold: 26,
    period: 300, periods: 1, missing: 'notBreaching',
    condition: new CfnCondition(stack, 'BackupAlarmCondition', { expression: Fn.conditionAnd(p.cloudWatch, p.backupEnabled) }),
    description: 'No successful backup for more than 26 hours (see the backup logs of replica 1 of each shard, docs/operations-guide.md).',
  });

  // ---------------------------------------------------------------- dashboard
  const search = (metric: string, stat: string, dims = 'Cluster,Node') => [{
    expression: `SEARCH('{${METRIC_NAMESPACE},${dims}} MetricName="${metric}" Cluster="${Aws.STACK_NAME}"', '${stat}', 60)`,
    id: `e${metric.replace(/[^A-Za-z]/g, '').toLowerCase()}`,
  }];
  const widget = (title: string, metrics: object[][], x: number, y: number, extra: object = {}) => ({
    type: 'metric', x, y, width: 8, height: 6,
    properties: { title, region: Aws.REGION, view: 'timeSeries', stacked: false, metrics, ...extra },
  });
  const pct = { yAxis: { left: { min: 0, max: 100 } } };
  const body = {
    widgets: [
      widget('Nodes up (ServerUp / KeeperUp)', [search('ServerUp', 'Minimum'), search('KeeperUp', 'Minimum')], 0, 0),
      widget('Data volume used %', [search('DataDiskUsedPercent', 'Maximum')], 8, 0, pct),
      widget('CPU used %', p.cpuMemoryWidgets?.cpu ?? [search('CpuUsedPercent', 'Maximum')], 16, 0, pct),
      widget('Memory used %', p.cpuMemoryWidgets?.memory ?? [search('MemoryUsedPercent', 'Maximum')], 0, 6, pct),
      widget('Max active parts in a partition', [search('MaxPartsPerPartition', 'Maximum')], 8, 6),
      widget('Delayed inserts', [search('DelayedInserts', 'Maximum')], 16, 6),
      widget('Replication queue size', [search('ReplicationQueueSize', 'Maximum')], 0, 12),
      widget('Max replica delay (s)', [search('MaxReplicaDelaySeconds', 'Maximum')], 8, 12),
      widget('Read-only replicas', [search('ReadonlyReplicas', 'Maximum')], 16, 12),
      widget('Keeper leader', [search('KeeperIsLeader', 'Maximum')], 0, 18),
      widget('Keeper avg latency (ms)', [search('KeeperAvgLatencyMs', 'Maximum')], 8, 18),
      widget('Hours since last backup', [search('BackupAgeHours', 'Maximum')], 16, 18),
      widget('Failed queries / rejected inserts (per minute)', [search('FailedQueries', 'Sum'), search('RejectedInserts', 'Sum')], 0, 24),
      widget('Distributed files to insert', [search('DistributedFilesToInsert', 'Maximum')], 8, 24),
      widget('Server restarts / Keeper connection errors', [search('ServerRestarts', 'Sum'), search('KeeperHardwareExceptions', 'Sum')], 16, 24),
      widget('Keeper outstanding requests', [search('KeeperOutstandingRequests', 'Maximum')], 0, 30),
      ...(eks ? [] : [widget('Root volume used %', [search('RootDiskUsedPercent', 'Maximum')], 8, 30, pct)]),
    ],
  };
  withCondition(new cloudwatch.CfnDashboard(stack, 'CloudWatchDashboard', {
    dashboardName: Fn.join('-', [Aws.STACK_NAME, 'clickhouse']),
    dashboardBody: stack.toJsonString(body),
  }), p.cloudWatch);
}

const ALERT_MANAGER_YAML = `alertmanager_config: |
  route:
    receiver: sns
    group_by: ['alertname', 'node']
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
  receivers:
    - name: sns
      sns_configs:
        - topic_arn: \${TopicArn}
          send_resolved: true
          sigv4:
            region: \${AWS::Region}
          subject: '[ClickHouse \${AWS::StackName}] {{ .Status }} {{ .CommonLabels.alertname }}'
`;

/**
 * Prometheus alert rules (Fn::Sub template: ExpectedServers, ExpectedKeepers, DiskThreshold).
 * ClickHouse exports its metrics as ClickHouseMetrics_*, ClickHouseProfileEvents_* and ClickHouseAsyncMetrics_*; the
 * `clickhouse-health` scrape job adds clickhouse_failed_mutations. Host metrics come from node_exporter on EC2, and from
 * ClickHouse's OS metrics, the kubelet and cAdvisor on EKS (managed scraper).
 *
 * Node down: a node alerts when it has been seen within the last 3 hours but is not up now (target down, or its series
 * vanished: dead EC2 node, deleted pod). Nodes that are still being created (scale-out) have no history, so they do not
 * alert; the count-based *Missing rules (30 minutes) catch nodes that never came up or have been down for hours.
 */
export function alertRulesYaml(platform: 'ec2' | 'eks', diskUsedExpr: string): string {
  const h = HOST_EXPRS[platform];
  const rootDisk = h.rootDisk ? `
      - alert: ClickHouseRootDiskUsage
        expr: max by (node) (${h.rootDisk}) > ${THRESHOLDS.rootDiskPercent}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'Root volume of {{ $labels.node }} is {{ $value | printf "%.0f" }}% full.' }` : '';
  const kubernetes = platform === 'eks' ? `
  - name: clickhouse-kubernetes
    rules:
      - alert: ClickHouseKeeperDiskUsage
        expr: max by (persistentvolumeclaim) (100 * (1 - kubelet_volume_stats_available_bytes{namespace="clickhouse", persistentvolumeclaim=~"keeper-data-.*"} / kubelet_volume_stats_capacity_bytes{namespace="clickhouse", persistentvolumeclaim=~"keeper-data-.*"})) > \${DiskThreshold}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'Keeper volume {{ $labels.persistentvolumeclaim }} is {{ $value | printf "%.0f" }}% full: grow KeeperDataVolumeSize.' }
      - alert: ClickHouseContainerOOMKilled
        expr: max by (pod, container) (max_over_time(container_oom_events_total{namespace="clickhouse"}[15m])) > 0
        labels: { severity: warning }
        annotations: { summary: 'Container {{ $labels.container }} of pod {{ $labels.pod }} hit its memory limit (OOM kill).' }
      - alert: ClickHouseKeeperRestarted
        expr: count by (pod) (count_over_time(container_start_time_seconds{namespace="clickhouse", container="clickhouse-keeper"}[1h])) > 1 unless on (pod) count by (pod) (count by (pod, image) (count_over_time(container_start_time_seconds{namespace="clickhouse", container="clickhouse-keeper"}[1h]))) > 1
        labels: { severity: warning }
        annotations: { summary: 'Keeper pod {{ $labels.pod }} restarted within the last hour without an image change.' }` : '';
  return `groups:
  - name: clickhouse-availability
    rules:
      - alert: ClickHouseServerDown
        expr: max by (node) (max_over_time(up{job="clickhouse"}[3h])) unless max by (node) (up{job="clickhouse"} == 1)
        for: 3m
        labels: { severity: critical }
        annotations: { summary: 'ClickHouse server {{ $labels.node }} is down or not scraped.' }
      - alert: ClickHouseServersMissing
        expr: (count(up{job="clickhouse"} == 1) or vector(0)) < \${ExpectedServers}
        for: 30m
        labels: { severity: critical }
        annotations: { summary: 'Fewer ClickHouse servers are up than expected (\${ExpectedServers}) for 30 minutes.' }
      - alert: ClickHouseKeeperDown
        expr: max by (node) (max_over_time(up{job="keeper"}[3h])) unless max by (node) (up{job="keeper"} == 1)
        for: 3m
        labels: { severity: critical }
        annotations: { summary: 'ClickHouse Keeper {{ $labels.node }} is down or not scraped.' }
      - alert: ClickHouseKeepersMissing
        expr: (count(up{job="keeper"} == 1) or vector(0)) < \${ExpectedKeepers}
        for: 30m
        labels: { severity: critical }
        annotations: { summary: 'Fewer ClickHouse Keeper nodes are up than expected (\${ExpectedKeepers}) for 30 minutes.' }
      - alert: ClickHouseServerRestarted
        expr: (max by (node) (max_over_time(ClickHouseAsyncMetrics_Uptime{job="clickhouse"}[1h])) > max by (node) (ClickHouseAsyncMetrics_Uptime{job="clickhouse"}) + 60) unless on (node) (max by (node) (max_over_time(ClickHouseMetrics_VersionInteger{job="clickhouse"}[1h])) > min by (node) (min_over_time(ClickHouseMetrics_VersionInteger{job="clickhouse"}[1h])))
        labels: { severity: warning }
        annotations: { summary: 'ClickHouse server {{ $labels.node }} restarted within the last hour without a version change (crash, OOM kill?).' }
      - alert: ClickHouseKeeperNoLeader
        expr: (max(ClickHouseAsyncMetrics_KeeperIsLeader + ClickHouseAsyncMetrics_KeeperIsStandalone) or vector(0)) < 1
        for: 3m
        labels: { severity: critical }
        annotations: { summary: 'The ClickHouse Keeper ensemble has no leader (no quorum).' }
      - alert: ClickHouseReadonlyReplica
        expr: max by (node) (ClickHouseMetrics_ReadonlyReplica) > 0
        for: 2m
        labels: { severity: critical }
        annotations: { summary: 'Read-only replicated tables on {{ $labels.node }} (lost Keeper session?).' }
      - alert: ClickHouseKeeperSessionLost
        expr: (max by (node) (ClickHouseMetrics_ZooKeeperSession{job="clickhouse"}) < 1) or (max by (node) (ClickHouseMetrics_ZooKeeperSessionExpired{job="clickhouse"}) > 0)
        for: 3m
        labels: { severity: critical }
        annotations: { summary: 'ClickHouse server {{ $labels.node }} has no (or an expired) session to ClickHouse Keeper.' }
      - alert: ClickHouseKeeperConnectionErrors
        expr: sum by (node) (increase(ClickHouseProfileEvents_ZooKeeperHardwareExceptions{job="clickhouse"}[5m])) > ${THRESHOLDS.keeperErrorsPer5m}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'ClickHouse server {{ $labels.node }} keeps losing its connection to ClickHouse Keeper.' }
  - name: clickhouse-capacity
    rules:
      - alert: ClickHouseDataDiskUsage
        expr: max by (node) (${diskUsedExpr}) > \${DiskThreshold}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'Data volume of {{ $labels.node }} is {{ $value | printf "%.0f" }}% full.' }${rootDisk}
      - alert: ClickHouseCpuHigh
        expr: max by (node) (${h.cpu}) > ${THRESHOLDS.cpuPercent}
        for: 15m
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.node }} uses {{ $value | printf "%.0f" }}% CPU.' }
      - alert: ClickHouseMemoryHigh
        expr: max by (node) (${h.memory}) > ${THRESHOLDS.memoryPercent}
        for: 15m
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.node }} uses {{ $value | printf "%.0f" }}% of its memory (limit).' }
      - alert: ClickHouseTooManyParts
        expr: max by (node) (ClickHouseAsyncMetrics_MaxPartCountForPartition) > 600
        for: 5m
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.node }}: a partition has {{ $value }} active parts (inserts are delayed at 1000).' }
      - alert: ClickHouseDelayedInserts
        expr: max by (node) (ClickHouseMetrics_DelayedInserts) > 0
        for: 3m
        labels: { severity: warning }
        annotations: { summary: 'Inserts are throttled on {{ $labels.node }} (too many parts).' }
      - alert: ClickHouseRejectedInserts
        expr: sum by (node) (increase(ClickHouseProfileEvents_RejectedInserts[5m])) > 0
        labels: { severity: critical }
        annotations: { summary: 'INSERTs were rejected on {{ $labels.node }} (too many parts).' }
      - alert: ClickHouseDistributedQueue
        expr: max by (node) (ClickHouseMetrics_DistributedFilesToInsert) > ${THRESHOLDS.distributedFilesToInsert}
        for: 15m
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.node }} has {{ $value }} queued files of asynchronous Distributed inserts (system.distribution_queue).' }
      - alert: ClickHouseFailedQueries
        expr: sum(increase(ClickHouseProfileEvents_FailedQuery{job="clickhouse"}[5m])) > ${THRESHOLDS.failedQueriesPer5m}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: '{{ $value | printf "%.0f" }} queries failed in the cluster in the last 5 minutes.' }
      - alert: ClickHouseFailedMutations
        expr: max by (node) (clickhouse_failed_mutations) > 0
        for: 5m
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.node }}: {{ $value }} ALTER mutation(s) keep failing (system.mutations.latest_fail_reason).' }
      - alert: ClickHouseReplicaDelay
        expr: max by (node) (ClickHouseAsyncMetrics_ReplicasMaxAbsoluteDelay) > 300
        for: 15m
        labels: { severity: warning }
        annotations: { summary: 'Replica on {{ $labels.node }} is {{ $value }}s behind.' }
      - alert: ClickHouseReplicationQueue
        expr: max by (node) (ClickHouseAsyncMetrics_ReplicasMaxQueueSize) > 1000
        for: 15m
        labels: { severity: warning }
        annotations: { summary: 'Replication queue on {{ $labels.node }} has {{ $value }} entries.' }
      - alert: ClickHouseKeeperLatency
        expr: max by (node) (ClickHouseAsyncMetrics_KeeperAvgLatency{job="keeper"}) > ${THRESHOLDS.keeperLatencyMs}
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'Keeper {{ $labels.node }}: average request latency {{ $value }} ms.' }
      - alert: ClickHouseKeeperOutstandingRequests
        expr: max by (node) (ClickHouseMetrics_KeeperOutstandingRequests{job="keeper"}) > ${THRESHOLDS.keeperOutstandingRequests}
        for: 5m
        labels: { severity: warning }
        annotations: { summary: 'Keeper {{ $labels.node }} has {{ $value }} outstanding requests.' }${kubernetes}
`;
}

/** Backup age (node_exporter textfile collector on EC2, /ops-metrics on EKS); only deployed with EnableBackup=true. */
const BACKUP_RULES_YAML = `groups:
  - name: clickhouse-backup
    rules:
      - alert: ClickHouseBackupStale
        expr: time() - max by (node) (clickhouse_backup_last_success_timestamp_seconds) > 26 * 3600
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'No successful backup on {{ $labels.node }} for more than 26 hours.' }
`;

/**
 * Scrape parameters of the `clickhouse-health` job (EC2 Prometheus agent and EKS managed scraper): a query over the
 * default HTTP handler as the read-only ops_monitor user, in the Prometheus text format.
 */
export const HEALTH_QUERY = "SELECT 'clickhouse_failed_mutations' AS name, toFloat64(count()) AS value, "
  + "'Unfinished mutations whose last attempt failed' AS help, 'gauge' AS type "
  + "FROM system.mutations WHERE NOT is_done AND latest_fail_reason != '' FORMAT Prometheus";
