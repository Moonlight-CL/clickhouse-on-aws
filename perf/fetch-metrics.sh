#!/bin/bash
# Collect cluster metadata and CloudWatch metrics (EC2 CPU, EBS data-volume I/O) for the performance report.
# Usage: perf/fetch-metrics.sh <stack-name> <start-iso> <end-iso> <out-dir>
set -euo pipefail
STACK=$1 START=$2 END=$3 OUT=$4
mkdir -p "$OUT"

aws ec2 describe-instances --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK" Name=instance-state-name,Values=running \
  --query "Reservations[].Instances[].{id:InstanceId,type:InstanceType,az:Placement.AvailabilityZone,arch:Architecture,ip:PrivateIpAddress,
           name:Tags[?Key=='Name']|[0].Value,role:Tags[?Key=='ch-logical-id']|[0].Value,
           volumes:BlockDeviceMappings[].{device:DeviceName,id:Ebs.VolumeId}}" --output json > "$OUT/instances.json"
VOL_IDS=$(node -e 'const i=require(require("path").resolve(process.argv[1]));console.log(i.flatMap(x=>x.volumes.map(v=>v.id)).join(" "))' "$OUT/instances.json")
# shellcheck disable=SC2086
aws ec2 describe-volumes --volume-ids $VOL_IDS \
  --query "Volumes[].{id:VolumeId,size:Size,type:VolumeType,iops:Iops,throughput:Throughput,encrypted:Encrypted,instance:Attachments[0].InstanceId,device:Attachments[0].Device}" \
  --output json > "$OUT/volumes.json"
aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Parameters" --output json > "$OUT/stack-parameters.json"

# metric queries: CPU of ClickHouse nodes, data-volume (/dev/sdb) write/read bytes and ops, 1-minute resolution
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
