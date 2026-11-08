// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Read/write the per-session folder (`<sessionsRoot>/<sessionId>/*`).
 *
 * Everything here is synchronous on purpose — these writes happen once
 * per turn and blocking is simpler + safer than trying to coordinate
 * parallel appends with the analyze() loop.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../../utils/atomicFileWriter';
import type { CliPaths, SessionPaths } from './paths';
import { ensureSessionLayout, sessionPaths } from './paths';
import type { CliSessionConfig } from '../types';
import { isRecordedRuntimeKind } from '../../agentRuntime/runtimeKinds';

export function readConfig(sp: SessionPaths): CliSessionConfig | null {
  if (!fs.existsSync(sp.config)) return null;
  let config: CliSessionConfig;
  try {
    config = JSON.parse(fs.readFileSync(sp.config, 'utf-8')) as CliSessionConfig;
  } catch {
    return null;
  }
  return withMigratedSessionRuntime(config);
}

/**
 * The recorded runtime label is provenance: a resume resolves the effective
 * runtime (Pi Agent Core, or the hidden legacy opt-in) through the same
 * selection a provider profile uses, so a retired label is kept as recorded.
 * An unknown label is dropped so the resume follows its provider/env pin.
 */
function withMigratedSessionRuntime(config: CliSessionConfig): CliSessionConfig {
  const recorded: unknown = config?.agentRuntimeKind;
  if (recorded === undefined || isRecordedRuntimeKind(recorded)) return config;
  const {agentRuntimeKind: _unknown, ...rest} = config;
  return rest;
}

/** Full write. For incremental updates, callers should readConfig → mutate → writeConfig. */
export function writeConfig(sp: SessionPaths, cfg: CliSessionConfig): void {
  ensureSessionLayout(sp);
  atomicWriteFileSync(sp.config, JSON.stringify(cfg, null, 2));
}

export function writeConclusion(sp: SessionPaths, markdown: string): void {
  ensureSessionLayout(sp);
  fs.writeFileSync(sp.conclusion, markdown, 'utf-8');
}

export function writeReportHtml(sp: SessionPaths, html: string): void {
  ensureSessionLayout(sp);
  fs.writeFileSync(sp.report, html, 'utf-8');
}

export function writeJsonFile(sp: SessionPaths, filePath: string, value: unknown): void {
  ensureSessionLayout(sp);
  atomicWriteFileSync(filePath, JSON.stringify(value ?? null, null, 2));
}

export function turnReportPath(sp: SessionPaths, turn: number): string {
  return path.join(sp.turnsDir, `${String(turn).padStart(3, '0')}.html`);
}

export function writeTurnReportHtml(sp: SessionPaths, turn: number, html: string): string {
  ensureSessionLayout(sp);
  const filePath = turnReportPath(sp, turn);
  fs.writeFileSync(filePath, html, 'utf-8');
  return filePath;
}

/** Per-turn markdown snapshot. `turn` is 1-indexed. */
export function writeTurnMarkdown(sp: SessionPaths, turn: number, markdown: string): void {
  ensureSessionLayout(sp);
  const filename = `${String(turn).padStart(3, '0')}.md`;
  fs.writeFileSync(path.join(sp.turnsDir, filename), markdown, 'utf-8');
}

/** Convenience: resolve paths + read config in one call. */
export function loadSession(paths: CliPaths, sessionId: string): {
  sp: SessionPaths;
  config: CliSessionConfig | null;
} {
  const sp = sessionPaths(paths, sessionId);
  return { sp, config: readConfig(sp) };
}
