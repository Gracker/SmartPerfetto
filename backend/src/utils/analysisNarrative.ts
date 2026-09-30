// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type TriadRole = 'trigger' | 'supply' | 'amplification';

export const TRIAD_LABELS: Record<TriadRole, string> = {
  trigger: '直接原因',
  supply: '资源问题',
  amplification: '放大因素',
};

export const TRIAD_ROLE_ALIASES: Record<TriadRole, string[]> = {
  trigger: ['触发因子', '直接原因'],
  supply: ['供给约束', '资源瓶颈', '资源问题'],
  amplification: ['放大路径', '放大环节', '放大因素'],
};

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
