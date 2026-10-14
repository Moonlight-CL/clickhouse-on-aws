import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ClickHouseClusterStack, MAX_REPLICAS, MAX_SHARDS } from '../lib/clickhouse-cluster-stack';
import { archOf } from '../lib/instance-types';
import { HEALTH_QUERY } from '../lib/monitoring';

const app = new App({ analyticsReporting: false, context: { 'aws:cdk:enable-path-metadata': false } });
const stack = new ClickHouseClusterStack(app, 'TestStack', { synthesizer: new BootstraplessSynthesizer() });
const template = Template.fromStack(stack);
const json = template.toJSON();

describe('parameters', () => {
  test('user-facing choices are parameters', () => {
    for (const name of [
      'ClusterName', 'ClickHouseVersion', 'ClickHouseInstanceType', 'KeeperInstanceType', 'ShardCount', 'ReplicaCount',
      'KeeperCount', 'VpcId', 'SubnetIds', 'MultiAZ', 'DataVolumeSize', 'ClientCidr',
    ]) {
      expect(json.Parameters[name]).toBeDefined();
    }
    expect(json.Parameters.ClickHouseVersion.Default).toBe('26.8.24.9');
    expect(json.Parameters.ShardCount.AllowedValues).toEqual(['1', '2', '3', '4', '5']);
    expect(json.Parameters.ReplicaCount.AllowedValues).toEqual(['1', '2', '3']);
    expect(json.Parameters.KeeperCount.AllowedValues).toEqual(['1', '3']);
    expect(json.Parameters.VpcId.Type).toBe('AWS::EC2::VPC::Id');
    expect(json.Parameters.SubnetIds.Type).toBe('List<AWS::EC2::Subnet::Id>');
    expect(json.Parameters.ClickHouseInstanceType.AllowedValues).toEqual(expect.arrayContaining(['m7g.xlarge', 'r8g.2xlarge', 'm7i.xlarge']));
  });

  test('every offered instance type has an architecture mapping', () => {
    const offered = [...json.Parameters.ClickHouseInstanceType.AllowedValues, ...json.Parameters.KeeperInstanceType.AllowedValues];
    for (const t of offered) expect(json.Mappings.InstanceArch[t].Arch).toBe(archOf(t));
  });

  test('ClientCidr is required and must be a valid IPv4 CIDR', () => {
    const p = json.Parameters.ClientCidr;
    expect(p.Default).toBeUndefined();
    const re = new RegExp(p.AllowedPattern);
    for (const ok of ['10.1.0.0/16', '172.31.0.0/16', '192.168.1.10/32', '0.0.0.0/0']) expect(re.test(ok)).toBe(true);
    for (const bad of ['10.0.0.0', '256.1.0.0/16', '10.0.0.0/33', '10.0.0/8', ' 10.0.0.0/8', '10.0.0.0/8,0.0.0.0/0']) expect(re.test(bad)).toBe(false);
  });
});

describe('update guard', () => {
  const guard = json.Resources.UpdateGuard;
  const keys = (prop: string): string[] => guard.Properties[prop]['Fn::Join'][1]
    .filter((x: any) => x.Ref).map((x: any) => x.Ref);

  test('rejects changes to immutable parameters, decreases and downgrades', () => {
    expect(guard.Type).toBe('AWS::CloudFormation::CustomResource');
    expect(keys('Immutable')).toEqual(['ClusterName', 'KeeperCount', 'VpcId', 'MultiAZ', 'ClickHouseInstanceType', 'KeeperInstanceType', 'SystemVolumeSize']);
    expect(JSON.stringify(guard.Properties.Immutable)).toContain('{"Fn::Join":[",",{"Ref":"SubnetIds"}]}');
    expect(keys('NoDecrease')).toEqual(['ShardCount', 'ReplicaCount', 'DataVolumeSize', 'KeeperDataVolumeSize']);
    expect(keys('NoDowngrade')).toEqual(['ClickHouseVersion']);
  });

  test('every other resource depends on it, so a rejected update changes nothing', () => {
    const exempt = ['UpdateGuard', 'UpdateGuardFunction', 'UpdateGuardRole'];
    for (const [id, r] of Object.entries<any>(json.Resources)) {
      if (!exempt.includes(id)) expect([id, r.DependsOn]).toEqual([id, expect.arrayContaining(['UpdateGuard'])]);
    }
  });
});

test('architecture detection', () => {
  expect(archOf('m7g.xlarge')).toBe('arm64');
  expect(archOf('t4g.medium')).toBe('arm64');
  expect(archOf('c7gn.large')).toBe('arm64');
  expect(archOf('m7i.xlarge')).toBe('x86_64');
  expect(archOf('t3.medium')).toBe('x86_64');
  expect(archOf('m7a.large')).toBe('x86_64');
});

describe('node slots', () => {
  const instances = template.findResources('AWS::EC2::Instance');

  test(`declares ${MAX_SHARDS}x${MAX_REPLICAS} ClickHouse and 3 Keeper slots, each signalling a WaitCondition`, () => {
    const ids = Object.keys(instances);
    expect(ids.filter((id) => /^ChS\dR\d$/.test(id))).toHaveLength(MAX_SHARDS * MAX_REPLICAS);
    expect(ids.filter((id) => /^Keeper\d$/.test(id))).toHaveLength(3);
    const waits = template.findResources('AWS::CloudFormation::WaitCondition');
    for (const [id, r] of Object.entries(instances)) {
      expect(waits[`${id}Ready`].CreationPolicy).toEqual({ ResourceSignal: { Count: 1, Timeout: 'PT40M' } });
      expect(waits[`${id}Ready`].DependsOn.sort()).toEqual([`${id}DataAttachment`, 'UpdateGuard']);
      expect(waits[`${id}Ready`].Condition).toBe(r.Condition);
    }
  });

  test('template changes never replace running nodes; termination protection is configurable', () => {
    for (const r of Object.values(instances)) {
      expect(r.Properties.LaunchTemplate.Version).toBe('1');
      expect(r.Properties.DisableApiTermination).toEqual({ 'Fn::If': ['TerminationProtection', true, false] });
      expect(r.Properties.Tags).toContainEqual({ Key: 'ch-stack', Value: { Ref: 'AWS::StackName' } });
    }
    expect(json.Parameters.EnableTerminationProtection.Default).toBe('true');
  });

  test('user data does not depend on mutable cluster settings (they come from the ClusterConfig SSM parameter)', () => {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    for (const lt of Object.values(lts)) {
      const ud = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);
      for (const p of ['ClickHouseVersion', 'ShardCount', 'ReplicaCount', 'KeeperCount', 'Monitoring', 'EnableBackup']) {
        expect(ud).not.toContain(`"${p}"`);
      }
      expect(ud).toContain('ClusterConfig');
    }
    const [param] = Object.values(template.findResources('AWS::SSM::Parameter'));
    expect(JSON.stringify(param.Properties.Value)).toContain('ClickHouseVersion');
  });

  test('only shard 1 / replica 1 and keeper 1 are unconditional', () => {
    const unconditional = Object.entries(instances).filter(([, r]) => !r.Condition).map(([id]) => id).sort();
    expect(unconditional).toEqual(['ChS1R1', 'Keeper1']);
    expect(instances.ChS1R2.Condition).toBe('ReplicasAtLeast2');
    expect(instances.ChS2R1.Condition).toBe('ShardsAtLeast2');
    expect(instances.ChS3R2.Condition).toBe('SlotS3R2');
    expect(instances.Keeper3.Condition).toBe('ThreeKeepers');
    expect(json.Conditions.SlotS3R2).toEqual({ 'Fn::And': [{ Condition: 'ShardsAtLeast3' }, { Condition: 'ReplicasAtLeast2' }] });
  });

  test('replica N is placed in the N-th subnet when MultiAZ', () => {
    const eni = template.findResources('AWS::EC2::NetworkInterface');
    expect(eni.ChS1R1Eni.Properties.SubnetId).toEqual({ 'Fn::Select': [0, { Ref: 'SubnetIds' }] });
    expect(eni.ChS2R3Eni.Properties.SubnetId).toEqual({
      'Fn::If': ['IsMultiAZ', { 'Fn::Select': [2, { Ref: 'SubnetIds' }] }, { 'Fn::Select': [0, { Ref: 'SubnetIds' }] }],
    });
    expect(eni.Keeper2Eni.Properties.SubnetId['Fn::If'][1]).toEqual({ 'Fn::Select': [1, { Ref: 'SubnetIds' }] });
  });

  test('every slot has a DNS record bound to its ENI with the same condition', () => {
    const records = template.findResources('AWS::Route53::RecordSet');
    for (const [id, inst] of Object.entries(instances)) {
      expect(records[`${id}Dns`].Condition).toBe(inst.Condition);
      expect(records[`${id}Dns`].Properties.ResourceRecords).toEqual([{ 'Fn::GetAtt': [`${id}Eni`, 'PrimaryPrivateIpAddress'] }]);
    }
  });

  test('launch templates enforce IMDSv2, expose tags, encrypt EBS and pick AMI by architecture', () => {
    template.allResourcesProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        MetadataOptions: { HttpTokens: 'required', InstanceMetadataTags: 'enabled' },
      },
    });
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    expect(lts.ClickHouseLaunchTemplate.Properties.LaunchTemplateData.ImageId)
      .toEqual({ 'Fn::If': ['ClickHouseIsArm64', { Ref: 'Arm64AmiId' }, { Ref: 'X86AmiId' }] });
    expect(lts.KeeperLaunchTemplate.Properties.LaunchTemplateData.ImageId['Fn::If'][0]).toBe('KeeperIsArm64');
    for (const lt of Object.values(lts)) {
      for (const bdm of lt.Properties.LaunchTemplateData.BlockDeviceMappings) expect(bdm.Ebs.Encrypted).toBe(true);
    }
  });

  test('system volume is in the launch template; data volumes are separate resources kept as snapshots', () => {
    const lts = template.findResources('AWS::EC2::LaunchTemplate');
    for (const lt of Object.values(lts)) {
      expect(lt.Properties.LaunchTemplateData.BlockDeviceMappings).toEqual([{
        DeviceName: '/dev/xvda',
        Ebs: { VolumeSize: { Ref: 'SystemVolumeSize' }, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true },
      }]);
    }
    const volumes = template.findResources('AWS::EC2::Volume');
    expect(Object.keys(volumes)).toHaveLength(MAX_SHARDS * MAX_REPLICAS + 3);
    for (const [id, v] of Object.entries(volumes)) {
      expect(v.DeletionPolicy).toBe('Snapshot');
      expect(v.UpdateReplacePolicy).toBe('Snapshot');
      expect(v.Properties).toMatchObject({ Encrypted: true, VolumeType: 'gp3' });
      expect(v.Properties.AvailabilityZone).toEqual({ 'Fn::GetAtt': [id.replace(/Data$/, ''), 'AvailabilityZone'] });
    }
    expect(volumes.ChS2R2Data.Properties).toMatchObject({
      Size: { Ref: 'DataVolumeSize' }, Iops: { Ref: 'DataVolumeIops' }, Throughput: { Ref: 'DataVolumeThroughput' },
    });
    expect(volumes.Keeper1Data.Properties.Size).toEqual({ Ref: 'KeeperDataVolumeSize' });
    expect(json.Parameters.DataVolumeIops.Default).toBe(3000);
    expect(json.Parameters.DataVolumeThroughput.Default).toBe(125);
  });
});

describe('operations', () => {
  test('day-2 node configuration via SSM association (one node at a time, after the first nodes are ready)', () => {
    const assoc = Object.values(template.findResources('AWS::SSM::Association'));
    expect(assoc).toHaveLength(1);
    expect(assoc[0].Properties).toMatchObject({
      MaxConcurrency: '1', MaxErrors: '0', Targets: [{ Key: 'tag:ch-stack', Values: [{ Ref: 'AWS::StackName' }] }],
    });
    expect(assoc[0].Properties.Parameters.MonitoringMode).toEqual([{ Ref: 'Monitoring' }]);
    expect(assoc[0].DependsOn.sort()).toEqual(['ChS1R1Ready', 'Keeper1Ready', 'UpdateGuard']);
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    const script = doc.Properties.Content.mainSteps[0].inputs.runCommand.join('\n');
    for (const name of Object.keys(doc.Properties.Content.parameters)) expect(script).toContain(`{{ ${name} }}`);
  });

  test('node-config ships the current shared helpers instead of the copies saved at boot', () => {
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    const script: string = doc.Properties.Content.mainSteps[0].inputs.runCommand.join('\n');
    expect(script).not.toMatch(/^# @include /m);
    for (const fn of ['render_cluster_xml', 'render_operations_xml', 'render_ops_monitor_xml', 'install_clickhouse_packages', 'install_data_volume_dropins']) {
      expect(script).toContain(`${fn}() {`);
    }
    expect(script).not.toContain('/opt/clickhouse-ops/lib/cluster-xml.sh');
    expect(script).toContain('RequiresMountsFor=/var/lib/clickhouse');
  });

  test('the association waits for a rolling run over the largest cluster', () => {
    const [assoc] = Object.values(template.findResources('AWS::SSM::Association'));
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    const perNode = Number(doc.Properties.Content.mainSteps[0].inputs.timeoutSeconds);
    expect(assoc.Properties.WaitForSuccessTimeoutSeconds).toBe((MAX_SHARDS * MAX_REPLICAS + 3) * perNode);
    expect(assoc.Properties.WaitForSuccessTimeoutSeconds).toBeLessThanOrEqual(172800);
  });

  test('passwords never appear on a command line', () => {
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    const scripts = [doc.Properties.Content.mainSteps[0].inputs.runCommand.join('\n')];
    for (const lt of Object.values(template.findResources('AWS::EC2::LaunchTemplate'))) {
      scripts.push(JSON.stringify(lt.Properties.LaunchTemplateData.UserData));
    }
    for (const s of scripts) {
      expect(s).not.toMatch(/--password/);
      expect(s).not.toMatch(/ -u ["']?\w+:\$/);
    }
    expect(JSON.stringify(json.Outputs.ConnectCommand)).not.toContain('--password');
  });

  test('monitoring mode selects CloudWatch or Prometheus resources', () => {
    expect(json.Parameters.Monitoring.AllowedValues).toEqual(['None', 'CloudWatch', 'Prometheus']);
    const byType = (t: string) => Object.values(template.findResources(t));
    for (const a of byType('AWS::CloudWatch::Alarm')) expect(String(JSON.stringify(a.Condition))).toMatch(/MonitoringCloudWatch|AlarmCondition/);
    // created only after the association has started the metric publisher (no false "node down" alarms)
    for (const a of byType('AWS::CloudWatch::Alarm')) expect(a.DependsOn).toContain('NodeConfigAssociation');
    // per-slot alarms also wait for their own node (a node added by a scale-out is still booting otherwise)
    for (const [id, a] of Object.entries<any>(template.findResources('AWS::CloudWatch::Alarm'))) {
      const slot = /^(ChS\dR\d|Keeper\d)(Down|DataDisk|RootDisk)Alarm$/.exec(id)?.[1];
      if (slot) {
        expect(a.DependsOn).toContain(`${slot}Ready`);
        expect(json.Resources[`${slot}Ready`].Condition).toBe(json.Resources[slot].Condition);
      }
    }
    // nodes depend on the log group, so it is deleted after their CloudWatch agents (which would re-create it)
    for (const i of byType('AWS::EC2::Instance')) expect(i.DependsOn).toContain('NodeLogGroup');
    // per slot: down, data volume, root volume; 18 cluster-wide alarms
    expect(byType('AWS::CloudWatch::Alarm').length).toBe((MAX_SHARDS * MAX_REPLICAS + 3) * 3 + 18);
    expect(byType('AWS::CloudWatch::Dashboard')[0].Condition).toBe('MonitoringCloudWatch');
    expect(byType('AWS::APS::Workspace')[0].Condition).toBe('MonitoringPrometheus');
    expect(byType('AWS::APS::RuleGroupsNamespace')[0].Condition).toBe('MonitoringPrometheus');
    expect(byType('AWS::Grafana::Workspace')[0].Condition).toBe('GrafanaEnabled');
    expect(json.Conditions.GrafanaEnabled).toEqual({
      'Fn::And': [{ Condition: 'MonitoringPrometheus' }, { 'Fn::Equals': [{ Ref: 'CreateGrafanaWorkspace' }, 'true'] }],
    });
    // must deploy in accounts without IAM Identity Center
    expect(json.Parameters.GrafanaAuthProvider.Default).toBe('SAML');
    expect(byType('AWS::Grafana::Workspace')[0].Properties.AuthenticationProviders).toEqual([{ Ref: 'GrafanaAuthProvider' }]);
  });

  test('backups go to a retained, versioned, private, TLS-only bucket with lifecycle expiry', () => {
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(bucket.Condition).toBe('BackupEnabled');
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays).toEqual({ Ref: 'BackupRetentionDays' });
    const [policy] = Object.values(template.findResources('AWS::S3::BucketPolicy'));
    expect(policy.Properties.PolicyDocument.Statement[0].Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
  });

  test('CloudWatch alarms cover hosts, inserts, queries, Keeper and restarts; never alarm on missing data except node down', () => {
    const alarms = Object.entries<any>(template.findResources('AWS::CloudWatch::Alarm'));
    const metrics = new Set(alarms.map(([, a]) => a.Properties.MetricName));
    for (const m of ['CpuUsedPercent', 'MemoryUsedPercent', 'RootDiskUsedPercent', 'DataDiskUsedPercent', 'KeeperAvgLatencyMs',
      'KeeperOutstandingRequests', 'FailedQueries', 'KeeperHardwareExceptions', 'DistributedFilesToInsert', 'RejectedInserts',
      'DelayedInserts', 'ServerRestarts', 'FailedMutations']) expect(metrics).toContain(m);
    for (const [id, a] of alarms) {
      const breaching = /DownAlarm$|^KeeperNoLeaderAlarm$/.test(id);
      expect([id, a.Properties.TreatMissingData]).toEqual([id, breaching ? 'breaching' : 'notBreaching']);
    }
    expect(json.Resources.ChS2R3DataDiskAlarm.Properties.Dimensions[1]).toEqual({ Name: 'Node', Value: 'ch-s2-r3' });
    // the publisher computes every metric the alarms use
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    const script: string = doc.Properties.Content.mainSteps[0].inputs.runCommand.join('\n');
    for (const m of metrics) expect(script).toMatch(new RegExp(`\\b${m}\\b`));
    expect(script).toContain("metric = 'MaxPartCountForPartition'");
    expect(script).not.toContain('FROM system.parts');
  });

  test('Prometheus rules: per-node down alerts, count rules with a long for, backup rule only with backups', () => {
    const ns = template.findResources('AWS::APS::RuleGroupsNamespace');
    const rules: string = ns.PrometheusAlertRules.Properties.Data['Fn::Sub'][0];
    for (const a of ['ClickHouseServerDown', 'ClickHouseServersMissing', 'ClickHouseKeeperDown', 'ClickHouseKeepersMissing',
      'ClickHouseKeeperSessionLost', 'ClickHouseFailedMutations', 'ClickHouseRejectedInserts', 'ClickHouseDistributedQueue',
      'ClickHouseServerRestarted', 'ClickHouseCpuHigh', 'ClickHouseMemoryHigh', 'ClickHouseRootDiskUsage', 'ClickHouseKeeperLatency']) {
      expect(rules).toContain(`alert: ${a}\n`);
    }
    expect(rules).toContain('max by (node) (max_over_time(up{job="clickhouse"}[3h])) unless max by (node) (up{job="clickhouse"} == 1)');
    expect(rules).toMatch(/ClickHouseServersMissing\n {8}expr: [^\n]*\$\{ExpectedServers\}\n {8}for: 30m/);
    expect(rules).not.toContain('BackupStale');
    expect(ns.PrometheusBackupAlertRules.Properties.Data).toContain('ClickHouseBackupStale');
    expect(json.Conditions[ns.PrometheusBackupAlertRules.Condition]).toEqual({
      'Fn::And': [{ Condition: 'MonitoringPrometheus' }, { Condition: 'BackupEnabled' }],
    });
    // failed mutations come from the clickhouse-health scrape job of the node's Prometheus agent
    const doc = Object.values(template.findResources('AWS::SSM::Document'))[0];
    expect(doc.Properties.Content.mainSteps[0].inputs.runCommand.join('\n')).toContain(HEALTH_QUERY);
  });

  test('expected server count for alert rules is ShardCount x ReplicaCount', () => {
    expect(json.Mappings.ServerCount['3']['2']).toBe('6');
    expect(json.Mappings.ServerCount['5']['3']).toBe('15');
  });
});

describe('one-click template', () => {
  test('needs no CDK bootstrap and has no assets', () => {
    expect(json.Parameters.BootstrapVersion).toBeUndefined();
    expect(json.Rules).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/cdk-hnb659fds|aws:asset/);
  });

  test('fits the 1 MB CloudFormation template limit (larger than 51,200 bytes: deploy via S3 / console upload)', () => {
    expect(JSON.stringify(json).length).toBeLessThan(1_000_000);
  });

  test('password is generated, never embedded', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true },
    });
    expect(Object.keys(json.Parameters)).not.toContain('Password');
  });

  test('nodes have no public IPs (pre-created ENIs) and client ports are limited to ClientCidr', () => {
    const sgs = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
    expect(sgs).toHaveLength(1);
    expect(sgs[0].Properties.SecurityGroupIngress.map((r: any) => [r.FromPort, r.CidrIp])).toEqual([
      [8123, { Ref: 'ClientCidr' }],
      [9000, { Ref: 'ClientCidr' }],
    ]);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 5);
    for (const r of Object.values(template.findResources('AWS::EC2::NetworkInterface'))) {
      expect(r.Properties.AssociatePublicIpAddress).toBeUndefined();
    }
  });

  test('outputs', () => {
    for (const o of ['ClusterName', 'ClickHouseEndpoint', 'KeeperEndpoints', 'AdminPasswordSecretArn', 'ConnectCommand']) {
      expect(json.Outputs[o]).toBeDefined();
    }
  });
});
