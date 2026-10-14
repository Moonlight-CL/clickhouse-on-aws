import { CfnCustomResource, CfnResource, Fn, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface UpdateGuardProps {
  /** Parameters that must never change after the stack is created: name -> value. */
  readonly immutable: Record<string, string>;
  /** Numeric parameters that may grow but never shrink: name -> value. */
  readonly noDecrease: Record<string, string>;
  /** Dotted version parameters (e.g. 26.8.24.9) that may be upgraded but never downgraded: name -> value. */
  readonly noDowngrade: Record<string, string>;
}

// Rejects a stack update that changes an immutable parameter, shrinks a no-decrease one or downgrades a version. Updates issued by a
// rollback are always accepted (the stack status is UPDATE_ROLLBACK_IN_PROGRESS), so a rollback never fails here.
const LAMBDA_CODE = `import json, urllib.request
import boto3

def send(e, status, reason=""):
    body = json.dumps({"Status": status, "Reason": reason[:1000], "PhysicalResourceId": e.get("PhysicalResourceId") or "update-guard",
                       "StackId": e["StackId"], "RequestId": e["RequestId"], "LogicalResourceId": e["LogicalResourceId"]}).encode()
    urllib.request.urlopen(urllib.request.Request(e["ResponseURL"], data=body, method="PUT", headers={"Content-Type": ""}))

def violations(e):
    new, old = e["ResourceProperties"], e.get("OldResourceProperties", {})
    errs = []
    for k, v in json.loads(new.get("Immutable", "{}")).items():
        was = json.loads(old.get("Immutable", "{}")).get(k)
        if was is not None and was != v:
            errs.append(f"{k} cannot be changed after creation ({was!r} -> {v!r})")
    for k, v in json.loads(new.get("NoDecrease", "{}")).items():
        was = json.loads(old.get("NoDecrease", "{}")).get(k)
        if was is not None and int(v) < int(was):
            errs.append(f"{k} cannot be decreased ({was} -> {v})")
    ver = lambda s: [int(x) for x in s.split(".")]
    for k, v in json.loads(new.get("NoDowngrade", "{}")).items():
        was = json.loads(old.get("NoDowngrade", "{}")).get(k)
        if was is not None and ver(v) < ver(was):
            errs.append(f"{k} cannot be downgraded ({was} -> {v})")
    return errs

def handler(e, c):
    try:
        if e["RequestType"] == "Update":
            status = boto3.client("cloudformation").describe_stacks(StackName=e["StackId"])["Stacks"][0]["StackStatus"]
            errs = [] if "ROLLBACK" in status else violations(e)
            if errs:
                print("rejected:", errs)
                return send(e, "FAILED", "Update rejected (see the operations guide): " + "; ".join(errs))
        send(e, "SUCCESS")
    except Exception as x:
        print("error:", x)
        send(e, "FAILED", "update guard error: " + str(x))
`;

/**
 * Custom resource that blocks unsafe stack updates before anything else is touched: every other resource of the
 * stack depends on it, so CloudFormation updates (and rejects) it first.
 */
export function createUpdateGuard(scope: Construct, p: UpdateGuardProps): CfnCustomResource {
  const role = new iam.CfnRole(scope, 'UpdateGuardRole', {
    assumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    },
    managedPolicyArns: [Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')],
    policies: [{
      policyName: 'describe-stack',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'cloudformation:DescribeStacks', Resource: Stack.of(scope).stackId }],
      },
    }],
  });
  const fn = new lambda.CfnFunction(scope, 'UpdateGuardFunction', {
    runtime: 'python3.13', handler: 'index.handler', timeout: 30, role: role.attrArn,
    code: { zipFile: LAMBDA_CODE },
  });
  const guard = new CfnCustomResource(scope, 'UpdateGuard', { serviceToken: fn.attrArn });
  guard.addPropertyOverride('Immutable', Fn.toJsonString(p.immutable));
  guard.addPropertyOverride('NoDecrease', Fn.toJsonString(p.noDecrease));
  guard.addPropertyOverride('NoDowngrade', Fn.toJsonString(p.noDowngrade));
  return guard;
}

/** Make every resource of the stack (except the guard itself) depend on the guard. Call after all resources exist. */
export function dependOnUpdateGuard(stack: Stack, guard: CfnCustomResource): void {
  const exempt = new Set(['UpdateGuard', 'UpdateGuardFunction', 'UpdateGuardRole']);
  for (const c of stack.node.findAll()) {
    if (c instanceof CfnResource && c !== guard && !exempt.has(c.node.id)) c.addResourceDependency(guard);
  }
}
