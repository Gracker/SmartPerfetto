// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Terminal renderer for StreamingUpdate events.
 *
 * PR1 scope: stateless line-by-line logging, no spinner/animation.
 * The spinner + clear-line tricks needed for a polished typewriter
 * effect belong in PR3's REPL — in one-shot mode, stable line-based
 * output is easier to grep and read in CI/scripts.
 *
 * ANSI colors are stripped when stdout is not a TTY or `--no-color`
 * is passed — ensures `smartperfetto analyze ... > log.txt` stays clean.
 */

import {
  claimVerificationStatusLine,
  investigationStatusLines,
  type ClaimVerificationStatusSummary,
  type DeliveryVerdict,
} from '../../services/analysisInvestigationPresentation';
import type {AnalysisDeliveryAssurance} from '../../types/analysisDelivery';
import type { StreamingUpdate } from '../../agent/types';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  loadedCliAnalysisEvidence,
  renderCliAnalysisEvidence,
  type CliAnalysisEvidenceOutput,
} from '../services/analysisResultPresentation';
import {renderCliSceneReport, type CliSceneReportMetadata} from '../services/sceneReportReference';

export interface RendererOptions {
  verbose: boolean;
  useColor: boolean;
  format?: OutputFormat;
}

type ClaimVerificationSummary = ClaimVerificationStatusSummary & {issueCount?: number};

export type OutputFormat = 'text' | 'json' | 'ndjson';
export type TextJsonFormat = Extract<OutputFormat, 'text' | 'json'>;

export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (!value || value === 'text') return 'text';
  if (value === 'json' || value === 'ndjson') return value;
  throw new Error(`Invalid --format value: ${value}. Expected text, json, or ndjson.`);
}

export function parseTextJsonFormat(value: string | undefined): TextJsonFormat {
  if (!value || value === 'text') return 'text';
  if (value === 'json') return value;
  throw new Error(`Invalid --format value: ${value}. Expected text or json.`);
}

/** Minimal ANSI color helper. Stays in-file so we don't pull in chalk. */
function ansi(code: string, on: boolean): (s: string) => string {
  return (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
}

interface CompletionMetadata extends CliSceneReportMetadata {
  reportPath: string;
  turnReportPath?: string;
  sessionDir: string;
  sessionId: string;
  success?: boolean;
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  hasConclusion?: boolean;
  /** Absent for callers that predate it; the marker then follows success/partial only. */
  deliveryVerdict?: DeliveryVerdict;
}

interface ConclusionMetadata {
  confidence?: number;
  /** False when confidence is the fixed no-findings baseline, which the text view omits. */
  confidenceGrounded?: boolean;
  rounds?: number;
  durationMs?: number;
  claimVerification?: ClaimVerificationSummary;
  investigationAssurance?: Pick<AnalysisDeliveryAssurance, 'investigation' | 'investigationEvidence'>;
  analysisEvidence?: CliAnalysisEvidenceOutput;
}

export interface Renderer {
  format: OutputFormat;
  onEvent(update: StreamingUpdate): void;
  /**
   * The finished answer while its semantic review still runs (text mode only).
   * printConclusion then adds the verdict without repeating an unchanged body.
   */
  printProvisionalConclusion?(conclusion: string): void;
  /** Called once after the SDK result arrives — prints the conclusion block. */
  printConclusion(conclusion: string, meta: ConclusionMetadata): void;
  /** Called on fatal errors that abort the run. */
  printError(message: string): void;
  /** Called last to summarize report path + any diagnostics. */
  printCompletion(meta: CompletionMetadata): void;
}

export function createRenderer(opts: RendererOptions): Renderer {
  const format = opts.format ?? 'text';
  if (format !== 'text') return createMachineRenderer(format);

  const useColor = opts.useColor && Boolean(process.stdout.isTTY);
  const dim = ansi('2', useColor);
  const cyan = ansi('36', useColor);
  const yellow = ansi('33', useColor);
  const red = ansi('31', useColor);
  const green = ansi('32', useColor);
  const bold = ansi('1', useColor);

  // answer_token events arrive many per second — write without newline to get
  // a typewriter feel. A newline is printed once a non-token event interrupts.
  let answerStreamOpen = false;

  function closeAnswerStream() {
    if (answerStreamOpen) {
      process.stdout.write('\n');
      answerStreamOpen = false;
    }
  }

  function onEvent(update: StreamingUpdate): void {
    const type = update.type;
    const content: any = update.content || {};

    // Tokens stream mid-line; anything else must close the line first.
    if (type !== 'answer_token' && answerStreamOpen) closeAnswerStream();

    switch (type) {
      case 'progress': {
        const phase = content.phase || 'progress';
        const msg = content.message || '';
        console.log(`${dim('›')} ${cyan(`[${phase}]`)} ${msg}`);
        return;
      }
      case 'thought': {
        const text = (content.thought || '').trim();
        if (!text) return;
        // Dim thoughts so answer tokens remain visually prominent. Wrap long
        // thoughts to keep things readable but don't hard-wrap mid-word.
        for (const line of text.split('\n')) {
          console.log(dim(`  ${line}`));
        }
        return;
      }
      case 'agent_task_dispatched': {
        const tool = content.toolName || 'tool';
        const msg = content.message || tool;
        console.log(`${yellow('↳')} ${msg}`);
        return;
      }
      case 'agent_response': {
        if (!opts.verbose) return;
        const taskId = String(content.taskId || '');
        const resStr = typeof content.result === 'string'
          ? content.result
          : JSON.stringify(content.result);
        const preview = resStr.length > 200 ? `${resStr.slice(0, 200)}…` : resStr;
        console.log(dim(`  ← ${taskId.slice(0, 8)}: ${preview}`));
        return;
      }
      case 'sub_agent_started': {
        const name = content.agentName || 'sub-agent';
        const desc = content.description || '';
        console.log(`${yellow('▸')} sub-agent ${bold(name)}${desc ? ` · ${desc}` : ''}`);
        return;
      }
      case 'sub_agent_completed': {
        const name = content.agentName || 'sub-agent';
        const msg = content.message || '';
        console.log(`${green('✓')} ${msg || `sub-agent ${name} completed`}`);
        return;
      }
      case 'answer_token': {
        const token = content.token || '';
        if (!token) return;
        process.stdout.write(token);
        answerStreamOpen = true;
        return;
      }
      case 'conclusion': {
        // The raw conclusion event may arrive before we're ready to print the
        // framed block — printConclusion() handles the formatted version.
        return;
      }
      case 'error': {
        console.error(red(`✗ ${content.message || 'unknown error'}`));
        return;
      }
      default: {
        if (opts.verbose) console.log(dim(`[event:${type}]`), content);
      }
    }
  }

  // Body already shown while the review ran; printConclusion does not repeat it.
  let provisionalBody: string | undefined;

  function printConclusionHeader(title: string, subtitle?: string): void {
    const bar = '─'.repeat(Math.min(60, (process.stdout.columns || 80) - 4));
    console.log(`\n${cyan(bar)}`);
    console.log(subtitle ? `${bold(title)} ${dim(subtitle)}` : bold(title));
    console.log(cyan(bar));
  }

  function printProvisionalConclusion(conclusion: string): void {
    if (!conclusion.trim()) return;
    closeAnswerStream();
    const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    printConclusionHeader(localize(language, '结论', 'Conclusion'), localize(language,
      '· 正在核验，核验结果随后给出', '· verification in progress; the verdict follows'));
    console.log(conclusion);
    provisionalBody = conclusion;
  }

  function printConclusion(
    conclusion: string,
    meta: ConclusionMetadata,
  ): void {
    closeAnswerStream();
    const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    const bar = '─'.repeat(Math.min(60, (process.stdout.columns || 80) - 4));
    const bodyShown = provisionalBody !== undefined && provisionalBody.trim() === conclusion.trim();
    provisionalBody = undefined;
    if (bodyShown) {
      printConclusionHeader(localize(language, '结论核验', 'Conclusion verification'));
    } else {
      printConclusionHeader('结论');
      console.log(conclusion.trim() ? conclusion : dim(localize(
        language, '未生成可交付结论。', 'No deliverable conclusion was generated.',
      )));
    }
    if (meta.analysisEvidence) {
      console.log('');
      console.log(renderCliAnalysisEvidence(
        loadedCliAnalysisEvidence(meta.analysisEvidence),
        parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
      ));
    }
    console.log(cyan(bar));
    const bits: string[] = [];
    if (meta.confidence !== undefined && meta.confidenceGrounded !== false) {
      bits.push(`confidence ${(meta.confidence * 100).toFixed(0)}%`);
    }
    if (meta.rounds !== undefined) bits.push(`${meta.rounds} rounds`);
    if (meta.durationMs !== undefined) bits.push(`${Math.round(meta.durationMs / 100) / 10}s`);
    if (bits.length) console.log(dim(bits.join(' · ')));
    const claimLine = claimVerificationStatusLine(meta.claimVerification, language);
    if (claimLine) console.log(dim(claimLine));
    for (const line of investigationStatusLines(meta.investigationAssurance, language)) console.log(dim(line));
  }

  function printError(message: string): void {
    closeAnswerStream();
    console.error(red(`\n✗ ${message}`));
  }

  function printCompletion(meta: CompletionMetadata): void {
    closeAnswerStream();
    // A truncated run reached this point with a plain green tick, which is the
    // same thing a complete run prints. Say which one happened.
    const verdict: DeliveryVerdict = meta.deliveryVerdict ??
      (meta.success === false ? 'failed' : meta.partial ? 'partial' : 'completed');
    const mark = verdict === 'failed' ? red('✗') : verdict === 'partial' ? yellow('!')
      : verdict === 'unverified' ? cyan('~') : green('✓');
    console.log(`\n${mark} session ${bold(meta.sessionId)}`);
    if (verdict === 'unverified') {
      const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      console.log(dim(`  ${localize(language, '结论已交付，但核验未完成或覆盖不全，不能视为已核验结论',
        'the conclusion was delivered, but its checks did not complete; do not treat it as verified')}`));
    }
    if (verdict === 'partial' || verdict === 'failed') {
      const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      const reason = meta.terminationReason ? ` (${meta.terminationReason})` : '';
      const message = meta.hasConclusion === false
        ? localize(language, '分析已终止，未生成可交付结论', 'analysis stopped without a deliverable conclusion')
        : meta.terminationReason === 'quality_gate_failed'
          ? localize(language, '已有正文，但未通过质量校验', 'a narrative is available, but quality checks did not pass')
          : localize(language, '分析未完整结束，结果为部分内容', 'analysis did not finish; this is a partial result');
      console.log(dim(`  ${message}${reason}`));
    }
    if (meta.terminationMessage?.trim()) {
      console.log(dim(`  ${meta.terminationMessage.trim()}`));
    }
    console.log(`  ${dim('dir:')}    ${meta.sessionDir}`);
    console.log(`  ${dim('report:')} ${meta.reportPath}`);
    if (meta.turnReportPath) {
      console.log(`  ${dim('turn:')}   ${meta.turnReportPath}`);
    }
    if (meta.sceneReportStatus) {
      console.log(renderCliSceneReport(meta.sceneReportStatus === 'partial' && meta.sceneReport
        ? {status: 'available', reference: meta.sceneReport}
        : {status: 'unavailable', reason: meta.sceneReportUnavailableReason || 'scene_report_missing'},
      parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE)));
    }
    console.log(dim(`\n  open ${meta.reportPath}  ·  smp ask ${meta.sessionId} "..."  ·  smp repl --resume ${meta.sessionId}`));
  }

  return { format, onEvent, printProvisionalConclusion, printConclusion, printError, printCompletion };
}

function createMachineRenderer(format: 'json' | 'ndjson'): Renderer {
  let conclusionPayload: {
    conclusion: string;
    confidence?: number;
    rounds?: number;
    durationMs?: number;
    claimVerification?: ClaimVerificationSummary;
    investigationAssurance?: Pick<AnalysisDeliveryAssurance, 'investigation' | 'investigationEvidence'>;
    analysisEvidence?: CliAnalysisEvidenceOutput;
  } | null = null;

  function emit(obj: Record<string, unknown>, stream: NodeJS.WriteStream = process.stdout): void {
    stream.write(`${JSON.stringify(obj)}\n`);
  }

  function onEvent(update: StreamingUpdate): void {
    if (format !== 'ndjson') return;
    emit({
      type: 'event',
      eventType: update.type,
      content: update.content ?? {},
    });
  }

  function printConclusion(
    conclusion: string,
    meta: ConclusionMetadata,
  ): void {
    conclusionPayload = { conclusion, ...meta };
    if (format === 'ndjson') {
      emit({
        type: 'conclusion',
        ...conclusionPayload,
      });
    }
  }

  function printError(message: string): void {
    emit({
      ok: false,
      type: 'error',
      error: message,
    }, process.stderr);
  }

  function printCompletion(meta: CompletionMetadata): void {
    const scene = {...(meta.sceneReport ? {sceneReport: meta.sceneReport} : {}),
      ...(meta.sceneReportStatus ? {sceneReportStatus: meta.sceneReportStatus} : {}),
      ...(meta.sceneReportUnavailableReason ? {sceneReportUnavailableReason: meta.sceneReportUnavailableReason} : {})};
    if (format === 'ndjson') {
      emit({
        ok: meta.success !== false,
        ...(meta.partial ? { partial: true } : {}),
        ...(meta.terminationReason ? { terminationReason: meta.terminationReason } : {}),
        ...(meta.terminationMessage ? { terminationMessage: meta.terminationMessage } : {}),
        ...(meta.hasConclusion !== undefined ? { hasConclusion: meta.hasConclusion } : {}),
        ...(meta.deliveryVerdict ? { deliveryVerdict: meta.deliveryVerdict } : {}),
        type: 'complete',
        sessionId: meta.sessionId,
        sessionDir: meta.sessionDir,
        reportPath: meta.reportPath,
        ...(meta.turnReportPath ? { turnReportPath: meta.turnReportPath } : {}),
        ...scene,
      });
      return;
    }

    emit({
      ok: meta.success !== false,
      ...(meta.partial ? { partial: true } : {}),
      ...(meta.terminationReason ? { terminationReason: meta.terminationReason } : {}),
      ...(meta.terminationMessage ? { terminationMessage: meta.terminationMessage } : {}),
      ...(meta.hasConclusion !== undefined ? { hasConclusion: meta.hasConclusion } : {}),
      ...(meta.deliveryVerdict ? { deliveryVerdict: meta.deliveryVerdict } : {}),
      sessionId: meta.sessionId,
      sessionDir: meta.sessionDir,
      reportPath: meta.reportPath,
      ...(meta.turnReportPath ? { turnReportPath: meta.turnReportPath } : {}),
      ...(conclusionPayload ?? { conclusion: '' }),
      ...scene,
    });
  }

  return { format, onEvent, printConclusion, printError, printCompletion };
}
