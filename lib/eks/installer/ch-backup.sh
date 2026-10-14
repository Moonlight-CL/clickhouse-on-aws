#!/bin/bash
# ClickHouse backup of every shard to S3 (runs in the clickhouse-backup CronJob, one BACKUP per shard).
# BACKUP_SHARDS: space separated shards, each a comma separated list of its replicas' hosts; the backup runs on the first
# replica that succeeds (replica 1 normally). A failed shard does not stop the others; the exit code is non-zero if any
# shard has no backup. Full on Sundays or when the shard has no full backup of the last 7 days, incremental (base_backup =
# last full) otherwise. Usage: ch-backup.sh [auto|full|incremental]. State comes from system.backup_log of the backup
# host. The password comes from the CLICKHOUSE_PASSWORD environment variable (Kubernetes Secret).
set -uo pipefail
KIND_ARG=${1:-auto}
log() { echo "$(date -u +%FT%TZ) $*"; }
q() { clickhouse-client --host "$1" --user default --receive_timeout 86400 -q "$2"; }

backup_shard() {  # backup_shard <host>: BACKUP of the shard of <host>, run on <host>
  local h=$1 shard url last_full='' age='' kind name sql settings=() s3cred
  shard=$(q "$h" "SELECT getMacro('shard')") || return 1
  url="$BACKUP_URL/shard-$((shard + 1))"
  q "$h" "SYSTEM FLUSH LOGS" || return 1
  # last successful full backup of this shard: (name, age in seconds)
  read -r last_full age <<<"$(q "$h" "SELECT extract(name, '/([^/]+-full)/') AS n, dateDiff('second', max(event_time), now())
      FROM system.backup_log WHERE status = 'BACKUP_CREATED' AND n != '' AND position(name, '$url/') > 0
      GROUP BY n ORDER BY max(event_time) DESC LIMIT 1 FORMAT TSV")"
  kind=$KIND_ARG
  if [ "$kind" = auto ]; then
    if [ -z "$last_full" ] || [ "$(date -u +%u)" = 7 ] || [ "${age:-0}" -gt $((7 * 86400)) ]; then kind=full; else kind=incremental; fi
  fi
  [ "$kind" = incremental ] && [ -z "$last_full" ] && kind=full
  name="$(date -u +%Y%m%dT%H%M%SZ)-$kind"
  sql="BACKUP ALL EXCEPT DATABASES system, information_schema, INFORMATION_SCHEMA TO S3('$url/$name/')"
  # 26.x: S3 from queries may use the server's (Pod Identity) credentials only when allowed explicitly
  s3cred=$(q "$h" "SELECT count() FROM system.settings WHERE name = 's3_allow_server_credentials_in_user_queries'") || return 1
  [ "$s3cred" = 1 ] && settings+=("s3_allow_server_credentials_in_user_queries = 1")
  [ "$kind" = incremental ] && settings+=("base_backup = S3('$url/$last_full/')")
  [ ${#settings[@]} -gt 0 ] && sql="$sql SETTINGS $(IFS=,; echo "${settings[*]}")"
  log "$h: starting $kind backup $url/$name/"
  q "$h" "$sql" || return 1
  log "$h: backup $name finished"
}

rc=0 n=0
for replicas in $BACKUP_SHARDS; do
  n=$((n + 1)) ok=0
  for h in ${replicas//,/ }; do
    if backup_shard "$h"; then ok=1; break; fi
    log "$h: backup FAILED, trying the next replica of shard $n" >&2
  done
  [ $ok = 1 ] || { log "shard $n: backup FAILED on every replica ($replicas)" >&2; rc=1; }
done
exit $rc
