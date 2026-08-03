// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { localize, type OutputLanguage } from '../agentv3/outputLanguage';
import type { AnalysisPlanV3, Hypothesis } from '../agentv3/types';
import { isConclusionLikePlanPhase } from '../agentv3/planPhaseSemantics';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';

interface VerificationIssueLike {
  type?: string;
  message?: string;
}

interface TruncatedFinalReportRepairInput {
  conclusion: string;
  plan: AnalysisPlanV3 | null;
  hypotheses?: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
  missingContractSections?: ReadonlyArray<{
    id: string;
    label: string;
    description?: string;
    recoveryText?: { zh: string[]; en: string[] };
  }>;
  recoveryKind?: 'truncation' | 'missing_contract';
}

export interface InterruptedFinalReportRecoveryInput {
  partialConclusion?: string;
  plan: AnalysisPlanV3 | null;
  hypotheses?: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
}

const MAX_SUMMARY_CHARS = 260;
const MAX_PHASE_BULLETS = 6;
const MAX_HYPOTHESIS_BULLETS = 5;

function hasProperConclusionEnding(line: string): boolean {
  return /[。.!！?？）\]】`✅✓☑→]$/.test(line) ||
    /^```$/.test(line) ||
    /^\|.*\|$/.test(line) ||
    /^\s*-\s*evidence_ref_id=.*\bvalue=.+$/i.test(line) ||
    /^---+$/.test(line);
}

export function isTruncationVerificationIssue(issue: VerificationIssueLike | undefined): boolean {
  if (!issue) return false;
  return issue.type === 'truncation' ||
    /结论文本被截断|conclusion.*truncated|truncated.*conclusion/i.test(issue.message || '');
}

export function findTruncationVerificationIssue(
  issues: readonly VerificationIssueLike[],
): VerificationIssueLike | undefined {
  return issues.find(isTruncationVerificationIssue);
}

function compactOneLine(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string): string {
  const compact = compactOneLine(value);
  if (compact.length <= MAX_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function collectPhaseBullets(
  plan: AnalysisPlanV3 | null,
  outputLanguage: OutputLanguage,
): string[] {
  if (!plan) return [];
  return plan.phases
    .filter(phase => (phase.status === 'completed' || phase.status === 'skipped') && phase.summary)
    .filter(phase => !isConclusionLikePlanPhase(phase))
    .map(phase => {
      const label = phase.name || phase.id;
      const status = phase.status === 'skipped'
        ? localize(outputLanguage, '已跳过', 'skipped')
        : localize(outputLanguage, '已完成', 'done');
      return `${label} (${status}): ${truncateSummary(phase.summary || '')}`;
    })
    .filter(line => line.length > 0)
    .slice(0, MAX_PHASE_BULLETS);
}

function collectHypothesisBullets(
  hypotheses: readonly Hypothesis[] | undefined,
  outputLanguage: OutputLanguage,
): string[] {
  return (hypotheses || [])
    .filter(h => h.status === 'confirmed' || h.status === 'rejected')
    .map(h => {
      const evidence = compactOneLine(h.evidence);
      const suffix = evidence
        ? localize(
            outputLanguage,
            `；证据：${truncateSummary(evidence)}`,
            `; evidence: ${truncateSummary(evidence)}`,
          )
        : '';
      return `${h.status}: ${truncateSummary(h.statement)}${suffix}`;
    })
    .slice(0, MAX_HYPOTHESIS_BULLETS);
}

function dropIncompleteLastLine(text: string): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split(/\r?\n/);
  const lastLine = (lines[lines.length - 1] || '').trim();
  if (lastLine.length <= 15 || hasProperConclusionEnding(lastLine)) {
    return trimmed;
  }
  lines.pop();
  return lines.join('\n').trimEnd();
}

function renderBullets(lines: readonly string[], fallback: string): string {
  const source = lines.length > 0 ? lines : [fallback];
  return source.map(line => `- ${line}`).join('\n');
}

function renderRecoveredContractSections(
  sections: ReadonlyArray<{
    id: string;
    label: string;
    recoveryText?: { zh: string[]; en: string[] };
  }> | undefined,
  phaseBullets: readonly string[],
  outputLanguage: OutputLanguage,
): string {
  if (!sections?.length) return '';
  const evidence = renderBullets(
    phaseBullets,
    renderRequiredLocalizedStrategyTemplate(
      'report-runtime-recovery-section-evidence-empty',
      outputLanguage,
      {},
    ),
  );
  return sections.map(section => {
    const englishTitle = section.id
      .split(/[_-]+/)
      .filter(Boolean)
      .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(' ');
    const title = localize(outputLanguage, section.label, englishTitle || section.label);
    const recoveryLines = outputLanguage === 'zh-CN'
      ? section.recoveryText?.zh || []
      : section.recoveryText?.en || [];
    const recovery = recoveryLines.length > 0
      ? `${renderBullets(recoveryLines.map(line => compactOneLine(line)), '')}\n\n`
      : '';
    return renderRequiredLocalizedStrategyTemplate(
      'report-runtime-recovery-contract-section',
      outputLanguage,
      {
        title: compactOneLine(title),
        recovery,
        evidence,
      },
    );
  }).join('\n\n');
}

export function repairTruncatedFinalReport(
  input: TruncatedFinalReportRepairInput,
): string | undefined {
  const recoveryKind = input.recoveryKind ?? 'truncation';
  const base = recoveryKind === 'truncation'
    ? dropIncompleteLastLine(input.conclusion)
    : input.conclusion.trimEnd();
  if (!base.trim()) return undefined;

  const phaseBullets = collectPhaseBullets(input.plan, input.outputLanguage);
  const hypothesisBullets = collectHypothesisBullets(input.hypotheses, input.outputLanguage);
  const recoveredContractSections = renderRecoveredContractSections(
    input.missingContractSections,
    phaseBullets,
    input.outputLanguage,
  );
  const phaseEvidence = renderBullets(
    phaseBullets,
    renderRequiredLocalizedStrategyTemplate(
      'report-runtime-recovery-phase-empty',
      input.outputLanguage,
      {},
    ),
  );
  const hypothesisEvidence = renderBullets(
    hypothesisBullets,
    renderRequiredLocalizedStrategyTemplate(
      'report-runtime-recovery-hypothesis-empty',
      input.outputLanguage,
      {},
    ),
  );
  const repaired = renderRequiredLocalizedStrategyTemplate(
    recoveryKind === 'truncation'
      ? 'report-runtime-recovery-truncation'
      : 'report-runtime-recovery-missing-contract',
    input.outputLanguage,
    {
      base,
      recoveredSections: recoveredContractSections,
      phaseEvidence,
      hypothesisEvidence,
    },
  ).trim();

  return repaired.length > input.conclusion.trim().length ? repaired : undefined;
}

/**
 * Repair an existing streamed report after a runtime interruption. Plan state
 * may supply bounded evidence for the recovery appendix, but it must never be
 * used to manufacture a report when the model produced no deliverable answer.
 * Callers remain responsible for validating partialConclusion and preserving
 * the partial result contract.
 */
export function recoverInterruptedFinalReport(
  input: InterruptedFinalReportRecoveryInput,
): string | undefined {
  const partialConclusion = input.partialConclusion?.trim() || '';
  if (!partialConclusion) return undefined;

  return repairTruncatedFinalReport({
    conclusion: partialConclusion,
    plan: input.plan,
    hypotheses: input.hypotheses,
    outputLanguage: input.outputLanguage,
    recoveryKind: 'truncation',
  }) || partialConclusion;
}
