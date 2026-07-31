// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  formatThreats,
  scanContent,
} from '../../agentv3/selfImprove/contentScanner';
import {redactSecrets} from './secretPatterns';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const MAC_RE = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const ABSOLUTE_PATH_RE =
  /(?:\/(?:Users|home|data|private|var|tmp)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g;
const APP_PACKAGE_RE = /\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}\b/gi;
const STRUCTURAL_CONTROL_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern: /<\/?untrusted_curation_data\b/i,
    label: 'untrusted-data boundary tag',
  },
  {
    pattern: /<\|(?:im_start|im_end|system|assistant|developer|user)\|>/i,
    label: 'chat control token',
  },
  {
    pattern: /(?:\[\/?INST\]|<<\/?SYS>>)/i,
    label: 'instruction control token',
  },
  {
    pattern: /^\s*(?:system|assistant|developer|user)\s*:/im,
    label: 'role marker',
  },
];

export type PublicArtifactSanitizationResult<T> =
  | {ok: true; value: T; warnings: string[]}
  | {ok: false; errors: string[]; warnings: string[]};

/**
 * Sanitize data that may leave the local analysis boundary, such as a
 * contribution bundle or a user-reviewed GitHub Issue draft.
 */
export function sanitizePublicArtifactData<T>(
  value: T,
): PublicArtifactSanitizationResult<T> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const sanitized = sanitizeValue(value, '$', warnings, errors);
  return errors.length > 0
    ? {ok: false, errors, warnings}
    : {ok: true, value: sanitized as T, warnings};
}

function sanitizeValue(
  value: unknown,
  path: string,
  warnings: string[],
  errors: string[],
): unknown {
  if (typeof value === 'string') {
    const structuralControl = STRUCTURAL_CONTROL_PATTERNS.find(({pattern}) =>
      pattern.test(value));
    if (structuralControl) {
      errors.push(`${path}: ${structuralControl.label} forbidden`);
      return value;
    }
    const threats = scanContent(value);
    if (threats.length > 0) {
      errors.push(`${path}: ${formatThreats(threats)}`);
      return value;
    }
    const secretRedaction = redactSecrets(value);
    let text = secretRedaction.text
      .replace(EMAIL_RE, '[REDACTED_EMAIL]')
      .replace(URL_RE, '[REDACTED_URL]')
      .replace(MAC_RE, '[REDACTED_MAC]')
      .replace(PHONE_RE, '[REDACTED_PHONE]')
      .replace(ABSOLUTE_PATH_RE, '[REDACTED_PATH]')
      .replace(APP_PACKAGE_RE, '[REDACTED_PACKAGE]');
    if (text !== value) warnings.push(`redacted sensitive text at ${path}`);
    if (text.length > 4000) {
      text = text.slice(0, 4000);
      warnings.push(`truncated oversized text at ${path}`);
    }
    return text;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      sanitizeValue(child, `${path}[${index}]`, warnings, errors));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sanitizeValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        warnings,
        errors,
      );
    }
    return output;
  }
  errors.push(`${path}: unsupported value`);
  return null;
}
