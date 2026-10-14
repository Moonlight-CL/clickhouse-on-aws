export type Arch = 'arm64' | 'x86_64';

const SIZES = ['large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge'];

const ARM_FAMILIES = ['m7g', 'm8g', 'r7g', 'r8g', 'c7g', 'c8g', 'm6g', 'r6g'];
const X86_FAMILIES = ['m7i', 'r7i', 'c7i', 'm6i', 'r6i', 'm7a', 'r7a'];

const expand = (families: string[]) => families.flatMap((f) => SIZES.map((s) => `${f}.${s}`));

/** Instance types offered for ClickHouse server nodes (EBS-only families). */
export const CLICKHOUSE_INSTANCE_TYPES = [...expand(ARM_FAMILIES), ...expand(X86_FAMILIES)];

/** Instance types offered for ClickHouse Keeper nodes. */
export const KEEPER_INSTANCE_TYPES = [
  't4g.medium', 't4g.large', 't4g.xlarge',
  'm7g.large', 'm7g.xlarge', 'c7g.large', 'c7g.xlarge',
  't3.medium', 't3.large', 't3.xlarge',
  'm7i.large', 'm7i.xlarge', 'c7i.large', 'c7i.xlarge',
];

/** Graviton families end in "g" (optionally followed by suffix letters such as "gn"); t4g is Graviton too. */
export function archOf(instanceType: string): Arch {
  const family = instanceType.split('.')[0];
  return /^[a-z]+\d+g[a-z]*$/.test(family) ? 'arm64' : 'x86_64';
}

export const ALL_INSTANCE_TYPES = Array.from(new Set([...CLICKHOUSE_INSTANCE_TYPES, ...KEEPER_INSTANCE_TYPES]));
