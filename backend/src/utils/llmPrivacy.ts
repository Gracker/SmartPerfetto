// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';

export const LLM_REDACTION_VERSION = '1.0.0';

export interface LlmRedactionStats {
  applied: boolean;
  replacements: Record<string, number>;
}

export function hashSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type TextRule = {
  id: string;
  regex: RegExp;
  replace: string | ((match: string) => string);
};

const TEXT_REDACTION_RULES: TextRule[] = [
  {
    id: 'openai_like_api_key',
    regex: /\bsk-[A-Za-z0-9]{16,}\b/g,
    replace: 'sk-<REDACTED>',
  },
  {
    id: 'bearer_token',
    regex: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/g,
    replace: 'Bearer <REDACTED>',
  },
  {
    id: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: '<REDACTED_EMAIL>',
  },
  {
    id: 'absolute_path_unix',
    regex: /(?:\/Users\/|\/home\/)[^\s/]+(?:\/[^\s]+)+/g,
    replace: '<REDACTED_PATH>',
  },
  {
    id: 'absolute_path_windows',
    // e.g. C:\Users\name\file.txt
    regex: /\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s\\]+\b/g,
    replace: '<REDACTED_PATH>',
  },
];

function applyTextRedactionRules(text: string): { text: string; stats: LlmRedactionStats } {
  let out = text;
  const replacements: Record<string, number> = {};

  for (const rule of TEXT_REDACTION_RULES) {
    let count = 0;
    out = out.replace(rule.regex, (match) => {
      count += 1;
      return typeof rule.replace === 'function' ? rule.replace(match) : rule.replace;
    });
    if (count > 0) {
      replacements[rule.id] = (replacements[rule.id] || 0) + count;
    }
  }

  return {
    text: out,
    stats: {
      applied: Object.keys(replacements).length > 0,
      replacements,
    },
  };
}

export function redactTextForLLM(text: string): { text: string; stats: LlmRedactionStats } {
  return applyTextRedactionRules(text || '');
}

function isSensitiveKey(key: string): boolean {
  const k = (key || '').toLowerCase();
  if (!k) return false;
  return (
    k.includes('api_key') ||
    k.includes('apikey') ||
    k.includes('authorization') ||
    k === 'auth' ||
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('password') ||
    k.includes('passwd') ||
    k.includes('fingerprint') ||
    k === 'serial'
  );
}

export function redactObjectForLLM(value: unknown): { value: unknown; stats: LlmRedactionStats } {
  const replacements: Record<string, number> = {};

  const bump = (id: string) => {
    replacements[id] = (replacements[id] || 0) + 1;
  };

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 20) return node; // safety guard

    if (typeof node === 'string') {
      const redacted = applyTextRedactionRules(node);
      for (const [id, count] of Object.entries(redacted.stats.replacements)) {
        replacements[id] = (replacements[id] || 0) + count;
      }
      return redacted.text;
    }

    if (node === null || node === undefined) return node;

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }

    if (typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => {
        if (!isSensitiveKey(k)) return [k, walk(v, depth + 1)];
        bump('sensitive_key');
        return [k, '<REDACTED>'];
      }));
    }

    return node;
  };

  const redactedValue = walk(value, 0);
  return {
    value: redactedValue,
    stats: {
      applied: Object.keys(replacements).length > 0,
      replacements,
    },
  };
}

