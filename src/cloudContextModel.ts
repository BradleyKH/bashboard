// Cloud-context chips (pure, no DOM): which AWS and Azure identities a pane shows, and whether
// they look like production (docs/design/terminal.md section 4.25).

export interface AwsContext {
  profile: string;
  region: string;
}

export interface AzureContext {
  name: string;
  id: string;
  user: string | null;
}

export interface CloudChip {
  provider: 'aws' | 'azure';
  text: string;
  /** Hover text, one fact per line. */
  title: string;
  production: boolean;
}

export const DEFAULT_PRODUCTION_PATTERN = 'prod|prd|live';

/**
 * Compiles the `cloud.productionPattern` setting. An empty pattern never matches (null); an
 * invalid one falls back to the default so a typo does not silently disable the warning.
 * No `g` flag: a global regex keeps `lastIndex` between `.test` calls and would alternate.
 */
export function compileProductionPattern(pattern: string): RegExp | null {
  if (pattern === '') return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(DEFAULT_PRODUCTION_PATTERN, 'i');
  }
}

/** AWS chip first, then Azure. Azure appears only when its subscription name looks like production. */
export function cloudChips(
  aws: AwsContext | null,
  azure: AzureContext | null,
  pattern: RegExp | null,
  enabled: boolean,
): CloudChip[] {
  if (!enabled) return [];
  const chips: CloudChip[] = [];

  if (aws && (aws.profile !== '' || aws.region !== '')) {
    const label = aws.profile !== '' ? aws.profile : 'default';
    const lines = ['AWS', `Profile: ${label}`];
    if (aws.region !== '') lines.push(`Region: ${aws.region}`);
    chips.push({
      provider: 'aws',
      text: aws.region !== '' ? `aws ${label} · ${aws.region}` : `aws ${label}`,
      title: lines.join('\n'),
      production: pattern?.test(aws.profile) ?? false,
    });
  }

  if (azure && pattern?.test(azure.name)) {
    const lines = ['Azure', `Subscription: ${azure.name}`, `Subscription id: ${azure.id}`];
    if (azure.user) lines.push(`User: ${azure.user}`);
    chips.push({ provider: 'azure', text: `az ${azure.name}`, title: lines.join('\n'), production: true });
  }

  return chips;
}
