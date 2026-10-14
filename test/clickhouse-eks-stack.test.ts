import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ClickHouseEksStack, CLUSTER_NAME_MAX_LENGTH, EKS_MAX_REPLICAS, EKS_MAX_SHARDS } from '../lib/eks/clickhouse-eks-stack';

const app = new App({ analyticsReporting: false, context: { 'aws:cdk:enable-path-metadata': false } });
const stack = new ClickHouseEksStack(app, 'EksTestStack', { synthesizer: new BootstraplessSynthesizer() });
const template = Template.fromStack(stack);
const json = template.toJSON();
const byType = (t: string) => Object.entries(template.findResources(t));

test('no assets, no bootstrap, no IRSA / OIDC provider', () => {
  const types = Object.values(json.Resources).map((r: any) => r.Type);
  expect(types).not.toContain('AWS::IAM::OIDCProvider');
  expect(types).not.toContain('Custom::AWSCDK-EKS-Cluster');
  expect(JSON.stringify(json)).not.toMatch(/AssumeRoleWithWebIdentity|cdk-hnb659fds|BootstrapVersion/);
  expect(JSON.stringify(json).length).toBeLessThan(1_000_000); // CloudFormation template limit (S3)
});

test('network: new VPC or existing VPC + subnets', () => {
  expect(json.Parameters.CreateVpc.AllowedValues).toEqual(['true', 'false']);
  expect(json.Parameters.VpcId.Default).toBe('');
  expect(json.Parameters.SubnetIds.Type).toBe('CommaDelimitedList');
  for (const [, r] of byType('AWS::EC2::Subnet')) expect(r.Condition).toBe('CreateNewVpc');
  expect(byType('AWS::EC2::Subnet')).toHaveLength(6);
  expect(json.Rules.ExistingVpcNeedsIds).toBeDefined();
});

test('EKS: API auth mode, secrets encryption, control plane logs, self-managed add-ons off', () => {
  const [[, c]] = byType('AWS::EKS::Cluster');
  expect(c.Properties.AccessConfig.AuthenticationMode).toBe('API');
  expect(c.Properties.BootstrapSelfManagedAddons).toBe(false);
  expect(c.Properties.EncryptionConfig[0].Resources).toEqual(['secrets']);
  expect(c.Properties.ResourcesVpcConfig.EndpointPrivateAccess).toBe(true);
  expect(json.Parameters.KubernetesVersion.Default).toBe('1.36');
});

test('every AWS permission of a pod comes from EKS Pod Identity', () => {
  const associations = byType('AWS::EKS::PodIdentityAssociation').map(([, r]) => `${r.Properties.Namespace}/${r.Properties.ServiceAccount}`);
  expect(associations.sort()).toEqual(['clickhouse/ch-cw-metrics', 'clickhouse/clickhouse', 'kube-system/aws-load-balancer-controller']);
  const addonIdentities = byType('AWS::EKS::Addon').flatMap(([, r]) => (r.Properties.PodIdentityAssociations ?? []).map((a: any) => `${r.Properties.AddonName}:${a.ServiceAccount}`));
  expect(addonIdentities.sort()).toEqual(['amazon-cloudwatch-observability:cloudwatch-agent', 'aws-ebs-csi-driver:ebs-csi-controller-sa', 'vpc-cni:aws-node']);
  for (const [, r] of byType('AWS::IAM::Role')) {
    const principals = JSON.stringify(r.Properties.AssumeRolePolicyDocument);
    if (principals.includes('pods.eks.amazonaws.com')) expect(principals).toContain('sts:TagSession');
  }
  // the node role has no CNI permissions (the VPC CNI uses Pod Identity)
  expect(JSON.stringify(json.Resources.NodeRole)).not.toContain('AmazonEKS_CNI_Policy');
});

test('node groups: system + per-AZ keeper and server groups, dedicated by taints', () => {
  const ngs = Object.fromEntries(byType('AWS::EKS::Nodegroup'));
  expect(Object.keys(ngs).sort()).toEqual(['KeeperNodeGroup1', 'KeeperNodeGroup2', 'KeeperNodeGroup3', 'ServerNodeGroup1', 'ServerNodeGroup2', 'ServerNodeGroup3', 'SystemNodeGroup']);
  expect(ngs.SystemNodeGroup.Properties.Taints).toBeUndefined();
  for (const r of [1, 2, 3]) {
    const ng = ngs[`ServerNodeGroup${r}`];
    expect(ng.Properties.Labels).toEqual({ 'clickhouse-on-aws/role': 'server', 'clickhouse-on-aws/slot': String(r) });
    expect(ng.Properties.Taints).toEqual([{ Key: 'clickhouse-on-aws/dedicated', Value: 'server', Effect: 'NO_SCHEDULE' }]);
    expect(ng.Properties.Subnets).toHaveLength(1);
    expect(ng.Properties.ScalingConfig.DesiredSize).toEqual({ Ref: 'ShardCount' });
  }
  expect(ngs.ServerNodeGroup2.Condition).toBe('ReplicasAtLeast2');
  expect(ngs.KeeperNodeGroup3.Condition).toBe('ThreeKeepers');
  // keeper / server: an instance type change replaces the node group (blue/green, the installer moves the pods); generated
  // names, so the replacement can exist next to the old group. system: in-place rolling update (launch template version)
  for (const [id, ng] of Object.entries(ngs) as [string, any][]) {
    expect(ng.Properties.NodegroupName).toBeUndefined();
    if (id === 'SystemNodeGroup') expect(ng.Properties.InstanceTypes).toBeUndefined();
    else expect(ng.Properties.InstanceTypes).toEqual([{ Ref: id.startsWith('Keeper') ? 'KeeperInstanceType' : 'ClickHouseInstanceType' }]);
  }
  expect(json.Resources.SystemLaunchTemplate.Properties.LaunchTemplateData.InstanceType).toEqual({ Ref: 'SystemInstanceType' });
  for (const lt of ['KeeperLaunchTemplate', 'ServerLaunchTemplate']) expect(json.Resources[lt].Properties.LaunchTemplateData.InstanceType).toBeUndefined();
  // one node group of a role at a time
  for (const [a, b] of [['KeeperNodeGroup2', 'KeeperNodeGroup1'], ['KeeperNodeGroup3', 'KeeperNodeGroup2'], ['ServerNodeGroup2', 'ServerNodeGroup1'], ['ServerNodeGroup3', 'ServerNodeGroup2']]) {
    expect(ngs[a].DependsOn).toContain(b);
  }
  // the installer gets the current node group names (a replaced group has a new name) and instance types
  const cr = json.Resources.ClusterInstall.Properties;
  expect(JSON.stringify(cr.NodeGroups)).toContain('"KeeperNodeGroup1","NodegroupName"');
  expect(cr.KeeperInstanceType).toEqual({ Ref: 'KeeperInstanceType' });
  expect(cr.ClickHouseInstanceType).toEqual({ Ref: 'ClickHouseInstanceType' });
});

/** Evaluates the template's conditions for the given parameter values. */
function conditionsFor(values: Record<string, string>): Record<string, boolean> {
  const memo: Record<string, boolean> = {};
  const val = (x: any): string => (typeof x === 'string' ? x : values[x.Ref]);
  const ev = (e: any): boolean => {
    if (e.Condition) return cond(e.Condition);
    if (e['Fn::Equals']) return val(e['Fn::Equals'][0]) === val(e['Fn::Equals'][1]);
    if (e['Fn::Or']) return e['Fn::Or'].some(ev);
    if (e['Fn::And']) return e['Fn::And'].every(ev);
    if (e['Fn::Not']) return !ev(e['Fn::Not'][0]);
    throw new Error(`unsupported condition ${JSON.stringify(e)}`);
  };
  const cond = (n: string): boolean => (memo[n] ??= ev(json.Conditions[n]));
  for (const n of Object.keys(json.Conditions)) cond(n);
  return memo;
}

test('every DependsOn points at a resource that exists, for every combination of the condition parameters', () => {
  const used = [...new Set(JSON.stringify(json.Conditions).match(/"Ref":"[A-Za-z0-9]+"/g)!.map((m) => m.slice(7, -1)))];
  const choices = used.map((p) => json.Parameters[p].AllowedValues ?? ['', 'x']);
  const deps = Object.entries(json.Resources).map(([id, r]: [string, any]) => [id, r.Condition, [r.DependsOn ?? []].flat()] as [string, string | undefined, string[]]);
  let combos = 0;
  const visit = (i: number, values: Record<string, string>) => {
    if (i < used.length) {
      for (const v of choices[i]) visit(i + 1, { ...values, [used[i]]: v });
      return;
    }
    combos++;
    const c = conditionsFor(values);
    const exists = (id: string) => { const k = json.Resources[id].Condition; return !k || c[k]; };
    for (const [id, , on] of deps) {
      if (!exists(id)) continue;
      for (const d of on) if (!exists(d)) throw new Error(`${id} depends on ${d}, which does not exist with ${JSON.stringify(values)}`);
    }
  };
  visit(0, {});
  expect(used).toEqual(expect.arrayContaining(['KeeperCount', 'ReplicaCount', 'ShardCount']));
  expect(combos).toBeGreaterThan(1000);
});

test('update guard: checked first, protects the cluster identity, its AZ placement and the data', () => {
  const guard = json.Resources.UpdateGuard;
  expect(guard.Type).toBe('AWS::CloudFormation::CustomResource');
  const props = JSON.stringify(guard.Properties);
  for (const p of ['ClusterName', 'KeeperCount', 'CreateVpc', 'VpcCidr', 'VpcId', 'MultiAZ']) expect(props).toContain(`\\"${p}\\":\\"`);
  expect(JSON.stringify(guard.Properties.Immutable)).toContain('"SubnetIds\\":\\"",{"Fn::Join":[",",{"Ref":"SubnetIds"}]}');
  for (const p of ['ShardCount', 'DataVolumeSize', 'KeeperDataVolumeSize']) expect(JSON.stringify(guard.Properties.NoDecrease)).toContain(`{"Ref":"${p}"}`);
  for (const p of ['ClickHouseVersion', 'KubernetesVersion']) expect(JSON.stringify(guard.Properties.NoDowngrade)).toContain(`{"Ref":"${p}"}`);
  // ReplicaCount may shrink (the operator drops the removed replicas from Keeper)
  expect(props).not.toContain('ReplicaCount');
  const exempt = new Set(['UpdateGuard', 'UpdateGuardFunction', 'UpdateGuardRole']);
  for (const [id, r] of Object.entries(json.Resources) as [string, any][]) {
    if (!exempt.has(id)) expect([r.DependsOn ?? []].flat()).toContain('UpdateGuard');
  }
});

test('parameters: ClusterName length fits the operator object names, no wide-open network defaults', () => {
  const re = new RegExp(json.Parameters.ClusterName.AllowedPattern);
  const longest = 'a'.repeat(CLUSTER_NAME_MAX_LENGTH);
  expect(re.test(longest)).toBe(true);
  expect(re.test('a'.repeat(CLUSTER_NAME_MAX_LENGTH + 1))).toBe(false);
  expect(re.test(json.Parameters.ClusterName.Default)).toBe(true);
  // operator names: the cluster part is cut at 15 characters; StatefulSet <= 52 (controller-revision-hash label), DNS labels <= 63
  expect(CLUSTER_NAME_MAX_LENGTH).toBeLessThanOrEqual(15);
  const s = EKS_MAX_SHARDS - 1, r = EKS_MAX_REPLICAS - 1;
  expect(`chi-${longest}-${longest}-${s}-${r}`.length).toBeLessThanOrEqual(52);
  expect(`chi-${longest}-deploy-confd-${longest}-${s}-${r}`.length).toBeLessThanOrEqual(63);
  expect(`data-chi-${longest}-${longest}-${s}-${r}-0`.length).toBeLessThanOrEqual(63);

  const cidr = new RegExp(json.Parameters.ClientCidr.AllowedPattern);
  expect(json.Parameters.ClientCidr.Default).toBeUndefined();
  for (const ok of ['10.0.0.0/8', '172.31.0.0/16', '192.168.1.10/32']) expect(cidr.test(ok)).toBe(true);
  for (const bad of ['', '10.0.0.0', '256.0.0.0/8', '10.0.0.0/33', '10.0.0/8', '1.2.3.4/16 ']) expect(cidr.test(bad)).toBe(false);
  expect(json.Parameters.EksPublicAccessCidrs.Default).toBe('');
  expect(json.Parameters.EksPublicEndpoint.Default).toBe('false');
  expect(JSON.stringify(json.Rules.PublicEndpointNeedsCidrs)).toContain('EksPublicAccessCidrs');
});

test('no ops_monitor password anywhere (password-less, VPC-only user)', () => {
  expect(byType('AWS::SecretsManager::Secret').map(([id]) => id).sort()).toEqual(['AdminPassword', 'OperatorPassword']);
  const blob = JSON.stringify(json.Resources.PrometheusScraper.Properties.ScrapeConfiguration);
  expect(blob).toContain('ops_monitor');
  expect(blob).not.toMatch(/password|resolve:secretsmanager/);
  expect(JSON.stringify(json.Resources.ClusterInstall.Properties)).not.toContain('OpsMonitor');
});

test('installer custom resource gets the whole cluster configuration and is deleted before the cluster', () => {
  const [[, cr]] = byType('AWS::CloudFormation::CustomResource');
  for (const k of ['ClusterName', 'ClickHouseVersion', 'ShardCount', 'ReplicaCount', 'KeeperCount', 'Monitoring', 'EnableBackup', 'AdminSecretArn']) {
    expect(cr.Properties[k]).toBeDefined();
  }
  expect(cr.Properties.ServiceTimeout).toBe(3600);
  // the installer gets its deadline (ServiceTimeout minus a margin) from the trigger
  expect(json.Resources.InstallerTrigger.Properties.Code.ZipFile).toContain('"DEADLINE": str(int(time.time()) + 3360)');
  expect(cr.DependsOn).toEqual(expect.arrayContaining(['EbsCsiAddon', 'CoreDnsAddon', 'InstallerAccess']));
  const [[, project]] = byType('AWS::CodeBuild::Project');
  expect(project.Properties.VpcConfig).toBeDefined();
  expect(project.Properties.Source.BuildSpec).toContain('install.sh');
});

test('monitoring: CloudWatch alarms reuse the EC2 metrics, Prometheus uses the managed scraper', () => {
  const alarms = byType('AWS::CloudWatch::Alarm');
  // per slot: down + data volume (Keeper volumes from the kubelet); 18 cluster-wide + node root volume, OOM kills, log TTL job
  expect(alarms.length).toBe((EKS_MAX_SHARDS * EKS_MAX_REPLICAS + 3) * 2 + 21);
  for (const [, a] of alarms) expect(a.DependsOn).toContain('ClusterInstall');
  const ci = Object.fromEntries(alarms.filter(([, a]) => a.Properties.Namespace === 'ContainerInsights').map(([id, a]) => [id, a.Properties]));
  expect(Object.keys(ci).sort()).toEqual(['CpuHighAlarm', 'MemoryHighAlarm', 'NodeRootDiskAlarm', 'OomKilledAlarm']);
  expect(ci.MemoryHighAlarm.MetricName).toBe('pod_memory_utilization_over_pod_limit');
  expect(ci.MemoryHighAlarm.Dimensions).toEqual([{ Name: 'ClusterName', Value: { Ref: 'AWS::StackName' } }, { Name: 'Namespace', Value: 'clickhouse' }]);
  expect(json.Resources.Keeper2DataDiskAlarm.Condition).toBeDefined();
  expect(json.Resources.LogTtlJobAlarm.Properties.MetricName).toBe('LogTtlJobAgeHours');
  const [[, scraper]] = byType('AWS::APS::Scraper');
  expect(scraper.Condition).toBe('MonitoringPrometheus');
  const ns = template.findResources('AWS::APS::RuleGroupsNamespace');
  const rules = JSON.stringify(ns.PrometheusAlertRules);
  expect(rules).toContain('ClickHouseAsyncMetrics_DiskAvailable{disk=\\"default\\"}');
  for (const a of ['ClickHouseKeeperDiskUsage', 'ClickHouseContainerOOMKilled', 'ClickHouseKeeperRestarted', 'ClickHouseServerRestarted', 'ClickHouseMemoryHigh']) {
    expect(rules).toContain(`alert: ${a}\\n`);
  }
  expect(rules).not.toContain('ClickHouseRootDiskUsage');
  expect(rules).not.toContain('node_filesystem');
  expect(ns.PrometheusBackupAlertRules.Condition).toBe('PrometheusBackupAlerts');
  // kubelet + cAdvisor through the API server proxy (AWS sample configuration), only namespace clickhouse kept
  const blob = JSON.stringify(scraper.Properties.ScrapeConfiguration);
  expect(blob).toContain('/api/v1/nodes/$1/proxy/metrics/cadvisor');
  expect(blob).toContain('/api/v1/nodes/$1/proxy/metrics\'');
  expect(blob).toContain('credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token');
  expect(blob).toContain('job_name: clickhouse-health');
  expect(blob.match(/;clickhouse', action: keep/g)).toHaveLength(2);
  expect(json.Parameters.GrafanaAuthProvider.Default).toBe('SAML');
});

test('metrics publisher and scraper RBAC: the publisher reads kubelet metrics without nodes/proxy', () => {
  const install = fs.readFileSync(path.join(__dirname, '../lib/eks/installer/install.sh'), 'utf8');
  const rbac = install.slice(install.indexOf('kind: ClusterRole\nmetadata: {name: ch-cw-metrics}'));
  expect(rbac.slice(0, rbac.indexOf('---'))).toContain('resources: [nodes/metrics], verbs: [get]');
  expect(rbac.slice(0, rbac.indexOf('---'))).not.toContain('nodes/proxy');
  expect(install).toContain('resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods, ingresses, configmaps]');
  const pub = fs.readFileSync(path.join(__dirname, '../lib/eks/installer/ch-cw-metrics.sh'), 'utf8');
  for (const m of ['FailedQueries', 'RejectedInserts', 'KeeperHardwareExceptions', 'DistributedFilesToInsert', 'ServerRestarts', 'LogTtlJobAgeHours', 'MaxPartCountForPartition']) {
    expect(pub).toContain(m);
  }
  expect(pub).not.toContain('FROM system.parts');
  // the node list (~12 KiB per node) is passed as a file: as one argument it exceeds the 128 KiB limit from about 10 nodes
  expect(install).not.toMatch(/"\$\(kubectl get nodes -o json\)"/);
  expect(install).toContain('kubectl get nodes -o json > /tmp/nodes.json');
});

test('renderer: CHK + CHI with one pod template per host, pinned to its replica node group', () => {
  const config = {
    ClusterName: 'demo', ShardCount: '2', ReplicaCount: String(EKS_MAX_REPLICAS), KeeperCount: '3', ClickHouseVersion: '26.8.24.9',
    EnableBackup: 'true', SystemLogRetentionDays: '30', ServerCpu: 'auto', ServerMemory: 'auto', KeeperCpu: '2', KeeperMemory: '4Gi',
    KeeperDataVolumeSize: '20', DataVolumeSize: '100', ClientCidr: '10.0.0.0/8', ClientLoadBalancer: 'false', SubnetIds: 's1,s2',
    BackupTimeUTC: '03:30', BackupBucket: 'b', Region: 'us-west-2', StackName: 'st', Monitoring: 'Prometheus', MetricNamespace: 'ClickHouse',
  };
  const facts = { install_ts: 1, data_vac: 'ch-data-3000-125', task_id: 'req-1', allocatable: { server: { cpu_m: 7910, mem_mi: 30000 }, keeper: { cpu_m: 1930, mem_mi: 7000 } }, vpc_cidrs: ['10.1.0.0/16'] };
  const out = JSON.parse(execFileSync('python3', [path.join(__dirname, '../lib/eks/installer/render.py'), JSON.stringify(facts)], {
    env: { ...process.env, CONFIG: JSON.stringify(config) },
  }).toString());
  const kinds = out.items.map((i: any) => `${i.kind}/${i.metadata.name}`);
  expect(kinds).toEqual(['ClickHouseKeeperInstallation/keeper', 'ClickHouseInstallation/demo', 'CronJob/clickhouse-log-ttl', 'CronJob/clickhouse-backup']);
  const chi = out.items[1];
  const pods = chi.spec.templates.podTemplates;
  expect(pods).toHaveLength(2 * EKS_MAX_REPLICAS);
  expect(pods[1].spec.nodeSelector).toEqual({ 'clickhouse-on-aws/role': 'server', 'clickhouse-on-aws/slot': '2' });
  const res = pods[0].spec.containers[0].resources;
  expect(res.requests).toEqual(res.limits); // Guaranteed QoS
  expect(res.requests).toEqual({ cpu: '7100m', memory: '27904Mi' });
  expect(chi.spec.configuration.clusters[0].secret).toEqual({ auto: 'true' });
  expect(chi.spec.templates.volumeClaimTemplates[0].reclaimPolicy).toBe('Retain');
  expect(out.items[3].spec.schedule).toBe('30 3 * * *');
  // the installer waits for the reconcile of this run
  expect(out.items[0].spec.taskID).toBe('req-1');
  expect(chi.spec.taskID).toBe('req-1');
  // ops_monitor: empty password (as SHA-256, else the operator sets its default password), VPC only, SELECT on a few tables
  const users = chi.spec.configuration.users;
  expect(users['ops_monitor/password_sha256_hex']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(users['ops_monitor/password']).toBeUndefined();
  expect(users['ops_monitor/networks/ip']).toEqual(['10.1.0.0/16', '127.0.0.1/32']);
  expect(users['ops_monitor/grants/query']).toContain('GRANT SELECT ON system.backup_log');
  expect(users['ops_monitor/grants/query']).toEqual(expect.arrayContaining(['GRANT SELECT ON system.asynchronous_metrics', 'GRANT SELECT ON system.events']));
  expect(users['ops_monitor/grants/query'].join()).not.toContain('system.*');
  expect(JSON.stringify(out)).not.toContain('clickhouse-ops-monitor');
  // ops jobs: password as CLICKHOUSE_PASSWORD from the Secret; backups try every replica of a shard
  const backupEnv = Object.fromEntries(out.items[3].spec.jobTemplate.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
  expect(backupEnv.CLICKHOUSE_PASSWORD).toEqual({ secretKeyRef: { name: 'clickhouse-admin', key: 'password' } });
  expect(backupEnv.BACKUP_SHARDS).toBe('chi-demo-demo-0-0,chi-demo-demo-0-1,chi-demo-demo-0-2 chi-demo-demo-1-0,chi-demo-demo-1-1,chi-demo-demo-1-2');
});
