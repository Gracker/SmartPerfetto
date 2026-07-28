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

import * as path from 'path';
import type { CliPaths, SessionPaths } from '../io/paths';
import type { Renderer } from '../repl/renderer';
import type { CliSessionConfig, CliSessionIndexEntry } from '../types';
import type { RunTurnOutput } from './cliAnalyzeService';
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
import {parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  privateAnalysisFailureMessage,
  privateAnalysisQueryMessage,
  projectPrivateAnalysisResult,
} from '../../services/security/privateAnalysisProjection';
import {sanitizeCodeAwareText} from '../../services/security/codeAwareOutputRegistry';

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

export function commitTurnOutputs(input: CommitTurnInput): void {
  const { paths, sp, renderer, sessionId, turn, query, config, reportAppendix } = input;
  const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const rawConclusion = input.result.result.conclusion || '';
  const result: RunTurnOutput = input.result.privateKnowledge
    ? {
        ...input.result,
        result: projectPrivateAnalysisResult(sessionId, input.result.result, outputLanguage),
        reportError: input.result.reportError
          ? privateAnalysisFailureMessage(outputLanguage)
          : undefined,
      }
    : input.result;
  const durableQuery = result.privateKnowledge
    ? privateAnalysisQueryMessage(outputLanguage)
    : query;
  const turnMarkdown = result.privateKnowledge
    ? sanitizeCodeAwareText(
        sessionId,
        replaceExact(
          replaceExact(input.turnMarkdown, query, durableQuery),
          rawConclusion,
          result.result.conclusion || '',
        ),
      )
    : input.turnMarkdown;
  const indexEntry = result.privateKnowledge
    ? {...input.indexEntry, firstQuery: durableQuery}
    : input.indexEntry;

  const conclusion = result.result.conclusion || '';
  const turnPrefix = path.join(sp.turnsDir, String(turn).padStart(3, '0'));
  const cliTurnPath = `${turnPrefix}.md`;

  writeConclusion(sp, conclusion);
  writeTurnMarkdown(sp, turn, reportAppendix?.markdown ? `${turnMarkdown}\n\n${reportAppendix.markdown}` : turnMarkdown);

  let turnReportPath: string | undefined;
  const privateSafeReportHtml = result.privateKnowledge && result.reportHtml
    ? sanitizeCodeAwareText(
        sessionId,
        replaceExact(
          replaceExact(result.reportHtml, query, durableQuery),
          rawConclusion,
          result.result.conclusion || '',
        ),
      )
    : result.reportHtml;
  const reportHtml = privateSafeReportHtml && reportAppendix?.html
    ? appendHtmlToBody(privateSafeReportHtml, reportAppendix.html)
    : privateSafeReportHtml;
  const reportPathForUser = privateSafeReportHtml
    ? (turnReportPath = writeTurnReportHtml(sp, turn, reportHtml || ''), writeReportHtml(sp, reportHtml || ''), sp.report)
    : `(report generation failed${result.reportError ? `: ${result.reportError}` : ''})`;
  assertCliReceiptPath(result, cliTurnPath);
  writeAnalysisQualitySidecars(sp, turn, result);

  writeConfig(sp, config);

  appendTranscriptTurn(sp.transcript, {
    turn,
    timestamp: config.lastTurnAt,
    question: durableQuery,
    conclusionMd: conclusion,
    confidence: result.result.confidence,
    rounds: result.result.rounds,
    durationMs: result.result.totalDurationMs,
    reportFile: turnReportPath,
    error: result.reportError,
  });

  upsertSession(paths, indexEntry);

  renderer.printConclusion(conclusion, {
    confidence: result.result.confidence,
    rounds: result.result.rounds,
    durationMs: result.result.totalDurationMs,
    claimVerification: result.result.claimVerificationResult
      ? {
        status: result.result.claimVerificationResult.status,
        checkedClaimCount: result.result.claimVerificationResult.checkedClaimCount,
        unsupportedClaimCount: result.result.claimVerificationResult.unsupportedClaimCount,
        issueCount: result.result.claimVerificationResult.issues?.length || 0,
      }
      : undefined,
  });
  renderer.printCompletion({
    reportPath: reportPathForUser,
    turnReportPath,
    sessionDir: sp.dir,
    sessionId,
    success: result.result.success,
  });
}

function writeAnalysisQualitySidecars(sp: SessionPaths, turn: number, result: RunTurnOutput): void {
  const turnPrefix = path.join(sp.turnsDir, String(turn).padStart(3, '0'));
  writeJsonFile(sp, sp.claimSupport, result.result.claimSupport || []);
  writeJsonFile(sp, `${turnPrefix}.claim-support.json`, result.result.claimSupport || []);
  writeJsonFile(sp, sp.claimVerification, result.result.claimVerificationResult || null);
  writeJsonFile(sp, `${turnPrefix}.claim-verification.json`, result.result.claimVerificationResult || null);
  writeJsonFile(sp, sp.identityResolutions, result.result.identityResolutions || []);
  writeJsonFile(sp, `${turnPrefix}.identity-resolutions.json`, result.result.identityResolutions || []);
  writeJsonFile(sp, path.join(sp.dir, 'analysis-receipt.json'), result.result.analysisReceipt || null);
  writeJsonFile(sp, `${turnPrefix}.analysis-receipt.json`, result.result.analysisReceipt || null);
  writeJsonFile(sp, path.join(sp.dir, 'ui-action-proposals.json'), result.result.uiActionProposals || []);
  writeJsonFile(sp, `${turnPrefix}.ui-action-proposals.json`, result.result.uiActionProposals || []);
}

function assertCliReceiptPath(result: RunTurnOutput, cliTurnPath: string): void {
  if (result.privateKnowledge) return;
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
