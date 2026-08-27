// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared "normalize an AnalysisResult before it reaches the user" helpers.
 *
 * Both delivery paths (HTTP SSE and CLI HTML report) need to:
 *   1. Run the conclusion text through `normalizeConclusionOutput` when the
 *      heuristic says to (see `shouldNormalizeConclusionOutput`).
 *   2. If the orchestrator didn't populate `conclusionContract`, derive one
 *      from the normalized-but-unsanitized conclusion so machine-readable
 *      evidence refs survive display cleanup.
 *   3. Sanitize user-facing narrative text (strip internal evidence IDs,
 *      replace legacy phrases).
 *
 * HTTP route used to inline all of this in `sendAgentDrivenResult`. CLI's
 * `buildReportHtml` skipped the step entirely, so the CLI-produced HTML
 * diverged from the web UI for the same session. Centralize the logic
 * here so `buildAgentDrivenReportData` receives an already-normalized
 * result regardless of the delivery path.
 */

import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { buildEvidenceContract } from './evidence/evidenceContractBuilder';
import { hasDeliverableFinalReportHeading } from './finalResultQualityGate';
import { sanitizeNarrativeForClient } from '../routes/narrativeSanitizer';
import type { AnalysisResult } from '../agent/core/orchestratorTypes';
import type {
  ConclusionClaimKind,
  ConclusionContract,
  ConclusionContractClaimItem,
  ConclusionContractClaimReference,
  ConclusionOutputMode,
} from '../agent/core/conclusionContract';
import type { DataEnvelope, DataPayload } from '../types/dataContract';
import {
  sanitizeConclusionSourceContract,
  verifySourceClaimBindingsForResult,
} from './codebase/sourceClaimVerifier';

interface ConclusionContractDeriveOptions {
  mode?: ConclusionOutputMode;
  singleFrameDrillDown?: boolean;
  sceneId?: string;
}

interface EvidenceBackedConclusionContractDeriveOptions extends ConclusionContractDeriveOptions {
  existingContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
}

interface NarrativeCellCandidate {
  claimText: string;
  kind: ConclusionClaimKind;
  score: number;
  evidenceText: string;
  references: ConclusionContractClaimReference[];
}

const NARRATIVE_FALLBACK_MAX_CLAIMS = 12;
const NARRATIVE_FALLBACK_MAX_REFS_PER_ROW = 4;
const NARRATIVE_FALLBACK_LABEL_COLUMNS = [
  'slice_name',
  'name',
  'reason_id',
  'reason',
  'startup_type',
  'type_display',
  'package',
  'process_name',
  'thread_name',
  'core_type',
  'pressure_level',
  'assessment',
  'severity',
  'summary',
  'title',
];
const NARRATIVE_FALLBACK_USEFUL_COLUMN_RE =
  /(?:dur|ttid|ttfd|self|total|running|runnable|sleep|blocked|q[1-4][ab]?|pct|percent|freq|mhz|ms|level|severity|type|reason|slice|task|package|process|thread|core|pressure|score|count|binder|gc|jit|inflate|startup)/i;
const NARRATIVE_FALLBACK_NOISY_COLUMN_RE =
  /^(?:ts|start_ts|end_ts|id|startup_id|upid|utid|pid|tid|track_id|slice_id|arg_set_id)$/i;
const NARRATIVE_FALLBACK_IDENTITY_ID_COLUMN_RE =
  /^(?:upid|utid|pid|tid)$/i;

/**
 * Normalize a conclusion string for contract parsing without user-facing
 * sanitization. This keeps evidence/source ids available for
 * `deriveConclusionContract`; display sanitization may intentionally remove
 * those ids later.
 */
export function normalizeNarrativeForContract(narrative: string): string {
  const raw = String(narrative || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (
    !hasDeliverableFinalReportHeading(trimmed) &&
    shouldNormalizeConclusionOutput(trimmed)
  ) {
    try {
      return normalizeConclusionOutput(trimmed).trim() || raw;
    } catch {
      return raw;
    }
  }

  return raw;
}

/**
 * Derive a conclusion contract before display sanitization can remove internal
 * evidence ids from machine-readable references.
 */
export function deriveConclusionContractForNarrative(
  narrative: string,
  options: ConclusionContractDeriveOptions = {},
): ConclusionContract | undefined {
  const contractSource = normalizeNarrativeForContract(narrative);
  return (
    deriveConclusionContract(contractSource, options) ||
    deriveConclusionContract(normalizeNarrativeForClient(narrative), options) ||
    undefined
  );
}

function hasStructuredClaims(
  contract: ConclusionContract | null | undefined,
): contract is ConclusionContract & { claims: ConclusionContractClaimItem[] } {
  return Array.isArray(contract?.claims) && contract.claims.length > 0;
}

function rowsAsObjects(envelope: DataEnvelope): Record<string, unknown>[] {
  const data = envelope.data as DataPayload | undefined;
  if (!data || !Array.isArray(data.rows)) return [];
  const columns = Array.isArray(data.columns)
    ? data.columns.map(col => String(col))
    : [];
  return data.rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    const record: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      columns.forEach((col, index) => {
        record[col] = row[index];
      });
    }
    return record;
  });
}

function normalizeForNarrativeMatch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[`*_~#[\](){}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripInlineMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPrimitiveClaimValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 180;
}

function coerceClaimValue(value: string | number | boolean): string | number | boolean {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function numericValueVariants(value: number): string[] {
  const variants = new Set<string>([String(value)]);
  if (Number.isInteger(value)) {
    variants.add(String(Math.round(value)));
  } else {
    variants.add(value.toFixed(1).replace(/\.0$/, ''));
    variants.add(value.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
    variants.add(String(Math.round(value)));
  }
  return Array.from(variants).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numericVariantAppearsInNarrative(variant: string, normalizedNarrative: string): boolean {
  const normalizedVariant = normalizeForNarrativeMatch(variant);
  if (!normalizedVariant) return false;
  const pattern = new RegExp(
    `(^|[^0-9A-Za-z_.+-])${escapeRegExp(normalizedVariant)}(?:\\s*(?:ns|us|µs|ms|s|fps|hz|mhz|ghz|b|kb|mb|gb|%))?(?=$|[^0-9A-Za-z_.])`,
    'i',
  );
  return pattern.test(normalizedNarrative);
}

function primitiveValueAppearsInNarrative(value: string | number | boolean, normalizedNarrative: string): boolean {
  if (typeof value === 'number') {
    return numericValueVariants(value).some(variant =>
      numericVariantAppearsInNarrative(variant, normalizedNarrative),
    );
  }
  const normalized = normalizeForNarrativeMatch(value);
  if (!normalized) return false;
  if (typeof value === 'boolean') return normalizedNarrative.includes(normalized);
  return normalized.length >= 2 && normalizedNarrative.includes(normalized);
}

function rowLabelMatchesNarrative(row: Record<string, unknown>, normalizedNarrative: string): boolean {
  return NARRATIVE_FALLBACK_LABEL_COLUMNS.some(column => {
    const value = row[column];
    if (!isPrimitiveClaimValue(value)) return false;
    return primitiveValueAppearsInNarrative(value, normalizedNarrative);
  });
}

function envelopeTitleMatchesNarrative(envelope: DataEnvelope, normalizedNarrative: string): boolean {
  const candidates = [
    envelope.display?.title,
    envelope.meta?.source,
    envelope.meta?.skillId,
    envelope.meta?.stepId,
    envelope.meta?.planPhaseTitle,
  ];
  return candidates.some(candidate => {
    const normalized = normalizeForNarrativeMatch(candidate);
    return normalized.length >= 2 && normalizedNarrative.includes(normalized);
  });
}

function evidenceIdentifierForEnvelope(envelope: DataEnvelope): string | undefined {
  const meta = envelope.meta as unknown as Record<string, unknown> | undefined;
  const candidates = [
    meta?.evidenceRefId,
    meta?.artifactId,
    meta?.sourceArtifactId,
    meta?.sourceToolCallId,
    envelope.display?.title,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  return undefined;
}

function sourceRefForEnvelope(envelope: DataEnvelope): string | undefined {
  return String(envelope.display?.title || envelope.meta?.stepId || envelope.meta?.source || '').trim() || undefined;
}

function cellScore(input: {
  column: string;
  value: string | number | boolean;
  rowMatches: boolean;
  envelopeMatches: boolean;
  normalizedNarrative: string;
}): number {
  const normalizedColumn = normalizeForNarrativeMatch(input.column);
  const columnAppears = normalizedColumn.length >= 2 && input.normalizedNarrative.includes(normalizedColumn);
  const valueAppears = primitiveValueAppearsInNarrative(input.value, input.normalizedNarrative);
  let score = 0;
  if (valueAppears) score += 8;
  if (columnAppears) score += 4;
  if (input.rowMatches) score += 4;
  if (input.envelopeMatches) score += 2;
  if (typeof input.value === 'number') score += 2;
  if (NARRATIVE_FALLBACK_USEFUL_COLUMN_RE.test(input.column)) score += 2;
  if (NARRATIVE_FALLBACK_NOISY_COLUMN_RE.test(input.column)) score -= 4;
  return score;
}

function columnAppearsInNarrative(column: string, normalizedNarrative: string): boolean {
  const normalizedColumn = normalizeForNarrativeMatch(column);
  return normalizedColumn.length >= 2 && normalizedNarrative.includes(normalizedColumn);
}

function shouldSkipNarrativeFallbackColumn(input: {
  column: string;
  value: string | number | boolean;
  normalizedNarrative: string;
}): boolean {
  if (!NARRATIVE_FALLBACK_NOISY_COLUMN_RE.test(input.column)) return false;
  if (!NARRATIVE_FALLBACK_IDENTITY_ID_COLUMN_RE.test(input.column)) return true;
  return !(
    primitiveValueAppearsInNarrative(input.value, input.normalizedNarrative) &&
    columnAppearsInNarrative(input.column, input.normalizedNarrative)
  );
}

function buildNarrativeEvidenceCandidates(
  narrative: string,
  envelopes: DataEnvelope[] | undefined,
): NarrativeCellCandidate[] {
  const normalizedNarrative = normalizeForNarrativeMatch(narrative);
  if (!normalizedNarrative || !Array.isArray(envelopes) || envelopes.length === 0) return [];

  const candidates: NarrativeCellCandidate[] = [];
  envelopes.forEach((envelope) => {
    if (envelope.display?.level === 'hidden' || envelope.display?.level === 'debug') return;
    const evidenceRefId = evidenceIdentifierForEnvelope(envelope);
    if (!evidenceRefId) return;
    const sourceRef = sourceRefForEnvelope(envelope);
    const rows = rowsAsObjects(envelope);
    if (rows.length === 0) return;
    const envelopeMatches = envelopeTitleMatchesNarrative(envelope, normalizedNarrative);
    const meta = envelope.meta as unknown as Record<string, unknown> | undefined;
    const artifactId = typeof meta?.artifactId === 'string' ? meta.artifactId : undefined;
    const sourceArtifactId = typeof meta?.sourceArtifactId === 'string' ? meta.sourceArtifactId : undefined;
    const sourceToolCallId = typeof meta?.sourceToolCallId === 'string' ? meta.sourceToolCallId : undefined;

    rows.slice(0, 30).forEach((row, rowIndex) => {
      const rowMatches = rowLabelMatchesNarrative(row, normalizedNarrative);
      const scoredCells = Object.entries(row)
        .flatMap(([column, value]) => {
          if (!isPrimitiveClaimValue(value)) return [];
          if (shouldSkipNarrativeFallbackColumn({ column, value, normalizedNarrative })) return [];
          const valueAppears = primitiveValueAppearsInNarrative(value, normalizedNarrative);
          if (typeof value === 'number' && !valueAppears) return [];
          const useful = NARRATIVE_FALLBACK_USEFUL_COLUMN_RE.test(column) ||
            rowMatches ||
            envelopeMatches ||
            valueAppears;
          if (!useful) return [];
          return [{
            column,
            value: coerceClaimValue(value),
            score: cellScore({
              column,
              value,
              rowMatches,
              envelopeMatches,
              normalizedNarrative,
            }),
          }];
        })
        .filter(cell => cell.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, NARRATIVE_FALLBACK_MAX_REFS_PER_ROW);

      if (scoredCells.length === 0) return;
      const references: ConclusionContractClaimReference[] = scoredCells.map(cell => ({
        evidenceRefId,
        ...(sourceRef ? { sourceRef } : {}),
        ...(sourceToolCallId ? { sourceToolCallId } : {}),
        ...(artifactId ? { artifactId } : {}),
        ...(sourceArtifactId ? { sourceArtifactId } : {}),
        rowIndex,
        column: cell.column,
        value: cell.value,
      }));
      const kind: ConclusionClaimKind = scoredCells.some(cell => typeof cell.value === 'number')
        ? 'numeric'
        : 'categorical';
      const title = stripInlineMarkdown(envelope.display?.title || envelope.meta?.stepId || envelope.meta?.source || 'evidence');
      const claimText = `${title}: ${scoredCells
        .map(cell => `${cell.column}=${String(cell.value)}`)
        .join(', ')}`;
      candidates.push({
        claimText,
        kind,
        score: scoredCells.reduce((sum, cell) => sum + cell.score, 0),
        evidenceText: `${claimText} (${evidenceRefId})`,
        references,
      });
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function extractFirstNarrativeStatement(narrative: string): string {
  const text = String(narrative || '').trim();
  if (!text) return '结论信息缺失（证据不足）';

  const sectionPattern = /(^|\n)#{1,3}\s*(?:综合结论|关键结论|根因分析|概览|1\.\s*概览|Final Conclusion|Overview|Root Cause)\s*\n([\s\S]*?)(?=\n#{1,3}\s+|\n*$)/i;
  const section = text.match(sectionPattern)?.[2] || text;
  const lines = section
    .split(/\r?\n/)
    .map(line => stripInlineMarkdown(line))
    .filter(line =>
      line &&
      !line.startsWith('|') &&
      !/^[-*]\s*$/.test(line) &&
      !/^[-: ]+$/.test(line) &&
      !/^#{1,6}\s+/.test(line),
    );
  const statement = lines.find(line => /[\u4e00-\u9fffA-Za-z0-9]/.test(line)) || stripInlineMarkdown(text);
  return statement.slice(0, 260) || '结论信息缺失（证据不足）';
}

function buildEvidenceBackedFallbackContract(
  narrative: string,
  dataEnvelopes: DataEnvelope[] | undefined,
  options: ConclusionContractDeriveOptions,
): ConclusionContract | undefined {
  const candidates = buildNarrativeEvidenceCandidates(narrative, dataEnvelopes)
    .slice(0, NARRATIVE_FALLBACK_MAX_CLAIMS);
  if (candidates.length === 0) return undefined;

  const claims: ConclusionContractClaimItem[] = candidates.map((candidate, index) => ({
    id: `Q${index + 1}`,
    conclusionId: 'C1',
    text: candidate.claimText,
    kind: candidate.kind,
    references: candidate.references,
  }));

  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: options.mode || 'initial_report',
    conclusions: [{
      rank: 1,
      statement: extractFirstNarrativeStatement(narrative),
      confidencePercent: 70,
    }],
    clusters: [],
    evidenceChain: candidates.slice(0, 8).map(candidate => ({
      conclusionId: 'C1',
      text: candidate.evidenceText,
    })),
    claims,
    uncertainties: [],
    nextSteps: [],
    metadata: {
      ...(options.sceneId ? { sceneId: options.sceneId } : {}),
      derivedFromNarrativeEvidenceMatch: true,
      claimDerivation: 'narrative_evidence_match',
      claimVerificationScope: 'sampled_narrative_evidence',
    },
  };
}

function hasFullyEvidenceResolvableStructuredClaims(
  contract: ConclusionContract | undefined,
  dataEnvelopes: DataEnvelope[] | undefined,
): boolean {
  if (!hasStructuredClaims(contract)) return false;
  if (!Array.isArray(dataEnvelopes) || dataEnvelopes.length === 0) return true;
  const evidenceContract = buildEvidenceContract({
    conclusionContract: contract,
    dataEnvelopes,
  });
  const support = evidenceContract.claimSupport || [];
  if (support.length === 0) return false;
  return support.length >= contract.claims.length &&
    support.every(claim =>
      claim.supportLevel === 'verified' &&
      claim.anchors.every(anchor => !anchor.missing) &&
      claim.anchors.some(anchor =>
        (anchor.cells || []).some(cell =>
          cell.value !== undefined &&
          (cell.actualValue !== undefined || cell.displayValue !== undefined),
        ),
      ),
    );
}

/**
 * Derive a conclusion contract and guarantee row-level claim refs when the
 * provider returned a rich human report instead of the requested JSON contract.
 * The fallback uses captured DataEnvelope cells as the expected verifier values,
 * so `claimVerifierStatus=not_checked` does not masquerade as a valid result.
 */
export function deriveEvidenceBackedConclusionContractForNarrative(
  narrative: string,
  dataEnvelopes: DataEnvelope[] | undefined,
  options: EvidenceBackedConclusionContractDeriveOptions = {},
): ConclusionContract | undefined {
  const parsed =
    options.existingContract ||
    deriveConclusionContractForNarrative(narrative, options);

  const fallback = buildEvidenceBackedFallbackContract(narrative, dataEnvelopes, options);
  if (hasStructuredClaims(parsed)) {
    if (!fallback || hasFullyEvidenceResolvableStructuredClaims(parsed, dataEnvelopes)) {
      return parsed;
    }
    return {
      ...parsed,
      claims: fallback.claims,
      evidenceChain: fallback.evidenceChain,
      metadata: {
        ...(parsed.metadata || {}),
        ...(fallback.metadata || {}),
        replacedUnresolvableProviderClaims: true,
      },
    };
  }

  if (!fallback) return parsed || undefined;
  if (!parsed) return fallback;

  return {
    ...parsed,
    claims: fallback.claims,
    evidenceChain: fallback.evidenceChain,
    metadata: {
      ...(parsed.metadata || {}),
      ...(fallback.metadata || {}),
    },
  };
}

/**
 * Normalize a conclusion string for end-user display. Safe to call on any
 * input; falls back to the original text when normalization would empty it.
 */
export function normalizeNarrativeForClient(narrative: string): string {
  const normalized = normalizeNarrativeForContract(narrative);
  return sanitizeNarrativeForClient(normalized) || normalized;
}

/**
 * Normalize an AnalysisResult's conclusion + re-derive its conclusionContract
 * (if missing) using the same rounds-based mode heuristic the HTTP path uses.
 * Returns the input unchanged when no fields would actually change, so the
 * identity check in callers (`result === normalized`) stays cheap.
 */
export function normalizeResultForReport(
  result: AnalysisResult,
  options: EvidenceBackedConclusionContractDeriveOptions = {},
): AnalysisResult {
  const normalizedConclusion = normalizeNarrativeForClient(result.conclusion);
  const derivedContract =
    deriveEvidenceBackedConclusionContractForNarrative(result.conclusion, options.dataEnvelopes, {
      existingContract: result.conclusionContract,
      mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
      ...options,
    }) || undefined;
  let normalizedContract = derivedContract
    ? sanitizeConclusionSourceContract(derivedContract, {
        actualSourceUseDecision: result.sourceUseDecision ?? null,
      })
    : undefined;
  let sourceClaimVerificationResult = result.sourceClaimVerificationResult;
  if (normalizedContract) {
    const resultWithNormalizedContract = {
      ...result,
      conclusionContract: normalizedContract,
    };
    const verification = verifySourceClaimBindingsForResult(resultWithNormalizedContract);
    if (verification) {
      sourceClaimVerificationResult = verification;
      normalizedContract = {
        ...normalizedContract,
        sourceClaimBindings: verification.bindings,
      };
    }
  }

  if (
    normalizedConclusion === result.conclusion &&
    normalizedContract === result.conclusionContract &&
    sourceClaimVerificationResult === result.sourceClaimVerificationResult
  ) {
    return result;
  }
  return {
    ...result,
    conclusion: normalizedConclusion,
    conclusionContract: normalizedContract,
    ...(sourceClaimVerificationResult ? {sourceClaimVerificationResult} : {}),
  };
}
