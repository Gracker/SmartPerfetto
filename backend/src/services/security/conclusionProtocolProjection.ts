// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {
  CONCLUSION_PROTOCOL_VALUES, CONCLUSION_CONTRACT_SIDECAR_MARKER, declaredContractForResult,
  parseConclusionContractSidecar,
  parseTypedConclusionContractJson, renderConclusionContractSidecar,
  type ConclusionContract,
} from '../../agent/core/conclusionContract';
import {isSourceMechanismStatus} from '../codebase/sourceUseDecision';
import {
  issueCodeAwareStructuredProjectionReceipt, projectCodeAwareProtocolLiteral,
  projectCodeAwareStructuredText, sanitizeCodeAwareStructuredTextWithReceipt,
  type CodeAwareTextProjectionReceipt,
} from './codeAwareOutputRegistry';
import {preserveProjectedFieldOrder} from './analysisDeliveryProjection';
import {SUPPORTED_DETERMINISTIC_CLAIM_RULES} from '../verifier/deterministicClaimVerifier';

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
    'claims.*.semantics.numeric.presentation.schemaVersion': ['numeric_presentation@1'],
    'claims.*.semantics.numeric.presentation.rounding': ['half_away_from_zero'],
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

/**
 * The owner's live protocol projection of a `partially_valid` declaration shows
 * its valid claims plus one closed marker per invalid entry `{id, status:
 * 'invalid', codes}` (plan A.4): nothing from the invalid entry's raw payload
 * is echoed, and the marker cannot be mistaken for a verified claim. The
 * durable stored contract keeps the typed invalid entries with `valid: false`.
 */
function markInvalidClaimsForDisplay(contract: ConclusionContract | undefined): ConclusionContract | undefined {
  const claims = contract?.claims;
  if (!contract || !claims?.some(claim => claim.valid === false)) return contract;
  const {rawClaims: _rawClaims, ...withoutRaw} = contract;
  const marked = claims.map(claim => claim.valid === false
    ? {id: claim.id, status: 'invalid' as const, codes: claim.invalidCodes ?? []}
    : claim);
  return {...withoutRaw, claims: marked} as unknown as ConclusionContract;
}

/** Parse the native declaration before applying any output echo replacement. */
export function projectConclusionProtocol(sessionId: string | undefined, raw: string): CodeAwareTextProjectionReceipt {
  // Keep the established size/eviction/revocation limits before parsing untrusted JSON.
  const fallback = sanitizeCodeAwareStructuredTextWithReceipt(sessionId, raw);
  if (fallback.disposition === 'replaced') return fallback;
  const sidecar = parseConclusionContractSidecar(raw);
  // Shared ingress expands only the private validation view of an authoring frame.
  // `raw` remains the native candidate; public projection below is always canonical full-v1.
  const typed = sidecar.status === 'absent' ? parseTypedConclusionContractJson(raw) : undefined;
  const parsed = sidecar.status !== 'absent' ? sidecar : typed;
  if (!parsed || parsed.status === 'absent') return fallback;
  if ((parsed.status !== 'valid' && parsed.status !== 'partially_valid') || !parsed.contract) {
    // Preserve failure qualification without persisting arbitrary fields from malformed JSON.
    // The original parse remains in the run-bound private declaration, never in this marker.
    const narrative = sidecar.status !== 'absent'
      ? sanitizeCodeAwareStructuredTextWithReceipt(sessionId, sidecar.narrative).text : '';
    const invalid = `${CONCLUSION_CONTRACT_SIDECAR_MARKER}\n\`\`\`json\nnull\n\`\`\`\n-->`;
    return issueCodeAwareStructuredProjectionReceipt(raw, `${invalid}${/^[\r\n]/.test(narrative) ? '' : '\n'}${narrative}`);
  }
  const contract = parsed.status === 'partially_valid'
    ? markInvalidClaimsForDisplay(projectConclusionContractForDisplay(sessionId, parsed.contract))
    : projectConclusionContractForDisplay(sessionId, parsed.contract);
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
