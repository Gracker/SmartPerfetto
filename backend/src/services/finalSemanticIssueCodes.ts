// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto

/** Claim issue codes accepted from the final semantic review response. */
export const SEMANTIC_ISSUE_CODES = [
  'kind_mismatch', 'predicate_mismatch', 'polarity_mismatch', 'discourse_mismatch',
  'modality_mismatch', 'quantifier_mismatch', 'scope_mismatch', 'numeric_mismatch',
  'declaration_not_expressed', 'unclear_semantics',
] as const;
export type SemanticIssueCode = typeof SEMANTIC_ISSUE_CODES[number];

/** Verifier issue codes recorded from an inconsistent semantic claim review. */
export const semanticClaimIssueCode = (code: SemanticIssueCode): string => `semantic_${code}`;
export const SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE = 'semantic_undeclared_claim';
/**
 * A `numeric_mismatch` whose located text shows the declared exact value
 * rounded at its displayed precision: an unmarked approximation, recorded as a
 * warning. It contradicts no value, so it cannot fail the claim.
 */
export const SEMANTIC_NUMERIC_DISPLAY_ROUNDING_ISSUE_CODE = 'semantic_numeric_display_rounding';
const SEMANTIC_CLAIM_ISSUE_CODES: ReadonlySet<string> = new Set(SEMANTIC_ISSUE_CODES.map(semanticClaimIssueCode));
export const isSemanticClaimIssueCode = (code: string): boolean => SEMANTIC_CLAIM_ISSUE_CODES.has(code);
