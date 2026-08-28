// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import 'dotenv/config';
import { installEpipeGuard } from '../utils/epipeGuard';
installEpipeGuard();

import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import agentRoutes from '../routes/agentRoutes';
import ragAdminRoutes from '../routes/ragAdminRoutes';
import skillRoutes from '../routes/skillRoutes';
import traceProcessorRoutes from '../routes/traceProcessorRoutes';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { resolveAgentRuntimeSelection } from '../agentRuntime';
import { getOpenAIRuntimeDiagnostics, hasOpenAICredentials } from '../agentOpenAI';
import type {ConclusionContract} from '../agent/core/conclusionContract';
import type { TraceDataset } from '../agent/core/orchestratorTypes';
import type {
  SelectionContext,
  TracePairContext,
  TracePairLayout,
  TraceSource,
} from '../agentv3/types';
import {
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
} from '../middleware/auth';
import { writeTraceMetadata } from '../services/traceMetadataStore';
import {CodeLookupLedger} from '../services/codebase/codeLookupLedger';
import {hasConcreteCodeReference} from '../services/codebase/codeReferenceContract';
import {verifySourceClaimBindings} from '../services/codebase/sourceClaimVerifier';
import {
  collectMatchedTraceEvidenceRefIdsByClaimId,
  collectVerifiedTraceOccurrenceRefIdsByClaimId,
} from '../services/verifier/claimVerificationRunner';
import type {ClaimVerificationResult} from '../types/claimVerification';
import {
  privateProjectedSourceEventType,
  successfulCodeLookupToolCounts,
} from './agentSseVerificationEvidence';

type CodeAwareMode = 'off' | 'metadata_only' | 'provider_send';
type SmartAction = 'preview' | 'analyze';

export interface VerifyOptions {
  tracePath: string;
  referenceTracePath?: string;
  query: string;
  timeoutMs: number;
  outputPath?: string;
  keepSession: boolean;
  keepTrace: boolean;
  requireConclusionEvidence: boolean;
  /** Analysis mode override forwarded as options.analysisMode to the backend. */
  analysisMode?: 'fast' | 'full' | 'auto';
  /** Analyze preset forwarded as options.preset to the backend. */
  preset?: 'smart';
  /** Frontend-style pre-queried trace datasets forwarded as top-level traceContext. */
  traceContext?: TraceDataset[];
  selectionContext?: SelectionContext;
  /** Smart action forwarded as options.smartAction. Defaults to analyze for --mode smart CLI runs. */
  smartAction?: SmartAction;
  /** Smart scene selection forwarded as options.smartSelection. */
  smartSelection?: {
    scope: 'all' | 'scene_types' | 'scene_ids';
    sceneTypes?: string[];
    sceneIds?: string[];
    label?: string;
  };
  /** Force deterministic prepasses to bypass cached scene reports. */
  forceRefresh: boolean;
  /** Code-aware mode forwarded as options.codeAwareMode to the backend. */
  codeAwareMode?: CodeAwareMode;
  /** Registered codebases exposed to this verification run. */
  codebaseIds: string[];
  /** Registered private knowledge sources exposed to this verification run. */
  knowledgeSourceIds: string[];
  /** Optional source root registered and indexed through the real admin API before analysis. */
  setupCodebaseRoot?: string;
  /** Explicit setup behavior; omitted preserves the historical register-and-index path. */
  setupCodebaseMode?: 'register-only' | 'register-and-index';
  /** Optional Wiki root registered and indexed through the real admin API before analysis. */
  setupKnowledgeRoot?: string;
  /**
   * undefined = use active Provider Manager profile if configured.
   * string = use that explicit provider.
   * null = force env/default fallback and ignore active providers.
   */
  providerId?: string | null;
  /** Require semantic source-level code references in the final conclusion. */
  requireCodeRef: boolean;
  /** Require analysis_completed claim verifier output to pass with no unsupported claims. */
  requireClaimVerifierOk: boolean;
  /** Require the terminal analysis_completed payload to not be marked partial. */
  requireNonPartial: boolean;
  /** Require a final-report heading such as # 性能分析报告 / ## 综合结论 / ## Final Conclusion. */
  requireFinalReportHeading: boolean;
  /** Fail if final text contains process narration such as "enter Phase". */
  forbidProcessNarration: boolean;
  /** Optional upper bound for the final analysis_completed conclusion text length. */
  maxAnalysisCompletedConclusionChars?: number;
  /** Literal text that must appear in a conclusion/analysis_completed event. */
  requiredText: string[];
  /** Literal text that must not appear in a conclusion/analysis_completed event. */
  forbiddenText: string[];
  /** Optional second-turn query sent to the same session after the first turn completes. */
  followUpQuery?: string;
  /** Literal text that must appear in the follow-up conclusion/analysis_completed event. */
  followUpRequiredText: string[];
  /** Tool names that must not be dispatched during the follow-up turn. */
  followUpForbiddenTools: string[];
  /** Degraded fallback names that must not be emitted during the run. */
  forbiddenDegradedFallbacks: string[];
  /** Allow full-mode source/tool checks that intentionally do not emit data envelopes. */
  allowNoDataEnvelopes: boolean;
  /** Require at least one data envelope even in quick mode. */
  requireDataEnvelope: boolean;
  /** Require analysis_completed.quickRun receipt metadata. */
  requireQuickRun: boolean;
  /** Allow capability-limited preview runtimes that only prove routing/SSE/finalization. */
  allowCapabilityLimitedRuntime: boolean;
  /** Require a real source-run-pinned external issue opportunity and Agent triage. */
  requireExternalIssueTriage: boolean;
  /** Tool names that must be dispatched during the run. */
  requiredTools: string[];
  /** Private lookup tools that must return at least one provenance-bearing chunk. */
  requiredSuccessfulLookups: string[];
  /** Skill ids that must be dispatched through invoke_skill during the run. */
  requiredSkills: string[];
  tracePairLayout: TracePairLayout;
  tracePairWorkspaceOpen: boolean;
  tracePairSplitPercent: number;
  tracePairActiveTraceSide: TraceSource;
  tracePairMaximizedTraceSide?: TraceSource;
  tracePairMinimizedTraceSides: TraceSource[];
}

interface SseSummary {
  totalEvents: number;
  terminalEvent?: string;
  /** agentv3 event type counts */
  progressCount: number;
  agentTaskDispatchedCount: number;
  agentResponseCount: number;
  answerTokenCount: number;
  conclusionCount: number;
  dataEnvelopeCount: number;
  planSubmittedCount: number;
  architectureDetectedCount: number;
  degradedCount: number;
  degradedFallbackCounts: Record<string, number>;
  degradedEvents: Array<{
    fallback?: string;
    terminationReason?: string;
    message?: string;
  }>;
  errorEvents: string[];
  /** Number of DataEnvelope objects carried by data events, not just event count. */
  dataEnvelopeItemCount: number;
  dataEnvelopeMissingPhaseCount: number;
  dataEnvelopeAmbiguousPhaseCount: number;
  dataEnvelopeUnexpectedPhaseCount: number;
  dataEnvelopePhaseCounts: Record<string, number>;
  conclusionChars: number;
  conclusionHasConcreteEvidenceRefs: boolean;
  conclusionHasEvidenceIndex: boolean;
  analysisCompletedConclusionChars: number;
  analysisCompletedHasConcreteEvidenceRefs: boolean;
  analysisCompletedHasEvidenceIndex: boolean;
  analysisCompletedHasFinalReportHeading: boolean;
  analysisCompletedHasProcessNarration: boolean;
  claimVerifierStatus?: string;
  claimVerifierPassed?: boolean;
  claimVerifierCheckedClaimCount?: number;
  claimVerifierUnsupportedClaimCount?: number;
  claimVerifierIssueCount?: number;
  conclusionHasConcreteCodeRefs: boolean;
  analysisCompletedHasConcreteCodeRefs: boolean;
  analysisCompletedSourceUseStatus?: string;
  analysisCompletedSourceReferenceCount?: number;
  analysisCompletedSourceBindingCount?: number;
  analysisCompletedSourceClaimVerifierStatus?: string;
  analysisCompletedSourceMechanismStatuses?: string[];
  analysisCompletedSourceReferenceMembershipPassed?: boolean;
  analysisCompletedReportUrl?: string;
  analysisCompletedPartial?: boolean;
  analysisCompletedTerminationReason?: string;
  analysisCompletedTerminationMessage?: string;
  externalIssueSource?: {
    runId: string;
    runManifestId: string;
    resultSnapshotId?: string;
  };
  quickRun?: {
    requestedMode?: string;
    resolvedMode?: string;
    profile?: string;
    targetTurns?: number;
    hardCapTurns?: number;
    actualTurns?: number;
    enforcement?: string;
    stopReason?: string;
    verifierStatus?: string;
    frontendPrequeryInjected?: number;
    frontendPrequeryCited?: number;
    currentRunDataEnvelopes?: number;
    citedEvidenceRefs?: number;
  };
  requiredTextMatches: Record<string, boolean>;
  forbiddenTextMatches: Record<string, boolean>;
  /** Older SSE fields that may still appear in archived sessions/logs. */
  stageNames: string[];
  stageTransitionCount: number;
  directSkillProgressCount: number;
  directSkillCompletedCount: number;
  directSkillFindingCount: number;
  toolCallCounts: Record<string, number>;
  successfulLookupCounts: Record<string, number>;
  skillCallCounts: Record<string, number>;
}

const DEFAULT_TRACE = '../Trace/real/android-scroll-customer/trace.pftrace';
const DEFAULT_QUERY = '分析滑动性能';

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/verifyAgentSseScrolling.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --trace <path>                    Trace path (default: ../Trace/real/android-scroll-customer/trace.pftrace)');
  console.log('  --reference-trace <path>          Reference trace path for raw dual-trace comparison');
  console.log('  --query <text>                    Analyze query (default: 分析滑动性能)');
  console.log('  --timeout-ms <number>             SSE timeout in ms (default: 600000)');
  console.log('  --mode <fast|full|auto|smart>     Override analysisMode, or use smart as shorthand for --preset smart');
  console.log('  --preset <smart>                  Forward preset to the backend');
  console.log('  --trace-context-json <json|@file> Forward frontend-style traceContext datasets');
  console.log('  --selection-context-json <json|@file>');
  console.log('                                      Forward frontend-style selectionContext');
  console.log('  --smart-action <preview|analyze>  Smart action (default: analyze for --mode/--preset smart)');
  console.log('  --smart-scope <all|scene_types|scene_ids>');
  console.log('                                      Smart selection scope (default: all for analyze)');
  console.log('  --smart-scene-type <type>          Smart scene type selection; repeatable');
  console.log('  --smart-scene-id <id>              Smart scene id selection; repeatable');
  console.log('  --force-refresh                   Bypass cached scene reports when supported');
  console.log('  --code-aware <off|metadata_only|provider_send>');
  console.log('                                      Forward codeAwareMode to the backend');
  console.log('  --codebase-id <id>                 Registered codebase id to expose; repeatable');
  console.log('  --knowledge-source-id <id>         Registered private knowledge source id; repeatable');
  console.log('  --setup-codebase-root <path>       Register and index an app-source root before analysis');
  console.log('  --setup-codebase-mode <register-only|register-and-index>');
  console.log('                                      Select setup behavior (default: register-and-index)');
  console.log('  --setup-knowledge-root <path>      Register and index an Android Internals Wiki root before analysis');
  console.log('  --provider-id <id|env|null>        Provider id, or env/null to ignore active providers');
  console.log('  --require-code-ref                 Require source-level code refs in conclusion/analysis_completed text');
  console.log('  --require-claim-verifier-ok        Require analysis_completed claim verifier to pass with no unsupported claims');
  console.log('  --require-non-partial              Fail if analysis_completed is marked partial');
  console.log('  --require-final-report-heading     Require a final-report heading in analysis_completed text');
  console.log('  --forbid-process-narration         Fail if final text contains process narration like entering phases');
  console.log('  --max-analysis-completed-conclusion-chars <number>');
  console.log('                                      Fail if analysis_completed conclusion text exceeds this length');
  console.log('  --require-text <text>              Require literal text in conclusion/analysis_completed; repeatable');
  console.log('  --forbid-text <text>               Forbid literal text in conclusion/analysis_completed; repeatable');
  console.log('  --follow-up-query <text>           Run a second turn against the same session');
  console.log('  --follow-up-require-text <text>    Require literal text in follow-up conclusion; repeatable');
  console.log('  --follow-up-forbid-tool <name>     Fail if follow-up dispatches this tool; repeatable');
  console.log('  --forbid-degraded-fallback <name>  Fail if a degraded event with this fallback is emitted; repeatable');
  console.log('  --require-tool <name>              Require an agent_task_dispatched tool call; repeatable');
  console.log('  --require-successful-lookup <name> Require a successful provenance-bearing private lookup; repeatable');
  console.log('  --require-skill <skillId>          Require an invoke_skill call for a specific skillId; repeatable');
  console.log('  --trace-pair-layout <horizontal|vertical>');
  console.log('                                      Dual-trace visual layout metadata (default: horizontal)');
  console.log('  --trace-pair-workspace-open        Mark both trace panes as visible in the same-page workspace');
  console.log('  --trace-pair-split <number>        Primary pane split percent, clamped to 18..82 (default: 50)');
  console.log('  --trace-pair-active <current|reference>');
  console.log('                                      Active/focused trace pane (default: current)');
  console.log('  --trace-pair-maximized <current|reference>');
  console.log('                                      Mark one trace pane as maximized in tracePairContext');
  console.log('  --trace-pair-minimized <current|reference>');
  console.log('                                      Mark a trace pane as minimized; repeatable');
  console.log('  --require-data-envelope            Require at least one SSE data envelope, including in fast mode');
  console.log('  --require-quick-run                Require analysis_completed.quickRun receipt metadata');
  console.log('  --allow-no-data-envelopes          Do not require data envelopes in full mode');
  console.log('  --allow-capability-limited-runtime Do not require plan/tool/data events for preview runtime smoke tests');
  console.log('  --require-external-issue-triage    Require source-run-pinned M10 opportunity and live Agent review');
  console.log('  --output <path>                   JSON report output path');
  console.log('  --require-conclusion-evidence     Fail unless analysis_completed conclusion has concrete evidence refs');
  console.log('  --keep-session                    Do not delete session after verification');
  console.log('  --keep-trace                      Do not delete loaded trace after verification');
  console.log('  --help                            Show this help');
}

function parseTraceContextArg(value: string): TraceDataset[] {
  const raw = value.startsWith('@')
    ? fs.readFileSync(path.resolve(process.cwd(), value.slice(1)), 'utf8')
    : value;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('--trace-context-json must be a JSON array');
  }
  const datasets = parsed.filter((dataset): dataset is TraceDataset => {
    if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return false;
    const record = dataset as Partial<TraceDataset>;
    return typeof record.label === 'string'
      && Array.isArray(record.columns)
      && record.columns.every((column) => typeof column === 'string')
      && Array.isArray(record.rows)
      && record.rows.every((row) => Array.isArray(row));
  });
  if (datasets.length === 0) {
    throw new Error('--trace-context-json did not contain any valid datasets');
  }
  return datasets;
}

function parseSelectionContextArg(value: string): SelectionContext {
  const raw = value.startsWith('@')
    ? fs.readFileSync(path.resolve(process.cwd(), value.slice(1)), 'utf8')
    : value;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--selection-context-json must be a JSON object');
  }
  return parsed as SelectionContext;
}

export function parseArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {
    tracePath: path.resolve(process.cwd(), DEFAULT_TRACE),
    query: DEFAULT_QUERY,
    timeoutMs: 600_000,
    keepSession: false,
    keepTrace: false,
    forceRefresh: false,
    requireConclusionEvidence: false,
    codebaseIds: [],
    knowledgeSourceIds: [],
    requireCodeRef: false,
    requireClaimVerifierOk: false,
    requireNonPartial: false,
    requireFinalReportHeading: false,
    forbidProcessNarration: false,
    requiredText: [],
    forbiddenText: [],
    followUpRequiredText: [],
    followUpForbiddenTools: [],
    forbiddenDegradedFallbacks: [],
    allowNoDataEnvelopes: false,
    requireDataEnvelope: false,
    requireQuickRun: false,
    allowCapabilityLimitedRuntime: false,
    requireExternalIssueTriage: false,
    requiredTools: [],
    requiredSuccessfulLookups: [],
    requiredSkills: [],
    tracePairLayout: 'horizontal',
    tracePairWorkspaceOpen: false,
    tracePairSplitPercent: 50,
    tracePairActiveTraceSide: 'current',
    tracePairMinimizedTraceSides: [],
  };
  let smartScope: 'all' | 'scene_types' | 'scene_ids' | undefined;
  const smartSceneTypes: string[] = [];
  const smartSceneIds: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--keep-session') {
      options.keepSession = true;
      continue;
    }

    if (arg === '--keep-trace') {
      options.keepTrace = true;
      continue;
    }

    if (arg === '--force-refresh') {
      options.forceRefresh = true;
      continue;
    }

    if (arg === '--require-conclusion-evidence') {
      options.requireConclusionEvidence = true;
      continue;
    }

    if (arg === '--require-code-ref') {
      options.requireCodeRef = true;
      continue;
    }

    if (arg === '--require-claim-verifier-ok') {
      options.requireClaimVerifierOk = true;
      continue;
    }

    if (arg === '--require-non-partial') {
      options.requireNonPartial = true;
      continue;
    }

    if (arg === '--require-final-report-heading') {
      options.requireFinalReportHeading = true;
      continue;
    }

    if (arg === '--forbid-process-narration') {
      options.forbidProcessNarration = true;
      continue;
    }

    if (arg === '--allow-no-data-envelopes') {
      options.allowNoDataEnvelopes = true;
      continue;
    }

    if (arg === '--require-data-envelope') {
      options.requireDataEnvelope = true;
      continue;
    }

    if (arg === '--require-quick-run') {
      options.requireQuickRun = true;
      continue;
    }

    if (arg === '--allow-capability-limited-runtime') {
      options.allowCapabilityLimitedRuntime = true;
      options.allowNoDataEnvelopes = true;
      continue;
    }

    if (arg === '--require-external-issue-triage') {
      options.requireExternalIssueTriage = true;
      continue;
    }

    if (arg === '--trace') {
      if (!next) {
        throw new Error('--trace requires a value');
      }
      options.tracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--reference-trace') {
      if (!next) {
        throw new Error('--reference-trace requires a value');
      }
      options.referenceTracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--query') {
      if (!next) {
        throw new Error('--query requires a value');
      }
      options.query = next;
      i += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      if (!next) {
        throw new Error('--timeout-ms requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${next}`);
      }
      options.timeoutMs = parsed;
      i += 1;
      continue;
    }

    if (arg === '--max-analysis-completed-conclusion-chars') {
      if (!next) {
        throw new Error('--max-analysis-completed-conclusion-chars requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-analysis-completed-conclusion-chars value: ${next}`);
      }
      options.maxAnalysisCompletedConclusionChars = parsed;
      i += 1;
      continue;
    }

    if (arg === '--mode') {
      if (!next) {
        throw new Error('--mode requires a value');
      }
      if (next === 'smart') {
        options.preset = 'smart';
        options.smartAction = options.smartAction ?? 'analyze';
        options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
        i += 1;
        continue;
      }
      if (next !== 'fast' && next !== 'full' && next !== 'auto') {
        throw new Error(`Invalid --mode value: ${next} (expected fast|full|auto|smart)`);
      }
      options.analysisMode = next;
      i += 1;
      continue;
    }

    if (arg === '--preset') {
      if (!next) {
        throw new Error('--preset requires a value');
      }
      if (next !== 'smart') {
        throw new Error(`Invalid --preset value: ${next} (expected smart)`);
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      i += 1;
      continue;
    }

    if (arg === '--trace-context-json') {
      if (!next) {
        throw new Error('--trace-context-json requires a value');
      }
      options.traceContext = parseTraceContextArg(next);
      i += 1;
      continue;
    }

    if (arg === '--selection-context-json') {
      if (!next) {
        throw new Error('--selection-context-json requires a value');
      }
      options.selectionContext = parseSelectionContextArg(next);
      i += 1;
      continue;
    }

    if (arg === '--smart-action') {
      if (!next) {
        throw new Error('--smart-action requires a value');
      }
      if (next !== 'preview' && next !== 'analyze') {
        throw new Error(`Invalid --smart-action value: ${next} (expected preview|analyze)`);
      }
      options.preset = 'smart';
      options.smartAction = next;
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      i += 1;
      continue;
    }

    if (arg === '--smart-scope') {
      if (!next) {
        throw new Error('--smart-scope requires a value');
      }
      if (next !== 'all' && next !== 'scene_types' && next !== 'scene_ids') {
        throw new Error(`Invalid --smart-scope value: ${next} (expected all|scene_types|scene_ids)`);
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartScope = next;
      i += 1;
      continue;
    }

    if (arg === '--smart-scene-type') {
      if (!next) {
        throw new Error('--smart-scene-type requires a value');
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartSceneTypes.push(next);
      smartScope = smartScope ?? 'scene_types';
      i += 1;
      continue;
    }

    if (arg === '--smart-scene-id') {
      if (!next) {
        throw new Error('--smart-scene-id requires a value');
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartSceneIds.push(next);
      smartScope = smartScope ?? 'scene_ids';
      i += 1;
      continue;
    }

    if (arg === '--code-aware') {
      if (!next) {
        throw new Error('--code-aware requires a value');
      }
      if (next !== 'off' && next !== 'metadata_only' && next !== 'provider_send') {
        throw new Error(`Invalid --code-aware value: ${next} (expected off|metadata_only|provider_send)`);
      }
      options.codeAwareMode = next;
      i += 1;
      continue;
    }

    if (arg === '--codebase-id') {
      if (!next) {
        throw new Error('--codebase-id requires a value');
      }
      options.codebaseIds.push(next);
      i += 1;
      continue;
    }

    if (arg === '--knowledge-source-id') {
      if (!next) {
        throw new Error('--knowledge-source-id requires a value');
      }
      options.knowledgeSourceIds.push(next);
      i += 1;
      continue;
    }

    if (arg === '--setup-codebase-root') {
      if (!next) {
        throw new Error('--setup-codebase-root requires a value');
      }
      options.setupCodebaseRoot = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--setup-codebase-mode') {
      if (!next) {
        throw new Error('--setup-codebase-mode requires a value');
      }
      if (next !== 'register-only' && next !== 'register-and-index') {
        throw new Error(
          `Invalid --setup-codebase-mode value: ${next} (expected register-only|register-and-index)`,
        );
      }
      options.setupCodebaseMode = next;
      i += 1;
      continue;
    }

    if (arg === '--setup-knowledge-root') {
      if (!next) {
        throw new Error('--setup-knowledge-root requires a value');
      }
      options.setupKnowledgeRoot = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--provider-id') {
      if (!next) {
        throw new Error('--provider-id requires a value');
      }
      options.providerId = normalizeProviderIdArg(next);
      i += 1;
      continue;
    }

    if (arg === '--require-text') {
      if (!next) {
        throw new Error('--require-text requires a value');
      }
      options.requiredText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--forbid-text') {
      if (!next) {
        throw new Error('--forbid-text requires a value');
      }
      options.forbiddenText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--follow-up-query') {
      if (!next) {
        throw new Error('--follow-up-query requires a value');
      }
      options.followUpQuery = next;
      i += 1;
      continue;
    }

    if (arg === '--follow-up-require-text') {
      if (!next) {
        throw new Error('--follow-up-require-text requires a value');
      }
      options.followUpRequiredText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--follow-up-forbid-tool') {
      if (!next) {
        throw new Error('--follow-up-forbid-tool requires a value');
      }
      options.followUpForbiddenTools.push(next);
      i += 1;
      continue;
    }

    if (arg === '--forbid-degraded-fallback') {
      if (!next) {
        throw new Error('--forbid-degraded-fallback requires a value');
      }
      options.forbiddenDegradedFallbacks.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-tool') {
      if (!next) {
        throw new Error('--require-tool requires a value');
      }
      options.requiredTools.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-successful-lookup') {
      if (!next) {
        throw new Error('--require-successful-lookup requires a value');
      }
      options.requiredSuccessfulLookups.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-skill') {
      if (!next) {
        throw new Error('--require-skill requires a value');
      }
      options.requiredSkills.push(next);
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-layout') {
      if (!next) {
        throw new Error('--trace-pair-layout requires a value');
      }
      if (next !== 'horizontal' && next !== 'vertical') {
        throw new Error(`Invalid --trace-pair-layout value: ${next} (expected horizontal|vertical)`);
      }
      options.tracePairLayout = next;
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-workspace-open') {
      options.tracePairWorkspaceOpen = true;
      continue;
    }

    if (arg === '--trace-pair-split') {
      if (!next) {
        throw new Error('--trace-pair-split requires a value');
      }
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --trace-pair-split value: ${next}`);
      }
      options.tracePairSplitPercent = parsed;
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-active') {
      if (!next) {
        throw new Error('--trace-pair-active requires a value');
      }
      options.tracePairActiveTraceSide = parseTraceSourceArg(next, '--trace-pair-active');
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-maximized') {
      if (!next) {
        throw new Error('--trace-pair-maximized requires a value');
      }
      options.tracePairMaximizedTraceSide = parseTraceSourceArg(next, '--trace-pair-maximized');
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-minimized') {
      if (!next) {
        throw new Error('--trace-pair-minimized requires a value');
      }
      const traceSide = parseTraceSourceArg(next, '--trace-pair-minimized');
      if (!options.tracePairMinimizedTraceSides.includes(traceSide)) {
        options.tracePairMinimizedTraceSides.push(traceSide);
      }
      i += 1;
      continue;
    }

    if (arg === '--output') {
      if (!next) {
        throw new Error('--output requires a value');
      }
      options.outputPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.preset === 'smart') {
    options.smartAction = options.smartAction ?? 'analyze';
    if (options.smartAction === 'analyze') {
      const scope = smartScope ?? 'all';
      if (scope === 'scene_types') {
        if (smartSceneTypes.length === 0) {
          throw new Error('--smart-scope scene_types requires --smart-scene-type');
        }
        options.smartSelection = {
          scope,
          sceneTypes: Array.from(new Set(smartSceneTypes)),
          label: 'CLI scene_types',
        };
      } else if (scope === 'scene_ids') {
        if (smartSceneIds.length === 0) {
          throw new Error('--smart-scope scene_ids requires --smart-scene-id');
        }
        options.smartSelection = {
          scope,
          sceneIds: Array.from(new Set(smartSceneIds)),
          label: 'CLI scene_ids',
        };
      } else {
        options.smartSelection = { scope: 'all', label: 'CLI all scenes' };
      }
    }
  }

  if (options.setupCodebaseMode && !options.setupCodebaseRoot) {
    throw new Error('--setup-codebase-mode requires --setup-codebase-root');
  }

  return options;
}

function parseTraceSourceArg(value: string, flag: string): TraceSource {
  if (value === 'current' || value === 'reference') return value;
  throw new Error(`Invalid ${flag} value: ${value} (expected current|reference)`);
}

function normalizeProviderIdArg(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'env' || normalized === 'null' || normalized === 'none' || normalized === 'default') {
    return null;
  }
  if (value.trim() === '') {
    throw new Error('--provider-id must not be empty');
  }
  return value;
}

function createVerificationApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  app.use('/api/agent/v1', agentRoutes);
  app.use('/api/rag', ragAdminRoutes);
  app.use('/api/trace-processor', traceProcessorRoutes);
  app.use('/api/skills', skillRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

async function postJsonOrThrow(
  baseUrl: string,
  route: string,
  body?: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(method === 'POST'
      ? {
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body ?? {}),
        }
      : {}),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || payload.success === false) {
    throw new Error(`Context setup failed (${route}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

type SetupRequest = typeof postJsonOrThrow;

export interface AnalysisContextSetupResult {
  codebases: Array<{
    codebaseId: string;
    setupMode: 'register-only' | 'register-and-index';
    chunkCount: number;
    activeIndexState: 'active' | 'none';
    activeGeneration?: string;
    pendingGeneration: boolean;
    reindexRequests: number;
  }>;
}

export async function setupAnalysisContext(
  baseUrl: string,
  options: VerifyOptions,
  request: SetupRequest = postJsonOrThrow,
): Promise<AnalysisContextSetupResult> {
  const result: AnalysisContextSetupResult = {codebases: []};
  if (options.setupCodebaseRoot) {
    const setupMode = options.setupCodebaseMode ?? 'register-and-index';
    const registration = await request(baseUrl, '/api/rag/codebases/register', {
      kind: 'app_source',
      displayName: 'DeepSeek E2E App Source',
      rootPath: options.setupCodebaseRoot,
      sendToProvider: true,
    });
    const codebase = asRecord(registration.codebase);
    const codebaseId = typeof codebase?.codebaseId === 'string' ? codebase.codebaseId : '';
    if (!codebaseId) throw new Error('Context setup did not return a codebaseId');
    let reindexRequests = 0;
    if (setupMode === 'register-and-index') {
      await request(
        baseUrl,
        `/api/rag/codebases/${encodeURIComponent(codebaseId)}/reindex`,
        {},
      );
      reindexRequests = 1;
    }

    const auditPayload = await request(
      baseUrl,
      `/api/rag/codebases/${encodeURIComponent(codebaseId)}/audit`,
      undefined,
      'GET',
    );
    const audit = asRecord(auditPayload.audit);
    if (!audit || audit.codebaseId !== codebaseId) {
      throw new Error('Context setup audit did not return the registered codebase');
    }
    const chunkCount = typeof audit.chunkCount === 'number' ? audit.chunkCount : 0;
    const activeIndexState: 'active' | 'none' = audit.activeIndexState === 'active'
      ? 'active'
      : 'none';
    const activeGeneration = typeof audit.activeGeneration === 'string'
      ? audit.activeGeneration
      : undefined;
    const pendingGeneration = Boolean(audit.pendingGeneration);
    if (
      setupMode === 'register-only' &&
      (
        chunkCount !== 0 ||
        activeIndexState !== 'none' ||
        activeGeneration !== undefined ||
        pendingGeneration ||
        reindexRequests !== 0
      )
    ) {
      throw new Error('register-only setup returned an indexed or active audited codebase state');
    }
    if (
      setupMode === 'register-and-index' &&
      (
        chunkCount <= 0 ||
        activeIndexState !== 'active' ||
        activeGeneration === undefined ||
        pendingGeneration
      )
    ) {
      throw new Error('register-and-index setup did not produce an active audited index');
    }
    result.codebases.push({
      codebaseId,
      setupMode,
      chunkCount,
      activeIndexState,
      activeGeneration,
      pendingGeneration,
      reindexRequests,
    });
    options.codebaseIds.push(codebaseId);
    options.codeAwareMode ??= 'provider_send';
  }

  if (options.setupKnowledgeRoot) {
    const registration = await postJsonOrThrow(baseUrl, '/api/rag/android-internals/sources', {
      rootPath: options.setupKnowledgeRoot,
      displayName: 'DeepSeek E2E Android Internals',
      rightsAcknowledged: true,
      sendToProvider: true,
    });
    const source = asRecord(registration.source);
    const sourceId = typeof source?.sourceId === 'string' ? source.sourceId : '';
    if (!sourceId) throw new Error('Context setup did not return a knowledge source id');
    await postJsonOrThrow(
      baseUrl,
      `/api/rag/android-internals/sources/${encodeURIComponent(sourceId)}/reindex`,
      {},
    );
    options.knowledgeSourceIds.push(sourceId);
  }

  options.codebaseIds = Array.from(new Set(options.codebaseIds));
  options.knowledgeSourceIds = Array.from(new Set(options.knowledgeSourceIds));
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizeDispatchedToolName(toolName: string): string {
  const match = toolName.match(/^mcp__.+?__(.+)$/);
  return match?.[1] ?? toolName;
}

function recordToolCall(summary: SseSummary, toolName: string): void {
  summary.toolCallCounts[toolName] = (summary.toolCallCounts[toolName] ?? 0) + 1;
  const normalized = normalizeDispatchedToolName(toolName);
  if (normalized !== toolName) {
    summary.toolCallCounts[normalized] = (summary.toolCallCounts[normalized] ?? 0) + 1;
  }
}

function recordClaimVerifierSummary(summary: SseSummary, payload: Record<string, unknown> | null): void {
  const direct = asRecord(payload?.claimVerificationResult);
  const nested = asRecord(asRecord(payload?.qualityArtifacts)?.claimVerificationResult);
  const verifier = direct ?? nested;
  if (!verifier) return;

  if (typeof verifier.status === 'string') summary.claimVerifierStatus = verifier.status;
  if (typeof verifier.passed === 'boolean') summary.claimVerifierPassed = verifier.passed;
  if (typeof verifier.checkedClaimCount === 'number') {
    summary.claimVerifierCheckedClaimCount = verifier.checkedClaimCount;
  }
  if (typeof verifier.unsupportedClaimCount === 'number') {
    summary.claimVerifierUnsupportedClaimCount = verifier.unsupportedClaimCount;
  }
  if (Array.isArray(verifier.issues)) {
    summary.claimVerifierIssueCount = verifier.issues.length;
  }
}

function hasConcreteEvidenceReferences(text: string): boolean {
  return /art-\d+|data:[a-z0-9_:.:-]+|evidence_ref_id\s*=|evidence\s*(ref|id|source)\s*[:=]|source_ref\s*=|表\s*(?:art-\d+|sql:\d+)|\bsql:\d+\b/i.test(text);
}

function hasEvidenceIndex(text: string): boolean {
  return /证据(?:表)?索引/.test(text);
}

function hasFinalReportHeading(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,3}\s*(?:(?:[^\n#]{0,40})?分析报告|综合结论|最终结论|最终报告|Final Conclusion|Final Report|Analysis Report)(?=\s|[：:。.!！?\n]|$)/i.test(text);
}

function hasProcessNarration(text: string): boolean {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(compact) ||
    /(?:现在|接下来|下一步).{0,40}(?:完成|进入|继续).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(compact) ||
    /(?:现在完成|现在进入|进入|继续执行).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(compact) ||
    /(?:update_plan_phase|submit_plan|resolve_hypothesis|阶段状态更新|执行剩余阶段|继续执行剩余阶段|OpenAI plan|provider 未主动结束 stream|plan 未完成|plan 已完成)/i.test(compact);
}

function clampTracePairSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(82, Math.max(18, Math.round(value)));
}

function isTracePairPaneLive(
  options: VerifyOptions,
  traceSide: TraceSource,
): boolean {
  if (!options.tracePairWorkspaceOpen) return traceSide === 'current';
  if (
    options.tracePairMaximizedTraceSide &&
    options.tracePairMaximizedTraceSide !== traceSide
  ) {
    return false;
  }
  return !options.tracePairMinimizedTraceSides.includes(traceSide);
}

function buildTracePairContextForVerification(input: {
  options: VerifyOptions;
  traceId: string;
  referenceTraceId: string;
}): TracePairContext {
  const { options, traceId, referenceTraceId } = input;
  const primarySide = options.tracePairLayout === 'vertical' ? 'top' : 'left';
  const referenceSide = options.tracePairLayout === 'vertical' ? 'bottom' : 'right';
  const activeSide = options.tracePairActiveTraceSide === 'reference'
    ? referenceSide
    : primarySide;

  return {
    schemaVersion: 1,
    layout: options.tracePairLayout,
    primarySide,
    referenceSide,
    activeSide,
    workspaceOpen: options.tracePairWorkspaceOpen,
    splitPercent: clampTracePairSplitPercent(options.tracePairSplitPercent),
    ...(options.tracePairMaximizedTraceSide
      ? { maximizedTraceSide: options.tracePairMaximizedTraceSide }
      : {}),
    ...(options.tracePairMinimizedTraceSides.length > 0
      ? { minimizedTraceSides: options.tracePairMinimizedTraceSides }
      : {}),
    aliases: {
      left: 'current',
      top: 'current',
      primary: 'current',
      main: 'current',
      current: 'current',
      '左': 'current',
      '左侧': 'current',
      '上': 'current',
      '上方': 'current',
      '主': 'current',
      '当前': 'current',
      right: 'reference',
      bottom: 'reference',
      reference: 'reference',
      baseline: 'reference',
      '右': 'reference',
      '右侧': 'reference',
      '下': 'reference',
      '下方': 'reference',
      '参考': 'reference',
    },
    panes: [
      {
        side: primarySide,
        traceSide: 'current',
        traceId,
        traceName: path.basename(options.tracePath),
        active: options.tracePairActiveTraceSide === 'current',
        visualState: isTracePairPaneLive(options, 'current') ? 'live' : 'context_only',
      },
      {
        side: referenceSide,
        traceSide: 'reference',
        traceId: referenceTraceId,
        traceName: path.basename(options.referenceTracePath || 'reference.trace'),
        active: options.tracePairActiveTraceSide === 'reference',
        visualState: isTracePairPaneLive(options, 'reference') ? 'live' : 'context_only',
      },
    ],
  };
}

interface TextChecks {
  requiredText: string[];
  forbiddenText: string[];
}

function recordTextChecks(summary: SseSummary, text: string, checks: TextChecks): void {
  for (const required of checks.requiredText) {
    if (!summary.requiredTextMatches[required] && text.includes(required)) {
      summary.requiredTextMatches[required] = true;
    }
  }
  for (const forbidden of checks.forbiddenText) {
    if (!summary.forbiddenTextMatches[forbidden] && text.includes(forbidden)) {
      summary.forbiddenTextMatches[forbidden] = true;
    }
  }
}

function extractDataEnvelopes(parsed: unknown, parsedRecord: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const candidates = [
    parsedRecord?.envelope,
    asRecord(parsedRecord?.data)?.envelope,
    parsed,
    parsedRecord?.data,
    asRecord(parsedRecord?.data)?.data,
    parsedRecord?.content,
    asRecord(parsedRecord?.content)?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
    }

    const record = asRecord(candidate);
    if (record && asRecord(record.meta)) {
      return [record];
    }
  }

  return [];
}

function recordConclusionEvidence(
  summary: SseSummary,
  text: string,
  target: 'conclusion' | 'analysis_completed',
): void {
  if (target === 'conclusion') {
    summary.conclusionChars = Math.max(summary.conclusionChars, text.length);
    summary.conclusionHasConcreteEvidenceRefs ||= hasConcreteEvidenceReferences(text);
    summary.conclusionHasEvidenceIndex ||= hasEvidenceIndex(text);
    summary.conclusionHasConcreteCodeRefs ||= hasConcreteCodeReference(text);
    return;
  }

  summary.analysisCompletedConclusionChars = Math.max(
    summary.analysisCompletedConclusionChars,
    text.length,
  );
  summary.analysisCompletedHasConcreteEvidenceRefs ||= hasConcreteEvidenceReferences(text);
  summary.analysisCompletedHasEvidenceIndex ||= hasEvidenceIndex(text);
  summary.analysisCompletedHasFinalReportHeading ||= hasFinalReportHeading(text);
  summary.analysisCompletedHasProcessNarration ||= hasProcessNarration(text);
  summary.analysisCompletedHasConcreteCodeRefs ||= hasConcreteCodeReference(text);
}

async function collectSseSummary(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
  textChecks: TextChecks,
  options: { runId?: string } = {},
): Promise<SseSummary> {
  const summary: SseSummary = {
    totalEvents: 0,
    progressCount: 0,
    agentTaskDispatchedCount: 0,
    agentResponseCount: 0,
    answerTokenCount: 0,
    conclusionCount: 0,
    dataEnvelopeCount: 0,
    planSubmittedCount: 0,
    architectureDetectedCount: 0,
    degradedCount: 0,
    degradedFallbackCounts: {},
    degradedEvents: [],
    errorEvents: [],
    dataEnvelopeItemCount: 0,
    dataEnvelopeMissingPhaseCount: 0,
    dataEnvelopeAmbiguousPhaseCount: 0,
    dataEnvelopeUnexpectedPhaseCount: 0,
    dataEnvelopePhaseCounts: {},
    conclusionChars: 0,
    conclusionHasConcreteEvidenceRefs: false,
    conclusionHasEvidenceIndex: false,
    analysisCompletedConclusionChars: 0,
    analysisCompletedHasConcreteEvidenceRefs: false,
    analysisCompletedHasEvidenceIndex: false,
    analysisCompletedHasFinalReportHeading: false,
    analysisCompletedHasProcessNarration: false,
    conclusionHasConcreteCodeRefs: false,
    analysisCompletedHasConcreteCodeRefs: false,
    requiredTextMatches: Object.fromEntries(textChecks.requiredText.map((text) => [text, false])),
    forbiddenTextMatches: Object.fromEntries(textChecks.forbiddenText.map((text) => [text, false])),
    stageNames: [],
    stageTransitionCount: 0,
    directSkillProgressCount: 0,
    directSkillCompletedCount: 0,
    directSkillFindingCount: 0,
    toolCallCounts: {},
    successfulLookupCounts: {},
    skillCallCounts: {},
  };

  const stageNameSet = new Set<string>();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const streamPath = options.runId
      ? `/api/agent/v1/runs/${options.runId}/stream`
      : `/api/agent/v1/${sessionId}/stream`;
    const response = await fetch(`${baseUrl}${streamPath}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let shouldStop = false;

    while (!shouldStop) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');

      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);

        if (block !== '' && !block.startsWith(':')) {
          let event = 'message';
          const dataLines: string[] = [];

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          const dataText = dataLines.join('\n');
          let parsed: unknown = dataText;
          if (dataText !== '') {
            try {
              parsed = JSON.parse(dataText);
            } catch {
              parsed = dataText;
            }
          }

          summary.totalEvents += 1;
          summary.terminalEvent = event;

          const parsedRecord = asRecord(parsed);
          const payload = asRecord(parsedRecord?.data) ?? parsedRecord;

          // --- agentv3 event counting ---
          switch (event) {
            case 'progress': {
              summary.progressCount += 1;
              const sourceEventType = privateProjectedSourceEventType(payload);
              if (sourceEventType === 'plan_submitted') {
                summary.planSubmittedCount += 1;
              } else if (sourceEventType === 'agent_response') {
                summary.agentResponseCount += 1;
              } else if (sourceEventType === 'degraded') {
                summary.degradedCount += 1;
                const fallback = typeof payload?.degradedFallback === 'string'
                  ? payload.degradedFallback
                  : undefined;
                if (fallback) {
                  summary.degradedFallbackCounts[fallback] =
                    (summary.degradedFallbackCounts[fallback] ?? 0) + 1;
                }
                summary.degradedEvents.push(fallback ? {fallback} : {});
              }
              break;
            }
            case 'agent_task_dispatched':
              summary.agentTaskDispatchedCount += 1;
              if (typeof payload?.toolName === 'string') {
                recordToolCall(summary, payload.toolName);
              }
              {
                const args = asRecord(payload?.args);
                if (typeof args?.skillId === 'string') {
                  summary.skillCallCounts[args.skillId] = (summary.skillCallCounts[args.skillId] ?? 0) + 1;
                }
              }
              break;
            case 'agent_response':
              summary.agentResponseCount += 1;
              break;
            case 'answer_token':
              summary.answerTokenCount += 1;
              break;
            case 'conclusion':
              summary.conclusionCount += 1;
              if (typeof payload?.conclusion === 'string') {
                recordTextChecks(summary, payload.conclusion, textChecks);
                recordConclusionEvidence(summary, payload.conclusion, 'conclusion');
              }
              break;
            case 'data':
              summary.dataEnvelopeCount += 1;
              for (const envelope of extractDataEnvelopes(parsed, parsedRecord)) {
                const meta = asRecord(envelope.meta);
                const phaseId = typeof meta?.planPhaseId === 'string' ? meta.planPhaseId : '';
                const attribution = typeof meta?.planPhaseAttribution === 'string'
                  ? meta.planPhaseAttribution
                  : '';
                summary.dataEnvelopeItemCount += 1;
                summary.dataEnvelopePhaseCounts[phaseId || '<missing>'] =
                  (summary.dataEnvelopePhaseCounts[phaseId || '<missing>'] || 0) + 1;
                if (!phaseId) summary.dataEnvelopeMissingPhaseCount += 1;
                if (attribution === 'ambiguous') summary.dataEnvelopeAmbiguousPhaseCount += 1;
                if (attribution === 'unexpected_tool') summary.dataEnvelopeUnexpectedPhaseCount += 1;
              }
              break;
            case 'plan_submitted':
              summary.planSubmittedCount += 1;
              break;
            case 'architecture_detected':
              summary.architectureDetectedCount += 1;
              break;
            case 'degraded':
              summary.degradedCount += 1;
              if (typeof payload?.fallback === 'string') {
                summary.degradedFallbackCounts[payload.fallback] =
                  (summary.degradedFallbackCounts[payload.fallback] ?? 0) + 1;
              }
              summary.degradedEvents.push({
                ...(typeof payload?.fallback === 'string' ? { fallback: payload.fallback } : {}),
                ...(typeof payload?.terminationReason === 'string' ? { terminationReason: payload.terminationReason } : {}),
                ...(typeof payload?.message === 'string' ? { message: payload.message } : {}),
              });
              break;
            default:
              break;
          }

          if (event === 'analysis_completed') {
            if (typeof payload?.conclusion === 'string') {
              recordTextChecks(summary, payload.conclusion, textChecks);
              recordConclusionEvidence(summary, payload.conclusion, 'analysis_completed');
            }
            recordClaimVerifierSummary(summary, payload);
            const conclusionContract = asRecord(payload?.conclusionContract);
            const sourceUseDecision = asRecord(conclusionContract?.sourceUseDecision);
            if (typeof sourceUseDecision?.status === 'string') {
              summary.analysisCompletedSourceUseStatus = sourceUseDecision.status;
            }
            if (Array.isArray(sourceUseDecision?.references)) {
              summary.analysisCompletedSourceReferenceCount = sourceUseDecision.references.length;
            }
            if (Array.isArray(conclusionContract?.sourceClaimBindings)) {
              summary.analysisCompletedSourceBindingCount = conclusionContract.sourceClaimBindings.length;
            }
            const claimVerificationResult = asRecord(payload?.claimVerificationResult);
            if (
              conclusionContract?.schemaVersion === 'conclusion_contract_v1' &&
              sourceUseDecision?.schemaVersion === 'source_use_decision@1' &&
              claimVerificationResult?.schemaVersion === 'claim_verifier@1'
            ) {
              const typedContract = conclusionContract as unknown as ConclusionContract;
              const typedClaimVerification = claimVerificationResult as unknown as ClaimVerificationResult;
              const sourceClaimVerification = verifySourceClaimBindings({
                conclusionContract: typedContract,
                actualSourceUseDecision: typedContract.sourceUseDecision,
                matchedTraceEvidenceRefIdsByClaimId:
                  collectMatchedTraceEvidenceRefIdsByClaimId(typedClaimVerification),
                verifiedTraceOccurrenceRefIdsByClaimId:
                  collectVerifiedTraceOccurrenceRefIdsByClaimId(typedClaimVerification),
              });
              const returnedReferenceIds = new Set(
                typedContract.sourceUseDecision?.references.map(reference => reference.id) ?? [],
              );
              summary.analysisCompletedSourceClaimVerifierStatus = sourceClaimVerification.status;
              summary.analysisCompletedSourceMechanismStatuses = sourceClaimVerification.bindings
                .map(binding => binding.mechanismStatus);
              summary.analysisCompletedSourceReferenceMembershipPassed =
                sourceClaimVerification.bindings.length > 0 &&
                sourceClaimVerification.bindings.every(binding =>
                  binding.sourceReferenceIds.every(referenceId => returnedReferenceIds.has(referenceId)));
            }
            if (typeof payload?.reportUrl === 'string') {
              summary.analysisCompletedReportUrl = payload.reportUrl;
            }
            if (typeof payload?.partial === 'boolean') {
              summary.analysisCompletedPartial = payload.partial;
            }
            if (typeof payload?.terminationReason === 'string') {
              summary.analysisCompletedTerminationReason = payload.terminationReason;
            }
            if (typeof payload?.terminationMessage === 'string') {
              summary.analysisCompletedTerminationMessage = payload.terminationMessage;
            }
            const receipt = asRecord(payload?.analysisReceipt);
            const receiptOutputs = asRecord(receipt?.outputs);
            if (
              typeof receipt?.runId === 'string' &&
              typeof receipt.runManifestId === 'string'
            ) {
              summary.externalIssueSource = {
                runId: receipt.runId,
                runManifestId: receipt.runManifestId,
                ...(typeof receiptOutputs?.resultSnapshotId === 'string'
                  ? {resultSnapshotId: receiptOutputs.resultSnapshotId}
                  : {}),
              };
            }
            if (payload?.quickRun && typeof payload.quickRun === 'object' && !Array.isArray(payload.quickRun)) {
              const quickRun = payload.quickRun as Record<string, any>;
              const evidence = quickRun.evidence && typeof quickRun.evidence === 'object'
                ? quickRun.evidence as Record<string, any>
                : {};
              summary.quickRun = {
                ...(typeof quickRun.requestedMode === 'string' ? { requestedMode: quickRun.requestedMode } : {}),
                ...(typeof quickRun.resolvedMode === 'string' ? { resolvedMode: quickRun.resolvedMode } : {}),
                ...(typeof quickRun.profile === 'string' ? { profile: quickRun.profile } : {}),
                ...(typeof quickRun.targetTurns === 'number' ? { targetTurns: quickRun.targetTurns } : {}),
                ...(typeof quickRun.hardCapTurns === 'number' ? { hardCapTurns: quickRun.hardCapTurns } : {}),
                ...(typeof quickRun.actualTurns === 'number' ? { actualTurns: quickRun.actualTurns } : {}),
                ...(typeof quickRun.enforcement === 'string' ? { enforcement: quickRun.enforcement } : {}),
                ...(typeof quickRun.stopReason === 'string' ? { stopReason: quickRun.stopReason } : {}),
                ...(typeof quickRun.verifierStatus === 'string' ? { verifierStatus: quickRun.verifierStatus } : {}),
                ...(typeof evidence.frontendPrequeryInjected === 'number' ? { frontendPrequeryInjected: evidence.frontendPrequeryInjected } : {}),
                ...(typeof evidence.frontendPrequeryCited === 'number' ? { frontendPrequeryCited: evidence.frontendPrequeryCited } : {}),
                ...(typeof evidence.currentRunDataEnvelopes === 'number' ? { currentRunDataEnvelopes: evidence.currentRunDataEnvelopes } : {}),
                ...(typeof evidence.citedEvidenceRefs === 'number' ? { citedEvidenceRefs: evidence.citedEvidenceRefs } : {}),
              };
            }
          }

          // --- Older SSE counting (backwards compat) ---
          if (event === 'stage_transition') {
            const stageName = typeof payload?.stageName === 'string' ? payload.stageName : undefined;
            if (stageName) {
              stageNameSet.add(stageName);
              summary.stageTransitionCount += 1;
            }
          }

          if (event === 'progress') {
            const message = typeof payload?.message === 'string' ? payload.message : '';
            if (message.includes('DirectSkill[jank_frame_detail]')) {
              summary.directSkillProgressCount += 1;
            }
            if (message.includes('DirectSkillExecutor: completed')) {
              summary.directSkillCompletedCount += 1;
            }
          }

          if (event === 'finding') {
            const findingsContainer = asRecord(parsedRecord?.data);
            const findingsRaw = findingsContainer?.findings;
            if (Array.isArray(findingsRaw)) {
              for (const finding of findingsRaw) {
                const findingRecord = asRecord(finding);
                const source = typeof findingRecord?.source === 'string' ? findingRecord.source : '';
                if (source.includes('direct_skill:jank_frame_detail')) {
                  summary.directSkillFindingCount += 1;
                }
              }
            }
          }

          if (event === 'error') {
            if (typeof payload?.message === 'string') {
              summary.errorEvents.push(payload.message);
            } else {
              summary.errorEvents.push(typeof parsed === 'string' ? parsed : 'Unknown SSE error event');
            }
          }

          if (event === 'analysis_completed' || event === 'end') {
            shouldStop = true;
            break;
          }
        }

        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    await reader.cancel();
  } finally {
    clearTimeout(timeout);
  }

  summary.stageNames = Array.from(stageNameSet);
  return summary;
}

interface ExternalIssueE2eVerification {
  checks: Record<string, boolean>;
  passed: boolean;
  summary: {
    opportunityStatus?: string;
    signalKinds: string[];
    reviewSource?: string;
    candidateDecisions: string[];
    candidateOwnership: string[];
    draftAttempted: boolean;
    draftNotSubmitted?: boolean;
    githubUrlIsHttps?: boolean;
  };
}

async function verifyExternalIssueTriage(
  baseUrl: string,
  sessionId: string,
  source: SseSummary['externalIssueSource'],
): Promise<ExternalIssueE2eVerification> {
  const summary: ExternalIssueE2eVerification['summary'] = {
    signalKinds: [],
    candidateDecisions: [],
    candidateOwnership: [],
    draftAttempted: false,
  };
  const checks: Record<string, boolean> = {
    externalIssueSourcePersisted: Boolean(source),
    externalIssueNegativeFeedbackStored: false,
    externalIssueOpportunityAvailable: false,
    externalIssueHasUserReportedInaccuracySignal: false,
    externalIssueAgentReviewUsed: false,
    externalIssueHasValidatedCandidates: false,
    externalIssueDraftBoundaryVerified: false,
  };
  if (!source) {
    return {checks, passed: false, summary};
  }

  const feedbackResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/feedback`,
    {
      rating: 'negative',
      runId: source.runId,
      targetKind: 'conclusion',
      targetId: source.runId,
      source: 'api',
      idempotencyKey: `external-issue-e2e:${source.runId}`,
    },
  );
  checks.externalIssueNegativeFeedbackStored =
    feedbackResponse.ok &&
    feedbackResponse.payload.durableFeedbackStored === true;
  if (!checks.externalIssueNegativeFeedbackStored) {
    return {checks, passed: false, summary};
  }

  const opportunityResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/opportunity`,
    source,
  );
  const opportunity = asRecord(opportunityResponse.payload.opportunity);
  summary.opportunityStatus =
    typeof opportunity?.status === 'string' ? opportunity.status : undefined;
  summary.signalKinds = Array.isArray(opportunity?.signals)
    ? opportunity.signals
      .map(item => asRecord(item)?.kind)
      .filter((kind): kind is string => typeof kind === 'string')
    : [];
  checks.externalIssueOpportunityAvailable =
    opportunityResponse.ok && opportunity?.status === 'available';
  checks.externalIssueHasUserReportedInaccuracySignal =
    summary.signalKinds.includes('user_reported_inaccuracy');
  if (!checks.externalIssueOpportunityAvailable) {
    return {checks, passed: false, summary};
  }

  const reviewResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/review`,
    source,
  );
  const review = asRecord(reviewResponse.payload.review);
  const candidates = Array.isArray(review?.candidates)
    ? review.candidates
      .map(candidate => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate !== null)
    : [];
  summary.reviewSource =
    typeof review?.source === 'string' ? review.source : undefined;
  summary.candidateDecisions = candidates
    .map(candidate => candidate.decision)
    .filter((decision): decision is string => typeof decision === 'string');
  summary.candidateOwnership = candidates
    .map(candidate => candidate.ownership)
    .filter((ownership): ownership is string => typeof ownership === 'string');
  checks.externalIssueAgentReviewUsed =
    reviewResponse.ok && review?.source === 'agent';
  checks.externalIssueHasValidatedCandidates =
    candidates.length > 0 && candidates.length <= 3;
  if (!checks.externalIssueAgentReviewUsed || candidates.length === 0) {
    return {checks, passed: false, summary};
  }

  const readyCandidate = candidates.find(candidate =>
    candidate.decision === 'report' || candidate.decision === 'needs_user_input');
  if (!readyCandidate || typeof readyCandidate.candidateId !== 'string') {
    checks.externalIssueDraftBoundaryVerified = summary.candidateDecisions.every(
      decision => decision === 'needs_verification' || decision === 'not_reportable',
    );
    return {
      checks,
      passed: Object.values(checks).every(Boolean),
      summary,
    };
  }

  const questions = Array.isArray(readyCandidate.userQuestions)
    ? readyCandidate.userQuestions
      .map(question => asRecord(question))
      .filter((question): question is Record<string, unknown> => question !== null)
    : [];
  const answers = questions
    .filter(question => typeof question.questionId === 'string')
    .map(question => ({
      questionId: question.questionId,
      answer: 'Reproduced by the isolated real-provider E2E run; no private trace content is attached.',
    }));
  summary.draftAttempted = true;
  const draftResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/draft`,
    {
      ...source,
      review,
      candidateId: readyCandidate.candidateId,
      answers,
      sensitiveDataReviewed: true,
    },
  );
  const draft = asRecord(draftResponse.payload.draft);
  summary.draftNotSubmitted = draft?.notSubmitted === true;
  summary.githubUrlIsHttps =
    typeof draft?.githubUrl === 'string' &&
    draft.githubUrl.startsWith('https://github.com/');
  checks.externalIssueDraftBoundaryVerified =
    draftResponse.ok &&
    summary.draftNotSubmitted &&
    summary.githubUrlIsHttps;
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    summary,
  };
}

async function postJsonResponse(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>,
): Promise<{
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
  }
  return {ok: response.ok, status: response.status, payload};
}

function findSessionLogFile(sessionId: string): string | null {
  const logDir = path.resolve(process.cwd(), 'logs/sessions');
  if (!fs.existsSync(logDir)) {
    return null;
  }
  const prefix = `session_${sessionId}_`;
  const files = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(logDir, files[files.length - 1]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.tracePath)) {
    throw new Error(`Trace file not found: ${options.tracePath}`);
  }
  if (options.referenceTracePath && !fs.existsSync(options.referenceTracePath)) {
    throw new Error(`Reference trace file not found: ${options.referenceTracePath}`);
  }

  const runtimeSelection = resolveAgentRuntimeSelection(options.providerId);
  if (runtimeSelection.kind === 'openai-agents-sdk' && !hasOpenAICredentials(options.providerId)) {
    const diagnostics = getOpenAIRuntimeDiagnostics(options.providerId);
    throw new Error(
      'OpenAI Agents SDK runtime is selected but no usable OpenAI-compatible credentials were found. ' +
      diagnostics.configHint
    );
  }

  const app = createVerificationApp();
  const server = app.listen(0);

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind local verification server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const traceProcessorService = getTraceProcessorService();
  let traceId = '';
  let referenceTraceId = '';
  let sessionId = '';

  try {
    const setup = await setupAnalysisContext(baseUrl, options);
    traceId = await traceProcessorService.loadTraceFromFilePath(options.tracePath);
    await writeTraceMetadata({
      id: traceId,
      filename: path.basename(options.tracePath),
      size: fs.statSync(options.tracePath).size,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: traceProcessorService.getTraceFilePath(traceId),
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: DEFAULT_DEV_USER_ID,
    });

    let tracePairContext: TracePairContext | undefined;
    if (options.referenceTracePath) {
      referenceTraceId = await traceProcessorService.loadTraceFromFilePath(options.referenceTracePath);
      await writeTraceMetadata({
        id: referenceTraceId,
        filename: path.basename(options.referenceTracePath),
        size: fs.statSync(options.referenceTracePath).size,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: traceProcessorService.getTraceFilePath(referenceTraceId),
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: DEFAULT_DEV_USER_ID,
      });
      tracePairContext = buildTracePairContextForVerification({
        options,
        traceId,
        referenceTraceId,
      });
    }

    const startResponse = await fetch(`${baseUrl}/api/agent/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traceId,
        query: options.query,
        ...(referenceTraceId ? { referenceTraceId } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.traceContext ? { traceContext: options.traceContext } : {}),
        ...(options.selectionContext ? { selectionContext: options.selectionContext } : {}),
        options: {
          ...(options.preset ? { preset: options.preset } : {}),
          ...(options.smartAction ? { smartAction: options.smartAction } : {}),
          ...(options.smartSelection ? { smartSelection: options.smartSelection } : {}),
          ...(options.forceRefresh ? { forceRefresh: true } : {}),
          ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}),
          ...(options.codeAwareMode ? { codeAwareMode: options.codeAwareMode } : {}),
          ...(options.codebaseIds.length > 0 ? { codebaseIds: options.codebaseIds } : {}),
          ...(options.knowledgeSourceIds.length > 0
            ? { knowledgeSourceIds: options.knowledgeSourceIds }
            : {}),
          ...(tracePairContext ? { tracePairContext } : {}),
        },
      }),
    });

    const startJson = (await startResponse.json()) as Record<string, unknown>;
    if (!startResponse.ok || typeof startJson.sessionId !== 'string') {
      throw new Error(`Analyze request failed: ${JSON.stringify(startJson)}`);
    }
    sessionId = startJson.sessionId;

    const sse = await collectSseSummary(baseUrl, sessionId, options.timeoutMs, {
      requiredText: options.requiredText,
      forbiddenText: options.forbiddenText,
    });
    const auditedLookupCounts = successfulCodeLookupToolCounts(
      CodeLookupLedger.restore(sessionId, 12_000, 2).getEntries(),
    );
    sse.successfulLookupCounts = auditedLookupCounts;
    for (const [toolName, count] of Object.entries(auditedLookupCounts)) {
      sse.toolCallCounts[toolName] = (sse.toolCallCounts[toolName] ?? 0) + count;
    }

    // Quick-mode analyses skip plan submission. Architecture detection can still
    // be emitted by the deterministic prepass before the lightweight agent path.
    // Don't use agent_response count as a quick/full classifier. Quick has a
    // 5-turn product target but a larger hard cap, and runtime adapters differ.
    const isQuickMode = sse.planSubmittedCount === 0;

    const smartMode = options.preset === 'smart';
    const capabilityLimitedRuntime = options.allowCapabilityLimitedRuntime;
    const requiredChecks = {
      hasProgressEvents: sse.progressCount > 0,
      ...(smartMode || capabilityLimitedRuntime || isQuickMode ? {} : { hasAgentResponses: sse.agentResponseCount > 0 }),
      hasTerminalConclusionPayload: sse.conclusionCount > 0 || sse.analysisCompletedConclusionChars > 0,
      hasAnalysisCompletedEvent: sse.terminalEvent === 'analysis_completed' || sse.terminalEvent === 'end',
      hasNoSseErrors: sse.errorEvents.length === 0,
    };

    const fullModeChecks = smartMode || capabilityLimitedRuntime
      ? {}
      : {
        ...(options.allowNoDataEnvelopes ? {} : { hasDataEnvelopes: sse.dataEnvelopeCount > 0 }),
        hasPlanSubmitted: sse.planSubmittedCount > 0,
        hasArchitectureDetected: sse.architectureDetectedCount > 0,
      };
    const dualTraceChecks = options.referenceTracePath
      ? {
        hasReferenceTraceId: referenceTraceId.length > 0,
        hasTracePairContext: Boolean(tracePairContext),
      }
      : {};

    // Mode expectation: if the caller pinned `--mode fast|full`, verify the backend honored it.
    // Catches regressions where a fast CLI flag silently falls back to the full pipeline (or vice versa).
    const modeExpectationChecks: Record<string, boolean> = {};
    if (!capabilityLimitedRuntime && options.analysisMode === 'fast') {
      modeExpectationChecks.fastModeHonored = isQuickMode;
    } else if (!capabilityLimitedRuntime && options.analysisMode === 'full') {
      modeExpectationChecks.fullModeHonored = !isQuickMode;
    }
    const conclusionEvidenceChecks = options.requireConclusionEvidence
      ? {
        hasAnalysisCompletedConclusion: sse.analysisCompletedConclusionChars > 0,
        hasAnalysisCompletedConclusionEvidence: sse.analysisCompletedHasConcreteEvidenceRefs,
      }
      : {};
    const codeReferenceChecks = options.requireCodeRef
      ? {
        hasConcreteCodeReferences:
          sse.conclusionHasConcreteCodeRefs || sse.analysisCompletedHasConcreteCodeRefs,
      }
      : {};
    const claimVerifierChecks = options.requireClaimVerifierOk
      ? {
        hasClaimVerifierResult: Boolean(sse.claimVerifierStatus),
        claimVerifierPassed: sse.claimVerifierStatus === 'passed' && sse.claimVerifierPassed !== false,
        claimVerifierHasNoUnsupportedClaims: (sse.claimVerifierUnsupportedClaimCount ?? 0) === 0,
      }
      : {};
    const partialChecks = options.requireNonPartial
      ? {
        analysisCompletedNotPartial: sse.analysisCompletedPartial !== true,
      }
      : {};
    const finalReportHeadingChecks = options.requireFinalReportHeading
      ? {
        analysisCompletedHasFinalReportHeading: sse.analysisCompletedHasFinalReportHeading,
      }
      : {};
    const processNarrationChecks = options.forbidProcessNarration
      ? {
        analysisCompletedHasNoProcessNarration: !sse.analysisCompletedHasProcessNarration,
      }
      : {};
    const conclusionLengthChecks = options.maxAnalysisCompletedConclusionChars !== undefined
      ? {
        analysisCompletedConclusionWithinMaxChars:
          sse.analysisCompletedConclusionChars <= options.maxAnalysisCompletedConclusionChars,
      }
      : {};
    const requiredTextChecks = Object.fromEntries(
      options.requiredText.map((text) => [`requiresText:${text}`, sse.requiredTextMatches[text] === true]),
    );
    const forbiddenTextChecks = Object.fromEntries(
      options.forbiddenText.map((text) => [`forbidsText:${text}`, sse.forbiddenTextMatches[text] !== true]),
    );
    const requiredToolChecks = Object.fromEntries(
      options.requiredTools.map((toolName) => [`requiresTool:${toolName}`, (sse.toolCallCounts[toolName] ?? 0) > 0]),
    );
    const requiredSuccessfulLookupChecks = Object.fromEntries(
      options.requiredSuccessfulLookups.map((toolName) => [
        `requiresSuccessfulLookup:${toolName}`,
        (sse.successfulLookupCounts[toolName] ?? 0) > 0,
      ]),
    );
    const requiredSkillChecks = Object.fromEntries(
      options.requiredSkills.map((skillId) => [`requiresSkill:${skillId}`, (sse.skillCallCounts[skillId] ?? 0) > 0]),
    );
    const degradedFallbackChecks = Object.fromEntries(
      options.forbiddenDegradedFallbacks.map((fallback) => [
        `forbidsDegradedFallback:${fallback}`,
        (sse.degradedFallbackCounts[fallback] ?? 0) === 0,
      ]),
    );
    const dataEnvelopeChecks = options.requireDataEnvelope
      ? { hasRequiredDataEnvelope: sse.dataEnvelopeCount > 0 }
      : {};
    const quickRunChecks = options.requireQuickRun
      ? {
        hasQuickRunReceipt: Boolean(sse.quickRun),
        quickRunResolvedQuick: sse.quickRun?.resolvedMode === 'quick',
        quickRunHasTurnBudget:
          typeof sse.quickRun?.targetTurns === 'number' &&
          typeof sse.quickRun?.hardCapTurns === 'number' &&
          (sse.quickRun?.targetTurns ?? 0) <= (sse.quickRun?.hardCapTurns ?? 0),
      }
      : {};
    const externalIssueVerification = options.requireExternalIssueTriage
      ? await verifyExternalIssueTriage(
        baseUrl,
        sessionId,
        sse.externalIssueSource,
      )
      : undefined;
    const externalIssueChecks = externalIssueVerification?.checks ?? {};
    const checks = {
      ...requiredChecks,
      ...fullModeChecks,
      ...dualTraceChecks,
      ...modeExpectationChecks,
      ...conclusionEvidenceChecks,
      ...codeReferenceChecks,
      ...claimVerifierChecks,
      ...partialChecks,
      ...finalReportHeadingChecks,
      ...processNarrationChecks,
      ...conclusionLengthChecks,
      ...requiredTextChecks,
      ...forbiddenTextChecks,
      ...requiredToolChecks,
      ...requiredSuccessfulLookupChecks,
      ...requiredSkillChecks,
      ...degradedFallbackChecks,
      ...dataEnvelopeChecks,
      ...quickRunChecks,
      ...externalIssueChecks,
    };
    let passed = Object.values(requiredChecks).every(Boolean)
      && Object.values(modeExpectationChecks).every(Boolean)
      && Object.values(dualTraceChecks).every(Boolean)
      && Object.values(conclusionEvidenceChecks).every(Boolean)
      && Object.values(codeReferenceChecks).every(Boolean)
      && Object.values(claimVerifierChecks).every(Boolean)
      && Object.values(partialChecks).every(Boolean)
      && Object.values(finalReportHeadingChecks).every(Boolean)
      && Object.values(processNarrationChecks).every(Boolean)
      && Object.values(conclusionLengthChecks).every(Boolean)
      && Object.values(requiredTextChecks).every(Boolean)
      && Object.values(forbiddenTextChecks).every(Boolean)
      && Object.values(requiredToolChecks).every(Boolean)
      && Object.values(requiredSuccessfulLookupChecks).every(Boolean)
      && Object.values(requiredSkillChecks).every(Boolean)
      && Object.values(degradedFallbackChecks).every(Boolean)
      && Object.values(dataEnvelopeChecks).every(Boolean)
      && Object.values(quickRunChecks).every(Boolean)
      && Object.values(externalIssueChecks).every(Boolean)
      && (isQuickMode || Object.values(fullModeChecks).every(Boolean));
    let followUpOutput: Record<string, unknown> | undefined;
    if (options.followUpQuery) {
      const followUpResponse = await fetch(`${baseUrl}/api/agent/v1/sessions/${sessionId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId,
          query: options.followUpQuery,
          ...(referenceTraceId ? { referenceTraceId } : {}),
          ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
          ...(options.selectionContext ? { selectionContext: options.selectionContext } : {}),
          options: {
            ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}),
            ...(options.codeAwareMode ? { codeAwareMode: options.codeAwareMode } : {}),
            ...(options.codebaseIds.length > 0 ? { codebaseIds: options.codebaseIds } : {}),
            ...(options.knowledgeSourceIds.length > 0
              ? { knowledgeSourceIds: options.knowledgeSourceIds }
              : {}),
            ...(tracePairContext ? { tracePairContext } : {}),
          },
        }),
      });
      const followUpStartJson = (await followUpResponse.json()) as Record<string, unknown>;
      if (
        !followUpResponse.ok ||
        typeof followUpStartJson.sessionId !== 'string' ||
        typeof followUpStartJson.runId !== 'string'
      ) {
        throw new Error(`Follow-up analyze request failed: ${JSON.stringify(followUpStartJson)}`);
      }

      const followUpSse = await collectSseSummary(
        baseUrl,
        sessionId,
        options.timeoutMs,
        {
          requiredText: options.followUpRequiredText,
          forbiddenText: [],
        },
        { runId: followUpStartJson.runId },
      );
      const followUpIsQuickMode = followUpSse.planSubmittedCount === 0;
      const followUpRequiredTextChecks = Object.fromEntries(
        options.followUpRequiredText.map((text) => [
          `followUpRequiresText:${text}`,
          followUpSse.requiredTextMatches[text] === true,
        ]),
      );
      const followUpForbiddenToolChecks = Object.fromEntries(
        options.followUpForbiddenTools.map((toolName) => [
          `followUpForbidsTool:${toolName}`,
          (followUpSse.toolCallCounts[toolName] ?? 0) === 0,
        ]),
      );
      const followUpChecks = {
        hasFollowUpProgressEvents: followUpSse.progressCount > 0,
        hasFollowUpTerminalConclusionPayload:
          followUpSse.conclusionCount > 0 || followUpSse.analysisCompletedConclusionChars > 0,
        hasFollowUpAnalysisCompletedEvent:
          followUpSse.terminalEvent === 'analysis_completed' || followUpSse.terminalEvent === 'end',
        hasFollowUpNoSseErrors: followUpSse.errorEvents.length === 0,
        ...(options.analysisMode === 'fast' ? { followUpFastModeHonored: followUpIsQuickMode } : {}),
        ...followUpRequiredTextChecks,
        ...followUpForbiddenToolChecks,
      };
      const followUpPassed = Object.values(followUpChecks).every(Boolean);
      passed = passed && followUpPassed;
      followUpOutput = {
        query: options.followUpQuery,
        runId: followUpStartJson.runId,
        checks: followUpChecks,
        passed: followUpPassed,
        summary: followUpSse,
      };
    }
    const sessionLogFile = findSessionLogFile(sessionId);

    const output = {
      timestamp: new Date().toISOString(),
      tracePath: options.tracePath,
      referenceTracePath: options.referenceTracePath,
      query: options.query,
      preset: options.preset,
      selectionContext: options.selectionContext,
      analysisContext: {
        codeAwareMode: options.codeAwareMode ?? 'off',
        codebaseIds: options.codebaseIds,
        knowledgeSourceIds: options.knowledgeSourceIds,
        setup,
      },
      traceId,
      referenceTraceId: referenceTraceId || undefined,
      tracePairContext,
      sessionId,
      checks,
      passed,
      summary: sse,
      externalIssue: externalIssueVerification?.summary,
      followUp: followUpOutput,
      sessionLogFile,
    };

    const defaultOutputPath = path.resolve(
      process.cwd(),
      `test-output/verify-agent-sse-scrolling-${Date.now()}.json`
    );
    const outputPath = options.outputPath ?? defaultOutputPath;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    console.log(JSON.stringify(output, null, 2));
    console.log(`Report written to: ${outputPath}`);

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    if (sessionId !== '' && !options.keepSession) {
      try {
        await fetch(`${baseUrl}/api/agent/v1/${sessionId}`, { method: 'DELETE' });
      } catch {
      }
    }

    if (traceId !== '' && !options.keepTrace) {
      try {
        await traceProcessorService.deleteTrace(traceId);
      } catch {
      }
    }

    if (referenceTraceId !== '' && !options.keepTrace) {
      try {
        await traceProcessorService.deleteTrace(referenceTraceId);
      } catch {
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
