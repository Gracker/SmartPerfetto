// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/** Exact implementation descriptors, not evidence of admission or execution. */
export const OPENAI_TYPED_FINAL_CONTRACTS = Object.freeze({
  'openai_typed_final_admission@1': Object.freeze({
    representationVersion: 'authored_claim_document@1',
    compilerVersion: 'authored_claim_document_compiler@1',
    admissionVersion: 'openai_typed_final_admission@1',
    wireVersion: 'openai_chat_final_wire@1',
  } as const),
  'openai_typed_final_admission@2': Object.freeze({
    representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2',
    admissionVersion: 'openai_typed_final_admission@2',
    wireVersion: 'openai_chat_final_wire@1',
  } as const),
  'openai_typed_final_admission@3': Object.freeze({
    representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2',
    admissionVersion: 'openai_typed_final_admission@3',
    wireVersion: 'openai_chat_final_wire@2',
  } as const),
  'openai_typed_final_admission@4': Object.freeze({
    representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2',
    admissionVersion: 'openai_typed_final_admission@4',
    wireVersion: 'openai_chat_final_wire@3',
  } as const),
});

export type OpenAiTypedFinalContractIdentity = typeof OPENAI_TYPED_FINAL_CONTRACTS[keyof typeof OPENAI_TYPED_FINAL_CONTRACTS];

/** Historical descriptors remain exact; unknown input never selects a default. */
export function getOpenAiTypedFinalContractIdentity(admissionVersion: unknown): OpenAiTypedFinalContractIdentity | undefined {
  switch (admissionVersion) {
    case 'openai_typed_final_admission@1':
    case 'openai_typed_final_admission@2':
    case 'openai_typed_final_admission@3':
    case 'openai_typed_final_admission@4':
      return OPENAI_TYPED_FINAL_CONTRACTS[admissionVersion];
    default:
      return undefined;
  }
}

/** Captured configuration policy only; descriptors do not grant admission or source authority. */
export const FINAL_SUBMISSION_MODE_DESCRIPTORS = Object.freeze({
  assistant_text: Object.freeze({kind: 'assistant'} as const),
  authored_claim_document_v1: Object.freeze({kind: 'typed', requiredDeclarationSyntax: 'canonical_v1',
    sourcePolicy: 'function_only', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@1']} as const),
  authored_claim_document_v2: Object.freeze({kind: 'typed', requiredDeclarationSyntax: 'authoring_v2',
    sourcePolicy: 'function_only', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']} as const),
  authored_claim_document_v2_dual: Object.freeze({kind: 'typed', requiredDeclarationSyntax: 'authoring_v2',
    sourcePolicy: 'function_or_assistant_json', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@4']} as const),
});

export type FinalSubmissionModeKey = keyof typeof FINAL_SUBMISSION_MODE_DESCRIPTORS;
export type AuthoredFinalSubmissionMode = Exclude<FinalSubmissionModeKey, 'assistant_text'>;
export type FinalSubmissionModeDescriptor = typeof FINAL_SUBMISSION_MODE_DESCRIPTORS[FinalSubmissionModeKey];
export type AuthoredFinalSubmissionModeDescriptor = typeof FINAL_SUBMISSION_MODE_DESCRIPTORS[AuthoredFinalSubmissionMode];

export function getFinalSubmissionModeDescriptor(value: unknown): FinalSubmissionModeDescriptor | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FINAL_SUBMISSION_MODE_DESCRIPTORS, value)
    ? FINAL_SUBMISSION_MODE_DESCRIPTORS[value as FinalSubmissionModeKey] : undefined;
}

export function getAuthoredFinalSubmissionModeDescriptor(value: unknown): AuthoredFinalSubmissionModeDescriptor | undefined {
  const descriptor = getFinalSubmissionModeDescriptor(value);
  return descriptor?.kind === 'typed' ? descriptor : undefined;
}

export function isAuthoredFinalSubmissionMode(value: unknown): value is AuthoredFinalSubmissionMode {
  return getAuthoredFinalSubmissionModeDescriptor(value) !== undefined;
}

/** Expected current implementation; callers must separately check actual SDK/profile facts. */
export function expectedOpenAiTypedFinalContract(mode: AuthoredFinalSubmissionMode): OpenAiTypedFinalContractIdentity {
  const descriptor = getAuthoredFinalSubmissionModeDescriptor(mode);
  if (!descriptor) throw new Error('invalid_final_submission_mode');
  return OPENAI_TYPED_FINAL_CONTRACTS[descriptor.admissionVersion];
}

export const OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION = Object.freeze({
  kind: 'assistant', nativeContract: 'openai_native_completion_observer@1',
} as const);

export type OpenAiOutputImplementation = typeof OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION |
  (Readonly<{kind: 'typed'}> & OpenAiTypedFinalContractIdentity);
