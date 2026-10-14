#!/usr/bin/env python3
"""Render the Kubernetes manifests of the ClickHouse cluster (CHK + CHI + supporting objects) as one JSON List.

Input: the CONFIG environment variable (JSON written by the installer Lambda from the CloudFormation properties)
plus a few runtime facts passed as arguments (node allocatable resources, VPC CIDRs, install timestamp).
Output: JSON on stdout, applied with `kubectl apply -f -`.
"""
import hashlib
import json
import os
import sys

C = json.loads(os.environ["CONFIG"])
facts = json.loads(sys.argv[1])

NS = "clickhouse"
NAME = C["ClusterName"]
SHARDS, REPLICAS, KEEPERS = int(C["ShardCount"]), int(C["ReplicaCount"]), int(C["KeeperCount"])
VERSION = C["ClickHouseVersion"]
LABEL_ROLE, LABEL_SLOT, TAINT = "clickhouse-on-aws/role", "clickhouse-on-aws/slot", "clickhouse-on-aws/dedicated"
BACKUP_ON = C["EnableBackup"] == "true"
LOG_TTL = int(C["SystemLogRetentionDays"])


def resources(kind):
    """Guaranteed QoS: requests == limits. 'auto' = node allocatable minus a reserve for the DaemonSets."""
    cpu, mem = C[f"{kind}Cpu"], C[f"{kind}Memory"]
    alloc = facts["allocatable"][kind.lower()]
    if cpu == "auto":
        cpu = f"{max(500, (alloc['cpu_m'] - 800) // 100 * 100)}m"
    if mem == "auto":
        mem = f"{max(1024, (alloc['mem_mi'] - 2048) // 256 * 256)}Mi"
    return {"requests": {"cpu": cpu, "memory": mem}, "limits": {"cpu": cpu, "memory": mem}}


def tolerate(role):
    return [{"key": TAINT, "operator": "Equal", "value": role, "effect": "NoSchedule"}]


def anti_affinity(app):
    # one pod per node (hard); the node selector already pins each replica / keeper to its own AZ node group
    return {"podAntiAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": [{
        "labelSelector": {"matchLabels": {"app": app}}, "topologyKey": "kubernetes.io/hostname"}]}}


PROMETHEUS = {
    "prometheus/endpoint": "/metrics", "prometheus/port": "9363", "prometheus/metrics": "true",
    "prometheus/events": "true", "prometheus/asynchronous_metrics": "true",
}

# ------------------------------------------------------------------------------------------------- Keeper (CHK)
keeper_res = resources("Keeper")
keeper = {
    "apiVersion": "clickhouse-keeper.altinity.com/v1", "kind": "ClickHouseKeeperInstallation",
    "metadata": {"name": "keeper", "namespace": NS},
    "spec": {
        # unique per installer run: the installer waits until status.taskIDsCompleted contains it
        "taskID": facts["task_id"],
        "defaults": {"templates": {"dataVolumeClaimTemplate": "keeper-data"}},
        "configuration": {
            "clusters": [{"name": "keeper", "layout": {"replicas": [
                {"templates": {"podTemplate": f"keeper-{k}"}} for k in range(1, KEEPERS + 1)]}}],
            "settings": {
                "logger/level": "information", "logger/console": "true", "listen_host": "0.0.0.0",
                "keeper_server/four_letter_word_white_list": "*", **PROMETHEUS,
            },
        },
        "templates": {
            "podTemplates": [{
                "name": f"keeper-{k}",
                "metadata": {"labels": {"app": "ch-keeper", "ch-role": "keeper", "ch-node": f"keeper-{k}"}},
                "spec": {
                    "nodeSelector": {LABEL_ROLE: "keeper", LABEL_SLOT: str(k)},
                    "tolerations": tolerate("keeper"),
                    "affinity": anti_affinity("ch-keeper"),
                    "securityContext": {"fsGroup": 101},
                    "containers": [{
                        "name": "clickhouse-keeper", "image": f"clickhouse/clickhouse-keeper:{VERSION}",
                        "imagePullPolicy": "IfNotPresent", "resources": keeper_res,
                    }],
                },
            } for k in range(1, KEEPERS + 1)],
            "volumeClaimTemplates": [{
                "name": "keeper-data", "reclaimPolicy": "Retain",
                "spec": {"storageClassName": "ch-gp3", "accessModes": ["ReadWriteOnce"],
                         "resources": {"requests": {"storage": f"{C['KeeperDataVolumeSize']}Gi"}}},
            }],
        },
    },
}

# ------------------------------------------------------------------------------------------------- ClickHouse (CHI)
server_res = resources("Server")
# Backup-age metric for Prometheus (scraped from replica 1 of each shard): last successful BACKUP, or the install
# time when there has been none yet (so a cluster that never backs up alerts after a day).
ops_metrics_xml = f"""<clickhouse>
  <http_handlers>
    <rule>
      <url>/ops-metrics</url>
      <methods>GET</methods>
      <handler>
        <type>predefined_query_handler</type>
        <query>SELECT 'clickhouse_backup_last_success_timestamp_seconds' AS name, greatest(toUnixTimestamp(maxIf(event_time, status = 'BACKUP_CREATED')), {facts['install_ts']}) AS value, 'Last successful backup of this shard' AS help, 'gauge' AS type FROM system.backup_log FORMAT Prometheus</query>
      </handler>
    </rule>
    <defaults/>
  </http_handlers>
</clickhouse>
"""
networks_admin = sorted(set([C["ClientCidr"], *facts["vpc_cidrs"], "127.0.0.1/32"]))
# system tables read by /ops-metrics (backup_log), the clickhouse-health scrape job (mutations) and ch-cw-metrics.sh
OPS_MONITOR_TABLES = ["asynchronous_metrics", "backup_log", "disks", "events", "metrics", "mutations", "parts", "replicas",
                      "replication_queue", "zookeeper_connection"]
host = lambda s, r: f"ch-s{s}-r{r}"  # noqa: E731
chi = {
    "apiVersion": "clickhouse.altinity.com/v1", "kind": "ClickHouseInstallation",
    "metadata": {"name": NAME, "namespace": NS},
    "spec": {
        "taskID": facts["task_id"],
        "defaults": {"templates": {"dataVolumeClaimTemplate": "data"}},
        "configuration": {
            "zookeeper": {"keeper": {"name": "keeper"}, "session_timeout_ms": 30000, "operation_timeout_ms": 10000},
            "users": {
                "default/password": {"valueFrom": {"secretKeyRef": {"name": "clickhouse-admin", "key": "password"}}},
                "default/networks/ip": networks_admin,
                "default/access_management": 1,
                # read-only monitoring user (/ops-metrics, metrics publisher): no password (nothing to leak into the scraper
                # configuration), accepted only from the VPC CIDRs (pod and scraper ENI IPs), SELECT on the tables it reads only.
                # Empty password as its SHA-256: the operator would give a user without any password its default password.
                "ops_monitor/password_sha256_hex": hashlib.sha256(b"").hexdigest(),
                "ops_monitor/networks/ip": sorted(set([*facts["vpc_cidrs"], "127.0.0.1/32"])),
                "ops_monitor/profile": "ops_readonly",
                "ops_monitor/grants/query": [f"GRANT SELECT ON system.{t}" for t in OPS_MONITOR_TABLES],
            },
            "profiles": {"ops_readonly/readonly": 1},
            "settings": {
                **PROMETHEUS,
                # S3 (BACKUP/RESTORE, s3 table function) uses the pod's EKS Pod Identity credentials
                "s3/use_environment_credentials": "true",
                "backup_log/database": "system", "backup_log/table": "backup_log",
                "backup_log/flush_interval_milliseconds": "7500",
                # metric_log is too wide for ALTER ... MODIFY TTL (metadata > max_query_size): TTL via config
                "metric_log/ttl": f"event_date + INTERVAL {LOG_TTL} DAY DELETE",
            },
            # served on every host; the scraper only collects it from replica 1 of each shard (label ch-backup-host)
            "files": {"config.d/ops-metrics.xml": ops_metrics_xml},
            "clusters": [{
                "name": NAME,
                "secret": {"auto": "true"},  # interserver secret instead of user/password in remote_servers
                "layout": {"shards": [{"replicas": [
                    {"templates": {"podTemplate": host(s, r)}}
                    for r in range(1, REPLICAS + 1)]} for s in range(1, SHARDS + 1)]},
            }],
        },
        "templates": {
            "podTemplates": [{
                "name": host(s, r),
                "metadata": {"labels": {"app": "ch-server", "ch-role": "server", "ch-node": host(s, r),
                                        "ch-backup-host": "true" if r == 1 else "false"}},
                "spec": {
                    "serviceAccountName": "clickhouse",
                    "nodeSelector": {LABEL_ROLE: "server", LABEL_SLOT: str(r)},
                    "tolerations": tolerate("server"),
                    "affinity": anti_affinity("ch-server"),
                    "securityContext": {"fsGroup": 101},
                    "terminationGracePeriodSeconds": 120,
                    "containers": [{
                        "name": "clickhouse", "image": f"clickhouse/clickhouse-server:{VERSION}",
                        "imagePullPolicy": "IfNotPresent", "resources": server_res,
                    }],
                },
            } for s in range(1, SHARDS + 1) for r in range(1, REPLICAS + 1)],
            "volumeClaimTemplates": [{
                "name": "data", "reclaimPolicy": "Retain",
                "spec": {"storageClassName": "ch-gp3", "accessModes": ["ReadWriteOnce"],
                         "volumeAttributesClassName": facts["data_vac"],
                         "resources": {"requests": {"storage": f"{C['DataVolumeSize']}Gi"}}},
            }],
        },
    },
}

items = [keeper, chi]

# ------------------------------------------------------------------------------------------------- client load balancer
if C["ClientLoadBalancer"] == "true":
    items.append({
        "apiVersion": "v1", "kind": "Service",
        "metadata": {"name": "clickhouse-nlb", "namespace": NS, "annotations": {
            "service.beta.kubernetes.io/aws-load-balancer-type": "external",
            "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal",
            "service.beta.kubernetes.io/aws-load-balancer-subnets": C["SubnetIds"],
            "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled": "true",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol": "HTTP",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-port": "8123",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-path": "/ping",
        }},
        "spec": {
            "type": "LoadBalancer", "loadBalancerClass": "service.k8s.aws/nlb",
            "loadBalancerSourceRanges": [C["ClientCidr"]],
            "selector": {"app": "ch-server", "clickhouse.altinity.com/chi": NAME},
            "ports": [{"name": "http", "port": 8123, "targetPort": 8123}, {"name": "tcp", "port": 9000, "targetPort": 9000}],
        },
    })

# ------------------------------------------------------------------------------------------------- backups
all_hosts = " ".join(f"chi-{NAME}-{NAME}-{s - 1}-{r - 1}" for s in range(1, SHARDS + 1) for r in range(1, REPLICAS + 1))


def ops_cronjob(name, schedule, command, env):
    return {
        "apiVersion": "batch/v1", "kind": "CronJob",
        "metadata": {"name": name, "namespace": NS},
        "spec": {
            "schedule": schedule, "timeZone": "Etc/UTC",
            "concurrencyPolicy": "Forbid", "startingDeadlineSeconds": 3600,
            "successfulJobsHistoryLimit": 3, "failedJobsHistoryLimit": 5,
            "jobTemplate": {"spec": {"backoffLimit": 1, "template": {"spec": {
                "restartPolicy": "Never",
                "nodeSelector": {LABEL_ROLE: "system"},
                "containers": [{
                    "name": name, "image": f"clickhouse/clickhouse-server:{VERSION}",
                    "command": ["bash", *command],
                    "env": [*env, {"name": "CLICKHOUSE_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "clickhouse-admin", "key": "password"}}}],
                    "resources": {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "512Mi"}},
                    "volumeMounts": [{"name": "ops", "mountPath": "/ops"}],
                }],
                "volumes": [{"name": "ops", "configMap": {"name": "clickhouse-ops"}}],
            }}}},
        },
    }


# system.*_log tables are created on first use and re-created by upgrades: (re)apply the TTL every hour
items.append(ops_cronjob("clickhouse-log-ttl", "17 * * * *", ["/ops/ch-log-ttl.sh"],
                         [{"name": "CH_HOSTS", "value": all_hosts}, {"name": "LOG_TTL_DAYS", "value": str(LOG_TTL)}]))

backup_hosts = " ".join(f"chi-{NAME}-{NAME}-{s - 1}-0" for s in range(1, SHARDS + 1))
# per shard its replicas, tried in this order
backup_shards = " ".join(",".join(f"chi-{NAME}-{NAME}-{s - 1}-{r - 1}" for r in range(1, REPLICAS + 1)) for s in range(1, SHARDS + 1))
if BACKUP_ON:
    hh, mm = C["BackupTimeUTC"].split(":")
    items.append(ops_cronjob("clickhouse-backup", f"{int(mm)} {int(hh)} * * *", ["/ops/ch-backup.sh", "auto"], [
        {"name": "BACKUP_SHARDS", "value": backup_shards},
        {"name": "BACKUP_URL", "value": f"https://{C['BackupBucket']}.s3.{C['Region']}.amazonaws.com/{C['StackName']}"},
    ]))

# ------------------------------------------------------------------------------------------------- CloudWatch metrics agent
if C["Monitoring"] == "CloudWatch":
    servers = " ".join(f"{host(s, r)}=chi-{NAME}-{NAME}-{s - 1}-{r - 1}" for s in range(1, SHARDS + 1) for r in range(1, REPLICAS + 1))
    keepers = " ".join(f"keeper-{k}=chk-keeper-keeper-0-{k - 1}" for k in range(1, KEEPERS + 1))
    items.append({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": "ch-cw-metrics", "namespace": NS},
        "spec": {"replicas": 1, "selector": {"matchLabels": {"app": "ch-cw-metrics"}}, "template": {
            "metadata": {"labels": {"app": "ch-cw-metrics"}},
            "spec": {
                "serviceAccountName": "ch-cw-metrics",
                "nodeSelector": {LABEL_ROLE: "system"},
                "containers": [{
                    "name": "agent", "image": "public.ecr.aws/aws-cli/aws-cli:latest",
                    "command": ["bash", "/ops/ch-cw-metrics.sh"],
                    "env": [
                        {"name": "SERVERS", "value": servers}, {"name": "KEEPERS", "value": keepers},
                        {"name": "BACKUP_HOSTS", "value": backup_hosts if BACKUP_ON else ""},
                        {"name": "CLUSTER_ID", "value": C["StackName"]}, {"name": "AWS_REGION", "value": C["Region"]},
                        {"name": "METRIC_NAMESPACE", "value": C["MetricNamespace"]},
                        {"name": "INSTALL_TS", "value": str(facts["install_ts"])},
                    ],
                    "resources": {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "256Mi"}},
                    "volumeMounts": [{"name": "ops", "mountPath": "/ops"}],
                }],
                "volumes": [{"name": "ops", "configMap": {"name": "clickhouse-ops"}}],
            },
        }},
    })

json.dump({"apiVersion": "v1", "kind": "List", "items": items}, sys.stdout)
