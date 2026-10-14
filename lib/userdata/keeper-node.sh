# ---- keeper-node.sh: ClickHouse Keeper node bootstrap ----
KEEPER_ID=${LOGICAL_ID#Keeper}
SELF="keeper-$KEEPER_ID.$CH_ZONE"
log "bootstrapping ClickHouse Keeper $SELF (server_id=$KEEPER_ID, version $CH_VERSION)"

install_base
mount_data_volume
install_clickhouse_packages clickhouse-keeper

mkdir -p /var/lib/clickhouse/coordination/log /var/lib/clickhouse/coordination/snapshots /var/log/clickhouse-keeper /etc/clickhouse-keeper
chown -R clickhouse:clickhouse /var/lib/clickhouse /var/log/clickhouse-keeper

RAFT=""
for k in $(seq 1 "$CH_KEEPERS"); do
  RAFT+="            <server><id>$k</id><hostname>keeper-$k.$CH_ZONE</hostname><port>9234</port></server>"$'\n'
done

cat > /etc/clickhouse-keeper/keeper_config.xml <<EOF
<clickhouse>
    <logger>
        <level>information</level>
        <log>/var/log/clickhouse-keeper/clickhouse-keeper.log</log>
        <errorlog>/var/log/clickhouse-keeper/clickhouse-keeper.err.log</errorlog>
        <size>500M</size>
        <count>5</count>
    </logger>
    <listen_host>0.0.0.0</listen_host>
    <path>/var/lib/clickhouse/coordination</path>
    <prometheus>
        <endpoint>/metrics</endpoint>
        <port>9363</port>
        <metrics>true</metrics>
        <events>true</events>
        <asynchronous_metrics>true</asynchronous_metrics>
    </prometheus>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>$KEEPER_ID</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
            <raft_logs_level>warning</raft_logs_level>
        </coordination_settings>
        <raft_configuration>
$RAFT        </raft_configuration>
    </keeper_server>
</clickhouse>
EOF
chown clickhouse:clickhouse /etc/clickhouse-keeper/keeper_config.xml

# Raft peers are addressed by DNS name; wait until every peer record exists.
for h in $(keeper_hosts); do retry 900 resolves "$h"; done

if ! systemctl cat clickhouse-keeper >/dev/null 2>&1; then
  log "clickhouse-keeper.service not shipped by package, creating it"
  cat > /etc/systemd/system/clickhouse-keeper.service <<'EOF'
[Unit]
Description=ClickHouse Keeper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=clickhouse
Group=clickhouse
Restart=always
RestartSec=5
LimitNOFILE=500000
ExecStart=/usr/bin/clickhouse-keeper --config=/etc/clickhouse-keeper/keeper_config.xml

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi
systemctl enable clickhouse-keeper
systemctl restart clickhouse-keeper

# Healthy = answers ruok and has joined a quorum (leader/follower; standalone counts for a single node).
keeper_ready() {
  [ "$(keeper_cmd 127.0.0.1 ruok)" = imok ] &&
    keeper_cmd 127.0.0.1 mntr | grep -Eq '^zk_server_state\s+(leader|follower|standalone)'
}
retry 900 keeper_ready
keeper_cmd 127.0.0.1 mntr | grep -E '^zk_(version|server_state)'
signal 0
log "keeper bootstrap complete"
