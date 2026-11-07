// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export function toSingleString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return undefined;
}

/** An http(s) URL with no embedded credentials: the shared shape of a provider endpoint. */
export function isCredentialFreeHttpUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}
