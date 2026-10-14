# ClickHouse on AWS EC2 — one-click cluster (CDK + CloudFormation)

This project creates a self-managed **ClickHouse** cluster on Amazon EC2. Coordination uses **ClickHouse Keeper**, not ZooKeeper.
You can deploy it two ways:

- **CloudFormation (one click)**: upload `templates/clickhouse-cluster.template.json` in the CloudFormation console and fill in the parameters. No CDK and no `cdk bootstrap` needed.
- **AWS CDK (TypeScript)**: `npx cdk deploy`. The template above is generated from this CDK app, so both paths deploy the same thing.
- **Amazon EKS**: `templates/clickhouse-eks.template.json` (CDK stack `ClickHouseEks`) deploys the same kind of cluster on EKS — new or existing VPC, Altinity ClickHouse operator, ClickHouse Keeper, gp3 PVCs with ReplicatedMergeTree, EKS Pod Identity for every AWS permission (no IRSA), CloudWatch or Amazon Managed Prometheus (+ Grafana) monitoring, S3 backups. See **[docs/eks-guide.md](docs/eks-guide.md)** (Chinese) and the section [Amazon EKS](#amazon-eks) below.

The stack is built for long-term operation: data volumes that survive node and stack changes, rolling upgrades and
day-2 configuration through SSM State Manager, a choice of CloudWatch or Amazon Managed Prometheus (+ Grafana)
monitoring with alarms, and daily S3 backups. The [Operations](#operations) section below summarizes upgrades, backups and
monitoring; **[docs/operations-guide.md](docs/operations-guide.md)** (Chinese) explains how these work and has the full
operational runbooks (security, upgrades, scaling, schema design, restore, deletion).

## Architecture

```
                 VPC (existing)            Route 53 private zone  <ClusterName>.clickhouse.internal
 ┌───────────── AZ-a ─────────────┬──────────── AZ-b ────────────┬──────────── AZ-c ────────────┐
 │ ch-s1-r1  ch-s2-r1 ...         │ ch-s1-r2  ch-s2-r2 ...       │ ch-s1-r3 ...                 │
 │ keeper-1                       │ keeper-2                     │ keeper-3                     │
 └────────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

- **ClickHouse nodes**: `ShardCount × ReplicaCount` EC2 instances named `ch-s<shard>-r<replica>`. Each one has:
  - a separate encrypted gp3 data volume (`AWS::EC2::Volume`, `DeletionPolicy`/`UpdateReplacePolicy: Snapshot`) mounted at `/var/lib/clickhouse` (xfs). Its size, IOPS and throughput are configurable and can be changed online. If the data volume is not mounted, bootstrap fails, so data can never end up on the system volume;
  - `remote_servers` listing all shards and replicas of the cluster (`internal_replication=true`);
  - `macros` (`{cluster}`, `{shard}`, `{replica}`) so you can use `ReplicatedMergeTree` and `ON CLUSTER` directly;
  - `<zookeeper>` pointing at the Keeper nodes on port 9181.
- **ClickHouse Keeper**: 1 (dev) or 3 (HA, Raft quorum) dedicated nodes named `keeper-<n>`. Raft port is 9234. This follows the ClickHouse docs' advice to run Keeper on dedicated hosts.
- **Cross-AZ (`MultiAZ=true`)**: replica N and keeper N go into the N-th subnet of `SubnetIds`. With `MultiAZ=false`, every node goes into the first subnet.
- **Graviton / x86**: the AMI architecture (Amazon Linux 2023 arm64 or x86_64) is chosen automatically from the instance type, separately for ClickHouse nodes and Keeper nodes.
- **Security**:
  - No public IPs. Each node uses a pre-created ENI, so it gets no public IP even in a public subnet.
  - The intra-cluster ports (9000, 8123, 9009, 9181, 9234) are open only between cluster nodes.
  - Client ports 8123 and 9000 are open only to `ClientCidr`.
  - The password of user `default` is generated randomly in Secrets Manager and never appears in the template.
  - IMDSv2 is required.
  - Nodes are managed through SSM Session Manager.
- **Readiness**: every node signals a `WaitCondition` (`<node>Ready`, created after its data volume is attached). The stack only reaches `CREATE_COMPLETE` once:
  - every Keeper node answers `ruok` and has joined the quorum;
  - every ClickHouse node answers `SELECT 1` and can read `system.zookeeper`;
  - the node-config association (monitoring agents, system log TTL, backups) has succeeded on every node.

  If bootstrap fails, the stack fails and rolls back automatically. The bootstrap log is at `/var/log/clickhouse-bootstrap.log`.
- **Stack updates never replace running nodes**: instances pin launch-template version 1; the ClickHouse version and topology live in the SSM parameter `/clickhouse/<stack>/cluster-config`. Changing `ClickHouseVersion`, `ShardCount`/`ReplicaCount`, `Monitoring`, backups or log retention re-runs the SSM association `<stack>-node-config`, which applies the change **one node at a time** (rolling upgrade included). Optional EC2 termination protection and `templates/stack-policy.json` guard against deleting nodes and volumes.
- **Update guard**: the custom resource `UpdateGuard` is updated before every other resource and rejects (the stack rolls back untouched) updates that change `ClusterName`, `KeeperCount`, `VpcId`, `SubnetIds`, `MultiAZ`, the instance types or `SystemVolumeSize`, decrease `ShardCount`, `ReplicaCount` or a data volume size, or downgrade `ClickHouseVersion`. Rollbacks are always accepted.
- **Monitoring** (`Monitoring` = `None` | `CloudWatch` | `Prometheus`): CloudWatch agent + ClickHouse health metrics, per-node and cluster alarms, a dashboard and node logs; or Amazon Managed Service for Prometheus with alert rules, a Prometheus agent + node_exporter on every node and optional Amazon Managed Grafana (dashboard: `docs/grafana/clickhouse-cluster-dashboard.json`). All alarms go to one SNS topic.
- **Backups** (`EnableBackup`): daily native `BACKUP` to a retained, versioned, TLS-only S3 bucket (full on Sundays, incremental otherwise) from replica 1 of every shard.
- **System log retention**: TTL on all `system.*_log` tables (`SystemLogRetentionDays`).
- **Packages**: the pinned version is installed from the official repository at `packages.clickhouse.com`. If that fails, the RPMs are downloaded from GitHub Releases (`v<version>-lts` / `-stable`).

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `ClusterName` | `clickhouse` | Cluster name (lowercase letters and digits). Used as the cluster name in `remote_servers` and as the private DNS zone `<name>.clickhouse.internal`. Must be unique within the VPC. |
| `ClickHouseVersion` | `26.8.24.9` | Exact version from [ClickHouse releases](https://github.com/ClickHouse/ClickHouse/releases). Keeper uses the same version. Changing it on a running stack performs a rolling upgrade (no downgrades). |
| `ClickHouseInstanceType` | `m7g.2xlarge` | Instance type for ClickHouse nodes. Graviton (m/r/c 6g/7g/8g) and Intel/AMD (m/r/c 6i/7i/7a) families, large to 16xlarge. Fixed after creation (update guard); resize running nodes manually with the runbook in the operations guide. |
| `KeeperInstanceType` | `t4g.medium` | Instance type for Keeper nodes (same rule). |
| `ShardCount` | `1` | Number of shards, 1–5. |
| `ReplicaCount` | `2` | Replicas per shard, 1–3. |
| `KeeperCount` | `3` | Number of Keeper nodes: `3` (HA) or `1` (dev/test). Cannot be changed after creation. |
| `VpcId` | – | An existing VPC. DNS support and DNS hostnames must be enabled. |
| `SubnetIds` | – | Subnets in that VPC. Use private subnets with NAT, because nodes need outbound access to download packages and reach SSM. With `MultiAZ=true`, provide at least `max(ReplicaCount, KeeperCount)` subnets, one per AZ. |
| `MultiAZ` | `true` | Whether to spread replicas and Keeper nodes across the subnets/AZs. |
| `DataVolumeSize` | `200` | Size of the data volume on each ClickHouse node, in GiB. |
| `DataVolumeIops` | `3000` | gp3 IOPS of each data volume. 3000 is the gp3 baseline (no extra cost); at most 500 IOPS per GiB. |
| `DataVolumeThroughput` | `125` | gp3 throughput of each data volume in MiB/s. 125 is the baseline; at most 0.25 MiB/s per IOPS. |
| `SystemVolumeSize` | `30` | Size of the system (root) volume on every node, in GiB. It holds the OS, packages and logs, never data. |
| `KeeperDataVolumeSize` | `20` | Size of the separate volume for Raft logs and snapshots on each Keeper node, in GiB. |
| `ClientCidr` | – (required) | CIDR allowed to reach 8123/9000. Usually the VPC CIDR. |
| `EnableTerminationProtection` | `true` | EC2 termination protection on all nodes. Set to `false` (stack update) before deleting the stack. |
| `EnableBackup` | `true` | Daily backups to a new S3 bucket (retained when the stack is deleted). |
| `BackupRetentionDays` | `35` | S3 lifecycle expiry of backups; the guaranteed restorable window is this minus 7 days. |
| `BackupTimeUTC` | `03:00` | Daily backup time. |
| `SystemLogRetentionDays` | `30` | TTL of the `system.*_log` tables. |
| `Monitoring` | `CloudWatch` | `None`, `CloudWatch` or `Prometheus`; can be switched with a stack update. |
| `AlarmEmail` | (empty) | Optional e-mail subscription of the alarm SNS topic. |
| `DiskUsageAlarmPercent` | `80` | Data volume usage alarm threshold. |
| `LogRetentionDays` | `30` | CloudWatch mode: retention of the log group `/clickhouse/<stack>`. |
| `CreateGrafanaWorkspace` | `true` | Prometheus mode: also create an Amazon Managed Grafana workspace. |
| `GrafanaAuthProvider` | `SAML` | `SAML` works in every account (connect your IdP after creation). Choose `AWS_SSO` only if IAM Identity Center is enabled for the account/organization (it may live in another region); otherwise the Grafana workspace fails to create and the stack rolls back. Can be switched later with a stack update. |
| `Arm64AmiId` / `X86AmiId` | AL2023 SSM parameters | Usually leave these unchanged. |

Limitations:
- The one-click template supports up to 5 shards × 3 replicas. To go higher, change `MAX_SHARDS` / `MAX_REPLICAS` in `lib/clickhouse-cluster-stack.ts` and run `npm run synth-template` again.
- Increasing `ShardCount` / `ReplicaCount` adds nodes and updates `remote_servers` on all nodes, but tables must be created on new replicas and existing data is not rebalanced onto new shards (see the operations guide). Scale-in and `KeeperCount` changes are rejected; create a new cluster and use BACKUP/RESTORE. Instance families with instance-store disks (`*d`) are not offered.
- Stacks created with earlier versions of this template (data volume inside the launch template) cannot be updated in place to this version; create a new stack and migrate the data with BACKUP/RESTORE.

## Deploy

### Option 1: CloudFormation console (one click)

1. Open CloudFormation → *Create stack* → *Upload a template file*, and choose `templates/clickhouse-cluster.template.json`.
2. Fill in the parameters, check *I acknowledge that AWS CloudFormation might create IAM resources*, and create the stack. It takes about 5–10 minutes.

### Option 2: AWS CLI

The template is larger than the 51,200-byte limit of `--template-body`, so upload it to an S3 bucket first
(the console does this automatically):

```bash
# examples/ops-params.json shows all parameters (1 shard x 2 replicas, Graviton, 3 Keepers, multi-AZ, CloudWatch monitoring, backups)
aws s3 cp templates/clickhouse-cluster.template.json s3://<bucket>/clickhouse-cluster.template.json
aws cloudformation create-stack --stack-name ch-prod \
  --template-url https://<bucket>.s3.<region>.amazonaws.com/clickhouse-cluster.template.json \
  --parameters file://examples/ops-params.json \
  --capabilities CAPABILITY_IAM \
  --stack-policy-body file://templates/stack-policy.json
aws cloudformation wait stack-create-complete --stack-name ch-prod
```

### Option 3: CDK

```bash
npm install
npx cdk deploy ClickHouseCluster \
  --parameters VpcId=vpc-xxxx \
  --parameters SubnetIds=subnet-a,subnet-b,subnet-c \
  --parameters ShardCount=1 --parameters ReplicaCount=2 --parameters KeeperCount=3 \
  --parameters MultiAZ=true --parameters ClickHouseInstanceType=m7g.xlarge \
  --parameters ClickHouseVersion=26.8.24.9 --parameters ClientCidr=10.0.0.0/16
```

The stack has no assets. The CDK CLI uploads the template (> 50 KB) to the CDK bootstrap bucket, so CDK deployments need `cdk bootstrap` to have been run once; the console and CLI paths do not. Apply the stack policy afterwards with `aws cloudformation set-stack-policy --stack-name ClickHouseCluster --stack-policy-body file://templates/stack-policy.json`.

## Connect

The stack Outputs include `ConnectCommand`, `PasswordCommand`, `ClickHouseEndpoint` and `KeeperEndpoints`:

```bash
# Get a shell on a node (instance id is in the FirstNodeInstanceId output)
aws ssm start-session --target <instance-id>
clickhouse-client --password "$(aws secretsmanager get-secret-value --secret-id <AdminPasswordSecretArn> --query SecretString --output text)"

# Or from your laptop via port forwarding
aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8123"],"localPortNumber":["8123"]}'
```

Replicated tables:

```sql
CREATE TABLE t ON CLUSTER '{cluster}' (id UInt64, s String)
ENGINE = ReplicatedMergeTree ORDER BY id;

-- Distributed table spanning all shards
CREATE TABLE t_all ON CLUSTER '{cluster}' AS t
ENGINE = Distributed('{cluster}', currentDatabase(), t, rand());
```

Applications inside the VPC can connect directly to `ch-s<shard>-r<replica>.<ClusterName>.clickhouse.internal:8123/9000`.

## Operations

Both templates are operated the same way: **change a stack parameter and update the stack**. CloudFormation applies the
change in place, one node at a time (EC2: the SSM association `<stack>-node-config`; EKS: the `ClusterInstall`
installer). Neither path replaces nodes or data volumes. The full runbooks are in
[docs/operations-guide.md](docs/operations-guide.md) (EC2) and [docs/eks-guide.md](docs/eks-guide.md) (EKS), both in Chinese.

### Changing parameters

```bash
# Change one parameter and keep all others (STACK=<stack name>, here: upgrade ClickHouse)
aws cloudformation update-stack --stack-name "$STACK" --use-previous-template --capabilities CAPABILITY_IAM \
  --parameters $(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Parameters[].ParameterKey' \
      --output text | tr '\t' '\n' | grep -vx ClickHouseVersion | sed 's/.*/ParameterKey=&,UsePreviousValue=true/') \
    ParameterKey=ClickHouseVersion,ParameterValue=26.8.24.9
aws cloudformation wait stack-update-complete --stack-name "$STACK"
```

To move a stack to a newer version of this project's template, use `--template-url` instead of `--use-previous-template`.

**What can change.** Every stack update first goes through `UpdateGuard`. If the update is unsafe, the guard rejects it
before anything else changes, and the stack rolls back untouched; the event reason names the parameter.

| | EC2 | EKS |
|---|---|---|
| Online, rolling | `ClickHouseVersion` (upgrade only), `ShardCount`/`ReplicaCount` (increase only), volume size (increase only), IOPS, throughput, `Monitoring`, backup and log-retention settings, `ClientCidr` | Same, plus `ClickHouseInstanceType`/`KeeperInstanceType` (blue/green node groups), `ReplicaCount` decrease, `KubernetesVersion` (one minor version at a time) |
| Rejected | `ClusterName`, `KeeperCount`, `VpcId`, `SubnetIds`, `MultiAZ`, instance types, `SystemVolumeSize`, any decrease, version downgrade | `ClusterName`, `KeeperCount`, `CreateVpc`, `VpcCidr`, `VpcId`, `SubnetIds`, `MultiAZ`, `ShardCount` or volume size decrease, ClickHouse/Kubernetes downgrade |

- If the stack has `templates/stack-policy.json` applied, updates that would replace nodes fail even earlier, with *Action denied by stack policy*.
- On EC2, change the instance type of running nodes with the manual runbook in the operations guide (§7).
- To shrink a cluster, create a new one and move the data with BACKUP/RESTORE.

### Upgrades

- **How.** Set `ClickHouseVersion` to an exact release (`<major>.<minor>.<patch>.<build>`; prefer LTS releases, and do not skip an LTS). Keeper and ClickHouse are upgraded one node at a time.
  - **EC2**: each node gets the new packages and is restarted. The next node only starts when this one is healthy again:
    - on the right version, with all its tables and replicas back and async loading finished;
    - no readonly replica, and replication delay below 60 s;
    - on Keepers: back in the quorum, with all followers synced.

    A node that is not healthy within 45 minutes fails the update. Verified live: 25.8.33.6 → 26.8.24.9 on 5 nodes in about 4 minutes, data unchanged.
  - **EKS**: the Altinity operator restarts host by host. The installer waits until the operator reports *this* change as completed (`spec.taskID`), Keeper before ClickHouse. The whole installer run must finish within the 1-hour custom-resource limit; for the largest layouts, change one thing per update.
- **Before upgrading**: confirm the latest backup succeeded, and run the workload on a staging cluster first (the `perf/` benchmark is version-agnostic). If needed, keep old behaviour with `compatibility = '<old version>'` in a settings profile.
- **Rollback.** Downgrades are rejected. If an upgrade fails, the stack rolls back. Nodes that were already upgraded keep the new version: node-config logs a warning, so the rollback still completes. Retry after fixing the cause. To really go back, restore a pre-upgrade backup into a new cluster.
- **Kubernetes (EKS)**: raise `KubernetesVersion` one minor version at a time. The control plane is upgraded first, then the node groups roll one after another.

### Backups and restore

- **Schedule** (`EnableBackup=true`, the default): every day at `BackupTimeUTC` a native `BACKUP ALL EXCEPT DATABASES system, information_schema` runs for every shard. It is a full backup on Sundays (or when the last full one is more than 7 days old), and incremental otherwise.
  - Backups go to `s3://<BackupBucketName>/<stack>/shard-<N>/<UTC time>-<full|incremental>/`.
  - The bucket is versioned and TLS-only, and it is **retained** when the stack is deleted.
  - ClickHouse reaches S3 through the instance role (EC2) or Pod Identity (EKS), so no keys are stored anywhere.
- **Where it runs**: on EC2, `ch-backup.timer` on replica 1 of each shard. On EKS, the CronJob `clickhouse-backup`, which falls back to the shard's other replicas, and one failed shard does not stop the others.
- **Retention**: backups expire after `BackupRetentionDays`. Because an incremental backup needs its full one, the guaranteed restorable window is `BackupRetentionDays − 7` days.
- **Run a backup now**:

  ```bash
  # EC2 (on replica 1 of the shard, via SSM Session Manager)
  sudo /opt/clickhouse-ops/bin/ch-backup.sh full        # or incremental / auto
  journalctl -u ch-backup --no-pager | tail
  # EKS
  kubectl -n clickhouse create job backup-now --from=cronjob/clickhouse-backup && kubectl -n clickhouse logs -f job/backup-now
  ```

- **Restore**: restore into a new table name, verify it, then swap. Restoring from an incremental backup uses its full backup automatically.
  - ClickHouse 26.x does not let queries use the server's own S3 credentials unless they ask for it, so add `s3_allow_server_credentials_in_user_queries = 1`. The backup scripts add it automatically.

  ```sql
  RESTORE TABLE db.t AS db.t_restored
    FROM S3('https://<bucket>.s3.<region>.amazonaws.com/<stack>/shard-<N>/<name>/')
    SETTINGS s3_allow_server_credentials_in_user_queries = 1;
  SELECT count(), sum(cityHash64(*)) FROM db.t_restored;   -- compare with the source
  ```

  Rehearse a restore regularly (for example each quarter). On both platforms, a restore was verified live to produce identical row hashes.
- **System log retention**: `SystemLogRetentionDays` sets a TTL on all `system.*_log` tables. On EC2 the node-config association applies it; on EKS the hourly CronJob `clickhouse-log-ttl` does.

### Monitoring and alarms

`Monitoring` can be switched between `None`, `CloudWatch` and `Prometheus` with a stack update, and nodes/pods are not restarted. All alarms and alerts go to one SNS topic (output `AlarmTopicArn`); `AlarmEmail` adds an e-mail subscription, which you must confirm.

- **CloudWatch**
  - A publisher (EC2: `ch-cw-metrics.timer` on every node; EKS: Deployment `ch-cw-metrics`) writes ClickHouse/Keeper health metrics every minute to namespace `ClickHouse`. Its dimensions are `Cluster=<stack>` and `Node=<host>`.
  - Each platform has a dashboard (output `CloudWatchDashboardUrl`). EC2 adds the log group `/clickhouse/<stack>`; EKS adds Container Insights.
- **Prometheus**
  - Metrics go to Amazon Managed Service for Prometheus (outputs `PrometheusWorkspaceId`, `PrometheusQueryEndpoint`). EC2 uses a Prometheus agent with node_exporter on every node. EKS uses the AWS managed scraper (which also scrapes kubelet/cAdvisor), so no Prometheus server or agent runs in the cluster.
  - Alert rules are evaluated in AMP, and its Alertmanager sends them to SNS.
  - Grafana is optional (`CreateGrafanaWorkspace`, output `GrafanaUrl`). Import `docs/grafana/clickhouse-cluster-dashboard.json`; it works on both platforms.
- **What is alarmed.** CloudWatch alarms and Prometheus rules cover the same things:

  | Area | Alarms (default threshold) |
  |---|---|
  | Availability | Server / Keeper down, per node (3 min); no Keeper leader (3 min); servers or keepers missing (Prometheus, 30 min); unexpected server restart (uptime reset without a version change) |
  | Replication & Keeper | readonly replica; replica delay > 300 s; replication queue > 1000; Keeper session lost; Keeper connection errors; Keeper latency > 100 ms; outstanding requests > 100 |
  | Writes & queries | too many parts per partition > 600; delayed inserts; rejected inserts; Distributed queue > 1000 files; failed queries > 100 per 5 min; failed mutations |
  | Capacity | data disk > `DiskUsageAlarmPercent` (80 %), **per node**; root disk > 85 %; CPU or memory > 90 % for 15 min; EKS: Keeper volume usage, OOM kills |
  | Ops jobs | last backup older than 26 h (only with `EnableBackup=true`); EKS: log-TTL CronJob not successful for 3 h |

- **Avoiding false alarms.**
  - Missing data counts as breaching only for "node down" and "no Keeper leader". Metrics an older ClickHouse version does not have are published as 0.
  - Per-node alarms are created only after that node is ready, and Prometheus rules only after the cluster is deployed, so new stacks and scale-outs do not page.
  - On EKS, pods that the operator recreates for a configuration change or a node-group replacement do count as restarts.
- **Query AMP from the CLI** (SigV4, service `aps`):

  ```bash
  eval "$(aws configure export-credentials --format env)"
  curl -s --aws-sigv4 "aws:amz:<region>:aps" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
    -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
    --data-urlencode 'query=ALERTS{alertstate="firing"}' <PrometheusQueryEndpoint>
  ```

- **Monitoring access.** On EC2, the publisher and the Prometheus agent use the read-only, password-less user `ops_monitor`, which is restricted to localhost. On EKS, `ops_monitor` is also password-less, but accepts connections only from the VPC CIDR and can only read the system tables it needs. The admin password never appears in a command line, a scrape config or the EKS audit log.

## Performance test (token_hub)

`perf/` contains a reproducible load test of the `token_hub.t_billing_records` / `t_billing_records_mv` schema, and its HTML report is at `perf/report.html`.

1. Deploy a cluster (see `examples/perf-params.json`).
2. Start a load-generator EC2 instance in the same VPC with `clickhouse-client` installed.
3. Copy `perf/bench.sh` and `perf/sql/` to `/opt/bench` on that instance.
4. Create the schema there: run `perf/sql/01_schema.sql`, then `02_generators.sql`, with `clickhouse-client --multiquery`.
5. Run the benchmark on that instance: `bench.sh <ClusterName> <AdminPasswordSecretArn> <region>`.
6. On your workstation, copy the instance's `/opt/bench/results` to `perf/results/` and fetch metrics: `perf/fetch-metrics.sh <stack> <start> <end> perf/results`.
7. Generate the report: `node perf/report.js [results-dir] [out.html] [baseline-results-dir]`.

On EKS, pass the pod IPs of the two replicas (`R1=<ip> R2=<ip> bench.sh ...`), collect metrics with
`perf/fetch-metrics-eks.sh`, and put `platform.txt` / `label.txt` / `deployment.html` into the results directory for the report
(see `perf/results-eks-26.8.24.9/`).

## Amazon EKS

```bash
aws s3 cp templates/clickhouse-eks.template.json s3://<bucket>/clickhouse-eks.template.json
aws cloudformation create-stack --stack-name ch-eks \
  --template-url https://<bucket>.s3.<region>.amazonaws.com/clickhouse-eks.template.json \
  --parameters file://examples/eks-perf-params.json --capabilities CAPABILITY_IAM
```

- **Network**: `CreateVpc=true` creates a 3-AZ VPC (`VpcCidr`, NAT per AZ or single, S3 gateway endpoint); `CreateVpc=false` uses `VpcId` + `SubnetIds` (private subnets with NAT, one per AZ). Replica N and keeper N run in the N-th subnet.
- **EKS**: API authentication mode with access entries, KMS envelope encryption of secrets, control plane logs, private API endpoint (public optional), managed add-ons (VPC CNI, kube-proxy, CoreDNS, Pod Identity agent, EBS CSI, snapshot controller, metrics server, CloudWatch observability).
- **Node groups**: 2 system nodes; one node group per AZ for each Keeper and for each replica (dedicated by taints), so a replaced node always comes back next to its EBS volume. One ClickHouse/Keeper pod per node with Guaranteed QoS.
- **ClickHouse**: Altinity operator 0.27.4 (`ClickHouseInstallation` + `ClickHouseKeeperInstallation`), official `clickhouse/clickhouse-server` / `clickhouse-keeper` images, gp3 PVCs (xfs, encrypted, `Retain`, online resize, IOPS/throughput via a `VolumeAttributesClass`), interserver secret, internal NLB via the AWS Load Balancer Controller.
- **Day 2**: parameter changes (version, volume size/IOPS, instance types, replicas/shards, monitoring, backups) are applied by the `ClusterInstall` custom resource (Lambda + CodeBuild in the VPC running helm/kubectl), one host at a time; node groups roll one after another. An instance type change replaces the node groups (blue/green): the installer moves the pods one by one onto the new nodes before the old groups are deleted. The whole installer run must finish within the 1-hour custom resource limit (see the EKS guide).
- **Update guard**: like on EC2, `UpdateGuard` rejects changes of `ClusterName` (2–15 characters), `KeeperCount`, the VPC/subnets/`MultiAZ`, shard or volume-size decreases and ClickHouse/Kubernetes downgrades. `ClientCidr` is required; the EKS API endpoint is private unless `EksPublicAccessCidrs` is set.
- **Pod Identity**: VPC CNI, EBS CSI, CloudWatch agent, Load Balancer Controller, ClickHouse (S3 backups) and the metrics publisher each get their own role; there is no OIDC provider and no IRSA.
- **Monitoring**: `CloudWatch` (Container Insights + the same ClickHouse metrics, alarms and dashboard as on EC2) or `Prometheus` (AWS managed scraper → Amazon Managed Service for Prometheus, alert rules, Alertmanager → SNS, optional Grafana).

## Delete

```bash
# 1. turn termination protection off (no node is replaced)
aws cloudformation update-stack --stack-name ch-prod --use-previous-template --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=EnableTerminationProtection,ParameterValue=false <UsePreviousValue=true for all other parameters>
# 2. delete
aws cloudformation delete-stack --stack-name ch-prod
```

This removes the instances, ENIs, the private DNS zone, the secret, the IAM role and the monitoring resources. **Each data volume is snapshotted before it is deleted**, and the **backup bucket is retained**; delete the snapshots (tag `ch-logical-id`) and the bucket yourself when they are no longer needed.

## Development

```bash
npm install
npm run build            # tsc type check
npm test                 # jest unit tests (parameters/conditions/size/no bootstrap)
npx cdk synth            # human-readable template (YAML)
npm run synth-template   # regenerate templates/clickhouse-cluster.template.json
```

| Path | Contents |
|---|---|
| `bin/clickhouse-on-aws.ts` | CDK app (BootstraplessSynthesizer) |
| `lib/clickhouse-cluster-stack.ts` | Parameters, conditions, cluster-config SSM parameter, launch templates, node slots (instance, ENI, data volume, WaitCondition, DNS), IAM, security group, outputs |
| `lib/monitoring.ts` | SNS topic, CloudWatch alarms/dashboard/log group, Amazon Managed Prometheus workspace + alert rules + alert manager, Amazon Managed Grafana |
| `lib/backup.ts` | Backup S3 bucket |
| `lib/update-guard.ts` | `UpdateGuard` custom resource (both stacks) that rejects unsafe stack updates before any other resource changes |
| `lib/node-config.ts`, `lib/nodeconfig/node-config.sh` | SSM document + State Manager association for day-2 node configuration (rolling upgrade, topology, monitoring agents, log TTL, backups) |
| `lib/instance-types.ts` | Instance types offered and their architecture |
| `lib/userdata/*.sh` | Node bootstrap scripts (common + cluster config renderer + ClickHouse + Keeper), embedded in the launch templates |
| `templates/clickhouse-cluster.template.json` | Generated one-click CloudFormation template |
| `templates/stack-policy.json` | Stack policy that forbids replacing/deleting nodes, volumes and other stateful resources during updates |
| `docs/operations-guide.md` | Operations guide (Chinese) |
| `docs/grafana/clickhouse-cluster-dashboard.json` | Grafana dashboard for Prometheus mode |
| `lib/eks/clickhouse-eks-stack.ts`, `lib/eks/vpc.ts` | EKS stack: parameters, optional VPC, EKS cluster, add-ons, node groups, Pod Identity, monitoring, outputs |
| `lib/eks/installer.ts`, `lib/eks/installer/*` | Installer custom resource (Lambda + CodeBuild) and its scripts: install.sh (helm/kubectl), render.py (CHK/CHI manifests), backup / log TTL / CloudWatch metrics scripts |
| `templates/clickhouse-eks.template.json` | Generated one-click EKS template |
| `docs/eks-guide.md` | EKS guide (Chinese) |
