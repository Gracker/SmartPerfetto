// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI bootstrap: env loading + path layout.
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

export interface BootstrapOptions {
  envFile?: string;
  sessionDir?: string;
  /** @deprecated Runtime credential checks are command-specific now. */
  requireLlm?: boolean;
}

export interface BootstrapResult {
  paths: CliPaths;
}

let memoizedResult: BootstrapResult | null = null;

export function bootstrap(options: BootstrapOptions = {}): BootstrapResult {
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
    loadEnv(envFile, sessionDir);
    const paths = computePaths(sessionDir);
    if (backendRoot && !process.env.SMARTPERFETTO_PACKAGE_ROOT?.trim()) {
      process.env.SMARTPERFETTO_PACKAGE_ROOT = backendRoot;
    }
    if (!process.env.SMARTPERFETTO_DISTRIBUTION?.trim()) {
      process.env.SMARTPERFETTO_DISTRIBUTION = 'npm';
    }
    // Keep helper services that read SMARTPERFETTO_HOME directly (for example
    // the CLI-managed trace_processor_shell cache) aligned with --session-dir.
    process.env.SMARTPERFETTO_HOME = paths.home;
    if (!process.env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim()) {
      process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(paths.home, 'runtime', 'data');
    }
    if (!process.env.SMARTPERFETTO_BACKEND_LOG_DIR?.trim()) {
      process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(paths.home, 'runtime', 'logs');
    }
    // Keep CLI trace copies inside the same user-selected home. The web server
    // keeps its historical ./uploads/traces default because it does not call
    // this bootstrap path.
    if (!process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR?.trim()) {
      process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = paths.tracesRoot;
    }
    ensureLayout(paths);
    memoizedResult = { paths };
  }

  return memoizedResult;
}

/**
 * Load env from (in order, later files override earlier files):
 *   1. --env-file argument
 *   2. backend/.env relative to this compiled file
 *   3. <resolved CLI home>/env (`--session-dir`, SMARTPERFETTO_HOME, or
 *      ~/.smartperfetto)
 *
 * Missing files are silently skipped; only an explicitly-passed --env-file
 * is required to exist.
 */
function loadEnv(explicitFile?: string, sessionDir?: string): void {
  if (explicitFile) {
    const resolved = path.resolve(explicitFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--env-file not found: ${resolved}`);
    }
    dotenv.config({ path: resolved, quiet: true, override: true });
    return;
  }

  // Try backend/.env (sibling of this module's package root).
  // __dirname at runtime will be something like dist/cli-user or src/cli-user.
  // Walk up to find the first ancestor containing package.json with our name.
  const backendRoot = findBackendRoot();
  if (backendRoot) {
    const envPath = path.join(backendRoot, '.env');
    if (fs.existsSync(envPath)) dotenv.config({ path: envPath, quiet: true, override: true });
  }

  // Last chance: user-level override. Keep this aligned with computePaths()
  // so `smp --session-dir X config init` creates the file later runs read.
  const cliHome = sessionDir
    ?? (process.env.SMARTPERFETTO_HOME?.trim() ? path.resolve(process.env.SMARTPERFETTO_HOME) : undefined)
    ?? path.join(process.env.HOME || '', '.smartperfetto');
  const userEnv = path.join(cliHome, 'env');
  if (fs.existsSync(userEnv)) dotenv.config({ path: userEnv, quiet: true, override: true });
}

/**
 * Walk up from this module's __dirname to find the backend package root
 * (the one containing a SmartPerfetto CLI `package.json` with the `smp` or
 * `smartperfetto` bin entry). Used both to locate `.env` and to pin
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
        if (isSmartPerfettoPackage(pkg)) {
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

function isSmartPerfettoPackage(pkg: any): boolean {
  const hasCliBin = Boolean(pkg?.bin?.smp || pkg?.bin?.smartperfetto);
  return hasCliBin && (
    pkg.name === '@gracker/smartperfetto' ||
    pkg.name === 'smart-perfetto-backend'
  );
}
