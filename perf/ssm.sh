#!/bin/bash
# Run a shell command on an EC2 instance via SSM and print its output.
# Usage: perf/ssm.sh <instance-id> '<command>' [timeout-seconds]
set -euo pipefail
INSTANCE=$1 CMD=$2 TIMEOUT=${3:-600}
PARAMS=$(node -e 'console.log(JSON.stringify({commands: [process.argv[1]], executionTimeout: [process.argv[2]]}))' "$CMD" "$TIMEOUT")
CID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "$PARAMS" --query Command.CommandId --output text)
while :; do
  sleep 3
  STATUS=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case $STATUS in Pending|InProgress|Delayed) continue ;; esac
  break
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$INSTANCE" --query StandardOutputContent --output text
ERR=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$INSTANCE" --query StandardErrorContent --output text)
[ -n "$ERR" ] && echo "--- stderr:" >&2 && echo "$ERR" >&2
[ "$STATUS" = Success ]
