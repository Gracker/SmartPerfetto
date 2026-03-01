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

export class EvidenceSynthesizer {
  synthesize(input: EvidenceSynthesisInput): EvidenceSynthesisOutput {
    const normalizedFindings = this.attachPrincipleEvidence(input.findings, input.decision);
    const principleSummary = this.buildPrincipleSummary(input.decision);

    const conclusion = principleSummary.length > 0
      ? `${input.originalConclusion}\n\n${principleSummary}`
      : input.originalConclusion;

    return {
      conclusion,
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

  private buildPrincipleSummary(decision: PrincipleDecision): string {
    // Keep "allow" outputs user-facing and concise.
    // Principle internals remain available via progress events and attached evidence.
    if (decision.outcome === 'allow' || decision.matchedPrincipleIds.length === 0) {
      return '';
    }

    return [
      '## Principles Applied',
      `- Outcome: ${decision.outcome}`,
      `- Matched principles: ${decision.matchedPrincipleIds.join(', ')}`,
      `- Reason codes: ${decision.reasonCodes.join(', ')}`,
    ].join('\n');
  }
}
