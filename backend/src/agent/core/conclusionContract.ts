// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CaseKnowledgeRecommendation, CaseKnowledgeReportRecommendation} from '../../types/caseKnowledge';
import {sanitizeSourceUseDecision, sanitizeSourceReferences, sanitizeSourceClaimBindings, isSourceClaimBindingsDeclaration,
  MAX_SOURCE_REFERENCE_ID_LENGTH, MAX_SOURCE_REFERENCE_PATH_LENGTH} from '../../services/codebase/sourceUseDecision';
import type {EvidenceRelationCandidateV1} from '../../types/evidenceContract';
import type {
  SourceClaimBindingV1,
  SourceReferenceV1,
  SourceUseDecisionV1,
} from '../../services/codebase/sourceUseDecision';

export type ConclusionOutputMode = 'initial_report' | 'focused_answer' | 'need_input';
export type ConclusionClusterOutputMode = 'required' | 'optional' | 'none';
export type ConclusionClusterFrameListMode = 'none' | 'top' | 'full';
export type ConclusionClaimKind =
  | 'numeric'
  | 'categorical'
  | 'time_range'
  | 'identity'
  | 'causal'
  | 'comparison'
  | 'inference'
  | 'recommendation';
export type ConclusionClaimSupportLevel = 'verified' | 'partial' | 'inference' | 'unsupported';

export interface ConclusionContractConclusionItem {
  rank: number;
  statement: string;
  confidencePercent?: number;
  trigger?: string;
  supply?: string;
  amplification?: string;
}

export interface ConclusionContractClusterItem {
  cluster: string;
  description?: string;
  frames?: number;
  percentage?: number;
  frameRefs?: string[];
  omittedFrameRefs?: number;
}

export interface ConclusionContractClusterPolicy {
  outputMode: ConclusionClusterOutputMode;
  frameListMode: ConclusionClusterFrameListMode;
  maxFramesPerCluster?: number;
}

export interface ConclusionContractEvidenceItem {
  conclusionId: string;
  text: string;
}

export interface ConclusionContractClaimReference {
  evidenceRefId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  value?: string | number | boolean | null;
  sourceRef?: string;
  sourceToolCallId?: string;
  /** Canonical durable artifact id for artifact-backed claims. */
  artifactId?: string;
  /** Compatibility alias from existing artifact rows; normalize to artifactId. */
  sourceArtifactId?: string;
}

export interface ConclusionContractClaimItem {
  id?: string;
  conclusionId?: string;
  text: string;
  kind?: ConclusionClaimKind;
  references: ConclusionContractClaimReference[];
  artifactRefs?: Array<{ artifactId: string; rowIndex?: number; rowSelector?: Record<string, unknown> }>;
  relationRefs?: string[];
  /** Model-produced hint only; visible verdicts come from verifier output. */
  supportLevel?: ConclusionClaimSupportLevel;
  semantics?: ClaimSemanticsV1;
  /** Original invalid model declaration; never a verified interpretation. */
  rawSemantics?: unknown;
  /** Malformed references remain available for diagnosis and lossless reparse. */
  rawReferences?: unknown;
  /** Parser-owned diagnostics, not accepted from model JSON. */
  semanticsParseIssues?: ConclusionContractParseIssue[];
}

export interface ClaimSemanticsV1 {
  schemaVersion: 'claim_semantics@1';
  /** Unknown rule IDs are valid declarations but supply no proof. */
  predicate: string;
  polarity: 'affirmed' | 'negated' | 'undetermined';
  discourse: 'asserted' | 'hypothetical' | 'quoted' | 'rejected_quote';
  quantifier: 'one' | 'some' | 'all' | 'only';
  modality: 'certain' | 'possible' | 'undetermined';
  conditions?: string[];
  scope: {
    subjectRefs?: ConclusionContractClaimReference[];
    objectRefs?: ConclusionContractClaimReference[];
    population: 'cited_rows' | 'selected_interval' | 'process_instance' | 'trace' | 'codebase';
    timeRangeNs?: {start: string; end: string};
  };
  /** The proposition value is distinct from a cited cell's value. */
  numeric?: {operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: number | string; unit: string};
  /** Original claimed location, not metadata filled from a later lookup. */
  source?: {sourceReferenceId: string; filePath: string; lineRange: {start: number; end: number}};
}

export interface ConclusionContractParseIssue {
  code: 'invalid_framing' | 'duplicate_marker' | 'invalid_json' | 'invalid_contract' |
    'invalid_claim' | 'invalid_reference' | 'invalid_semantics' | 'duplicate_claim_id' |
    'invalid_relation_proposal' | 'duplicate_proposal_id' | 'untrusted_parser_metadata';
  path: string;
  /** Fixed schema facts only; no raw values, user keys or source paths. */
  details?: ConclusionContractStructureDetail[];
  /** Closed relation shape only; no raw proposal fields or values. */
  relationProposalDiagnostic?: ConclusionRelationProposalDiagnostic;
  /** Closed claim location only: position, issue code and schema field, never model values. */
  claimDiagnostic?: ConclusionClaimDiagnostic;
}

/** Each parse issue's closed set of schema fields; never model-authored keys. */
const CLAIM_DIAGNOSTIC_FIELDS_BY_CODE = {
  invalid_claim: ['claim', 'text', 'id', 'conclusionId', 'kind'],
  invalid_reference: ['references', 'artifactRefs', 'relationRefs'],
  invalid_semantics: ['semantics', 'semantics.unknown_field', 'semantics.schemaVersion', 'semantics.predicate',
    'semantics.polarity', 'semantics.discourse', 'semantics.quantifier', 'semantics.modality', 'semantics.conditions',
    'semantics.scope', 'semantics.scope.unknown_field', 'semantics.scope.population', 'semantics.scope.subjectRefs',
    'semantics.scope.objectRefs', 'semantics.scope.timeRangeNs', 'semantics.numeric', 'semantics.source'],
  duplicate_claim_id: ['id'],
  untrusted_parser_metadata: ['parser_metadata'],
} as const;

export type ConclusionClaimDiagnosticCode = keyof typeof CLAIM_DIAGNOSTIC_FIELDS_BY_CODE;
export type ConclusionClaimDiagnosticField =
  typeof CLAIM_DIAGNOSTIC_FIELDS_BY_CODE[ConclusionClaimDiagnosticCode][number];

const CLAIM_NUMERIC_SUBREASONS = ['shape', 'operator', 'value', 'unit'] as const;

/** The failing part of `semantics.numeric`: its object shape or keys, `operator`, `value` or `unit`. */
export type ConclusionClaimNumericSubreason = typeof CLAIM_NUMERIC_SUBREASONS[number];

/** One failing claim: its 1-based position in `claims`, the parse issue and the schema field. */
export interface ConclusionClaimDiagnostic {
  readonly ordinal: number;
  readonly code: ConclusionClaimDiagnosticCode;
  readonly field: ConclusionClaimDiagnosticField;
  /** Only for `semantics.numeric`; absent in older diagnostics. */
  readonly subreason?: ConclusionClaimNumericSubreason;
}

export const MAX_CLAIM_DIAGNOSTICS = 24;

/** The whole claim diagnostic shape; validation and every copy read this one list. */
const CLAIM_DIAGNOSTIC_KEYS = ['ordinal', 'code', 'field', 'subreason'] as const;

/** Only a code/field pair a parser can actually produce is a claim diagnostic. */
export function isConclusionClaimDiagnostic(value: unknown): value is ConclusionClaimDiagnostic {
  return record(value) && keysWithin(value, CLAIM_DIAGNOSTIC_KEYS) &&
    Number.isSafeInteger(value.ordinal) && Number(value.ordinal) >= 1 && typeof value.code === 'string' &&
    hasOwn(CLAIM_DIAGNOSTIC_FIELDS_BY_CODE, value.code) &&
    (CLAIM_DIAGNOSTIC_FIELDS_BY_CODE[value.code as ConclusionClaimDiagnosticCode] as readonly unknown[]).includes(value.field) &&
    (value.subreason === undefined || (value.code === 'invalid_semantics' && value.field === 'semantics.numeric' &&
      oneOf(value.subreason, CLAIM_NUMERIC_SUBREASONS)));
}

/** A detached copy of a validated claim diagnostic with exactly its schema keys. */
export function copyConclusionClaimDiagnostic(detail: ConclusionClaimDiagnostic): ConclusionClaimDiagnostic {
  return declaredFields(detail, CLAIM_DIAGNOSTIC_KEYS);
}

export type ConclusionRelationProposalItemReason =
  | 'item_not_object'
  | 'unknown_field'
  | 'invalid_schema_version'
  | 'invalid_id'
  | 'invalid_kind'
  | 'invalid_direction'
  | 'invalid_subject'
  | 'invalid_object'
  | 'invalid_proof'
  | 'invalid_value'
  | 'invalid_unit'
  | 'invalid_metric_column'
  | 'invalid_delta_direction'
  | 'invalid_proof_bindings';

export type ConclusionRelationProposalDiagnostic =
  | {readonly scope: 'collection'; readonly reason: 'collection_not_array'}
  | {readonly scope: 'item'; readonly ordinal: number; readonly reason: ConclusionRelationProposalItemReason};

export const MAX_RELATION_PROPOSAL_DIAGNOSTICS = 24;

const RELATION_PROPOSAL_ITEM_REASONS: readonly ConclusionRelationProposalItemReason[] = [
  'item_not_object', 'unknown_field', 'invalid_schema_version', 'invalid_id', 'invalid_kind',
  'invalid_direction', 'invalid_subject', 'invalid_object', 'invalid_proof', 'invalid_value',
  'invalid_unit', 'invalid_metric_column', 'invalid_delta_direction', 'invalid_proof_bindings',
];

/** Keyed by the union so a new parse issue code cannot be left out. */
const PARSE_ISSUE_CODE_SET: Readonly<Record<ConclusionContractParseIssue['code'], true>> = {
  invalid_framing: true, duplicate_marker: true, invalid_json: true, invalid_contract: true, invalid_claim: true,
  invalid_reference: true, invalid_semantics: true, duplicate_claim_id: true, invalid_relation_proposal: true,
  duplicate_proposal_id: true, untrusted_parser_metadata: true,
};

export const CONCLUSION_PARSE_ISSUE_CODES = Object.freeze(
  Object.keys(PARSE_ISSUE_CODE_SET) as ConclusionContractParseIssue['code'][]);

const MAX_TRIAGE_CODES = 3;
const MAX_TRIAGE_QUALIFIERS = 3;

/** One issue, or one already-projected `code[:reason+reason]` string, in the fixed vocabulary. */
function triageEntry(value: unknown): {code: string; qualifiers: string[]} | undefined {
  if (typeof value === 'string') {
    const [code, qualifier, ...rest] = value.split(':');
    if (!hasOwn(PARSE_ISSUE_CODE_SET, code) || rest.length) return undefined;
    if (qualifier === undefined) return {code, qualifiers: []};
    const qualifiers = qualifier.split('+');
    return code === 'invalid_relation_proposal' && qualifiers.every(reason =>
      reason === 'collection_not_array' || oneOf(reason, RELATION_PROPOSAL_ITEM_REASONS)) ? {code, qualifiers} : undefined;
  }
  if (!record(value) || typeof value.code !== 'string' || !hasOwn(PARSE_ISSUE_CODE_SET, value.code)) return undefined;
  return {code: value.code, qualifiers: value.code === 'invalid_relation_proposal' &&
    isConclusionRelationProposalDiagnostic(value.relationProposalDiagnostic) ? [value.relationProposalDiagnostic.reason] : []};
}

/**
 * Closed-vocabulary triage codes for declaration parse issues; never raw
 * values, paths or ordinals. Each base code takes one slot, and relation
 * proposal reasons qualify it (`invalid_relation_proposal:invalid_kind+unknown_field`)
 * so several failing proposals cannot crowd out another code. Accepts parse
 * issues or codes already in this form; anything outside the vocabulary is
 * dropped rather than echoed.
 */
export function conclusionParseIssueTriageCodes(values: readonly unknown[]): string[] {
  const qualifiersByCode = new Map<string, string[]>();
  for (const entry of values.map(triageEntry)) {
    if (!entry || (!qualifiersByCode.has(entry.code) && qualifiersByCode.size >= MAX_TRIAGE_CODES)) continue;
    const known = qualifiersByCode.get(entry.code) ?? [];
    qualifiersByCode.set(entry.code, known);
    for (const qualifier of entry.qualifiers) {
      if (!known.includes(qualifier) && known.length < MAX_TRIAGE_QUALIFIERS) known.push(qualifier);
    }
  }
  return [...qualifiersByCode].map(([code, qualifiers]) => qualifiers.length ? `${code}:${qualifiers.join('+')}` : code);
}

export function isConclusionRelationProposalDiagnostic(value: unknown): value is ConclusionRelationProposalDiagnostic {
  if (!record(value) || !keysWithin(value, value.scope === 'collection' ? ['scope', 'reason'] : ['scope', 'ordinal', 'reason'])) {
    return false;
  }
  if (value.scope === 'collection') return value.reason === 'collection_not_array';
  return value.scope === 'item' && Number.isSafeInteger(value.ordinal) && Number(value.ordinal) >= 1 &&
    Number(value.ordinal) <= MAX_RELATION_PROPOSAL_DIAGNOSTICS &&
    RELATION_PROPOSAL_ITEM_REASONS.includes(value.reason as ConclusionRelationProposalItemReason);
}

export type ConclusionBindingEligibility = 'eligible' | 'ineligible' | 'legacy_unchecked';

export interface ConclusionContractDeclarationParseResult {
  status: 'absent' | 'valid' | 'invalid';
  raw: string;
  rawPayload?: unknown;
  contract?: ConclusionContract;
  issues: ConclusionContractParseIssue[];
  bindingEligibility: ConclusionBindingEligibility;
}

export interface ConclusionContractSidecarParseResult extends ConclusionContractDeclarationParseResult {
  /** Exact narrative outside the accepted marker. */
  narrative: string;
  /** Half-open UTF-16 offsets; retain raw separately before removing these from chat. */
  machineSegments: Array<{start: number; end: number}>;
}

export interface ConclusionContractMetadata {
  confidencePercent?: number;
  rounds?: number;
  clusterPolicy?: ConclusionContractClusterPolicy;
  sceneId?: string;
  /**
   * Claims were derived by matching the final narrative against captured
   * DataEnvelope cells, not emitted explicitly by the model.
   */
  derivedFromNarrativeEvidenceMatch?: boolean;
  claimDerivation?: 'explicit_model_contract' | 'narrative_evidence_match';
  claimVerificationScope?: 'explicit_claims' | 'sampled_narrative_evidence';
  replacedUnresolvableProviderClaims?: boolean;
}

export interface ConclusionContract {
  schemaVersion: 'conclusion_contract_v1';
  mode: ConclusionOutputMode;
  conclusions: ConclusionContractConclusionItem[];
  clusters: ConclusionContractClusterItem[];
  evidenceChain: ConclusionContractEvidenceItem[];
  claims?: ConclusionContractClaimItem[];
  rawClaims?: unknown;
  /** Parser-owned original root when rejected metadata cannot be omitted losslessly. */
  rawDeclaration?: unknown;
  /** Model proposals only; proof is produced independently by the backend. */
  relationProposals?: EvidenceRelationCandidateV1[];
  /** Preserve malformed proposals without treating them as typed candidates. */
  rawRelationProposals?: unknown;
  /** Parser-owned binding state. JSON with these fields cannot supply authority. */
  parseIssues?: ConclusionContractParseIssue[];
  bindingEligibility?: ConclusionBindingEligibility;
  sourceUseDecision?: SourceUseDecisionV1;
  sourceReferences?: SourceReferenceV1[];
  sourceClaimBindings?: SourceClaimBindingV1[];
  /**
   * Curated case-library recommendations selected by a retrieval/citation path.
   * Report rendering consumes this structured projection; retrieval remains
   * responsible for evidence-signature gating.
   */
  caseRecommendations?: CaseKnowledgeReportRecommendation[];
  uncertainties: string[];
  nextSteps: string[];
  metadata?: ConclusionContractMetadata;
}

const SIDECAR_MARKER = '<!-- smartperfetto:conclusion-contract@1';
const SIDECAR_PREFIX = '<!-- smartperfetto:conclusion-contract@';
/** Shared prompt framing; injected only after developer comments are stripped. */
export const CONCLUSION_CONTRACT_SIDECAR_MARKER = SIDECAR_MARKER;
const ROOT_PARSER_FIELDS = [
  'parseIssues', 'bindingEligibility', 'verified', 'rawClaims', 'rawRelationProposals', 'rawDeclaration',
] as const;
const CLAIM_PARSER_FIELDS = [
  'parseIssues', 'bindingEligibility', 'verified', 'rawSemantics', 'semanticsParseIssues', 'rawReferences', 'rawDeclaration',
] as const;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Fixed protocol values shared by declaration validation and private display projection. */
export const CONCLUSION_PROTOCOL_VALUES = Object.freeze({
  schemaVersion: 'conclusion_contract_v1',
  semanticsSchemaVersion: 'claim_semantics@1',
  relationSchemaVersion: 'evidence_relation_candidate@1',
  bindingEligibility: ['eligible', 'ineligible', 'legacy_unchecked'],
  deltaDirection: ['current_minus_reference'],
  mode: ['initial_report', 'focused_answer', 'need_input'],
  claimKind: ['numeric', 'categorical', 'time_range', 'identity', 'causal', 'comparison', 'inference', 'recommendation'],
  supportLevel: ['verified', 'partial', 'inference', 'unsupported'],
  polarity: ['affirmed', 'negated', 'undetermined'],
  discourse: ['asserted', 'hypothetical', 'quoted', 'rejected_quote'],
  quantifier: ['one', 'some', 'all', 'only'],
  modality: ['certain', 'possible', 'undetermined'],
  population: ['cited_rows', 'selected_interval', 'process_instance', 'trace', 'codebase'],
  operator: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  relationKind: ['overlap', 'wakeup', 'blocking_state', 'binder_peer', 'lock_owner', 'comparison_delta', 'derived'],
  direction: ['subject_to_object', 'object_to_subject', 'symmetric'],
} as const);
Object.values(CONCLUSION_PROTOCOL_VALUES).forEach(value => { if (Array.isArray(value)) Object.freeze(value); });

/** Fixed schema facts remain self-contained in generated frontend contract types. */
export interface ConclusionContractStructureDetail {
  field: '$' | '$.schemaVersion' | '$.mode' | '$.conclusions' | '$.conclusions[]' |
    '$.conclusions[].statement' | '$.conclusions[].rank' | '$.clusters' | '$.clusters[]' | '$.clusters[].cluster' |
    '$.evidenceChain' | '$.evidenceChain[]' | '$.evidenceChain[].conclusionId' | '$.evidenceChain[].text' |
    '$.uncertainties' | '$.uncertainties[]' | '$.nextSteps' | '$.nextSteps[]';
  reason: 'missing_required' | 'wrong_type' | 'invalid_literal' | 'invalid_enum' | 'invalid_number';
  expected: 'object' | 'array' | 'string' | 'finite_number' | 'conclusion_contract_v1' | 'conclusion_mode';
  actual: 'missing' | 'undefined' | 'null' | 'array' | 'object' | 'string' |
    'number' | 'nonfinite_number' | 'boolean' | 'other';
}
/** Schema-owned locations and their expected types; also constrain public diagnostics. */
const CONCLUSION_STRUCTURE_EXPECTED = Object.freeze({
  '$': 'object', '$.schemaVersion': CONCLUSION_PROTOCOL_VALUES.schemaVersion, '$.mode': 'conclusion_mode',
  '$.conclusions': 'array', '$.conclusions[]': 'object',
  '$.conclusions[].statement': 'string', '$.conclusions[].rank': 'finite_number',
  '$.clusters': 'array', '$.clusters[]': 'object', '$.clusters[].cluster': 'string',
  '$.evidenceChain': 'array', '$.evidenceChain[]': 'object',
  '$.evidenceChain[].conclusionId': 'string', '$.evidenceChain[].text': 'string',
  '$.uncertainties': 'array', '$.uncertainties[]': 'string', '$.nextSteps': 'array', '$.nextSteps[]': 'string',
} as const satisfies Record<ConclusionContractStructureDetail['field'], ConclusionContractStructureDetail['expected']>);
export const MAX_CONCLUSION_STRUCTURE_DETAILS = 24;
const CONCLUSION_STRUCTURE_ACTUAL: readonly ConclusionContractStructureDetail['actual'][] = ['missing', 'undefined', 'null', 'array', 'object', 'string',
  'number', 'nonfinite_number', 'boolean', 'other'];

function structureFailureReason(field: ConclusionContractStructureDetail['field'], actual: ConclusionContractStructureDetail['actual']):
  ConclusionContractStructureDetail['reason'] | undefined {
  if (actual === 'missing') return field === '$' || field.endsWith('[]') ? undefined : 'missing_required';
  const expected = CONCLUSION_STRUCTURE_EXPECTED[field];
  if (expected === 'finite_number') return actual === 'number' ? undefined
    : actual === 'nonfinite_number' ? 'invalid_number' : 'wrong_type';
  if (expected === CONCLUSION_PROTOCOL_VALUES.schemaVersion) return actual === 'string' ? 'invalid_literal' : 'wrong_type';
  if (expected === 'conclusion_mode') return actual === 'string' ? 'invalid_enum' : 'wrong_type';
  return expected === actual ? undefined : 'wrong_type';
}

/** Reject even individually known enum values when their field/type/reason combination is impossible. */
export function isConclusionContractStructureDetail(value: unknown): value is ConclusionContractStructureDetail {
  if (!record(value) || Object.keys(value).length !== 4 || !keysWithin(value, ['field', 'reason', 'expected', 'actual']) ||
    typeof value.field !== 'string' || !hasOwn(CONCLUSION_STRUCTURE_EXPECTED, value.field) ||
    !CONCLUSION_STRUCTURE_ACTUAL.includes(value.actual as ConclusionContractStructureDetail['actual'])) return false;
  const field = value.field as ConclusionContractStructureDetail['field'];
  const reason = structureFailureReason(field, value.actual as ConclusionContractStructureDetail['actual']);
  return reason !== undefined && value.reason === reason && value.expected === CONCLUSION_STRUCTURE_EXPECTED[field];
}

function structureActual(value: unknown, present: boolean): ConclusionContractStructureDetail['actual'] {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'nonfinite_number';
  if (typeof value === 'object' || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'undefined') {
    return typeof value as 'object' | 'string' | 'boolean' | 'undefined';
  }
  return 'other';
}

function oneOf(value: unknown, options: readonly string[]): value is string {
  return typeof value === 'string' && options.includes(value);
}

function keysWithin(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function claimReference(value: unknown): value is ConclusionContractClaimReference {
  if (!record(value) || !keysWithin(value, [
    'evidenceRefId', 'rowIndex', 'rowSelector', 'column', 'value', 'sourceRef',
    'sourceToolCallId', 'artifactId', 'sourceArtifactId',
  ])) return false;
  const identifiers = ['evidenceRefId', 'sourceRef', 'sourceToolCallId', 'artifactId', 'sourceArtifactId'];
  if (!identifiers.some(key => typeof value[key] === 'string' && String(value[key]).trim())) return false;
  if ([...identifiers, 'column'].some(key => value[key] !== undefined &&
    (typeof value[key] !== 'string' || !String(value[key]).trim()))) return false;
  if (value.rowIndex !== undefined && (!Number.isSafeInteger(value.rowIndex) || Number(value.rowIndex) < 0)) return false;
  if (value.rowSelector !== undefined && (!record(value.rowSelector) ||
    Object.keys(value.rowSelector).length === 0 ||
    Object.entries(value.rowSelector).some(([key, item]) => !key || !scalar(item)))) return false;
  return value.value === undefined || value.value === null || scalar(value.value);
}

function referenceList(value: unknown): value is ConclusionContractClaimReference[] {
  return Array.isArray(value) && value.every(claimReference);
}

/**
 * A decimal-nanosecond string, or a safe integer that `claimSemanticsResult`
 * writes back as its decimal string. An unsafe number may already have lost
 * digits in JSON.parse, so it stays invalid.
 */
function decimalNanoseconds(value: unknown): value is string | number {
  return typeof value === 'string' ? /^-?\d+$/.test(value) : Number.isSafeInteger(value);
}

/** The first failing part of a numeric proposition, in the order the schema lists it. */
function numericFailure(numeric: unknown): ConclusionClaimNumericSubreason | undefined {
  if (!record(numeric) || !keysWithin(numeric, ['operator', 'value', 'unit'])) return 'shape';
  if (!oneOf(numeric.operator, CONCLUSION_PROTOCOL_VALUES.operator)) return 'operator';
  if (!((typeof numeric.value === 'number' && Number.isFinite(numeric.value)) ||
    (typeof numeric.value === 'string' && /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numeric.value)))) return 'value';
  if (typeof numeric.unit !== 'string' || !numeric.unit.trim()) return 'unit';
  return undefined;
}

interface ClaimSemanticsFailure {
  field: ConclusionClaimDiagnosticField;
  subreason?: ConclusionClaimNumericSubreason;
}

/**
 * The first schema field a semantics declaration fails on; undefined when it is valid.
 * `schemaVersion` has one supported value, so it may be omitted; a present value must be it.
 */
function claimSemanticsFailure(raw: unknown): ClaimSemanticsFailure | undefined {
  if (!record(raw)) return {field: 'semantics'};
  if (!keysWithin(raw, ['schemaVersion', 'predicate', 'polarity', 'discourse',
    'quantifier', 'modality', 'conditions', 'scope', 'numeric', 'source'])) return {field: 'semantics.unknown_field'};
  if (hasOwn(raw, 'schemaVersion') && raw.schemaVersion !== CONCLUSION_PROTOCOL_VALUES.semanticsSchemaVersion) {
    return {field: 'semantics.schemaVersion'};
  }
  if (typeof raw.predicate !== 'string' || !raw.predicate.trim() || /\s/.test(raw.predicate)) return {field: 'semantics.predicate'};
  if (!oneOf(raw.polarity, CONCLUSION_PROTOCOL_VALUES.polarity)) return {field: 'semantics.polarity'};
  if (!oneOf(raw.discourse, CONCLUSION_PROTOCOL_VALUES.discourse)) return {field: 'semantics.discourse'};
  if (!oneOf(raw.quantifier, CONCLUSION_PROTOCOL_VALUES.quantifier)) return {field: 'semantics.quantifier'};
  if (!oneOf(raw.modality, CONCLUSION_PROTOCOL_VALUES.modality)) return {field: 'semantics.modality'};
  if (raw.conditions !== undefined && !stringList(raw.conditions)) return {field: 'semantics.conditions'};
  const scope = raw.scope;
  if (!record(scope)) return {field: 'semantics.scope'};
  if (!keysWithin(scope, ['subjectRefs', 'objectRefs', 'population', 'timeRangeNs'])) {
    return {field: 'semantics.scope.unknown_field'};
  }
  if (!oneOf(scope.population, CONCLUSION_PROTOCOL_VALUES.population)) return {field: 'semantics.scope.population'};
  if (scope.subjectRefs !== undefined && !referenceList(scope.subjectRefs)) return {field: 'semantics.scope.subjectRefs'};
  if (scope.objectRefs !== undefined && !referenceList(scope.objectRefs)) return {field: 'semantics.scope.objectRefs'};
  if (scope.timeRangeNs !== undefined) {
    const range = scope.timeRangeNs;
    if (!record(range) || !keysWithin(range, ['start', 'end']) || !decimalNanoseconds(range.start) ||
      !decimalNanoseconds(range.end) || BigInt(range.start) > BigInt(range.end)) return {field: 'semantics.scope.timeRangeNs'};
  }
  const numeric = raw.numeric === undefined ? undefined : numericFailure(raw.numeric);
  if (numeric) return {field: 'semantics.numeric', subreason: numeric};
  if (raw.source !== undefined) {
    const source = raw.source;
    if (!record(source) || !keysWithin(source, ['sourceReferenceId', 'filePath', 'lineRange']) ||
      typeof source.sourceReferenceId !== 'string' || !source.sourceReferenceId.trim() ||
      source.sourceReferenceId.length > MAX_SOURCE_REFERENCE_ID_LENGTH || typeof source.filePath !== 'string' ||
      !source.filePath.trim() || source.filePath.length > MAX_SOURCE_REFERENCE_PATH_LENGTH || !record(source.lineRange) ||
      !keysWithin(source.lineRange, ['start', 'end']) || !Number.isSafeInteger(source.lineRange.start) ||
      !Number.isSafeInteger(source.lineRange.end) || Number(source.lineRange.start) < 1 ||
      Number(source.lineRange.end) < Number(source.lineRange.start)) return {field: 'semantics.source'};
  }
  return undefined;
}

type ClaimSemanticsResult = {semantics?: ClaimSemanticsV1; rawSemantics?: unknown;
  semanticsParseIssues?: ConclusionContractParseIssue[]};

/**
 * The claim item's own semantics fields; the failing field is reported to the caller separately.
 * Valid semantics are canonical and equal the verbose declaration: an omitted `schemaVersion` is
 * inserted as the first key, where the verbose form writes it, and a safe-integer time window
 * becomes the decimal strings the schema declares. Invalid semantics stay exactly as written.
 */
function claimSemanticsResult(raw: unknown, path: string, failure: ClaimSemanticsFailure | undefined): ClaimSemanticsResult {
  if (failure) return {rawSemantics: raw, semanticsParseIssues: [{code: 'invalid_semantics', path}]};
  const clone = structuredClone(raw) as Record<string, unknown>;
  const semantics = (hasOwn(clone, 'schemaVersion') ? clone
    : {schemaVersion: CONCLUSION_PROTOCOL_VALUES.semanticsSchemaVersion, ...clone}) as unknown as ClaimSemanticsV1;
  const range = semantics.scope.timeRangeNs;
  if (range) {
    range.start = String(range.start);
    range.end = String(range.end);
  }
  return {semantics};
}

/** Schema validation only; it does not infer meaning from a claim's wording. */
export function parseClaimSemanticsDeclaration(raw: unknown, path = 'semantics'): ClaimSemanticsResult {
  return claimSemanticsResult(raw, path, claimSemanticsFailure(raw));
}

/** Preserve array order and duplicate IDs so binding validation can reject ambiguity. */
export function parseDeclaredConclusionClaims(raw: unknown): {
  claims: ConclusionContractClaimItem[];
  rawClaims?: unknown;
  issues: ConclusionContractParseIssue[];
} {
  if (!Array.isArray(raw)) return {claims: [], rawClaims: raw, issues: [{code: 'invalid_claim', path: 'claims'}]};
  const claims: ConclusionContractClaimItem[] = [];
  const issues: ConclusionContractParseIssue[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    const path = `claims[${index}]`;
    // A new issue object per claim location: claim items keep their own semantics issues untouched.
    const fail = (code: ConclusionClaimDiagnosticCode, field: ConclusionClaimDiagnosticField, issuePath = path,
      subreason?: ConclusionClaimNumericSubreason) =>
      issues.push({code, path: issuePath, claimDiagnostic: {ordinal: index + 1, code, field, ...(subreason ? {subreason} : {})}});
    if (!record(item) || typeof item.text !== 'string') {
      fail('invalid_claim', record(item) ? 'text' : 'claim');
      return;
    }
    const invalidField: ConclusionClaimDiagnosticField | undefined = !item.text.trim() ? 'text'
      : item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim()) ? 'id'
        : item.conclusionId !== undefined && typeof item.conclusionId !== 'string' ? 'conclusionId'
          : item.kind !== undefined && !oneOf(item.kind, CONCLUSION_PROTOCOL_VALUES.claimKind) ? 'kind' : undefined;
    if (invalidField) fail('invalid_claim', invalidField);
    if (CLAIM_PARSER_FIELDS.some(key => hasOwn(item, key))) fail('untrusted_parser_metadata', 'parser_metadata');
    const referencesValid = referenceList(item.references);
    if (!referencesValid) fail('invalid_reference', 'references', `${path}.references`);
    const semanticsFailure = hasOwn(item, 'semantics') ? claimSemanticsFailure(item.semantics) : undefined;
    const semantics = hasOwn(item, 'semantics')
      ? claimSemanticsResult(item.semantics, `${path}.semantics`, semanticsFailure) : {};
    if (semanticsFailure) fail('invalid_semantics', semanticsFailure.field, `${path}.semantics`, semanticsFailure.subreason);
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) fail('duplicate_claim_id', 'id', `${path}.id`);
      ids.add(item.id);
    }
    const artifactRefs = item.artifactRefs;
    const validArtifactRefs = artifactRefs === undefined || (Array.isArray(artifactRefs) && artifactRefs.every(ref =>
      record(ref) && keysWithin(ref, ['artifactId', 'rowIndex', 'rowSelector']) &&
      typeof ref.artifactId === 'string' && ref.artifactId.trim() &&
      (ref.rowIndex === undefined || (Number.isSafeInteger(ref.rowIndex) && Number(ref.rowIndex) >= 0)) &&
      (ref.rowSelector === undefined || record(ref.rowSelector))));
    if (!validArtifactRefs || (item.relationRefs !== undefined && !stringList(item.relationRefs))) {
      fail('invalid_reference', validArtifactRefs ? 'relationRefs' : 'artifactRefs');
    }
    claims.push({
      ...(typeof item.id === 'string' ? {id: item.id} : {}),
      ...(typeof item.conclusionId === 'string' ? {conclusionId: item.conclusionId} : {}),
      text: item.text,
      ...(typeof item.kind === 'string' ? {kind: item.kind as ConclusionClaimKind} : {}),
      references: referenceList(item.references) ? structuredClone(item.references) : [],
      ...(!referencesValid ? {rawReferences: structuredClone(item.references)} : {}),
      ...(Array.isArray(artifactRefs) && validArtifactRefs ? {artifactRefs: structuredClone(artifactRefs) as ConclusionContractClaimItem['artifactRefs']} : {}),
      ...(stringList(item.relationRefs) ? {relationRefs: [...item.relationRefs]} : {}),
      ...(oneOf(item.supportLevel, CONCLUSION_PROTOCOL_VALUES.supportLevel)
        ? {supportLevel: item.supportLevel as ConclusionClaimSupportLevel} : {}),
      ...semantics,
    });
  });
  return {claims, ...(issues.some(issue => issue.code === 'invalid_claim' || issue.code === 'untrusted_parser_metadata' ||
    (issue.code === 'invalid_reference' && !issue.path.endsWith('.references'))) ? {rawClaims: structuredClone(raw)} : {}), issues};
}

function relationProposalFailure(value: unknown): ConclusionRelationProposalItemReason | undefined {
  if (!record(value)) return 'item_not_object';
  if (!keysWithin(value, ['schemaVersion', 'id', 'kind', 'direction', 'subject', 'object',
    'proof', 'proofBindings', 'metricColumn', 'value', 'unit', 'deltaDirection'])) return 'unknown_field';
  // One supported version: it may be omitted, and a present value must be it.
  if (hasOwn(value, 'schemaVersion') && value.schemaVersion !== CONCLUSION_PROTOCOL_VALUES.relationSchemaVersion) {
    return 'invalid_schema_version';
  }
  if (typeof value.id !== 'string' || !/^proposal:[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value.id)) return 'invalid_id';
  if (!oneOf(value.kind, CONCLUSION_PROTOCOL_VALUES.relationKind)) return 'invalid_kind';
  if (!oneOf(value.direction, CONCLUSION_PROTOCOL_VALUES.direction)) return 'invalid_direction';
  if (!claimReference(value.subject)) return 'invalid_subject';
  if (value.object !== undefined && !claimReference(value.object)) return 'invalid_object';
  if (value.proof !== undefined && !claimReference(value.proof)) return 'invalid_proof';
  if (value.value !== undefined && !scalar(value.value)) return 'invalid_value';
  if (value.unit !== undefined && (typeof value.unit !== 'string' || !value.unit.trim())) return 'invalid_unit';
  if (value.metricColumn !== undefined && (typeof value.metricColumn !== 'string' || !value.metricColumn.trim())) {
    return 'invalid_metric_column';
  }
  if (value.deltaDirection !== undefined && !oneOf(value.deltaDirection, CONCLUSION_PROTOCOL_VALUES.deltaDirection)) {
    return 'invalid_delta_direction';
  }
  if (value.proofBindings !== undefined) {
    if (!record(value.proofBindings) || !keysWithin(value.proofBindings, ['subject', 'object'])) {
      return 'invalid_proof_bindings';
    }
    for (const endpoint of [value.proofBindings.subject, value.proofBindings.object]) {
      if (!record(endpoint) || !keysWithin(endpoint, ['endpointColumn', 'proofColumn']) ||
        typeof endpoint.endpointColumn !== 'string' || !endpoint.endpointColumn.trim() ||
        typeof endpoint.proofColumn !== 'string' || !endpoint.proofColumn.trim()) return 'invalid_proof_bindings';
    }
  }
  return undefined;
}

export function parseDeclaredRelationProposals(raw: unknown): {
  relationProposals: EvidenceRelationCandidateV1[];
  rawRelationProposals?: unknown;
  issues: ConclusionContractParseIssue[];
} {
  if (!Array.isArray(raw)) return {relationProposals: [], rawRelationProposals: raw,
    issues: [{code: 'invalid_relation_proposal', path: 'relationProposals',
      relationProposalDiagnostic: {scope: 'collection', reason: 'collection_not_array'}}]};
  const relationProposals: EvidenceRelationCandidateV1[] = [];
  const issues: ConclusionContractParseIssue[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    const reason = relationProposalFailure(item);
    if (reason) {
      issues.push({code: 'invalid_relation_proposal', path: `relationProposals[${index}]`,
        ...(index < MAX_RELATION_PROPOSAL_DIAGNOSTICS ? {relationProposalDiagnostic: {
          scope: 'item' as const, ordinal: index + 1, reason,
        }} : {})});
      return;
    }
    if (ids.has(item.id)) issues.push({code: 'duplicate_proposal_id', path: `relationProposals[${index}].id`});
    ids.add(item.id);
    // An omitted version is inserted as the first key, where the verbose declaration writes it.
    relationProposals.push(hasOwn(item, 'schemaVersion') ? structuredClone(item)
      : {schemaVersion: CONCLUSION_PROTOCOL_VALUES.relationSchemaVersion, ...structuredClone(item)});
  });
  return {relationProposals, ...(issues.length ? {rawRelationProposals: structuredClone(raw)} : {}), issues};
}

/** New declaration fields distinguish the typed protocol from legacy aliases. */
export function hasConclusionContractDeclarations(value: unknown): boolean {
  if (!record(value)) return false;
  return hasOwn(value, 'relationProposals') || ROOT_PARSER_FIELDS.some(key => hasOwn(value, key)) ||
    (Array.isArray(value.claims) && value.claims.some(claim => record(claim) &&
      (hasOwn(claim, 'semantics') || CLAIM_PARSER_FIELDS.some(key => hasOwn(claim, key)))));
}

/** Classify complete canonical typed JSON before a legacy extractor can rewrite it. */
export function parseTypedConclusionContractJson(raw: string): ConclusionContractDeclarationParseResult {
  const absent: ConclusionContractDeclarationParseResult = {
    status: 'absent', raw, issues: [], bindingEligibility: 'legacy_unchecked',
  };
  const text = raw.trim();
  const fenced = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(text);
  let rawPayload: unknown;
  try { rawPayload = JSON.parse(fenced ? fenced[1] : text); }
  catch { return absent; }
  if (!record(rawPayload) || rawPayload.schemaVersion !== 'conclusion_contract_v1' ||
    !hasConclusionContractDeclarations(rawPayload)) return absent;
  const projected = parseConclusionContractDeclaration(rawPayload);
  const status = projected.issues.length ? 'invalid' : 'valid';
  return {raw, rawPayload, ...projected, status,
    bindingEligibility: status === 'valid' ? 'eligible' : 'ineligible'};
}

/** Sidecar JSON uses canonical v1 field names. Legacy aliases stay in the legacy parser. */
export function parseConclusionContractDeclaration(raw: unknown): {contract?: ConclusionContract; issues: ConclusionContractParseIssue[]} {
  const issues: ConclusionContractParseIssue[] = [];
  const details: ConclusionContractStructureDetail[] = [];
  const seenDetails = new Set<string>();
  const check = (field: ConclusionContractStructureDetail['field'], value: unknown, valid: boolean, present = true): boolean => {
    if (valid) return true;
    const actual = structureActual(value, present);
    const reason = structureFailureReason(field, actual);
    const key = `${field}:${actual}`;
    if (reason && !seenDetails.has(key) && details.length < MAX_CONCLUSION_STRUCTURE_DETAILS) {
      seenDetails.add(key);
      details.push({field, reason, expected: CONCLUSION_STRUCTURE_EXPECTED[field], actual});
    }
    return false;
  };
  const invalid = () => ({issues: [...issues, {code: 'invalid_contract' as const, path: '$', details}]});
  if (!record(raw)) {
    check('$', raw, false);
    return invalid();
  }
  const stringArray = (field: 'uncertainties' | 'nextSteps'): boolean => {
    const value = raw[field];
    if (!check(`$.${field}`, value, Array.isArray(value), hasOwn(raw, field))) return false;
    let valid = true;
    (value as unknown[]).forEach(item => {if (!check(`$.${field}[]`, item, typeof item === 'string')) valid = false;});
    return valid;
  };
  const rootValid = [
    check('$.schemaVersion', raw.schemaVersion, raw.schemaVersion === CONCLUSION_PROTOCOL_VALUES.schemaVersion, hasOwn(raw, 'schemaVersion')),
    check('$.mode', raw.mode, oneOf(raw.mode, CONCLUSION_PROTOCOL_VALUES.mode), hasOwn(raw, 'mode')),
    check('$.conclusions', raw.conclusions, Array.isArray(raw.conclusions), hasOwn(raw, 'conclusions')),
    check('$.clusters', raw.clusters, Array.isArray(raw.clusters), hasOwn(raw, 'clusters')),
    check('$.evidenceChain', raw.evidenceChain, Array.isArray(raw.evidenceChain), hasOwn(raw, 'evidenceChain')),
    stringArray('uncertainties'), stringArray('nextSteps'),
  ].every(Boolean);
  if (!rootValid) return invalid();
  const rejectedRootMetadata = ROOT_PARSER_FIELDS.some(key => hasOwn(raw, key));
  if (rejectedRootMetadata) issues.push({code: 'untrusted_parser_metadata', path: '$'});
  let itemsValid = true;
  (raw.conclusions as unknown[]).forEach(item => {
    if (!record(item)) {check('$.conclusions[]', item, false); itemsValid = false; return;}
    if (!check('$.conclusions[].statement', item.statement, typeof item.statement === 'string', hasOwn(item, 'statement'))) itemsValid = false;
    if (!check('$.conclusions[].rank', item.rank, typeof item.rank === 'number' && Number.isFinite(item.rank), hasOwn(item, 'rank'))) itemsValid = false;
  });
  (raw.clusters as unknown[]).forEach(item => {
    if (!record(item)) {check('$.clusters[]', item, false); itemsValid = false; return;}
    if (!check('$.clusters[].cluster', item.cluster, typeof item.cluster === 'string', hasOwn(item, 'cluster'))) itemsValid = false;
  });
  (raw.evidenceChain as unknown[]).forEach(item => {
    if (!record(item)) {check('$.evidenceChain[]', item, false); itemsValid = false; return;}
    if (!check('$.evidenceChain[].conclusionId', item.conclusionId, typeof item.conclusionId === 'string', hasOwn(item, 'conclusionId'))) itemsValid = false;
    if (!check('$.evidenceChain[].text', item.text, typeof item.text === 'string', hasOwn(item, 'text'))) itemsValid = false;
  });
  const claims = hasOwn(raw, 'claims') ? parseDeclaredConclusionClaims(raw.claims) : undefined;
  const relations = hasOwn(raw, 'relationProposals') ? parseDeclaredRelationProposals(raw.relationProposals) : undefined;
  issues.push(...(claims?.issues ?? []), ...(relations?.issues ?? []));
  const sourceBindingsValid = !hasOwn(raw, 'sourceClaimBindings') || isSourceClaimBindingsDeclaration(raw.sourceClaimBindings);
  if (!sourceBindingsValid) issues.push({code: 'invalid_reference', path: 'sourceClaimBindings'});
  // Reject impossible declaration links before protocol recovery finishes. This
  // checks ownership shape only; aliases, values and causality remain verifier work.
  let sourceBindingLinksValid = true;
  if (sourceBindingsValid && Array.isArray(raw.sourceClaimBindings)) {
    raw.sourceClaimBindings.forEach((binding: SourceClaimBindingV1, index: number) => {
      const owners = (claims?.claims ?? []).filter(claim => claim.id === binding.claimId);
      const owner = owners.length === 1 ? owners[0] : undefined;
      const hasTraceReference = owner && [owner.references, owner.artifactRefs, owner.relationRefs,
        owner.semantics?.scope.subjectRefs, owner.semantics?.scope.objectRefs].some(refs => refs && refs.length > 0);
      if (!owner || (binding.traceEvidenceRefIds.length > 0 && !hasTraceReference)) {
        sourceBindingLinksValid = false;
        issues.push({code: 'invalid_reference', path: `sourceClaimBindings[${index}].${owner ? 'traceEvidenceRefIds' : 'claimId'}`});
      }
    });
  }
  if (!itemsValid) return invalid();
  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1', mode: raw.mode as ConclusionOutputMode,
    conclusions: structuredClone(raw.conclusions) as ConclusionContractConclusionItem[],
    clusters: structuredClone(raw.clusters) as ConclusionContractClusterItem[],
    evidenceChain: structuredClone(raw.evidenceChain) as ConclusionContractEvidenceItem[],
    uncertainties: [...raw.uncertainties as string[]], nextSteps: [...raw.nextSteps as string[]],
    ...(claims ? {claims: claims.claims, ...(hasOwn(claims, 'rawClaims') ? {rawClaims: claims.rawClaims} : {})} : {}),
    ...(relations ? {relationProposals: relations.relationProposals,
      ...(hasOwn(relations, 'rawRelationProposals') ? {rawRelationProposals: relations.rawRelationProposals} : {})} : {}),
    ...(record(raw.metadata) ? {metadata: structuredClone(raw.metadata) as ConclusionContractMetadata} : {}),
    ...(record(raw.sourceUseDecision) ? {sourceUseDecision: structuredClone(raw.sourceUseDecision) as unknown as SourceUseDecisionV1} : {}),
    ...(Array.isArray(raw.sourceReferences) ? {sourceReferences: structuredClone(raw.sourceReferences) as SourceReferenceV1[]} : {}),
    ...(sourceBindingsValid && hasOwn(raw, 'sourceClaimBindings')
      ? {sourceClaimBindings: structuredClone(raw.sourceClaimBindings) as SourceClaimBindingV1[]} : {}),
    ...(rejectedRootMetadata || !sourceBindingsValid || !sourceBindingLinksValid ? {rawDeclaration: structuredClone(raw)} : {}),
    parseIssues: issues,
    bindingEligibility: issues.length ? 'ineligible' : 'eligible',
  };
  return {contract, issues};
}

export interface ConclusionSidecarMachineSegment {
  start: number;
  end: number;
  startLine: number;
  /** -1 means the explicit machine segment was interrupted. */
  endLine: number;
}

function newSidecarLineState() {
  return {
    length: 0, prefixIndex: 0, pendingPrefix: '', startText: '', commentTail: '',
    hasCommentClose: false, equalsTerminator: true,
    fencePossible: true, fenceCharacter: '', fenceLength: 0, fenceTail: false,
    fenceTailWhitespace: true, fenceTailBacktick: false, fenceTailLineBreak: false,
  };
}

/**
 * The shared framing grammar for final parsing and live narrative projection.
 * Only a possible line-start marker and one CR are withheld. Machine payloads
 * and visible prose are never retained; line/fence recognition uses counters.
 */
export class ConclusionSidecarFramingScanner {
  private line = newSidecarLineState();
  private offset = 0;
  private lineStart = 0;
  private lineIndex = 0;
  private fence: {character: string; length: number} | undefined;
  private htmlComment = false;
  private machineStart: {offset: number; line: number} | undefined;
  private pendingCr = false;
  private ended = false;
  private markers = 0;

  constructor(private readonly onMachineSegment?: (segment: ConclusionSidecarMachineSegment) => void) {}

  get markerCount(): number { return this.markers; }

  /** Diagnostic of text awaiting disambiguation, independent of answer length. */
  get bufferedCharacterCount(): number {
    return this.line.pendingPrefix.length + (this.pendingCr ? 1 : 0);
  }

  write(text: string): string {
    if (this.ended) return '';
    let visible = '';
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      this.offset++;
      if (this.pendingCr) {
        this.pendingCr = false;
        if (character === '\n') {
          visible += this.endLine('\r\n');
          continue;
        }
        visible += this.consumeCharacter('\r');
      }
      if (character === '\r') this.pendingCr = true;
      else if (character === '\n') visible += this.endLine('\n');
      else visible += this.consumeCharacter(character);
    }
    return visible;
  }

  finish(): string {
    if (this.ended) return '';
    let visible = '';
    if (this.pendingCr) {
      this.pendingCr = false;
      visible += this.consumeCharacter('\r');
    }
    visible += this.endLine('');
    if (this.machineStart) this.emitSegment(this.offset, -1);
    this.ended = true;
    return visible;
  }

  reset(): void {
    this.line = newSidecarLineState();
    this.offset = this.lineStart = this.lineIndex = this.markers = 0;
    this.fence = this.machineStart = undefined;
    this.htmlComment = this.pendingCr = this.ended = false;
  }

  private consumeCharacter(character: string): string {
    const line = this.line;
    line.length++;
    line.equalsTerminator &&= character === '-->'[line.length - 1];
    if (!this.machineStart) {
      if (line.startText.length < 7) line.startText += character;
      line.commentTail = (line.commentTail + character).slice(-3);
      line.hasCommentClose ||= line.commentTail === '-->';
      this.consumeFenceCharacter(character);
    }

    if (this.fence || this.htmlComment) return character;
    if (line.prefixIndex >= 0) {
      if (character === SIDECAR_PREFIX[line.prefixIndex]) {
        line.prefixIndex++;
        if (line.prefixIndex === SIDECAR_PREFIX.length) {
          this.markers++;
          this.machineStart ??= {offset: this.lineStart, line: this.lineIndex};
          line.pendingPrefix = '';
          line.prefixIndex = -1;
        } else if (!this.machineStart) line.pendingPrefix += character;
        return '';
      }
      line.prefixIndex = -1;
    }
    if (this.machineStart) return '';
    const visible = line.pendingPrefix + character;
    line.pendingPrefix = '';
    return visible;
  }

  private consumeFenceCharacter(character: string): void {
    const line = this.line;
    if (!line.fencePossible) return;
    if (!line.fenceCharacter) {
      if (character === ' ' && line.length <= 3) return;
      if ((character === '`' || character === '~') && line.length <= 4) {
        line.fenceCharacter = character;
        line.fenceLength = 1;
      } else line.fencePossible = false;
    } else if (!line.fenceTail && character === line.fenceCharacter) {
      line.fenceLength++;
    } else {
      line.fenceTail = true;
      line.fenceTailWhitespace &&= /\s/.test(character);
      line.fenceTailBacktick ||= character === '`';
      // Match the existing opening regex's dot semantics, including bare CR.
      line.fenceTailLineBreak ||= /[\r\u2028\u2029]/.test(character);
    }
  }

  private endLine(newline: string): string {
    const line = this.line;
    let visible = line.pendingPrefix;
    if (this.machineStart) {
      if (line.length === 3 && line.equalsTerminator) {
        this.emitSegment(this.lineStart + line.length, this.lineIndex);
      }
    } else if (this.fence) {
      if (line.fenceCharacter === this.fence.character && line.fenceLength >= this.fence.length &&
        line.fenceTailWhitespace) this.fence = undefined;
    } else if (this.htmlComment) {
      if (line.hasCommentClose) this.htmlComment = false;
    } else if (line.fenceLength >= 3 && !line.fenceTailLineBreak &&
      (line.fenceCharacter !== '`' || !line.fenceTailBacktick)) {
      this.fence = {character: line.fenceCharacter, length: line.fenceLength};
    } else if (/^ {0,3}<!--/.test(line.startText) && !line.hasCommentClose) {
      this.htmlComment = true;
    }
    if (!this.machineStart) visible += newline;
    this.line = newSidecarLineState();
    this.lineStart = this.offset;
    this.lineIndex++;
    return visible;
  }

  private emitSegment(end: number, endLine: number): void {
    const start = this.machineStart!;
    this.onMachineSegment?.({start: start.offset, end, startLine: start.line, endLine});
    this.machineStart = undefined;
  }
}

/** Recognize explicit top-level sidecars without interpreting ordinary prose. */
export function parseConclusionContractSidecar(raw: string): ConclusionContractSidecarParseResult {
  const lines = raw.split(/\r?\n/);
  const markers: Array<{start: number; end: number}> = [];
  const machineSegments: Array<{start: number; end: number}> = [];
  const scanner = new ConclusionSidecarFramingScanner(segment => {
    markers.push({start: segment.startLine, end: segment.endLine});
    machineSegments.push({start: segment.start, end: segment.end});
  });
  const narrative = scanner.write(raw) + scanner.finish();
  const markerCount = scanner.markerCount;
  const base = {raw, narrative, machineSegments, issues: [] as ConclusionContractParseIssue[]};
  if (markerCount === 0) return {...base, status: 'absent', bindingEligibility: 'legacy_unchecked'};
  if (markerCount !== 1) return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'duplicate_marker', path: '$'}]};
  const marker = markers[0];
  if (marker.end < 0 || lines[marker.start] !== SIDECAR_MARKER || lines[marker.start + 1] !== '```json' ||
    lines[marker.end - 1] !== '```') return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'invalid_framing', path: '$'}]};
  const payload = lines.slice(marker.start + 2, marker.end - 1).join('\n');
  if (payload.includes('-->')) return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'invalid_framing', path: '$'}]};
  let rawPayload: unknown;
  try { rawPayload = JSON.parse(payload); }
  catch { return {...base, status: 'invalid', bindingEligibility: 'ineligible', issues: [{code: 'invalid_json', path: '$'}]}; }
  const projected = parseConclusionContractDeclaration(rawPayload);
  const status = projected.issues.length ? 'invalid' : 'valid';
  return {...base, rawPayload, ...projected, status,
    bindingEligibility: status === 'valid' ? 'eligible' : 'ineligible',
  };
}

/** Raw invalid declarations are serialized as declarations, then validated anew. */
export function renderConclusionContractSidecar(contract: ConclusionContract): string {
  const {parseIssues: _issues, bindingEligibility: _eligibility, rawClaims, rawRelationProposals, rawDeclaration, ...body} = contract;
  const claims = hasOwn(contract, 'rawClaims') ? rawClaims : contract.claims?.map(claim => {
    const {rawSemantics, semanticsParseIssues: _semanticIssues, rawReferences, ...declaration} = claim;
    return {...declaration,
      ...(hasOwn(claim, 'rawSemantics') ? {semantics: rawSemantics} : {}),
      ...(hasOwn(claim, 'rawReferences') ? {references: rawReferences} : {}),
    };
  });
  const declaration = hasOwn(contract, 'rawDeclaration') ? rawDeclaration : {...body,
    ...(claims !== undefined ? {claims} : {}),
    ...(hasOwn(contract, 'rawRelationProposals') ? {relationProposals: rawRelationProposals} : {}),
  };
  const serialized = JSON.stringify(declaration, null, 2);
  if (serialized === undefined) throw new Error('Cannot serialize an unavailable conclusion declaration');
  return wrapConclusionContractSidecarPayload(serialized);
}

/**
 * Frame serialized declaration JSON as a sidecar. `<`, `>` and `&` only occur
 * inside JSON strings, so their `\u` escapes keep `-->` out of the payload.
 */
export function wrapConclusionContractSidecarPayload(serializedJson: string): string {
  const payload = serializedJson.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `${SIDECAR_MARKER}\n\`\`\`json\n${payload}\n\`\`\`\n-->`;
}

export function declaredFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  if (!value || typeof value !== 'object') return {} as Pick<T, K>;
  return Object.fromEntries(keys.flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? [[key, descriptor.value]] : [];
  })) as Pick<T, K>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(Object.entries(declaredFields(value, keys)).filter(([, item]) => typeof item === 'string')) as Partial<Pick<T, K>>;
}

function numberFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(Object.entries(declaredFields(value, keys)).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Partial<Pick<T, K>>;
}

function caseRecommendationsForResult(value: ConclusionContract['caseRecommendations']): CaseKnowledgeReportRecommendation[] {
  const recommendations = (items: unknown): CaseKnowledgeRecommendation[] => Array.isArray(items) ? items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const fields = declaredFields(item as CaseKnowledgeRecommendation, ['id', 'priority', 'action', 'applies_when', 'risks']);
    return typeof fields.id === 'string' && typeof fields.action === 'string' && typeof fields.applies_when === 'string' &&
      typeof fields.risks === 'string' && ['P0', 'P1', 'P2', 'P3'].includes(fields.priority) ? [fields] : [];
  }) : [];
  return Array.isArray(value) ? value.flatMap(item => {
    if (!item || typeof item.caseId !== 'string' || typeof item.title !== 'string' ||
      !['strong', 'partial', 'background'].includes(item.matchStrength)) return [];
    const learned = item.learnedProvenance;
    return [{caseId: item.caseId, title: item.title, matchStrength: item.matchStrength,
      ...stringFields(item, ['scene', 'primaryRootCause', 'evidenceGap']),
      ...(item.evidenceRefs ? {evidenceRefs: strings(item.evidenceRefs)} : {}),
      ...(item.matchedSignatures ? {matchedSignatures: strings(item.matchedSignatures)} : {}),
      ...(item.missingRequiredSignatures ? {missingRequiredSignatures: strings(item.missingRequiredSignatures)} : {}),
      recommendations: {app: recommendations(item.recommendations?.app), oem: recommendations(item.recommendations?.oem)},
      ...(learned && typeof learned.candidateId === 'string' && typeof learned.supported === 'boolean' &&
        Number.isFinite(learned.supportingEvidence) && Number.isFinite(learned.contradictingEvidence) ? {learnedProvenance: {
          candidateId: learned.candidateId, supportingEvidence: learned.supportingEvidence,
          contradictingEvidence: learned.contradictingEvidence, supported: learned.supported,
        }} : {}),
    }];
  }) : [];
}

/** Raw malformed declarations remain private; typed declarations retain parser eligibility. */
export function declaredContractForResult(contract: ConclusionContract | undefined): ConclusionContract | undefined {
  if (!contract) return undefined;
  const typed = declaredFields(contract, ['schemaVersion', 'mode', 'conclusions', 'clusters', 'evidenceChain',
    'claims', 'relationProposals', 'bindingEligibility', 'sourceUseDecision', 'sourceReferences',
    'sourceClaimBindings', 'caseRecommendations', 'uncertainties', 'nextSteps', 'metadata']);
  if (Array.isArray(typed.conclusions)) typed.conclusions = typed.conclusions.flatMap(item =>
    item && typeof item.statement === 'string' && Number.isFinite(item.rank) ? [{rank: item.rank, statement: item.statement,
      ...numberFields(item, ['confidencePercent']), ...stringFields(item, ['trigger', 'supply', 'amplification'])}] : []);
  if (Array.isArray(typed.clusters)) typed.clusters = typed.clusters.flatMap(item =>
    item && typeof item.cluster === 'string' ? [{cluster: item.cluster, ...stringFields(item, ['description']),
      ...numberFields(item, ['frames', 'percentage', 'omittedFrameRefs']),
      ...(item.frameRefs ? {frameRefs: strings(item.frameRefs)} : {})}] : []);
  if (Array.isArray(typed.evidenceChain)) typed.evidenceChain = typed.evidenceChain.flatMap(item =>
    item && typeof item.conclusionId === 'string' && typeof item.text === 'string'
      ? [{conclusionId: item.conclusionId, text: item.text}] : []);
  if (Array.isArray(typed.claims)) {
    const declarations = typed.claims.map(claim => declaredFields(claim,
      ['id', 'conclusionId', 'text', 'kind', 'references', 'artifactRefs', 'relationRefs', 'supportLevel', 'semantics']));
    typed.claims = parseDeclaredConclusionClaims(declarations).claims.map(claim => {
      const {rawReferences: _references, rawSemantics: _semantics, semanticsParseIssues: _issues, ...projected} = claim;
      if (projected.artifactRefs) projected.artifactRefs = projected.artifactRefs.map(reference => ({
        ...reference, ...(reference.rowSelector ? {rowSelector: Object.fromEntries(Object.entries(reference.rowSelector)
          .filter(([, item]) => typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)))} : {}),
      }));
      return projected;
    });
  } else delete typed.claims;
  if (typed.relationProposals) typed.relationProposals = parseDeclaredRelationProposals(typed.relationProposals).relationProposals;
  if (typed.sourceUseDecision) typed.sourceUseDecision = sanitizeSourceUseDecision(typed.sourceUseDecision);
  if (typed.sourceReferences) typed.sourceReferences = sanitizeSourceReferences(typed.sourceReferences);
  if (typed.sourceClaimBindings) typed.sourceClaimBindings = sanitizeSourceClaimBindings(typed.sourceClaimBindings);
  if (typed.caseRecommendations) typed.caseRecommendations = caseRecommendationsForResult(typed.caseRecommendations);
  if (typed.uncertainties) typed.uncertainties = strings(typed.uncertainties);
  if (typed.nextSteps) typed.nextSteps = strings(typed.nextSteps);
  if (typed.metadata) {
    const metadata = typed.metadata;
    const clusterPolicy = metadata.clusterPolicy;
    typed.metadata = {
      ...(typeof metadata.confidencePercent === 'number' ? {confidencePercent: metadata.confidencePercent} : {}),
      ...(typeof metadata.rounds === 'number' ? {rounds: metadata.rounds} : {}),
      ...(typeof metadata.sceneId === 'string' ? {sceneId: metadata.sceneId} : {}),
      ...(typeof metadata.derivedFromNarrativeEvidenceMatch === 'boolean'
        ? {derivedFromNarrativeEvidenceMatch: metadata.derivedFromNarrativeEvidenceMatch} : {}),
      ...(typeof metadata.replacedUnresolvableProviderClaims === 'boolean'
        ? {replacedUnresolvableProviderClaims: metadata.replacedUnresolvableProviderClaims} : {}),
      ...(metadata.claimDerivation === 'explicit_model_contract' || metadata.claimDerivation === 'narrative_evidence_match'
        ? {claimDerivation: metadata.claimDerivation} : {}),
      ...(metadata.claimVerificationScope === 'explicit_claims' || metadata.claimVerificationScope === 'sampled_narrative_evidence'
        ? {claimVerificationScope: metadata.claimVerificationScope} : {}),
      ...(clusterPolicy && ['required', 'optional', 'none'].includes(clusterPolicy.outputMode) &&
        ['none', 'top', 'full'].includes(clusterPolicy.frameListMode) ? {clusterPolicy: {
          outputMode: clusterPolicy.outputMode, frameListMode: clusterPolicy.frameListMode,
          ...(typeof clusterPolicy.maxFramesPerCluster === 'number' ? {maxFramesPerCluster: clusterPolicy.maxFramesPerCluster} : {}),
        }} : {}),
    };
  }
  return typed;
}
