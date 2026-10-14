# ---- cluster-xml.sh: renders the stack-managed ClickHouse server config files ----
# Shared by the boot script and the day-2 node-config association (embedded in its SSM document, so running nodes
# always get the current template's version). node-config re-renders cluster.xml when ShardCount / ReplicaCount
# change, so existing nodes learn about added replicas/shards; ClickHouse reloads these files without restart.
# render_cluster_xml <self-fqdn> <shard> <password>; env: CH_CLUSTER CH_ZONE CH_SHARDS CH_REPLICAS CH_KEEPERS
render_cluster_xml() {
  local self=$1 shard=$2 password=$3 s r k
  echo '<clickhouse>'
  echo '    <listen_host>0.0.0.0</listen_host>'
  echo "    <interserver_http_host>$self</interserver_http_host>"
  echo '    <remote_servers replace="true">'
  echo "        <$CH_CLUSTER>"
  for s in $(seq 1 "$CH_SHARDS"); do
    echo '            <shard>'
    echo '                <internal_replication>true</internal_replication>'
    for r in $(seq 1 "$CH_REPLICAS"); do
      echo "                <replica><host>ch-s$s-r$r.$CH_ZONE</host><port>9000</port><user>default</user><password>$password</password></replica>"
    done
    echo '            </shard>'
  done
  echo "        </$CH_CLUSTER>"
  echo '    </remote_servers>'
  echo '    <zookeeper>'
  for k in $(seq 1 "$CH_KEEPERS"); do echo "        <node><host>keeper-$k.$CH_ZONE</host><port>9181</port></node>"; done
  echo '    </zookeeper>'
  echo '    <macros>'
  echo "        <cluster>$CH_CLUSTER</cluster>"
  echo "        <shard>$(printf '%02d' "$shard")</shard>"
  echo "        <replica>$self</replica>"
  echo '    </macros>'
  echo '    <distributed_ddl>'
  echo '        <path>/clickhouse/task_queue/ddl</path>'
  echo '    </distributed_ddl>'
  echo '</clickhouse>'
}

# config.d/operations.xml: Prometheus endpoint on 9363 (not opened in the security group; scraped locally by the
# monitoring agent) and S3 credentials from the instance role (for BACKUP/RESTORE to S3).
render_operations_xml() {
  cat <<'EOF'
<clickhouse>
    <prometheus>
        <endpoint>/metrics</endpoint>
        <port>9363</port>
        <metrics>true</metrics>
        <events>true</events>
        <asynchronous_metrics>true</asynchronous_metrics>
    </prometheus>
    <s3>
        <use_environment_credentials>true</use_environment_credentials>
    </s3>
</clickhouse>
EOF
}

# users.d/ops-monitor.xml: password-less read-only user that only works from localhost (local metrics publisher).
render_ops_monitor_xml() {
  cat <<'EOF'
<clickhouse>
    <users>
        <ops_monitor>
            <no_password/>
            <networks>
                <ip>127.0.0.1</ip>
                <ip>::1</ip>
            </networks>
            <profile>readonly</profile>
            <quota>default</quota>
        </ops_monitor>
    </users>
</clickhouse>
EOF
}
