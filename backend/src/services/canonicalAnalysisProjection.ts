// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisCandidateIdentity} from '../types/analysisDelivery';

/** Internal receipt; neither this object nor its private manifest enters result JSON. */
export interface CanonicalAnalysisProjection {
  readonly disposition: 'preserved' | 'protocol_projection';
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly sourceCandidate?: Readonly<AnalysisCandidateIdentity>;
  readonly candidate?: Readonly<AnalysisCandidateIdentity>;
}

const issued = new WeakSet<CanonicalAnalysisProjection>();

export function isIssuedCanonicalAnalysisProjection(value: unknown): value is CanonicalAnalysisProjection {
  return typeof value === 'object' && value !== null && issued.has(value as CanonicalAnalysisProjection);
}

/** Called only by canonicalization after selecting the body and binding the candidate. */
export function issueCanonicalAnalysisProjection(input: CanonicalAnalysisProjection): CanonicalAnalysisProjection {
  const projection = Object.freeze({...input,
    ...(input.sourceCandidate ? {sourceCandidate: Object.freeze({...input.sourceCandidate})} : {}),
    ...(input.candidate ? {candidate: Object.freeze({...input.candidate})} : {}),
  });
  issued.add(projection);
  return projection;
}
