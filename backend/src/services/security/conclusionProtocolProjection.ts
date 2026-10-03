// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {isDeepStrictEqual} from 'node:util';
import {
  CONCLUSION_PROTOCOL_VALUES, CONCLUSION_CONTRACT_SIDECAR_MARKER, conclusionParseIssueTriageCodes, declaredContractForResult,
  parseConclusionContractSidecar,
  parseTypedConclusionContractJson, renderConclusionContractSidecar,
  type ConclusionContract,
  type ConclusionContractClaimReference,
} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity} from '../../types/analysisDelivery';
import {isSourceMechanismStatus} from '../codebase/sourceUseDecision';
import {
  issueCodeAwareStructuredProjectionReceipt, projectCodeAwareProtocolLiteral, projectCodeAwareSemanticInputStructure,
  projectCodeAwareAuthorizedInputText,
  projectCodeAwareStructuredText, sanitizeCodeAwareStructuredTextWithReceipt,
  type CodeAwareTextProjectionReceipt,
} from './codeAwareOutputRegistry';
import {preparedReferenceResolution, type PreparedClaimEvidence} from '../evidence/claimEvidencePreparation';
import {isIssuedEvidenceReadResolution} from '../evidence/evidenceReadView';
import type {FinalSemanticSnapshot} from '../finalSemanticAssessment';
import {preserveProjectedFieldOrder} from './analysisDeliveryProjection';
import {SUPPORTED_DETERMINISTIC_CLAIM_RULES} from '../verifier/deterministicClaimVerifier';
import {isIssuedCanonicalAnalysisProjection, matchingCanonicalAnalysisProseFields,
  type CanonicalAnalysisProjection} from '../canonicalAnalysisProjection';

/** Identity-only token. Its original declarations live exclusively in the private map. */
export interface IssuedConclusionProtocolProjection {readonly kind: 'conclusion_protocol_projection'}
export interface NativeConclusionDeclaration {
  readonly raw: string;
  readonly contract?: ConclusionContract;
}
interface ProjectionState {
  readonly sessionId: string;
  readonly nativeCandidate: AnalysisCandidateIdentity;
  readonly displayCandidate: AnalysisCandidateIdentity;
  readonly displayFingerprint: string;
  readonly publicClaimsFingerprint: string;
  readonly publicContractFingerprint: string;
  readonly sourceUseFingerprint: string;
  readonly validationFingerprint: string;
  readonly original: NativeConclusionDeclaration;
}
const issued = new WeakMap<IssuedConclusionProtocolProjection, ProjectionState>();
const nativeDeclarations = new WeakMap<object, IssuedConclusionProtocolProjection>();
const attached = new WeakSet<object>();

export function isIssuedNativeConclusionDeclaration(value: NativeConclusionDeclaration): boolean {
  return nativeDeclarations.has(value);
}

function freeze<T>(value: T): T {
  const copied = structuredClone(value);
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    Object.values(item).forEach(visit);
    Object.freeze(item);
  };
  visit(copied);
  return copied;
}

function sameCandidate(left: AnalysisCandidateIdentity | undefined, right: AnalysisCandidateIdentity): boolean {
  return Boolean(left && left.runId === right.runId && left.attemptId === right.attemptId &&
    left.candidateRef === right.candidateRef && left.conclusionFingerprint === right.conclusionFingerprint);
}

function literal(path: string[], value: string): boolean {
  const key = path.map(part => /^\d+$/.test(part) ? '*' : part).join('.');
  const values: Readonly<Record<string, readonly string[]>> = {
    schemaVersion: [CONCLUSION_PROTOCOL_VALUES.schemaVersion], mode: CONCLUSION_PROTOCOL_VALUES.mode,
    bindingEligibility: CONCLUSION_PROTOCOL_VALUES.bindingEligibility,
    'claims.*.kind': CONCLUSION_PROTOCOL_VALUES.claimKind,
    'claims.*.supportLevel': CONCLUSION_PROTOCOL_VALUES.supportLevel,
    'claims.*.semantics.schemaVersion': [CONCLUSION_PROTOCOL_VALUES.semanticsSchemaVersion],
    'claims.*.semantics.polarity': CONCLUSION_PROTOCOL_VALUES.polarity,
    'claims.*.semantics.discourse': CONCLUSION_PROTOCOL_VALUES.discourse,
    'claims.*.semantics.quantifier': CONCLUSION_PROTOCOL_VALUES.quantifier,
    'claims.*.semantics.modality': CONCLUSION_PROTOCOL_VALUES.modality,
    'claims.*.semantics.scope.population': CONCLUSION_PROTOCOL_VALUES.population,
    'claims.*.semantics.numeric.operator': CONCLUSION_PROTOCOL_VALUES.operator,
    'relationProposals.*.schemaVersion': [CONCLUSION_PROTOCOL_VALUES.relationSchemaVersion],
    'relationProposals.*.kind': CONCLUSION_PROTOCOL_VALUES.relationKind,
    'relationProposals.*.direction': CONCLUSION_PROTOCOL_VALUES.direction,
    'relationProposals.*.deltaDirection': CONCLUSION_PROTOCOL_VALUES.deltaDirection,
  };
  if (key === 'sourceClaimBindings.*.mechanismStatus') return isSourceMechanismStatus(value);
  if (key === 'claims.*.semantics.predicate') return SUPPORTED_DETERMINISTIC_CLAIM_RULES.some(rule => rule.id === value);
  return values[key]?.includes(value) ?? false;
}

/** The same allowlisted public declaration is used by runtime and persisted projections. */
export function projectConclusionContractForDisplay(sessionId: string | undefined,
  contract: ConclusionContract | undefined): ConclusionContract | undefined {
  const declared = declaredContractForResult(projectCodeAwareStructuredText(undefined, contract).value);
  if (!declared) return undefined;
  const projected = projectCodeAwareStructuredText(sessionId, declared).value;
  if (!projected) return undefined;
  const restoreLiterals = (original: unknown, output: unknown, path: string[] = []): void => {
    if (!original || !output || typeof original !== 'object' || typeof output !== 'object') return;
    for (const [key, value] of Object.entries(original)) {
      const target = output as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(target, key)) continue;
      const childPath = [...path, key];
      // Constant field names are also subject to canaries/private-query suppression.
      const safeKey = path[path.length - 1] === 'rowSelector'
        ? sanitizeCodeAwareStructuredTextWithReceipt(sessionId, key).text
        : projectCodeAwareProtocolLiteral(sessionId, key);
      if (safeKey !== key) {delete target[key]; continue;}
      if (typeof value === 'string' && literal(childPath, value)) {
        target[key] = projectCodeAwareProtocolLiteral(sessionId, value);
      } else restoreLiterals(value, target[key], childPath);
    }
  };
  restoreLiterals(declared, projected);
  return preserveProjectedFieldOrder(contract, projected);
}

/** Parse the native declaration before applying any output echo replacement. */
export function projectConclusionProtocol(sessionId: string | undefined, raw: string): CodeAwareTextProjectionReceipt {
  // Keep the established size/eviction/revocation limits before parsing untrusted JSON.
  const fallback = sanitizeCodeAwareStructuredTextWithReceipt(sessionId, raw);
  if (fallback.disposition === 'replaced') return fallback;
  const sidecar = parseConclusionContractSidecar(raw);
  const typed = sidecar.status === 'absent' ? parseTypedConclusionContractJson(raw) : undefined;
  const parsed = sidecar.status !== 'absent' ? sidecar : typed;
  if (!parsed || parsed.status === 'absent') return fallback;
  if (parsed.status !== 'valid' || !parsed.contract) {
    // Preserve failure qualification without persisting arbitrary fields from malformed JSON.
    // The original parse remains in the run-bound private declaration, never in this marker.
    const narrative = sidecar.status !== 'absent'
      ? sanitizeCodeAwareStructuredTextWithReceipt(sessionId, sidecar.narrative).text : '';
    const invalid = `${CONCLUSION_CONTRACT_SIDECAR_MARKER}\n\`\`\`json\nnull\n\`\`\`\n-->`;
    return issueCodeAwareStructuredProjectionReceipt(raw, `${invalid}${/^[\r\n]/.test(narrative) ? '' : '\n'}${narrative}`);
  }
  const contract = projectConclusionContractForDisplay(sessionId, parsed.contract);
  if (!contract) return issueCodeAwareStructuredProjectionReceipt(raw, '', true);
  let text: string;
  if (sidecar.status !== 'absent') {
    const segment = sidecar.machineSegments[0];
    // Project the two narrative spans together so matches crossing the hidden protocol remain private.
    const prefix = raw.slice(0, segment.start);
    const suffix = raw.slice(segment.end);
    const narrative = sanitizeCodeAwareStructuredTextWithReceipt(sessionId, prefix + suffix);
    const sidecarText = renderConclusionContractSidecar(contract);
    // Framing is deterministic; presentation order does not carry claim authority.
    text = `${sidecarText}${/^[\r\n]/.test(narrative.text) ? '' : '\n'}${narrative.text}`;
  } else {
    // JSON.stringify performs the required escaping for CodeRefs containing quotes or backslashes.
    const {parseIssues: _issues, bindingEligibility: _eligibility, ...declaration} = contract;
    const payload = JSON.stringify(declaration);
    text = raw.trim().startsWith('```') ? `\`\`\`json\n${payload}\n\`\`\`` : payload;
  }
  const bounded = sanitizeCodeAwareStructuredTextWithReceipt(undefined, text);
  return issueCodeAwareStructuredProjectionReceipt(raw, bounded.text, bounded.disposition === 'replaced');
}

export function issueConclusionProtocolProjection(input: {
  original: NativeConclusionDeclaration; result: AnalysisResult;
  nativeCandidate: AnalysisCandidateIdentity; displayCandidate: AnalysisCandidateIdentity;
}): IssuedConclusionProtocolProjection {
  if (input.nativeCandidate.conclusionFingerprint !== analysisDeliveryFingerprint(input.original.raw) ||
    input.displayCandidate.conclusionFingerprint !== analysisDeliveryFingerprint(input.result.conclusion) ||
    input.nativeCandidate.runId !== input.displayCandidate.runId ||
    input.nativeCandidate.attemptId !== input.displayCandidate.attemptId) {
    throw new Error('conclusion_protocol_projection_identity_mismatch');
  }
  const token: IssuedConclusionProtocolProjection = Object.freeze({kind: 'conclusion_protocol_projection'});
  const state = freeze({sessionId: input.result.sessionId, nativeCandidate: input.nativeCandidate,
    displayCandidate: input.displayCandidate, displayFingerprint: analysisDeliveryFingerprint(input.result.conclusion),
    publicClaimsFingerprint: analysisDeliveryFingerprint(input.result.conclusionContract?.claims),
    publicContractFingerprint: analysisDeliveryFingerprint(input.result.conclusionContract),
    sourceUseFingerprint: analysisDeliveryFingerprint(input.result.sourceUseDecision),
    validationFingerprint: analysisDeliveryFingerprint(input.original), original: input.original});
  nativeDeclarations.set(state.original, token);
  issued.set(token, state);
  return token;
}

export function readConclusionProtocolProjection(token: IssuedConclusionProtocolProjection, input: {
  result: AnalysisResult; candidate: AnalysisCandidateIdentity | undefined; runId: string;
}): NativeConclusionDeclaration {
  const state = issued.get(token);
  if (!state || state.sessionId !== input.result.sessionId || state.nativeCandidate.runId !== input.runId ||
    !sameCandidate(input.candidate, state.displayCandidate) ||
    state.displayFingerprint !== analysisDeliveryFingerprint(input.result.conclusion) ||
    state.publicClaimsFingerprint !== analysisDeliveryFingerprint(input.result.conclusionContract?.claims) ||
    state.publicContractFingerprint !== analysisDeliveryFingerprint(input.result.conclusionContract) ||
    state.sourceUseFingerprint !== analysisDeliveryFingerprint(input.result.sourceUseDecision) ||
    state.validationFingerprint !== analysisDeliveryFingerprint(state.original)) {
    throw new Error('conclusion_protocol_projection_mismatch');
  }
  return state.original;
}

export function claimConclusionProtocolProjection(token: IssuedConclusionProtocolProjection): void {
  if (!issued.has(token) || attached.has(token)) throw new Error('conclusion_protocol_projection_already_claimed');
  attached.add(token);
}

export function releaseConclusionProtocolProjection(token: IssuedConclusionProtocolProjection): void {
  const state = issued.get(token);
  if (state) nativeDeclarations.delete(state.original);
  issued.delete(token);
  attached.delete(token);
}

/** Preserve captured machine inputs and exact native declaration prose on their issued input roles. */
/**
 * Reduce protocol diagnostics to closed-vocabulary triage facts: channel
 * statuses and issue codes, never raw payloads, parser paths or model values.
 * The native path used to drop the whole field because of `rawPayload`; the
 * codes are the only way an `invalid_declarations` verdict stays triageable.
 */
function protocolIssueCodesProjection(diagnostics: unknown): unknown {
  if (!diagnostics || typeof diagnostics !== 'object') return undefined;
  const channels = diagnostics as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  let kept = 0;
  for (const channelName of ['sidecar', 'typedJson', 'conversation']) {
    const channel = channels[channelName];
    if (!channel || typeof channel !== 'object') continue;
    const status = (channel as {status?: unknown}).status;
    if (typeof status !== 'string') continue;
    const issues = (channel as {issues?: unknown}).issues;
    projected[channelName] = {status, triageCodes: Array.isArray(issues) ? conclusionParseIssueTriageCodes(issues) : []};
    kept++;
  }
  return kept > 0 ? projected : undefined;
}

export function projectConclusionSemanticInput(input: {
  sessionId: string; snapshot: FinalSemanticSnapshot; prepared: PreparedClaimEvidence;
  providerQuery?: string; providerSelection?: FinalSemanticSnapshot['selectionScope'];
  nativeDeclaration?: NativeConclusionDeclaration;
  canonicalProjection?: CanonicalAnalysisProjection; canonicalCandidate?: AnalysisCandidateIdentity; runId?: string;
}): {value: FinalSemanticSnapshot; changed: boolean; limited: boolean} {
  let limited = false;
  const projectInput = <T>(sessionId: string | undefined, value: T) => {
    const projected = projectCodeAwareSemanticInputStructure(sessionId, value);
    limited ||= projected.limited;
    return projected;
  };
  let changed = false;
  const trusted = <T>(value: T): T => {
    const bounded = projectInput(undefined, value);
    changed ||= bounded.changed;
    const visit = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const safe = projectCodeAwareAuthorizedInputText(input.sessionId, node);
        changed ||= safe !== node;
        return safe;
      }
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(visit);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        const safeKey = projectCodeAwareAuthorizedInputText(input.sessionId, key);
        if (safeKey !== key) {changed = true; continue;}
        Object.defineProperty(output, key, {value: visit(item), enumerable: true, writable: true, configurable: true});
      }
      return output;
    };
    return visit(bounded.value) as T;
  };
  const trustedSelection = () => {
    const original = input.snapshot.selectionScope;
    const issued = input.providerSelection;
    if (!isDeepStrictEqual(original, issued)) {changed = true; return undefined;}
    if (issued === undefined) return undefined;
    const bounded = projectInput(undefined, issued);
    changed ||= bounded.changed;
    const visit = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const receipt = sanitizeCodeAwareStructuredTextWithReceipt(input.sessionId, node);
        changed ||= receipt.disposition !== 'preserved' || receipt.text !== node;
        return receipt.text;
      }
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(visit);
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
    };
    return visit(bounded.value) as FinalSemanticSnapshot['selectionScope'];
  };
  if (!input.nativeDeclaration || !isIssuedNativeConclusionDeclaration(input.nativeDeclaration)) {
    const {selectionScope: _selectionScope, ...withoutSelection} = input.snapshot;
    const projected = projectInput<FinalSemanticSnapshot>(input.sessionId,
      input.providerQuery === undefined ? withoutSelection : {...withoutSelection, query: ''});
    changed ||= projected.changed;
    const selection = trustedSelection();
    if (selection !== undefined && projected.value) projected.value.selectionScope = selection;
    if (input.providerQuery !== undefined && projected.value) projected.value.query = input.providerQuery;
    return {value: projected.value, changed, limited};
  }
  const contract = declaredContractForResult(input.snapshot.conclusionContract);
  const replacements = new WeakMap<object, Map<string, unknown>>();
  const token = nativeDeclarations.get(input.nativeDeclaration);
  const state = token && attached.has(token) ? issued.get(token) : undefined;
  const projection = input.canonicalProjection;
  const prosePaths = contract && state && projection && isIssuedCanonicalAnalysisProjection(projection) &&
    input.canonicalCandidate && state.sessionId === input.sessionId && state.nativeCandidate.runId === input.runId &&
    state.original === input.nativeDeclaration && state.validationFingerprint === analysisDeliveryFingerprint(input.nativeDeclaration) &&
    sameCandidate(projection.sourceCandidate, state.displayCandidate) && projection.inputFingerprint === state.displayFingerprint &&
    input.canonicalCandidate.runId === state.nativeCandidate.runId && input.canonicalCandidate.attemptId === state.nativeCandidate.attemptId
    ? matchingCanonicalAnalysisProseFields({projection, sessionId: input.sessionId, nativeDeclaration: input.nativeDeclaration,
      sourceCandidate: state.displayCandidate, candidate: input.canonicalCandidate, body: input.snapshot.body, contract}) : [];
  for (const path of prosePaths) {
    let parent: unknown = contract;
    for (const key of path.slice(0, -1)) {
      parent = parent && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, key)
        ? (parent as Record<string, unknown>)[key] : undefined;
    }
    const key = String(path[path.length - 1]);
    if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) continue;
    const target = parent as Record<string, unknown>;
    if (typeof target[key] !== 'string') continue;
    const entries = replacements.get(target) ?? new Map<string, unknown>();
    entries.set(key, trusted(target[key])); replacements.set(target, entries);
    target[key] = null;
  }
  const authorizedReads = new Set<string>();
  const maskReference = (target: Record<string, unknown>, key: string) => {
    const reference = target[key] as ConclusionContractClaimReference | undefined;
    if (!reference || typeof reference !== 'object') return;
    const resolution = preparedReferenceResolution(input.prepared, reference);
    if (!resolution || resolution.status !== 'resolved' || !isIssuedEvidenceReadResolution(resolution) || !resolution.row) return;
    const row = resolution.row;
    if (reference.column !== undefined && !Object.prototype.hasOwnProperty.call(row, reference.column)) return;
    if (Object.prototype.hasOwnProperty.call(reference, 'value') &&
      (reference.column === undefined || reference.value !== row[reference.column])) return;
    if (Object.entries(reference.rowSelector ?? {}).some(([column, value]) => value !== row[column])) return;
    authorizedReads.add(resolution.key);
    const entries = replacements.get(target) ?? new Map<string, unknown>();
    entries.set(key, trusted(reference));
    replacements.set(target, entries);
    target[key] = null;
  };
  const maskList = (references: unknown) => {
    if (Array.isArray(references)) references.forEach((_ref, index) => maskReference(references as unknown as Record<string, unknown>, String(index)));
  };
  for (const claim of contract?.claims ?? []) {
    maskList(claim.references); maskList(claim.artifactRefs);
    maskList(claim.semantics?.scope.subjectRefs); maskList(claim.semantics?.scope.objectRefs);
  }
  for (const relation of contract?.relationProposals ?? []) {
    for (const key of ['subject', 'object', 'proof']) maskReference(relation as unknown as Record<string, unknown>, key);
  }
  // Masked fields are restored after output projection; they are never reparsed as new declarations.
  const contractProjection = projectInput(input.sessionId, contract);
  // Keep fixed validated literals through the same role as display projection.
  const restoreClosed = (original: unknown, projected: unknown, path: string[] = []) => {
    if (!original || !projected || typeof original !== 'object' || typeof projected !== 'object') return;
    for (const [key, value] of Object.entries(original)) {
      const output = projected as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(output, key)) {changed = true; continue;}
      if (projectCodeAwareProtocolLiteral(input.sessionId, key) !== key) {delete output[key]; changed = true; continue;}
      if (typeof value === 'string' && literal([...path, key], value)) output[key] = trusted(value);
      else restoreClosed(value, output[key], [...path, key]);
    }
  };
  restoreClosed(contract, contractProjection.value);
  changed ||= analysisDeliveryFingerprint(contractProjection.value) !== analysisDeliveryFingerprint(contract);
  // Restore to the matching objects in the projected clone by traversing both trees.
  const restoreRefs = (original: unknown, projected: unknown) => {
    if (!original || !projected || typeof original !== 'object' || typeof projected !== 'object') return;
    for (const [key, value] of Object.entries(original)) {
      const replacement = replacements.get(original);
      if (!Object.prototype.hasOwnProperty.call(projected, key)) {changed = true; continue;}
      if (replacement?.has(key)) (projected as Record<string, unknown>)[key] = replacement.get(key);
      else restoreRefs(value, (projected as Record<string, unknown>)[key]);
    }
  };
  restoreRefs(contract, contractProjection.value);
  const evidence = structuredClone(input.snapshot.evidenceSnapshot) as {reads?: Array<Record<string, unknown>>} | undefined;
  const rows: Array<{index: number; row: unknown; columns: unknown}> = [];
  evidence?.reads?.forEach((read, index) => {
    if (!authorizedReads.has(String(read.key)) || read.status !== 'resolved') return;
    const record = read.record as Record<string, unknown>;
    rows.push({index, row: trusted(read.row), columns: trusted(record.columns)});
    read.row = null; record.columns = null;
  });
  const {selectionScope: _selectionScope, ...withoutSelection} = input.snapshot;
  const base = projectInput<FinalSemanticSnapshot>(input.sessionId, {...withoutSelection,
    query: input.providerQuery === undefined ? input.snapshot.query : '',
    conclusionContract: undefined, evidenceSnapshot: evidence, sourceUse: undefined,
    // Native raw payload is private diagnostic state; closed-vocabulary issue
    // codes survive so an ineligible declaration still names its parse failure.
    protocolDiagnostics: protocolIssueCodesProjection(input.snapshot.protocolDiagnostics)});
  changed ||= base.changed;
  if (!base.value) return {value: base.value, changed: true, limited};
  base.value.conclusionContract = contractProjection.value;
  const projectedReads = (base.value.evidenceSnapshot as typeof evidence)?.reads;
  for (const row of rows) {
    const read = projectedReads?.[row.index];
    if (!read || !read.record) {changed = true; continue;}
    read.row = row.row; (read.record as Record<string, unknown>).columns = row.columns;
  }
  base.value.sourceUse = trusted(input.snapshot.sourceUse);
  const selection = trustedSelection();
  if (selection !== undefined) base.value.selectionScope = selection;
  if (input.providerQuery !== undefined) base.value.query = input.providerQuery;
  return {value: base.value, changed, limited};
}
