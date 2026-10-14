# ClickHouse on EC2 运维手册

本手册面向用 `templates/clickhouse-cluster.template.json`（或 CDK）部署的集群，分两部分：

- **第一部分** 说明模版里已经内置、由 CloudFormation 参数控制的运维能力：数据保护、日常配置、监控告警、备份。
- **第二部分** 是需要按场景手动执行的最佳实践和操作手册：安全、升级与配置变更、容量与扩缩容、表设计与写入、成本、删除集群。

文中的 `<stack>` 指 CloudFormation 堆栈名，`<cluster>` 指参数 `ClusterName`。

---

## 第一部分：模版内置的运维能力

### 1. 数据保护

| 机制 | 说明 |
|---|---|
| 系统盘 / 数据盘分离 | 系统盘（`/dev/xvda`，`SystemVolumeSize`）存放 OS、软件包和日志。数据盘是**独立的 `AWS::EC2::Volume` 资源**，xfs 格式，挂载在 `/var/lib/clickhouse`。 |
| 数据盘保留策略 | 数据盘设置了 `DeletionPolicy: Snapshot` 和 `UpdateReplacePolicy: Snapshot`：删除堆栈或替换数据卷之前，会先自动生成 EBS 快照。 |
| 运行中的节点不会被替换 | 实例固定使用启动模版的第 1 版；ClickHouse 版本、分片数、副本数都放在 SSM 参数 `/clickhouse/<stack>/cluster-config` 中，由节点启动脚本读取。因此修改模版或参数（包括 AL2023 AMI 更新）**不会替换正在运行的节点**。注意：后来扩容出来的节点同样用第 1 版启动模版（原来的 AMI、实例类型、系统盘大小）。 |
| 更新保护（UpdateGuard） | 堆栈里的自定义资源 `UpdateGuard` 最先被更新（其它所有资源都依赖它），会**拒绝**下列堆栈更新，此时其它资源一个都不会被改动：<br>• 修改创建后不可变的参数：`ClusterName`、`KeeperCount`、`VpcId`、`SubnetIds`、`MultiAZ`、`ClickHouseInstanceType`、`KeeperInstanceType`、`SystemVolumeSize`；<br>• 调小 `ShardCount`、`ReplicaCount`、`DataVolumeSize`、`KeeperDataVolumeSize`（缩容会删除节点和数据盘，EBS 也不能缩小）；<br>• 降低 `ClickHouseVersion`。<br>被拒绝时堆栈事件中 `UpdateGuard` 的状态原因形如 `Update rejected (see the operations guide): ShardCount cannot be decreased (3 -> 2); ClickHouseInstanceType cannot be changed after creation ('m7g.2xlarge' -> 'r8g.2xlarge')`，堆栈随后回滚到原参数。回滚过程中的更新总是放行，保证回滚本身不会失败。 |
| 终止保护 | `EnableTerminationProtection=true`（默认）：所有节点开启 EC2 终止保护，误删实例和误删堆栈都会失败。 |
| 堆栈策略 | `templates/stack-policy.json` 禁止对实例、数据卷、卷挂载、ENI、备份桶、Secret、私有 DNS 区执行 Replace 或 Delete。创建堆栈时通过 `--stack-policy-body` 指定。 |
| 启动校验 | 每个节点在数据盘挂好、ClickHouse/Keeper 健康检查通过后，才会向 `<节点>Ready` 发信号，堆栈才会完成创建；否则堆栈失败并回滚（启动早期失败，例如读不到 SSM 参数，也会立即发失败信号，而不是等满 40 分钟）。 |
| 数据盘未挂载时不启动 | 数据盘在 `/etc/fstab` 中是 `nofail`（缺盘时系统仍能启动、可登录排查）。systemd drop-in `clickhouse-server.service.d/data-volume.conf`、`clickhouse-keeper.service.d/data-volume.conf`（`RequiresMountsFor=/var/lib/clickhouse`）保证服务只在数据盘挂载后启动，绝不会在系统盘上建一个空库。已有节点由日常配置关联补装。 |

创建堆栈的推荐命令（模版超过 51,200 字节，CLI 需要先上传到 S3；控制台上传会自动处理）：

```bash
aws s3 cp templates/clickhouse-cluster.template.json s3://<your-bucket>/clickhouse-cluster.template.json
aws cloudformation create-stack --stack-name <stack> \
  --template-url https://<your-bucket>.s3.<region>.amazonaws.com/clickhouse-cluster.template.json \
  --parameters file://examples/ops-params.json \
  --capabilities CAPABILITY_IAM \
  --stack-policy-body file://templates/stack-policy.json
```

> 旧版模版创建的集群（数据盘在启动模版里、实例跟随启动模版的最新版本）**无法原地升级到本模版**：节点替换会因 ENI 冲突失败。迁移方法：新建一个集群，然后用 `BACKUP`/`RESTORE`（见第 4 节）或 `INSERT ... SELECT FROM remote()` 迁移数据。

### 2. 日常配置（SSM State Manager）

堆栈包含一个 SSM Command 文档 `<stack>-NodeConfigDocument-*`，以及关联 `<stack>-node-config`。该关联：

- 作用于所有带 `ch-stack=<stack>` 标签的节点；
- 每次只在 **1 个节点**上执行（`MaxConcurrency=1`），出错立即停止（`MaxErrors=0`）；
- 在创建或更新堆栈时立即执行，CloudFormation 会等它成功（最长 18 小时：最大集群 5×3 + 3 个 Keeper，每个节点最多 1 小时，逐个执行）；之后每小时执行一次，用来纠正配置漂移，新加入的节点也会被覆盖；
- 文档里带有当前模版版本的共享脚本（`cluster.xml` 等配置的生成函数、软件包安装函数），所以已有节点总是用最新模版的逻辑，而不是节点启动时那一版。

它负责以下内容，所有操作都是幂等的：

| 内容 | 触发参数 | 行为 |
|---|---|---|
| 滚动升级 | `ClickHouseVersion` | 版本与目标不一致的节点逐个执行。ClickHouse 节点：记录重启前的表数和 `system.replicas` 行数 → 安装新版本（软件源失败时改用 GitHub release RPM）→ 重启 → 等到版本正确、表和复制表数量恢复、异步加载完成（`system.asynchronous_loader` 没有 `PENDING` 任务）、没有只读副本、复制延迟小于 60 秒。Keeper 节点：重启后等它重新进入 quorum（`mntr` 中 `zk_server_state` 为 leader/follower），并且 leader 报告所有 follower 已同步（`zk_synced_followers`）。全部满足才处理下一个节点；每个节点的等待总共最多 45 分钟，超时即失败并停止。已安装版本比目标新（只会出现在堆栈回滚时）：记录警告并保持新版本，不失败。 |
| 集群拓扑 | `ShardCount` / `ReplicaCount` | 在每个 ClickHouse 节点上重新生成 `config.d/cluster.xml`（`remote_servers`、`macros`），同时维护 `config.d/operations.xml` 和 `users.d/ops-monitor.xml`。ClickHouse 会自动重新加载，不需要重启。 |
| 数据盘扩容 | `DataVolumeSize`（CloudFormation 在线修改 EBS） | 执行 `xfs_growfs /var/lib/clickhouse`。 |
| 系统日志 TTL | `SystemLogRetentionDays` | 写入 `config.d/system-log-ttl.xml`，并对已存在的 `system.*_log` 表执行 `ALTER ... MODIFY TTL`，不需要重启。 |
| 监控代理 | `Monitoring` | 安装、启动所选的代理，停止其余代理（见第 3 节）。 |
| 备份 | `EnableBackup` / `BackupTimeUTC` | 在每个分片的 1 号副本上安装 `ch-backup.timer`（见第 4 节）。 |

常用命令：

```bash
# 立即在所有节点上重新执行（例如扩容数据盘后）
aws ssm start-associations-once --association-ids $(aws ssm list-associations \
  --association-filter-list key=AssociationName,value=<stack>-node-config --query 'Associations[0].AssociationId' --output text)
# 查看最近的执行记录，以及每个节点的结果
aws ssm describe-association-executions --association-id <id> --max-results 5
aws ssm describe-association-execution-targets --association-id <id> --execution-id <exec-id>
```

节点上的日志：

- 启动日志：`/var/log/clickhouse-bootstrap.log`
- 日常配置的输出：在 SSM 控制台 → State Manager → 执行历史中查看

### 3. 监控与告警（参数 `Monitoring`）

| 取值 | 创建的资源 |
|---|---|
| `None` | 不创建监控资源，并停止节点上的所有监控代理。 |
| `CloudWatch`（默认） | SNS 告警主题；每个节点一个"节点宕机"告警和若干集群级告警；CloudWatch 仪表板 `<stack>-clickhouse`；日志组 `/clickhouse/<stack>`。节点上运行 CloudWatch Agent（CPU、内存、错误日志）和 `ch-cw-metrics.timer`（每分钟上报 ClickHouse 健康指标）。 |
| `Prometheus` | Amazon Managed Service for Prometheus 工作区，包含告警规则和 Alertmanager（告警发到同一个 SNS 主题）；可选 Amazon Managed Grafana。节点上运行 node_exporter 和 Prometheus（agent 模式），采集 ClickHouse/Keeper 自带的 `:9363/metrics` 并 remote-write 到 AMP。 |

两种模式可以随时通过**更新堆栈的 `Monitoring` 参数**切换：节点不会被替换，代理由日常配置关联自动切换。

`AlarmEmail` 不为空时，会给 SNS 主题添加邮件订阅（需要在邮件里点击确认）。也可以自行订阅 Slack、PagerDuty 等。

**CloudWatch 指标**（命名空间 `ClickHouse`，维度为 `Cluster=<stack>` 和 `Cluster+Node`，由 `ch-cw-metrics` 每分钟上报；计数类指标上报的是与上一分钟相比的增量）：

| 指标 | 节点 | 告警（默认阈值） |
|---|---|---|
| `ServerUp` / `KeeperUp` | 每个节点 | 连续 3 分钟没有成功的健康检查，或没有数据上报 → `<stack>-<node>-ServerUp/KeeperUp`（每节点一个） |
| `DataDiskUsedPercent` | 所有节点 | 数据盘使用率 > `DiskUsageAlarmPercent`（80%），10 分钟（**每节点一个**，第二个节点写满不会被已经 ALARM 的告警掩盖） |
| `RootDiskUsedPercent` | 所有节点 | 系统盘使用率 > 85%，10 分钟（每节点一个） |
| `CpuUsedPercent`、`MemoryUsedPercent` | 所有节点 | 任一节点 > 90%，持续 15 分钟 |
| `MaxPartsPerPartition` | ClickHouse | > 600（达到 1000 开始延迟插入，3000 拒绝插入；取自 `system.asynchronous_metrics` 的 `MaxPartCountForPartition`） |
| `DelayedInserts` | ClickHouse | > 0 持续 3 分钟 |
| `RejectedInserts` | ClickHouse | 5 分钟内 > 0（客户端收到 Too many parts 错误） |
| `DistributedFilesToInsert` | ClickHouse | > 1000，持续 15 分钟（Distributed 表异步写入积压） |
| `FailedQueries` | ClickHouse | 全集群每 5 分钟 > 100，持续 10 分钟 |
| `MaxReplicaDelaySeconds` | ClickHouse | > 300 秒，持续 15 分钟 |
| `ReadonlyReplicas` | ClickHouse | ≥ 1（通常是与 Keeper 断开） |
| `ReplicationQueueSize` | ClickHouse | > 1000，持续 15 分钟 |
| `KeeperSessionUp` | ClickHouse | < 1（没有 Keeper 会话） |
| `KeeperHardwareExceptions` | ClickHouse | 全集群每 5 分钟 > 10 次与 Keeper 的连接错误，持续 10 分钟 |
| `ServerRestarts` | ClickHouse | ≥ 1：uptime 变小且版本没变（崩溃、OOM、实例重启）；升级引起的重启不告警 |
| `FailedMutations` | ClickHouse | > 0（ALTER mutation 一直失败） |
| `KeeperIsLeader` | Keeper | 集群内没有 leader，持续 3 分钟 |
| `KeeperAvgLatencyMs` | Keeper | > 100 ms，持续 10 分钟 |
| `KeeperOutstandingRequests` | Keeper | > 100，持续 5 分钟 |
| `BackupAgeHours` | 每个分片的 1 号副本 | > 26 小时（仅 `EnableBackup=true`） |

缺失数据：只有节点宕机、Keeper 无 leader 这两类把"没有数据"当作告警；其它告警（包括备份时效：备份节点每分钟都会上报距上次备份的小时数，没有数据只会是节点或上报程序宕机，已由宕机告警覆盖）缺数据时视为正常（旧版本 ClickHouse 没有的指标按 0 上报，不会误报）。每个节点的告警在该节点的 `<id>Ready` 和日常配置关联之后才创建，扩容时新节点启动期间不会误报。

**Prometheus 告警规则**（`lib/monitoring.ts` 中的 `alertRulesYaml`）：

| 规则 | 条件 |
|---|---|
| `ClickHouseServerDown` / `ClickHouseKeeperDown` | **按节点**：3 小时内出现过、但现在不在线（`up == 0` 或序列消失）持续 3 分钟，告警里带节点名；正在创建的新节点没有历史，不会误报 |
| `ClickHouseServersMissing` / `ClickHouseKeepersMissing` | 在线数少于 分片数×副本数 / Keeper 数，持续 **30 分钟**（兜底：从未起来或宕机超过 3 小时的节点） |
| `ClickHouseServerRestarted` | 1 小时内 `Uptime` 回退且 `VersionInteger` 没变 |
| `ClickHouseKeeperNoLeader`、`ClickHouseReadonlyReplica` | 同 CloudWatch |
| `ClickHouseKeeperSessionLost` | `ZooKeeperSession` < 1 或 `ZooKeeperSessionExpired` > 0，3 分钟 |
| `ClickHouseKeeperConnectionErrors` | 5 分钟内 `ZooKeeperHardwareExceptions` 增加 > 10，持续 10 分钟 |
| `ClickHouseDataDiskUsage`、`ClickHouseRootDiskUsage`（85%） | 按节点，10 分钟 |
| `ClickHouseCpuHigh`、`ClickHouseMemoryHigh` | 按节点 > 90%，15 分钟（node_exporter） |
| `ClickHouseTooManyParts`、`ClickHouseDelayedInserts`、`ClickHouseRejectedInserts`、`ClickHouseDistributedQueue`、`ClickHouseFailedQueries`、`ClickHouseFailedMutations`、`ClickHouseReplicaDelay`、`ClickHouseReplicationQueue`、`ClickHouseKeeperLatency`、`ClickHouseKeeperOutstandingRequests` | 阈值同 CloudWatch |
| `ClickHouseBackupStale` | 单独的规则组 `clickhouse-backup-alerts`，只在 `EnableBackup=true` 时创建 |

`ClickHouseFailedMutations` 的数据来自 Prometheus agent 的 `clickhouse-health` 抓取任务：以 `ops_monitor` 身份对 `:8123` 执行一条 `FORMAT Prometheus` 查询（`system.mutations`）。

查询 AMP（需要 SigV4 签名，服务名 `aps`）：

```bash
eval "$(aws configure export-credentials --format env)"
curl -s --aws-sigv4 "aws:amz:<region>:aps" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  --data-urlencode 'query=count by (job) (up == 1)' <PrometheusQueryEndpoint 输出>
# 告警状态: 把 .../api/v1/query 换成 .../api/v1/alerts
```

**Amazon Managed Grafana**（`CreateGrafanaWorkspace=true`）：

1. 登录方式（参数 `GrafanaAuthProvider`，部署前先确认账号情况）：

   ```bash
   # 判断是否已开通 IAM Identity Center：对 Identity Center 所在区域执行，有输出即已开通。
   # 不确定区域时可遍历所有区域；成员账号看不到组织实例，需要问组织管理员。
   aws sso-admin list-instances --region <region> --query 'Instances[].[InstanceArn,IdentityStoreId]' --output text
   ```

   - `SAML`（默认，任何账号都能部署成功）：工作区创建后，在 Grafana 控制台 → 工作区 → Authentication → SAML 中导入 IdP（Okta、Entra ID、ADFS 等）的元数据，并配置 admin 角色对应的断言属性；配置完成前没有人能登录。
   - `AWS_SSO`：组织或账号**必须已经开通** IAM Identity Center，否则 Grafana 工作区创建失败，整个堆栈回滚。Identity Center 可以在**其它区域**：本项目验证过，us-west-2 的工作区使用 us-east-1 的 Identity Center 可以正常登录。创建后给用户或组分配 Admin/Viewer 权限：
     ```bash
     aws identitystore list-users --region <identity-center 区域> --identity-store-id <d-xxxxxxxxxx>   # 查出 UserId
     aws grafana update-permissions --workspace-id <GrafanaUrl 中的 g-xxxx> --update-instruction-batch \
       '[{"action":"ADD","role":"ADMIN","users":[{"id":"<UserId>","type":"SSO_USER"}]}]'   # 组用 SSO_GROUP
     ```
     打开 `GrafanaUrl`，点击 *Sign in with AWS IAM Identity Center* 登录。
   - 两者都没有：设置 `CreateGrafanaWorkspace=false`，只用 AMP（用 SigV4 查询，见上文，或接入自建 Grafana）；以后开通了再改回 `true`。
   - `SAML` 和 `AWS_SSO` 之间可以通过更新堆栈原地切换，工作区不会被替换（已验证）。
2. 添加数据源：在 Grafana 中选择 *Amazon Managed Service for Prometheus*，或者用 Prometheus 类型并设置：

   | 字段 | 值 |
   |---|---|
   | URL | 工作区地址 `https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>` |
   | SigV4 auth | 开启 |
   | Auth | Workspace IAM Role（即 `ec2_iam_role`） |
   | 区域 | `<region>` |

3. 导入仪表板：Dashboards → Import → 上传 `docs/grafana/clickhouse-cluster-dashboard.json`。仪表板包含节点存活、Keeper leader、QPS、写入行数、CPU、内存、数据盘、EBS 吞吐、part 数、复制队列、Keeper 延迟、插入被延迟或拒绝、距上次备份的小时数。

**成本提示**：
- Prometheus 模式下，每个节点约有 2,000 条时间序列，按 30 秒采集，5 个节点每天约 3,000 万个样本。如需降低，可以把 `prometheus.yml` 的 `scrape_interval` 调到 60 秒，或用 `metric_relabel_configs` 丢弃不需要的 `ClickHouseProfileEvents_*`。
- CloudWatch 模式下，每个节点约 10–15 个自定义指标。

### 4. 备份与恢复（参数 `EnableBackup`）

**机制**：
- 堆栈创建一个 S3 桶：开启版本控制、SSE-S3 加密、禁止公开访问、只允许 TLS 访问；对象在 `BackupRetentionDays` 天后过期；**删除堆栈时保留该桶**。
- 每个分片的 1 号副本运行 `ch-backup.timer`，每天在 `BackupTimeUTC` 执行一次：
  - 周日，或者已有超过 7 天没做全量时，做全量备份：`BACKUP ALL EXCEPT DATABASES system, information_schema TO S3(...)`；
  - 其他日子做增量备份，`base_backup` 指向最近一次全量。
- 备份路径：`s3://<bucket>/<stack>/shard-<N>/<UTC时间>-<full|incremental>/`。
- ClickHouse 通过实例角色访问 S3（`config.d/operations.xml` 中的 `use_environment_credentials`），配置文件里没有任何密钥。

**可恢复窗口**：增量备份依赖它的全量备份，而全量会先于后续增量过期，所以可以保证恢复的窗口是 `BackupRetentionDays - 7` 天（默认 35 − 7 = 28 天）。如果有合规要求，可以在桶上开启 S3 Object Lock 和跨区域复制（CRR）。

手动操作（在分片的 1 号副本上执行）：

```bash
sudo /opt/clickhouse-ops/bin/ch-backup.sh full          # 或 incremental / auto
journalctl -u ch-backup --no-pager | tail                # 定时备份的日志
cat /var/lib/clickhouse-ops/backup_last_name             # 最近一次备份的名称
aws s3 ls s3://<bucket>/<stack>/shard-1/                 # 列出所有备份
```

恢复（`URL=https://<bucket>.s3.<region>.amazonaws.com/<stack>/shard-<N>/<name>/`；从增量备份恢复时，会自动用到它的全量备份）：

```sql
-- 26.x 起，查询里的 S3 默认不能使用服务器自身的凭证（实例角色 / Pod Identity），需要显式允许
-- 单表恢复成新表名，校验后再替换原表
RESTORE TABLE db.t AS db.t_restored FROM S3('<URL>') SETTINGS s3_allow_server_credentials_in_user_queries = 1;
-- 整库恢复到所有节点（库已存在时先 DROP，或加 allow_non_empty_tables=true）
RESTORE DATABASE db ON CLUSTER '{cluster}' FROM S3('<URL>') SETTINGS s3_allow_server_credentials_in_user_queries = 1;
```

建议**每季度做一次恢复演练**：恢复到 `*_restored` 表，用 `count()` 和 `sum(cityHash64(*))` 与原表对比，并记录恢复耗时。本项目验证过：1,100 万行数据，全量 277 MB + 增量 4 MB，恢复后行哈希完全一致。

---

## 第二部分：需要手动执行的最佳实践与操作手册

### 5. 安全

- **用户与权限**：
  - `default` 用户只给管理员使用，密码保存在 Secrets Manager。
  - 应用使用 SQL RBAC 创建的独立用户，并配置资源上限和配额：
    ```sql
    CREATE ROLE app_writer; GRANT INSERT, SELECT ON db.* TO app_writer;
    CREATE ROLE app_reader; GRANT SELECT ON db.* TO app_reader;
    CREATE SETTINGS PROFILE app_limits SETTINGS max_memory_usage = 10000000000, max_execution_time = 60 TO app_reader;
    CREATE QUOTA app_q FOR INTERVAL 1 hour MAX queries = 100000 TO app_reader;
    CREATE USER app IDENTIFIED WITH sha256_password BY '...' HOST IP '10.0.0.0/8' DEFAULT ROLE app_reader;
    ```
  - `ops_monitor` 是模版创建的无密码只读用户，只能从本机登录，供监控脚本使用。
- **节点间认证**：`remote_servers` 当前使用 `default` 用户和密码。可以改用 `<secret>`（interserver secret），在 `config.d` 中覆盖 `cluster.xml`。注意 `cluster.xml` 由日常配置关联管理，自定义内容要放在单独的文件里。
- **TLS**：
  - 开启 HTTPS 8443、原生协议 TLS 9440，以及节点间的 `interserver_https_port`；证书可以由 ACM Private CA 签发，分发到 `/etc/clickhouse-server/`。
  - 修改安全组，只开放 TLS 端口。
  - Keeper 之间可以开启 `<secure>` raft。
- **网络**：
  - `ClientCidr` 是必填参数（没有默认值，必须是合法的 IPv4 CIDR），只放应用所在的网段；更好的做法是在安全组里改成只允许应用的安全组访问。
  - 统一入口可以使用内网 NLB，监听 9440/8443，后端是所有副本。
- **密码不出现在命令行**：模版里的脚本通过环境变量 `CLICKHOUSE_PASSWORD` 把密码交给 `clickhouse-client`（`ps` 看不到）。手动连接时同样建议：`CLICKHOUSE_PASSWORD="$(aws secretsmanager get-secret-value ...)" clickhouse-client`（见堆栈输出 `ConnectCommand`）。
- **密钥轮换**：轮换 Secrets Manager 中的密码后，执行一次日常配置关联（`start-associations-once`）重新生成 `cluster.xml`；`users.d/default-password.xml` 需要逐个节点更新。
- **系统补丁**：使用 SSM Patch Manager 的 Maintenance Window，**按副本错开**执行（例如先打所有 r1，再打所有 r2），每次重启后确认 `ReadonlyReplicas=0`、复制延迟恢复正常。
- **审计**：`system.query_log` 和 `session_log` 中记录了所有查询和登录。长期留存可以定时 `INSERT INTO FUNCTION s3(...) SELECT ... FROM system.query_log` 导出到 S3。

### 6. 升级与配置变更

- **版本升级（推荐方式）**：修改堆栈参数 `ClickHouseVersion` 并更新堆栈。日常配置关联会**逐个节点**升级：Keeper 和 ClickHouse 都处理，每个节点健康后才继续下一个，失败即停止，CloudFormation 会等待整个过程完成。
  - 本项目验证过：从 25.8.33.6 原地滚动升级到 26.8.24.9，5 个节点依次完成，数据和实例 ID 不变。
- **升级前**：
  1. 只使用 LTS 版本，不要跳跃多个 LTS。
  2. 先在预发集群跑一遍业务 SQL 和写入压测（`perf/`）。25.8 → 26.8 的已知变化包括：插入去重默认改为 `deduplicate_insert`、小批量写入变慢等。
  3. 确认最近一次备份成功。
  4. 必要时在 profile 中设置 `compatibility = '25.8'`，暂时保留旧版本的行为。
- **回退**：不支持降级。更新堆栈时降低 `ClickHouseVersion` 会被 UpdateGuard 拒绝。升级失败导致堆栈回滚时，已经升级的节点**保持新版本**（日常配置记录警告、不失败，所以回滚能正常完成），没升级的节点保持旧版本；之后修复问题再重新升级即可（集群可以在两个版本混合的状态下短时间运行）。确实需要回到旧版本时，从升级前的备份恢复到新集群。
- **配置变更**：
  - 自定义配置放在 `config.d/<name>.xml`、`users.d/<name>.xml` 中，纳入 Git 管理，通过 SSM Run Command 或自有的 SSM 文档下发。
  - 不要修改由关联管理的文件：`cluster.xml`、`system-log-ttl.xml`、`operations.xml`、`users.d/ops-monitor.xml`。
  - 大部分设置会自动重新加载，也可以执行 `SYSTEM RELOAD CONFIG`；涉及端口、监听地址的配置需要逐个节点重启。

### 7. 容量与扩缩容

- **数据盘扩容**：调大 `DataVolumeSize`（Keeper 节点对应 `KeeperDataVolumeSize`）并更新堆栈，EBS 会在线扩容；然后执行一次关联，或等最多 1 小时，xfs 会自动扩展。EBS 每 6 小时只能修改一次。
- **IOPS / 吞吐**：调整 `DataVolumeIops` 和 `DataVolumeThroughput`，在线生效。性能测试表明 gp3 默认的 125 MiB/s 是写入瓶颈，生产环境建议约 300 MiB/s（m7g.2xlarge 的 EBS 基线带宽为 312.5 MB/s）。
- **纵向扩容（更换实例类型）**：不能通过堆栈修改。实例固定使用启动模版第 1 版，修改 `ClickHouseInstanceType` / `KeeperInstanceType` 不会作用于任何节点（包括以后扩容出来的节点），所以 UpdateGuard 会拒绝这类更新。请按下面的步骤**逐个节点**手动修改（先换完一个副本的所有分片，再换下一个副本，例如先所有 `-r1`，再所有 `-r2`；同一分片任何时候只停一个副本）：
  1. 确认集群健康：所有节点 `ServerUp=1`，`ReadonlyReplicas=0`，复制延迟正常；记录本节点的表数：
     ```sql
     SELECT count() FROM system.replicas WHERE is_readonly;          -- 所有节点都应为 0
     SELECT max(absolute_delay) FROM system.replicas;                 -- 小于 60
     SELECT count() FROM system.tables WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA');
     ```
  2. 停机、改类型、开机（实例 ID、ENI、IP、数据盘都不变；Graviton 和 x86 不能互换，AMI 架构不同）：
     ```bash
     aws ec2 stop-instances --instance-ids <id> && aws ec2 wait instance-stopped --instance-ids <id>
     aws ec2 modify-instance-attribute --instance-id <id> --instance-type '{"Value":"r8g.2xlarge"}'
     aws ec2 start-instances --instance-ids <id> && aws ec2 wait instance-status-ok --instance-ids <id>
     ```
  3. 等节点恢复：表数与第 1 步相同，`SELECT count() FROM system.asynchronous_loader WHERE status = 'PENDING'` 为 0，没有只读副本，复制延迟追上（< 60 秒），然后才处理下一个节点。
  4. Keeper 节点同样**一次一个**：开机后等 `echo mntr | nc localhost 9181` 显示 `zk_server_state` 为 `leader`/`follower`，并且 leader 上 `zk_synced_followers` 等于 Keeper 数 − 1，再处理下一个 Keeper。
  5. 堆栈参数保持原值不变。注意：以后扩容（调大 `ShardCount`/`ReplicaCount`）新建的节点**仍然是创建堆栈时的实例类型**，需要对它们重复上述步骤。
- **缩容（减少分片或副本）**：不支持，调小 `ShardCount`/`ReplicaCount` 会被 UpdateGuard 拒绝（否则 CloudFormation 会删除节点及其数据盘）。需要更小的集群时，新建一个集群，用 `BACKUP`/`RESTORE`（见第 4 节）或 `INSERT ... SELECT FROM remote()` 迁移数据，再删除旧堆栈。
- **增加副本**：
  1. 把 `ReplicaCount` 调大并更新堆栈，新节点自动启动；关联会更新所有节点的 `remote_servers`。
  2. 在新副本上创建库和表：在已有节点上执行 `SHOW CREATE DATABASE db` 和 `SHOW CREATE TABLE db.t SETTINGS show_table_uuid_in_table_create_query_if_not_nil = 1`，把得到的 DDL（**必须带 `UUID '...'`**）在新节点上执行。默认的 ZooKeeper 路径是 `/clickhouse/tables/{uuid}/{shard}`：不带 UUID 时新表会得到新的 UUID，成为一个空的、不与任何副本同步的新表。带上原 UUID 后新副本会自动从已有副本拉取数据。Distributed 表同样处理。
  3. 推荐对新库使用 `ENGINE = Replicated` 数据库引擎，表结构会自动同步到新副本，不需要第 2 步。
- **增加分片**：调大 `ShardCount`。新分片的节点上没有任何用户表，要按上面"增加副本"第 2 步在**每个新节点**上创建库、复制表和 Distributed 表（带原 UUID 时新分片的 ZooKeeper 路径是 `/clickhouse/tables/<uuid>/<新分片号>`，与旧分片互不影响），否则写入 Distributed 表时分到新分片的数据会失败。新分片是空的，已有数据**不会自动重新分布**；新写入通过 Distributed 表按 sharding key 分布。如需重新平衡历史数据，按分区 `INSERT INTO dist SELECT ... FROM old` 迁移。规划时尽量一次留足分片。
- **不可变参数**：`ClusterName`（宏、ZooKeeper 路径、DNS 区名）、`KeeperCount`（需要重新配置 raft 成员）、`VpcId`/`SubnetIds`/`MultiAZ`（ENI 和数据盘绑定在子网/可用区上）创建后都不能修改，UpdateGuard 会拒绝。生产环境 Keeper 请直接选 3。需要改这些参数时，新建集群并迁移数据。
- **单节点故障**：
  - **实例故障**：EC2 默认的自动恢复，或手动 stop/start，会保留实例 ID、ENI 和数据盘（数据盘是独立资源），节点启动后自动追上复制。
  - **数据盘损坏、数据丢失**：用快照或新卷替换数据盘，在该节点执行 `sudo -u clickhouse touch /var/lib/clickhouse/flags/force_restore_data`，然后重启 clickhouse-server，副本会从其它副本恢复。如果 Keeper 中的元数据丢失，执行 `SYSTEM RESTORE REPLICA db.t`。
  - 建议每年至少演练一次。
- **冷热分层**：在 `config.d` 中配置 `storage_configuration`（EBS 热数据 + S3 磁盘），在表上设置 `TTL created_at + INTERVAL 90 DAY TO VOLUME 'cold'`，可以显著降低存储成本。

### 8. 表设计与写入链路（结合本项目的性能测试结论）

- **排序键与访问模式**：`t_billing_records` 的排序键是 `(kafka_meta_event_type, created_at, user_id)`。按用户、按组织的查询每次要扫描数千万行。可以考虑：
  - `ALTER TABLE ... ADD PROJECTION p_user (SELECT * ORDER BY user_id, created_at)`，org_id 同理；
  - 或者为账单类查询建按天预聚合的物化视图（`SummingMergeTree` / `AggregatingMergeTree`），把 Q1/Q3/Q8 这类查询降到毫秒级。
- **跳数索引**：给 `trace_id` 加 `INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 1`，避免查找时全表扫描。
- **列类型**：`model_code`、`status`、`scene`、`kafka_meta_event_type`、`currency` 改用 `LowCardinality(String)`；时间列加 `CODEC(Delta, ZSTD)`；大段 JSON 文本使用 `ZSTD(3)`。
- **数据生命周期**：设置表级 TTL，并按月分区，便于直接 `DROP PARTITION` 删除整月数据。
- **写入**：
  - 每批 ≥ 10 万行，或者开启 `async_insert=1, wait_for_async_insert=1`；
  - 避免高频小批量写入导致 part 过多（看 `MaxPartsPerPartition` 告警）。
  - 计费等关键数据可以开启 `insert_quorum=2`，代价约 5%。
- **Kafka 引擎**：
  - 把 `kafka_num_consumers` 设为分区数，并设置 `kafka_thread_per_consumer=1`；
  - 用 `system.kafka_consumers` 监控消费积压；
  - 物化视图的输出列必须与目标表一致：原 DDL 中的 `client_ip`、`forwarded_for` 在 25.8 和 26.8 上都会报错。
- **修改数据**：尽量不用 `ALTER UPDATE/DELETE`，它们会重写整个 part；需要更正时使用轻量删除（`DELETE FROM`）或 `ReplacingMergeTree`。
- **DDL**：一律使用 `ON CLUSTER '{cluster}'`，或使用 `Replicated` 数据库引擎。

### 9. 成本

- **计算**：Graviton 实例 + Compute Savings Plans 或 EC2 Instance Savings Plans（1 年期大约省 30–40%）。
- **Keeper**：运行一段时间后看 CPU 和内存，通常 `t4g.medium` 或 `m7g.medium` 就够用。Keeper 的实例类型同样不能通过堆栈修改，按第 7 节的纵向扩容步骤逐个节点操作。
- **存储**：gp3 按需配置 IOPS 和吞吐；冷数据放 S3 分层存储；备份保留期按合规要求设置。
- **监控**：CloudWatch 模式比 Prometheus 便宜；Prometheus 模式的成本主要由采集间隔和时间序列数量决定。

### 10. 删除集群

1. 确认最近一次备份成功，或者先手动做一次全量备份。
2. 把 `EnableTerminationProtection` 改为 `false` 并更新堆栈（节点不会被替换）。
3. `aws cloudformation delete-stack --stack-name <stack>`。
4. 堆栈删除后会保留以下资源：
   - 每块数据盘的 EBS 快照（标签 `ch-logical-id`）；
   - 备份 S3 桶。

   确认不再需要后手动删除。

### 11. 故障排查速查

| 现象 | 排查 |
|---|---|
| 堆栈创建卡在 `<节点>Ready` | 节点上的 `/var/log/clickhouse-bootstrap.log`，CloudWatch 模式下也在日志组 `/clickhouse/<stack>` 中 |
| 堆栈更新失败，`UpdateGuard` 显示 `Update rejected ...` | 修改了不可变参数、调小了数量或降低了版本（见第 1 节）。改回原值再更新；实例类型按第 7 节手动修改 |
| 堆栈更新立即回滚，原因 `Action denied by stack policy` | 更新会删除或替换受堆栈策略保护的资源（例如调小 `KeeperCount`、`ShardCount`、`ReplicaCount`）。堆栈策略在 `UpdateGuard` 之前生效，所以看不到 `Update rejected` 的说明；按上一行处理，不要为此放开堆栈策略 |
| 节点重启后 clickhouse-server / keeper 起不来，`Dependency failed` | 数据盘没有挂载（`findmnt /var/lib/clickhouse`）：检查卷挂载状态和 `/etc/fstab`，挂载后再启动服务 |
| 堆栈更新卡在 `NodeConfigAssociation` | SSM State Manager 执行历史中失败节点的输出；修复后重新更新堆栈或执行 `start-associations-once` |
| `ReadonlyReplicas` 告警 | Keeper 是否有 leader（`echo mntr \| nc keeper-1.<cluster>.clickhouse.internal 9181`）；`system.zookeeper_connection` |
| `MaxPartsPerPartition` 告警 | `SELECT table, partition, count() FROM system.parts WHERE active GROUP BY ALL ORDER BY 3 DESC LIMIT 10`；检查写入批次大小 |
| `BackupAgeHours` 告警 | 在 1 号副本上执行 `journalctl -u ch-backup`；`system.backups` 中的 `error` 列 |
| 复制延迟 | `system.replication_queue` 中的 `last_exception`；`system.replicas` |
