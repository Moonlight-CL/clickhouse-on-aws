#!/bin/bash
# EKS variant of fetch-metrics.sh: cluster metadata and CloudWatch metrics (EC2 CPU, EBS data-volume I/O) of the
# ClickHouse / Keeper nodes of a clickhouse-eks stack, in the same files and format the report expects.
# Nodes are found by their managed node group (ServerNodeGroupN -> replica N of shard 1, KeeperNodeGroupN -> keeper N);
# the data volume is the EBS volume of the node's data PVC (reported as device /dev/sdb).
# Usage: perf/fetch-metrics-eks.sh <stack-name> <start-iso> <end-iso> <out-dir>
set -euo pipefail
STACK=$1 START=$2 END=$3 OUT=$4
mkdir -p "$OUT"

aws ec2 describe-instances --filters "Name=tag:ch-stack,Values=$STACK" Name=instance-state-name,Values=running \
  --query "Reservations[].Instances[].{id:InstanceId,type:InstanceType,az:Placement.AvailabilityZone,arch:Architecture,ip:PrivateIpAddress,
           name:Tags[?Key=='Name']|[0].Value,nodegroup:Tags[?Key=='eks:nodegroup-name']|[0].Value,
           volumes:BlockDeviceMappings[].{device:DeviceName,id:Ebs.VolumeId}}" --output json > "$OUT/.instances.json"
node -e '
const { resolve } = require("path");
const inst = require(resolve(process.argv[1]));
for (const i of inst) {
  const m = /^(Server|Keeper)NodeGroup(\d)/.exec(i.nodegroup || "");
  i.role = m ? (m[1] === "Server" ? `ChS1R${m[2]}` : `Keeper${m[2]}`) : "System";
}
console.log(JSON.stringify(inst, null, 1));' "$OUT/.instances.json" > "$OUT/instances.json"
rm -f "$OUT/.instances.json"

IDS=$(node -e 'console.log(require(require("path").resolve(process.argv[1])).map(i=>i.id).join(","))' "$OUT/instances.json")
aws ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$IDS" \
  --query "Volumes[].{id:VolumeId,size:Size,type:VolumeType,iops:Iops,throughput:Throughput,encrypted:Encrypted,instance:Attachments[0].InstanceId,device:Attachments[0].Device,pvc:Tags[?Key=='kubernetes.io/created-for/pvc/name']|[0].Value}" \
  --output json | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const vols = JSON.parse(s);
  for (const v of vols) if (v.pvc) { v.k8sDevice = v.device; v.device = "/dev/sdb"; }  // PVC volume = data volume
  console.log(JSON.stringify(vols, null, 1));
});' > "$OUT/volumes.json"
aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Parameters" --output json > "$OUT/stack-parameters.json"

node -e '
const { resolve } = require("path");
const inst = require(resolve(process.argv[1])), vols = require(resolve(process.argv[2]));
const q = [];
const ch = inst.filter(i => /^ChS/.test(i.role));
ch.forEach((i, n) => q.push({ Id: `cpu${n}`, Label: `cpu ${i.role}`,
  MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: i.id }] }, Period: 60, Stat: "Average" } }));
ch.forEach((i, n) => {
  const v = vols.find(v => v.instance === i.id && v.device === "/dev/sdb");
  for (const [k, m] of [["wb", "VolumeWriteBytes"], ["rb", "VolumeReadBytes"], ["wo", "VolumeWriteOps"], ["ro", "VolumeReadOps"]]) {
    q.push({ Id: `${k}${n}`, Label: `${m} ${i.role}`,
      MetricStat: { Metric: { Namespace: "AWS/EBS", MetricName: m, Dimensions: [{ Name: "VolumeId", Value: v.id }] }, Period: 60, Stat: "Sum" } });
  }
});
console.log(JSON.stringify(q));' "$OUT/instances.json" "$OUT/volumes.json" > "$OUT/.queries.json"
aws cloudwatch get-metric-data --start-time "$START" --end-time "$END" --metric-data-queries "file://$OUT/.queries.json" \
  --scan-by TimestampAscending --output json > "$OUT/cloudwatch.json"
rm -f "$OUT/.queries.json"
echo "metrics written to $OUT"
