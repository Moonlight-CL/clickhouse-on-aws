# ClickHouse on Amazon EKS（一键部署）

`templates/clickhouse-eks.template.json`（CDK 堆栈 `ClickHouseEks`）用一个 CloudFormation 堆栈完成以下全部工作：

- 创建 EKS 集群和节点组；
- 安装 [Altinity ClickHouse Operator](https://github.com/Altinity/clickhouse-operator)；
- 部署 ClickHouse Keeper 和 ClickHouse 集群；
- 配置监控告警、备份和系统日志 TTL。

这个模版不依赖 CDK assets，不需要执行 `cdk bootstrap`。

本手册的约定：
- 运维通用的最佳实践（安全、表设计、写入、成本等）见 [operations-guide.md](operations-guide.md)，那里的内容同样适用于 EKS；
- 本文只说明 EKS 特有的部分；
- 文中 `<stack>` 是堆栈名，同时也是 EKS 集群名；`<name>` 是参数 `ClusterName`。

## 1. 架构

```
VPC（新建 3 AZ，或使用已有 VPC + 私有子网）
 ├─ EKS 控制面（API 认证模式 + access entry、Secrets 用 KMS 加密、api/audit/authenticator 日志）
 ├─ system 节点组 ×2      ：operator、CoreDNS、EBS CSI controller、LB controller、备份/TTL CronJob、指标上报
 ├─ keeper 节点组 1..3    ：每个 AZ 一个节点组，各 1 个节点，taint dedicated=keeper
 └─ server 节点组 1..3    ：第 N 个节点组 = 第 N 个副本所在 AZ，节点数 = ShardCount，taint dedicated=server
```

- **ClickHouse 版本**：直接使用官方镜像 `clickhouse/clickhouse-server:<ClickHouseVersion>` 和 `clickhouse/clickhouse-keeper:<ClickHouseVersion>`。
- **资源对象**：
  - ClickHouse 用 `ClickHouseInstallation`（CHI，名称为 `<name>`）描述，Keeper 用 `ClickHouseKeeperInstallation`（CHK，名称为 `keeper`），都在 namespace `clickhouse` 下；
  - 每个 host 一个 pod 模版，通过节点组标签 `clickhouse-on-aws/slot=N` 固定到所属副本的 AZ。
  - 这样节点被替换后，新节点仍在 EBS 卷所在的 AZ，PVC 可以直接挂回。
- **每节点一个 pod**：hostname 反亲和，确保一个节点只跑一个 ClickHouse 或 Keeper pod。
  - Pod 为 Guaranteed QoS（requests = limits）。
  - `auto` 模式下，CPU = 节点可分配值 − 800m，内存 = 节点可分配值 − 2 GiB（留给 DaemonSet）。在 m7g.2xlarge 上约为 7.1 vCPU / 27.75 GiB。
- **存储**：StorageClass `ch-gp3`：
  - gp3，加密，xfs；
  - `reclaimPolicy: Retain`：删除 PVC 或堆栈时，EBS 卷保留，并带有标签 `ch-stack=<stack>`；
  - `WaitForFirstConsumer`，允许在线扩容。
  - 数据卷的 IOPS 和吞吐通过 `VolumeAttributesClass` 设置，可在线修改。
- **复制**：
  - 表引擎为 ReplicatedMergeTree；
  - operator 自动生成 `{cluster}`、`{shard}`、`{replica}` 宏和 `remote_servers`；
  - 节点间用 interserver secret（`secret.auto`）认证，`remote_servers` 里不写用户名和密码。
- **客户端访问**：
  - 默认创建内网 NLB（AWS Load Balancer Controller，IP target、跨可用区），开放 8123/9000，来源限制为 `ClientCidr`；
  - VPC 内也可以直接访问 pod IP（VPC CNI 分配的 pod IP 可路由）。
- **安装器**：自定义资源 `ClusterInstall` 由 Lambda 触发一个 CodeBuild 项目。
  - CodeBuild 运行在 VPC 私有子网内，所以 EKS API 只开私有端点也能工作。
  - 它用 helm/kubectl 完成安装、升级和卸载，日志写入 `/clickhouse/<stack>`（日志流 `installer/...`）。

### 不使用 IRSA：所有 AWS 权限都来自 EKS Pod Identity

| ServiceAccount | 权限 |
|---|---|
| `kube-system/aws-node`（VPC CNI add-on） | AmazonEKS_CNI_Policy（节点角色上**没有** CNI 权限） |
| `kube-system/ebs-csi-controller-sa`（EBS CSI add-on） | AmazonEBSCSIDriverPolicy + 加密卷所需的 KMS 权限 |
| `amazon-cloudwatch/cloudwatch-agent`（CloudWatch 模式） | CloudWatchAgentServerPolicy |
| `kube-system/aws-load-balancer-controller` | AWS Load Balancer Controller 官方策略 |
| `clickhouse/clickhouse`（ClickHouse pod） | 读写备份桶（BACKUP/RESTORE） |
| `clickhouse/ch-cw-metrics`（CloudWatch 模式） | `cloudwatch:PutMetricData`，仅限命名空间 `ClickHouse` |

- 集群里没有 OIDC provider。
- 节点角色只有 `AmazonEKSWorkerNodePolicy`、`AmazonEC2ContainerRegistryPullOnly` 和 `AmazonSSMManagedInstanceCore`。

## 2. 部署

**前提条件**：
- 已有 VPC 时，提供至少 2 个、最好 3 个**带 NAT 出口的私有子网**，每个 AZ 一个。
- 节点需要从 Docker Hub、helm 仓库和 GitHub 拉取镜像与 chart。

```bash
aws s3 cp templates/clickhouse-eks.template.json s3://<bucket>/clickhouse-eks.template.json
aws cloudformation create-stack --stack-name ch-eks \
  --template-url https://<bucket>.s3.<region>.amazonaws.com/clickhouse-eks.template.json \
  --parameters file://examples/eks-perf-params.json \
  --capabilities CAPABILITY_IAM
aws cloudformation wait stack-create-complete --stack-name ch-eks   # 约 25-30 分钟
```

主要参数（完整说明见模版中各参数的 Description）：

- `ClusterName` 最长 15 个字符：operator 把对象名中的集群名部分截断到 15 个字符，最长的对象名（每个 host 的 ConfigMap 卷 `chi-<name>-deploy-confd-<name>-<分片>-<副本>`）也必须不超过 63 个字符。
- 网络参数没有放开的默认值：`ClientCidr` 必须显式填写；EKS API 默认只开私有端点（安装器运行在 VPC 内），开启公有端点时必须给出 `EksPublicAccessCidrs`。

| 分组 | 参数 |
|---|---|
| 集群 | `ClusterName`（2–15 个字符）、`ClickHouseVersion`、`ShardCount`（1–5）、`ReplicaCount`（1–3）、`KeeperCount`（1 或 3） |
| 网络 | `CreateVpc`（true：新建 3 AZ VPC，配合 `VpcCidr`（/16）和 `NatGateways`（PerAz / Single）；false：使用 `VpcId` + `SubnetIds`）、`MultiAZ`、`ClientCidr`（**必填**，没有默认值）、`ClientLoadBalancer` |
| EKS | `KubernetesVersion`（1.34–1.37）、`EksPublicEndpoint`（默认 false，只有私有端点）、`EksPublicAccessCidrs`（开启公有端点时必填，没有默认值）、`EksAdminRoleArn` |
| 计算 | `ClickHouseInstanceType`、`KeeperInstanceType`、`SystemInstanceType`、`ClickHouseCpu/Memory`、`KeeperCpu/Memory`（默认 `auto`） |
| 存储 | `DataVolumeSize`、`DataVolumeIops`、`DataVolumeThroughput`、`KeeperDataVolumeSize`、`NodeRootVolumeSize` |
| 数据保护 | `EnableBackup`、`BackupRetentionDays`、`BackupTimeUTC`、`SystemLogRetentionDays` |
| 监控 | `Monitoring`（None / CloudWatch / Prometheus）、`AlarmEmail`、`DiskUsageAlarmPercent`、`CreateGrafanaWorkspace`、`GrafanaAuthProvider` |

堆栈的 Outputs 包括：
- `KubeconfigCommand`；
- `ClickHouseEndpoint`（NLB 域名）；
- `PasswordCommand`；
- 监控、备份相关的链接和资源名。

**访问集群**：
- 创建堆栈的 IAM 身份自动拥有集群管理员权限；
- 也可以用 `EksAdminRoleArn` 再授权一个角色；
- 如果 API 只开私有端点，需要在 VPC 内执行 kubectl（例如 SSM 登录到一台跳板机）。

```bash
aws eks update-kubeconfig --region <region> --name <stack>
kubectl -n clickhouse get chi,chk,pods,pvc
PW=$(aws secretsmanager get-secret-value --secret-id <AdminPasswordSecretArn> --query SecretString --output text)
clickhouse-client --host <ClickHouseEndpoint> --password "$PW"
```

## 3. 日常运维（都通过更新堆栈参数完成）

| 操作 | 做法 | 行为 |
|---|---|---|
| 升级 ClickHouse / Keeper | 修改 `ClickHouseVersion` | 安装器更新 CHK 和 CHI 的镜像，operator **逐个 host** 滚动重启；PodDisruptionBudget 保证同时最多 1 个不可用 |
| 数据盘扩容 / 提高 IOPS 或吞吐 | 修改 `DataVolumeSize` / `DataVolumeIops` / `DataVolumeThroughput` | 安装器修改 PVC：容量在线扩展，VolumeAttributesClass 在线改性能；不重启。两者在同一个 PVC patch 中提交。EBS 对同一个卷每 6 小时只允许一次修改：同时修改容量和性能时，安装器在日志和 CloudFormation 事件原因中给出 WARNING；修改 10 分钟内没有完成（例如 6 小时内的第二次修改）也会给出 WARNING。请用 `aws ec2 describe-volumes-modifications` 确认都已生效 |
| 更换机型 | 修改 `ClickHouseInstanceType` / `KeeperInstanceType` | **蓝绿替换**：机型是节点组属性，修改后 CloudFormation 先在同一 AZ 创建新节点组（keeper、server 各自依次一个节点组）；安装器按新机型节点计算 `auto` 资源，封锁（cordon）旧节点，CHK/CHI 滚动时 pod 落到新节点，operator 没有重启的 pod 由安装器逐个删除并等待 Ready 和健康检查；旧节点组在清理阶段被删除时已经没有 ClickHouse pod。缩小机型也不会因为旧 pod 的 requests 放不进新节点而卡住。`SystemInstanceType` 仍是原地滚动 |
| 增加副本 / 分片 | 修改 `ReplicaCount` / `ShardCount` | 先扩节点组，再更新 CHI；Altinity operator 会把已有表结构同步到新 host，新副本会自动从已有副本复制数据（已实测：1→2 个分片、2→3 个副本，不需要手工建表）。新分片是空的，历史数据不会自动重新分布 |
| 减少副本 | 减小 `ReplicaCount` | operator 删除多余副本的 StatefulSet，并对它们执行 `SYSTEM DROP REPLICA`（operator 配置 `reconcile.host.drop.replicas.onDelete: yes`，默认开启）；PVC/EBS 卷按 Retain 保留。之后请在剩余副本上确认 `SELECT * FROM system.replicas WHERE total_replicas != active_replicas` 为空，否则手动执行 `SYSTEM DROP REPLICA '<副本名>' FROM TABLE db.t` |
| 升级 Kubernetes | `KubernetesVersion` 每次加一个小版本 | 先升级控制面，再原地滚动升级节点组（一次一个节点组，一次一个节点） |
| 切换监控方式 | 修改 `Monitoring` | 安装或删除对应的 add-on、指标上报程序、告警和抓取器；ClickHouse pod 不重启 |
| 修改备份时间 / 保留期、日志 TTL | 修改对应参数 | 更新 CronJob 和 S3 生命周期规则 |

安装器每次执行都会检查以下各项，任何一项失败都会让堆栈更新失败并回滚：
- operator 完成了**本次**变更：安装器给 CHK 和 CHI 设置唯一的 `spec.taskID`（CloudFormation 请求 ID），先应用 CHK 并等待 `status.taskIDsCompleted` 包含它，再应用 CHI 并等待；状态为 `Aborted` 时立即失败；
- 每个 pod Ready；
- 每个 server 能访问 Keeper；
- 每个 server 都能看到完整的集群（`clusterAllReplicas`）。

**更新保护**：自定义资源 `UpdateGuard` 在其他所有资源之前更新，下列变更会被直接拒绝（堆栈不做任何改动就回滚；回滚本身总是放行）：

| 规则 | 参数 | 原因 |
|---|---|---|
| 创建后不能修改 | `ClusterName`、`KeeperCount`、`CreateVpc`、`VpcCidr`、`VpcId`、`SubnetIds`、`MultiAZ` | 改名会让所有 host 改名（变成一个新的空集群）；`KeeperCount` 改变 Raft 成员；网络参数和 `MultiAZ` 决定每个 keeper / 副本节点组所在的子网（AZ），EBS 卷不能跟随 pod 换 AZ，pod 会一直 Pending |
| 只能增大 | `ShardCount`、`DataVolumeSize`、`KeeperDataVolumeSize` | 删除分片会丢数据；EBS 卷不能缩小 |
| 只能升级 | `ClickHouseVersion`、`KubernetesVersion` | 降级不受支持 |

**时间限制**：CloudFormation 最多等自定义资源 3600 秒（ServiceTimeout 的上限）。触发安装器的 Lambda 把截止时间设为 3600 − 240 秒，安装器所有等待都按剩余时间计算；到截止时间时停止当前操作，并以明确的原因（time budget）向 CloudFormation 报告失败，然后堆栈回滚。估算（未实测，按每个 host 滚动重启约 1–3 分钟）：
- 首次创建：节点组和 add-on 之后，安装器约 10–15 分钟；
- 版本升级、修改 CPU/内存等需要滚动重启的变更：operator 逐个 host 重启，keeper + server 总数约 15 个以内（例如 5 分片 × 2 副本 + 3 keeper）可在时限内完成；最大规模 5 × 3 + 3 = 18 个 host 可能超时；
- 更换机型时还要加上逐个迁移 pod 的时间（每个约 1–3 分钟）。

大集群的这类变更建议分步进行（例如先改机型，再升级版本）。

需要说明的几点：
- 从旧版本模版升级到本版本的第一次堆栈更新会**替换所有 keeper / server 节点组**（机型从启动模版移到节点组属性），过程与更换机型相同：新节点组就绪后 pod 逐个迁移，然后删除旧节点组。
- 安装器和运维脚本通过环境变量 `CLICKHOUSE_PASSWORD`（经 stdin 或 Kubernetes Secret 传入）把密码交给 clickhouse-client，不出现在命令行或 `kubectl exec` 参数（EKS 审计日志）中；clickhouse-client 从 25.x（已核对 25.3、25.8 的源码）起支持该变量。
- 堆栈参数之外的自定义配置，可以在 CHI 中用 `kubectl edit chi <name>` 修改。但下一次堆栈更新会按模版重新应用 CHI，安装器生成的字段会被覆盖。长期保留的配置，建议放进 `lib/eks/installer/render.py` 后重新生成模版。
- operator 每次 reconcile 都可能在 `status.errors` 里报告 `Update Service ... just recreate the service`。这是 operator 0.27 对 Service 类型字段的已知比对问题，它会自行重建 Service，不影响使用。

## 4. 备份与恢复

**机制**：
- CronJob `clickhouse-backup` 每天在 `BackupTimeUTC` 运行，对每个分片执行原生 `BACKUP`：先在 1 号副本上执行，失败时依次尝试该分片的其他副本；一个分片失败不影响其他分片，只要有分片没有备份成功，Job 就以非零退出；
- 周日或 7 天内没有全量备份时做全量，其余日子做增量；
- 备份写到 `s3://<bucket>/<stack>/shard-N/<时间>-<full|incremental>/`；
- ClickHouse 通过 Pod Identity 获取凭证；
- 26.x 版本需要在查询里加 `s3_allow_server_credentials_in_user_queries = 1`，脚本会根据版本自动添加。

```bash
kubectl -n clickhouse create job backup-now --from=cronjob/clickhouse-backup   # 立即备份
kubectl -n clickhouse logs job/backup-now
```

```sql
-- 已备份的列表
SELECT name, status, event_time, formatReadableSize(total_size) FROM system.backup_log ORDER BY event_time DESC;
-- 恢复到新表名，校验后再替换原表
RESTORE TABLE db.t AS db.t_restored FROM S3('https://<bucket>.s3.<region>.amazonaws.com/<stack>/shard-1/<name>/')
  SETTINGS s3_allow_server_credentials_in_user_queries = 1;
```

本项目已验证：
- 全量和增量备份都成功写入 S3；
- 从增量备份恢复 510 万行，与原表的 `sum(cityHash64(*))` 完全一致。

## 5. 监控与告警

**CloudWatch 模式**：
- `amazon-cloudwatch-observability` add-on（Container Insights 增强版 + Fluent Bit）采集节点、pod 和容器的指标与日志；
- Deployment `ch-cw-metrics` 每分钟把 ClickHouse 和 Keeper 的健康指标写入命名空间 `ClickHouse`，指标名、维度和告警**与 EC2 方案相同**（见 operations-guide.md 第 3 节），区别：
  - Keeper 的 `DataDiskUsedPercent` 来自 Keeper 节点 kubelet 的 `kubelet_volume_stats_*`（Keeper PVC），每个 Keeper 一个告警；
  - CPU / 内存告警使用 Container Insights 的 `pod_cpu_utilization_over_pod_limit` / `pod_memory_utilization_over_pod_limit`（命名空间 `clickhouse` 内最大的 pod，相对 pod limit > 90%，15 分钟）；
  - 另外有：节点系统盘 `node_filesystem_utilization` > 85%、`pod_container_status_terminated_reason_oom_killed` ≥ 1（OOM kill）、`LogTtlJobAgeHours` > 3（每小时的 CronJob `clickhouse-log-ttl` 连续 3 小时没有成功；备份 CronJob 的失败由 `BackupAgeHours` 覆盖）；没有 `RootDiskUsedPercent` 告警；
  - `ch-cw-metrics` 的 RBAC（install.sh）：命名空间内 pods get/list、cronjobs get，集群级只有 `nodes/metrics` get（直接访问 kubelet `:10250/metrics`，用集群 CA 校验证书；不需要 `nodes/proxy`）；读不到的数据不上报，对应告警按"正常"处理；
  - 由 operator 因配置变更或节点组替换而重建 pod，也会触发 `ServerRestarts`（只有版本升级引起的重启不告警）；
- 仪表板 `<stack>-clickhouse` 中的 CPU 和内存图表使用 Container Insights 的 pod 指标。
- 告警在安装器（`ClusterInstall`）之后创建，安装器会等所有 pod Ready，扩容时新节点不会误报。

**Prometheus 模式**：
- 使用 Amazon Managed Service for Prometheus 的**托管抓取器**（AWS::APS::Scraper），集群内不部署 Prometheus，也不需要任何凭证；
- `/ops-metrics`、`clickhouse-health` 和 `ch-cw-metrics` 使用只读用户 `ops_monitor`：没有密码（抓取器配置里不含任何密码），只接受来自 VPC CIDR 的连接（VPC CNI 的 pod IP 和抓取器的 ENI 都在 VPC 子网内），只能 SELECT 它用到的几张 system 表；
- 抓取对象：
  - ClickHouse 和 Keeper 的 `:9363/metrics`；
  - 每个分片 1 号副本的 `/ops-metrics`（备份时间戳）；
  - 每个 ClickHouse 服务器的 `clickhouse-health`（一条 `FORMAT Prometheus` 查询：失败的 mutation 数）；
  - 通过 API server 代理（`/api/v1/nodes/<node>/proxy/metrics[/cadvisor]`，与 AWS 示例配置相同，`aps-collector-role` 已包含 `nodes/proxy`）抓取 kubelet 和 cAdvisor，只保留命名空间 `clickhouse` 的 PVC 使用量、容器 CPU/内存/limit、OOM 事件、容器启动时间和磁盘读写字节；未部署 kube-state-metrics；
- 告警规则和 Alertmanager → SNS 与 EC2 方案相同（见 operations-guide.md 第 3 节），区别：
  - 数据盘使用率用 ClickHouse 自身的 `DiskAvailable` / `DiskTotal`，CPU 用 ClickHouse 的 `OSUserTimeNormalized + OSSystemTimeNormalized`（每节点一个 pod），内存用 cAdvisor 的 working set / memory limit（按 pod）；没有系统盘规则；
  - 额外规则组 `clickhouse-kubernetes`：`ClickHouseKeeperDiskUsage`（Keeper PVC > `DiskUsageAlarmPercent`）、`ClickHouseContainerOOMKilled`（`container_oom_events_total`，尽力而为：被杀容器的序列可能来不及被抓取，重启由下面的规则兜底）、`ClickHouseKeeperRestarted`（1 小时内出现多个容器实例且镜像没变）；
- 可选 Grafana，仪表板 `docs/grafana/clickhouse-cluster-dashboard.json` 可以直接导入（磁盘吞吐在 EKS 上使用 cAdvisor 的 `container_fs_*_bytes_total`）。

**已验证的告警**：
- CloudWatch 模式：封锁（cordon）r2 所在节点并删除其 pod，约 3.5 分钟后 `ch-s1-r2-ServerUp` 进入 ALARM，SNS 通知发送成功；解除封锁后自动恢复。
- Prometheus 模式：同样的操作约 4.5 分钟后 `ClickHouseServerDown` 进入 Alertmanager，SNS 发送成功；托管抓取器的 clickhouse / keeper / clickhouse-ops 三个 job 都有数据。
- 两种模式之间通过更新堆栈切换，ClickHouse pod 不重启。

## 6. 删除

```bash
aws cloudformation delete-stack --stack-name <stack>
```

**删除顺序**：
1. 安装器先删除 NLB 对应的 Service（由 LB Controller 删除 NLB）；删除失败时安装器停在这一步并报告失败（LB Controller 保持安装），排除问题后再次删除堆栈即可，或者手动删除 NLB 后删除堆栈并保留 `ClusterInstall`；
2. 再删除 CHI、CHK、operator 和 namespace；
3. 最后由 CloudFormation 删除 EKS、节点组和 VPC。

如果安装器访问不到 EKS API，删除会继续，但日志中会给出 WARNING：Kubernetes 对象没有被清理，NLB 及其 ENI 可能残留，可以这样查找：
```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=elbv2.k8s.aws/cluster,Values=<stack>
```

**删除后保留的资源**（确认不再需要后手动删除）：
- **EBS 数据卷**（StorageClass 为 Retain，带标签 `ch-stack=<stack>`），可以这样列出：
  ```bash
  aws ec2 describe-volumes --filters Name=tag:ch-stack,Values=<stack> --query "Volumes[].[VolumeId,Size,Tags[?Key=='kubernetes.io/created-for/pvc/name']|[0].Value]"
  ```
- **备份 S3 桶**。

## 7. 与 EC2 方案的选择

| | EC2 方案 | EKS 方案 |
|---|---|---|
| 适合 | 没有 Kubernetes 运维能力，追求最少组件和最高单机性能 | 已有 EKS 平台，希望统一调度、GitOps、声明式运维 |
| 额外成本 | 无 | EKS 控制面约 $73/月，加 2 个 system 节点；CloudWatch 模式下 Container Insights 按指标量计费 |
| 单节点可用资源 | 整机 | 扣除 DaemonSet 和 kubelet 预留后约 89% 的 CPU、87% 的内存（m7g.2xlarge） |
| 升级 | SSM 关联逐节点滚动 | operator 逐 host 滚动 |

性能对比见 `perf/report-eks-26.8.24.9.html`。
