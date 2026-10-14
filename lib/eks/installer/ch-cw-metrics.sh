#!/bin/bash
# Publishes ClickHouse / Keeper health metrics to CloudWatch every minute (ch-cw-metrics Deployment, CloudWatch mode).
# Same metric names and dimensions (Cluster, Cluster+Node) as the EC2 nodes, so the same alarms and dashboard apply.
# SERVERS / KEEPERS: space separated "<node>=<service host>" pairs.
# Counters (FailedQueries, RejectedInserts, KeeperHardwareExceptions) are published as the increase since the previous
# round; ServerRestarts is 1 when a server's uptime went back without a version change (restarts of upgrades are expected).
# Kubernetes API (service account token, RBAC of install.sh): Keeper volume usage from the kubelet of the Keeper nodes and
# the last successful run of the log TTL CronJob. Values that cannot be read are not published (alarms: missing = OK).
set -uo pipefail
q() {  # q <host> <sql>: password-less read-only monitoring user over HTTP (accepted from the VPC only)
  curl -sf --max-time 20 -H 'X-ClickHouse-User: ops_monitor' "http://$1:8123/" --data-binary "$2" 2>/dev/null
}
kc() {  # kc <host> <4lw>
  timeout 5 bash -c "exec 3<>/dev/tcp/$1/2181; printf '%s' '$2' >&3; cat <&3" 2>/dev/null
}
SA=/var/run/secrets/kubernetes.io/serviceaccount
kget() {  # kget <url>: GET with the service account token, TLS verified against the cluster CA
  curl -sf --max-time 10 --cacert "$SA/ca.crt" -H "Authorization: Bearer $(cat "$SA/token")" "$1" 2>/dev/null
}
KAPI=https://kubernetes.default.svc
NS=clickhouse
declare -A PREV=() UPTIME=() VERSION=()
while true; do
  started=$(date +%s)
  DATA=()
  add() {  # add <node> <metric> <value> <unit>
    local v=${3:-0}; [[ $v =~ ^-?[0-9.]+$ ]] || v=0
    DATA+=("MetricName=$2,Value=$v,Unit=$4,Dimensions=[{Name=Cluster,Value=$CLUSTER_ID}]")
    DATA+=("MetricName=$2,Value=$v,Unit=$4,Dimensions=[{Name=Cluster,Value=$CLUSTER_ID},{Name=Node,Value=$1}]")
  }
  # increase <key> <counter>: sets INC to the increase since the previous round (0 in the first round, the whole value
  # after a counter reset)
  increase() {
    local cur=${2:-0} prev=${PREV[$1]:-}
    [[ $cur =~ ^[0-9]+$ ]] || cur=0
    if [ -z "$prev" ]; then INC=0; elif [ "$cur" -ge "$prev" ]; then INC=$((cur - prev)); else INC=$cur; fi
    PREV[$1]=$cur
  }
  for pair in $SERVERS; do
    node=${pair%%=*} h=${pair#*=}
    if [ "$(q "$h" 'SELECT 1')" = 1 ]; then
      add "$node" ServerUp 1 Count
      add "$node" DataDiskUsedPercent "$(q "$h" "SELECT round(100 * (1 - free_space / total_space), 1) FROM system.disks WHERE name = 'default'")" Percent
      add "$node" MaxPartsPerPartition "$(q "$h" "SELECT value FROM system.asynchronous_metrics WHERE metric = 'MaxPartCountForPartition'")" Count
      add "$node" ReplicationQueueSize "$(q "$h" 'SELECT count() FROM system.replication_queue')" Count
      add "$node" MaxReplicaDelaySeconds "$(q "$h" 'SELECT max(absolute_delay) FROM system.replicas')" Seconds
      add "$node" ReadonlyReplicas "$(q "$h" 'SELECT count() FROM system.replicas WHERE is_readonly')" Count
      add "$node" KeeperSessionUp "$(q "$h" 'SELECT count() > 0 FROM system.zookeeper_connection')" Count
      add "$node" DelayedInserts "$(q "$h" "SELECT value FROM system.metrics WHERE metric = 'DelayedInserts'")" Count
      add "$node" DistributedFilesToInsert "$(q "$h" "SELECT value FROM system.metrics WHERE metric = 'DistributedFilesToInsert'")" Count
      add "$node" FailedMutations "$(q "$h" "SELECT count() FROM system.mutations WHERE NOT is_done AND latest_fail_reason != ''")" Count
      # system.events only lists events that happened: absent = 0
      events=$(q "$h" "SELECT event, value FROM system.events WHERE event IN ('FailedQuery', 'RejectedInserts', 'ZooKeeperHardwareExceptions')")
      for ev in FailedQuery:FailedQueries RejectedInserts:RejectedInserts ZooKeeperHardwareExceptions:KeeperHardwareExceptions; do
        increase "$node/${ev%%:*}" "$(awk -v e="${ev%%:*}" '$1 == e { print $2 }' <<<"$events")"
        add "$node" "${ev#*:}" "$INC" Count
      done
      read -r up ver < <(q "$h" 'SELECT uptime(), version()')
      restarted=0
      if [[ ${up:-} =~ ^[0-9]+$ ]]; then
        [ -n "${UPTIME[$node]:-}" ] && [ "$up" -lt "${UPTIME[$node]}" ] && [ "$ver" = "${VERSION[$node]}" ] && restarted=1
        UPTIME[$node]=$up VERSION[$node]=$ver
      fi
      add "$node" ServerRestarts "$restarted" Count
      if [[ " $BACKUP_HOSTS " == *" $h "* ]]; then
        last=$(q "$h" "SELECT toUnixTimestamp(maxIf(event_time, status = 'BACKUP_CREATED')) FROM system.backup_log")
        last=${last:-0}
        [[ $last =~ ^[0-9]+$ ]] && [ "$last" -gt "$INSTALL_TS" ] || last=$INSTALL_TS
        add "$node" BackupAgeHours "$(( ($(date +%s) - last) / 3600 ))" Count
      fi
    else
      add "$node" ServerUp 0 Count
    fi
  done
  # Keeper volumes: kubelet_volume_stats of the PVCs <template>-<keeper host>-0 on the Keeper nodes
  volumes=""
  for ip in $(kget "$KAPI/api/v1/namespaces/$NS/pods?labelSelector=app%3Dch-keeper" | grep -o '"hostIP":"[0-9.]*"' | cut -d'"' -f4 | sort -u); do
    volumes+=$(kget "https://$ip:10250/metrics" | grep -E '^kubelet_volume_stats_(capacity|available)_bytes\{' | grep "namespace=\"$NS\"")$'\n'
  done
  for pair in $KEEPERS; do
    node=${pair%%=*} h=${pair#*=}
    if [ "$(kc "$h" ruok)" = imok ]; then
      add "$node" KeeperUp 1 Count
      mntr=$(kc "$h" mntr)
      state=$(awk '$1 == "zk_server_state" { print $2 }' <<<"$mntr")
      add "$node" KeeperIsLeader "$([ "$state" = leader ] || [ "$state" = standalone ] && echo 1 || echo 0)" Count
      add "$node" KeeperOutstandingRequests "$(awk '$1 == "zk_outstanding_requests" { print $2 }' <<<"$mntr")" Count
      add "$node" KeeperAvgLatencyMs "$(awk '$1 == "zk_avg_latency" { print $2 }' <<<"$mntr")" Milliseconds
    else
      add "$node" KeeperUp 0 Count
    fi
    used=$(grep -E "persistentvolumeclaim=\"[^\"]*-$h(-[0-9]+)?\"" <<<"$volumes" | awk '
      $1 ~ /^kubelet_volume_stats_capacity_bytes/ { c = $2 } $1 ~ /^kubelet_volume_stats_available_bytes/ { a = $2 }
      END { if (c > 0) printf "%.1f", 100 * (1 - a / c) }')
    [ -n "$used" ] && add "$node" DataDiskUsedPercent "$used" Percent
  done
  # hours since the last successful run of the hourly log TTL CronJob (or since its creation)
  cj=$(kget "$KAPI/apis/batch/v1/namespaces/$NS/cronjobs/clickhouse-log-ttl")
  ts=$(grep -o '"lastSuccessfulTime":"[^"]*"' <<<"$cj" | cut -d'"' -f4)
  [ -n "$ts" ] || ts=$(grep -o '"creationTimestamp":"[^"]*"' <<<"$cj" | head -1 | cut -d'"' -f4)
  if [ -n "$ts" ] && ts=$(date -d "$ts" +%s 2>/dev/null); then
    DATA+=("MetricName=LogTtlJobAgeHours,Value=$(( ($(date +%s) - ts) / 3600 )),Unit=Count,Dimensions=[{Name=Cluster,Value=$CLUSTER_ID}]")
  fi
  # PutMetricData accepts up to 1000 values per call; 40 per call keeps the command line short
  for ((i = 0; i < ${#DATA[@]}; i += 40)); do
    aws cloudwatch put-metric-data --namespace "$METRIC_NAMESPACE" --metric-data "${DATA[@]:i:40}" \
      || echo "$(date -u +%FT%TZ) put-metric-data failed" >&2
  done
  sleep $(( 60 - ($(date +%s) - started) % 60 ))
done
