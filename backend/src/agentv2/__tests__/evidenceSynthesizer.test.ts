import { describe, expect, it } from '@jest/globals';
import { EvidenceSynthesizer } from '../operations/evidenceSynthesizer';
import type { PrincipleDecision } from '../contracts/policy';
import type { Finding } from '../../agent/types';

function createDecision(
  outcome: PrincipleDecision['outcome'],
  reasonCodes?: string[],
): PrincipleDecision {
  return {
    outcome,
    matchedPrincipleIds: ['evidence-first-conclusion'],
    reasonCodes: reasonCodes ?? ['effect.min_evidence.3'],
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

function createFinding(description: string): Finding {
  return {
    description,
    confidence: 0.8,
    evidence: [],
  } as unknown as Finding;
}

describe('EvidenceSynthesizer', () => {
  it('passes through conclusion without modification', () => {
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '结论正文',
      findings: [],
      decision: createDecision('allow'),
    });

    expect(output.conclusion).toBe('结论正文');
  });

  it('passes through conclusion for non-allow outcomes too', () => {
    // PrincipleEngine now produces correct decisions (turn 0 bypass),
    // so EvidenceSynthesizer no longer needs to patch or append summaries.
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '结论正文',
      findings: [],
      decision: createDecision('require_more_evidence'),
    });

    expect(output.conclusion).toBe('结论正文');
  });

  it('attaches principle evidence to findings', () => {
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '分析完成',
      findings: [createFinding('发现掉帧'), createFinding('CPU 调度延迟')],
      decision: createDecision('allow'),
    });

    expect(output.findings).toHaveLength(2);
    for (const finding of output.findings) {
      expect(finding.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principleId: 'evidence-first-conclusion',
          }),
        ])
      );
    }
  });

  it('does not modify findings when there are none', () => {
    const synthesizer = new EvidenceSynthesizer();
    const output = synthesizer.synthesize({
      originalConclusion: '空分析',
      findings: [],
      decision: createDecision('allow'),
    });

    expect(output.findings).toHaveLength(0);
  });

  it('preserves existing evidence on findings while adding principle refs', () => {
    const synthesizer = new EvidenceSynthesizer();
    const findingWithEvidence = {
      ...createFinding('有证据的发现'),
      evidence: [{ type: 'sql_result', data: 'some query' }],
    } as unknown as Finding;

    const output = synthesizer.synthesize({
      originalConclusion: '完成',
      findings: [findingWithEvidence],
      decision: createDecision('allow'),
    });

    const evidence = output.findings[0]!.evidence!;
    expect(evidence).toHaveLength(2); // original + principle
    expect(evidence[0]).toEqual({ type: 'sql_result', data: 'some query' });
    expect(evidence[1]).toEqual(
      expect.objectContaining({ principleId: 'evidence-first-conclusion' })
    );
  });
});
