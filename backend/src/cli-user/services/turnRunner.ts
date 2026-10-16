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
import { resolveInvocationPath } from '../bootstrap';
import type { CliPaths, SessionPaths } from '../io/paths';
import { ensureSessionLayout, sessionPaths } from '../io/paths';
import type { Renderer } from '../repl/renderer';
import type { CliSessionConfig, CliSessionLineage, CliTranscriptTurn } from '../types';
import type { CliAnalyzeService, RunTurnInput, RunTurnOutput } from './cliAnalyzeService';
import {commitTurnOutputs} from './turnPersistence';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {analysisConfidenceIsGrounded} from '../../agentv3/analysisTermination';
import { loadSession } from '../io/sessionStore';
import { readIndex } from '../io/indexJson';
import { appendStreamEvent } from '../io/transcriptWriter';
import {
  buildComparisonAppendix,
} from '../../services/comparisonAppendixService';
import type {CodeAwareMode} from '../../services/codebase/codeAwareFeature';
import type {CliAnalysisMode, TraceCaptureResult} from '../types';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {toAnalysisHistoryTurn, type AnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {parseAnalysisHistoryTurn} from '../../services/analysisHistoryStore';
import {isTurnInterrupted, TurnInterruptController, TurnInterruptedError, type InterruptSource} from './turnInterrupt';
import type {RequestedSourceDepth} from '../../services/codebase/sourceDepthPolicy';

/**
 * Text output shows the answer while its semantic review runs. json/ndjson keep
 * their exact event stream, so they never receive it (nor "answer readable"),
 * and their first Ctrl-C is therefore always the full abort.
 */
function provisionalAnswerOption(renderer: Renderer,
  interrupt?: TurnInterruptController): Pick<RunTurnInput, 'onProvisionalAnswer'> {
  // Only the text renderer implements printProvisionalConclusion.
  return renderer.printProvisionalConclusion
    ? {onProvisionalAnswer: ({conclusion}) => {
        renderer.printProvisionalConclusion?.(conclusion);
        // From now on the user has read the answer: a stop ends only its review.
        interrupt?.markProvisionalDelivered();
      }}
    : {};
}

/** The turn's stop signals; full abort surfaces as TurnInterruptedError. */
function interruptOptions(interrupt?: TurnInterruptController): Pick<RunTurnInput, 'signal' | 'reviewStopSignal'> {
  return interrupt ? {signal: interrupt.signal, reviewStopSignal: interrupt.reviewStopSignal} : {};
}

async function withTurnInterrupt<T>(ctx: TurnRunnerContext,
  run: (interrupt?: TurnInterruptController) => Promise<T>): Promise<T> {
  const interrupt = ctx.interruptSource ? new TurnInterruptController({source: ctx.interruptSource}) : undefined;
  try {
    return await run(interrupt);
  } catch (error) {
    if (interrupt?.interrupted && !isTurnInterrupted(error)) throw new TurnInterruptedError();
    throw error;
  } finally {
    interrupt?.dispose();
  }
}

const CLI_LEVEL3_LINEAGE_REASON = 'cli-level3-degraded' as const;

export interface TurnRunnerContext {
  paths: CliPaths;
  service: CliAnalyzeService;
  renderer: Renderer;
  /**
   * Ctrl-C source for the running turn (process SIGINT for one-shot commands,
   * readline for the REPL). Without it the turn has no interrupt handling.
   */
  interruptSource?: InterruptSource;
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
  input: StartSessionInput,
): Promise<TurnResult> {
  return withTurnInterrupt(ctx, interrupt => runStartSession(ctx, input, interrupt));
}

interface StartSessionInput {
  tracePath: string;
  query: string;
  referenceTracePath?: string;
  analysisMode?: CliAnalysisMode;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  sourceDepth?: RequestedSourceDepth;
  capture?: TraceCaptureResult;
}

async function runStartSession(
  ctx: TurnRunnerContext,
  input: StartSessionInput,
  interrupt?: TurnInterruptController,
): Promise<TurnResult> {
  const tracePath = resolveInvocationPath(input.tracePath);
  logText(ctx, `Loading trace: ${tracePath}`);
  // loadTraceFromFilePath throws on ENOENT; we let it propagate so there's
  // one source of truth for the existence check.
  const traceId = await ctx.service.loadTrace(tracePath);
  logText(ctx, `Trace loaded (traceId=${traceId.slice(0, 8)}…)`);

  let referenceTracePath: string | undefined;
  let referenceTraceId: string | undefined;
  let reportAppendix: { markdown: string; html: string } | undefined;
  if (input.referenceTracePath) {
    referenceTracePath = resolveInvocationPath(input.referenceTracePath);
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
    sourceDepth: input.sourceDepth,
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
    ...provisionalAnswerOption(ctx.renderer, interrupt),
    ...interruptOptions(interrupt),
  });
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
    model: result.model,
    analysisMode: input.analysisMode,
    codeAwareMode: result.codeAwareMode,
    codebaseIds: input.codebaseIds,
    knowledgeSourceIds: input.knowledgeSourceIds,
    sourceDepth: input.sourceDepth,
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
    query: input.query,
    result,
    config,
    turnMarkdown: formatTurnMarkdown(1, input.query, result.result.conclusion || '', result.result, false),
    reportAppendix,
    indexEntry: {
      sessionId: resolvedSessionId,
      createdAt: startedAt,
      lastTurnAt: now,
      tracePath,
      traceFilename: referenceTracePath
        ? `${path.basename(tracePath)} vs ${path.basename(referenceTracePath)}`
        : path.basename(tracePath),
      firstQuery: input.query,
      turnCount: 1,
      status: result.result.success ? 'completed' : 'failed',
    },
  });
  // The turn is saved: Ctrl-C no longer belongs to it.
  interrupt?.markCommitted();

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
 * Reuse the logical backend session when the trace can be restored. A fresh
 * trace load starts a new backend lineage while keeping the CLI session stable.
 * Both paths supply typed history separately from the current user question.
 */
export async function continueSession(
  ctx: TurnRunnerContext,
  input: { sessionId: string; query: string },
): Promise<TurnResult> {
  return withTurnInterrupt(ctx, interrupt => runContinueSession(ctx, input, interrupt));
}

async function runContinueSession(
  ctx: TurnRunnerContext,
  input: { sessionId: string; query: string },
  interrupt?: TurnInterruptController,
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
  let requestedSessionId: string | undefined;
  let degraded = false;
  let degradedPreviousBackendSessionId: string | undefined;
  let pendingLineage: CliSessionLineage | undefined = existingConfig.lineage;

  if (reloaded) {
    effectiveTraceId = existingConfig.traceId;
    requestedSessionId = previousBackendSessionId;
    logText(ctx, `Trace reloaded (traceId=${effectiveTraceId.slice(0, 8)}…)`);
  } else {
    logText(ctx, '(trace evicted from cache — loading fresh with prior conversation history)');
    effectiveTraceId = await ctx.service.loadTrace(existingConfig.tracePath);
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
    query: input.query,
    history: readCliAnalysisHistory(sp, existingConfig.traceId,
      Boolean(existingConfig.codebaseIds?.length || existingConfig.knowledgeSourceIds?.length)),
    sessionId: requestedSessionId,
    codeAwareMode: existingConfig.codeAwareMode,
    codebaseIds: existingConfig.codebaseIds,
    knowledgeSourceIds: existingConfig.knowledgeSourceIds,
    sourceDepth: existingConfig.sourceDepth,
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
    ...provisionalAnswerOption(ctx.renderer, interrupt),
    ...interruptOptions(interrupt),
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
    model: result.model || existingConfig.model,
    codeAwareMode: result.codeAwareMode,
    lastTurnAt: now,
    turnCount: nextTurn,
  };
  const idx = readIndex(ctx.paths);
  const prev = idx.sessions[userSessionId];

  commitTurnOutputs({
    paths: ctx.paths,
    sp,
    renderer: ctx.renderer,
    sessionId: userSessionId,
    turn: nextTurn,
    query: input.query,
    result,
    config: updatedConfig,
    turnMarkdown: formatTurnMarkdown(
      nextTurn,
      input.query,
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
      firstQuery: prev?.firstQuery ?? input.query,
      turnCount: nextTurn,
      status: result.result.success ? 'completed' : 'failed',
    },
  });
  // The turn is saved: Ctrl-C no longer belongs to it.
  interrupt?.markCommitted();

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

/** Old transcripts stay readable but cannot acquire a completed or verified status from prose. */
export function readCliAnalysisHistory(sp: SessionPaths, traceId: string,
  legacySourceDerived = false): AnalysisHistoryTurn[] {
  const sessionId = path.basename(sp.dir);
  const turns = readTranscriptTurns(sp.transcript);
  const history = turns.flatMap(turn => {
    const stored = parseAnalysisHistoryTurn(turn.history);
    if (stored) return [stored];
    if (typeof turn.question !== 'string' || !Number.isSafeInteger(turn.turn) || turn.turn < 1) return [];
    return [toAnalysisHistoryTurn({id: `${sessionId}:turn:${turn.turn}`, turnIndex: turn.turn - 1,
      query: turn.question, traceId, timestamp: Number.isFinite(turn.timestamp) ? turn.timestamp : 0,
      result: {message: typeof turn.conclusionMd === 'string' ? turn.conclusionMd : ''},
      sourceDerived: legacySourceDerived})];
  });
  if (history.length) return history;
  const answer = readConclusionContext(sp.conclusion);
  return answer.trim() ? [toAnalysisHistoryTurn({id: `${sessionId}:legacy`, turnIndex: 0,
    query: '', traceId, timestamp: 0, result: {message: answer}, sourceDerived: legacySourceDerived})] : [];
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
  result: Pick<AnalysisResult, 'confidence' | 'rounds' | 'totalDurationMs' | 'findings' | 'claimVerificationResult'>,
  degraded: boolean,
  lineageNotice?: string,
): string {
  const claims = result.claimVerificationResult?.claimResults;
  // The no-findings confidence is a fixed baseline; show what was verified instead.
  const assurance = analysisConfidenceIsGrounded(result) || !claims
    ? `**Confidence**: ${(result.confidence * 100).toFixed(0)}%`
    : `**Verified claims**: ${claims.filter(claim => claim.status === 'verified').length}/${claims.length}`;
  const lines: string[] = [
    `# Turn ${turn}`,
    ``,
    `**Question**: ${query}`,
    ``,
    `${assurance}  ·  **Rounds**: ${result.rounds}  ·  **Duration**: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
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
