#!/bin/bash
# ---- install.sh: ClickHouse-on-EKS installer, run by the CodeBuild project behind the "ClusterInstall" custom resource.
# Create/Update: installs/upgrades the cluster add-ons that are Helm charts (AWS Load Balancer Controller, Altinity
# ClickHouse operator), then renders and applies the ClickHouse Keeper (waits for it) and the ClickHouse cluster and the ops
# objects, moves the pods off the nodes of replaced node groups (instance type change), and waits until every server
# answers. Delete: removes the ClickHouse resources and the load balancer first, so that no AWS resource created from inside
# Kubernetes (NLB, ENIs) outlives the stack. Data volumes are kept (Retain).
# Reports the result to CloudFormation itself (RESPONSE_URL), also on failure (EXIT trap), before DEADLINE (set by the
# trigger Lambda: the CloudFormation ServiceTimeout minus a margin). Every wait is bounded by the time left.
set -euo pipefail
cd "$(dirname "$0")"

cfg() { python3 -c 'import json,os,sys; print(json.loads(os.environ["CONFIG"])[sys.argv[1]])' "$1"; }
log() { echo "[installer $(date -u +%FT%TZ)] $*"; }
NS=clickhouse
REGION=$(cfg Region) EKS=$(cfg EksClusterName) STACK=$(cfg StackName) NAME=$(cfg ClusterName)
DATA='{}'
STATUS=FAILED REASON="installer failed, see CodeBuild log $CODEBUILD_BUILD_ID"
DEADLINE=${DEADLINE:-$(($(date +%s) + 3300))}
# unique per CloudFormation request: spec.taskID of CHK / CHI, so that the waits see the reconcile of THIS change
TASK_ID=${REQUEST_ID:-$(date +%s)}
WARNINGS=''

left() {  # left [max]: seconds until DEADLINE (at least 1), at most max
  local r=$((DEADLINE - $(date +%s)))
  [ "$r" -ge 1 ] || r=1
  [ -n "${1:-}" ] && [ "$1" -lt "$r" ] && r=$1
  echo "$r"
}
fail() { echo "$*" > /tmp/fail-reason; log "ERROR: $*"; return 1; }
warn() { log "WARNING: $*"; WARNINGS="$WARNINGS $*;"; }

respond() {
  python3 - "$STATUS" "$REASON" "$DATA" > /tmp/response.json <<'EOF'
import json, os, sys
print(json.dumps({
    "Status": sys.argv[1], "Reason": sys.argv[2][:3000], "PhysicalResourceId": os.environ["PHYSICAL_ID"],
    "StackId": os.environ["STACK_ID"], "RequestId": os.environ["REQUEST_ID"],
    "LogicalResourceId": os.environ["LOGICAL_ID"], "Data": json.loads(sys.argv[3]),
}))
EOF
  curl -sS -f -X PUT -H 'Content-Type:' --data-binary @/tmp/response.json "$RESPONSE_URL" >/dev/null \
    && touch /tmp/responded && log "reported $STATUS to CloudFormation"
}
on_exit() {
  local rc=$?
  exec 2>&1  # the stderr tee may be gone (watchdog)
  if [ -n "${WATCHDOG:-}" ]; then pkill -P "$WATCHDOG" || true; kill "$WATCHDOG" 2>/dev/null || true; fi
  if [ $rc -ne 0 ]; then
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      REASON="installer stopped at its time budget (it must answer before the CloudFormation ServiceTimeout of 3600 s; the"
      REASON="$REASON operator may still be rolling the cluster; see docs/eks-guide.md, time limits, and CodeBuild log $CODEBUILD_BUILD_ID)"
    fi
    if [ -s /tmp/fail-reason ]; then
      REASON="$REASON: $(tr '\n' ' ' < /tmp/fail-reason)"
    else
      REASON="$REASON (exit $rc): $(tail -c 1500 /tmp/last-error 2>/dev/null | tr '\n' ' ')"
    fi
    STATUS=FAILED
  elif [ -n "$WARNINGS" ]; then
    REASON="OK, with warnings:$WARNINGS"
  fi
  respond
}
trap on_exit EXIT
# keep stderr of every command for the failure reason
exec 2> >(tee /tmp/last-error >&2)
TEE_PID=$!

# at DEADLINE: stop whatever runs (a hung kubectl exec, helm, curl) so that the EXIT trap still reports to CloudFormation
start_watchdog() {
  (
    sleep "$(left)"
    echo "time budget exhausted" >&2
    for p in $(pgrep -P $$); do
      [ "$p" = "$BASHPID" ] || [ "$p" = "$TEE_PID" ] || kill -TERM "$p" 2>/dev/null || true
    done
  ) &
  WATCHDOG=$!
}

# ------------------------------------------------------------------------------------------------- tools
install_tools() {
  local arch=amd64 kver
  kver=$(curl -sSf "https://dl.k8s.io/release/stable-$(cfg KubernetesVersion).txt")
  curl -sSfLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$kver/bin/linux/$arch/kubectl"
  chmod +x /usr/local/bin/kubectl
  curl -sSfL "https://get.helm.sh/helm-$(cfg HelmVersion)-linux-$arch.tar.gz" | tar xz -C /tmp
  install /tmp/linux-$arch/helm /usr/local/bin/helm
  aws eks update-kubeconfig --region "$REGION" --name "$EKS" >/dev/null
  log "kubectl $kver, helm $(helm version --short)"
}

# ------------------------------------------------------------------------------------------------- delete
delete_all() {
  if ! aws eks describe-cluster --region "$REGION" --name "$EKS" >/dev/null 2>&1; then
    log "EKS cluster $EKS does not exist, nothing to delete"; return 0
  fi
  install_tools
  if ! kubectl get ns >/dev/null 2>&1; then
    # the stack deletion goes on (nothing can be done from here), but say what may be left behind
    warn "EKS API of $EKS not reachable from the installer: the Kubernetes objects were NOT removed. The internal NLB of the" \
      "client Service and its ENIs may remain, list them with: aws resourcegroupstaggingapi get-resources --region $REGION" \
      "--tag-filters Key=elbv2.k8s.aws/cluster,Values=$EKS"
    return 0
  fi
  # load balancer first (the controller must still be running to delete the NLB); on failure stop here, with the
  # controller still installed, so that deleting the stack again can finish the job
  if ! kubectl -n $NS delete service clickhouse-nlb --ignore-not-found --wait=true --timeout="$(left 600)s"; then
    fail "the client load balancer Service clickhouse-nlb could not be deleted, so its NLB may remain (see kubectl -n $NS" \
      "describe service clickhouse-nlb and the aws-load-balancer-controller logs in kube-system). Fix it and delete the stack" \
      "again, or delete the NLB manually and delete the stack retaining ClusterInstall."
  fi
  kubectl -n $NS delete chi --all --ignore-not-found --wait=true --timeout="$(left 1200)s" || warn "deleting the ClickHouseInstallation failed"
  kubectl -n $NS delete chk --all --ignore-not-found --wait=true --timeout="$(left 1200)s" || warn "deleting the ClickHouseKeeperInstallation failed"
  helm uninstall clickhouse-operator -n clickhouse-operator --wait --timeout "$(left 600)s" 2>/dev/null || true
  helm uninstall aws-load-balancer-controller -n kube-system --wait --timeout "$(left 600)s" 2>/dev/null || true
  # PVCs go with the namespace; their EBS volumes are kept (StorageClass reclaimPolicy Retain, tag ch-stack)
  kubectl delete namespace $NS clickhouse-operator --ignore-not-found --wait=true --timeout="$(left 900)s" || warn "deleting the namespaces failed"
  log "ClickHouse resources deleted (data volumes retained, tag ch-stack=$STACK)"
}

# ------------------------------------------------------------------------------------------------- create / update
apply() { kubectl apply --server-side --force-conflicts --field-manager=clickhouse-on-aws -f "$@"; }

chq() {  # chq <pod> <sql>: query as "default"; the password goes through stdin, never on the exec command line (EKS audit log)
  # shellcheck disable=SC2016 # expanded by the shell in the pod
  kubectl -n $NS exec -i "$1" -c clickhouse -- \
    bash -c 'read -r CLICKHOUSE_PASSWORD; export CLICKHOUSE_PASSWORD; exec clickhouse-client -q "$1" </dev/null' _ "$2" <<<"$PW"
}

retry() {  # retry <max seconds> <command...>: until the command succeeds
  local end=$(($(date +%s) + $(left "$1")))
  until "${@:2}"; do
    [ "$(date +%s)" -lt "$end" ] || return 1
    sleep 5
  done
}

itype() { if [ "$1" = keeper ]; then cfg KeeperInstanceType; else cfg ClickHouseInstanceType; fi; }
nodes() {  # nodes <keeper|server> <current|ready|old>: nodes of the role in the node groups of this stack version with the
  # configured instance type (current; ready = current and Ready), or the others (old: node groups being replaced)
  kubectl get nodes -l "clickhouse-on-aws/role=$1" -o json | python3 -c '
import json, sys
mode, groups, itype = sys.argv[1], {g.split("/")[-1] for g in sys.argv[2].split(",") if g}, sys.argv[3]
for n in json.load(sys.stdin)["items"]:
    lb = n["metadata"]["labels"]
    cur = lb.get("eks.amazonaws.com/nodegroup") in groups and lb.get("node.kubernetes.io/instance-type") == itype
    ready = any(c["type"] == "Ready" and c["status"] == "True" for c in n["status"].get("conditions", []))
    if {"current": cur, "ready": cur and ready, "old": not cur}[mode]:
        print(n["metadata"]["name"])' "$2" "$(cfg NodeGroups)" "$(itype "$1")"
}

wait_nodes() {  # every node group must be Ready before anything is scheduled on it
  local role=$1 want=$2 have=0
  while :; do
    if [ "$role" = system ]; then
      have=$(kubectl get nodes -l "clickhouse-on-aws/role=$role" --no-headers 2>/dev/null | awk '$2 == "Ready"' | wc -l)
    else
      have=$(nodes "$role" ready | wc -l)
    fi
    [ "$have" -ge "$want" ] && { log "$have/$want $role node(s) ready"; return 0; }
    [ "$(left)" -gt 10 ] || fail "only $have/$want $role node(s) ready"
    sleep 10
  done
}

# blue/green node groups: cordon the keeper / server nodes of replaced node groups (new instance type), so that pods
# restarted from now on land on the new nodes; uncordon current nodes cordoned by an earlier run (rolled back update)
prepare_nodes() {
  local role n
  for role in keeper server; do
    for n in $(nodes $role old); do
      kubectl cordon "$n" >/dev/null
      kubectl annotate --overwrite node "$n" clickhouse-on-aws/cordoned-by-installer=true >/dev/null
      log "$n: $role node of a replaced node group cordoned"
    done
    for n in $(nodes $role current); do
      [ "$(kubectl get node "$n" -o jsonpath='{.metadata.annotations.clickhouse-on-aws/cordoned-by-installer}')" = true ] || continue
      kubectl uncordon "$n" >/dev/null
      kubectl annotate node "$n" clickhouse-on-aws/cordoned-by-installer- >/dev/null
      log "$n: uncordoned"
    done
  done
}

# delete the pods still on old nodes one at a time; each comes back on a new node (same slot = AZ, its EBS volume is
# re-attached) and must be Ready and healthy before the next one goes, so the old node group is empty when CloudFormation
# deletes it
move_off_old_nodes() {  # move_off_old_nodes <keeper|server> <app label>
  local role=$1 app=$2 old p pod node
  old=" $(nodes "$role" old | tr '\n' ' ') "
  for p in $(kubectl -n $NS get pods -l "app=$app" -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}'); do
    pod=${p%%=*} node=${p#*=}
    [ -n "$node" ] && [[ $old == *" $node "* ]] || continue
    log "$pod: moving off $node (replaced node group)"
    kubectl -n $NS delete pod "$pod" --wait=true --timeout="$(left 600)s" >/dev/null
    retry 300 kubectl -n $NS get pod "$pod" >/dev/null 2>&1 || fail "$pod was not re-created"
    kubectl -n $NS wait pod "$pod" --for=condition=Ready --timeout="$(left 900)s"
    if [ "$role" = server ]; then
      retry 300 chq "$pod" "SELECT count() FROM system.zookeeper WHERE path = '/'" >/dev/null || fail "$pod does not answer after the move"
    else
      retry 300 chq "$(kubectl -n $NS get pods -l "clickhouse.altinity.com/chi=$NAME" -o jsonpath='{.items[0].metadata.name}')" \
        "SELECT count() FROM system.zookeeper WHERE path = '/'" >/dev/null || fail "Keeper has no quorum after moving $pod"
    fi
    log "$pod: running on $(kubectl -n $NS get pod "$pod" -o jsonpath='{.spec.nodeName}')"
  done
}

wait_task() {  # wait_task <chk|chi> <name>: until the operator completed the reconcile of THIS run (spec.taskID)
  local kind=$1 name=$2 st
  log "waiting for $kind/$name (task $TASK_ID)"
  while :; do
    st=$(kubectl -n $NS get "$kind/$name" -o jsonpath='{.status.status}|{.status.taskID}|{.status.taskIDsCompleted}' 2>/dev/null || true)
    if [ "${st%%|*}" = Aborted ] && [[ $st == *"|$TASK_ID|"* || $st == *"\"$TASK_ID\""* ]]; then
      fail "the operator aborted the reconcile of $kind/$name: $(kubectl -n $NS get "$kind/$name" -o jsonpath='{.status.errors}')"
    fi
    if [[ ${st##*|} == *"\"$TASK_ID\""* ]]; then
      log "$kind/$name: task $TASK_ID completed (status ${st%%|*})"; return 0
    fi
    [ "$(left)" -gt 10 ] || fail "$kind/$name: the operator did not complete task $TASK_ID in time (status ${st%%|*})"
    sleep 10
  done
}

# online changes of existing data volumes: size (expansion) and IOPS/throughput (VolumeAttributesClass), one patch per PVC
# (the EBS CSI driver merges both into one ModifyVolume). EBS accepts one modification per volume every 6 hours: a change
# right after another one is not applied by AWS until then, which is reported as a warning (the CSI driver retries).
update_volumes() {
  local vac=$1 size pvc cur grow parts both='' changed=() pending=() deadline
  size="$(cfg DataVolumeSize)Gi"
  for pvc in $(kubectl -n $NS get pvc -l "clickhouse.altinity.com/chi=$NAME" -o name); do
    cur=$(kubectl -n $NS get "$pvc" -o jsonpath='{.spec.resources.requests.storage} {.spec.volumeAttributesClassName}')
    grow=$(python3 -c 'import sys; u={"Gi":1,"Ti":1024}; f=lambda v: float(v[:-2])*u[v[-2:]]; print(int(f(sys.argv[1]) < f(sys.argv[2])))' "${cur%% *}" "$size")
    parts=()
    [ "${cur#* }" = "$vac" ] || parts+=("\"volumeAttributesClassName\":\"$vac\"")
    [ "$grow" = 1 ] && parts+=("\"resources\":{\"requests\":{\"storage\":\"$size\"}}")
    [ ${#parts[@]} -gt 0 ] || continue
    [ ${#parts[@]} -eq 2 ] && both="$both ${pvc#*/}"
    kubectl -n $NS patch "$pvc" --type merge -p "{\"spec\":{$(IFS=,; echo "${parts[*]}")}}" >/dev/null
    log "$pvc: ${cur%% *} ${cur#* } -> $size $vac"
    changed+=("$pvc")
  done
  [ ${#changed[@]} -gt 0 ] || return 0
  [ -z "$both" ] || warn "size and IOPS/throughput of the data volumes changed in one update ($both): EBS allows one" \
    "modification per volume every 6 hours, check that both took effect (aws ec2 describe-volumes-modifications)"
  deadline=$(($(date +%s) + $(left 300)))
  while :; do
    pending=()
    for pvc in "${changed[@]}"; do
      python3 -c 'import sys; u={"Gi":1,"Ti":1024}; f=lambda v: float(v[:-2])*u[v[-2:]] if v[-2:] in u else float(v or 0)/2**30; c, a = sys.argv[1].split(" ", 1); sys.exit(0 if f(c) >= f(sys.argv[2]) and a == sys.argv[3] else 1)' \
        "$(kubectl -n $NS get "$pvc" -o jsonpath='{.status.capacity.storage} {.status.currentVolumeAttributesClassName}')" "$size" "$vac" \
        || pending+=("$pvc")
    done
    [ ${#pending[@]} -gt 0 ] || { log "data volumes: $size, $vac"; return 0; }
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 15
  done
  for pvc in "${pending[@]}"; do
    warn "$pvc: modification not finished: $(kubectl -n $NS get "$pvc" -o jsonpath='capacity {.status.capacity.storage}, class {.status.currentVolumeAttributesClassName}, {.status.modifyVolumeStatus}') $(kubectl -n $NS get events --field-selector "involvedObject.name=${pvc#*/}" -o jsonpath='{range .items[-2:]}{.reason}: {.message} {end}' | tr '\n' ' ')"
  done
}

install_all() {
  install_tools
  local shards replicas keepers servers
  shards=$(cfg ShardCount) replicas=$(cfg ReplicaCount) keepers=$(cfg KeeperCount)
  servers=$((shards * replicas))
  wait_nodes system 1
  wait_nodes keeper "$keepers"
  wait_nodes server "$servers"

  # namespace, credentials (from files, not command line arguments), service accounts (EKS Pod Identity associations exist
  # for these names), ops scripts
  kubectl create namespace $NS --dry-run=client -o yaml | apply -
  PW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$(cfg AdminSecretArn)" --query SecretString --output text)
  kubectl -n $NS create secret generic clickhouse-admin --from-file=password=<(printf %s "$PW") --dry-run=client -o yaml | apply -
  for sa in clickhouse ch-cw-metrics; do kubectl -n $NS create serviceaccount $sa --dry-run=client -o yaml | apply -; done
  # ch-cw-metrics (CloudWatch mode) reads the log TTL CronJob status, finds the Keeper nodes (pods) and reads the Keeper
  # volume usage from their kubelet (/metrics: nodes/metrics only, no nodes/proxy)
  apply - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: ch-cw-metrics, namespace: $NS}
rules:
  - {apiGroups: [""], resources: [pods], verbs: [get, list]}
  - {apiGroups: [batch], resources: [cronjobs], verbs: [get]}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: ch-cw-metrics, namespace: $NS}
subjects: [{kind: ServiceAccount, name: ch-cw-metrics, namespace: $NS}]
roleRef: {kind: Role, name: ch-cw-metrics, apiGroup: rbac.authorization.k8s.io}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: ch-cw-metrics}
rules:
  - {apiGroups: [""], resources: [nodes/metrics], verbs: [get]}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: ch-cw-metrics}
subjects: [{kind: ServiceAccount, name: ch-cw-metrics, namespace: $NS}]
roleRef: {kind: ClusterRole, name: ch-cw-metrics, apiGroup: rbac.authorization.k8s.io}
EOF
  kubectl -n $NS create configmap clickhouse-ops --from-file=ch-backup.sh --from-file=ch-log-ttl.sh --from-file=ch-cw-metrics.sh \
    --dry-run=client -o yaml | apply -

  # storage: encrypted gp3, kept when the PVC is deleted, bound in the pod's AZ, online expansion;
  # data volume IOPS/throughput via a VolumeAttributesClass (changed online by patching the PVCs)
  local iops thr vac
  iops=$(cfg DataVolumeIops) thr=$(cfg DataVolumeThroughput) vac="ch-data-${iops}-${thr}"
  apply - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: ch-gp3}
provisioner: ebs.csi.aws.com
parameters: {type: gp3, encrypted: "true", csi.storage.k8s.io/fstype: xfs, tagSpecification_1: "ch-stack=$STACK"}
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
---
apiVersion: storage.k8s.io/v1
kind: VolumeAttributesClass
metadata: {name: $vac}
driverName: ebs.csi.aws.com
parameters: {iops: "$iops", throughput: "$thr"}
EOF

  # AWS Load Balancer Controller (internal NLB for clients), credentials via EKS Pod Identity
  if [ "$(cfg ClientLoadBalancer)" = true ]; then
    helm upgrade --install aws-load-balancer-controller aws-load-balancer-controller \
      --repo https://aws.github.io/eks-charts --version "$(cfg LbcChartVersion)" -n kube-system \
      --set clusterName="$EKS" --set region="$REGION" --set vpcId="$(cfg VpcId)" \
      --set serviceAccount.name=aws-load-balancer-controller \
      --set nodeSelector.clickhouse-on-aws/role=system --wait --timeout "$(left 600)s"
  else
    kubectl -n $NS delete service clickhouse-nlb --ignore-not-found --wait=true --timeout="$(left 600)s"
    helm uninstall aws-load-balancer-controller -n kube-system --wait --timeout "$(left 600)s" 2>/dev/null || true
  fi

  # Altinity ClickHouse operator (CRDs: ClickHouseInstallation, ClickHouseKeeperInstallation); its password as a values file
  local opw
  opw=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$(cfg OperatorSecretArn)" --query SecretString --output text)
  helm upgrade --install clickhouse-operator altinity-clickhouse-operator \
    --repo https://helm.altinity.com --version "$(cfg OperatorChartVersion)" -n clickhouse-operator --create-namespace \
    -f <(printf 'secret:\n  password: "%s"\n' "$opw") \
    --set nodeSelector.clickhouse-on-aws/role=system --set 'watchNamespaces={clickhouse}' --wait --timeout "$(left 600)s"

  prepare_nodes

  # facts for the renderer ('auto' resources from the nodes of the current node groups only)
  local install_ts facts
  install_ts=$(kubectl -n $NS get configmap clickhouse-install -o jsonpath='{.data.install_ts}' 2>/dev/null || true)
  if [ -z "$install_ts" ]; then
    install_ts=$(date +%s)
    kubectl -n $NS create configmap clickhouse-install --from-literal=install_ts="$install_ts"
  fi
  # the node list as a file: as an argument it exceeds the kernel's per-argument limit (128 KiB) from about 10 nodes
  kubectl get nodes -o json > /tmp/nodes.json
  facts=$(python3 - "$install_ts" "$vac" "$TASK_ID" /tmp/nodes.json "$(nodes keeper ready | tr '\n' ' ')" \
    "$(nodes server ready | tr '\n' ' ')" \
    "$(aws ec2 describe-vpcs --region "$REGION" --vpc-ids "$(cfg VpcId)" --query 'Vpcs[0].CidrBlockAssociationSet[].CidrBlock' --output json)" <<'EOF'
import json, sys
install_ts, vac, task_id, nodes, cidrs = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4])), json.loads(sys.argv[7])
current = {"keeper": set(sys.argv[5].split()), "server": set(sys.argv[6].split())}
def qty_m(v): return int(float(v[:-1])) if v.endswith("m") else int(float(v) * 1000)
def qty_mi(v):
    units = {"Ki": 1 / 1024, "Mi": 1, "Gi": 1024, "Ti": 1024 * 1024}
    for u, f in units.items():
        if v.endswith(u): return int(float(v[:-2]) * f)
    return int(int(v) / 1024 / 1024)
alloc = {}
for n in nodes["items"]:
    role = n["metadata"]["labels"].get("clickhouse-on-aws/role")
    if role not in current or n["metadata"]["name"] not in current[role]:
        continue
    a = n["status"]["allocatable"]
    cur = {"cpu_m": qty_m(a["cpu"]), "mem_mi": qty_mi(a["memory"])}
    prev = alloc.get(role, cur)
    alloc[role] = {k: min(prev[k], cur[k]) for k in cur}
print(json.dumps({"install_ts": int(install_ts), "data_vac": vac, "task_id": task_id, "allocatable": alloc, "vpc_cidrs": cidrs}))
EOF
)
  log "facts: $facts"
  python3 render.py "$facts" > /tmp/manifests.json
  python3 - <<'EOF'
import json
m = json.load(open("/tmp/manifests.json"))
for f, keeper in (("/tmp/keeper.json", True), ("/tmp/cluster.json", False)):
    json.dump({**m, "items": [i for i in m["items"] if (i["kind"] == "ClickHouseKeeperInstallation") == keeper]}, open(f, "w"))
EOF

  # Keeper first: the operator rolls it one host at a time (PodDisruptionBudget); then the ClickHouse cluster
  apply /tmp/keeper.json
  wait_task chk keeper
  kubectl -n $NS wait pod -l app=ch-keeper --for=condition=Ready --timeout="$(left 900)s"
  apply /tmp/cluster.json
  wait_task chi "$NAME"
  kubectl -n $NS wait pod -l "clickhouse.altinity.com/chi=$NAME" --for=condition=Ready --timeout="$(left 900)s"
  local errors
  errors=$(kubectl -n $NS get "chi/$NAME" -o jsonpath='{.status.errors}')
  [ -z "$errors" ] || [ "$errors" = '[]' ] || log "operator reported: $errors"
  # pods the operator did not restart (resources unchanged) are still on nodes of replaced node groups
  move_off_old_nodes keeper ch-keeper
  move_off_old_nodes server ch-server

  # objects of disabled features (and the secret of the former ops_monitor password)
  [ "$(cfg Monitoring)" = CloudWatch ] || kubectl -n $NS delete deployment ch-cw-metrics --ignore-not-found
  [ "$(cfg EnableBackup)" = true ] || kubectl -n $NS delete cronjob clickhouse-backup --ignore-not-found
  kubectl -n $NS delete secret clickhouse-ops-monitor --ignore-not-found >/dev/null
  if [ "$(cfg Monitoring)" = Prometheus ]; then
    # Amazon Managed Service for Prometheus managed scraper: its access entry maps to this user
    apply - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: aps-collector-role}
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods, ingresses, configmaps]
    verbs: [describe, get, list, watch]
  - apiGroups: [extensions, networking.k8s.io]
    resources: [ingresses/status, ingresses]
    verbs: [describe, get, list, watch]
  - nonResourceURLs: [/metrics]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: aps-collector-user-role-binding}
subjects: [{kind: User, name: aps-collector-user, apiGroup: rbac.authorization.k8s.io}]
roleRef: {kind: ClusterRole, name: aps-collector-role, apiGroup: rbac.authorization.k8s.io}
EOF
  fi

  update_volumes "$vac"

  # health: every server answers, sees Keeper and the expected cluster topology
  local h
  for h in $(kubectl -n $NS get pods -l "clickhouse.altinity.com/chi=$NAME" -o name); do
    chq "$h" "SYSTEM FLUSH LOGS"
    chq "$h" "SELECT hostName(), version(), (SELECT count() FROM system.zookeeper WHERE path = '/'), (SELECT count() FROM system.clusters WHERE cluster = '$NAME') FORMAT TSV"
  done
  # every server must see the whole cluster (remote_servers reaches the first hosts a little later)
  local got h0 ok end
  end=$(($(date +%s) + $(left 300)))
  while :; do
    ok=1
    for h0 in $(kubectl -n $NS get pods -l "clickhouse.altinity.com/chi=$NAME" -o name); do
      got=$(chq "$h0" "SELECT count() FROM clusterAllReplicas('$NAME', system.one)" 2>/dev/null || echo 0)
      [ "$got" = "$servers" ] || ok=0
    done
    [ $ok = 1 ] || [ "$(date +%s)" -ge "$end" ] && break
    sleep 10
  done
  [ $ok = 1 ] || fail "not every server sees $servers servers in cluster $NAME"
  kubectl -n $NS create job "log-ttl-$(date +%s)" --from=cronjob/clickhouse-log-ttl >/dev/null || true

  local endpoint="clickhouse-$NAME.$NS.svc.cluster.local"
  if [ "$(cfg ClientLoadBalancer)" = true ]; then
    end=$(($(date +%s) + $(left 600)))
    while :; do
      endpoint=$(kubectl -n $NS get service clickhouse-nlb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
      [ -n "$endpoint" ] || [ "$(date +%s)" -ge "$end" ] && break
      sleep 10
    done
    [ -n "$endpoint" ] || fail "the client load balancer (Service clickhouse-nlb) got no address"
  fi
  DATA=$(python3 -c 'import json,sys; print(json.dumps({"Endpoint": sys.argv[1]}))' "$endpoint")
  log "ClickHouse cluster $NAME ready: $servers server(s), endpoint $endpoint"
}

log "request: $REQUEST_TYPE"
if [ "${1:-}" = report-failure ]; then exit 1; fi
log "deadline $(date -u -d "@$DEADLINE" +%FT%TZ) ($(left) s left), task $TASK_ID"
start_watchdog
if [ "$REQUEST_TYPE" = Delete ]; then delete_all; else install_all; fi
STATUS=SUCCESS REASON=OK
