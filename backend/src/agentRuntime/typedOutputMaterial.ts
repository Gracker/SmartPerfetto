// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {CONCLUSION_PROTOCOL_VALUES} from '../agent/core/conclusionContract';
import {CONCLUSION_AUTHORING_LIMITS} from '../agent/core/conclusionAuthoring';

/** Independent observation domains; none changes the compiler, native budget or tool scope. */
export const TYPED_OUTPUT_MATERIAL_LIMITS = Object.freeze({
  decodedUtf8Bytes: 1_048_576,
  decodedUtf16Chars: 1_048_576,
  retainedUtf8Bytes: 1_048_576,
  identityEntries: 64,
  identityUtf8Bytes: 1_048_576,
  structureNodes: CONCLUSION_AUTHORING_LIMITS.nodes,
  structureDepth: CONCLUSION_AUTHORING_LIMITS.depth,
  normalizedDocumentUtf8Bytes: CONCLUSION_AUTHORING_LIMITS.utf8Bytes,
  // Partitioning is available only for the exact ASCII {document:N} envelope.
  normalizedOuterUtf8Bytes: CONCLUSION_AUTHORING_LIMITS.utf8Bytes + '{"document":}'.length,
});

/** Internal material counts only: no native completion, authorship or proof authority. */
export const TYPED_OUTPUT_WIRE_FINISH_REASONS = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter',
  'insufficient_system_resource', 'aborted', 'other'] as const;
export type RuntimeTypedOutputDecoded = Readonly<{
  utf8Bytes: number; utf16Chars: number;
  utf8Precision: 'exact' | 'lower_bound'; utf16Precision: 'exact' | 'lower_bound';
}>;
export type RuntimeTypedOutputRetention = Readonly<{
  status: 'complete' | 'over_limit' | 'ambiguous' | 'not_retained' | 'not_observed'; retainedUtf8Bytes: number;
}>;
export type RuntimeTypedOutputCollection = Readonly<{status: 'array'; items: number}>
  | Readonly<{status: 'null' | 'missing' | 'wrong_type'}>;
export type RuntimeTypedOutputPartition = Readonly<{status: 'unsupported_shape'}> | Readonly<{
  status: 'measured'; totalNormalizedUtf8Bytes: number; referenceDictionary: number; semanticFrames: number;
  claims: number; bodyParts: number; contractOther: number; overhead: number;
}>;
export type RuntimeTypedOutputStructure = Readonly<{
  status: 'unsupported_shape' | 'resource_limit' | 'not_applicable' | 'not_observed';
}> | Readonly<{
  status: 'measured';
  collections: Readonly<Record<'referenceDictionary' | 'semanticFrames' | 'claims' | 'bodyParts' |
    'relationProposals' | 'sourceClaimBindings', RuntimeTypedOutputCollection>>;
  claimKinds?: Readonly<{
    counts: Readonly<Record<typeof CONCLUSION_PROTOCOL_VALUES.claimKind[number], number>>;
    absent: number; unclassified: number;
  }>;
  bodyParts?: Readonly<{
    literalPartCount: number; literalPartTextUtf8Bytes: number; claimTextUseCount: number; unclassifiedPartCount: number;
  }>;
  explicitNullCount: number;
  /** Available only when both original claims and bodyParts are arrays. */
  exactTextReuse?: Readonly<{
    duplicateClaimTextCount: number; duplicateClaimTextUtf8Bytes: number;
    literalPartMatchingClaimTextCount: number; literalPartMatchingClaimTextUtf8Bytes: number;
  }>;
  partition: RuntimeTypedOutputPartition;
}>;
export interface RuntimeTypedOutputMaterial {
  readonly schemaVersion: 'typed_output_material@1';
  readonly wireToolRole: 'final_role' | 'other_tool' | 'no_tool' | 'ambiguous' | 'unknown';
  readonly transport: Readonly<{
    doneSeen: boolean; eofSeen: boolean; framing: 'valid' | 'invalid' | 'unknown';
    finishReason?: typeof TYPED_OUTPUT_WIRE_FINISH_REASONS[number];
  }>;
  readonly decoded: Readonly<Partial<Record<'arguments' | 'companion' | 'refusal', RuntimeTypedOutputDecoded>>>;
  readonly retention: Readonly<Record<'arguments' | 'companion' | 'refusal', RuntimeTypedOutputRetention> & {
    combinedRetainedUtf8Bytes: number;
  }>;
  readonly json: Readonly<{status: 'complete_json' | 'invalid_json' | 'not_parsed'}>;
  readonly representation: 'authored_claim_document@1' | 'authored_claim_document@2' | 'unknown' | 'not_applicable';
  readonly structure: RuntimeTypedOutputStructure;
}
