// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import os from 'os';

export function backendDataPath(...segments: string[]): string {
  const root = process.env.SMARTPERFETTO_BACKEND_DATA_DIR || path.resolve(process.cwd(), 'data');
  return path.join(root, ...segments);
}

export function backendLogPath(...segments: string[]): string {
  const root = process.env.SMARTPERFETTO_BACKEND_LOG_DIR || path.resolve(process.cwd(), 'logs');
  return path.join(root, ...segments);
}

export function hasConfiguredUserDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim());
}

export function resolveUserDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(homeDir, '.smartperfetto', 'runtime', 'data');
}

/**
 * Mutable, upgrade-surviving user state.
 *
 * This path is intentionally separate from backendDataPath(), whose source
 * fallback also contains committed static assets. Persistence-sensitive
 * callers must additionally consult the self-evolution persistence probe:
 * resolving a path alone does not authorize durable overlay writes.
 */
export function userDataPath(...segments: string[]): string {
  return path.join(resolveUserDataRoot(), ...segments);
}
