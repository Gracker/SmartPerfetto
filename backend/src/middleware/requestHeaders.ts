// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { IncomingMessage } from 'http';

/** Keep a caller-supplied identifier to a bounded, header- and log-safe charset. */
export const sanitizeContextId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
};

export const getHeaderValue = (req: IncomingMessage, name: string): string => {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
};

export const getFirstHeaderValue = (req: IncomingMessage, names: string[]): string => {
  for (const name of names) {
    const value = getHeaderValue(req, name);
    if (value.trim().length > 0) return value;
  }
  return '';
};

/** A comma-separated header of ids, sanitized; `fallback` when absent or empty. */
export const parseHeaderList = (req: IncomingMessage, names: string[], fallback: string[]): string[] => {
  const raw = getFirstHeaderValue(req, names);
  if (!raw.trim()) return fallback;
  const parsed = raw
    .split(',')
    .map(value => sanitizeContextId(value))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
};
