// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI-internal types.
 *
 * Persisted file schemas for `~/.smartperfetto/`. Stable — bumping a
 * field requires a migration. Everything else is ephemeral / derivable.
 */

import type { BackendAgentRuntimeKind } from '../agentRuntime/runtimeSelection';
import type { SessionLineage } from '../agentv3/sessionStateSnapshot';
import type { CodeAwareMode } from '../services/codebase/codeAwareFeature';
import type {
  CaptureConfigRenderOptions,
  CapturePresetId,
  CaptureTarget,
} from '../services/traceCaptureConfig';

export type CliAnalysisMode = 'fast' | 'full' | 'auto';

export type {
  CaptureConfigRenderOptions,
  CapturePresetId,
  CaptureTarget,
};

export interface CaptureToolResolution {
  name: 'adb' | 'tracebox';
  source: 'env' | 'bundled' | 'path' | 'override' | 'missing';
  path: string;
  exists: boolean;
  executable: boolean;
  platformKey?: string;
  hint?: string;
}

export interface TraceCaptureResult {
  target: 'android';
  serial: string;
  app?: string;
  preset?: CapturePresetId;
  configPath?: string;
  durationSeconds: number;
  out: string;
  remotePath: string;
  usedSideload: boolean;
  tools: {
    adb: CaptureToolResolution;
    tracebox?: CaptureToolResolution;
  };
  device?: {
    apiLevel?: number;
    abi?: string;
    perfettoCommand?: string;
  };
  preflight?: {
    warnings: string[];
    selinux?: string;
    staleProcessesDetected?: boolean;
    killedStaleProcesses?: boolean;
  };
  analysis?: {
    sessionId: string;
    sessionDir: string;
    turn: number;
    success: boolean;
  };
}

export interface CliSessionLineage extends SessionLineage {
  reason: 'cli-level3-degraded';
}

/** Written to `<sessionDir>/config.json`. Source of truth for resume. */
export interface CliSessionConfig {
  /** CLI-local session id (same as backend session id — no separate namespace). */
  sessionId: string;
  /** Backend agent session id used for runtime persistence; may differ after degraded CLI resume. */
  backendSessionId?: string;
  /** Backend-session ancestry when the CLI-visible session had to bridge to a fresh backend session. */
  lineage?: CliSessionLineage;
  /** Trace path the user passed on first analyze. Used to re-load on traceId eviction. */
  tracePath: string;
  /** Trace id assigned by TraceProcessorService (may change across processes). */
  traceId: string;
  /** Optional reference trace path for comparison sessions. */
  referenceTracePath?: string;
  /** Optional reference trace id assigned by TraceProcessorService. */
  referenceTraceId?: string;
  /** Provider Manager profile that supplied runtime credentials; null means env/default fallback. */
  providerId?: string | null;
  /** Runtime that produced the session. Used by resume preflight checks. */
  agentRuntimeKind?: BackendAgentRuntimeKind;
  /** Non-secret provider/runtime snapshot hash captured for diagnostics. */
  providerSnapshotHash?: string | null;
  /** Claude model actually used — preserved for consistency across resumes. */
  model?: string;
  /** Code-aware mode selected for this analysis turn, if any. */
  codeAwareMode?: CodeAwareMode;
  /** Registered codebase ids exposed to this analysis turn. */
  codebaseIds?: string[];
  /** Registered private knowledge source ids exposed to this analysis turn. */
  knowledgeSourceIds?: string[];
  /** Analysis mode selected for the latest turn. */
  analysisMode?: CliAnalysisMode;
  /** Capture metadata when the session was created by `smp capture ... --analyze`. */
  capture?: TraceCaptureResult;
  /** Unix ms when session was created. */
  createdAt: number;
  /** Unix ms of most recent turn completion. */
  lastTurnAt: number;
  /** Incremented per turn, starts at 1. */
  turnCount: number;
}

/** One row in `~/.smartperfetto/index.json` — the global session catalog. */
export interface CliSessionIndexEntry {
  sessionId: string;
  createdAt: number;
  lastTurnAt: number;
  tracePath: string;
  traceFilename: string;
  firstQuery: string;
  turnCount: number;
  /**
   * `partial` is a run that produced output but did not finish — a timeout
   * hard limit, an exhausted turn budget, a failed quality gate. It used to be
   * filed as `completed`, so `smp list` showed a truncated 1200s comparison
   * exactly like a clean one.
   */
  status: 'pending' | 'completed' | 'partial' | 'failed';
}

/** One row in `<sessionDir>/transcript.jsonl` — human-readable turn log. */
export interface CliTranscriptTurn {
  turn: number;
  timestamp: number;
  question: string;
  conclusionMd?: string;
  /** Product-owned continuity; persisted evidence remains historical after restart. */
  history?: import('../agentRuntime/analysisHistory').AnalysisHistoryTurn;
  confidence?: number;
  rounds?: number;
  durationMs?: number;
  reportFile?: string;
  error?: string;
}
