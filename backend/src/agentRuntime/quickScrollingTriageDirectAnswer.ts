// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract, ConclusionContractClaimReference } from '../agent/core/conclusionContract';
import type { AnalysisOptions } from '../agent/core/orchestratorTypes';
import type {
  FocusAppDetectionResult,
  FocusAppTimeRange,
} from '../agentv3/focusAppDetector';
import { focusAppTimeRangeFromSelection } from '../agentv3/focusAppDetector';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {
  QUICK_REFERENCE_HEADING,
  QUICK_TRIAGE_HEADING,
  QUICK_TRIAGE_MAX_CLAIMS,
  QUICK_TRIAGE_MAX_REFERENCES_PER_CLAIM,
  QUICK_TRIAGE_MAX_REFERENCE_VALUE_CHARS,
  QUICK_TRIAGE_MAX_STATEMENT_CHARS,
} from '../agentv3/quickAnswerContract';
import { shouldUseQuickScrollingTriageIntent } from '../agentv3/quickScrollingTriageIntent';
import {
  createSkillExecutor,
  SkillExecutor,
} from '../services/skillEngine/skillExecutor';
import {
  ensureSkillRegistryInitialized,
  skillRegistry,
} from '../services/skillEngine/skillLoader';
import {
  resolveEffectiveSkillRegistryForRuntime,
} from '../services/selfEvolution/effectiveRuntimeRegistryProvider';
import type { TraceProcessorService } from '../services/traceProcessorService';
import type { DataEnvelope, DataEnvelopeTraceSide } from '../types/dataContract';
import type { QuickStructuredDirectAnswer } from './quickDirectAnswerContract';
import {
  cellText,
  columnIndex,
  envelopeRows,
  numericValue,
  primitiveValue,
  rowValue,
  runtimeSkillSourceToolCallId,
  stableQuickEvidenceHash,
  withQuickEvidenceProvenance,
} from './quickEvidenceTable';

const SCROLLING_SKILL_ID = 'scrolling_analysis';
const QUICK_SCROLLING_TRIAGE_EVIDENCE_STEP_IDS = new Set([
  'performance_summary',
  'input_latency_summary',
  'batch_frame_root_cause',
]);

export interface QuickScrollingTriageEvidencePayload {
  envelopes: DataEnvelope[];
  effectivePackageName?: string;
}

export interface QuickScrollingTriageDirectAnswer extends QuickStructuredDirectAnswer {}

interface DirectClaim {
  id: string;
  label: string;
  statement: string;
  kind: NonNullable<NonNullable<ConclusionContract['claims']>[number]['kind']>;
  evidenceText: string;
  references: ConclusionContractClaimReference[];
}

export function shouldUseQuickScrollingTriageDirectAnswer(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
}): boolean {
  return shouldUseQuickScrollingTriageIntent({ query: input.query });
}

export function buildQuickScrollingTriageSkillParams(input: {
  effectivePackageName?: string;
  timeRange?: FocusAppTimeRange;
}): Record<string, unknown> {
  return {
    package: input.effectivePackageName ?? '',
    enable_frame_details: false,
    max_frames_per_session: 10,
    enable_expert_probes: false,
    ...(input.timeRange ? { start_ts: input.timeRange.startNs, end_ts: input.timeRange.endNs } : {}),
  };
}

export function selectQuickScrollingTriageEvidenceEnvelopes(envelopes: DataEnvelope[]): DataEnvelope[] {
  return envelopes.filter(envelope => {
    const stepId = envelope.meta.stepId;
    return stepId !== undefined && QUICK_SCROLLING_TRIAGE_EVIDENCE_STEP_IDS.has(stepId);
  });
}

function resolveTimeRange(input: {
  selectionContext?: AnalysisOptions['selectionContext'];
  focusResult?: FocusAppDetectionResult;
}): FocusAppTimeRange | undefined {
  return focusAppTimeRangeFromSelection(input.selectionContext) ?? input.focusResult?.timeRange;
}

function withQuickScrollingProvenance(
  envelope: DataEnvelope,
  input: {
    traceId: string;
    traceSide: DataEnvelopeTraceSide;
    queryHash: string;
    sourceToolCallId: string;
    index: number;
    outputLanguage: OutputLanguage;
  },
): DataEnvelope {
  return withQuickEvidenceProvenance(envelope, {
    skillId: SCROLLING_SKILL_ID,
    traceId: input.traceId,
    traceSide: input.traceSide,
    queryHash: input.queryHash,
    sourceToolCallId: input.sourceToolCallId,
    index: input.index,
    planPhaseGoal: localize(input.outputLanguage, '复用滑动性能 Skill 结果回答概览类问题', 'Reuse scrolling Skill output for overview questions'),
    toolNarration: localize(input.outputLanguage, '执行 scrolling_analysis 获取滑动概览', 'Run scrolling_analysis for the scrolling overview'),
    producerReason: localize(
      input.outputLanguage,
      '快速问答概览问题由 scrolling_analysis 结构化结果直接支持。',
      'The quick overview question is directly supported by structured scrolling_analysis output.',
    ),
    intent: 'runtime_scrolling_triage',
    outputLanguage: input.outputLanguage,
  });
}

export async function buildQuickScrollingTriageEvidence(input: {
  traceProcessorService: TraceProcessorService;
  traceId: string;
  packageName?: string;
  focusResult?: FocusAppDetectionResult;
  selectionContext?: AnalysisOptions['selectionContext'];
  outputLanguage?: OutputLanguage;
}): Promise<QuickScrollingTriageEvidencePayload | undefined> {
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const traceSide: DataEnvelopeTraceSide = 'current';
  const effectivePackageName = input.packageName || input.focusResult?.primaryApp;
  const timeRange = resolveTimeRange({
    selectionContext: input.selectionContext,
    focusResult: input.focusResult,
  });
  const params = buildQuickScrollingTriageSkillParams({ effectivePackageName, timeRange });
  const queryHash = stableQuickEvidenceHash({
    traceId: input.traceId,
    traceSide,
    skillId: SCROLLING_SKILL_ID,
    params,
  });
  const toolCallId = runtimeSkillSourceToolCallId(SCROLLING_SKILL_ID, queryHash);

  await ensureSkillRegistryInitialized();
  const skillExecutor = createSkillExecutor(input.traceProcessorService);
  const effectiveSkillRegistry =
    resolveEffectiveSkillRegistryForRuntime(skillRegistry);
  skillExecutor.registerSkills(effectiveSkillRegistry.getAllSkills());
  skillExecutor.setFragmentRegistry(
    effectiveSkillRegistry.getFragmentCache(),
  );

  const result = await skillExecutor.execute(
    SCROLLING_SKILL_ID,
    input.traceId,
    params,
    { __traceSide: traceSide },
  );
  if (!result.success || result.displayResults.length === 0) return undefined;

  const envelopes = selectQuickScrollingTriageEvidenceEnvelopes(SkillExecutor.toDataEnvelopes(result, undefined, {
    traceId: input.traceId,
    traceSide,
  })).map((envelope, index) => withQuickScrollingProvenance(envelope, {
    traceId: input.traceId,
    traceSide,
    queryHash,
      sourceToolCallId: toolCallId,
      index,
      outputLanguage,
    }));
  if (!envelopes.some(envelope => envelope.meta.stepId === 'performance_summary')) {
    return undefined;
  }
  return {
    envelopes,
    effectivePackageName,
  };
}

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined) return '-';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

function findEnvelope(envelopes: DataEnvelope[], stepId: string): DataEnvelope | undefined {
  return envelopes.find(envelope =>
    envelope.meta.stepId === stepId &&
    Array.isArray(envelope.data.columns) &&
    Array.isArray(envelope.data.rows) &&
    envelope.data.rows.length > 0);
}

function directClaimReference(input: {
  envelope: DataEnvelope;
  rowIndex: number;
  column: string;
  value: unknown;
}): ConclusionContractClaimReference | undefined {
  const value = primitiveValue(input.value);
  if (value === undefined || !input.envelope.meta.evidenceRefId) return undefined;
  return {
    evidenceRefId: input.envelope.meta.evidenceRefId,
    sourceToolCallId: input.envelope.meta.sourceToolCallId,
    sourceRef: input.envelope.display?.title,
    rowIndex: input.rowIndex,
    column: input.column,
    value,
  };
}

function referencesForColumns(input: {
  envelope: DataEnvelope;
  row: unknown[];
  rowIndex: number;
  columns: string[];
}): ConclusionContractClaimReference[] {
  const index = columnIndex(input.envelope.data.columns ?? []);
  return input.columns
    .map(column => directClaimReference({
      envelope: input.envelope,
      rowIndex: input.rowIndex,
      column,
      value: rowValue(input.row, index, column),
    }))
    .filter((ref): ref is ConclusionContractClaimReference => Boolean(ref));
}

function sourceRef(envelope: DataEnvelope): string {
  return envelope.display?.title ?? envelope.meta.source ?? SCROLLING_SKILL_ID;
}

function truncateQuickValue(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= QUICK_TRIAGE_MAX_REFERENCE_VALUE_CHARS) return text;
  return `${text.slice(0, QUICK_TRIAGE_MAX_REFERENCE_VALUE_CHARS - 3)}...`;
}

function truncateQuickStatement(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= QUICK_TRIAGE_MAX_STATEMENT_CHARS) return normalized;
  return `${normalized.slice(0, QUICK_TRIAGE_MAX_STATEMENT_CHARS - 3)}...`;
}

function buildReferenceLines(claims: DirectClaim[]): string {
  return claims.map((claim, index) => {
    const first = claim.references[0];
    const sampledRefs = claim.references.slice(0, QUICK_TRIAGE_MAX_REFERENCES_PER_CLAIM);
    const columns = sampledRefs
      .map(ref => ref.column)
      .filter((column): column is string => Boolean(column))
      .join(',');
    const values = sampledRefs
      .map(ref => truncateQuickValue(ref.value))
      .filter(Boolean)
      .join(', ');
    const parts = [
      first?.evidenceRefId ? `evidence_ref_id=\`${first.evidenceRefId}\`` : undefined,
      columns ? `cols=\`${columns}\`` : undefined,
      values ? `vals=\`${values}\`` : undefined,
    ].filter(Boolean);
    return `- Q${index + 1}: ${parts.join('; ')}`;
  }).join('\n');
}

function buildConclusionText(input: {
  claims: DirectClaim[];
  boundary: string;
  outputLanguage: OutputLanguage;
}): string {
  const summaryLines = input.claims.map(claim => `- ${truncateQuickStatement(claim.statement)}`).join('\n');
  const refs = buildReferenceLines(input.claims);
  const evidenceIndexLine = localize(
    input.outputLanguage,
    '证据索引：以下 evidence_ref_id 对应已发送结构化数据。',
    'Evidence index: the evidence_ref_id values below map to emitted structured data.',
  );
  return localize(
    input.outputLanguage,
    `${QUICK_TRIAGE_HEADING}\n${summaryLines}\n\n边界：${input.boundary}\n\n${QUICK_REFERENCE_HEADING}\n${evidenceIndexLine}\n${refs}`,
    `## Quick Triage\n${summaryLines}\n\nBoundary: ${input.boundary}\n\n## Sentence-Level Data References\n${evidenceIndexLine}\n${refs}`,
  );
}

function buildConclusionContract(input: {
  claims: DirectClaim[];
  boundary: string;
  outputLanguage: OutputLanguage;
}): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: input.claims.map((claim, index) => ({
      rank: index + 1,
      statement: claim.statement,
      confidencePercent: index === 0 ? 98 : 95,
    })),
    clusters: [],
    evidenceChain: input.claims.map(claim => ({
      conclusionId: claim.id,
      text: claim.evidenceText,
    })),
    claims: input.claims.map(claim => ({
      id: claim.id,
      conclusionId: claim.id,
      text: claim.statement,
      kind: claim.kind,
      references: claim.references,
    })),
    uncertainties: [input.boundary],
    nextSteps: [
      localize(
        input.outputLanguage,
        '如需逐帧调用栈、Binder server 或锁等待归因，切换完整模式并对代表帧深钻。',
        'For per-frame call stacks, Binder server attribution, or lock-wait attribution, switch to full mode and drill into representative frames.',
      ),
    ],
    metadata: {
      confidencePercent: 95,
      rounds: 0,
      claimDerivation: 'explicit_model_contract',
      claimVerificationScope: 'explicit_claims',
    },
  };
}

function buildPerformanceClaims(input: {
  envelopes: DataEnvelope[];
  outputLanguage: OutputLanguage;
}): DirectClaim[] {
  const envelope = findEnvelope(input.envelopes, 'performance_summary');
  if (!envelope) return [];
  const row = envelopeRows(envelope)[0];
  if (!row) return [];
  const index = columnIndex(envelope.data.columns ?? []);
  const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
  const perceivedJankFrames = numericValue(rowValue(row, index, 'perceived_jank_frames'));
  const jankRate = numericValue(rowValue(row, index, 'jank_rate'));
  const actualFps = numericValue(rowValue(row, index, 'actual_fps'));
  const refreshRate = numericValue(rowValue(row, index, 'refresh_rate'));
  const rating = cellText(rowValue(row, index, 'rating'));
  if (!totalFrames || totalFrames <= 0 || perceivedJankFrames === undefined || jankRate === undefined) {
    return [];
  }

  const performanceStatement = localize(
    input.outputLanguage,
    `滑动性能概览：评级 ${rating}；共 ${totalFrames} 帧，感知掉帧 ${perceivedJankFrames} 帧（${formatNumber(jankRate)}%），FPS ${formatNumber(actualFps)}/${formatNumber(refreshRate)}Hz。`,
    `Scrolling summary: rating ${rating}; ${totalFrames} frames, ${perceivedJankFrames} perceived janky frames (${formatNumber(jankRate)}%), FPS ${formatNumber(actualFps)}/${formatNumber(refreshRate)}Hz.`,
  );
  const performanceRefs = referencesForColumns({
    envelope,
    row,
    rowIndex: 0,
    columns: ['total_frames', 'perceived_jank_frames', 'jank_rate', 'actual_fps', 'refresh_rate', 'rating'],
  });

  const appJankyFrames = numericValue(rowValue(row, index, 'app_janky_frames'));
  const sfJankCount = numericValue(rowValue(row, index, 'sf_jank_count'));
  const bufferStuffingFrames = numericValue(rowValue(row, index, 'buffer_stuffing_frames'));
  const bufferStuffingRate = numericValue(rowValue(row, index, 'buffer_stuffing_rate'));
  const responsibilityStatement = localize(
    input.outputLanguage,
    `责任分布：App 侧掉帧 ${formatNumber(appJankyFrames)} 帧，SF/消费侧 ${formatNumber(sfJankCount)} 帧，Buffer Stuffing ${formatNumber(bufferStuffingFrames)} 帧（${formatNumber(bufferStuffingRate)}%）。`,
    `Responsibility split: ${formatNumber(appJankyFrames)} app-side janky frames, ${formatNumber(sfJankCount)} SF/consumer-side frames, and ${formatNumber(bufferStuffingFrames)} Buffer Stuffing frames (${formatNumber(bufferStuffingRate)}%).`,
  );
  const responsibilityRefs = referencesForColumns({
    envelope,
    row,
    rowIndex: 0,
    columns: ['app_janky_frames', 'sf_jank_count', 'buffer_stuffing_frames', 'buffer_stuffing_rate'],
  });

  const claims: DirectClaim[] = [
    {
      id: 'quick-scrolling-performance',
      label: localize(input.outputLanguage, '性能概览', 'performance summary'),
      statement: performanceStatement,
      kind: 'numeric',
      evidenceText: `${sourceRef(envelope)}: total_frames=${totalFrames}, perceived_jank_frames=${perceivedJankFrames}, jank_rate=${jankRate}`,
      references: performanceRefs,
    },
    {
      id: 'quick-scrolling-responsibility',
      label: localize(input.outputLanguage, '责任分布', 'responsibility split'),
      statement: responsibilityStatement,
      kind: 'numeric',
      evidenceText: `${sourceRef(envelope)}: app_janky_frames=${appJankyFrames}, sf_jank_count=${sfJankCount}, buffer_stuffing_frames=${bufferStuffingFrames}`,
      references: responsibilityRefs,
    },
  ];
  return claims
    .filter(claim => claim.references.length > 0)
    .slice(0, QUICK_TRIAGE_MAX_CLAIMS);
}

function buildInputLatencyClaim(input: {
  envelopes: DataEnvelope[];
  outputLanguage: OutputLanguage;
}): DirectClaim | undefined {
  const envelope = findEnvelope(input.envelopes, 'input_latency_summary');
  if (!envelope) return undefined;
  const row = envelopeRows(envelope)[0];
  if (!row) return undefined;
  const index = columnIndex(envelope.data.columns ?? []);
  const totalInputEvents = numericValue(rowValue(row, index, 'total_input_events'));
  if (!totalInputEvents || totalInputEvents <= 0) return undefined;
  const moveEvents = numericValue(rowValue(row, index, 'move_events'));
  const p95HandlingMs = numericValue(rowValue(row, index, 'p95_handling_ms'));
  const maxHandlingMs = numericValue(rowValue(row, index, 'max_handling_ms'));
  const maxE2eMs = numericValue(rowValue(row, index, 'max_e2e_ms'));
  const slowHandlingEvents = numericValue(rowValue(row, index, 'slow_handling_events'));
  const inputBacklogFrames = numericValue(rowValue(row, index, 'input_backlog_frames'));
  const rating = cellText(rowValue(row, index, 'input_latency_rating'));
  const statement = localize(
    input.outputLanguage,
    `Input 延迟概览：评级 ${rating}；输入事件 ${totalInputEvents} 个，MOVE ${formatNumber(moveEvents)} 个，P95 App 处理 ${formatNumber(p95HandlingMs)}ms，最慢 Input→Present ${formatNumber(maxE2eMs)}ms，慢处理 ${formatNumber(slowHandlingEvents)} 个，输入堆积帧 ${formatNumber(inputBacklogFrames)} 个。`,
    `Input latency summary: rating ${rating}; ${totalInputEvents} input events, ${formatNumber(moveEvents)} MOVE events, P95 app handling ${formatNumber(p95HandlingMs)}ms, max Input-to-Present ${formatNumber(maxE2eMs)}ms, ${formatNumber(slowHandlingEvents)} slow handling events, ${formatNumber(inputBacklogFrames)} backlog frames.`,
  );
  const references = referencesForColumns({
    envelope,
    row,
    rowIndex: 0,
    columns: ['total_input_events', 'move_events', 'p95_handling_ms', 'max_handling_ms', 'max_e2e_ms', 'slow_handling_events', 'input_backlog_frames', 'input_latency_rating'],
  });
  if (references.length === 0) return undefined;
  return {
    id: 'quick-scrolling-input-latency',
    label: localize(input.outputLanguage, 'Input 延迟', 'input latency'),
    statement,
    kind: 'numeric',
    evidenceText: `${sourceRef(envelope)}: total_input_events=${totalInputEvents}, max_handling_ms=${maxHandlingMs}, max_e2e_ms=${maxE2eMs}`,
    references,
  };
}

function buildRootCauseClaim(input: {
  envelopes: DataEnvelope[];
  outputLanguage: OutputLanguage;
}): DirectClaim | undefined {
  const envelope = findEnvelope(input.envelopes, 'batch_frame_root_cause');
  if (!envelope) return undefined;
  const columns = envelope.data.columns ?? [];
  const index = columnIndex(columns);
  const rows = envelopeRows(envelope);
  let selectedRowIndex = -1;
  let selectedDuration = -Infinity;
  for (const [rowIndex, row] of rows.entries()) {
    const durMs = numericValue(rowValue(row, index, 'dur_ms')) ?? -Infinity;
    if (durMs > selectedDuration) {
      selectedDuration = durMs;
      selectedRowIndex = rowIndex;
    }
  }
  if (selectedRowIndex < 0 || !Number.isFinite(selectedDuration)) return undefined;
  const row = rows[selectedRowIndex];
  if (!row) return undefined;
  const frameId = cellText(rowValue(row, index, 'frame_id'));
  const vsyncMissed = numericValue(rowValue(row, index, 'vsync_missed'));
  const reasonCode = cellText(rowValue(row, index, 'reason_code'));
  const primaryCause = cellText(rowValue(row, index, 'primary_cause'));
  const statement = localize(
    input.outputLanguage,
    `掉帧样本中耗时最长的是 frame_id=${frameId}，帧耗时 ${formatNumber(selectedDuration)}ms，跳帧 ${formatNumber(vsyncMissed)}，分类 ${reasonCode}，主要原因为 ${primaryCause}。`,
    `The longest janky sample is frame_id=${frameId}, duration ${formatNumber(selectedDuration)}ms, missed vsync ${formatNumber(vsyncMissed)}, reason ${reasonCode}, primary cause ${primaryCause}.`,
  );
  const references = referencesForColumns({
    envelope,
    row,
    rowIndex: selectedRowIndex,
    columns: ['frame_id', 'dur_ms', 'vsync_missed', 'reason_code', 'primary_cause', 'top_slice_name', 'top_slice_ms'],
  });
  if (references.length === 0) return undefined;
  return {
    id: 'quick-scrolling-root-cause-sample',
    label: localize(input.outputLanguage, '掉帧样本', 'janky sample'),
    statement,
    kind: 'categorical',
    evidenceText: `${sourceRef(envelope)}: frame_id=${frameId}, dur_ms=${selectedDuration}, reason_code=${reasonCode}, primary_cause=${primaryCause}`,
    references,
  };
}

export function buildQuickScrollingTriageDirectAnswer(input: {
  evidence?: QuickScrollingTriageEvidencePayload;
  outputLanguage?: OutputLanguage;
}): QuickScrollingTriageDirectAnswer | undefined {
  const evidence = input.evidence;
  if (!evidence?.envelopes.length) return undefined;
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const claims = [
    ...buildPerformanceClaims({ envelopes: evidence.envelopes, outputLanguage }),
    buildInputLatencyClaim({ envelopes: evidence.envelopes, outputLanguage }),
    buildRootCauseClaim({ envelopes: evidence.envelopes, outputLanguage }),
  ]
    .filter((claim): claim is DirectClaim => Boolean(claim))
    .slice(0, QUICK_TRIAGE_MAX_CLAIMS);
  if (claims.length === 0 || claims[0]?.id !== 'quick-scrolling-performance') return undefined;

  const boundary = localize(
    outputLanguage,
    'fast 仅复用 scrolling_analysis 概览、Input 和掉帧样本；逐帧调用栈、Binder/锁归因需完整模式深钻。',
    'fast reuses scrolling_analysis overview, input, and janky samples only; per-frame stacks and Binder/lock attribution need full-mode drilldown.',
  );
  return {
    conclusion: buildConclusionText({ claims, boundary, outputLanguage }),
    conclusionContract: buildConclusionContract({ claims, boundary, outputLanguage }),
    confidence: 0.95,
  };
}
