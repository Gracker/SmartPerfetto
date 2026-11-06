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
});

export type OpenAiTypedFinalContractIdentity = typeof OPENAI_TYPED_FINAL_CONTRACTS[keyof typeof OPENAI_TYPED_FINAL_CONTRACTS];

/** Historical descriptors remain exact; unknown input never selects a default. */
export function getOpenAiTypedFinalContractIdentity(admissionVersion: unknown): OpenAiTypedFinalContractIdentity | undefined {
  switch (admissionVersion) {
    case 'openai_typed_final_admission@1':
    case 'openai_typed_final_admission@2':
    case 'openai_typed_final_admission@3':
      return OPENAI_TYPED_FINAL_CONTRACTS[admissionVersion];
    default:
      return undefined;
  }
}

/** Expected current implementation; callers must separately check actual SDK/profile facts. */
export function expectedOpenAiTypedFinalContract(mode: 'authored_claim_document_v1' | 'authored_claim_document_v2'): OpenAiTypedFinalContractIdentity {
  return OPENAI_TYPED_FINAL_CONTRACTS[mode === 'authored_claim_document_v1'
    ? 'openai_typed_final_admission@1' : 'openai_typed_final_admission@3'];
}

export const OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION = Object.freeze({
  kind: 'assistant', nativeContract: 'openai_native_completion_observer@1',
} as const);

export type OpenAiOutputImplementation = typeof OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION |
  (Readonly<{kind: 'typed'}> & OpenAiTypedFinalContractIdentity);
