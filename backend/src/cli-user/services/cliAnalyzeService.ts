// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI Analyze Facade.
 *
 * Wraps agentv3's service layer into a single `runTurn()` call with no
 * Express dependency. This is the CLI's only touch-point with the agentv3
 * internals — everything else (commands, REPL, IO) depends on this facade.
 *
 * Compared to HTTP route's `runAgentDrivenAnalysis()`, this omits:
 *   - SSE broadcasting (no HTTP response)
 *   - conversation_step derivation (frontend-only concern)
 *   - scene reconstruction payload (deferred to PR-future)
 *   - LLM telemetry logging subscription (best-effort, not critical for CLI)
 *
 * It keeps:
 *   - prepareSession / analyze / conclusion capture
 *   - HTML report generation (written to CLI's session folder, not /api/reports)
 *   - sdkSessionId surfacing for subsequent resume
 */

import * as fs from 'fs';
import { AssistantApplicationService } from '../../assistant/application/assistantApplicationService';
import {
  AgentAnalyzeSessionService,
  type AnalyzeManagedSession,
} from '../../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import { createSessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import { getHTMLReportGenerator } from '../../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../../services/agentReportData';
import { normalizeResultForReport } from '../../services/agentResultNormalizer';
import { persistAgentTurn } from '../../services/persistAgentSession';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { installTraceProcessorPrebuilt } from './traceProcessorInstaller';
import type { StreamingUpdate } from '../../agent/types';
import type { ModelRouter } from '../../agent';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';

export interface RunTurnInput {
  tracePath?: string;
  traceId?: string;
  query: string;
  sessionId?: string;
  /** Receives every StreamingUpdate from the orchestrator in real time. */
  onEvent: (update: StreamingUpdate) => void;
  /**
   * Fires once after `prepareSession` resolves, before `analyze()` starts
   * streaming events. Lets callers create the session folder + switch to
   * direct disk writes instead of buffering events in memory.
   */
  onSessionReady?: (sessionId: string) => void;
}

export interface RunTurnOutput {
  sessionId: string;
  traceId: string;
  sdkSessionId?: string;
  result: AnalysisResult;
  /** Absolute path to the generated HTML report, or undefined if generation failed. */
  reportHtml?: string;
  reportError?: string;
  model?: string;
}

/**
 * Singleton per CLI process.
 * - Own `AssistantApplicationService` — no HTTP routes touch it, so the 30-min
 *   idle cleanup (only scheduled from agentRoutes.ts) never runs.
 * - `SessionPersistenceService` writes to `backend/data/sessions/sessions.db`
 *   (the same DB the HTTP server uses — intentional, so REPL sessions are
 *   visible to the web UI and vice versa).
 */
export class CliAnalyzeService {
  private static checkedTraceProcessorPath: string | null = null;
  private static traceProcessorInstallPromise: Promise<void> | null = null;

  // Independent AssistantApplicationService instance — intentionally separate
  // from the HTTP route's instance. The 30-min idle cleanup timer is registered
  // *only* from agentRoutes.ts at server startup, not from this constructor,
  // so a CLI-owned AppService is never subject to abandonment cleanup. This
  // matters because CLI sessions have no SSE clients (AppService's signal for
  // "abandoned"), so a shared instance would prematurely cull them.
  // ⚠ If a future change moves the cleanup timer into AssistantApplicationService's
  // constructor, this design breaks silently — pass `enableIdleCleanup: false` then.
  private readonly appService = new AssistantApplicationService<AnalyzeManagedSession>();
  private readonly persistence: SessionPersistenceService;
  private readonly analyzeService: AgentAnalyzeSessionService<AnalyzeManagedSession>;

  constructor() {
    this.persistence = SessionPersistenceService.getInstance();
    this.analyzeService = new AgentAnalyzeSessionService<AnalyzeManagedSession>({
      assistantAppService: this.appService,
      // agentv3 path never calls into this — agentv2 fallback would. We throw
      // instead of returning a stub so a future wrong turn fails loudly.
      getModelRouter: (): ModelRouter => {
        throw new Error(
          'CliAnalyzeService: getModelRouter() invoked — agentv2 is not supported from the CLI. ' +
          'Ensure CLAUDE_AGENT_SDK / agentv3 is active (unset AI_SERVICE).',
        );
      },
      createSessionLogger,
      sessionPersistenceService: this.persistence,
      // sessionContextManager omitted — AgentAnalyzeSessionService defaults to
      // the module-level singleton internally.
      // Only invoked on resume; PR1 covers fresh analyze only. Returning null
      // lets prepareSession fall through to a new session rather than throw.
      buildRecoveredResultFromContext: () => null,
    });
  }

  async loadTrace(tracePath: string): Promise<string> {
    await this.ensureTraceProcessorAvailable();
    return getTraceProcessorService().loadTraceFromFilePath(tracePath);
  }

  /**
   * Resume-only path: try to reload an existing trace by its original id,
   * preserving identity so the persisted session's `traceId` still matches.
   * Returns true on success, false if the trace file has been evicted from
   * `uploads/traces/` (caller should then degrade to a fresh load).
   */
  async reloadTraceById(traceId: string): Promise<boolean> {
    await this.ensureTraceProcessorAvailable();
    const info = await getTraceProcessorService().getOrLoadTrace(traceId);
    return info !== undefined;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
    // Resolve traceId: either passed in (we assume caller already loaded), or load now.
    let traceId = input.traceId;
    if (!traceId) {
      if (!input.tracePath) {
        throw new Error('runTurn requires either tracePath or traceId');
      }
      traceId = await this.loadTrace(input.tracePath);
    }

    const { sessionId, session } = this.analyzeService.prepareSession({
      traceId,
      query: input.query,
      requestedSessionId: input.sessionId,
    });

    // Bump runSequence for this turn. HTTP route gets the incremented value
    // from an externally-constructed runContext; CLI increments inline so the
    // turn index used by appendMessages (msg-<session>-turn<N>-role) is unique
    // across turns rather than colliding with prior turns of the same session.
    session.runSequence = (session.runSequence || 0) + 1;

    // Surface sessionId to the caller now, before analyze() starts emitting
    // events. Without this, callers must buffer events until runTurn resolves,
    // which accumulates the entire analyze run's output in memory.
    input.onSessionReady?.(sessionId);

    const orchestrator = session.orchestrator;

    // Subscribe to live updates. Wrap in off()-on-finally to avoid handler leaks
    // if runTurn is called multiple times within one CLI process (REPL path).
    const handler = (update: StreamingUpdate) => {
      try {
        input.onEvent(update);
      } catch (err) {
        // Don't let a renderer bug kill the analysis — log and continue.
        console.error('[CliAnalyzeService] onEvent handler threw:', (err as Error).message);
      }
    };
    orchestrator.on('update', handler);

    let result: AnalysisResult;
    try {
      result = await orchestrator.analyze(input.query, sessionId, traceId, {});
    } finally {
      orchestrator.off('update', handler);
    }

    // Persist to SQLite BEFORE building the report — the snapshot is stashed on
    // the session as `_lastSnapshot` and read by the HTML generator. Routes
    // through the same shared helper the HTTP layer uses, so any future schema
    // change applies to both paths automatically.
    persistAgentTurn({
      session,
      sessionId,
      traceId,
      query: input.query,
      result: { conclusion: result.conclusion, totalDurationMs: result.totalDurationMs },
    });

    // sdkSessionId is only populated on ClaudeRuntime (agentv3) — guarded call.
    const sdkSessionId =
      typeof orchestrator.getSdkSessionId === 'function'
        ? orchestrator.getSdkSessionId(sessionId)
        : undefined;

    const reportOutput = this.buildReportHtml(session, result);

    return {
      sessionId,
      traceId,
      sdkSessionId,
      result,
      reportHtml: reportOutput.html,
      reportError: reportOutput.error,
      // The Claude model name is stored on ClaudeRuntime's config; not trivially
      // exposed via IOrchestrator. Left undefined for PR1; fills in PR2 via
      // CLAUDE_MODEL env read if needed for config.json provenance.
      model: process.env.CLAUDE_MODEL,
    };
  }

  /**
   * Build the HTML report for a completed turn. Routes through the shared
   * `normalizeResultForReport` + `buildAgentDrivenReportData` pipeline the
   * HTTP path uses, so CLI and web UI emit identical reports for the same
   * session (same sanitized conclusion text, same derived conclusionContract).
   */
  private buildReportHtml(
    session: AnalyzeManagedSession,
    result: AnalysisResult,
  ): { html?: string; error?: string } {
    try {
      const normalized = normalizeResultForReport(result);
      const reportData = buildAgentDrivenReportData({
        session,
        result: {
          sessionId: session.sessionId,
          success: normalized.success,
          findings: normalized.findings,
          hypotheses: normalized.hypotheses,
          conclusion: normalized.conclusion,
          conclusionContract: normalized.conclusionContract,
          confidence: normalized.confidence,
          rounds: normalized.rounds,
          totalDurationMs: normalized.totalDurationMs,
        },
      });
      const html = getHTMLReportGenerator().generateAgentDrivenHTML(reportData);
      return { html };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async ensureTraceProcessorAvailable(): Promise<void> {
    const traceProcessorPath = getTraceProcessorPath();
    if (CliAnalyzeService.checkedTraceProcessorPath === traceProcessorPath) return;

    if (!fs.existsSync(traceProcessorPath)) {
      if (process.env.TRACE_PROCESSOR_PATH) {
        throw new Error(
          [
            `trace_processor_shell binary not found at TRACE_PROCESSOR_PATH: ${traceProcessorPath}`,
            '',
            'Fix TRACE_PROCESSOR_PATH or unset it to let SmartPerfetto download the pinned binary automatically.',
          ].join('\n'),
        );
      }

      await this.installTraceProcessor(traceProcessorPath);
    }

    try {
      fs.accessSync(traceProcessorPath, fs.constants.X_OK);
    } catch {
      throw new Error(
        [
          `trace_processor_shell is not executable: ${traceProcessorPath}`,
          '',
          `Run \`chmod +x ${traceProcessorPath}\`, or set TRACE_PROCESSOR_PATH to an executable binary.`,
        ].join('\n'),
      );
    }

    CliAnalyzeService.checkedTraceProcessorPath = traceProcessorPath;
  }

  private async installTraceProcessor(traceProcessorPath: string): Promise<void> {
    if (!CliAnalyzeService.traceProcessorInstallPromise) {
      console.error(`trace_processor_shell not found. Downloading pinned Perfetto binary to ${traceProcessorPath}...`);
      CliAnalyzeService.traceProcessorInstallPromise = installTraceProcessorPrebuilt(traceProcessorPath)
        .finally(() => {
          CliAnalyzeService.traceProcessorInstallPromise = null;
        });
    }
    await CliAnalyzeService.traceProcessorInstallPromise;
  }

  /**
   * Best-effort teardown. Called by CLI on process exit to stop the
   * trace_processor_shell subprocess — otherwise Node waits on it.
   */
  async shutdown(): Promise<void> {
    try {
      await getTraceProcessorService().cleanup();
    } catch {
      /* ignore — already cleaned or never started */
    }
  }
}
