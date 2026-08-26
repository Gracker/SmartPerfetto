// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  /\b(api[_-]?key|secret|password|token)\s*[:=]\s*(?!['"])([^\s'";,]{8,})/gi,
  /https?:\/\/[a-z0-9.-]+\.(?:internal|corp|local)\/[\w/-]+/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactedCount++;
      return '[REDACTED_SECRET]';
    });
  }
  return {text, redactedCount};
}
