#!/usr/bin/env node
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { ClickHouseClusterStack } from '../lib/clickhouse-cluster-stack';
import { ClickHouseEksStack } from '../lib/eks/clickhouse-eks-stack';

const app = new App();

// Bootstrapless: the stack has no assets, so the synthesized template is a self-contained
// "one-click" CloudFormation template and `cdk deploy` needs no `cdk bootstrap`.
new ClickHouseClusterStack(app, 'ClickHouseCluster', {
  stackName: process.env.STACK_NAME,
  synthesizer: new BootstraplessSynthesizer(),
});

new ClickHouseEksStack(app, 'ClickHouseEks', {
  stackName: process.env.EKS_STACK_NAME,
  synthesizer: new BootstraplessSynthesizer(),
});
