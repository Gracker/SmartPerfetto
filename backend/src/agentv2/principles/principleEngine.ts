import type {
  DecisionContext,
  PrincipleDecision,
  PrincipleOutcome,
} from '../contracts/policy';
import { compileOperationPolicy } from './policyCompiler';
import { PrincipleRegistry } from './principleRegistry';

const OUTCOME_PRIORITY: Record<PrincipleOutcome, number> = {
  allow: 1,
  require_more_evidence: 2,
  require_approval: 3,
  deny: 4,
};

export class PrincipleEngine {
  private readonly registry: PrincipleRegistry;

  constructor(registry: PrincipleRegistry = new PrincipleRegistry()) {
    this.registry = registry;
  }

  decide(context: DecisionContext): PrincipleDecision {
    const compiled = compileOperationPolicy(context, this.registry.listActive());
    const reasonCodes = [...compiled.reasonCodes];
    let outcome = compiled.decisionFloor;

    if (compiled.policy.allowedDomains.length === 0) {
      outcome = strongerOutcome(outcome, 'deny');
      reasonCodes.push('policy.no_allowed_domains');
    }

    const requiredBlockedConflict = compiled.policy.requiredDomains.some(domain =>
      compiled.policy.blockedDomains.includes(domain)
    );
    if (requiredBlockedConflict) {
      outcome = strongerOutcome(outcome, 'deny');
      reasonCodes.push('policy.required_domain_blocked');
    }

    const approvalNeeded = context.requestedActions.some(action =>
      compiled.policy.requireApprovalForActions.includes(action)
    );
    if (approvalNeeded) {
      outcome = strongerOutcome(outcome, 'require_approval');
      reasonCodes.push('policy.approval_required_for_action');
    }

    // Skip evidence check on turn 0: first analysis has no prior evidence by
    // definition.  Previously this always fired `require_more_evidence` on the
    // first turn, which EvidenceSynthesizer then silently patched to 'allow'
    // post-execution — a feedback loop that produced stale governance decisions.
    if (
      context.turnIndex > 0 &&
      context.evidenceCount < compiled.policy.minEvidenceBeforeConclusion
    ) {
      outcome = strongerOutcome(outcome, 'require_more_evidence');
      reasonCodes.push('policy.insufficient_evidence');
    }

    if (context.contradictionCount > 0 && compiled.policy.contradictionPriorityBoost > 0) {
      outcome = strongerOutcome(outcome, 'require_more_evidence');
      reasonCodes.push('policy.contradiction_investigation_required');
    }

    return {
      outcome,
      reasonCodes: unique(reasonCodes),
      matchedPrincipleIds: compiled.matchedPrincipleIds,
      policy: compiled.policy,
    };
  }

  getRegistry(): PrincipleRegistry {
    return this.registry;
  }
}

function strongerOutcome(current: PrincipleOutcome, candidate: PrincipleOutcome): PrincipleOutcome {
  return OUTCOME_PRIORITY[candidate] > OUTCOME_PRIORITY[current] ? candidate : current;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
