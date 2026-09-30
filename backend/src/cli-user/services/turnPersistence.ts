// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Per-turn persistence helper shared by `analyze` and `resume`.
 *
 * Both commands end a turn with the same fan-out: write conclusion +
 * per-turn markdown + HTML report + config + transcript + index entry,
 * then render the conclusion block and the completion summary. This
 * helper owns those eight steps so the call sites stay short and
 * uniform — any future addition (e.g. a `--no-report` flag) only
 * touches one place.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CliPaths, SessionPaths } from '../io/paths';
import type { Renderer } from '../repl/renderer';
import type { CliSessionConfig, CliSessionIndexEntry } from '../types';
import type { RunTurnOutput } from './cliAnalyzeService';
import type {AnalysisSourceSupplementOutcome} from '../../services/codebase/analysisSourceSupplement';
import {
  writeConfig,
  writeConclusion,
  writeJsonFile,
  writeReportHtml,
  writeTurnReportHtml,
  writeTurnMarkdown,
} from '../io/sessionStore';
import { upsertSession } from '../io/indexJson';
import { appendTranscriptTurn } from '../io/transcriptWriter';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {projectToolResultAuditForPrivateRun} from '../../agentRuntime/runtimeToolResultAudit';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  projectOwnerAnalysisError,
  projectOwnerAnalysisResult,
  projectOwnerQuestion,
} from '../../services/security/privateAnalysisProjection';
import {sanitizeOwnerCodeAwareText} from '../../services/security/codeAwareOutputRegistry';
import {
  projectSafeSourceProvenance,
  type SafeSourceProvenanceProjection,
} from '../../services/codebase/sourceClaimVerifier';
import {analysisConfidenceIsGrounded} from '../../agentv3/analysisTermination';
import {deriveDeliveryVerdict, summarizeClaimVerification} from '../../services/analysisInvestigationPresentation';
import {
  buildCliAnalysisEvidenceBundle,
  latestCliAnalysisEvidencePath,
  rebindCliAnalysisEvidenceTurnMarkdown,
  turnCliAnalysisEvidencePath,
  type CliAnalysisEvidenceOutput,
} from './analysisResultPresentation';
import {buildCliSceneReportBundle, cliSceneReportMetadata, latestCliSceneReportPath, loadedCliSceneReport,
  rebindCliSceneReportTurnMarkdown, turnCliSceneReportPath} from './sceneReportReference';

export interface CommitTurnInput {
  paths: CliPaths;
  sp: SessionPaths;
  renderer: Renderer;

  /** User-facing session id. For resume this equals the input session id;
   *  for a fresh analyze it equals `result.sessionId`. */
  sessionId: string;
  /** 1-indexed. */
  turn: number;
  /** The user's question for this turn. */
  query: string;
  /** Output of CliAnalyzeService.runTurn(). */
  result: RunTurnOutput;
  /** Caller-constructed config. This helper persists it verbatim. */
  config: CliSessionConfig;
  /** Pre-formatted markdown for `turns/NNN.md`. */
  turnMarkdown: string;
  /** Optional deterministic appendix, currently used by dual-trace comparison. */
  reportAppendix?: { markdown: string; html: string };
  /** Caller-constructed index row. */
  indexEntry: CliSessionIndexEntry;
}

export function commitTurnOutputs(input: CommitTurnInput): CliAnalysisEvidenceOutput {
  const { paths, sp, renderer, sessionId, turn, query, config, reportAppendix } = input;
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const rawConclusion = input.result.result.conclusion || '';
  const inputSourceProvenance = sourceProvenanceForResult(input.result);
  const result: RunTurnOutput = input.result.privateKnowledge
    ? {
        ...input.result,
        result: projectOwnerAnalysisResult(sessionId, input.result.result, outputLanguage),
        reportError: input.result.reportError
          ? projectOwnerAnalysisError(sessionId, input.result.reportError, outputLanguage)
          : undefined,
        ...(input.result.toolResultAudit
          ? {toolResultAudit: projectToolResultAuditForPrivateRun(input.result.toolResultAudit)}
          : {}),
      }
    : input.result;
  const conclusion = result.result.conclusion || '';
  // The creator's local files keep the question: the transcript is resume
  // history for the model, and displayed copies pass the owner guard.
  const ownerView = (text: string) => sanitizeOwnerCodeAwareText(sessionId, replaceExact(text, rawConclusion, conclusion));
  const baseTurnMarkdown = result.privateKnowledge ? ownerView(input.turnMarkdown) : input.turnMarkdown;
  const sourceProvenance = inputSourceProvenance ?? sourceProvenanceForResult(result);
  const turnMarkdown = reportAppendix?.markdown
    ? `${baseTurnMarkdown}\n\n${reportAppendix.markdown}`
    : baseTurnMarkdown;
  // A run that stopped early is neither cleanly completed nor failed; filing it
  // as `completed` made `smp list` show a truncated comparison exactly like a
  // finished one.
  const statusForIndex: CliSessionIndexEntry['status'] =
    result.result.partial && input.indexEntry.status === 'completed'
      ? 'partial'
      : input.indexEntry.status;
  const indexEntry = {...input.indexEntry, status: statusForIndex,
    firstQuery: projectOwnerQuestion(result.privateKnowledge === true, sessionId, input.indexEntry.firstQuery)};

  const turnPrefix = path.join(sp.turnsDir, String(turn).padStart(3, '0'));
  const cliTurnPath = `${turnPrefix}.md`;
  const evidenceBundle = buildCliAnalysisEvidenceBundle({
    sessionId,
    turn,
    conclusion,
    turnMarkdown,
    result: result.result,
    sourceProvenance,
  });
  const sceneBundle = buildCliSceneReportBundle({sessionId, turn, traceId: result.traceId, conclusion, turnMarkdown, result: result.result});

  writeConclusion(sp, conclusion);
  writeTurnMarkdown(sp, turn, turnMarkdown);

  let turnReportPath: string | undefined;
  const privateSafeReportHtml = result.privateKnowledge && result.reportHtml ? ownerView(result.reportHtml) : result.reportHtml;
  const reportHtml = privateSafeReportHtml && reportAppendix?.html
    ? appendHtmlToBody(privateSafeReportHtml, reportAppendix.html)
    : privateSafeReportHtml;
  const reportPathForUser = privateSafeReportHtml
    ? (turnReportPath = writeTurnReportHtml(sp, turn, reportHtml || ''), writeReportHtml(sp, reportHtml || ''), sp.report)
    : `(report generation failed${result.reportError ? `: ${result.reportError}` : ''})`;
  assertCliReceiptPath(result, cliTurnPath);
  writeAnalysisQualitySidecars(sp, turn, result, sourceProvenance);
  writeJsonFile(sp, turnCliAnalysisEvidencePath(sp, turn), evidenceBundle);
  writeJsonFile(sp, turnCliSceneReportPath(sp, turn), sceneBundle);

  writeConfig(sp, config);
  // Latest is a pointer-by-value. Write it last so a partial failure cannot
  // pair a previous turn's evidence with the newly written conclusion.
  writeJsonFile(sp, latestCliAnalysisEvidencePath(sp), evidenceBundle);
  // A non-scene turn replaces the latest locator with an explicit none bundle.
  writeJsonFile(sp, latestCliSceneReportPath(sp), sceneBundle);

  appendTranscriptTurn(sp.transcript, {
    turn,
    timestamp: config.lastTurnAt,
    question: query,
    conclusionMd: conclusion,
    history: toAnalysisHistoryTurn({
      id: result.result.completion?.runId ?? `${sessionId}:turn:${turn}`,
      turnIndex: turn - 1,
      query,
      traceId: result.traceId,
      timestamp: config.lastTurnAt,
      result: result.result,
      sourceDerived: result.privateKnowledge === true,
      analysisContextFingerprint: result.analysisContextFingerprint,
    }),
    confidence: result.result.confidence,
    rounds: result.result.rounds,
    durationMs: result.result.totalDurationMs,
    reportFile: turnReportPath,
    error: result.reportError,
  });

  upsertSession(paths, indexEntry);

  renderer.printConclusion(conclusion, {
    investigationAssurance: {
      investigation: result.result.deliveryAssurance?.investigation ?? 'not_checked',
      investigationEvidence: result.result.deliveryAssurance?.investigationEvidence ?? 'not_checked',
    },
    confidence: result.result.confidence,
    confidenceGrounded: analysisConfidenceIsGrounded(result.result),
    rounds: result.result.rounds,
    durationMs: result.result.totalDurationMs,
    claimVerification: summarizeClaimVerification(result.result.claimVerificationResult),
    analysisEvidence: evidenceBundle,
  });
  renderer.printCompletion({
    reportPath: reportPathForUser,
    turnReportPath,
    sessionDir: sp.dir,
    sessionId,
    success: result.result.success,
    hasConclusion: Boolean(conclusion.trim()),
    ...(result.result.terminationMessage ? { terminationMessage: result.result.terminationMessage } : {}),
    ...(result.result.partial ? { partial: true } : {}),
    ...(result.result.terminationReason ? { terminationReason: result.result.terminationReason } : {}),
    deliveryVerdict: deriveDeliveryVerdict(result.result),
    ...cliSceneReportMetadata(loadedCliSceneReport(sceneBundle)),
  });
  return evidenceBundle;
}

export function commitSourceSupplementOutput(input: {
  sp: SessionPaths;
  renderer: Renderer;
  sessionId: string;
  turn: number;
  supplement: AnalysisSourceSupplementOutcome;
  analysisEvidence: CliAnalysisEvidenceOutput;
}): void {
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const safeSupplement = {
    message: sanitizeOwnerCodeAwareText(input.sessionId, input.supplement.message),
    metrics: {...input.supplement.metrics},
  };
  const turnPrefix = path.join(input.sp.turnsDir, String(input.turn).padStart(3, '0'));
  const turnPath = `${turnPrefix}.md`;
  const previousTurnMarkdown = fs.existsSync(turnPath) ? fs.readFileSync(turnPath, 'utf8') : '';
  const current = previousTurnMarkdown.trimEnd();
  const heading = localize(outputLanguage, '源码补充', 'Source supplement');
  const metrics = localize(
    outputLanguage,
    `${safeSupplement.metrics.searchCalls} 次搜索 / ${safeSupplement.metrics.readCalls} 次读取 / ${safeSupplement.metrics.durationMs}ms`,
    `${safeSupplement.metrics.searchCalls} searches / ${safeSupplement.metrics.readCalls} reads / ${safeSupplement.metrics.durationMs}ms`,
  );
  const turnMarkdown = `${current}\n\n## ${heading}\n\n${safeSupplement.message}\n\n_${metrics}_\n`;
  const reboundEvidence = rebindCliAnalysisEvidenceTurnMarkdown(
    input.analysisEvidence,
    turnMarkdown,
  );
  rebindCliSceneReportTurnMarkdown({sp: input.sp, sessionId: input.sessionId, turn: input.turn,
    turnMarkdown: previousTurnMarkdown, nextMarkdown: turnMarkdown});
  writeTurnMarkdown(input.sp, input.turn, turnMarkdown);
  writeJsonFile(input.sp, turnCliAnalysisEvidencePath(input.sp, input.turn), reboundEvidence);
  // Latest remains a pointer-by-value and is written after the per-turn pair.
  writeJsonFile(input.sp, latestCliAnalysisEvidencePath(input.sp), reboundEvidence);
  writeJsonFile(input.sp, path.join(input.sp.dir, 'source-supplement.json'), safeSupplement);
  writeJsonFile(input.sp, `${turnPrefix}.source-supplement.json`, safeSupplement);
  input.renderer.onEvent({
    type: 'analysis_source_enrichment_completed',
    content: safeSupplement,
    timestamp: Date.now(),
  });
}

function writeAnalysisQualitySidecars(
  sp: SessionPaths,
  turn: number,
  result: RunTurnOutput,
  sourceProvenance: SafeSourceProvenanceProjection | undefined,
): void {
  const turnPrefix = path.join(sp.turnsDir, String(turn).padStart(3, '0'));
  writeJsonFile(sp, sp.claimSupport, result.result.claimSupport || []);
  writeJsonFile(sp, `${turnPrefix}.claim-support.json`, result.result.claimSupport || []);
  writeJsonFile(sp, sp.claimVerification, result.result.claimVerificationResult || null);
  writeJsonFile(sp, `${turnPrefix}.claim-verification.json`, result.result.claimVerificationResult || null);
  writeJsonFile(sp, sp.identityResolutions, result.result.identityResolutions || []);
  writeJsonFile(sp, `${turnPrefix}.identity-resolutions.json`, result.result.identityResolutions || []);
  // Preserve bound investigation details independently of the readable conclusion.
  writeJsonFile(sp, `${turnPrefix}.investigation-assessment.json`, result.result.investigationAssessment || null);
  writeJsonFile(sp, `${turnPrefix}.delivery-assurance.json`, result.result.deliveryAssurance || null);
  writeJsonFile(sp, path.join(sp.dir, 'analysis-receipt.json'), result.result.analysisReceipt || null);
  writeJsonFile(sp, `${turnPrefix}.analysis-receipt.json`, result.result.analysisReceipt || null);
  writeJsonFile(sp, path.join(sp.dir, 'ui-action-proposals.json'), result.result.uiActionProposals || []);
  writeJsonFile(sp, `${turnPrefix}.ui-action-proposals.json`, result.result.uiActionProposals || []);
  // Internal timing receipt only (no content): the CLI manifest store is not durable.
  if (result.runtimePerformance) {
    writeJsonFile(sp, `${turnPrefix}.runtime-performance.json`, result.runtimePerformance);
  }
  // Handoff facts only (no payload values); the stream copy is transport-truncated.
  if (result.toolResultAudit) {
    writeJsonFile(sp, `${turnPrefix}.tool-results.json`, result.toolResultAudit);
  }
  writeSourceProvenanceSidecars(sp, turnPrefix, sourceProvenance);
}

function sourceProvenanceForResult(
  result: RunTurnOutput,
): SafeSourceProvenanceProjection | undefined {
  const resultValue = result.result;
  const hasActualDecision = Object.prototype.hasOwnProperty.call(
    resultValue,
    'sourceUseDecision',
  );
  return projectSafeSourceProvenance({
    conclusionContract: resultValue.conclusionContract,
    ...(hasActualDecision
      ? {actualSourceUseDecision: resultValue.sourceUseDecision}
      : {}),
  });
}

function writeSourceProvenanceSidecars(
  sp: SessionPaths,
  turnPrefix: string,
  provenance: SafeSourceProvenanceProjection | undefined,
): void {
  const latestDecisionPath = path.join(sp.dir, 'source-use-decision.json');
  const latestBindingsPath = path.join(sp.dir, 'source-claim-bindings.json');
  if (!provenance) {
    for (const filePath of [latestDecisionPath, latestBindingsPath]) {
      fs.rmSync(filePath, {force: true});
    }
    return;
  }

  writeJsonFile(sp, latestDecisionPath, provenance.sourceUseDecision);
  writeJsonFile(sp, `${turnPrefix}.source-use-decision.json`, provenance.sourceUseDecision);
  writeJsonFile(sp, latestBindingsPath, provenance.sourceClaimBindings);
  writeJsonFile(sp, `${turnPrefix}.source-claim-bindings.json`, provenance.sourceClaimBindings);
}

function assertCliReceiptPath(result: RunTurnOutput, cliTurnPath: string): void {
  const receipt = result.result.analysisReceipt;
  if (!receipt) return;
  if (receipt.outputs.cliTurnPath !== cliTurnPath) {
    throw new Error(
      `analysis_receipt_cli_turn_path_mismatch:${receipt.outputs.cliTurnPath ?? 'missing'}:${cliTurnPath}`,
    );
  }
}

function appendHtmlToBody(html: string, appendixHtml: string): string {
  const closeBody = /<\/body>\s*<\/html>\s*$/i;
  if (closeBody.test(html)) {
    return html.replace(closeBody, `${appendixHtml}\n</body>\n</html>`);
  }
  return `${html}\n${appendixHtml}`;
}

function replaceExact(value: string, needle: string, replacement: string): string {
  return needle ? value.split(needle).join(replacement) : value;
}
