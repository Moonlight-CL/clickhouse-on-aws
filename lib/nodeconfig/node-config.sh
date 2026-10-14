#!/bin/bash
# ---- node-config.sh: day-2 configuration of a ClickHouse / Keeper node -------------------------------
# Run by the SSM State Manager association of the stack on every node (one node at a time), at stack
# create/update and then periodically. It is idempotent: files are only rewritten and services only
# restarted when something changed, so periodic runs are no-ops. It only restarts clickhouse-server /
# clickhouse-keeper for a version upgrade.
#
# Responsibilities:
#   * rolling upgrade of ClickHouse / Keeper to ClickHouseVersion (this node only; SSM runs one node at a time
#     and stops at the first failure, so the cluster is upgraded replica by replica)
#   * cluster topology in config.d/cluster.xml (ShardCount / ReplicaCount; reloaded by ClickHouse without restart)
#     and the other stack-managed config files (operations.xml, ops-monitor.xml)
#   * systemd drop-ins: clickhouse-server / clickhouse-keeper require the data volume mount
#   * grow the data filesystem after the EBS data volume was enlarged (DataVolumeSize)
#   * TTL of system.*_log tables (SystemLogRetentionDays)
#   * monitoring agents: None | CloudWatch (agent + metrics publisher) | Prometheus (node_exporter + agent -> AMP)
#   * scheduled S3 backups on replica 1 of every shard (EnableBackup)
#
# The {{ ... }} placeholders are SSM document parameters, substituted by SSM before the script runs. The
# `# @include <file>` lines are replaced by lib/userdata/<file> when the document is built (lib/node-config.ts).
# Passwords are passed to clickhouse-client in the CLICKHOUSE_PASSWORD environment variable, never on a command line.
set -Eeuo pipefail

CH_VERSION='{{ ClickHouseVersion }}'
CH_CLUSTER='{{ ClusterName }}'
CH_SHARDS='{{ ShardCount }}'
CH_REPLICAS='{{ ReplicaCount }}'
CH_KEEPERS='{{ KeeperCount }}'
CH_ZONE="$CH_CLUSTER.clickhouse.internal"
export CH_CLUSTER CH_SHARDS CH_REPLICAS CH_KEEPERS CH_ZONE   # used by render_cluster_xml
MONITORING='{{ MonitoringMode }}'
LOG_TTL_DAYS='{{ SystemLogRetentionDays }}'
BACKUP_BUCKET='{{ BackupBucket }}'
BACKUP_TIME='{{ BackupTimeUTC }}'
AMP_REMOTE_WRITE_URL='{{ AmpRemoteWriteUrl }}'
LOG_GROUP='{{ LogGroupName }}'
CLUSTER_ID='{{ ClusterId }}'
REGION='{{ Region }}'
SECRET_ARN='{{ SecretArn }}'
METRIC_NAMESPACE='{{ MetricNamespace }}'
PROMETHEUS_VERSION='{{ PrometheusVersion }}'
NODE_EXPORTER_VERSION='{{ NodeExporterVersion }}'

OPS_ETC=/etc/clickhouse-ops
OPS_BIN=/opt/clickhouse-ops/bin
OPS_VAR=/var/lib/clickhouse-ops
TEXTFILE_DIR=$OPS_VAR/textfile
mkdir -p "$OPS_ETC" "$OPS_BIN" "$OPS_VAR" "$TEXTFILE_DIR"
chmod 755 "$OPS_ETC" "$TEXTFILE_DIR"

log() { echo "[node-config $(date -u +%FT%TZ)] $*"; }
trap 'log "FAILED at line $LINENO"' ERR

ARCH=$(uname -m)   # aarch64 | x86_64
# install_clickhouse_packages, install_data_volume_dropins
# @include node-lib.sh
# render_cluster_xml, render_operations_xml, render_ops_monitor_xml
# @include cluster-xml.sh

# --------------------------------------------------------------------------- wait for bootstrap
for _ in $(seq 1 240); do [ -f /etc/clickhouse-bootstrap.done ] && break; sleep 10; done
if [ ! -f /etc/clickhouse-bootstrap.done ]; then log "node bootstrap has not finished after 40 minutes"; exit 1; fi

# one run at a time on this node (an update-triggered run and a scheduled or stale run can overlap)
exec 9>/run/clickhouse-node-config.lock
flock 9
# A node added by a stack update also receives a run of the association as it was before the update (State Manager
# applies it to new instances as soon as they register, before CloudFormation has updated it): that stale run would
# write the old topology over the new one. The stack's SSM parameter is updated before the association.
CURRENT=$(trap - ERR; aws ssm get-parameter --region "$REGION" --name "/clickhouse/$CLUSTER_ID/cluster-config" \
  --query Parameter.Value --output text 2>/dev/null) || CURRENT=
for kv in "CH_VERSION='$CH_VERSION'" "CH_SHARDS='$CH_SHARDS'" "CH_REPLICAS='$CH_REPLICAS'"; do
  if [ -n "$CURRENT" ] && ! grep -qxF "$kv" <<<"$CURRENT"; then
    log "stale run: $kv differs from /clickhouse/$CLUSTER_ID/cluster-config (the stack has been updated), nothing done"
    exit 0
  fi
done

TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
LOGICAL_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/tags/instance/ch-logical-id)
if [[ $LOGICAL_ID =~ ^ChS([0-9]+)R([0-9]+)$ ]]; then
  ROLE=clickhouse SHARD=${BASH_REMATCH[1]} REPLICA=${BASH_REMATCH[2]} NODE="ch-s${SHARD}-r${REPLICA}"
elif [[ $LOGICAL_ID =~ ^Keeper([0-9]+)$ ]]; then
  ROLE=keeper SHARD=0 REPLICA=0 NODE="keeper-${BASH_REMATCH[1]}"
else
  log "unknown node logical id '$LOGICAL_ID'"; exit 1
fi
# replica 1 of each shard takes the backups of its shard
BACKUP_NODE=false
if [ "$ROLE" = clickhouse ] && [ "$REPLICA" = 1 ] && [ -n "$BACKUP_BUCKET" ]; then BACKUP_NODE=true; fi
# start of the backup age (BackupAgeHours / clickhouse_backup_last_success_timestamp_seconds) until the first backup;
# created before the monitoring section, whose first metrics publish already reads it
if [ "$BACKUP_NODE" = true ] && [ ! -f "$OPS_VAR/backup_installed" ]; then date +%s > "$OPS_VAR/backup_installed"; fi
log "node $NODE (role $ROLE), monitoring=$MONITORING, backup_node=$BACKUP_NODE, log_ttl=${LOG_TTL_DAYS}d"

# write_file <path> <mode> [owner]: stdin -> path; returns 0 if the content changed, 1 if unchanged
write_file() {
  local path=$1 mode=$2 owner=${3:-root} tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  install -D -o "$owner" -g "$owner" -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# shared environment of the helper scripts installed below
write_file "$OPS_ETC/env" 600 <<EOF || true
CLUSTER_ID='$CLUSTER_ID'
REGION='$REGION'
NODE='$NODE'
ROLE='$ROLE'
SHARD='$SHARD'
REPLICA='$REPLICA'
SECRET_ARN='$SECRET_ARN'
METRIC_NAMESPACE='$METRIC_NAMESPACE'
BACKUP_BUCKET='$BACKUP_BUCKET'
BACKUP_NODE='$BACKUP_NODE'
TEXTFILE_DIR='$TEXTFILE_DIR'
EOF

SYSTEMD_CHANGED=0
unit() {  # unit <name> : stdin -> /etc/systemd/system/<name>
  if write_file "/etc/systemd/system/$1" 644; then SYSTEMD_CHANGED=1; return 0; fi
  return 1
}
reload_systemd() { if [ "$SYSTEMD_CHANGED" = 1 ]; then systemctl daemon-reload; SYSTEMD_CHANGED=0; fi; }
stop_units() { for u in "$@"; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done; }

# --------------------------------------------------------------------------- data volume
# EBS volumes can be enlarged in place (stack parameter DataVolumeSize / KeeperDataVolumeSize); grow xfs.
xfs_growfs /var/lib/clickhouse >/dev/null 2>&1 || true
# the services never start without the data volume (fstab mounts it nofail); takes effect at the next start
if [ -n "$(install_data_volume_dropins)" ]; then systemctl daemon-reload; log "data volume systemd drop-ins installed"; fi

admin_password() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" --query SecretString --output text; }
# chq <sql>: query the local server as default (password in the environment, not on the command line; needs PW)
chq() { CLICKHOUSE_PASSWORD="$PW" clickhouse-client --user default -q "$1"; }
# chq_try <sql>: like chq, errors silenced; only for $(...) in polling checks (no ERR trap log per attempt)
chq_try() { trap - ERR; CLICKHOUSE_PASSWORD="$PW" clickhouse-client --user default -q "$1" 2>/dev/null; }
# keeper_cmd <host> <4lw>: only for $(...) / pipelines
keeper_cmd() { trap - ERR; timeout 5 bash -c "exec 3<>/dev/tcp/$1/9181; printf '%s' '$2' >&3; cat <&3" 2>/dev/null; }
# wait_for <seconds> <cmd...>
wait_for() {
  local deadline=$(( $(date +%s) + $1 )); shift
  until "$@"; do [ "$(date +%s)" -ge "$deadline" ] && return 1; sleep 5; done
}
# is_at_least <value> <min>: numeric comparison that is false for an empty / non-numeric value
is_at_least() { [[ $1 =~ ^[0-9]+$ ]] && [ "$1" -ge "$2" ]; }

# --------------------------------------------------------------------------- rolling upgrade (this node)
# All waits of one node share a deadline of UPGRADE_BUDGET seconds, so a node always ends within the document step
# timeout (3600 s) and the largest cluster (5x3 servers + 3 keepers, one node at a time) within the association's
# waitForSuccessTimeoutSeconds (lib/node-config.ts).
UPGRADE_BUDGET=2700
left() { echo $(( DEADLINE - $(date +%s) )); }
if [ "$ROLE" = clickhouse ]; then PKG=clickhouse-server; else PKG=clickhouse-keeper; fi
INSTALLED=$(rpm -q --qf '%{VERSION}' "$PKG")
if [ "$INSTALLED" != "$CH_VERSION" ] && [ "$(printf '%s\n%s\n' "$INSTALLED" "$CH_VERSION" | sort -V | head -n1)" = "$CH_VERSION" ]; then
  # The stack's update guard rejects downgrades, so this is a CloudFormation rollback of an upgrade. ClickHouse cannot
  # be downgraded in place safely: keep the newer version (and finish the run) instead of failing the rollback.
  log "WARNING: $PKG $INSTALLED is newer than the target $CH_VERSION (stack rollback?). Downgrades are not supported:" \
    "keeping $INSTALLED on this node. To go back to $CH_VERSION restore a backup into a new cluster."
elif [ "$INSTALLED" != "$CH_VERSION" ]; then
  log "upgrading $PKG $INSTALLED -> $CH_VERSION"
  DEADLINE=$(( $(date +%s) + UPGRADE_BUDGET ))
  if [ "$ROLE" = clickhouse ]; then
    PW=$(admin_password)
    USER_TABLES="SELECT count() FROM system.tables WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA') AND NOT is_temporary"
    # baseline: everything that has to be back (loaded and replicating) before the next node may restart
    TABLES_BEFORE=$(chq "$USER_TABLES") || { log "clickhouse-server is not healthy before the upgrade, not upgrading"; exit 1; }
    REPLICAS_BEFORE=$(chq 'SELECT count() FROM system.replicas')
    log "before restart: $TABLES_BEFORE table(s), $REPLICAS_BEFORE replicated table(s)"
    install_clickhouse_packages clickhouse-common-static clickhouse-server clickhouse-client
    systemctl restart clickhouse-server
    up() { [ "$(chq_try 'SELECT version()')" = "$CH_VERSION" ]; }
    loaded() {
      is_at_least "$(chq_try "$USER_TABLES")" "$TABLES_BEFORE" &&
        is_at_least "$(chq_try 'SELECT count() FROM system.replicas')" "$REPLICAS_BEFORE" &&
        # asynchronous table loading (system.asynchronous_loader exists since 24.x): no job left to run
        { [ "$(chq_try "SELECT count() FROM system.tables WHERE database = 'system' AND name = 'asynchronous_loader'")" != 1 ] ||
          [ "$(chq_try "SELECT count() FROM system.asynchronous_loader WHERE status = 'PENDING'")" = 0 ]; }
    }
    rw() { [ "$(chq_try 'SELECT count() FROM system.replicas WHERE is_readonly')" = 0 ]; }
    caught_up() { [ "$(chq_try 'SELECT max(absolute_delay) < 60 FROM system.replicas')" = 1 ]; }
    wait_for "$(left)" up || { log "clickhouse-server did not come back on $CH_VERSION"; exit 1; }
    wait_for "$(left)" loaded || { log "not all $TABLES_BEFORE table(s) / $REPLICAS_BEFORE replicated table(s) are loaded after the upgrade"; exit 1; }
    wait_for "$(left)" rw || { log "replicated tables still read-only after upgrade"; exit 1; }
    wait_for "$(left)" caught_up || { log "replica did not catch up (absolute_delay < 60 s) after upgrade"; exit 1; }
  else
    install_clickhouse_packages clickhouse-keeper
    systemctl restart clickhouse-keeper
    in_quorum() { [ "$(keeper_cmd 127.0.0.1 ruok)" = imok ] && keeper_cmd 127.0.0.1 mntr | grep -Eq '^zk_server_state\s+(leader|follower|standalone)'; }
    # the leader reports all other keepers as synced followers (this one included) before the next keeper restarts
    followers_synced() {
      [ "$CH_KEEPERS" = 1 ] && return 0
      local k mntr
      for k in $(seq 1 "$CH_KEEPERS"); do
        mntr=$(keeper_cmd "keeper-$k.$CH_ZONE" mntr)
        if grep -Eq '^zk_server_state\s+leader' <<<"$mntr"; then
          [ "$(awk '$1 == "zk_synced_followers" { print $2 }' <<<"$mntr")" = $(( CH_KEEPERS - 1 )) ]
          return
        fi
      done
      return 1
    }
    wait_for "$(left)" in_quorum || { log "keeper did not rejoin the quorum on $CH_VERSION"; exit 1; }
    wait_for "$(left)" followers_synced || { log "keeper leader does not report all $(( CH_KEEPERS - 1 )) followers as synced"; exit 1; }
  fi
  log "$PKG upgraded to $CH_VERSION"
fi

# --------------------------------------------------------------------------- system log TTL and topology (ClickHouse nodes)
if [ "$ROLE" = clickhouse ]; then
  PW=$(admin_password)
  # topology: re-render remote_servers/zookeeper/macros (picked up by ClickHouse without restart)
  if render_cluster_xml "$NODE.$CH_ZONE" "$SHARD" "$PW" | write_file /etc/clickhouse-server/config.d/cluster.xml 640 clickhouse; then
    log "cluster topology updated: $CH_SHARDS shard(s) x $CH_REPLICAS replica(s)"
  fi
  render_operations_xml | write_file /etc/clickhouse-server/config.d/operations.xml 640 clickhouse && log "operations.xml updated" || true
  render_ops_monitor_xml | write_file /etc/clickhouse-server/users.d/ops-monitor.xml 640 clickhouse && log "ops-monitor.xml updated" || true
  # Only tables that exist (i.e. are enabled in the server config) get a TTL: naming a disabled log in
  # config.d would enable it. Renamed copies (query_log_0 ...) are left alone.
  LOG_TABLES=$(chq "SELECT name FROM system.tables WHERE database = 'system' AND match(name, '^[a-z_]+_log$') AND engine LIKE '%MergeTree%'
    AND name IN (SELECT table FROM system.columns WHERE database = 'system' AND name = 'event_date') ORDER BY name")
  {
    echo '<!-- managed by the stack node-config association: system log retention -->'
    echo '<clickhouse>'
    for t in $LOG_TABLES; do echo "    <$t><ttl>event_date + INTERVAL $LOG_TTL_DAYS DAY DELETE</ttl></$t>"; done
    echo '</clickhouse>'
  } | write_file /etc/clickhouse-server/config.d/system-log-ttl.xml 644 clickhouse && log "system log TTL config updated" || true
  # apply to the existing tables right away (the config covers tables re-created after upgrades; tables too wide
  # for ALTER, e.g. metric_log on 26.x, get the TTL from the config when they are re-created at the next restart).
  # The running server still expects the TTL of the config it was started with: a log table it has not prepared yet
  # (prepared at its first flush; SYSTEM FLUSH LOGS prepares all of them), and error_log at every flush, is renamed
  # to <table>_N and re-created without the TTL when it differs. So each table is altered at most once per server
  # process (state file); otherwise every run would leave another renamed copy behind.
  ALTERED=$OPS_VAR/system-log-ttl.altered
  SERVER_PID=$(systemctl show -p MainPID --value clickhouse-server)
  chq 'SYSTEM FLUSH LOGS' >/dev/null || true
  for t in $LOG_TABLES; do
    if ! chq "SELECT engine_full FROM system.tables WHERE database = 'system' AND name = '$t'" | grep -q "TTL event_date + toIntervalDay($LOG_TTL_DAYS)"; then
      if grep -qx "$SERVER_PID $t $LOG_TTL_DAYS" "$ALTERED" 2>/dev/null; then
        continue
      fi
      echo "$SERVER_PID $t $LOG_TTL_DAYS" >> "$ALTERED"
      if chq "ALTER TABLE system.$t MODIFY TTL event_date + toIntervalDay($LOG_TTL_DAYS)" 2>/dev/null; then
        log "system.$t: TTL set to $LOG_TTL_DAYS days"
      else
        log "system.$t: ALTER not possible, TTL from config.d/system-log-ttl.xml applies after the next restart"
      fi
    fi
  done
fi

# --------------------------------------------------------------------------- monitoring: CloudWatch
install_cloudwatch() {
  rpm -q amazon-cloudwatch-agent >/dev/null 2>&1 || dnf install -y -q amazon-cloudwatch-agent
  local logs
  if [ "$ROLE" = clickhouse ]; then
    logs="{\"file_path\": \"/var/log/clickhouse-server/clickhouse-server.err.log\", \"log_group_name\": \"$LOG_GROUP\", \"log_stream_name\": \"$NODE/clickhouse-server.err.log\", \"timestamp_format\": \"%Y.%m.%d %H:%M:%S\"},"
  else
    logs="{\"file_path\": \"/var/log/clickhouse-keeper/clickhouse-keeper.err.log\", \"log_group_name\": \"$LOG_GROUP\", \"log_stream_name\": \"$NODE/clickhouse-keeper.err.log\", \"timestamp_format\": \"%Y.%m.%d %H:%M:%S\"},"
  fi
  if write_file /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json 644 <<EOF
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root", "omit_hostname": true },
  "metrics": {
    "namespace": "$METRIC_NAMESPACE",
    "metrics_collected": {
      "cpu": { "measurement": ["usage_active", "usage_iowait"], "totalcpu": true,
               "append_dimensions": { "Cluster": "$CLUSTER_ID", "Node": "$NODE" } },
      "mem": { "measurement": ["used_percent"], "append_dimensions": { "Cluster": "$CLUSTER_ID", "Node": "$NODE" } }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          $logs
          { "file_path": "/var/log/clickhouse-bootstrap.log", "log_group_name": "$LOG_GROUP", "log_stream_name": "$NODE/bootstrap.log" }
        ]
      }
    }
  }
}
EOF
  then
    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
      -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json >/dev/null
    log "CloudWatch agent configured"
  fi
  systemctl enable --now amazon-cloudwatch-agent >/dev/null 2>&1 || true

  # ClickHouse / Keeper health metrics -> CloudWatch every minute (dimensions Cluster and Cluster+Node)
  write_file "$OPS_BIN/ch-cw-metrics.sh" 755 <<'EOF' || true
#!/bin/bash
# Publishes ClickHouse / Keeper health metrics of this node to CloudWatch (run every minute by a timer).
# Counters (FailedQueries, RejectedInserts, KeeperHardwareExceptions, CPU) are published as the increase since the previous
# run (state file); ServerRestarts is 1 when the uptime went back without a version change (upgrades restart on purpose).
set -uo pipefail
. /etc/clickhouse-ops/env
STATE=/var/lib/clickhouse-ops/cw-metrics.state
declare -A PREV=()
if [ -f "$STATE" ]; then while read -r k v; do PREV[$k]=$v; done < "$STATE"; fi
declare -A NEXT=()
for k in "${!PREV[@]}"; do NEXT[$k]=${PREV[$k]}; done
DATA=()
add() {  # add <metric> <value> <unit>
  local v=${2:-0}; [[ $v =~ ^-?[0-9.]+$ ]] || v=0
  DATA+=("MetricName=$1,Value=$v,Unit=$3,Dimensions=[{Name=Cluster,Value=$CLUSTER_ID}]")
  DATA+=("MetricName=$1,Value=$v,Unit=$3,Dimensions=[{Name=Cluster,Value=$CLUSTER_ID},{Name=Node,Value=$NODE}]")
}
# increase <key> <counter>: sets INC to the increase since the previous run (empty in the first run, the whole value after
# a counter reset)
increase() {
  local cur=${2:-0} prev=${PREV[$1]:-}
  [[ $cur =~ ^[0-9]+$ ]] || cur=0
  if [ -z "$prev" ]; then INC=; elif [ "$cur" -ge "$prev" ]; then INC=$((cur - prev)); else INC=$cur; fi
  NEXT[$1]=$cur
}
pct() { df --output=pcent "$1" 2>/dev/null | tail -1 | tr -dc '0-9'; }
add DataDiskUsedPercent "$(pct /var/lib/clickhouse)" Percent
add RootDiskUsedPercent "$(pct /)" Percent
add MemoryUsedPercent "$(awk '$1 == "MemTotal:" { t = $2 } $1 == "MemAvailable:" { a = $2 } END { if (t > 0) printf "%.1f", 100 * (1 - a / t) }' /proc/meminfo)" Percent
# CPU busy (all but idle and iowait) since the previous run
read -r _ u n s idle iow irq sirq steal _ < /proc/stat
increase cpu_total $((u + n + s + idle + iow + irq + sirq + steal)); dt=$INC
increase cpu_idle $((idle + iow)); di=$INC
[ -n "$dt" ] && [ "$dt" -gt 0 ] && add CpuUsedPercent "$(awk -v t="$dt" -v i="$di" 'BEGIN { printf "%.1f", 100 * (t - i) / t }')" Percent
if [ "$ROLE" = clickhouse ]; then
  q() { timeout 20 clickhouse-client --user ops_monitor -q "$1" 2>/dev/null; }
  if [ "$(q 'SELECT 1')" = 1 ]; then
    add ServerUp 1 Count
    add MaxPartsPerPartition "$(q "SELECT value FROM system.asynchronous_metrics WHERE metric = 'MaxPartCountForPartition'")" Count
    add ReplicationQueueSize "$(q 'SELECT count() FROM system.replication_queue')" Count
    add MaxReplicaDelaySeconds "$(q 'SELECT max(absolute_delay) FROM system.replicas')" Seconds
    add ReadonlyReplicas "$(q 'SELECT count() FROM system.replicas WHERE is_readonly')" Count
    add KeeperSessionUp "$(q 'SELECT count() > 0 FROM system.zookeeper_connection')" Count
    add DelayedInserts "$(q "SELECT value FROM system.metrics WHERE metric = 'DelayedInserts'")" Count
    add DistributedFilesToInsert "$(q "SELECT value FROM system.metrics WHERE metric = 'DistributedFilesToInsert'")" Count
    add FailedMutations "$(q "SELECT count() FROM system.mutations WHERE NOT is_done AND latest_fail_reason != ''")" Count
    # system.events only lists events that happened: absent = 0
    events=$(q "SELECT event, value FROM system.events WHERE event IN ('FailedQuery', 'RejectedInserts', 'ZooKeeperHardwareExceptions')")
    for ev in FailedQuery:FailedQueries RejectedInserts:RejectedInserts ZooKeeperHardwareExceptions:KeeperHardwareExceptions; do
      increase "${ev%%:*}" "$(awk -v e="${ev%%:*}" '$1 == e { print $2 }' <<<"$events")"
      add "${ev#*:}" "${INC:-0}" Count
    done
    read -r up ver < <(q 'SELECT uptime(), version()')
    restarted=0
    if [[ ${up:-} =~ ^[0-9]+$ ]]; then
      [ -n "${PREV[uptime]:-}" ] && [ "$up" -lt "${PREV[uptime]}" ] && [ "$ver" = "${PREV[version]:-}" ] && restarted=1
      NEXT[uptime]=$up NEXT[version]=$ver
    fi
    add ServerRestarts "$restarted" Count
  else
    add ServerUp 0 Count
  fi
  if [ "$BACKUP_NODE" = true ]; then
    last=$(cat /var/lib/clickhouse-ops/backup_last_success 2>/dev/null || stat -c %Y /var/lib/clickhouse-ops/backup_installed)
    add BackupAgeHours "$(( ($(date +%s) - last) / 3600 ))" Count
  fi
else
  kc() { timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/9181; printf '%s' '$1' >&3; cat <&3" 2>/dev/null; }
  if [ "$(kc ruok)" = imok ]; then
    add KeeperUp 1 Count
    mntr=$(kc mntr)
    state=$(awk '$1 == "zk_server_state" { print $2 }' <<<"$mntr")
    add KeeperIsLeader "$([ "$state" = leader ] || [ "$state" = standalone ] && echo 1 || echo 0)" Count
    add KeeperOutstandingRequests "$(awk '$1 == "zk_outstanding_requests" { print $2 }' <<<"$mntr")" Count
    add KeeperAvgLatencyMs "$(awk '$1 == "zk_avg_latency" { print $2 }' <<<"$mntr")" Milliseconds
  else
    add KeeperUp 0 Count
  fi
fi
aws cloudwatch put-metric-data --region "$REGION" --namespace "$METRIC_NAMESPACE" --metric-data "${DATA[@]}"
for k in "${!NEXT[@]}"; do echo "$k ${NEXT[$k]}"; done > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
EOF
  unit ch-cw-metrics.service <<EOF || true
[Unit]
Description=Publish ClickHouse health metrics to CloudWatch
[Service]
Type=oneshot
ExecStart=$OPS_BIN/ch-cw-metrics.sh
EOF
  unit ch-cw-metrics.timer <<'EOF' || true
[Unit]
Description=Publish ClickHouse health metrics to CloudWatch every minute
[Timer]
OnBootSec=60
OnUnitActiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
EOF
  reload_systemd
  systemctl enable --now ch-cw-metrics.timer >/dev/null
  # publish one datapoint now, so alarms created right after this run see data instead of "missing"
  systemctl start ch-cw-metrics.service || log "WARNING: first CloudWatch metrics publish failed"
}

# --------------------------------------------------------------------------- monitoring: Prometheus -> AMP
[ "$ARCH" = aarch64 ] && GOARCH=arm64 || GOARCH=amd64
# install_release <name> <version> <github repo>: download, verify sha256, unpack to /opt/clickhouse-ops/<name>
install_release() {
  local name=$1 ver=$2 repo=$3 dir=/opt/clickhouse-ops/$1 pkg tmp
  [ -x "$dir/$name" ] && [ "$(cat "$dir/VERSION" 2>/dev/null)" = "$ver" ] && return 0
  pkg="$name-$ver.linux-$GOARCH.tar.gz"
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 -o "$tmp/$pkg" "https://github.com/$repo/releases/download/v$ver/$pkg"
  curl -fsSL --retry 5 -o "$tmp/sha256sums.txt" "https://github.com/$repo/releases/download/v$ver/sha256sums.txt"
  (cd "$tmp" && grep " $pkg\$" sha256sums.txt | sha256sum -c -)
  rm -rf "$dir" && mkdir -p "$dir"
  tar xzf "$tmp/$pkg" -C "$dir" --strip-components=1
  echo "$ver" > "$dir/VERSION"
  rm -rf "$tmp"
  log "installed $name $ver"
}
install_prometheus() {
  id chops >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin chops
  install_release node_exporter "$NODE_EXPORTER_VERSION" prometheus/node_exporter
  install_release prometheus "$PROMETHEUS_VERSION" prometheus/prometheus
  install -d -o chops -g chops "$OPS_VAR/prometheus-agent"
  local restart_node=0 restart_agent=0 health_job=''
  # ClickHouse servers: failed mutations, as a query over the default HTTP handler (same as the EKS managed scraper)
  if [ "$ROLE" = clickhouse ]; then
    health_job="
  - job_name: 'clickhouse-health'
    metrics_path: /
    params:
      user: [ops_monitor]
      query: [\"SELECT 'clickhouse_failed_mutations' AS name, toFloat64(count()) AS value, 'Unfinished mutations whose last attempt failed' AS help, 'gauge' AS type FROM system.mutations WHERE NOT is_done AND latest_fail_reason != '' FORMAT Prometheus\"]
    fallback_scrape_protocol: PrometheusText0.0.4
    static_configs:
      - targets: ['127.0.0.1:8123']"
  fi
  unit ch-node-exporter.service <<EOF && restart_node=1
[Unit]
Description=Prometheus node_exporter (host metrics)
After=network-online.target
[Service]
User=chops
ExecStart=/opt/clickhouse-ops/node_exporter/node_exporter --web.listen-address=127.0.0.1:9100 --collector.textfile.directory=$TEXTFILE_DIR
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  write_file "$OPS_ETC/prometheus.yml" 644 <<EOF && restart_agent=1
# managed by the stack node-config association
global:
  scrape_interval: 30s
  external_labels:
    cluster: '$CLUSTER_ID'
    node: '$NODE'
    role: '$ROLE'
scrape_configs:
  - job_name: '$ROLE'
    static_configs:
      - targets: ['127.0.0.1:9363']
  - job_name: 'node'
    static_configs:
      - targets: ['127.0.0.1:9100']$health_job
remote_write:
  - url: '$AMP_REMOTE_WRITE_URL'
    sigv4:
      region: '$REGION'
    queue_config:
      max_samples_per_send: 1000
      capacity: 2500
      max_shards: 20
EOF
  unit ch-prometheus-agent.service <<EOF && restart_agent=1
[Unit]
Description=Prometheus in agent mode: scrape ClickHouse/Keeper and node_exporter, remote-write to Amazon Managed Prometheus
After=network-online.target
[Service]
User=chops
ExecStart=/opt/clickhouse-ops/prometheus/prometheus --agent --config.file=$OPS_ETC/prometheus.yml --storage.agent.path=$OPS_VAR/prometheus-agent --web.listen-address=127.0.0.1:9090
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  reload_systemd
  systemctl enable ch-node-exporter ch-prometheus-agent >/dev/null 2>&1
  if [ $restart_node = 1 ] || ! systemctl is-active -q ch-node-exporter; then systemctl restart ch-node-exporter; fi
  if [ $restart_agent = 1 ] || ! systemctl is-active -q ch-prometheus-agent; then systemctl restart ch-prometheus-agent; log "Prometheus agent (re)started"; fi
}

case "$MONITORING" in
  CloudWatch)
    stop_units ch-prometheus-agent ch-node-exporter
    install_cloudwatch ;;
  Prometheus)
    stop_units amazon-cloudwatch-agent ch-cw-metrics.timer
    install_prometheus ;;
  *)
    stop_units amazon-cloudwatch-agent ch-cw-metrics.timer ch-prometheus-agent ch-node-exporter ;;
esac

# --------------------------------------------------------------------------- backups (replica 1 of each shard)
if [ "$BACKUP_NODE" = true ]; then
  # initial value of the backup-age metric = install time, so a node that never backed up alerts after a day
  if [ ! -f "$TEXTFILE_DIR/clickhouse_backup.prom" ]; then
    echo "clickhouse_backup_last_success_timestamp_seconds $(cat "$OPS_VAR/backup_installed")" > "$TEXTFILE_DIR/clickhouse_backup.prom"
    chmod 644 "$TEXTFILE_DIR/clickhouse_backup.prom"
  fi
  write_file "$OPS_BIN/ch-backup.sh" 755 <<'EOF' || true
#!/bin/bash
# ClickHouse backup of this shard to S3: full on Sundays (or when there is no full backup of the last 7 days),
# incremental (base_backup = last full) otherwise. Usage: ch-backup.sh [auto|full|incremental]
set -euo pipefail
. /etc/clickhouse-ops/env
KIND=${1:-auto}
STATE=/var/lib/clickhouse-ops
PW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" --query SecretString --output text)
# the password goes to clickhouse-client in the environment (not visible in the process list)
export CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$PW"
URL="https://$BACKUP_BUCKET.s3.$REGION.amazonaws.com/$CLUSTER_ID/shard-$SHARD"
LAST_FULL=$(cat "$STATE/backup_last_full" 2>/dev/null || true)
LAST_FULL_TS=$(cat "$STATE/backup_last_full_ts" 2>/dev/null || echo 0)
if [ "$KIND" = auto ]; then
  if [ -z "$LAST_FULL" ] || [ "$(date -u +%u)" = 7 ] || [ $(( $(date +%s) - LAST_FULL_TS )) -gt $(( 7 * 86400 )) ]; then KIND=full; else KIND=incremental; fi
fi
[ "$KIND" = incremental ] && [ -z "$LAST_FULL" ] && KIND=full
NAME="$(date -u +%Y%m%dT%H%M%SZ)-$KIND"
SQL="BACKUP ALL EXCEPT DATABASES system, information_schema, INFORMATION_SCHEMA TO S3('$URL/$NAME/')"
# 26.x: S3 from queries may use the server's (instance profile) credentials only when allowed explicitly
SETTINGS=()
[ "$(clickhouse-client -q "SELECT count() FROM system.settings WHERE name = 's3_allow_server_credentials_in_user_queries'")" = 1 ] \
  && SETTINGS+=("s3_allow_server_credentials_in_user_queries = 1")
[ "$KIND" = incremental ] && SETTINGS+=("base_backup = S3('$URL/$LAST_FULL/')")
[ ${#SETTINGS[@]} -gt 0 ] && SQL="$SQL SETTINGS $(IFS=,; echo "${SETTINGS[*]}")"
echo "starting $KIND backup $URL/$NAME/"
clickhouse-client --receive_timeout 86400 -q "$SQL"
if [ "$KIND" = full ]; then echo "$NAME" > "$STATE/backup_last_full"; date +%s > "$STATE/backup_last_full_ts"; fi
date +%s > "$STATE/backup_last_success"
echo "$NAME" > "$STATE/backup_last_name"
echo "clickhouse_backup_last_success_timestamp_seconds $(cat "$STATE/backup_last_success")" > "$TEXTFILE_DIR/clickhouse_backup.prom.tmp"
mv "$TEXTFILE_DIR/clickhouse_backup.prom.tmp" "$TEXTFILE_DIR/clickhouse_backup.prom"
echo "backup $NAME finished"
EOF
  unit ch-backup.service <<EOF || true
[Unit]
Description=ClickHouse backup to s3://$BACKUP_BUCKET/$CLUSTER_ID/shard-$SHARD
After=clickhouse-server.service
[Service]
Type=oneshot
ExecStart=$OPS_BIN/ch-backup.sh auto
EOF
  unit ch-backup.timer <<EOF || true
[Unit]
Description=Daily ClickHouse backup at $BACKUP_TIME UTC
[Timer]
OnCalendar=*-*-* $BACKUP_TIME:00 UTC
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
EOF
  reload_systemd
  systemctl enable --now ch-backup.timer >/dev/null
else
  stop_units ch-backup.timer
fi

log "node configuration complete"
