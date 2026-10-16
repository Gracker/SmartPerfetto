// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Keep a caller-supplied identifier to a bounded, header- and log-safe charset. */
export const sanitizeContextId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
};
