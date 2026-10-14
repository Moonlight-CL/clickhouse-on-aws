#!/bin/bash
# ClickHouse token_hub performance test. Runs on a load-generator EC2 instance in the cluster VPC.
# Usage: bench.sh <cluster-name> <secret-arn> <region> [bulk_rows]
# Output: /opt/bench/results/*.json(l), progress in /opt/bench/bench.log
set -Eeuo pipefail
CLUSTER=$1 SECRET=$2 REGION=$3 BULK_ROWS=${4:-100000000}
ZONE="$CLUSTER.clickhouse.internal"
# replica hosts: EC2 private DNS names, or e.g. the pod IPs on EKS (R1=... R2=... bench.sh ...)
R1=${R1:-"ch-s1-r1.$ZONE"} R2=${R2:-"ch-s1-r2.$ZONE"}
DIR=/opt/bench; RES=$DIR/results; DATA=$DIR/data
mkdir -p "$RES" "$DATA"
PW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET" --query SecretString --output text)
RUN=r$(date -u +%H%M%S)   # unique query_id prefix per run, so query_log stats never mix runs

log() { echo "[$(date -u +%FT%TZ)] $*"; }
ch() { local h=$1; shift; clickhouse-client --host "$h" --user default --password "$PW" "$@"; }
q() { local sql=$1; shift; ch "$R1" "$@" -q "$sql"; }
now() { date +%s.%N; }
since() { awk -v a="$(now)" -v b="$1" 'BEGIN { printf "%.3f", a - b }'; }
flush_logs() { q "SYSTEM FLUSH LOGS ON CLUSTER '{cluster}'" >/dev/null; }
wait_merges() {   # let background merges settle so tests do not interfere with each other
  local n
  for _ in $(seq 1 180); do
    n=$(q "SELECT count() FROM clusterAllReplicas('$CLUSTER', system.merges) WHERE database = 'token_hub'")
    [ "$n" = 0 ] && return 0; sleep 5
  done
}
# insert stats from query_log on both replicas for queries whose id starts with $1
insert_stats() {
  flush_logs
  q "SELECT count() AS inserts, sum(written_rows) AS written_rows, sum(written_bytes) AS written_bytes,
       quantile(0.5)(query_duration_ms) AS p50_ms, quantile(0.95)(query_duration_ms) AS p95_ms,
       quantile(0.99)(query_duration_ms) AS p99_ms, max(query_duration_ms) AS max_ms, max(memory_usage) AS max_memory
     FROM clusterAllReplicas('$CLUSTER', system.query_log)
     WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND startsWith(query_id, '$1') FORMAT JSONEachRow"
}
emit() { local r="${1%\}},\"ts\":\"$(date -u +%FT%TZ)\"}"; echo "$r" >> "$RES/results.jsonl"; log "RESULT $r"; }
rows_total() { ch "$1" -q "SELECT count() FROM token_hub.t_billing_records"; }

# replicas: wait until r2 has as many rows as r1, returns seconds waited
replication_catchup() {
  local t0 a b; t0=$(now)
  for _ in $(seq 1 720); do
    a=$(rows_total "$R1"); b=$(rows_total "$R2")
    [ "$a" = "$b" ] && break; sleep 1
  done
  echo "$(since "$t0")"
}

: > "$RES/results.jsonl"
if [ "$(q "SELECT count() FROM system.settings WHERE name = 'deduplicate_insert'")" = 1 ]; then
  DEDUP_OPTS="--deduplicate_insert disable"
else
  DEDUP_OPTS="--insert_deduplicate 0"
fi
log "insert deduplication disabled with: $DEDUP_OPTS"
log "=== reset: empty t_billing_records on both replicas"
q "TRUNCATE TABLE IF EXISTS token_hub.t_billing_records ON CLUSTER '{cluster}' SYNC" > /dev/null
log "=== environment"
q "SELECT hostName() AS host, version() AS version, getSetting('max_threads') AS max_threads FROM clusterAllReplicas('$CLUSTER', system.one) FORMAT JSONEachRow" > "$RES/env.jsonl"
ch "$R1" -q "SELECT name, value FROM system.asynchronous_metrics WHERE metric IN ('NumberOfPhysicalCPUCores','OSMemoryTotal') FORMAT JSONEachRow" >> "$RES/env.jsonl" || true

############################################################ W1 bulk server-side INSERT SELECT
log "=== W1 bulk INSERT ... SELECT, $BULK_ROWS rows in batches of 10M"
BATCH=10000000
t_all=$(now)
for i in $(seq 0 $(( BULK_ROWS / BATCH - 1 ))); do
  t0=$(now)
  q "INSERT INTO token_hub.t_billing_records SELECT * FROM bench.gen_billing_rows(start = $(( i * BATCH )), cnt = $BATCH)
     SETTINGS max_insert_threads = 8, insert_deduplicate = 0" --query_id "${RUN}_W1_$i"
  dt=$(since "$t0")
  emit "{\"test\":\"W1\",\"batch\":$i,\"rows\":$BATCH,\"seconds\":$dt}"
done
dt_all=$(since "$t_all")
lag=$(replication_catchup)
emit "{\"test\":\"W1_total\",\"rows\":$BULK_ROWS,\"seconds\":$dt_all,\"replication_catchup_s\":$lag,\"stats\":$(insert_stats "${RUN}_W1_")}"
wait_merges

############################################################ prepare client-side files (not timed)
log "=== preparing client insert files"
FILES=48 EVENT_FILES=120 FROWS=100000
for i in $(seq 0 $(( FILES - 1 ))); do
  [ -s "$DATA/rows_$i.native" ] || q "SELECT * FROM bench.gen_billing_rows(start = $(( 1000000000 + i * FROWS )), cnt = $FROWS) FORMAT Native" > "$DATA/rows_$i.native"
done
for i in $(seq 0 $(( EVENT_FILES - 1 ))); do
  [ -s "$DATA/events_$i.json" ] || q "SELECT * FROM bench.gen_billing_events(start = $(( 3000000000 + i * FROWS )), cnt = $FROWS)
    FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers = 0" > "$DATA/events_$i.json"
done
q "SELECT * FROM bench.gen_billing_rows(start = 2000000000, cnt = 1000) FORMAT Native" > "$DATA/small_1k.native"
ROWS_FILE_BYTES=$(stat -c %s "$DATA/rows_0.native"); EVENTS_FILE_BYTES=$(stat -c %s "$DATA/events_0.json")
emit "{\"test\":\"files\",\"rows_file_rows\":$FROWS,\"rows_file_bytes\":$ROWS_FILE_BYTES,\"events_file_bytes\":$EVENTS_FILE_BYTES}"

# worker <test> <conc> <file-pattern> <format> <table> <index> [extra client settings...]
# Inserts alternate between the two replicas (even index -> r1, odd -> r2), like a load-balanced writer.
# File = pattern % (index mod NFILES); query_id = <run>_<test>_c<conc>_<index>.
worker() {
  local test=$1 c=$2 pat=$3 fmt=$4 table=$5 i=$6; shift 6
  local host=$R1 f=$pat
  if (( i % 2 )); then host=$R2; fi
  if [[ $pat == *%d* ]]; then f=$(printf "$pat" "$(( i % NFILES ))"); fi
  # ClickHouse 26.x: deduplicate_insert supersedes insert_deduplicate / async_insert_deduplicate (default: enable);
  # DEDUP_OPTS is chosen at startup for the server version (word-split on purpose)
  # shellcheck disable=SC2086
  ch "$host" --query_id "${RUN}_${test}_c${c}_$i" $DEDUP_OPTS "$@" -q "INSERT INTO $table FORMAT $fmt" < "$f"
}
export -f worker ch; export PW R1 R2 RUN DEDUP_OPTS

# run_parallel <test> <conc> <inserts> <file-pattern> <format> <table> <rows-per-insert> [extra settings...]
# env: IDX0 = first insert index (default 0), NFILES = number of distinct files behind the pattern
run_parallel() {
  local test=$1 c=$2 n=$3 pat=$4 fmt=$5 table=$6 rpf=$7; shift 7
  local t0 dt before after lag i0=${IDX0:-0}
  export NFILES=${NFILES:-1}
  before=$(rows_total "$R1")
  t0=$(now)
  seq "$i0" $(( i0 + n - 1 )) | xargs -P "$c" -I{} bash -c 'worker "$@"' _ "$test" "$c" "$pat" "$fmt" "$table" {} "$@" \
    || log "WARN: some $test inserts failed"
  dt=$(since "$t0")
  lag=$(replication_catchup)
  after=$(rows_total "$R1")
  emit "{\"test\":\"$test\",\"concurrency\":$c,\"inserts\":$n,\"rows\":$(( n * rpf )),\"rows_stored\":$(( after - before )),\"seconds\":$dt,\"replication_catchup_s\":$lag,\"settings\":\"$*\",\"stats\":$(insert_stats "${RUN}_${test}_c${c}_")}"
}

############################################################ W2 client batch inserts (Native, 100k rows/insert)
# sustained runs (tens of seconds) so the EBS write path is exercised, not only the page cache
log "=== W2 client batch inserts"
export NFILES=$FILES
for cn in 1:48 4:192 8:288 16:288; do
  run_parallel W2 "${cn%%:*}" "${cn##*:}" "$DATA/rows_%d.native" Native token_hub.t_billing_records $FROWS
  wait_merges
done
log "=== W2Q batch inserts with insert_quorum=2 (synchronous replication)"
run_parallel W2Q 8 192 "$DATA/rows_%d.native" Native token_hub.t_billing_records $FROWS --insert_quorum 2
wait_merges

############################################################ W3 small inserts (1k rows/insert)
log "=== W3 small inserts: sync vs async_insert"
export NFILES=1
run_parallel W3sync 8 400 "$DATA/small_1k.native" Native token_hub.t_billing_records 1000
wait_merges
run_parallel W3async 16 1600 "$DATA/small_1k.native" Native token_hub.t_billing_records 1000 --async_insert 1 --wait_for_async_insert 1
wait_merges

############################################################ W4 MV pipeline (JSON events -> source -> MV -> t_billing_records)
# every run uses its own event files (distinct ids): 24 files at c=1, 48 at c=4 and 48 at c=8
log "=== W4 MV pipeline"
export NFILES=$EVENT_FILES
before=$(rows_total "$R1")
IDX0=0  run_parallel W4 1 24 "$DATA/events_%d.json" JSONEachRow token_hub.t_billing_events_kafka_source $FROWS; wait_merges
IDX0=24 run_parallel W4 4 48 "$DATA/events_%d.json" JSONEachRow token_hub.t_billing_events_kafka_source $FROWS; wait_merges
IDX0=72 run_parallel W4 8 48 "$DATA/events_%d.json" JSONEachRow token_hub.t_billing_events_kafka_source $FROWS; wait_merges
after=$(rows_total "$R1")
# correctness: every row produced by the MV (JSON parsing) must be identical to what the generator produced
W4_ROWS=$(( EVENT_FILES * FROWS ))
check=$(q "SELECT (SELECT count() FROM token_hub.t_billing_records WHERE id > 3000000000 AND id <= $(( 3000000000 + W4_ROWS ))) AS mv_rows,
                  (SELECT sum(cityHash64(*)) FROM token_hub.t_billing_records WHERE id > 3000000000 AND id <= $(( 3000000000 + W4_ROWS ))) AS mv_hash,
                  (SELECT sum(cityHash64(*)) FROM bench.gen_billing_rows(start = 3000000000, cnt = $W4_ROWS)) AS expected_hash,
                  mv_hash = expected_hash AS identical
           FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers = 0")
emit "{\"test\":\"W4_check\",\"rows_added\":$(( after - before )),\"check\":$check}"

############################################################ storage stats after all writes
lag=$(replication_catchup)
wait_merges
q "SELECT hostName() AS host, count() AS rows FROM clusterAllReplicas('$CLUSTER', merge('token_hub', '^t_billing_records$')) GROUP BY host FORMAT JSONEachRow" > "$RES/replica_rows.jsonl" || true
q "SELECT hostName() AS host, sum(rows) AS rows, count() AS active_parts, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed, uniqExact(partition) AS partitions
   FROM clusterAllReplicas('$CLUSTER', system.parts) WHERE database = 'token_hub' AND table = 't_billing_records' AND active GROUP BY host FORMAT JSONEachRow" > "$RES/parts.jsonl"
q "SELECT name, type, data_compressed_bytes AS compressed, data_uncompressed_bytes AS uncompressed FROM system.columns
   WHERE database = 'token_hub' AND table = 't_billing_records' ORDER BY compressed DESC FORMAT JSONEachRow" > "$RES/columns.jsonl"
q "SELECT hostName() AS host, name, free_space, total_space FROM clusterAllReplicas('$CLUSTER', system.disks) FORMAT JSONEachRow" > "$RES/disks.jsonl"
emit "{\"test\":\"final_replication_catchup\",\"seconds\":$lag}"

############################################################ R read benchmarks on t_billing_records_mv
log "=== R reads"
UIDS=$(q "SELECT user_id FROM (SELECT user_id, count() c FROM token_hub.t_billing_records WHERE created_at >= '2026-10-05' GROUP BY user_id) ORDER BY cityHash64(user_id) LIMIT 200")
ORGS=$(q "SELECT DISTINCT org_id FROM token_hub.t_billing_records WHERE org_id > 0 AND created_at >= '2026-09-01' AND created_at < '2026-09-02' ORDER BY cityHash64(org_id) LIMIT 200")
TRACES=$(q "SELECT trace_id FROM token_hub.t_billing_records WHERE id % 1000003 = 7 ORDER BY cityHash64(id) LIMIT 200")
QDIR=$DIR/queries; mkdir -p "$QDIR"; rm -f "$QDIR"/*.sql
name=""
while IFS= read -r line; do
  if [[ $line =~ ^--\ (Q[0-9]+_[a-z0-9_]+): ]]; then name=${BASH_REMATCH[1]}; continue; fi
  [[ -z $line || $line == --* || -z $name ]] && continue
  : > "$QDIR/$name.sql"
  if [[ $line == *'{uid}'* ]]; then for v in $UIDS; do echo "${line//\{uid\}/$v}" >> "$QDIR/$name.sql"; done
  elif [[ $line == *'{org}'* ]]; then for v in $ORGS; do echo "${line//\{org\}/$v}" >> "$QDIR/$name.sql"; done
  elif [[ $line == *'{trace}'* ]]; then for v in $TRACES; do echo "${line//\{trace\}/$v}" >> "$QDIR/$name.sql"; done
  else echo "$line" > "$QDIR/$name.sql"; fi
  name=""
done < "$DIR/03_read_queries.sql"

bench() {  # bench <label> <concurrency> <seconds> <query file> <hosts...>
  local label=$1 c=$2 t=$3 f=$4; shift 4
  local hosts=(); for h in "$@"; do hosts+=(--host "$h"); done
  clickhouse-benchmark "${hosts[@]}" --user default --password "$PW" -c "$c" --timelimit "$t" --randomize \
    --delay 0 < "$f" > "$RES/read_${label}_c${c}.txt" 2>&1 || true
  log "read $label c=$c done"
}
for f in "$QDIR"/*.sql; do   # warm-up: one pass of every query
  head -n 3 "$f" | while IFS= read -r sql; do q "$sql" > /dev/null; done
done
for f in "$QDIR"/*.sql; do
  label=$(basename "$f" .sql)
  for c in 1 8 32; do bench "$label" "$c" 20 "$f" "$R1"; done
done
cat "$QDIR"/Q[1-6]_*.sql "$QDIR"/Q8_*.sql > "$QDIR/mixed.sql"
bench mixed_1replica 16 60 "$QDIR/mixed.sql" "$R1"
bench mixed_2replicas 16 60 "$QDIR/mixed.sql" "$R1" "$R2"
# per-query resource usage (rows/bytes read) from query_log
flush_logs
q "SELECT normalizedQueryHash(query) AS h, any(substring(query, 1, 60)) AS q, count() AS n, avg(read_rows) AS read_rows, avg(read_bytes) AS read_bytes,
     quantile(0.5)(query_duration_ms) AS p50_ms, avg(memory_usage) AS memory
   FROM system.query_log WHERE type = 'QueryFinish' AND query_kind = 'Select' AND has(databases, 'token_hub') AND user = 'default'
     AND event_time > now() - INTERVAL 2 HOUR GROUP BY h ORDER BY n DESC LIMIT 20 FORMAT JSONEachRow" > "$RES/read_query_log.jsonl"
log "=== ALL DONE"
touch "$RES/DONE"
