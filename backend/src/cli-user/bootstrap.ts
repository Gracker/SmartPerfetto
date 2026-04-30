// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI bootstrap: env loading + path layout + API key validation.
 *
 * Invariant: callers must await `bootstrap()` once before any CLI command
 * performs work. Idempotent within a process — safe to call twice.
 *
 * Notes on process liveness:
 *   We intentionally do NOT import `reportRoutes.ts` anywhere in the CLI
 *   path — that module installs a 30-minute setInterval without `.unref()`,
 *   which would keep the CLI process alive indefinitely after analyze
 *   completes. Instead, CLI writes its HTML report directly to the session
 *   folder via `sessionStore.writeReportHtml`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { computePaths, ensureLayout, type CliPaths } from './io/paths';
import { hasClaudeCredentials } from '../agentv3/claudeConfig';

export interface BootstrapOptions {
  envFile?: string;
  sessionDir?: string;
  /** When false, skip the ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL check so
   *  purely-local commands (`list`, `show`, `report`, `rm`) stay usable
   *  before the user has configured LLM credentials. Defaults to true. */
  requireLlm?: boolean;
}

export interface BootstrapResult {
  paths: CliPaths;
}

let memoizedResult: BootstrapResult | null = null;
let llmCredentialsVerified = false;

export function bootstrap(options: BootstrapOptions = {}): BootstrapResult {
  const requireLlm = options.requireLlm !== false;

  if (!memoizedResult) {
    // Resolve any user-relative paths *before* chdir — otherwise a relative
    // --session-dir or --env-file would reanchor to the backend root.
    const envFile = options.envFile ? path.resolve(options.envFile) : undefined;
    const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : undefined;

    // Backend services (SessionPersistenceService, traceRecorder, forkManager,
    // sceneTemplateStore, ...) resolve storage paths relative to `process.cwd()`,
    // assuming the process started in `backend/`. The HTTP server always does —
    // but CLI can be invoked from anywhere. Pin cwd to the backend root first so
    // SQLite, trace uploads, agent state, etc. all land in the same place the
    // web UI reads from. Pre-dates any service import that captures cwd.
    const backendRoot = findBackendRoot();
    if (backendRoot && process.cwd() !== backendRoot) {
      process.chdir(backendRoot);
    }
    loadEnv(envFile);
    const paths = computePaths(sessionDir);
    ensureLayout(paths);
    memoizedResult = { paths };
  }

  // Credentials check is separate from the memoization guard: a process
  // might first hit `bootstrap({requireLlm:false})` (list) and later an
  // LLM-using path — the second call must still enforce the check.
  if (requireLlm && !llmCredentialsVerified) {
    assertLlmCredentials();
    llmCredentialsVerified = true;
  }

  return memoizedResult;
}

/**
 * Load env from (in order, first wins):
 *   1. --env-file argument
 *   2. backend/.env relative to this compiled file
 *   3. ~/.smartperfetto/env
 *
 * Missing files are silently skipped; only an explicitly-passed --env-file
 * is required to exist.
 */
function loadEnv(explicitFile?: string): void {
  if (explicitFile) {
    const resolved = path.resolve(explicitFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--env-file not found: ${resolved}`);
    }
    dotenv.config({ path: resolved, quiet: true });
    return;
  }

  // Try backend/.env (sibling of this module's package root).
  // __dirname at runtime will be something like dist/cli-user or src/cli-user.
  // Walk up to find the first ancestor containing package.json with our name.
  const backendRoot = findBackendRoot();
  if (backendRoot) {
    const envPath = path.join(backendRoot, '.env');
    if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true });
  }

  // Last chance: user-level override.
  const userEnv = path.join(process.env.HOME || '', '.smartperfetto', 'env');
  if (fs.existsSync(userEnv)) dotenv.config({ path: userEnv, quiet: true });
}

/**
 * Walk up from this module's __dirname to find the backend package root
 * (the one containing a `package.json` named `smart-perfetto-backend` with
 * the `smartperfetto` bin entry). Used both to locate `.env` and to pin
 * `process.cwd()` so CWD-relative paths in the service layer resolve to
 * the right `backend/data/` and `backend/logs/` dirs.
 *
 * From `src/cli-user/` or `dist/cli-user/`, the root is 2 levels up. Cap
 * at 4 to leave headroom for monorepo layouts (packages/backend/...) without
 * walking into the user's home or root dir on a misconfigured install.
 */
function findBackendRoot(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'smart-perfetto-backend' && pkg.bin?.smartperfetto) {
          return dir;
        }
      } catch {
        // fall through to parent
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function assertLlmCredentials(): void {
  if (hasClaudeCredentials()) return;
  throw new Error(
    [
      'Missing Claude credentials.',
      'Set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL for proxy, or envs for AWS Bedrock) before running.',
      'The CLI reads backend/.env by default; pass --env-file <path> to override.',
    ].join(' '),
  );
}
