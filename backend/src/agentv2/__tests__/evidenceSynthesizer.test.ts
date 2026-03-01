import { describe, expect, it } from '@jest/globals';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import type { PrincipleDecision } from '../contracts/policy';

function createDecision(outcome: PrincipleDecision['outcome']): PrincipleDecision {
  return {
    outcome,
    matchedPrincipleIds: ['evidence-first-conclusion'],
    reasonCodes: ['effect.min_evidence.3'],
    policy: {
      allowedDomains: ['frame'],
      requiredDomains: [],
      blockedDomains: [],
      minEvidenceBeforeConclusion: 3,
      maxOperationSteps: 4,
      requireApprovalForActions: [],
      forceReferencedEntityFocus: false,
      contradictionPriorityBoost: 0,
    },
  };
}

describe('EvidenceSynthesizer', () => {
  it('does not append principles block for allow outcomes', () => {
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '结论正文',
      findings: [],
      decision: createDecision('allow'),
    });

    expect(output.conclusion).toBe('结论正文');
  });

  it('keeps principles block for non-allow outcomes', () => {
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '结论正文',
      findings: [],
      decision: createDecision('require_more_evidence'),
    });

    expect(output.conclusion).toContain('## Principles Applied');
    expect(output.conclusion).toContain('Outcome: require_more_evidence');
  });
});
