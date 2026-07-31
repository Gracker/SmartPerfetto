// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract, ConclusionContractClaimReference } from '../agent/core/conclusionContract';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import type { DataEnvelope } from '../types/dataContract';
import type { QuickStructuredDirectAnswer } from './quickDirectAnswerContract';
import {
  hasUsableTraceFactEvidence,
  type QuickTraceFactEvidenceKind,
  type QuickTraceFactEvidencePayload,
} from './quickTraceFactEvidence';
import {
  cellText,
  columnIndex,
  findFirstTableEnvelope,
  numericValue,
  rowValue,
} from './quickEvidenceTable';

export interface QuickTraceFactDirectAnswer extends QuickStructuredDirectAnswer {}

function cellList(value: unknown): string[] {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function formatProcessSamples(input: {
  names: string[];
  threadCounts: string[];
  outputLanguage: OutputLanguage;
}): string {
  return input.names.map((name, index) => {
    const threadCount = input.threadCounts[index];
    if (!threadCount) return name;
    return localize(
      input.outputLanguage,
      `${name}（${threadCount} 线程）`,
      `${name} (${threadCount} threads)`,
    );
  }).join(', ');
}

function formatTraceHealthIssueSamples(input: {
  names: string[];
  values: string[];
  severities: string[];
}): string {
  return input.names.map((name, index) => {
    const value = input.values[index];
    const severity = input.severities[index];
    if (value && severity) return `${name}=${value} (${severity})`;
    if (value) return `${name}=${value}`;
    return name;
  }).join(', ');
}

function formatNamedCountSamples(input: {
  names: string[];
  counts: string[];
}): string {
  return input.names.map((name, index) => {
    const count = input.counts[index];
    if (!count) return name;
    return `${name}=${count}`;
  }).join(', ');
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

function scopedRangeReferenceInfo(input: {
  envelope: DataEnvelope;
  row: unknown[];
  index: Map<string, number>;
}): {
  startNs: number;
  endNs: number;
  references: ConclusionContractClaimReference[];
  rows: string[];
  evidenceText: string;
} | undefined {
  const startNs = numericValue(rowValue(input.row, input.index, 'scope_start_ns'));
  const endNs = numericValue(rowValue(input.row, input.index, 'scope_end_ns'));
  if (startNs === undefined || endNs === undefined || endNs <= startNs) return undefined;
  return {
    startNs,
    endNs,
    references: [
      directClaimReference({ envelope: input.envelope, column: 'scope_start_ns', value: startNs }),
      directClaimReference({ envelope: input.envelope, column: 'scope_end_ns', value: endNs }),
    ],
    rows: [
      `column=\`scope_start_ns\`; value=\`${startNs}\``,
      `column=\`scope_end_ns\`; value=\`${endNs}\``,
    ],
    evidenceText: `scope_start_ns=${startNs}, scope_end_ns=${endNs}`,
  };
}

function buildDirectConclusionContract(input: {
  statement: string;
  evidenceText: string;
  references: ConclusionContractClaimReference[];
  kind: QuickTraceFactEvidenceKind;
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
      conclusionId: 'qtf-1',
      text: input.evidenceText,
    }],
    claims: [{
      id: `quick-trace-fact-${input.kind}`,
      conclusionId: 'qtf-1',
      text: input.statement,
      kind: 'numeric',
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

export function buildQuickTraceFactDirectAnswer(input: {
  evidence?: QuickTraceFactEvidencePayload;
  outputLanguage?: OutputLanguage;
}): QuickTraceFactDirectAnswer | undefined {
  const evidence = input.evidence;
  if (!evidence?.promptContext || !hasUsableTraceFactEvidence(evidence)) return undefined;
  const envelope = findFirstTableEnvelope(evidence.envelopes);
  if (!envelope?.data.columns || !envelope.data.rows?.length) return undefined;

  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const columns = envelope.data.columns;
  const index = columnIndex(columns);
  const row = envelope.data.rows[0];
  const evidenceRefId = envelope.meta.evidenceRefId;
  if (!evidenceRefId) return undefined;
  const sourceRef = envelope.display?.title ?? envelope.meta.source ?? 'runtime trace fact pre-evidence';

  if (evidence.evidenceKind === 'longest_process_slices') {
    const items = envelope.data.rows.slice(0, 20).map((candidate, rowIndex) => {
      const ts = cellText(rowValue(candidate, index, 'ts'));
      const durationMs = numericValue(rowValue(candidate, index, 'duration_ms'));
      const sliceName = cellText(rowValue(candidate, index, 'slice_name'));
      const processName = cellText(rowValue(candidate, index, 'process_name'));
      const threadName = cellText(rowValue(candidate, index, 'thread_name'));
      const trackScope = cellText(rowValue(candidate, index, 'track_scope'));
      if (durationMs === undefined || durationMs <= 0) return undefined;
      return {
        rowIndex,
        ts,
        durationMs,
        sliceName,
        processName,
        threadName,
        trackScope,
      };
    });
    if (items.some(item => !item)) return undefined;
    const verifiedItems = items.filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (verifiedItems.length === 0) return undefined;

    const rankedRows = verifiedItems.map((item, index) => localize(
      outputLanguage,
      `${index + 1}. ${item.sliceName} — ${item.durationMs} ms；进程 ${item.processName}；线程 ${item.threadName}`,
      `${index + 1}. ${item.sliceName} — ${item.durationMs} ms; process ${item.processName}; thread ${item.threadName}`,
    ));
    const statement = localize(
      outputLanguage,
      `当前范围内时长最长的 ${verifiedItems.length} 个 process slice 为：\n${rankedRows.join('\n')}`,
      `The ${verifiedItems.length} longest process slices in the current range are:\n${rankedRows.join('\n')}`,
    );
    const references = verifiedItems.flatMap(item => [
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'ts',
        value: item.ts,
      }),
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'duration_ms',
        value: item.durationMs,
      }),
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'slice_name',
        value: item.sliceName,
      }),
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'process_name',
        value: item.processName,
      }),
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'thread_name',
        value: item.threadName,
      }),
      directClaimReference({
        envelope,
        rowIndex: item.rowIndex,
        column: 'track_scope',
        value: item.trackScope,
      }),
    ]);
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: verifiedItems.map(item =>
          `rowIndex=\`${item.rowIndex}\`; ts=\`${item.ts}\`; duration_ms=\`${item.durationMs}\`; slice_name=\`${item.sliceName}\`; process_name=\`${item.processName}\`; thread_name=\`${item.threadName}\`; track_scope=\`${item.trackScope}\``
        ),
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: ${verifiedItems.map(item =>
          `rowIndex=${item.rowIndex}, ts=${item.ts}, duration_ms=${item.durationMs}, slice_name=${item.sliceName}, process_name=${item.processName}, thread_name=${item.threadName}, track_scope=${item.trackScope}`
        ).join('; ')}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'selection_duration') {
    const scope = cellText(rowValue(row, index, 'scope'));
    const scopeStartNs = numericValue(rowValue(row, index, 'scope_start_ns'));
    const scopeEndNs = numericValue(rowValue(row, index, 'scope_end_ns'));
    const durationNs = numericValue(rowValue(row, index, 'duration_ns'));
    const durationS = numericValue(rowValue(row, index, 'duration_s'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    if (
      scopeStartNs === undefined ||
      scopeEndNs === undefined ||
      scopeEndNs <= scopeStartNs ||
      durationNs === undefined ||
      durationNs <= 0 ||
      durationS === undefined ||
      durationS <= 0
    ) {
      return undefined;
    }
    const statement = localize(
      outputLanguage,
      `当前选区的起止时间为 ${scopeStartNs}-${scopeEndNs} ns，时长约 ${durationS} 秒。`,
      `The current selection spans ${scopeStartNs}-${scopeEndNs} ns, with a duration of about ${durationS} seconds.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'scope_start_ns', value: scopeStartNs }),
      directClaimReference({ envelope, column: 'scope_end_ns', value: scopeEndNs }),
      directClaimReference({ envelope, column: 'duration_ns', value: durationNs }),
      directClaimReference({ envelope, column: 'duration_s', value: durationS }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`scope\`; value=\`${scope}\``,
          `column=\`scope_start_ns\`; value=\`${scopeStartNs}\``,
          `column=\`scope_end_ns\`; value=\`${scopeEndNs}\``,
          `column=\`duration_ns\`; value=\`${durationNs}\``,
          `column=\`duration_s\`; value=\`${durationS}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: scope=${scope}, scope_start_ns=${scopeStartNs}, scope_end_ns=${scopeEndNs}, duration_ns=${durationNs}, duration_s=${durationS}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'cpu_core_count') {
    const observedCpuCount = numericValue(rowValue(row, index, 'observed_cpu_count'));
    const observedCpus = rowValue(row, index, 'observed_cpus');
    if (!observedCpuCount || observedCpuCount <= 0 || observedCpus === undefined) return undefined;
    const cpuText = cellText(observedCpus);
    const statement = localize(
      outputLanguage,
      `当前 trace 观测到 ${observedCpuCount} 个 CPU 核心（编号 ${cpuText}）。`,
      `The current trace observes ${observedCpuCount} CPU cores (${cpuText}).`,
    );
    const references = [
      directClaimReference({ envelope, column: 'observed_cpu_count', value: observedCpuCount }),
      directClaimReference({ envelope, column: 'observed_cpus', value: cpuText }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`observed_cpu_count\`; value=\`${observedCpuCount}\``,
          `column=\`observed_cpus\`; value=\`${cpuText}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: observed_cpu_count=${observedCpuCount}, observed_cpus=${cpuText}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'cpu_frequency_presence') {
    const cpuCount = numericValue(rowValue(row, index, 'cpufreq_cpu_count'));
    const sampleCount = numericValue(rowValue(row, index, 'cpufreq_sample_count'));
    if (cpuCount === undefined || cpuCount < 0 || sampleCount === undefined || sampleCount < 0) return undefined;
    const cpus = cellText(rowValue(row, index, 'cpufreq_cpus'));
    const minFreqKhz = numericValue(rowValue(row, index, 'min_freq_khz')) ?? 0;
    const maxFreqKhz = numericValue(rowValue(row, index, 'max_freq_khz')) ?? 0;
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasCpufreq = sampleCount > 0 && cpuCount > 0;
    const statement = localize(
      outputLanguage,
      hasCpufreq
        ? `当前 trace 采集到了 CPU 频率计数器数据：覆盖 ${cpuCount} 个 CPU（${cpus}），共有 ${sampleCount} 个 cpufreq 样本，频率范围 ${minFreqKhz}-${maxFreqKhz} kHz。`
        : '当前 trace 未采集到可解析的 CPU 频率计数器数据（cpufreq 样本数为 0）；这只说明当前 trace 缺少 cpu_counter_track/counter 中的 cpufreq 数据，不等同于证明设备没有频率变化或 DVFS 行为。',
      hasCpufreq
        ? `The current trace contains CPU frequency counter data: ${cpuCount} CPUs (${cpus}), ${sampleCount} cpufreq samples, frequency range ${minFreqKhz}-${maxFreqKhz} kHz.`
        : 'The current trace contains no parsable CPU frequency counter data (0 cpufreq samples); this only means cpufreq data is absent from cpu_counter_track/counter in this trace, not proof that the device had no frequency changes or DVFS behavior.',
    );
    const references = [
      directClaimReference({ envelope, column: 'cpufreq_cpu_count', value: cpuCount }),
      directClaimReference({ envelope, column: 'cpufreq_sample_count', value: sampleCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasCpufreq
        ? [
          directClaimReference({ envelope, column: 'cpufreq_cpus', value: cpus }),
          directClaimReference({ envelope, column: 'min_freq_khz', value: minFreqKhz }),
          directClaimReference({ envelope, column: 'max_freq_khz', value: maxFreqKhz }),
        ]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`cpufreq_cpu_count\`; value=\`${cpuCount}\``,
          `column=\`cpufreq_sample_count\`; value=\`${sampleCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasCpufreq
            ? [
              `column=\`cpufreq_cpus\`; value=\`${cpus}\``,
              `column=\`min_freq_khz\`; value=\`${minFreqKhz}\``,
              `column=\`max_freq_khz\`; value=\`${maxFreqKhz}\``,
            ]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasCpufreq
          ? `${sourceRef}: cpufreq_cpu_count=${cpuCount}, cpufreq_sample_count=${sampleCount}, cpufreq_cpus=${cpus}, min_freq_khz=${minFreqKhz}, max_freq_khz=${maxFreqKhz}, source_table=${sourceTable}`
          : `${sourceRef}: cpufreq_cpu_count=${cpuCount}, cpufreq_sample_count=${sampleCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'power_counter_presence') {
    const trackCount = numericValue(rowValue(row, index, 'power_counter_track_count'));
    const sampleCount = numericValue(rowValue(row, index, 'power_counter_sample_count'));
    if (trackCount === undefined || trackCount < 0 || sampleCount === undefined || sampleCount < 0) return undefined;
    const counterNames = cellList(rowValue(row, index, 'power_counter_names'));
    const counterSampleCounts = cellList(rowValue(row, index, 'power_counter_sample_counts'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasPowerCounters = sampleCount > 0 && trackCount > 0;
    const counterSamples = counterNames.length > 0
      ? formatNamedCountSamples({ names: counterNames, counts: counterSampleCounts })
      : '';
    const sampleZh = counterSamples ? `；主要计数器：${counterSamples}` : '';
    const sampleEn = counterSamples ? `; top counters: ${counterSamples}` : '';
    const statement = localize(
      outputLanguage,
      hasPowerCounters
        ? `当前 trace 采集到了功耗/电量相关计数器数据：覆盖 ${trackCount} 个 counter track，共 ${sampleCount} 个样本${sampleZh}。`
        : '当前 trace 未采集到可解析的功耗/电量相关 counter 数据；这只说明 counter_track/counter 中缺少 power/battery/energy/charge 相关计数器，不等同于证明设备没有耗电或功耗问题。',
      hasPowerCounters
        ? `The current trace contains power/battery-related counter data: ${trackCount} counter tracks and ${sampleCount} samples${sampleEn}.`
        : 'The current trace contains no parsable power/battery-related counter data; this only means power/battery/energy/charge counters are absent from counter_track/counter in this trace, not proof that the device had no power drain or power issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'power_counter_track_count', value: trackCount }),
      directClaimReference({ envelope, column: 'power_counter_sample_count', value: sampleCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasPowerCounters && counterNames.length > 0
        ? [directClaimReference({ envelope, column: 'power_counter_names', value: counterNames.join(',') })]
        : []),
      ...(hasPowerCounters && counterSampleCounts.length > 0
        ? [directClaimReference({ envelope, column: 'power_counter_sample_counts', value: counterSampleCounts.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`power_counter_track_count\`; value=\`${trackCount}\``,
          `column=\`power_counter_sample_count\`; value=\`${sampleCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasPowerCounters && counterNames.length > 0
            ? [`column=\`power_counter_names\`; value=\`${counterNames.join(',')}\``]
            : []),
          ...(hasPowerCounters && counterSampleCounts.length > 0
            ? [`column=\`power_counter_sample_counts\`; value=\`${counterSampleCounts.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasPowerCounters
          ? `${sourceRef}: power_counter_track_count=${trackCount}, power_counter_sample_count=${sampleCount}, power_counter_names=${counterNames.join(',')}, power_counter_sample_counts=${counterSampleCounts.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: power_counter_track_count=${trackCount}, power_counter_sample_count=${sampleCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'memory_counter_presence') {
    const trackCount = numericValue(rowValue(row, index, 'memory_counter_track_count'));
    const sampleCount = numericValue(rowValue(row, index, 'memory_counter_sample_count'));
    if (trackCount === undefined || trackCount < 0 || sampleCount === undefined || sampleCount < 0) return undefined;
    const counterNames = cellList(rowValue(row, index, 'memory_counter_names'));
    const counterSampleCounts = cellList(rowValue(row, index, 'memory_counter_sample_counts'));
    const counterMaxValues = cellList(rowValue(row, index, 'memory_counter_max_values'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasMemoryCounters = sampleCount > 0 && trackCount > 0;
    const counterSamples = counterNames.length > 0
      ? formatNamedCountSamples({ names: counterNames, counts: counterSampleCounts })
      : '';
    const sampleZh = counterSamples ? `；主要计数器：${counterSamples}` : '';
    const sampleEn = counterSamples ? `; top counters: ${counterSamples}` : '';
    const statement = localize(
      outputLanguage,
      hasMemoryCounters
        ? `当前 trace 采集到了内存相关计数器数据：覆盖 ${trackCount} 个 process counter track，共 ${sampleCount} 个样本${sampleZh}。`
        : '当前 trace 未采集到可解析的内存相关 process counter 数据；这只说明 process_counter_track/counter 中缺少 memory/rss/swap/oom 相关计数器，不等同于证明应用没有内存问题、内存压力或 OOM 风险。',
      hasMemoryCounters
        ? `The current trace contains memory-related counter data: ${trackCount} process counter tracks and ${sampleCount} samples${sampleEn}.`
        : 'The current trace contains no parsable memory-related process counter data; this only means memory/rss/swap/oom counters are absent from process_counter_track/counter in this trace, not proof that the app had no memory problem, memory pressure, or OOM risk.',
    );
    const references = [
      directClaimReference({ envelope, column: 'memory_counter_track_count', value: trackCount }),
      directClaimReference({ envelope, column: 'memory_counter_sample_count', value: sampleCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasMemoryCounters && counterNames.length > 0
        ? [directClaimReference({ envelope, column: 'memory_counter_names', value: counterNames.join(',') })]
        : []),
      ...(hasMemoryCounters && counterSampleCounts.length > 0
        ? [directClaimReference({ envelope, column: 'memory_counter_sample_counts', value: counterSampleCounts.join(',') })]
        : []),
      ...(hasMemoryCounters && counterMaxValues.length > 0
        ? [directClaimReference({ envelope, column: 'memory_counter_max_values', value: counterMaxValues.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`memory_counter_track_count\`; value=\`${trackCount}\``,
          `column=\`memory_counter_sample_count\`; value=\`${sampleCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasMemoryCounters && counterNames.length > 0
            ? [`column=\`memory_counter_names\`; value=\`${counterNames.join(',')}\``]
            : []),
          ...(hasMemoryCounters && counterSampleCounts.length > 0
            ? [`column=\`memory_counter_sample_counts\`; value=\`${counterSampleCounts.join(',')}\``]
            : []),
          ...(hasMemoryCounters && counterMaxValues.length > 0
            ? [`column=\`memory_counter_max_values\`; value=\`${counterMaxValues.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasMemoryCounters
          ? `${sourceRef}: memory_counter_track_count=${trackCount}, memory_counter_sample_count=${sampleCount}, memory_counter_names=${counterNames.join(',')}, memory_counter_sample_counts=${counterSampleCounts.join(',')}, memory_counter_max_values=${counterMaxValues.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: memory_counter_track_count=${trackCount}, memory_counter_sample_count=${sampleCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'scheduler_data_presence') {
    const schedSliceCount = numericValue(rowValue(row, index, 'sched_slice_count'));
    const threadStateCount = numericValue(rowValue(row, index, 'thread_state_count'));
    if (
      schedSliceCount === undefined
      || schedSliceCount < 0
      || threadStateCount === undefined
      || threadStateCount < 0
    ) {
      return undefined;
    }
    const runningStateCount = numericValue(rowValue(row, index, 'running_state_count')) ?? 0;
    const runnableStateCount = numericValue(rowValue(row, index, 'runnable_state_count')) ?? 0;
    const preemptedRunnableStateCount = numericValue(rowValue(row, index, 'preempted_runnable_state_count')) ?? 0;
    const sleepingStateCount = numericValue(rowValue(row, index, 'sleeping_state_count')) ?? 0;
    const uninterruptibleSleepStateCount = numericValue(rowValue(row, index, 'uninterruptible_sleep_state_count')) ?? 0;
    const idleStateCount = numericValue(rowValue(row, index, 'idle_state_count')) ?? 0;
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasSchedulerData = schedSliceCount > 0 || threadStateCount > 0;
    const statement = localize(
      outputLanguage,
      hasSchedulerData
        ? `当前 trace 采集到了调度/线程状态数据：sched_slice ${schedSliceCount} 行，thread_state ${threadStateCount} 行；其中 Running 状态 ${runningStateCount} 行、Runnable(R/R+) 状态 ${runnableStateCount} 行（R+ 抢占等待 ${preemptedRunnableStateCount} 行）、Sleeping(S) 状态 ${sleepingStateCount} 行、Uninterruptible(D/DK) 状态 ${uninterruptibleSleepStateCount} 行、Idle(I) 状态 ${idleStateCount} 行。`
        : '当前 trace 未采集到可解析的调度/线程状态数据；这只说明 sched_slice/thread_state 表中没有记录，不等同于证明系统没有调度等待、抢占或线程状态问题。',
      hasSchedulerData
        ? `The current trace contains scheduler/thread-state data: ${schedSliceCount} sched_slice rows and ${threadStateCount} thread_state rows, including ${runningStateCount} Running rows, ${runnableStateCount} Runnable (R/R+) rows (${preemptedRunnableStateCount} R+ preempted-runnable rows), ${sleepingStateCount} Sleeping (S) rows, ${uninterruptibleSleepStateCount} Uninterruptible (D/DK) rows, and ${idleStateCount} Idle (I) rows.`
        : 'The current trace contains no parsable scheduler/thread-state data; this only means sched_slice/thread_state rows are absent, not proof that the system had no scheduling wait, preemption, or thread-state issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'sched_slice_count', value: schedSliceCount }),
      directClaimReference({ envelope, column: 'thread_state_count', value: threadStateCount }),
      directClaimReference({ envelope, column: 'running_state_count', value: runningStateCount }),
      directClaimReference({ envelope, column: 'runnable_state_count', value: runnableStateCount }),
      directClaimReference({ envelope, column: 'preempted_runnable_state_count', value: preemptedRunnableStateCount }),
      directClaimReference({ envelope, column: 'sleeping_state_count', value: sleepingStateCount }),
      directClaimReference({ envelope, column: 'uninterruptible_sleep_state_count', value: uninterruptibleSleepStateCount }),
      directClaimReference({ envelope, column: 'idle_state_count', value: idleStateCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`sched_slice_count\`; value=\`${schedSliceCount}\``,
          `column=\`thread_state_count\`; value=\`${threadStateCount}\``,
          `column=\`running_state_count\`; value=\`${runningStateCount}\``,
          `column=\`runnable_state_count\`; value=\`${runnableStateCount}\``,
          `column=\`preempted_runnable_state_count\`; value=\`${preemptedRunnableStateCount}\``,
          `column=\`sleeping_state_count\`; value=\`${sleepingStateCount}\``,
          `column=\`uninterruptible_sleep_state_count\`; value=\`${uninterruptibleSleepStateCount}\``,
          `column=\`idle_state_count\`; value=\`${idleStateCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: sched_slice_count=${schedSliceCount}, thread_state_count=${threadStateCount}, running_state_count=${runningStateCount}, runnable_state_count=${runnableStateCount}, preempted_runnable_state_count=${preemptedRunnableStateCount}, sleeping_state_count=${sleepingStateCount}, uninterruptible_sleep_state_count=${uninterruptibleSleepStateCount}, idle_state_count=${idleStateCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'gpu_data_presence') {
    const gpuSliceCount = numericValue(rowValue(row, index, 'gpu_slice_count'));
    const gpuCounterTrackCount = numericValue(rowValue(row, index, 'gpu_counter_track_count'));
    const gpuCounterSampleCount = numericValue(rowValue(row, index, 'gpu_counter_sample_count'));
    if (
      gpuSliceCount === undefined
      || gpuSliceCount < 0
      || gpuCounterTrackCount === undefined
      || gpuCounterTrackCount < 0
      || gpuCounterSampleCount === undefined
      || gpuCounterSampleCount < 0
    ) {
      return undefined;
    }
    const gpuCounterNames = cellList(rowValue(row, index, 'gpu_counter_names'));
    const gpuSliceNames = cellList(rowValue(row, index, 'gpu_slice_names'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasGpuData = gpuSliceCount > 0 || gpuCounterTrackCount > 0 || gpuCounterSampleCount > 0;
    const counterSampleZh = gpuCounterNames.length > 0 ? `；GPU counter：${gpuCounterNames.join(', ')}` : '';
    const sliceSampleZh = gpuSliceNames.length > 0 ? `；GPU slice：${gpuSliceNames.join(', ')}` : '';
    const counterSampleEn = gpuCounterNames.length > 0 ? `; GPU counters: ${gpuCounterNames.join(', ')}` : '';
    const sliceSampleEn = gpuSliceNames.length > 0 ? `; GPU slices: ${gpuSliceNames.join(', ')}` : '';
    const statement = localize(
      outputLanguage,
      hasGpuData
        ? `当前 trace 采集到了 GPU 相关数据：gpu_slice ${gpuSliceCount} 行，GPU counter track ${gpuCounterTrackCount} 个，GPU counter 样本 ${gpuCounterSampleCount} 个${counterSampleZh}${sliceSampleZh}。`
        : '当前 trace 未采集到可解析的 GPU slice/counter 数据；这只说明 gpu_slice/gpu_counter_track/counter 中没有 GPU 记录，不等同于证明设备没有 GPU 渲染、负载或图形性能问题。',
      hasGpuData
        ? `The current trace contains GPU-related data: ${gpuSliceCount} gpu_slice rows, ${gpuCounterTrackCount} GPU counter tracks, and ${gpuCounterSampleCount} GPU counter samples${counterSampleEn}${sliceSampleEn}.`
        : 'The current trace contains no parsable GPU slice/counter data; this only means gpu_slice/gpu_counter_track/counter rows are absent, not proof that the device had no GPU rendering, load, or graphics performance issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'gpu_slice_count', value: gpuSliceCount }),
      directClaimReference({ envelope, column: 'gpu_counter_track_count', value: gpuCounterTrackCount }),
      directClaimReference({ envelope, column: 'gpu_counter_sample_count', value: gpuCounterSampleCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasGpuData && gpuCounterNames.length > 0
        ? [directClaimReference({ envelope, column: 'gpu_counter_names', value: gpuCounterNames.join(',') })]
        : []),
      ...(hasGpuData && gpuSliceNames.length > 0
        ? [directClaimReference({ envelope, column: 'gpu_slice_names', value: gpuSliceNames.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`gpu_slice_count\`; value=\`${gpuSliceCount}\``,
          `column=\`gpu_counter_track_count\`; value=\`${gpuCounterTrackCount}\``,
          `column=\`gpu_counter_sample_count\`; value=\`${gpuCounterSampleCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasGpuData && gpuCounterNames.length > 0
            ? [`column=\`gpu_counter_names\`; value=\`${gpuCounterNames.join(',')}\``]
            : []),
          ...(hasGpuData && gpuSliceNames.length > 0
            ? [`column=\`gpu_slice_names\`; value=\`${gpuSliceNames.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasGpuData
          ? `${sourceRef}: gpu_slice_count=${gpuSliceCount}, gpu_counter_track_count=${gpuCounterTrackCount}, gpu_counter_sample_count=${gpuCounterSampleCount}, gpu_counter_names=${gpuCounterNames.join(',')}, gpu_slice_names=${gpuSliceNames.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: gpu_slice_count=${gpuSliceCount}, gpu_counter_track_count=${gpuCounterTrackCount}, gpu_counter_sample_count=${gpuCounterSampleCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'slice_data_presence') {
    const sliceCount = numericValue(rowValue(row, index, 'slice_count'));
    const trackCount = numericValue(rowValue(row, index, 'track_count'));
    const processTrackCount = numericValue(rowValue(row, index, 'process_track_count')) ?? 0;
    const threadTrackCount = numericValue(rowValue(row, index, 'thread_track_count')) ?? 0;
    if (
      sliceCount === undefined
      || sliceCount < 0
      || trackCount === undefined
      || trackCount < 0
      || processTrackCount < 0
      || threadTrackCount < 0
    ) {
      return undefined;
    }
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasSliceData = sliceCount > 0 || trackCount > 0;
    const statement = localize(
      outputLanguage,
      hasSliceData
        ? `当前 trace 采集到了通用 slice/track 时间线数据：slice ${sliceCount} 行，track ${trackCount} 行；其中 process_track ${processTrackCount} 行、thread_track ${threadTrackCount} 行。`
        : '当前 trace 未采集到可解析的通用 slice/track 时间线数据；这只说明 slice/track/process_track/thread_track 表中没有记录，不等同于证明 trace 没有其他事件或性能问题。',
      hasSliceData
        ? `The current trace contains generic slice/track timeline data: ${sliceCount} slice rows and ${trackCount} track rows, including ${processTrackCount} process_track rows and ${threadTrackCount} thread_track rows.`
        : 'The current trace contains no parsable generic slice/track timeline data; this only means slice/track/process_track/thread_track rows are absent, not proof that the trace has no other events or performance issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'slice_count', value: sliceCount }),
      directClaimReference({ envelope, column: 'track_count', value: trackCount }),
      directClaimReference({ envelope, column: 'process_track_count', value: processTrackCount }),
      directClaimReference({ envelope, column: 'thread_track_count', value: threadTrackCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`slice_count\`; value=\`${sliceCount}\``,
          `column=\`track_count\`; value=\`${trackCount}\``,
          `column=\`process_track_count\`; value=\`${processTrackCount}\``,
          `column=\`thread_track_count\`; value=\`${threadTrackCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: slice_count=${sliceCount}, track_count=${trackCount}, process_track_count=${processTrackCount}, thread_track_count=${threadTrackCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'network_packet_presence') {
    const eventCount = numericValue(rowValue(row, index, 'network_packet_event_count'));
    const packetCount = numericValue(rowValue(row, index, 'network_packet_count'));
    const bytes = numericValue(rowValue(row, index, 'network_packet_bytes'));
    if (
      eventCount === undefined
      || eventCount < 0
      || packetCount === undefined
      || packetCount < 0
      || bytes === undefined
      || bytes < 0
    ) {
      return undefined;
    }
    const ifaceCount = numericValue(rowValue(row, index, 'network_iface_count')) ?? 0;
    const transportCount = numericValue(rowValue(row, index, 'network_transport_count')) ?? 0;
    const ifaces = cellList(rowValue(row, index, 'network_ifaces'));
    const ifacePacketCounts = cellList(rowValue(row, index, 'network_iface_packet_counts'));
    const transports = cellList(rowValue(row, index, 'network_transports'));
    const transportPacketCounts = cellList(rowValue(row, index, 'network_transport_packet_counts'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasNetworkPackets = eventCount > 0 || packetCount > 0 || bytes > 0;
    const ifaceSamples = ifaces.length > 0
      ? formatNamedCountSamples({ names: ifaces, counts: ifacePacketCounts })
      : '';
    const transportSamples = transports.length > 0
      ? formatNamedCountSamples({ names: transports, counts: transportPacketCounts })
      : '';
    const ifaceZh = ifaceSamples ? `；主要接口：${ifaceSamples}` : '';
    const ifaceEn = ifaceSamples ? `; top interfaces: ${ifaceSamples}` : '';
    const transportZh = transportSamples ? `；transport：${transportSamples}` : '';
    const transportEn = transportSamples ? `; transports: ${transportSamples}` : '';
    const statement = localize(
      outputLanguage,
      hasNetworkPackets
        ? `当前 trace 采集到了 packet-level 网络数据：android_network_packets ${eventCount} 行，packet_count 合计 ${packetCount}，packet_length 合计 ${bytes} bytes，覆盖 ${ifaceCount} 个接口、${transportCount} 类 transport${ifaceZh}${transportZh}。`
        : '当前 trace 未采集到可解析的 packet-level 网络数据（android_network_packets 为空）；这只说明本次 trace 未启用或未记录 android.network_packets 数据源，不等同于证明设备或应用没有网络活动、请求慢或网络问题。',
      hasNetworkPackets
        ? `The current trace contains packet-level network data: ${eventCount} android_network_packets rows, total packet_count ${packetCount}, total packet_length ${bytes} bytes, across ${ifaceCount} interfaces and ${transportCount} transport types${ifaceEn}${transportEn}.`
        : 'The current trace contains no parsable packet-level network data (android_network_packets is empty); this only means the trace did not enable or record the android.network_packets data source, not proof that the device or app had no network activity, slow requests, or network issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'network_packet_event_count', value: eventCount }),
      directClaimReference({ envelope, column: 'network_packet_count', value: packetCount }),
      directClaimReference({ envelope, column: 'network_packet_bytes', value: bytes }),
      directClaimReference({ envelope, column: 'network_iface_count', value: ifaceCount }),
      directClaimReference({ envelope, column: 'network_transport_count', value: transportCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasNetworkPackets && ifaces.length > 0
        ? [directClaimReference({ envelope, column: 'network_ifaces', value: ifaces.join(',') })]
        : []),
      ...(hasNetworkPackets && ifacePacketCounts.length > 0
        ? [directClaimReference({ envelope, column: 'network_iface_packet_counts', value: ifacePacketCounts.join(',') })]
        : []),
      ...(hasNetworkPackets && transports.length > 0
        ? [directClaimReference({ envelope, column: 'network_transports', value: transports.join(',') })]
        : []),
      ...(hasNetworkPackets && transportPacketCounts.length > 0
        ? [directClaimReference({ envelope, column: 'network_transport_packet_counts', value: transportPacketCounts.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`network_packet_event_count\`; value=\`${eventCount}\``,
          `column=\`network_packet_count\`; value=\`${packetCount}\``,
          `column=\`network_packet_bytes\`; value=\`${bytes}\``,
          `column=\`network_iface_count\`; value=\`${ifaceCount}\``,
          `column=\`network_transport_count\`; value=\`${transportCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasNetworkPackets && ifaces.length > 0
            ? [`column=\`network_ifaces\`; value=\`${ifaces.join(',')}\``]
            : []),
          ...(hasNetworkPackets && ifacePacketCounts.length > 0
            ? [`column=\`network_iface_packet_counts\`; value=\`${ifacePacketCounts.join(',')}\``]
            : []),
          ...(hasNetworkPackets && transports.length > 0
            ? [`column=\`network_transports\`; value=\`${transports.join(',')}\``]
            : []),
          ...(hasNetworkPackets && transportPacketCounts.length > 0
            ? [`column=\`network_transport_packet_counts\`; value=\`${transportPacketCounts.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasNetworkPackets
          ? `${sourceRef}: network_packet_event_count=${eventCount}, network_packet_count=${packetCount}, network_packet_bytes=${bytes}, network_iface_count=${ifaceCount}, network_transport_count=${transportCount}, network_ifaces=${ifaces.join(',')}, network_iface_packet_counts=${ifacePacketCounts.join(',')}, network_transports=${transports.join(',')}, network_transport_packet_counts=${transportPacketCounts.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: network_packet_event_count=${eventCount}, network_packet_count=${packetCount}, network_packet_bytes=${bytes}, network_iface_count=${ifaceCount}, network_transport_count=${transportCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'logcat_presence') {
    const eventCount = numericValue(rowValue(row, index, 'logcat_event_count'));
    if (eventCount === undefined || eventCount < 0) return undefined;
    const warnCount = numericValue(rowValue(row, index, 'warn_log_count')) ?? 0;
    const errorCount = numericValue(rowValue(row, index, 'error_log_count')) ?? 0;
    const fatalCount = numericValue(rowValue(row, index, 'fatal_log_count')) ?? 0;
    const distinctTagCount = numericValue(rowValue(row, index, 'distinct_tag_count')) ?? 0;
    const sampleTags = cellList(rowValue(row, index, 'sample_tags'));
    const sampleTagCounts = cellList(rowValue(row, index, 'sample_tag_counts'));
    const rawFirstLogTs = rowValue(row, index, 'first_log_ts');
    const rawLastLogTs = rowValue(row, index, 'last_log_ts');
    const firstLogTs = rawFirstLogTs === undefined
      || rawFirstLogTs === null
      || String(rawFirstLogTs).trim() === ''
      ? undefined
      : numericValue(rawFirstLogTs);
    const lastLogTs = rawLastLogTs === undefined
      || rawLastLogTs === null
      || String(rawLastLogTs).trim() === ''
      ? undefined
      : numericValue(rawLastLogTs);
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasLogcatData = eventCount > 0;
    const tagSamples = sampleTags.length > 0
      ? formatNamedCountSamples({ names: sampleTags, counts: sampleTagCounts })
      : '';
    const tagZh = tagSamples ? `；主要 tag：${tagSamples}` : '';
    const tagEn = tagSamples ? `; top tags: ${tagSamples}` : '';
    const timeZh = firstLogTs !== undefined && lastLogTs !== undefined
      ? `，日志时间范围 ${firstLogTs}-${lastLogTs} ns`
      : '';
    const timeEn = firstLogTs !== undefined && lastLogTs !== undefined
      ? `, log timestamp range ${firstLogTs}-${lastLogTs} ns`
      : '';
    const statement = localize(
      outputLanguage,
      hasLogcatData
        ? `当前 trace 采集到了 Logcat/android_logs 数据：共 ${eventCount} 条日志，其中 warn 及以上 ${warnCount} 条、error 及以上 ${errorCount} 条、fatal ${fatalCount} 条，覆盖 ${distinctTagCount} 个 tag${tagZh}${timeZh}。`
        : '当前 trace 未采集到可解析的 Logcat/android_logs 数据（android_logs 为空）；这只说明本次 trace 没有可查询的 android_logs 行，不等同于证明运行期间没有日志、警告或错误。',
      hasLogcatData
        ? `The current trace contains Logcat/android_logs data: ${eventCount} log rows, ${warnCount} warn-or-higher rows, ${errorCount} error-or-higher rows, ${fatalCount} fatal rows, across ${distinctTagCount} tags${tagEn}${timeEn}.`
        : 'The current trace contains no parsable Logcat/android_logs data (android_logs is empty); this only means there are no queryable android_logs rows in this trace, not proof that the run had no logs, warnings, or errors.',
    );
    const references = [
      directClaimReference({ envelope, column: 'logcat_event_count', value: eventCount }),
      directClaimReference({ envelope, column: 'warn_log_count', value: warnCount }),
      directClaimReference({ envelope, column: 'error_log_count', value: errorCount }),
      directClaimReference({ envelope, column: 'fatal_log_count', value: fatalCount }),
      directClaimReference({ envelope, column: 'distinct_tag_count', value: distinctTagCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasLogcatData && sampleTags.length > 0
        ? [directClaimReference({ envelope, column: 'sample_tags', value: sampleTags.join(',') })]
        : []),
      ...(hasLogcatData && sampleTagCounts.length > 0
        ? [directClaimReference({ envelope, column: 'sample_tag_counts', value: sampleTagCounts.join(',') })]
        : []),
      ...(firstLogTs !== undefined
        ? [directClaimReference({ envelope, column: 'first_log_ts', value: firstLogTs })]
        : []),
      ...(lastLogTs !== undefined
        ? [directClaimReference({ envelope, column: 'last_log_ts', value: lastLogTs })]
        : []),
    ];
    const rows = [
      `column=\`logcat_event_count\`; value=\`${eventCount}\``,
      `column=\`warn_log_count\`; value=\`${warnCount}\``,
      `column=\`error_log_count\`; value=\`${errorCount}\``,
      `column=\`fatal_log_count\`; value=\`${fatalCount}\``,
      `column=\`distinct_tag_count\`; value=\`${distinctTagCount}\``,
      `column=\`source_table\`; value=\`${sourceTable}\``,
      ...(hasLogcatData && sampleTags.length > 0
        ? [`column=\`sample_tags\`; value=\`${sampleTags.join(',')}\``]
        : []),
      ...(hasLogcatData && sampleTagCounts.length > 0
        ? [`column=\`sample_tag_counts\`; value=\`${sampleTagCounts.join(',')}\``]
        : []),
      ...(firstLogTs !== undefined
        ? [`column=\`first_log_ts\`; value=\`${firstLogTs}\``]
        : []),
      ...(lastLogTs !== undefined
        ? [`column=\`last_log_ts\`; value=\`${lastLogTs}\``]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows,
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasLogcatData
          ? `${sourceRef}: logcat_event_count=${eventCount}, warn_log_count=${warnCount}, error_log_count=${errorCount}, fatal_log_count=${fatalCount}, distinct_tag_count=${distinctTagCount}, sample_tags=${sampleTags.join(',')}, sample_tag_counts=${sampleTagCounts.join(',')}, first_log_ts=${firstLogTs ?? ''}, last_log_ts=${lastLogTs ?? ''}, source_table=${sourceTable}`
          : `${sourceRef}: logcat_event_count=${eventCount}, warn_log_count=${warnCount}, error_log_count=${errorCount}, fatal_log_count=${fatalCount}, distinct_tag_count=${distinctTagCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'trace_data_inventory') {
    const durationS = numericValue(rowValue(row, index, 'duration_s'));
    const sliceCount = numericValue(rowValue(row, index, 'slice_count'));
    const trackCount = numericValue(rowValue(row, index, 'track_count')) ?? 0;
    const processTrackCount = numericValue(rowValue(row, index, 'process_track_count')) ?? 0;
    const threadTrackCount = numericValue(rowValue(row, index, 'thread_track_count')) ?? 0;
    const processCount = numericValue(rowValue(row, index, 'process_count'));
    const threadCount = numericValue(rowValue(row, index, 'thread_count'));
    const schedSliceCount = numericValue(rowValue(row, index, 'sched_slice_count')) ?? 0;
    const threadStateCount = numericValue(rowValue(row, index, 'thread_state_count')) ?? 0;
    const counterTrackCount = numericValue(rowValue(row, index, 'counter_track_count')) ?? 0;
    const processCounterTrackCount = numericValue(rowValue(row, index, 'process_counter_track_count')) ?? 0;
    const cpuCounterTrackCount = numericValue(rowValue(row, index, 'cpu_counter_track_count')) ?? 0;
    const gpuCounterTrackCount = numericValue(rowValue(row, index, 'gpu_counter_track_count')) ?? 0;
    const counterSampleCount = numericValue(rowValue(row, index, 'counter_sample_count')) ?? 0;
    const cpufreqSampleCount = numericValue(rowValue(row, index, 'cpufreq_sample_count')) ?? 0;
    const actualFrameTimelineCount = numericValue(rowValue(row, index, 'actual_frame_timeline_slice_count')) ?? 0;
    const expectedFrameTimelineCount = numericValue(rowValue(row, index, 'expected_frame_timeline_slice_count')) ?? 0;
    const gpuSliceCount = numericValue(rowValue(row, index, 'gpu_slice_count')) ?? 0;
    const gpuCounterSampleCount = numericValue(rowValue(row, index, 'gpu_counter_sample_count')) ?? 0;
    const networkPacketEventCount = numericValue(rowValue(row, index, 'network_packet_event_count')) ?? 0;
    const androidLogCount = numericValue(rowValue(row, index, 'android_log_count')) ?? 0;
    if (
      durationS === undefined
      || durationS < 0
      || sliceCount === undefined
      || sliceCount < 0
      || processCount === undefined
      || processCount < 0
      || threadCount === undefined
      || threadCount < 0
    ) {
      return undefined;
    }
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const presentZh: string[] = [`trace_bounds 录制时长 ${durationS} 秒`];
    const presentEn: string[] = [`trace_bounds duration ${durationS}s`];
    const missingZh: string[] = [];
    const missingEn: string[] = [];

    const addInventoryItem = (
      present: boolean,
      zhPresent: string,
      enPresent: string,
      zhMissing: string,
      enMissing: string,
    ) => {
      if (present) {
        presentZh.push(zhPresent);
        presentEn.push(enPresent);
      } else {
        missingZh.push(zhMissing);
        missingEn.push(enMissing);
      }
    };

    addInventoryItem(
      sliceCount > 0 || trackCount > 0,
      `slice/track 时间线（slice=${sliceCount}, track=${trackCount}, process_track=${processTrackCount}, thread_track=${threadTrackCount}）`,
      `slice/track timeline (slice=${sliceCount}, track=${trackCount}, process_track=${processTrackCount}, thread_track=${threadTrackCount})`,
      'slice/track 时间线表',
      'slice/track timeline tables',
    );
    addInventoryItem(
      processCount > 0 || threadCount > 0,
      `进程/线程元数据（process=${processCount}, thread=${threadCount}）`,
      `process/thread metadata (process=${processCount}, thread=${threadCount})`,
      'process/thread 元数据',
      'process/thread metadata',
    );
    addInventoryItem(
      schedSliceCount > 0 || threadStateCount > 0,
      `调度/线程状态（sched_slice=${schedSliceCount}, thread_state=${threadStateCount}）`,
      `scheduler/thread-state data (sched_slice=${schedSliceCount}, thread_state=${threadStateCount})`,
      'sched_slice/thread_state 调度数据',
      'sched_slice/thread_state scheduler data',
    );
    addInventoryItem(
      counterSampleCount > 0,
      `计数器数据（counter=${counterSampleCount}, counter_track=${counterTrackCount}, process_counter_track=${processCounterTrackCount}, cpu_counter_track=${cpuCounterTrackCount}, gpu_counter_track=${gpuCounterTrackCount}）`,
      `counter data (counter=${counterSampleCount}, counter_track=${counterTrackCount}, process_counter_track=${processCounterTrackCount}, cpu_counter_track=${cpuCounterTrackCount}, gpu_counter_track=${gpuCounterTrackCount})`,
      'counter 计数器样本',
      'counter samples',
    );
    addInventoryItem(
      cpufreqSampleCount > 0,
      `CPU 频率样本（cpufreq=${cpufreqSampleCount}）`,
      `CPU frequency samples (cpufreq=${cpufreqSampleCount})`,
      'CPU 频率样本',
      'CPU frequency samples',
    );
    addInventoryItem(
      actualFrameTimelineCount > 0 || expectedFrameTimelineCount > 0,
      `FrameTimeline（actual=${actualFrameTimelineCount}, expected=${expectedFrameTimelineCount}）`,
      `FrameTimeline (actual=${actualFrameTimelineCount}, expected=${expectedFrameTimelineCount})`,
      'FrameTimeline actual/expected slices',
      'FrameTimeline actual/expected slices',
    );
    addInventoryItem(
      gpuSliceCount > 0 || gpuCounterSampleCount > 0,
      `GPU 数据（gpu_slice=${gpuSliceCount}, gpu_counter_samples=${gpuCounterSampleCount}）`,
      `GPU data (gpu_slice=${gpuSliceCount}, gpu_counter_samples=${gpuCounterSampleCount})`,
      'GPU slice/counter 样本',
      'GPU slice/counter samples',
    );
    addInventoryItem(
      networkPacketEventCount > 0,
      `packet-level 网络数据（android_network_packets=${networkPacketEventCount}）`,
      `packet-level network data (android_network_packets=${networkPacketEventCount})`,
      'packet-level 网络数据 android_network_packets',
      'packet-level android_network_packets data',
    );
    addInventoryItem(
      androidLogCount > 0,
      `Logcat 日志数据（android_logs=${androidLogCount}）`,
      `Logcat data (android_logs=${androidLogCount})`,
      'Logcat 日志数据 android_logs',
      'Logcat android_logs data',
    );

    const missingClauseZh = missingZh.length > 0
      ? `；这组清单未看到：${missingZh.join('；')}`
      : '；这组清单中的被检视数据都有记录';
    const missingClauseEn = missingEn.length > 0
      ? `; not seen in this inventory: ${missingEn.join('; ')}`
      : '; every checked category has records';
    const statement = localize(
      outputLanguage,
      `当前 trace 的常用数据清单包括：${presentZh.join('；')}${missingClauseZh}。这是基于常用 Perfetto 表/模块计数的快速清单，不等同于完整数据源枚举或问题诊断。`,
      `The current trace common-data inventory includes: ${presentEn.join('; ')}${missingClauseEn}. This is a fast inventory from common Perfetto table/module counts, not a complete data-source enumeration or issue diagnosis.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'duration_s', value: durationS }),
      directClaimReference({ envelope, column: 'slice_count', value: sliceCount }),
      directClaimReference({ envelope, column: 'track_count', value: trackCount }),
      directClaimReference({ envelope, column: 'process_count', value: processCount }),
      directClaimReference({ envelope, column: 'thread_count', value: threadCount }),
      directClaimReference({ envelope, column: 'sched_slice_count', value: schedSliceCount }),
      directClaimReference({ envelope, column: 'thread_state_count', value: threadStateCount }),
      directClaimReference({ envelope, column: 'counter_sample_count', value: counterSampleCount }),
      directClaimReference({ envelope, column: 'cpufreq_sample_count', value: cpufreqSampleCount }),
      directClaimReference({ envelope, column: 'actual_frame_timeline_slice_count', value: actualFrameTimelineCount }),
      directClaimReference({ envelope, column: 'expected_frame_timeline_slice_count', value: expectedFrameTimelineCount }),
      directClaimReference({ envelope, column: 'gpu_slice_count', value: gpuSliceCount }),
      directClaimReference({ envelope, column: 'gpu_counter_sample_count', value: gpuCounterSampleCount }),
      directClaimReference({ envelope, column: 'network_packet_event_count', value: networkPacketEventCount }),
      directClaimReference({ envelope, column: 'android_log_count', value: androidLogCount }),
    ];
    const rows = [
      `column=\`duration_s\`; value=\`${durationS}\``,
      `column=\`slice_count\`; value=\`${sliceCount}\``,
      `column=\`track_count\`; value=\`${trackCount}\``,
      `column=\`process_count\`; value=\`${processCount}\``,
      `column=\`thread_count\`; value=\`${threadCount}\``,
      `column=\`sched_slice_count\`; value=\`${schedSliceCount}\``,
      `column=\`thread_state_count\`; value=\`${threadStateCount}\``,
      `column=\`counter_sample_count\`; value=\`${counterSampleCount}\``,
      `column=\`cpufreq_sample_count\`; value=\`${cpufreqSampleCount}\``,
      `column=\`actual_frame_timeline_slice_count\`; value=\`${actualFrameTimelineCount}\``,
      `column=\`expected_frame_timeline_slice_count\`; value=\`${expectedFrameTimelineCount}\``,
      `column=\`gpu_slice_count\`; value=\`${gpuSliceCount}\``,
      `column=\`gpu_counter_sample_count\`; value=\`${gpuCounterSampleCount}\``,
      `column=\`network_packet_event_count\`; value=\`${networkPacketEventCount}\``,
      `column=\`android_log_count\`; value=\`${androidLogCount}\``,
      `column=\`source_table\`; value=\`${sourceTable}\``,
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows,
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: duration_s=${durationS}, slice_count=${sliceCount}, track_count=${trackCount}, process_count=${processCount}, thread_count=${threadCount}, sched_slice_count=${schedSliceCount}, thread_state_count=${threadStateCount}, counter_sample_count=${counterSampleCount}, cpufreq_sample_count=${cpufreqSampleCount}, actual_frame_timeline_slice_count=${actualFrameTimelineCount}, expected_frame_timeline_slice_count=${expectedFrameTimelineCount}, gpu_slice_count=${gpuSliceCount}, gpu_counter_sample_count=${gpuCounterSampleCount}, network_packet_event_count=${networkPacketEventCount}, android_log_count=${androidLogCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'trace_duration') {
    const traceStartNs = numericValue(rowValue(row, index, 'trace_start_ns'));
    const traceEndNs = numericValue(rowValue(row, index, 'trace_end_ns'));
    const traceStartS = numericValue(rowValue(row, index, 'trace_start_s'));
    const traceEndS = numericValue(rowValue(row, index, 'trace_end_s'));
    const durationS = numericValue(rowValue(row, index, 'duration_s'));
    if (
      traceStartNs === undefined
      || traceEndNs === undefined
      || traceStartS === undefined
      || traceEndS === undefined
      || !durationS
      || durationS <= 0
    ) return undefined;
    const statement = localize(
      outputLanguage,
      `当前 trace 起止时间为 ${traceStartS}-${traceEndS} 秒，录制时长约 ${durationS} 秒。`,
      `The current trace spans ${traceStartS}-${traceEndS} seconds, with a recording duration of about ${durationS} seconds.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'trace_start_ns', value: traceStartNs }),
      directClaimReference({ envelope, column: 'trace_end_ns', value: traceEndNs }),
      directClaimReference({ envelope, column: 'trace_start_s', value: traceStartS }),
      directClaimReference({ envelope, column: 'trace_end_s', value: traceEndS }),
      directClaimReference({ envelope, column: 'duration_s', value: durationS }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`trace_start_ns\`; value=\`${traceStartNs}\``,
          `column=\`trace_end_ns\`; value=\`${traceEndNs}\``,
          `column=\`trace_start_s\`; value=\`${traceStartS}\``,
          `column=\`trace_end_s\`; value=\`${traceEndS}\``,
          `column=\`duration_s\`; value=\`${durationS}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: trace_start_ns=${traceStartNs}, trace_end_ns=${traceEndNs}, trace_start_s=${traceStartS}, trace_end_s=${traceEndS}, duration_s=${durationS}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'trace_health_issues') {
    const issueStatCount = numericValue(rowValue(row, index, 'issue_stat_count'));
    if (issueStatCount === undefined || issueStatCount < 0) return undefined;
    const errorStatCount = numericValue(rowValue(row, index, 'error_stat_count')) ?? 0;
    const dataLossStatCount = numericValue(rowValue(row, index, 'data_loss_stat_count')) ?? 0;
    const totalIssueValue = numericValue(rowValue(row, index, 'total_issue_value')) ?? 0;
    const issueNames = cellList(rowValue(row, index, 'issue_names'));
    const issueValues = cellList(rowValue(row, index, 'issue_values'));
    const issueSeverities = cellList(rowValue(row, index, 'issue_severities'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasIssues = issueStatCount > 0;
    const issueSamples = issueNames.length > 0
      ? formatTraceHealthIssueSamples({
        names: issueNames,
        values: issueValues,
        severities: issueSeverities,
      })
      : '';
    const issueSamplesZh = issueSamples ? `；主要项：${issueSamples}` : '';
    const issueSamplesEn = issueSamples ? `; top issues: ${issueSamples}` : '';
    const statement = localize(
      outputLanguage,
      hasIssues
        ? `当前 trace 的 Perfetto stats 记录了 ${issueStatCount} 类 trace health issue（error ${errorStatCount} 类、data_loss ${dataLossStatCount} 类），累计计数 ${totalIssueValue}${issueSamplesZh}。`
        : '当前 trace 的 Perfetto stats 未记录 severity=error/data_loss 且 value > 0 的 trace health issue；这只说明采集/解析健康统计没有错误或数据丢失级别问题，不等同于证明应用没有性能问题。',
      hasIssues
        ? `The current trace records ${issueStatCount} Perfetto stats trace health issue types (${errorStatCount} error, ${dataLossStatCount} data_loss), with total count ${totalIssueValue}${issueSamplesEn}.`
        : 'The current trace records no Perfetto stats trace health issues with severity=error/data_loss and value > 0; this only means the capture/parse health stats show no error or data-loss level issue, not proof that the app has no performance problem.',
    );
    const references = [
      directClaimReference({ envelope, column: 'issue_stat_count', value: issueStatCount }),
      directClaimReference({ envelope, column: 'error_stat_count', value: errorStatCount }),
      directClaimReference({ envelope, column: 'data_loss_stat_count', value: dataLossStatCount }),
      directClaimReference({ envelope, column: 'total_issue_value', value: totalIssueValue }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasIssues && issueNames.length > 0
        ? [directClaimReference({ envelope, column: 'issue_names', value: issueNames.join(',') })]
        : []),
      ...(hasIssues && issueValues.length > 0
        ? [directClaimReference({ envelope, column: 'issue_values', value: issueValues.join(',') })]
        : []),
      ...(hasIssues && issueSeverities.length > 0
        ? [directClaimReference({ envelope, column: 'issue_severities', value: issueSeverities.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`issue_stat_count\`; value=\`${issueStatCount}\``,
          `column=\`error_stat_count\`; value=\`${errorStatCount}\``,
          `column=\`data_loss_stat_count\`; value=\`${dataLossStatCount}\``,
          `column=\`total_issue_value\`; value=\`${totalIssueValue}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasIssues && issueNames.length > 0
            ? [`column=\`issue_names\`; value=\`${issueNames.join(',')}\``]
            : []),
          ...(hasIssues && issueValues.length > 0
            ? [`column=\`issue_values\`; value=\`${issueValues.join(',')}\``]
            : []),
          ...(hasIssues && issueSeverities.length > 0
            ? [`column=\`issue_severities\`; value=\`${issueSeverities.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasIssues
          ? `${sourceRef}: issue_stat_count=${issueStatCount}, error_stat_count=${errorStatCount}, data_loss_stat_count=${dataLossStatCount}, total_issue_value=${totalIssueValue}, issue_names=${issueNames.join(',')}, issue_values=${issueValues.join(',')}, issue_severities=${issueSeverities.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: issue_stat_count=${issueStatCount}, error_stat_count=${errorStatCount}, data_loss_stat_count=${dataLossStatCount}, total_issue_value=${totalIssueValue}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'frame_timeline_presence') {
    const actualFrameCount = numericValue(rowValue(row, index, 'actual_frame_timeline_slice_count'));
    const expectedFrameCount = numericValue(rowValue(row, index, 'expected_frame_timeline_slice_count'));
    const jankyActualFrameCount = numericValue(rowValue(row, index, 'janky_actual_frame_count')) ?? 0;
    const actualFrameUpidCount = numericValue(rowValue(row, index, 'actual_frame_upid_count')) ?? 0;
    if (
      actualFrameCount === undefined
      || actualFrameCount < 0
      || expectedFrameCount === undefined
      || expectedFrameCount < 0
      || jankyActualFrameCount < 0
      || actualFrameUpidCount < 0
    ) {
      return undefined;
    }
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasFrameTimelineData = actualFrameCount > 0 || expectedFrameCount > 0;
    const statement = localize(
      outputLanguage,
      hasFrameTimelineData
        ? `当前 trace 采集到了 FrameTimeline 数据：actual_frame_timeline_slice ${actualFrameCount} 行，expected_frame_timeline_slice ${expectedFrameCount} 行；其中 ${jankyActualFrameCount} 行 actual frame 标记为 jank，涉及 ${actualFrameUpidCount} 个 upid。`
        : '当前 trace 未采集到可解析的 FrameTimeline 数据；这只说明 actual_frame_timeline_slice/expected_frame_timeline_slice 中没有帧记录，不等同于证明设备没有渲染、掉帧或图形性能问题。',
      hasFrameTimelineData
        ? `The current trace contains FrameTimeline data: ${actualFrameCount} actual_frame_timeline_slice rows and ${expectedFrameCount} expected_frame_timeline_slice rows; ${jankyActualFrameCount} actual frame rows are marked janky, across ${actualFrameUpidCount} upids.`
        : 'The current trace contains no parsable FrameTimeline data; this only means actual_frame_timeline_slice/expected_frame_timeline_slice have no frame rows, not proof that the device had no rendering, jank, or graphics performance issue.',
    );
    const references = [
      directClaimReference({ envelope, column: 'actual_frame_timeline_slice_count', value: actualFrameCount }),
      directClaimReference({ envelope, column: 'expected_frame_timeline_slice_count', value: expectedFrameCount }),
      directClaimReference({ envelope, column: 'janky_actual_frame_count', value: jankyActualFrameCount }),
      directClaimReference({ envelope, column: 'actual_frame_upid_count', value: actualFrameUpidCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`actual_frame_timeline_slice_count\`; value=\`${actualFrameCount}\``,
          `column=\`expected_frame_timeline_slice_count\`; value=\`${expectedFrameCount}\``,
          `column=\`janky_actual_frame_count\`; value=\`${jankyActualFrameCount}\``,
          `column=\`actual_frame_upid_count\`; value=\`${actualFrameUpidCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: actual_frame_timeline_slice_count=${actualFrameCount}, expected_frame_timeline_slice_count=${expectedFrameCount}, janky_actual_frame_count=${jankyActualFrameCount}, actual_frame_upid_count=${actualFrameUpidCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'refresh_rate') {
    const refreshRateHz = numericValue(rowValue(row, index, 'refresh_rate_hz'));
    const vsyncPeriodNs = numericValue(rowValue(row, index, 'vsync_period_ns'));
    const vsyncPeriodMs = numericValue(rowValue(row, index, 'vsync_period_ms'));
    const sampleCount = numericValue(rowValue(row, index, 'sample_count'));
    const rawMedianPeriodNs = numericValue(rowValue(row, index, 'raw_median_period_ns'));
    const detectionMethod = cellText(rowValue(row, index, 'detection_method'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    if (
      refreshRateHz === undefined
      || refreshRateHz <= 0
      || vsyncPeriodNs === undefined
      || vsyncPeriodNs <= 0
      || vsyncPeriodMs === undefined
      || vsyncPeriodMs <= 0
      || sampleCount === undefined
      || sampleCount < 10
      || !detectionMethod
      || detectionMethod === '-'
      || detectionMethod === 'default_60hz'
    ) {
      return undefined;
    }
    const rawMedianText = rawMedianPeriodNs !== undefined && rawMedianPeriodNs > 0
      ? localize(
        outputLanguage,
        `，原始中位周期 ${rawMedianPeriodNs} ns`,
        `, raw median period ${rawMedianPeriodNs} ns`,
      )
      : '';
    const statement = localize(
      outputLanguage,
      `当前 trace 通过 ${detectionMethod} 样本观测/推断到的 VSync 刷新率约为 ${refreshRateHz} Hz（周期约 ${vsyncPeriodMs} ms，样本数 ${sampleCount}${rawMedianText}）。这表示 trace 中可解析的显示/帧节奏，不等同于设备支持的全部刷新率、VRR 能力或刷新率策略结论。`,
      `The current trace observes/infers a VSync refresh rate of about ${refreshRateHz} Hz from ${detectionMethod} samples (period about ${vsyncPeriodMs} ms, ${sampleCount} samples${rawMedianText}). This describes the display/frame cadence parsable in this trace, not every refresh rate the device supports, VRR capability, or refresh-rate policy behavior.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'refresh_rate_hz', value: refreshRateHz }),
      directClaimReference({ envelope, column: 'vsync_period_ns', value: vsyncPeriodNs }),
      directClaimReference({ envelope, column: 'vsync_period_ms', value: vsyncPeriodMs }),
      directClaimReference({ envelope, column: 'detection_method', value: detectionMethod }),
      directClaimReference({ envelope, column: 'sample_count', value: sampleCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(rawMedianPeriodNs !== undefined && rawMedianPeriodNs > 0
        ? [directClaimReference({ envelope, column: 'raw_median_period_ns', value: rawMedianPeriodNs })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`refresh_rate_hz\`; value=\`${refreshRateHz}\``,
          `column=\`vsync_period_ns\`; value=\`${vsyncPeriodNs}\``,
          `column=\`vsync_period_ms\`; value=\`${vsyncPeriodMs}\``,
          `column=\`detection_method\`; value=\`${detectionMethod}\``,
          `column=\`sample_count\`; value=\`${sampleCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(rawMedianPeriodNs !== undefined && rawMedianPeriodNs > 0
            ? [`column=\`raw_median_period_ns\`; value=\`${rawMedianPeriodNs}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: refresh_rate_hz=${refreshRateHz}, vsync_period_ns=${vsyncPeriodNs}, vsync_period_ms=${vsyncPeriodMs}, detection_method=${detectionMethod}, sample_count=${sampleCount}, raw_median_period_ns=${rawMedianPeriodNs ?? ''}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'trace_jank_presence') {
    const scope = cellText(rowValue(row, index, 'scope'));
    const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
    const jankFrames = numericValue(rowValue(row, index, 'jank_frames'));
    if (
      !totalFrames
      || totalFrames <= 0
      || jankFrames === undefined
      || jankFrames < 0
    ) {
      return undefined;
    }
    const jankRatePct = numericValue(rowValue(row, index, 'jank_rate_pct'))
      ?? Number(((jankFrames / totalFrames) * 100).toFixed(2));
    const jankTypes = cellText(rowValue(row, index, 'jank_types'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasJank = jankFrames > 0;
    const scopedRange = scopedRangeReferenceInfo({ envelope, row, index });
    const subjectZh = scopedRange ? '当前选区的 FrameTimeline' : '当前 trace 的 FrameTimeline';
    const subjectEn = scopedRange ? 'The current selection has' : 'The current trace has';
    const scopeNoteZh = scopedRange
      ? '这是选区内的 trace-wide FrameTimeline 统计，不等同于特定应用或进程的归因结论。'
      : '这是 trace 全局 FrameTimeline 统计，不等同于特定应用或进程的归因结论。';
    const scopeNoteEn = scopedRange
      ? 'This is a selected-range trace-wide FrameTimeline count, not attribution to a specific app or process.'
      : 'This is a trace-wide FrameTimeline count, not attribution to a specific app or process.';
    const statement = localize(
      outputLanguage,
      hasJank
        ? `${subjectZh} 中共有 ${totalFrames} 帧，其中 ${jankFrames} 帧标记为掉帧/卡顿（${jankRatePct}%）。${scopeNoteZh}`
        : `${subjectZh} 中共有 ${totalFrames} 帧，其中 0 帧标记为掉帧/卡顿；未观测到${scopedRange ? '选区内' : ' trace 全局'}掉帧/卡顿帧。${scopeNoteZh}`,
      hasJank
        ? `${subjectEn} ${totalFrames} FrameTimeline frames, with ${jankFrames} frames marked as janky (${jankRatePct}%). ${scopeNoteEn}`
        : `${subjectEn} ${totalFrames} FrameTimeline frames, with 0 frames marked as janky; no ${scopedRange ? 'selected-range' : 'trace-wide'} janky frames were observed. ${scopeNoteEn}`,
    );
    const references = [
      directClaimReference({ envelope, column: 'total_frames', value: totalFrames }),
      directClaimReference({ envelope, column: 'jank_frames', value: jankFrames }),
      directClaimReference({ envelope, column: 'jank_rate_pct', value: jankRatePct }),
      ...(scopedRange?.references ?? []),
      ...(scope && scope !== '-'
        ? [directClaimReference({ envelope, column: 'scope', value: scope })]
        : []),
      ...(sourceTable && sourceTable !== '-'
        ? [directClaimReference({ envelope, column: 'source_table', value: sourceTable })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          ...(scope && scope !== '-'
            ? [`column=\`scope\`; value=\`${scope}\``]
            : []),
          `column=\`total_frames\`; value=\`${totalFrames}\``,
          `column=\`jank_frames\`; value=\`${jankFrames}\``,
          `column=\`jank_rate_pct\`; value=\`${jankRatePct}\``,
          ...(scopedRange?.rows ?? []),
          ...(sourceTable && sourceTable !== '-'
            ? [`column=\`source_table\`; value=\`${sourceTable}\``]
            : []),
          ...(hasJank && jankTypes && jankTypes !== '-'
            ? [`column=\`jank_types\`; value=\`${jankTypes}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: scope=${scope}, total_frames=${totalFrames}, jank_frames=${jankFrames}, jank_rate_pct=${jankRatePct}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'jank_frame_count') {
    const packageName = rowValue(row, index, 'package_name');
    const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
    const jankFrames = numericValue(rowValue(row, index, 'jank_frames'));
    if (
      typeof packageName !== 'string'
      || !totalFrames
      || totalFrames <= 0
      || jankFrames === undefined
      || jankFrames < 0
    ) {
      return undefined;
    }
    const jankRatePct = numericValue(rowValue(row, index, 'jank_rate_pct'))
      ?? Number(((jankFrames / totalFrames) * 100).toFixed(2));
    const jankTypes = cellText(rowValue(row, index, 'jank_types'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasJank = jankFrames > 0;
    const scopedRange = scopedRangeReferenceInfo({ envelope, row, index });
    const subjectZh = scopedRange ? `选区内焦点应用 ${packageName}` : `焦点应用 ${packageName}`;
    const subjectEn = scopedRange ? `The focus app ${packageName} in the current selection` : `The focus app ${packageName}`;
    const statement = localize(
      outputLanguage,
      hasJank
        ? `${subjectZh} 的 FrameTimeline 中共有 ${totalFrames} 帧，其中 ${jankFrames} 帧标记为掉帧/卡顿（${jankRatePct}%）。`
        : `${subjectZh} 的 FrameTimeline 中共有 ${totalFrames} 帧，其中 0 帧标记为掉帧/卡顿；未观测到掉帧/卡顿帧。`,
      hasJank
        ? `${subjectEn} has ${totalFrames} FrameTimeline frames, with ${jankFrames} frames marked as janky (${jankRatePct}%).`
        : `${subjectEn} has ${totalFrames} FrameTimeline frames, with 0 frames marked as janky; no janky frames were observed.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'package_name', value: packageName }),
      directClaimReference({ envelope, column: 'total_frames', value: totalFrames }),
      directClaimReference({ envelope, column: 'jank_frames', value: jankFrames }),
      directClaimReference({ envelope, column: 'jank_rate_pct', value: jankRatePct }),
      ...(scopedRange?.references ?? []),
      ...(sourceTable && sourceTable !== '-'
        ? [directClaimReference({ envelope, column: 'source_table', value: sourceTable })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`package_name\`; value=\`${packageName}\``,
          `column=\`total_frames\`; value=\`${totalFrames}\``,
          `column=\`jank_frames\`; value=\`${jankFrames}\``,
          `column=\`jank_rate_pct\`; value=\`${jankRatePct}\``,
          ...(scopedRange?.rows ?? []),
          ...(sourceTable && sourceTable !== '-'
            ? [`column=\`source_table\`; value=\`${sourceTable}\``]
            : []),
          ...(hasJank && jankTypes && jankTypes !== '-'
            ? [`column=\`jank_types\`; value=\`${jankTypes}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: package_name=${packageName}, total_frames=${totalFrames}, jank_frames=${jankFrames}, jank_rate_pct=${jankRatePct}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'jank_presence') {
    const packageName = rowValue(row, index, 'package_name');
    const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
    const jankFrames = numericValue(rowValue(row, index, 'jank_frames'));
    if (
      typeof packageName !== 'string'
      || !totalFrames
      || totalFrames <= 0
      || jankFrames === undefined
      || jankFrames < 0
    ) {
      return undefined;
    }
    const jankRatePct = numericValue(rowValue(row, index, 'jank_rate_pct'))
      ?? Number(((jankFrames / totalFrames) * 100).toFixed(2));
    const fps = numericValue(rowValue(row, index, 'fps'));
    const jankTypes = cellText(rowValue(row, index, 'jank_types'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasJank = jankFrames > 0;
    const fpsZh = fps && fps > 0 ? `，帧率约 ${fps} FPS` : '';
    const fpsEn = fps && fps > 0 ? `, at about ${fps} FPS` : '';
    const scopedRange = scopedRangeReferenceInfo({ envelope, row, index });
    const subjectZh = scopedRange ? `选区内焦点应用 ${packageName}` : `焦点应用 ${packageName}`;
    const subjectEn = scopedRange ? `The focus app ${packageName} in the current selection` : `The focus app ${packageName}`;
    const statement = localize(
      outputLanguage,
      hasJank
        ? `${subjectZh} 的 FrameTimeline 中共有 ${totalFrames} 帧${fpsZh}，其中 ${jankFrames} 帧标记为掉帧/卡顿（${jankRatePct}%）。`
        : `${subjectZh} 的 FrameTimeline 中共有 ${totalFrames} 帧${fpsZh}，其中 0 帧标记为掉帧/卡顿；未观测到掉帧/卡顿帧。`,
      hasJank
        ? `${subjectEn} has ${totalFrames} FrameTimeline frames${fpsEn}, with ${jankFrames} frames marked as janky (${jankRatePct}%).`
        : `${subjectEn} has ${totalFrames} FrameTimeline frames${fpsEn}, with 0 frames marked as janky; no janky frames were observed.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'package_name', value: packageName }),
      directClaimReference({ envelope, column: 'total_frames', value: totalFrames }),
      directClaimReference({ envelope, column: 'jank_frames', value: jankFrames }),
      directClaimReference({ envelope, column: 'jank_rate_pct', value: jankRatePct }),
      ...(scopedRange?.references ?? []),
      ...(fps && fps > 0
        ? [directClaimReference({ envelope, column: 'fps', value: fps })]
        : []),
      ...(sourceTable && sourceTable !== '-'
        ? [directClaimReference({ envelope, column: 'source_table', value: sourceTable })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`package_name\`; value=\`${packageName}\``,
          `column=\`total_frames\`; value=\`${totalFrames}\``,
          `column=\`jank_frames\`; value=\`${jankFrames}\``,
          `column=\`jank_rate_pct\`; value=\`${jankRatePct}\``,
          ...(scopedRange?.rows ?? []),
          ...(fps && fps > 0
            ? [`column=\`fps\`; value=\`${fps}\``]
            : []),
          ...(sourceTable && sourceTable !== '-'
            ? [`column=\`source_table\`; value=\`${sourceTable}\``]
            : []),
          ...(hasJank && jankTypes && jankTypes !== '-'
            ? [`column=\`jank_types\`; value=\`${jankTypes}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: package_name=${packageName}, total_frames=${totalFrames}, jank_frames=${jankFrames}, jank_rate_pct=${jankRatePct}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}${fps && fps > 0 ? `, fps=${fps}` : ''}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'thread_count') {
    const threadCount = numericValue(rowValue(row, index, 'thread_count'));
    const processCount = numericValue(rowValue(row, index, 'process_count')) ?? 0;
    if (!threadCount || threadCount <= 0) return undefined;
    const statement = localize(
      outputLanguage,
      processCount > 0
        ? `当前 trace 观测到 ${threadCount} 个线程，覆盖 ${processCount} 个进程。`
        : `当前 trace 观测到 ${threadCount} 个线程。`,
      processCount > 0
        ? `The current trace observes ${threadCount} threads across ${processCount} processes.`
        : `The current trace observes ${threadCount} threads.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'thread_count', value: threadCount }),
    ];
    if (processCount > 0) {
      references.push(directClaimReference({ envelope, column: 'process_count', value: processCount }));
    }
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`thread_count\`; value=\`${threadCount}\``,
          ...(processCount > 0
            ? [`column=\`process_count\`; value=\`${processCount}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: processCount > 0
          ? `${sourceRef}: thread_count=${threadCount}, process_count=${processCount}`
          : `${sourceRef}: thread_count=${threadCount}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'app_thread_count') {
    const packageName = rowValue(row, index, 'package_name');
    const threadCount = numericValue(rowValue(row, index, 'thread_count'));
    const processCount = numericValue(rowValue(row, index, 'process_count')) ?? 0;
    if (typeof packageName !== 'string' || !threadCount || threadCount <= 0) return undefined;
    const processNames = cellList(rowValue(row, index, 'process_names'));
    const processThreadCounts = cellList(rowValue(row, index, 'process_thread_counts'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const processSummary = processNames.length > 0
      ? formatNamedCountSamples({ names: processNames, counts: processThreadCounts })
      : '';
    const processZh = processSummary ? `；主要进程：${processSummary}` : '';
    const processEn = processSummary ? `; top processes: ${processSummary}` : '';
    const statement = localize(
      outputLanguage,
      processCount > 0
        ? `焦点应用 ${packageName} 在当前 trace 中观测到 ${threadCount} 个线程，覆盖 ${processCount} 个进程${processZh}。`
        : `焦点应用 ${packageName} 在当前 trace 中观测到 ${threadCount} 个线程${processZh}。`,
      processCount > 0
        ? `The focus app ${packageName} observes ${threadCount} threads across ${processCount} processes in the current trace${processEn}.`
        : `The focus app ${packageName} observes ${threadCount} threads in the current trace${processEn}.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'package_name', value: packageName }),
      directClaimReference({ envelope, column: 'thread_count', value: threadCount }),
      ...(processCount > 0
        ? [directClaimReference({ envelope, column: 'process_count', value: processCount })]
        : []),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(processSummary
        ? [directClaimReference({ envelope, column: 'process_names', value: processNames.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`package_name\`; value=\`${packageName}\``,
          `column=\`thread_count\`; value=\`${threadCount}\``,
          ...(processCount > 0
            ? [`column=\`process_count\`; value=\`${processCount}\``]
            : []),
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(processSummary
            ? [`column=\`process_names\`; value=\`${processNames.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: processSummary
          ? `${sourceRef}: package_name=${packageName}, thread_count=${threadCount}, process_count=${processCount}, process_names=${processNames.join(',')}, process_thread_counts=${processThreadCounts.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: package_name=${packageName}, thread_count=${threadCount}, process_count=${processCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'process_count') {
    const processCount = numericValue(rowValue(row, index, 'process_count'));
    if (!processCount || processCount <= 0) return undefined;
    const listedProcessCount = numericValue(rowValue(row, index, 'listed_process_count')) ?? 0;
    const processNames = cellList(rowValue(row, index, 'process_names'));
    const processThreadCounts = cellList(rowValue(row, index, 'process_thread_counts'));
    const omittedProcessCount = numericValue(rowValue(row, index, 'omitted_process_count')) ?? 0;
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const processSamples = processNames.length > 0
      ? formatProcessSamples({
        names: processNames,
        threadCounts: processThreadCounts,
        outputLanguage,
      })
      : '';
    const sampleZh = processSamples
      ? `；按线程数排序，前 ${listedProcessCount || processNames.length} 个进程包括：${processSamples}`
      : '';
    const sampleEn = processSamples
      ? `; sorted by thread count, the top ${listedProcessCount || processNames.length} processes are: ${processSamples}`
      : '';
    const omittedZh = omittedProcessCount > 0 ? `；另有 ${omittedProcessCount} 个进程未列出` : '';
    const omittedEn = omittedProcessCount > 0 ? `; ${omittedProcessCount} more processes are not listed` : '';
    const statement = localize(
      outputLanguage,
      `当前 trace 观测到 ${processCount} 个进程${sampleZh}${omittedZh}。`,
      `The current trace observes ${processCount} processes${sampleEn}${omittedEn}.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'process_count', value: processCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(listedProcessCount > 0
        ? [directClaimReference({ envelope, column: 'listed_process_count', value: listedProcessCount })]
        : []),
      ...(processNames.length > 0
        ? [directClaimReference({ envelope, column: 'process_names', value: processNames.join(',') })]
        : []),
      ...(processThreadCounts.length > 0
        ? [directClaimReference({ envelope, column: 'process_thread_counts', value: processThreadCounts.join(',') })]
        : []),
      ...(omittedProcessCount > 0
        ? [directClaimReference({ envelope, column: 'omitted_process_count', value: omittedProcessCount })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`process_count\`; value=\`${processCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(listedProcessCount > 0
            ? [`column=\`listed_process_count\`; value=\`${listedProcessCount}\``]
            : []),
          ...(processNames.length > 0
            ? [`column=\`process_names\`; value=\`${processNames.join(',')}\``]
            : []),
          ...(processThreadCounts.length > 0
            ? [`column=\`process_thread_counts\`; value=\`${processThreadCounts.join(',')}\``]
            : []),
          ...(omittedProcessCount > 0
            ? [`column=\`omitted_process_count\`; value=\`${omittedProcessCount}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: process_count=${processCount}, listed_process_count=${listedProcessCount}, process_names=${processNames.join(',')}, process_thread_counts=${processThreadCounts.join(',')}, omitted_process_count=${omittedProcessCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'app_process_count') {
    const packageName = rowValue(row, index, 'package_name');
    const processCount = numericValue(rowValue(row, index, 'process_count'));
    const threadCount = numericValue(rowValue(row, index, 'thread_count')) ?? 0;
    if (typeof packageName !== 'string' || !processCount || processCount <= 0) return undefined;
    const processNames = cellList(rowValue(row, index, 'process_names'));
    const processThreadCounts = cellList(rowValue(row, index, 'process_thread_counts'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const processSummary = processNames.length > 0
      ? formatNamedCountSamples({ names: processNames, counts: processThreadCounts })
      : '';
    const processZh = processSummary ? `；进程：${processSummary}` : '';
    const processEn = processSummary ? `; processes: ${processSummary}` : '';
    const threadZh = threadCount > 0 ? `，共 ${threadCount} 个线程` : '';
    const threadEn = threadCount > 0 ? ` with ${threadCount} threads` : '';
    const statement = localize(
      outputLanguage,
      `焦点应用 ${packageName} 在当前 trace 中观测到 ${processCount} 个进程${threadZh}${processZh}。`,
      `The focus app ${packageName} observes ${processCount} processes in the current trace${threadEn}${processEn}.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'package_name', value: packageName }),
      directClaimReference({ envelope, column: 'process_count', value: processCount }),
      ...(threadCount > 0
        ? [directClaimReference({ envelope, column: 'thread_count', value: threadCount })]
        : []),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(processSummary
        ? [directClaimReference({ envelope, column: 'process_names', value: processNames.join(',') })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`package_name\`; value=\`${packageName}\``,
          `column=\`process_count\`; value=\`${processCount}\``,
          ...(threadCount > 0
            ? [`column=\`thread_count\`; value=\`${threadCount}\``]
            : []),
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(processSummary
            ? [`column=\`process_names\`; value=\`${processNames.join(',')}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: processSummary
          ? `${sourceRef}: package_name=${packageName}, process_count=${processCount}, thread_count=${threadCount}, process_names=${processNames.join(',')}, process_thread_counts=${processThreadCounts.join(',')}, source_table=${sourceTable}`
          : `${sourceRef}: package_name=${packageName}, process_count=${processCount}, thread_count=${threadCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'binder_transaction_count') {
    const binderTxnCount = numericValue(rowValue(row, index, 'binder_txn_count'));
    if (binderTxnCount === undefined || binderTxnCount < 0) return undefined;
    const syncCount = numericValue(rowValue(row, index, 'sync_count')) ?? 0;
    const asyncCount = numericValue(rowValue(row, index, 'async_count')) ?? 0;
    const totalClientMs = numericValue(rowValue(row, index, 'total_client_ms')) ?? 0;
    const maxClientMs = numericValue(rowValue(row, index, 'max_client_ms')) ?? 0;
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasBinderTransactions = binderTxnCount > 0;
    const statement = localize(
      outputLanguage,
      hasBinderTransactions
        ? `当前 trace 的 android.binder 记录了 ${binderTxnCount} 次 Binder transaction，其中 ${syncCount} 次同步、${asyncCount} 次异步；client 侧累计耗时约 ${totalClientMs} ms，最长约 ${maxClientMs} ms。`
        : '当前 trace 的 android.binder 未记录到 Binder transaction。',
      hasBinderTransactions
        ? `The current trace records ${binderTxnCount} Binder transactions in android.binder: ${syncCount} synchronous and ${asyncCount} asynchronous; client-side duration totals about ${totalClientMs} ms, max about ${maxClientMs} ms.`
        : 'The current trace records no Binder transactions in android.binder.',
    );
    const references = [
      directClaimReference({ envelope, column: 'binder_txn_count', value: binderTxnCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasBinderTransactions
        ? [
          directClaimReference({ envelope, column: 'sync_count', value: syncCount }),
          directClaimReference({ envelope, column: 'async_count', value: asyncCount }),
          directClaimReference({ envelope, column: 'total_client_ms', value: totalClientMs }),
          directClaimReference({ envelope, column: 'max_client_ms', value: maxClientMs }),
        ]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`binder_txn_count\`; value=\`${binderTxnCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasBinderTransactions
            ? [
              `column=\`sync_count\`; value=\`${syncCount}\``,
              `column=\`async_count\`; value=\`${asyncCount}\``,
              `column=\`total_client_ms\`; value=\`${totalClientMs}\``,
              `column=\`max_client_ms\`; value=\`${maxClientMs}\``,
            ]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasBinderTransactions
          ? `${sourceRef}: binder_txn_count=${binderTxnCount}, sync_count=${syncCount}, async_count=${asyncCount}, total_client_ms=${totalClientMs}, max_client_ms=${maxClientMs}, source_table=${sourceTable}`
          : `${sourceRef}: binder_txn_count=${binderTxnCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'anr_presence') {
    const totalAnrCount = numericValue(rowValue(row, index, 'total_anr_count'));
    if (totalAnrCount === undefined || totalAnrCount < 0) return undefined;
    const affectedProcessCount = numericValue(rowValue(row, index, 'affected_process_count')) ?? 0;
    const anrSpanSeconds = numericValue(rowValue(row, index, 'anr_span_seconds')) ?? 0;
    const anrTypes = cellText(rowValue(row, index, 'anr_types'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasAnr = totalAnrCount > 0;
    const typeZh = hasAnr && anrTypes && anrTypes !== '-' ? `；类型：${anrTypes}` : '';
    const spanZh = hasAnr && anrSpanSeconds > 0 ? `，ANR 时间跨度约 ${anrSpanSeconds} 秒` : '';
    const typeEn = hasAnr && anrTypes && anrTypes !== '-' ? `; types: ${anrTypes}` : '';
    const spanEn = hasAnr && anrSpanSeconds > 0 ? ` over about ${anrSpanSeconds} seconds` : '';
    const statement = localize(
      outputLanguage,
      hasAnr
        ? `当前 trace 的 android_anrs 记录了 ${totalAnrCount} 个系统 ANR 事件，影响 ${affectedProcessCount} 个进程${spanZh}${typeZh}。`
        : '当前 trace 的 android_anrs 未记录到系统 ANR 事件；这表示当前 trace 可解析的 ANR 数据中没有 ANR 记录，不等同于证明采集范围之外从未发生 ANR。',
      hasAnr
        ? `The current trace records ${totalAnrCount} system ANR events in android_anrs, affecting ${affectedProcessCount} processes${spanEn}${typeEn}.`
        : 'The current trace records no system ANR events in android_anrs; this means the ANR data parsable from this trace has no ANR records, not proof that no ANR happened outside the captured scope.',
    );
    const references = [
      directClaimReference({ envelope, column: 'total_anr_count', value: totalAnrCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasAnr
        ? [
          directClaimReference({ envelope, column: 'affected_process_count', value: affectedProcessCount }),
          ...(anrSpanSeconds > 0
            ? [directClaimReference({ envelope, column: 'anr_span_seconds', value: anrSpanSeconds })]
            : []),
          ...(anrTypes && anrTypes !== '-'
            ? [directClaimReference({ envelope, column: 'anr_types', value: anrTypes })]
            : []),
        ]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`total_anr_count\`; value=\`${totalAnrCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasAnr
            ? [
              `column=\`affected_process_count\`; value=\`${affectedProcessCount}\``,
              ...(anrSpanSeconds > 0
                ? [`column=\`anr_span_seconds\`; value=\`${anrSpanSeconds}\``]
                : []),
              ...(anrTypes && anrTypes !== '-'
                ? [`column=\`anr_types\`; value=\`${anrTypes}\``]
                : []),
            ]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasAnr
          ? `${sourceRef}: total_anr_count=${totalAnrCount}, affected_process_count=${affectedProcessCount}, anr_span_seconds=${anrSpanSeconds}, anr_types=${anrTypes}, source_table=${sourceTable}`
          : `${sourceRef}: total_anr_count=${totalAnrCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'startup_presence') {
    const startupCount = numericValue(rowValue(row, index, 'startup_count'));
    if (startupCount === undefined || startupCount < 0) return undefined;
    const packages = cellText(rowValue(row, index, 'packages'));
    const startupTypes = cellText(rowValue(row, index, 'startup_types'));
    const totalStartupMs = numericValue(rowValue(row, index, 'total_startup_ms')) ?? 0;
    const maxStartupMs = numericValue(rowValue(row, index, 'max_startup_ms')) ?? 0;
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasStartups = startupCount > 0;
    const packageZh = hasStartups && packages && packages !== '-' ? `，涉及包名：${packages}` : '';
    const typeZh = hasStartups && startupTypes && startupTypes !== '-' ? `，类型：${startupTypes}` : '';
    const durationZh = hasStartups
      ? `；累计启动耗时约 ${totalStartupMs} ms，单次最长约 ${maxStartupMs} ms`
      : '';
    const packageEn = hasStartups && packages && packages !== '-' ? `, packages: ${packages}` : '';
    const typeEn = hasStartups && startupTypes && startupTypes !== '-' ? `, types: ${startupTypes}` : '';
    const durationEn = hasStartups
      ? `; total startup duration is about ${totalStartupMs} ms, max single startup about ${maxStartupMs} ms`
      : '';
    const statement = localize(
      outputLanguage,
      hasStartups
        ? `当前 trace 的 android_startups 记录了 ${startupCount} 个 duration > 0 的 App 启动事件${packageZh}${typeZh}${durationZh}。`
        : '当前 trace 的 android_startups 未记录到 duration > 0 的 App 启动事件；这表示当前 trace 可解析的启动数据中没有完整启动记录，不等同于证明采集范围之外没有发生启动。',
      hasStartups
        ? `The current trace records ${startupCount} App startup events with duration > 0 in android_startups${packageEn}${typeEn}${durationEn}.`
        : 'The current trace records no App startup events with duration > 0 in android_startups; this means the startup data parsable from this trace has no complete startup records, not proof that no startup happened outside the captured scope.',
    );
    const references = [
      directClaimReference({ envelope, column: 'startup_count', value: startupCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasStartups
        ? [
          ...(packages && packages !== '-'
            ? [directClaimReference({ envelope, column: 'packages', value: packages })]
            : []),
          ...(startupTypes && startupTypes !== '-'
            ? [directClaimReference({ envelope, column: 'startup_types', value: startupTypes })]
            : []),
          directClaimReference({ envelope, column: 'total_startup_ms', value: totalStartupMs }),
          directClaimReference({ envelope, column: 'max_startup_ms', value: maxStartupMs }),
        ]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`startup_count\`; value=\`${startupCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasStartups
            ? [
              ...(packages && packages !== '-'
                ? [`column=\`packages\`; value=\`${packages}\``]
                : []),
              ...(startupTypes && startupTypes !== '-'
                ? [`column=\`startup_types\`; value=\`${startupTypes}\``]
                : []),
              `column=\`total_startup_ms\`; value=\`${totalStartupMs}\``,
              `column=\`max_startup_ms\`; value=\`${maxStartupMs}\``,
            ]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasStartups
          ? `${sourceRef}: startup_count=${startupCount}, packages=${packages}, startup_types=${startupTypes}, total_startup_ms=${totalStartupMs}, max_startup_ms=${maxStartupMs}, source_table=${sourceTable}`
          : `${sourceRef}: startup_count=${startupCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'scroll_gesture_count') {
    const scrollGestureCount = numericValue(rowValue(row, index, 'scroll_gesture_count'));
    if (scrollGestureCount === undefined || scrollGestureCount < 0) return undefined;
    const scrollStartCount = numericValue(rowValue(row, index, 'scroll_start_count')) ?? 0;
    const maxMoveCount = numericValue(rowValue(row, index, 'max_move_count')) ?? 0;
    const processNames = cellText(rowValue(row, index, 'process_names'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const heuristic = cellText(rowValue(row, index, 'heuristic'));
    const hasScrollGestures = scrollGestureCount > 0;
    const processZh = hasScrollGestures && processNames && processNames !== '-'
      ? `，涉及进程：${processNames}`
      : '';
    const processEn = hasScrollGestures && processNames && processNames !== '-'
      ? `, processes: ${processNames}`
      : '';
    const maxMoveZh = hasScrollGestures && maxMoveCount > 0
      ? `，单次最多 ${maxMoveCount} 个 MOVE 事件`
      : '';
    const maxMoveEn = hasScrollGestures && maxMoveCount > 0
      ? `, max ${maxMoveCount} MOVE events in one gesture`
      : '';
    const statement = localize(
      outputLanguage,
      hasScrollGestures
        ? `当前 trace 按 scene_reconstruction 用户手势规则（MOTION 手势 move_count >= 3）从 android_input_events 识别到 ${scrollGestureCount} 次滑动手势；按第 2 个 MOVE 判定的滑动启动为 ${scrollStartCount} 次${maxMoveZh}${processZh}。`
        : '当前 trace 的 android_input_events 中未识别到满足 move_count >= 3 的滑动手势；这表示当前 trace 可解析输入事件里没有符合该规则的滑动，不等同于证明采集范围之外没有滑动。',
      hasScrollGestures
        ? `The current trace identifies ${scrollGestureCount} scroll gestures from android_input_events using the scene_reconstruction user-gesture rule (MOTION gesture move_count >= 3); the second-MOVE scroll-start count is ${scrollStartCount}${maxMoveEn}${processEn}.`
        : 'The current trace identifies no scroll gestures with move_count >= 3 in android_input_events; this means the parsable input events in this trace have no scrolls matching that rule, not proof that no scroll happened outside the captured scope.',
    );
    const references = [
      directClaimReference({ envelope, column: 'scroll_gesture_count', value: scrollGestureCount }),
      directClaimReference({ envelope, column: 'scroll_start_count', value: scrollStartCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      directClaimReference({ envelope, column: 'heuristic', value: heuristic }),
      ...(hasScrollGestures && maxMoveCount > 0
        ? [directClaimReference({ envelope, column: 'max_move_count', value: maxMoveCount })]
        : []),
      ...(hasScrollGestures && processNames && processNames !== '-'
        ? [directClaimReference({ envelope, column: 'process_names', value: processNames })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`scroll_gesture_count\`; value=\`${scrollGestureCount}\``,
          `column=\`scroll_start_count\`; value=\`${scrollStartCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          `column=\`heuristic\`; value=\`${heuristic}\``,
          ...(hasScrollGestures && maxMoveCount > 0
            ? [`column=\`max_move_count\`; value=\`${maxMoveCount}\``]
            : []),
          ...(hasScrollGestures && processNames && processNames !== '-'
            ? [`column=\`process_names\`; value=\`${processNames}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasScrollGestures
          ? `${sourceRef}: scroll_gesture_count=${scrollGestureCount}, scroll_start_count=${scrollStartCount}, max_move_count=${maxMoveCount}, process_names=${processNames}, source_table=${sourceTable}, heuristic=${heuristic}`
          : `${sourceRef}: scroll_gesture_count=${scrollGestureCount}, scroll_start_count=${scrollStartCount}, source_table=${sourceTable}, heuristic=${heuristic}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'input_event_count') {
    const inputEventCount = numericValue(rowValue(row, index, 'input_event_count'));
    if (inputEventCount === undefined || inputEventCount < 0) return undefined;
    const motionEventCount = numericValue(rowValue(row, index, 'motion_event_count')) ?? 0;
    const keyEventCount = numericValue(rowValue(row, index, 'key_event_count')) ?? 0;
    const processCount = numericValue(rowValue(row, index, 'process_count')) ?? 0;
    const processNames = cellText(rowValue(row, index, 'process_names'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const hasInputEvents = inputEventCount > 0;
    const processZh = hasInputEvents && processNames && processNames !== '-'
      ? `，覆盖 ${processCount} 个进程：${processNames}`
      : '';
    const processEn = hasInputEvents && processNames && processNames !== '-'
      ? ` across ${processCount} processes: ${processNames}`
      : '';
    const statement = localize(
      outputLanguage,
      hasInputEvents
        ? `当前 trace 的 android_input_events 记录了 ${inputEventCount} 个可解析输入事件，其中 MOTION ${motionEventCount} 个、KEY ${keyEventCount} 个${processZh}。`
        : '当前 trace 的 android_input_events 未记录到可解析输入事件；这表示当前 trace 可解析输入事件表为空，不等同于证明采集范围之外没有输入。',
      hasInputEvents
        ? `The current trace records ${inputEventCount} parsable input events in android_input_events: ${motionEventCount} MOTION and ${keyEventCount} KEY events${processEn}.`
        : 'The current trace records no parsable input events in android_input_events; this means the parsable input-event table is empty, not proof that no input happened outside the captured scope.',
    );
    const references = [
      directClaimReference({ envelope, column: 'input_event_count', value: inputEventCount }),
      directClaimReference({ envelope, column: 'motion_event_count', value: motionEventCount }),
      directClaimReference({ envelope, column: 'key_event_count', value: keyEventCount }),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
      ...(hasInputEvents && processCount > 0
        ? [directClaimReference({ envelope, column: 'process_count', value: processCount })]
        : []),
      ...(hasInputEvents && processNames && processNames !== '-'
        ? [directClaimReference({ envelope, column: 'process_names', value: processNames })]
        : []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`input_event_count\`; value=\`${inputEventCount}\``,
          `column=\`motion_event_count\`; value=\`${motionEventCount}\``,
          `column=\`key_event_count\`; value=\`${keyEventCount}\``,
          `column=\`source_table\`; value=\`${sourceTable}\``,
          ...(hasInputEvents && processCount > 0
            ? [`column=\`process_count\`; value=\`${processCount}\``]
            : []),
          ...(hasInputEvents && processNames && processNames !== '-'
            ? [`column=\`process_names\`; value=\`${processNames}\``]
            : []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: hasInputEvents
          ? `${sourceRef}: input_event_count=${inputEventCount}, motion_event_count=${motionEventCount}, key_event_count=${keyEventCount}, process_count=${processCount}, process_names=${processNames}, source_table=${sourceTable}`
          : `${sourceRef}: input_event_count=${inputEventCount}, motion_event_count=${motionEventCount}, key_event_count=${keyEventCount}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'device_info') {
    const fields = [
      {
        column: 'android_device_manufacturer',
        labelZh: '设备制造商',
        labelEn: 'device manufacturer',
      },
      {
        column: 'android_sdk_version',
        labelZh: 'Android SDK',
        labelEn: 'Android SDK',
      },
      {
        column: 'android_soc_model',
        labelZh: 'SoC',
        labelEn: 'SoC',
      },
      {
        column: 'system_name',
        labelZh: '系统',
        labelEn: 'system',
      },
      {
        column: 'system_release',
        labelZh: '内核版本',
        labelEn: 'kernel release',
      },
      {
        column: 'system_machine',
        labelZh: '架构',
        labelEn: 'architecture',
      },
      {
        column: 'android_build_fingerprint',
        labelZh: 'build fingerprint',
        labelEn: 'build fingerprint',
      },
    ];

    const presentFields = fields.flatMap(field => {
      const rawValue = rowValue(row, index, field.column);
      if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return [];
      const value = field.column === 'android_sdk_version'
        ? (numericValue(rawValue) ?? cellText(rawValue))
        : cellText(rawValue);
      return [{
        ...field,
        value,
        displayValue: cellText(value),
      }];
    });
    if (presentFields.length === 0) return undefined;

    const zhFacts = presentFields.map(field => `${field.labelZh}为 ${field.displayValue}`).join('，');
    const enFacts = presentFields.map(field => `${field.labelEn} is ${field.displayValue}`).join(', ');
    const statement = localize(
      outputLanguage,
      `当前 trace metadata 记录：${zhFacts}。`,
      `The current trace metadata records: ${enFacts}.`,
    );
    const references = presentFields.map(field => directClaimReference({
      envelope,
      column: field.column,
      value: field.value,
    }));

    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: presentFields.map(field => `column=\`${field.column}\`; value=\`${field.displayValue}\``),
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: ${presentFields
          .map(field => `${field.column}=${field.displayValue}`)
          .join(', ')}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'frame_metrics') {
    const packageName = rowValue(row, index, 'package_name');
    const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
    const durationS = numericValue(rowValue(row, index, 'duration_s'));
    const fps = numericValue(rowValue(row, index, 'fps'));
    if (
      typeof packageName !== 'string'
      || !totalFrames
      || totalFrames <= 0
      || !durationS
      || durationS <= 0
      || !fps
      || fps <= 0
    ) {
      return undefined;
    }
    const scopedRange = scopedRangeReferenceInfo({ envelope, row, index });
    const subjectZh = scopedRange ? `选区内焦点应用 ${packageName}` : `焦点应用 ${packageName}`;
    const subjectEn = scopedRange ? `The focus app ${packageName} in the current selection` : `The focus app ${packageName}`;
    const statement = localize(
      outputLanguage,
      `${subjectZh} 的窗口内总帧数为 ${totalFrames}，时长约 ${durationS} 秒，帧率约 ${fps} FPS。`,
      `${subjectEn} has ${totalFrames} frames over about ${durationS} seconds, or about ${fps} FPS.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'package_name', value: packageName }),
      directClaimReference({ envelope, column: 'total_frames', value: totalFrames }),
      directClaimReference({ envelope, column: 'duration_s', value: durationS }),
      directClaimReference({ envelope, column: 'fps', value: fps }),
      ...(scopedRange?.references ?? []),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`package_name\`; value=\`${packageName}\``,
          `column=\`total_frames\`; value=\`${totalFrames}\``,
          `column=\`duration_s\`; value=\`${durationS}\``,
          `column=\`fps\`; value=\`${fps}\``,
          ...(scopedRange?.rows ?? []),
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: `${sourceRef}: package_name=${packageName}, total_frames=${totalFrames}, duration_s=${durationS}, fps=${fps}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  if (evidence.evidenceKind === 'trace_frame_count') {
    const scope = cellText(rowValue(row, index, 'scope'));
    const totalFrames = numericValue(rowValue(row, index, 'total_frames'));
    if (!totalFrames || totalFrames <= 0) return undefined;
    const durationS = numericValue(rowValue(row, index, 'duration_s'));
    const sourceTable = cellText(rowValue(row, index, 'source_table'));
    const scopedRange = scopedRangeReferenceInfo({ envelope, row, index });
    const durationZh = durationS && durationS > 0 ? `，窗口时长约 ${durationS} 秒` : '';
    const durationEn = durationS && durationS > 0 ? ` over about ${durationS} seconds` : '';
    const statement = localize(
      outputLanguage,
      scopedRange
        ? `当前选区的 FrameTimeline 中共有 ${totalFrames} 帧${durationZh}。这是选区内的 trace-wide FrameTimeline 统计，不等同于特定应用或进程的归因结论。`
        : `当前 trace 的 FrameTimeline 中共有 ${totalFrames} 帧${durationZh}。这是 trace 全局 FrameTimeline 统计，不等同于特定应用或进程的归因结论。`,
      scopedRange
        ? `The current selection has ${totalFrames} FrameTimeline frames${durationEn}. This is a selected-range trace-wide FrameTimeline count, not attribution to a specific app or process.`
        : `The current trace has ${totalFrames} FrameTimeline frames${durationEn}. This is a trace-wide FrameTimeline count, not attribution to a specific app or process.`,
    );
    const references = [
      directClaimReference({ envelope, column: 'scope', value: scope }),
      directClaimReference({ envelope, column: 'total_frames', value: totalFrames }),
      ...(durationS && durationS > 0
        ? [directClaimReference({ envelope, column: 'duration_s', value: durationS })]
        : []),
      ...(scopedRange?.references ?? []),
      directClaimReference({ envelope, column: 'source_table', value: sourceTable }),
    ];
    return {
      conclusion: buildDirectConclusion({
        statement,
        evidenceRefId,
        sourceRef,
        outputLanguage,
        rows: [
          `column=\`scope\`; value=\`${scope}\``,
          `column=\`total_frames\`; value=\`${totalFrames}\``,
          ...(durationS && durationS > 0
            ? [`column=\`duration_s\`; value=\`${durationS}\``]
            : []),
          ...(scopedRange?.rows ?? []),
          `column=\`source_table\`; value=\`${sourceTable}\``,
        ],
      }),
      conclusionContract: buildDirectConclusionContract({
        statement,
        evidenceText: durationS && durationS > 0
          ? `${sourceRef}: scope=${scope}, total_frames=${totalFrames}, duration_s=${durationS}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}, source_table=${sourceTable}`
          : `${sourceRef}: scope=${scope}, total_frames=${totalFrames}${scopedRange ? `, ${scopedRange.evidenceText}` : ''}, source_table=${sourceTable}`,
        references,
        kind: evidence.evidenceKind,
      }),
      confidence: 1,
    };
  }

  return undefined;
}
