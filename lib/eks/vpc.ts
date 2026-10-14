import { CfnCondition, Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NewVpcProps {
  /** Condition: CreateVpc = true (every resource below is gated by it). */
  readonly create: CfnCondition;
  /** Condition: one NAT gateway per AZ (otherwise a single NAT gateway in the first AZ). */
  readonly natPerAz: CfnCondition;
  readonly cidr: string;
  /** Name used for the kubernetes.io/cluster/<name> subnet tags. */
  readonly eksClusterName: string;
}

export interface NewVpc {
  readonly vpc: ec2.CfnVPC;
  readonly privateSubnets: ec2.CfnSubnet[];
}

/**
 * Three-AZ VPC as recommended for a Keeper quorum: public subnets (NAT gateways, internet-facing load balancers)
 * and private subnets (nodes, internal load balancers), S3 gateway endpoint (backups stay off the NAT path).
 * CIDR split: private /18 x 3 at the bottom of the range, public /20 x 3 above them (as in the ClickHouse EKS guide).
 */
export function createVpc(scope: Construct, p: NewVpcProps): NewVpc {
  const gate = <T extends { cfnOptions: { condition?: CfnCondition } }>(r: T, c = p.create): T => {
    r.cfnOptions.condition = c;
    return r;
  };
  const name = (suffix: string) => [{ key: 'Name', value: Fn.sub(`\${AWS::StackName}-${suffix}`) }];
  const clusterTag = { key: Fn.join('', ['kubernetes.io/cluster/', p.eksClusterName]), value: 'shared' };

  const vpc = gate(new ec2.CfnVPC(scope, 'Vpc', {
    cidrBlock: p.cidr, enableDnsHostnames: true, enableDnsSupport: true, tags: name('vpc'),
  }));
  const igw = gate(new ec2.CfnInternetGateway(scope, 'InternetGateway', { tags: name('igw') }));
  const igwAttachment = gate(new ec2.CfnVPCGatewayAttachment(scope, 'InternetGatewayAttachment', { vpcId: vpc.ref, internetGatewayId: igw.ref }));

  // /16 -> 4 x /18 (private 0..2) ; the 4th /18 -> 4 x /20 (public 0..2)
  const privateCidrs = Fn.cidr(p.cidr, 4, '14');
  const publicCidrs = Fn.cidr(Fn.select(3, privateCidrs), 4, '12');
  const az = (i: number) => Fn.select(i, Fn.getAzs(''));

  const publicRt = gate(new ec2.CfnRouteTable(scope, 'PublicRouteTable', { vpcId: vpc.ref, tags: name('public') }));
  const defaultRoute = gate(new ec2.CfnRoute(scope, 'PublicDefaultRoute', {
    routeTableId: publicRt.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref,
  }));
  defaultRoute.addResourceDependency(igwAttachment);

  const privateSubnets: ec2.CfnSubnet[] = [];
  const privateRts: ec2.CfnRouteTable[] = [];
  const nats: ec2.CfnNatGateway[] = [];
  for (const i of [0, 1, 2]) {
    const pub = gate(new ec2.CfnSubnet(scope, `PublicSubnet${i + 1}`, {
      vpcId: vpc.ref, availabilityZone: az(i), cidrBlock: Fn.select(i, publicCidrs), mapPublicIpOnLaunch: false,
      tags: [...name(`public-${i + 1}`), { key: 'kubernetes.io/role/elb', value: '1' }, clusterTag],
    }));
    gate(new ec2.CfnSubnetRouteTableAssociation(scope, `PublicSubnet${i + 1}Routes`, { subnetId: pub.ref, routeTableId: publicRt.ref }));

    const priv = gate(new ec2.CfnSubnet(scope, `PrivateSubnet${i + 1}`, {
      vpcId: vpc.ref, availabilityZone: az(i), cidrBlock: Fn.select(i, privateCidrs),
      tags: [...name(`private-${i + 1}`), { key: 'kubernetes.io/role/internal-elb', value: '1' }, clusterTag],
    }));
    privateSubnets.push(priv);
    const rt = gate(new ec2.CfnRouteTable(scope, `PrivateRouteTable${i + 1}`, { vpcId: vpc.ref, tags: name(`private-${i + 1}`) }));
    privateRts.push(rt);
    gate(new ec2.CfnSubnetRouteTableAssociation(scope, `PrivateSubnet${i + 1}Routes`, { subnetId: priv.ref, routeTableId: rt.ref }));

    // NAT 1 always (when the VPC is created), NAT 2/3 only in per-AZ mode
    const natCond = i === 0 ? p.create : p.natPerAz;
    const eip = gate(new ec2.CfnEIP(scope, `NatEip${i + 1}`, { domain: 'vpc', tags: name(`nat-${i + 1}`) }), natCond);
    eip.addResourceDependency(igwAttachment);
    nats.push(gate(new ec2.CfnNatGateway(scope, `NatGateway${i + 1}`, {
      subnetId: pub.ref, allocationId: eip.attrAllocationId, tags: name(`nat-${i + 1}`),
    }), natCond));
  }
  privateRts.forEach((rt, i) => {
    const natId = i === 0 ? nats[0].ref : Fn.conditionIf(p.natPerAz.logicalId, nats[i].ref, nats[0].ref).toString();
    gate(new ec2.CfnRoute(scope, `PrivateDefaultRoute${i + 1}`, {
      routeTableId: rt.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: natId,
    }));
  });
  gate(new ec2.CfnVPCEndpoint(scope, 'S3GatewayEndpoint', {
    vpcId: vpc.ref, serviceName: Fn.sub('com.amazonaws.${AWS::Region}.s3'), vpcEndpointType: 'Gateway',
    routeTableIds: privateRts.map((rt) => rt.ref),
  }));
  return { vpc, privateSubnets };
}
