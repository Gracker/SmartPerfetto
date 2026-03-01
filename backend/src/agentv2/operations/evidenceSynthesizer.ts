import type { Finding } from '../../agent/types';
import type { PrincipleDecision } from '../contracts/policy';

export interface EvidenceSynthesisInput {
  originalConclusion: string;
  findings: Finding[];
  decision: PrincipleDecision;
}

export interface EvidenceSynthesisOutput {
  conclusion: string;
  findings: Finding[];
}

/**
 * Post-execution evidence synthesis.
 *
 * Responsibilities:
 *   1. Attach principle metadata to findings for traceability
 *   2. Pass through conclusion (principle internals stay in SSE progress events)
 *
 * Architecture note (2026-03-01 review):
 *   resolveEffectiveDecision() was removed because PrincipleEngine now skips
 *   the evidence check on turn 0 (no prior evidence expected). The previous
 *   pattern — PrincipleEngine always produces 'require_more_evidence',
 *   EvidenceSynthesizer retroactively patches to 'allow' — was a feedback
 *   loop where governance decisions were systematically overridden.
 */
export class EvidenceSynthesizer {
  synthesize(input: EvidenceSynthesisInput): EvidenceSynthesisOutput {
    const normalizedFindings = this.attachPrincipleEvidence(input.findings, input.decision);

    return {
      conclusion: input.originalConclusion,
      findings: normalizedFindings,
    };
  }

  private attachPrincipleEvidence(findings: Finding[], decision: PrincipleDecision): Finding[] {
    if (findings.length === 0) {
      return findings;
    }

    const principleEvidence = decision.matchedPrincipleIds.map(id => ({
      principleId: id,
      reasonCodes: decision.reasonCodes,
    }));

    return findings.map(finding => ({
      ...finding,
      evidence: [...(Array.isArray(finding.evidence) ? finding.evidence : []), ...principleEvidence],
    }));
  }
}
