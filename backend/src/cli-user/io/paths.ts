// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Path resolution for the CLI's user-local storage.
 *
 * Layout:
 *   $SMARTPERFETTO_HOME/                (default: ~/.smartperfetto)
 *   ├── index.json                      (global session catalog)
 *   ├── traces/                         (CLI-managed trace copies)
 *   └── sessions/
 *       └── <sessionId>/
 *           ├── config.json
 *           ├── conclusion.md           (latest turn's conclusion)
 *           ├── transcript.jsonl
 *           ├── stream.jsonl            (raw StreamingUpdate log)
 *           ├── claim-support.json      (latest Evidence Contract claim support)
 *           ├── claim-verification.json (latest deterministic verifier result)
 *           ├── identity-resolutions.json
 *           ├── report.html             (latest HTML report)
 *           └── turns/NNN.md            (per-turn full answer)
 *
 * Override with `--session-dir` flag or `SMARTPERFETTO_HOME` env var.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CliPaths {
  home: string;
  sessionsRoot: string;
  tracesRoot: string;
  indexFile: string;
}

/** Resolve a home override from argv/env. Does NOT create directories — that's ensureLayout's job. */
export function resolveHome(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim()) return path.resolve(overrideDir);
  const envHome = process.env.SMARTPERFETTO_HOME;
  if (envHome && envHome.trim()) return path.resolve(envHome);
  return path.join(os.homedir(), '.smartperfetto');
}

/** Return the resolved layout without touching the filesystem. */
export function computePaths(overrideDir?: string): CliPaths {
  const home = resolveHome(overrideDir);
  return {
    home,
    sessionsRoot: path.join(home, 'sessions'),
    tracesRoot: path.join(home, 'traces'),
    indexFile: path.join(home, 'index.json'),
  };
}

/** Create the home + sessions directories if missing. Idempotent. */
export function ensureLayout(paths: CliPaths): void {
  fs.mkdirSync(paths.sessionsRoot, { recursive: true });
  fs.mkdirSync(paths.tracesRoot, { recursive: true });
}

/** Per-session paths. Files may not exist yet — callers check as needed. */
export interface SessionPaths {
  dir: string;
  config: string;
  conclusion: string;
  transcript: string;
  stream: string;
  claimSupport: string;
  claimVerification: string;
  identityResolutions: string;
  report: string;
  turnsDir: string;
}

/**
 * Valid session id pattern: alphanumeric + hyphen only. The real ids we mint
 * ourselves look like `agent-<timestamp>-<random>` which satisfies this. We
 * reject anything else up-front so `sessionPaths` can't be coaxed into
 * traversing outside `sessionsRoot` via `../` or absolute-path inputs, which
 * would turn `rm` into an arbitrary-delete for any tree that happens to
 * contain a `config.json`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,127}$/;

export class InvalidSessionIdError extends Error {
  constructor(sessionId: string) {
    super(`invalid session id: ${JSON.stringify(sessionId)} (allowed: alphanumeric + "-_", 1-128 chars)`);
    this.name = 'InvalidSessionIdError';
  }
}

/** Throws InvalidSessionIdError on anything that doesn't match the pattern. */
export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new InvalidSessionIdError(sessionId);
  }
}

export function sessionPaths(paths: CliPaths, sessionId: string): SessionPaths {
  assertValidSessionId(sessionId);
  const dir = path.join(paths.sessionsRoot, sessionId);
  // Defense-in-depth: even with the pattern guard above, verify the resolved
  // dir stays under sessionsRoot. Catches symlink games and future pattern
  // relaxations that might let path segments slip through.
  const resolvedRoot = path.resolve(paths.sessionsRoot);
  const resolvedDir = path.resolve(dir);
  if (resolvedDir !== path.join(resolvedRoot, sessionId) && !resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new InvalidSessionIdError(sessionId);
  }
  return {
    dir,
    config: path.join(dir, 'config.json'),
    conclusion: path.join(dir, 'conclusion.md'),
    transcript: path.join(dir, 'transcript.jsonl'),
    stream: path.join(dir, 'stream.jsonl'),
    claimSupport: path.join(dir, 'claim-support.json'),
    claimVerification: path.join(dir, 'claim-verification.json'),
    identityResolutions: path.join(dir, 'identity-resolutions.json'),
    report: path.join(dir, 'report.html'),
    turnsDir: path.join(dir, 'turns'),
  };
}

/** Create the per-session folder tree. Idempotent. */
export function ensureSessionLayout(sp: SessionPaths): void {
  fs.mkdirSync(sp.dir, { recursive: true });
  fs.mkdirSync(sp.turnsDir, { recursive: true });
}
