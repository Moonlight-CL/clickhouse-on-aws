# ---- clickhouse-node.sh: ClickHouse server node bootstrap ----
SHARD=$(sed -E 's/^ChS([0-9]+)R([0-9]+)$/\1/' <<<"$LOGICAL_ID")
REPLICA=$(sed -E 's/^ChS([0-9]+)R([0-9]+)$/\2/' <<<"$LOGICAL_ID")
SELF="ch-s$SHARD-r$REPLICA.$CH_ZONE"
log "bootstrapping ClickHouse server $SELF (shard $SHARD, replica $REPLICA, version $CH_VERSION)"

install_base
mount_data_volume
install_clickhouse_packages clickhouse-server clickhouse-client
chown -R clickhouse:clickhouse /var/lib/clickhouse

PASSWORD=$(retry 300 aws secretsmanager get-secret-value --region "$CH_REGION" --secret-id "$CH_SECRET_ARN" \
  --query SecretString --output text)
PASSWORD_SHA256=$(printf '%s' "$PASSWORD" | sha256sum | awk '{print $1}')

# config files with the password (hash) are created 0640 clickhouse:clickhouse, never world-readable
# put <path>: stdin -> path (mode 640, owner clickhouse)
put() { local tmp; tmp=$(mktemp); cat > "$tmp"; install -o clickhouse -g clickhouse -m 640 "$tmp" "$1"; rm -f "$tmp"; }
render_cluster_xml "$SELF" "$SHARD" "$PASSWORD" | put /etc/clickhouse-server/config.d/cluster.xml

put /etc/clickhouse-server/users.d/default-password.xml <<EOF
<clickhouse>
    <users>
        <default>
            <password remove="1"/>
            <password_sha256_hex>$PASSWORD_SHA256</password_sha256_hex>
            <access_management>1</access_management>
            <named_collection_control>1</named_collection_control>
        </default>
    </users>
</clickhouse>
EOF

# Operations: Prometheus endpoint, S3 credentials from the instance role, local read-only monitoring user
# (see cluster-xml.sh; node-config keeps these files up to date).
render_operations_xml | put /etc/clickhouse-server/config.d/operations.xml
render_ops_monitor_xml | put /etc/clickhouse-server/users.d/ops-monitor.xml

# Replicas/shards and Keepers are addressed by DNS name; wait for the records.
for s in $(seq 1 "$CH_SHARDS"); do
  for r in $(seq 1 "$CH_REPLICAS"); do retry 900 resolves "ch-s$s-r$r.$CH_ZONE"; done
done
for h in $(keeper_hosts); do retry 900 resolves "$h"; done

systemctl enable clickhouse-server
systemctl restart clickhouse-server

chq() { CLICKHOUSE_PASSWORD="$PASSWORD" clickhouse-client --host 127.0.0.1 --user default -q "$1"; }
# Healthy = server answers queries and can talk to the Keeper ensemble.
server_ready() { chq "SELECT 1" >/dev/null && chq "SELECT count() FROM system.zookeeper WHERE path = '/'" >/dev/null; }
retry 900 server_ready
chq "SELECT version(), getMacro('shard'), getMacro('replica')"
signal 0
log "clickhouse server bootstrap complete"
