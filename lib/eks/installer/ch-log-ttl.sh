#!/bin/bash
# Applies the system log retention (TTL) to the system.*_log tables of every ClickHouse server (hourly CronJob).
# Only existing tables with an event_date column are touched (they are created on first use and re-created by
# upgrades); metric_log gets its TTL from the server config (too wide for ALTER). The password comes from the
# CLICKHOUSE_PASSWORD environment variable (Kubernetes Secret), never from the command line.
set -uo pipefail
rc=0
for h in $CH_HOSTS; do
  q() { clickhouse-client --host "$h" --user default -q "$1"; }
  # creates log tables that have no rows yet (system.backup_log feeds the backup-age metric)
  q "SYSTEM FLUSH LOGS" || rc=1
  tables=$(q "SELECT name FROM system.tables WHERE database = 'system' AND match(name, '^[a-z_]+_log$') AND name != 'metric_log'
      AND engine LIKE '%MergeTree%' AND position(engine_full, 'TTL event_date + toIntervalDay($LOG_TTL_DAYS)') = 0
      AND name IN (SELECT table FROM system.columns WHERE database = 'system' AND name = 'event_date')") || { rc=1; continue; }
  for t in $tables; do
    if q "ALTER TABLE system.$t MODIFY TTL event_date + toIntervalDay($LOG_TTL_DAYS)"; then
      echo "$h: system.$t TTL set to $LOG_TTL_DAYS days"
    else
      rc=1
    fi
  done
done
exit $rc
