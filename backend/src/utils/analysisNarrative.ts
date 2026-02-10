export type TriadRole = 'trigger' | 'supply' | 'amplification';

export const TRIAD_LABELS: Record<TriadRole, string> = {
  trigger: '直接原因',
  supply: '资源问题',
  amplification: '放大因素',
};

export const TRIAD_EVIDENCE_LABELS: Record<TriadRole, string> = {
  trigger: '直接原因证据',
  supply: '资源问题证据',
  amplification: '放大因素证据',
};

export const TRIAD_ROLE_ALIASES: Record<TriadRole, string[]> = {
  trigger: ['触发因子', '直接原因'],
  supply: ['供给约束', '资源瓶颈', '资源问题'],
  amplification: ['放大路径', '放大环节', '放大因素'],
};

export const TRIAD_HEADING = `根因机制拆解（${TRIAD_LABELS.trigger}/${TRIAD_LABELS.supply}/${TRIAD_LABELS.amplification}）`;
export const DEEP_REASON_LABEL = '为什么慢';
export const DEEP_REASON_ALIASES = ['为什么慢', '慢因子拆解'] as const;
export const OPTIMIZATION_LABEL = '优化方向';

export const SUPPLY_NONE_TEXT = `${TRIAD_LABELS.supply}不明显`;
export const SUPPLY_NONE_CURRENT_FRAME_TEXT = `${TRIAD_LABELS.supply}不明显（当前帧）`;
export const SUPPLY_WORKLOAD_WEAK_TEXT = `负载主导（${TRIAD_LABELS.supply}弱）`;
export const AMPLIFICATION_UNKNOWN_TEXT = '未识别放大因素';
export const AMPLIFICATION_UNKNOWN_CURRENT_FRAME_TEXT = '未观察到明确放大因素证据（当前帧）';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasGroup(role: TriadRole): string {
  return TRIAD_ROLE_ALIASES[role].map(escapeRegExp).join('|');
}

function buildTriadLinePattern(role: TriadRole): RegExp {
  return new RegExp(`(?:${aliasGroup(role)})(?:（[^）]*）)?\\s*[:：]\\s*([^；;\\n]+)`);
}

export function hasTriadRoleText(text: string, role: TriadRole): boolean {
  return new RegExp(`(?:${aliasGroup(role)})`).test(String(text || ''));
}

export function stripTriadPrefix(text: string): string {
  let out = String(text || '').trim();
  for (const role of ['trigger', 'supply', 'amplification'] as TriadRole[]) {
    const pattern = new RegExp(`^(?:${aliasGroup(role)})(?:（[^）]*）)?\\s*[:：]\\s*`);
    out = out.replace(pattern, '');
  }
  return out.trim();
}

export function normalizeLegacyTriadTerms(text: string): string {
  return String(text || '')
    .replace(/触发因子（直接原因）/g, TRIAD_LABELS.trigger)
    .replace(/供给约束（资源瓶颈）/g, TRIAD_LABELS.supply)
    .replace(/放大路径（问题放大环节）/g, TRIAD_LABELS.amplification);
}

export function parseTriadParts(text: string): Partial<Record<TriadRole, string>> {
  const source = String(text || '');
  const trigger = source.match(buildTriadLinePattern('trigger'))?.[1]?.trim();
  const supply = source.match(buildTriadLinePattern('supply'))?.[1]?.trim();
  const amplification = source.match(buildTriadLinePattern('amplification'))?.[1]?.trim();
  return {
    ...(trigger ? { trigger } : {}),
    ...(supply ? { supply } : {}),
    ...(amplification ? { amplification } : {}),
  };
}

export function buildTriadStatement(params: Partial<Record<TriadRole, string>>): string {
  const parts: string[] = [];
  if (params.trigger) parts.push(`${TRIAD_LABELS.trigger}: ${params.trigger}`);
  if (params.supply) parts.push(`${TRIAD_LABELS.supply}: ${params.supply}`);
  if (params.amplification) parts.push(`${TRIAD_LABELS.amplification}: ${params.amplification}`);
  return parts.join('；');
}

export type PhraseRule = {
  pattern: RegExp;
  replacement: string;
};

export const LEGACY_TO_PLAIN_PHRASE_RULES: PhraseRule[] = [
  {
    pattern: /触发因子（直接原因）|触发因子/g,
    replacement: TRIAD_LABELS.trigger,
  },
  {
    pattern: /供给约束（资源瓶颈）|供给约束/g,
    replacement: TRIAD_LABELS.supply,
  },
  {
    pattern: /放大路径（问题放大环节）|放大路径/g,
    replacement: TRIAD_LABELS.amplification,
  },
  {
    pattern: /负载主导（供给约束弱）/g,
    replacement: `任务量偏大（${SUPPLY_NONE_TEXT}）`,
  },
];
