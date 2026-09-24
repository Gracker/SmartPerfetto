// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { FocusAppDetectionResult } from '../agentv3/focusAppDetector';
import { resolveFocusAppTarget } from './focusAppTarget';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import {
  getSkillsDir,
  SkillRegistry,
} from '../services/skillEngine/skillLoader';
import type { SkillDefinition, SkillExecutionResult } from '../services/skillEngine/types';
import type { DataEnvelope, DataEnvelopeTraceSide } from '../types/dataContract';
import {
  cellText,
  columnIndex,
  findFirstTableEnvelope,
  numericValue,
  rowValue,
  runtimeSkillSourceToolCallId,
  stableQuickEvidenceHash,
  withQuickEvidenceProvenance,
} from './quickEvidenceTable';

const PROCESS_IDENTITY_SKILL_ID = 'process_identity_resolver';
const PROCESS_IDENTITY_SKILL_PATH = 'atomic/process_identity_resolver.skill.yaml';
const QUICK_PROCESS_IDENTITY_MAX_ROWS = 5;

let cachedProcessIdentitySkill:
  | { skill: SkillDefinition; fragments: Map<string, string> }
  | null
  | undefined;

export interface QuickProcessIdentityEvidencePayload {
  envelopes: DataEnvelope[];
  promptContext?: string;
}

export interface QuickProcessIdentityEvidenceInput {
  skillExecutor: Pick<SkillExecutor, 'execute'>;
  traceId: string;
  focusResult: FocusAppDetectionResult;
  packageName?: string;
  traceSide?: DataEnvelopeTraceSide;
  outputLanguage?: OutputLanguage;
}

export function shouldUseEvidenceOnlyQuickAnalysis(input: {
  skipQuickTracePreflightDetection: boolean;
  processIdentityEvidence?: QuickProcessIdentityEvidencePayload;
}): boolean {
  const evidence = input.processIdentityEvidence;
  return input.skipQuickTracePreflightDetection
    && !!evidence?.promptContext
    && hasVerifiedProcessIdentityEvidence(evidence);
}

function loadProcessIdentitySkill() {
  if (cachedProcessIdentitySkill !== undefined) return cachedProcessIdentitySkill;

  const registry = new SkillRegistry();
  const skill = registry.loadSingleSkill(getSkillsDir(), PROCESS_IDENTITY_SKILL_PATH);
  cachedProcessIdentitySkill = skill
    ? { skill, fragments: new Map(registry.getFragmentCache()) }
    : null;
  return cachedProcessIdentitySkill;
}

export function createQuickProcessIdentitySkillExecutor(
  traceProcessor: ConstructorParameters<typeof SkillExecutor>[0],
): SkillExecutor {
  const executor = new SkillExecutor(traceProcessor);
  const loaded = loadProcessIdentitySkill();
  if (loaded) {
    executor.registerSkill(loaded.skill);
    executor.setFragmentRegistry(new Map(loaded.fragments));
  }
  return executor;
}

function withQuickProcessIdentityProvenance(
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
    skillId: PROCESS_IDENTITY_SKILL_ID,
    traceId: input.traceId,
    traceSide: input.traceSide,
    queryHash: input.queryHash,
    sourceToolCallId: input.sourceToolCallId,
    index: input.index,
    planPhaseGoal: localize(input.outputLanguage, '复用进程身份解析结果回答身份类问题', 'Reuse process identity resolver output for identity questions'),
    toolNarration: localize(input.outputLanguage, '复用进程身份解析结果', 'Reuse process identity resolver output'),
    producerReason: localize(
      input.outputLanguage,
      '快速问答启动阶段已用 process_identity_resolver 确认当前 trace 的进程身份候选。',
      'The quick-answer startup path already resolved process identity candidates with process_identity_resolver.',
    ),
    intent: 'runtime_process_identity_detection',
    outputLanguage: input.outputLanguage,
  });
}

function normalizedText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function hasSafeIdentityWarning(value: unknown): boolean {
  const warning = normalizedText(value);
  return warning === '' || warning === '-' || warning === 'ok';
}

function hasKnownIdentityName(value: unknown): boolean {
  const text = normalizedText(value);
  return text !== '' && text !== '-' && text !== '<unknown>' && text !== 'unknown';
}

export function hasVerifiedProcessIdentityEvidence(
  evidence: QuickProcessIdentityEvidencePayload,
): boolean {
  const envelope = findFirstTableEnvelope(evidence.envelopes);
  if (!envelope?.data.columns || !envelope.data.rows?.length) return false;

  const index = columnIndex(envelope.data.columns);
  const firstRow = envelope.data.rows[0];
  const firstRank = numericValue(rowValue(firstRow, index, 'rank'));
  const firstStatus = normalizedText(rowValue(firstRow, index, 'identity_status'));
  const firstScore = numericValue(rowValue(firstRow, index, 'confidence_score')) ?? 0;
  const hasCanonicalIdentity = hasKnownIdentityName(rowValue(firstRow, index, 'canonical_package_name'))
    && hasKnownIdentityName(rowValue(firstRow, index, 'recommended_process_name_param'));

  if (firstRank !== 1) return false;
  if (firstStatus !== 'confirmed') return false;
  if (firstScore < 80) return false;
  if (!hasCanonicalIdentity) return false;
  if (!hasSafeIdentityWarning(rowValue(firstRow, index, 'identity_warning'))) return false;

  return !envelope.data.rows.slice(1).some(row => {
    const status = normalizedText(rowValue(row, index, 'identity_status'));
    const score = numericValue(rowValue(row, index, 'confidence_score')) ?? 0;
    return status === 'confirmed' && score >= 80;
  });
}

function buildPromptContext(
  envelopes: DataEnvelope[],
  outputLanguage: OutputLanguage,
): string | undefined {
  const tableEnvelope = findFirstTableEnvelope(envelopes);
  if (!tableEnvelope?.data.columns || !tableEnvelope.data.rows?.length) return undefined;

  const columns = tableEnvelope.data.columns;
  const index = columnIndex(columns);
  const preferredColumns = [
    'rank',
    'identity_status',
    'confidence_score',
    'canonical_package_name',
    'recommended_process_name_param',
    'upid',
    'pid',
    'process_name',
    'package_name',
    'identity_warning',
  ].filter(column => index.has(column));
  if (preferredColumns.length === 0) return undefined;

  const header = `| ${preferredColumns.join(' | ')} |`;
  const separator = `| ${preferredColumns.map(() => '---').join(' | ')} |`;
  const rows = tableEnvelope.data.rows
    .slice(0, QUICK_PROCESS_IDENTITY_MAX_ROWS)
    .map(row => `| ${preferredColumns.map(column => cellText(row[index.get(column)!])).join(' | ')} |`);

  const sourceLines = [
    `- evidence_ref_id: \`${tableEnvelope.meta.evidenceRefId}\``,
    `- source_tool_call_id: \`${tableEnvelope.meta.sourceToolCallId}\``,
  ].join('\n');

  return localize(
    outputLanguage,
    `## 当前 Trace 运行时预证据：进程身份候选\n${sourceLines}\n\n${header}\n${separator}\n${rows.join('\n')}`,
    `## Current Trace Runtime Evidence: Process Identity Candidates\n${sourceLines}\n\n${header}\n${separator}\n${rows.join('\n')}`,
  );
}

function hasDisplayRows(result: SkillExecutionResult): boolean {
  return result.displayResults.some(display =>
    Array.isArray(display.data.rows) && display.data.rows.length > 0);
}

export async function buildQuickProcessIdentityEvidence(
  input: QuickProcessIdentityEvidenceInput,
): Promise<QuickProcessIdentityEvidencePayload> {
  // Same effective-package rule as every runtime: an ambiguous detection
  // names no process to resolve.
  const requestedName = resolveFocusAppTarget({
    userPackageName: input.packageName,
    focusResult: input.focusResult,
  }).packageName;
  if (!requestedName) {
    return { envelopes: [] };
  }

  const traceSide = input.traceSide ?? 'current';
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const params = {
    package: requestedName,
    process_name: requestedName,
    max_rows: QUICK_PROCESS_IDENTITY_MAX_ROWS,
  };
  const queryHash = stableQuickEvidenceHash({
    traceId: input.traceId,
    traceSide,
    skillId: PROCESS_IDENTITY_SKILL_ID,
    params,
  });
  const toolCallId = runtimeSkillSourceToolCallId(PROCESS_IDENTITY_SKILL_ID, queryHash);

  try {
    const result = await input.skillExecutor.execute(
      PROCESS_IDENTITY_SKILL_ID,
      input.traceId,
      params,
      { __skipIdentityGate: true },
    );
    if (!result.success || !hasDisplayRows(result)) {
      return { envelopes: [] };
    }

    const envelopes = SkillExecutor.toDataEnvelopes(result, undefined, {
      traceId: input.traceId,
      traceSide,
    }).map((envelope, index) => withQuickProcessIdentityProvenance(envelope, {
      traceId: input.traceId,
      traceSide,
      queryHash,
      sourceToolCallId: toolCallId,
      index,
      outputLanguage,
    }));

    return {
      envelopes,
      promptContext: buildPromptContext(envelopes, outputLanguage),
    };
  } catch (error) {
    console.warn('[QuickProcessIdentityEvidence] process identity pre-evidence failed:', (error as Error).message);
    return { envelopes: [] };
  }
}
