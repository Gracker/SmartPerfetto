// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Turn runner — the shared per-turn flow used by `analyze`, `resume`,
 * and the REPL.
 *
 * Responsibilities:
 *   - Load / reload trace
 *   - Call CliAnalyzeService.runTurn()
 *   - Commit outputs to the session folder via `commitTurnOutputs`
 *
 * Out of scope:
 *   - Bootstrap (env/paths) — caller owns this
 *   - Service construction / teardown — caller owns the lifecycle
 *     (one-shot commands wrap a single turn; REPL keeps one service
 *      across many turns)
 *   - Error presentation beyond propagating exceptions
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CliPaths, SessionPaths } from '../io/paths';
import { ensureSessionLayout, sessionPaths } from '../io/paths';
import type { Renderer } from '../repl/renderer';
import type { CliSessionConfig, CliSessionLineage, CliTranscriptTurn } from '../types';
import type { CliAnalyzeService, RunTurnOutput } from './cliAnalyzeService';
import {commitSourceSupplementOutput, commitTurnOutputs} from './turnPersistence';
import { loadSession } from '../io/sessionStore';
import { readIndex } from '../io/indexJson';
import { appendStreamEvent } from '../io/transcriptWriter';
import {
  buildComparisonAppendix,
} from '../../services/comparisonAppendixService';
import type {CodeAwareMode} from '../../services/codebase/codeAwareFeature';
import type {CliAnalysisMode, TraceCaptureResult} from '../types';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {privateAnalysisQueryMessage} from '../../services/security/privateAnalysisProjection';

const RESUME_CONTEXT_MAX_CHARS = 4000;
const RESUME_TURN_MAX_CHARS = 1200;
const RESUME_MAX_TURNS = 3;
const CLI_LEVEL3_LINEAGE_REASON = 'cli-level3-degraded' as const;

export interface TurnRunnerContext {
  paths: CliPaths;
  service: CliAnalyzeService;
  renderer: Renderer;
}

export interface TurnResult {
  sessionId: string;
  sessionDir: string;
  turn: number;
  success: boolean;
  /** True when the resume path had to fall back to Level 3 (fresh load +
   *  preamble). Callers can surface a note to the user. */
  degraded: boolean;
}

/**
 * Fresh analyze — loads the trace, creates a new session, runs turn 1.
 * Equivalent to what `smartperfetto analyze <trace>` does, minus the
 * bootstrap / service-lifecycle work around it.
 */
export async function startSession(
  ctx: TurnRunnerContext,
  input: {
    tracePath: string;
    query: string;
    referenceTracePath?: string;
    analysisMode?: CliAnalysisMode;
    codeAwareMode?: CodeAwareMode;
    codebaseIds?: string[];
    knowledgeSourceIds?: string[];
    capture?: TraceCaptureResult;
  },
): Promise<TurnResult> {
  const tracePath = path.resolve(input.tracePath);
  logText(ctx, `Loading trace: ${tracePath}`);
  // loadTraceFromFilePath throws on ENOENT; we let it propagate so there's
  // one source of truth for the existence check.
  const traceId = await ctx.service.loadTrace(tracePath);
  logText(ctx, `Trace loaded (traceId=${traceId.slice(0, 8)}…)`);

  let referenceTracePath: string | undefined;
  let referenceTraceId: string | undefined;
  let reportAppendix: { markdown: string; html: string } | undefined;
  if (input.referenceTracePath) {
    referenceTracePath = path.resolve(input.referenceTracePath);
    if (referenceTracePath === tracePath) {
      throw new Error('reference trace must be different from current trace');
    }
    logText(ctx, `Loading reference trace: ${referenceTracePath}`);
    referenceTraceId = await ctx.service.loadTrace(referenceTracePath);
    logText(ctx, `Reference trace loaded (traceId=${referenceTraceId.slice(0, 8)}…)`);
    const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    reportAppendix = await buildComparisonAppendix(ctx.service, {
      currentTraceId: traceId,
      referenceTraceId,
    }).catch((err) => ({
      markdown: [
        localize(outputLanguage, '## SmartPerfetto 确定性对比附录', '## SmartPerfetto Deterministic Comparison Appendix'),
        '',
        localize(
          outputLanguage,
          `- 固定 SQL 附录生成失败：${(err as Error).message}`,
          `- Deterministic SQL appendix generation failed: ${(err as Error).message}`,
        ),
        '',
      ].join('\n'),
      html: `<section><h2>${localize(outputLanguage, 'SmartPerfetto 确定性对比附录', 'SmartPerfetto Deterministic Comparison Appendix')}</h2><p>${localize(outputLanguage, '固定 SQL 附录生成失败：', 'Deterministic SQL appendix generation failed: ')}${escapeHtml((err as Error).message)}</p></section>`,
    }));
  }

  const startedAt = Date.now();
  let sp: SessionPaths | undefined;
  let streamFile: string | null = null;
  let resolvedSessionId: string | undefined;

  const result = await ctx.service.runTurn({
    traceId,
    referenceTraceId,
    query: input.query,
    analysisMode: input.analysisMode,
    codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds,
    knowledgeSourceIds: input.knowledgeSourceIds,
    turn: 1,
    resolveCliTurnPath: (sid, turn) => path.join(
      sessionPaths(ctx.paths, sid).turnsDir,
      `${String(turn).padStart(3, '0')}.md`,
    ),
    onSessionReady: (sid) => {
      sp = sessionPaths(ctx.paths, sid);
      ensureSessionLayout(sp);
      resolvedSessionId = sid;
      streamFile = sp.stream;
    },
    onEvent: (update) => {
      ctx.renderer.onEvent(update);
      if (streamFile) appendStreamEvent(streamFile, update);
    },
  });
  const persistedQuery = result.privateKnowledge
    ? privateAnalysisQueryMessage(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE))
    : input.query;

  // Defensive: if onSessionReady didn't fire (future refactor hazard) we
  // still land on a valid session folder using the resolved sessionId.
  if (!resolvedSessionId || !sp) {
    resolvedSessionId = result.sessionId;
    sp = sessionPaths(ctx.paths, resolvedSessionId);
    ensureSessionLayout(sp);
  }
  const now = Date.now();

  const config: CliSessionConfig = {
    sessionId: resolvedSessionId,
    backendSessionId: result.sessionId,
    tracePath,
    traceId,
    referenceTracePath,
    referenceTraceId,
    providerId: result.providerId,
    agentRuntimeKind: result.agentRuntimeKind,
    providerSnapshotHash: result.providerSnapshotHash,
    sdkSessionId: result.sdkSessionId,
    model: result.model,
    analysisMode: input.analysisMode,
    codeAwareMode: result.codeAwareMode,
    codebaseIds: input.codebaseIds,
    knowledgeSourceIds: input.knowledgeSourceIds,
    capture: input.capture,
    createdAt: startedAt,
    lastTurnAt: now,
    turnCount: 1,
  };

  commitTurnOutputs({
    paths: ctx.paths,
    sp,
    renderer: ctx.renderer,
    sessionId: resolvedSessionId,
    turn: 1,
    query: persistedQuery,
    result,
    config,
    turnMarkdown: formatTurnMarkdown(1, persistedQuery, result.result.conclusion || '', result.result, false),
    reportAppendix,
    indexEntry: {
      sessionId: resolvedSessionId,
      createdAt: startedAt,
      lastTurnAt: now,
      tracePath,
      traceFilename: referenceTracePath
        ? `${path.basename(tracePath)} vs ${path.basename(referenceTracePath)}`
        : path.basename(tracePath),
      firstQuery: persistedQuery,
      turnCount: 1,
      status: result.result.success ? 'completed' : 'failed',
    },
  });
  await completeSourceSupplement(ctx, sp, result, 1);

  return {
    sessionId: resolvedSessionId,
    sessionDir: sp.dir,
    turn: 1,
    success: result.result.success,
    degraded: false,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Continue an existing session — reloads the trace (with the original id
 * when possible), runs turn N+1, and commits outputs to the same folder.
 *
 * Three-level degradation (plan §G.3): Level 1/2 keep sessionId+sdkSessionId
 * intact; Level 3 falls back to a fresh load with the prior conclusion
 * injected as preamble but keeps the CLI-visible session id stable.
 */
export async function continueSession(
  ctx: TurnRunnerContext,
  input: { sessionId: string; query: string },
): Promise<TurnResult> {
  const userSessionId = input.sessionId;
  const sp = sessionPaths(ctx.paths, userSessionId);
  const { config: existingConfig } = loadSession(ctx.paths, userSessionId);
  if (!existingConfig) {
    throw new Error(`no session found at ${sp.dir}`);
  }

  const nextTurn = existingConfig.turnCount + 1;
  const streamFile = sp.stream;
  const previousBackendSessionId = existingConfig.backendSessionId || userSessionId;

  logText(ctx, `Resuming session ${userSessionId} (turn ${nextTurn})`);
  const existingLineageNotice = buildLineageNotice(existingConfig.lineage);
  if (existingLineageNotice) {
    logText(ctx, existingLineageNotice);
  }
  const reloaded = await ctx.service.reloadTraceById(existingConfig.traceId);

  let effectiveTraceId: string;
  let effectiveQuery: string;
  let requestedSessionId: string | undefined;
  let degraded = false;
  let degradedPreviousBackendSessionId: string | undefined;
  let pendingLineage: CliSessionLineage | undefined = existingConfig.lineage;

  if (reloaded) {
    effectiveTraceId = existingConfig.traceId;
    effectiveQuery = buildResumeContextQuery(sp, input.query);
    requestedSessionId = previousBackendSessionId;
    logText(ctx, `Trace reloaded (traceId=${effectiveTraceId.slice(0, 8)}…)`);
  } else {
    logText(ctx, '(trace evicted from cache — loading fresh and replaying conclusion as preamble)');
    effectiveTraceId = await ctx.service.loadTrace(existingConfig.tracePath);
    effectiveQuery = buildResumeContextQuery(sp, input.query);
    requestedSessionId = undefined;
    degraded = true;
    degradedPreviousBackendSessionId = previousBackendSessionId;
    pendingLineage = createCliLevel3Lineage(previousBackendSessionId);
  }

  let effectiveReferenceTraceId = existingConfig.referenceTraceId;
  if (existingConfig.referenceTracePath) {
    const referenceReloaded = existingConfig.referenceTraceId
      ? await ctx.service.reloadTraceById(existingConfig.referenceTraceId)
      : false;
    if (!referenceReloaded) {
      effectiveReferenceTraceId = await ctx.service.loadTrace(existingConfig.referenceTracePath);
      logText(ctx, `Reference trace reloaded fresh (traceId=${effectiveReferenceTraceId.slice(0, 8)}…)`);
    }
  } else if (existingConfig.referenceTraceId) {
    const referenceReloaded = await ctx.service.reloadTraceById(existingConfig.referenceTraceId);
    if (!referenceReloaded) {
      throw new Error('comparison session is missing referenceTracePath; cannot reload reference trace');
    }
  }

  const runInput: Parameters<CliAnalyzeService['runTurn']>[0] = {
    traceId: effectiveTraceId,
    referenceTraceId: effectiveReferenceTraceId,
    query: effectiveQuery,
    sessionId: requestedSessionId,
    codeAwareMode: existingConfig.codeAwareMode,
    codebaseIds: existingConfig.codebaseIds,
    knowledgeSourceIds: existingConfig.knowledgeSourceIds,
    analysisMode: existingConfig.analysisMode,
    lineage: pendingLineage,
    turn: nextTurn,
    resolveCliTurnPath: (_sid, turn) => path.join(
      sp.turnsDir,
      `${String(turn).padStart(3, '0')}.md`,
    ),
    onSessionReady: () => {
      ensureSessionLayout(sp);
    },
    onEvent: (update) => {
      ctx.renderer.onEvent(update);
      appendStreamEvent(streamFile, update);
    },
  };
  let result: RunTurnOutput;
  try {
    result = await ctx.service.runTurn(runInput);
  } catch (err) {
    if (!requestedSessionId || !isTraceIdMismatchError(err)) throw err;
    logText(ctx, '(persisted backend session no longer matches this trace — starting a fresh backend turn with CLI transcript context)');
    degraded = true;
    degradedPreviousBackendSessionId = requestedSessionId;
    pendingLineage = createCliLevel3Lineage(requestedSessionId);
    requestedSessionId = undefined;
    result = await ctx.service.runTurn({
      ...runInput,
      sessionId: undefined,
      lineage: pendingLineage,
    });
  }

  const now = Date.now();
  const lineage = degraded
    ? pendingLineage ?? createCliLevel3Lineage(degradedPreviousBackendSessionId ?? previousBackendSessionId)
    : existingConfig.lineage;
  const updatedConfig: CliSessionConfig = {
    ...existingConfig,
    sessionId: userSessionId,
    backendSessionId: result.sessionId,
    lineage,
    traceId: effectiveTraceId,
    referenceTraceId: effectiveReferenceTraceId,
    providerId: result.providerId ?? existingConfig.providerId,
    agentRuntimeKind: result.agentRuntimeKind ?? existingConfig.agentRuntimeKind,
    providerSnapshotHash: result.providerSnapshotHash ?? existingConfig.providerSnapshotHash,
    sdkSessionId: result.sdkSessionId || existingConfig.sdkSessionId,
    model: result.model || existingConfig.model,
    codeAwareMode: result.codeAwareMode,
    lastTurnAt: now,
    turnCount: nextTurn,
  };
  const persistedQuery = result.privateKnowledge
    ? privateAnalysisQueryMessage(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE))
    : input.query;

  const idx = readIndex(ctx.paths);
  const prev = idx.sessions[userSessionId];

  commitTurnOutputs({
    paths: ctx.paths,
    sp,
    renderer: ctx.renderer,
    sessionId: userSessionId,
    turn: nextTurn,
    query: persistedQuery,
    result,
    config: updatedConfig,
    turnMarkdown: formatTurnMarkdown(
      nextTurn,
      persistedQuery,
      result.result.conclusion || '',
      result.result,
      degraded,
      buildLineageNotice(updatedConfig.lineage),
    ),
    indexEntry: {
      sessionId: userSessionId,
      createdAt: prev?.createdAt ?? existingConfig.createdAt,
      lastTurnAt: now,
      tracePath: existingConfig.tracePath,
      traceFilename: prev?.traceFilename ?? path.basename(existingConfig.tracePath),
      firstQuery: result.privateKnowledge ? persistedQuery : prev?.firstQuery ?? persistedQuery,
      turnCount: nextTurn,
      status: result.result.success ? 'completed' : 'failed',
    },
  });
  await completeSourceSupplement(ctx, sp, result, nextTurn);

  if (degraded) {
    const notice = buildLineageNotice(updatedConfig.lineage);
    logText(ctx, `\nnote: ${notice ?? 'SDK context was unavailable — replayed prior conclusion as preamble.'}`);
  }

  return {
    sessionId: userSessionId,
    sessionDir: sp.dir,
    turn: nextTurn,
    success: result.result.success,
    degraded,
  };
}

async function completeSourceSupplement(
  ctx: TurnRunnerContext,
  sp: SessionPaths,
  result: RunTurnOutput,
  turn: number,
): Promise<void> {
  if (!result.sourceSupplementTask) return;
  const supplement = await result.sourceSupplementTask;
  if (!supplement) {
    const failed = {
      type: 'analysis_source_enrichment_failed' as const,
      content: {errorCode: 'analysis_source_enrichment_failed'},
      timestamp: Date.now(),
    };
    ctx.renderer.onEvent(failed);
    appendStreamEvent(sp.stream, failed);
    return;
  }
  result.sourceSupplement = supplement;
  const completed = {
    type: 'analysis_source_enrichment_completed' as const,
    content: supplement,
    timestamp: Date.now(),
  };
  appendStreamEvent(sp.stream, completed);
  commitSourceSupplementOutput({
    sp,
    renderer: ctx.renderer,
    sessionId: result.sessionId,
    turn,
    supplement,
  });
}

function isTraceIdMismatchError(err: unknown): boolean {
  return err instanceof Error && /traceId mismatch for requested session/i.test(err.message);
}

function logText(ctx: TurnRunnerContext, message: string): void {
  if (ctx.renderer.format === 'text') console.log(message);
}

function buildLineageNotice(lineage: CliSessionConfig['lineage']): string | undefined {
  if (!lineage || lineage.reason !== CLI_LEVEL3_LINEAGE_REASON) return undefined;
  return `此会话因 trace 重载已从原会话降级续接（previous backend session: ${lineage.previousBackendSessionId}）。`;
}

function createCliLevel3Lineage(previousBackendSessionId: string): CliSessionLineage {
  return {
    previousBackendSessionId,
    reason: CLI_LEVEL3_LINEAGE_REASON,
    at: Date.now(),
  };
}

export function buildResumeContextQuery(sp: SessionPaths, userQuery: string): string {
  const transcriptTurns = readTranscriptTurns(sp.transcript).slice(-RESUME_MAX_TURNS);
  let context = '';

  if (transcriptTurns.length > 0) {
    context = transcriptTurns
      .map((turn) => {
        const answer = turn.conclusionMd?.trim()
          ? truncateAtBoundary(turn.conclusionMd.trim(), RESUME_TURN_MAX_CHARS)
          : '(empty)';
        return [
          `Turn ${turn.turn}`,
          `Question: ${turn.question}`,
          `Conclusion: ${answer}`,
        ].join('\n');
      })
      .join('\n\n---\n\n');
  } else {
    context = readConclusionContext(sp.conclusion);
  }

  if (!context.trim()) return userQuery;

  const trimmed = context.length > RESUME_CONTEXT_MAX_CHARS
    ? `${truncateAtBoundary(context, RESUME_CONTEXT_MAX_CHARS)}…（已截断）`
    : context;
  const sessionId = path.basename(sp.dir);

  return [
    '（continuing prior SmartPerfetto CLI session; previous context below）',
    `Session id: ${sessionId}`,
    `Session dir: ${sp.dir}`,
    `Report path: ${sp.report}`,
    '---',
    trimmed,
    '---',
    'Use the previous context when it is sufficient; only query the trace again if the new question needs new evidence.',
    `用户新问题: ${userQuery}`,
  ].join('\n');
}

function readConclusionContext(conclusionFile: string): string {
  try {
    return fs.readFileSync(conclusionFile, 'utf-8');
  } catch {
    return '';
  }
}

function readTranscriptTurns(transcriptFile: string): CliTranscriptTurn[] {
  try {
    if (!fs.existsSync(transcriptFile)) return [];
    return fs
      .readFileSync(transcriptFile, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as CliTranscriptTurn;
        } catch {
          return null;
        }
      })
      .filter((turn): turn is CliTranscriptTurn => Boolean(turn && typeof turn.turn === 'number'));
  } catch {
    return [];
  }
}

/**
 * Truncate at a sentence/paragraph boundary at or before `maxChars` so the
 * preamble doesn't end mid-sentence. Falls back to a hard char cut if no
 * suitable boundary exists in the trailing 30% of the window.
 *
 * Boundaries searched (CJK + Latin): paragraph break > full stop > newline.
 */
export function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const minAccept = Math.floor(maxChars * 0.7);
  const candidates = [
    window.lastIndexOf('\n\n'),
    window.lastIndexOf('。'),
    window.lastIndexOf('. '),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('\n'),
  ];
  const best = Math.max(...candidates);
  if (best >= minAccept) {
    // Include the boundary character itself for a clean cut.
    return window.slice(0, best + 1);
  }
  return window;
}

function formatTurnMarkdown(
  turn: number,
  query: string,
  conclusion: string,
  result: { confidence: number; rounds: number; totalDurationMs: number },
  degraded: boolean,
  lineageNotice?: string,
): string {
  const lines: string[] = [
    `# Turn ${turn}`,
    ``,
    `**Question**: ${query}`,
    ``,
    `**Confidence**: ${(result.confidence * 100).toFixed(0)}%  ·  **Rounds**: ${result.rounds}  ·  **Duration**: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    ``,
  ];
  if (lineageNotice) {
    lines.push(`> _${lineageNotice}_`, ``);
  }
  if (degraded) {
    lines.push(`> _Note: SDK context was unavailable for this turn — prior conclusion was replayed as preamble._`, ``);
  }
  lines.push('## Conclusion', '', conclusion || '*(empty)*', '');
  return lines.join('\n');
}
