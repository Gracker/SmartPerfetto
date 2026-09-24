// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract, ConclusionContractClaimReference } from '../agent/core/conclusionContract';
import { formatDurationNs } from '../agentv3/focusAppDetector';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import type { SelectionContext } from '../agentv3/types';
import type { DataEnvelope } from '../types/dataContract';
import type { FocusAppEvidencePayload } from './focusAppEvidence';
import {
  cellText,
  columnIndex,
  numericValue,
  rowValue,
} from './quickEvidenceTable';
import type { QuickStructuredDirectAnswer } from './quickDirectAnswerContract';

export interface QuickFocusAppDirectAnswer extends QuickStructuredDirectAnswer {}

const FOCUS_APP_PATTERNS = [
  /焦点应用|前台应用|focus(?:ed)?\s+app|foreground\s+app/i,
  /(?:当前|这个|本次|该)\s*(?:trace\s*)?(?:的)?\s*(?:当前|前台|焦点)?应用(?:包名)?(?:是什么|是哪个|是哪一个|是哪款|叫什么|是谁)/i,
  /(?:哪个|哪一个|什么)应用(?:在|处于)?(?:前台|焦点)(?:[？?。.!\s]*)$/i,
  /\b(?:what|which)\s+(?:current|foreground|focused)\s+app(?:lication)?\b/i,
  /\b(?:current|foreground|focused)\s+app(?:lication)?\s+(?:name|package|identity)?\b/i,
  /^\s*(?:前台|焦点)(?:应用)?包名(?:是什么|是哪个|是哪一个|叫什么)?(?:[？?。.!\s]*)$/i,
  /^\s*(?:what|which)\s+(?:is|was)\s+(?:the\s+)?(?:foreground|focused)\s+(?:app(?:lication)?\s+)?package(?:\s+name)?\s*[?？.。!！]*$/i,
  /^\s*(?:foreground|focused)\s+(?:app(?:lication)?\s+)?package(?:\s+name|identity)?\s*[?？.。!！]*$/i,
];
const SELECTION_APP_IDENTITY_PATTERNS = [
  /(?:选区|选中(?:的)?|范围|selection|selected\s+range|slice).*(?:应用|app|package|包名).*(?:是什么|是哪个|哪一个|which|what)/i,
  /(?:是什么|是哪个|哪一个|which|what).*(?:选区|选中(?:的)?|范围|selection|selected\s+range|slice).*(?:应用|app|package|包名)/i,
];
const NON_IDENTITY_DETAIL_PATTERN = /(?:为什么|原因|root\s*cause|分析|性能|卡顿|掉帧|丢帧|jank|fps|帧率|多少帧|多少线程|多少进程|线程|进程|process|pid|upid|cpu|耗时|延迟|瓶颈|优化)/i;

function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some(pattern => pattern.test(value));
}

export function shouldUseQuickFocusAppDirectAnswer(input: {
  query: string;
  selectionContext?: SelectionContext;
}): boolean {
  const query = input.query.trim();
  if (!query) return false;
  if (NON_IDENTITY_DETAIL_PATTERN.test(query)) return false;
  if (matchesAny(FOCUS_APP_PATTERNS, query)) return true;
  return Boolean(input.selectionContext && matchesAny(SELECTION_APP_IDENTITY_PATTERNS, query));
}

function directClaimReference(input: {
  envelope: DataEnvelope;
  column: string;
  value: string | number | boolean;
  rowIndex?: number;
}): ConclusionContractClaimReference {
  return {
    evidenceRefId: input.envelope.meta.evidenceRefId,
    sourceToolCallId: input.envelope.meta.sourceToolCallId,
    sourceRef: input.envelope.display?.title,
    rowIndex: input.rowIndex ?? 0,
    column: input.column,
    value: input.value,
  };
}

function buildDirectConclusionContract(input: {
  statement: string;
  evidenceText: string;
  references: ConclusionContractClaimReference[];
}): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [{
      rank: 1,
      statement: input.statement,
      confidencePercent: 100,
    }],
    clusters: [],
    evidenceChain: [{
      conclusionId: 'qfa-1',
      text: input.evidenceText,
    }],
    claims: [{
      id: 'quick-focus-app',
      conclusionId: 'qfa-1',
      text: input.statement,
      kind: 'categorical',
      references: input.references,
    }],
    uncertainties: [],
    nextSteps: [],
    metadata: {
      confidencePercent: 100,
      rounds: 0,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

function buildDirectConclusion(input: {
  statement: string;
  evidenceRefId: string;
  sourceRef: string;
  rows: string[];
  outputLanguage: OutputLanguage;
}): string {
  const evidenceLines = input.rows.map(row => `  - ${row}`).join('\n');
  return localize(
    input.outputLanguage,
    `${input.statement}\n\n## 逐句数据引用（结构化来源）\n- Q1: ${input.statement}\n  - evidence_ref_id=\`${input.evidenceRefId}\`; source_ref=${input.sourceRef}\n${evidenceLines}`,
    `${input.statement}\n\n## Sentence-Level Data References\n- Q1: ${input.statement}\n  - evidence_ref_id=\`${input.evidenceRefId}\`; source_ref=${input.sourceRef}\n${evidenceLines}`,
  );
}

export function buildQuickFocusAppDirectAnswer(input: {
  query: string;
  evidence?: FocusAppEvidencePayload;
  selectionContext?: SelectionContext;
  outputLanguage?: OutputLanguage;
}): QuickFocusAppDirectAnswer | undefined {
  if (!shouldUseQuickFocusAppDirectAnswer({
    query: input.query,
    selectionContext: input.selectionContext,
  })) {
    return undefined;
  }

  const envelope = input.evidence?.envelope;
  if (!envelope?.data.columns || !envelope.data.rows?.length) return undefined;
  const row = envelope.data.rows[0];
  if (!Array.isArray(row)) return undefined;

  const evidenceRefId = envelope.meta.evidenceRefId;
  if (!evidenceRefId) return undefined;

  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const index = columnIndex(envelope.data.columns);
  if (cellText(rowValue(row, index, 'detection_confidence')) === 'ambiguous') {
    return buildAmbiguousFocusAppAnswer({envelope, index, evidenceRefId, outputLanguage,
      scoped: numericValue(rowValue(row, index, 'scope_start_ns')) !== undefined,
      selectionContext: input.selectionContext});
  }
  const packageName = cellText(rowValue(row, index, 'package_name'));
  const foregroundDurationNs = numericValue(rowValue(row, index, 'foreground_duration_ns'));
  const foregroundCount = numericValue(rowValue(row, index, 'foreground_count'));
  const countSource = cellText(rowValue(row, index, 'count_source'));
  const detectionMethod = cellText(rowValue(row, index, 'detection_method'));
  if (
    !packageName
    || packageName === '-'
    || foregroundDurationNs === undefined
    || foregroundDurationNs < 0
    || foregroundCount === undefined
    || foregroundCount < 0
    || !countSource
    || countSource === '-'
  ) {
    return undefined;
  }

  const scopeStartNs = numericValue(rowValue(row, index, 'scope_start_ns'));
  const scopeEndNs = numericValue(rowValue(row, index, 'scope_end_ns'));
  const scoped = scopeStartNs !== undefined && scopeEndNs !== undefined;
  if (input.selectionContext && !scoped) return undefined;
  const durationText = formatDurationNs(foregroundDurationNs);
  const cpuDuration = cellText(rowValue(row, index, 'duration_source')) === 'cpu_running';
  const countLabel = countSource === 'frame_count'
    ? localize(outputLanguage, `共 ${foregroundCount ?? 0} 帧`, `${foregroundCount ?? 0} frames`)
    : countSource === 'none'
      ? ''
      : localize(outputLanguage, `前台切换 ${foregroundCount ?? 0} 次`, `${foregroundCount ?? 0} foreground switches`);
  const scopeText = scoped
    ? localize(outputLanguage, '当前选区/范围内的', 'the selected range')
    : localize(outputLanguage, '当前 trace 的', 'the current trace');
  const statement = cpuDuration
    ? localize(
      outputLanguage,
      `${scopeText}焦点应用（按 CPU 活动推断）是 ${packageName}，CPU 运行时长 ${durationText}。`,
      `The focus app in ${scopeText}, inferred from CPU activity, is ${packageName}, with ${durationText} of CPU running time.`,
    )
    : localize(
      outputLanguage,
      `${scopeText}焦点应用是 ${packageName}，前台时长 ${durationText}，${countLabel}。`,
      `The focus app in ${scopeText} is ${packageName}, with ${durationText} foreground time and ${countLabel}.`,
    );
  const sourceRef = envelope.display?.title ?? envelope.meta.source ?? 'runtime focus app detection';
  const references: ConclusionContractClaimReference[] = [
    directClaimReference({ envelope, column: 'package_name', value: packageName }),
    directClaimReference({ envelope, column: 'foreground_duration_ns', value: foregroundDurationNs }),
    ...(foregroundCount !== undefined
      ? [directClaimReference({ envelope, column: 'foreground_count', value: foregroundCount })]
      : []),
    directClaimReference({ envelope, column: 'count_source', value: countSource }),
    directClaimReference({ envelope, column: 'detection_method', value: detectionMethod }),
    ...(scoped
      ? [
        directClaimReference({ envelope, column: 'scope_start_ns', value: scopeStartNs }),
        directClaimReference({ envelope, column: 'scope_end_ns', value: scopeEndNs }),
      ]
      : []),
  ];
  const evidenceRows = [
    `column=\`package_name\`; value=\`${packageName}\``,
    `column=\`foreground_duration_ns\`; value=\`${foregroundDurationNs}\``,
    ...(foregroundCount !== undefined
      ? [`column=\`foreground_count\`; value=\`${foregroundCount}\``]
      : []),
    `column=\`detection_method\`; value=\`${detectionMethod}\``,
    ...(scoped
      ? [`columns=\`scope_start_ns,scope_end_ns\`; values=\`${scopeStartNs}, ${scopeEndNs}\``]
      : []),
  ];

  return {
    conclusion: buildDirectConclusion({
      statement,
      evidenceRefId,
      sourceRef,
      rows: evidenceRows,
      outputLanguage,
    }),
    conclusionContract: buildDirectConclusionContract({
      statement,
      evidenceText: scoped
        ? `${sourceRef}: package_name=${packageName}, foreground_duration_ns=${foregroundDurationNs}, foreground_count=${foregroundCount ?? '-'}, detection_method=${detectionMethod}, scope_start_ns=${scopeStartNs}, scope_end_ns=${scopeEndNs}`
        : `${sourceRef}: package_name=${packageName}, foreground_duration_ns=${foregroundDurationNs}, foreground_count=${foregroundCount ?? '-'}, detection_method=${detectionMethod}`,
      references,
    }),
    confidence: 1,
  };
}

/** Ambiguous detection: no primary app, so the answer is the ranked candidate list. */
function buildAmbiguousFocusAppAnswer(input: {
  envelope: DataEnvelope;
  index: ReturnType<typeof columnIndex>;
  evidenceRefId: string;
  outputLanguage: OutputLanguage;
  scoped: boolean;
  selectionContext?: SelectionContext;
}): QuickFocusAppDirectAnswer | undefined {
  if (input.selectionContext && !input.scoped) return undefined;
  const rows = (input.envelope.data.rows ?? []).filter(Array.isArray).slice(0, 5);
  const candidates = rows
    .map((row, rowIndex) => ({rowIndex, packageName: cellText(rowValue(row, input.index, 'package_name'))}))
    .filter(candidate => candidate.packageName && candidate.packageName !== '-');
  if (candidates.length === 0) return undefined;
  const names = candidates.map(candidate => candidate.packageName).join(', ');
  const scopeText = input.scoped
    ? localize(input.outputLanguage, '当前选区/范围内的', 'the selected range')
    : localize(input.outputLanguage, '当前 trace 的', 'the current trace');
  const statement = localize(
    input.outputLanguage,
    `${scopeText}焦点应用无法确定；按证据排序的候选为 ${names}。`,
    `The focus app in ${scopeText} cannot be determined; candidates ranked by evidence: ${names}.`,
  );
  const sourceRef = input.envelope.display?.title ?? input.envelope.meta.source ?? 'runtime focus app detection';
  const references = candidates.map(candidate => directClaimReference({
    envelope: input.envelope, column: 'package_name', value: candidate.packageName, rowIndex: candidate.rowIndex,
  }));
  const contract = buildDirectConclusionContract({
    statement,
    evidenceText: `${sourceRef}: detection_confidence=ambiguous, candidates=${names}`,
    references,
  });
  return {
    conclusion: buildDirectConclusion({
      statement,
      evidenceRefId: input.evidenceRefId,
      sourceRef,
      rows: candidates.map(candidate => `row=${candidate.rowIndex}; column=\`package_name\`; value=\`${candidate.packageName}\``),
      outputLanguage: input.outputLanguage,
    }),
    conclusionContract: {
      ...contract,
      conclusions: contract.conclusions.map(conclusion => ({...conclusion, confidencePercent: 50})),
      metadata: {...contract.metadata, confidencePercent: 50},
    },
    confidence: 0.5,
  };
}
