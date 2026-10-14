# ---- common.sh: shared helpers for ClickHouse / Keeper bootstrap ----
# Expects CH_STACK, CH_REGION and CH_CONFIG_PARAM (exported by the launch-template header). The cluster settings
# (CH_VERSION CH_CLUSTER CH_ZONE CH_SHARDS CH_REPLICAS CH_KEEPERS CH_SECRET_ARN) come from the stack-managed SSM
# parameter CH_CONFIG_PARAM, read at boot: the launch template itself never changes when they change, so stack
# updates never replace running nodes, while nodes created later always get the current settings.
set -Eeuo pipefail
exec > >(tee -a /var/log/clickhouse-bootstrap.log | logger -t clickhouse-bootstrap) 2>&1

log() { echo "[$(date -u +%FT%TZ)] $*" >&2; }

IMDS=http://169.254.169.254/latest
imds_token() { curl -fsS -X PUT "$IMDS/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600'; }
TOKEN=$(imds_token)
imds() { curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/meta-data/$1"; }
tag() { imds "tags/instance/$1"; }

LOGICAL_ID=$(tag ch-logical-id)
SIGNALLED=0
# The instance signals the WaitCondition <logical-id>Ready, which CloudFormation creates after the separate
# EBS data volume is attached. A successful bootstrap leaves /etc/clickhouse-bootstrap.done for day-2 tooling.
signal() {
  [ "$SIGNALLED" = 1 ] && return 0
  SIGNALLED=1
  [ "$1" = 0 ] && date -u +%FT%TZ > /etc/clickhouse-bootstrap.done
  log "cfn-signal exit=$1 resource=${LOGICAL_ID}Ready"
  if [ -x /opt/aws/bin/cfn-signal ]; then
    /opt/aws/bin/cfn-signal -e "$1" --stack "$CH_STACK" --resource "${LOGICAL_ID}Ready" --region "$CH_REGION" \
      --reason "clickhouse bootstrap exit $1 (see /var/log/clickhouse-bootstrap.log)" || true
  else
    # failed before aws-cfn-bootstrap was installed: signal with the AWS CLI of the AMI
    aws cloudformation signal-resource --region "$CH_REGION" --stack-name "$CH_STACK" --logical-resource-id "${LOGICAL_ID}Ready" \
      --unique-id "$(imds instance-id)" --status "$([ "$1" = 0 ] && echo SUCCESS || echo FAILURE)" || true
  fi
}
# shellcheck disable=SC2154  # rc is assigned inside the trap string
trap 'rc=$?; log "FAILED at line $LINENO (rc=$rc)"; signal 1' ERR

CH_CONFIG=
for _ in $(seq 1 30); do
  # (no ERR trap in the substitution: a transient failure must not signal the WaitCondition)
  CH_CONFIG=$(trap - ERR; aws ssm get-parameter --region "$CH_REGION" --name "$CH_CONFIG_PARAM" --query Parameter.Value --output text) && break
  sleep 10
done
if [ -z "$CH_CONFIG" ]; then log "cannot read the cluster settings from SSM parameter $CH_CONFIG_PARAM"; signal 1; exit 1; fi
eval "$CH_CONFIG"
export CH_VERSION CH_CLUSTER CH_ZONE CH_SHARDS CH_REPLICAS CH_KEEPERS CH_SECRET_ARN

# retry <seconds> <cmd...>: retry every 5s until success or timeout.
retry() {
  local timeout=$1; shift
  local deadline=$(( $(date +%s) + timeout ))
  until "$@"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then log "timeout waiting for: $*"; return 1; fi
    sleep 5
  done
}

# shellcheck disable=SC2034  # used by install_clickhouse_packages (node-lib.sh, concatenated after this file)
ARCH=$(uname -m)   # aarch64 | x86_64

install_base() {
  log "installing base packages"
  retry 300 dnf install -y -q aws-cfn-bootstrap xfsprogs
}

# Format (only if blank) and mount the separate EBS data volume on /var/lib/clickhouse. The volume is a
# stack resource attached after the instance starts, so wait for it. An existing filesystem (e.g. a volume
# restored from a snapshot) is kept as is.
mount_data_volume() {
  local root_disk dev=""
  root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
  # shellcheck disable=SC2329  # invoked through retry
  find_disk() {
    dev=$(lsblk -dpno NAME,TYPE | awk '$2=="disk"{print $1}' | grep -v "/dev/${root_disk}\$" | head -n1)
    [ -n "$dev" ]
  }
  retry 900 find_disk
  log "data disk: $dev"
  if ! blkid "$dev" >/dev/null 2>&1; then
    mkfs.xfs -f "$dev"
  fi
  mkdir -p /var/lib/clickhouse
  local uuid
  uuid=$(blkid -s UUID -o value "$dev")
  grep -q "$uuid" /etc/fstab || echo "UUID=$uuid /var/lib/clickhouse xfs defaults,noatime,nofail 0 2" >> /etc/fstab
  mount -a
  findmnt /var/lib/clickhouse
  install_data_volume_dropins >/dev/null
  systemctl daemon-reload
}

resolves() { getent hosts "$1" >/dev/null; }

keeper_hosts() {
  local k
  for k in $(seq 1 "$CH_KEEPERS"); do echo "keeper-$k.$CH_ZONE"; done
}

# Send a 4-letter-word command to a Keeper and print the reply.
keeper_cmd() {
  local host=$1 cmd=$2
  timeout 5 bash -c "exec 3<>/dev/tcp/$host/9181; printf '%s' '$cmd' >&3; cat <&3" 2>/dev/null
}
