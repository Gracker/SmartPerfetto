// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  EvalCaseV1,
  RunManifestScope,
  RunManifestV1,
} from '../../types/selfEvolution';
import {LifecycleConfigReader} from '../evolutionLifecycle/lifecycleConfig';
import {ScopedLeaseLostError} from '../evolutionLifecycle/scopedOutbox';
import {analyzeCurationHypotheses} from './curationAnalyzer';
import {selectSingleCurationCandidate} from './curationCoordinator';
import type {
  CurationDiagnostic,
  CurationRunObservation,
} from './curationContracts';
import {
  isCanonicalPublicFeedbackCurationSource,
  type PublicFeedbackCurationSource,
} from './feedbackEventStore';
import {
  generateCurationProposal,
  loadProposalTemplate,
  type ProposalBodyExecutor,
} from './proposalGenerator';
import {ProposalStore} from './proposalStore';
import {proposeRetireInjectionHypotheses} from './retireInjectionProposer';

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export interface CurationManifestSource {
  get(
    scope: RunManifestScope,
    runManifestId: string,
  ): RunManifestV1 | undefined;
}

export interface CurationEvalCaseSource {
  listCases(scope: RunManifestScope): EvalCaseV1[];
}

export interface RunCurationResult {
  proposal: CurationProposalV1 | null;
  diagnostics: CurationDiagnostic[];
  observationsAnalyzed: number;
}

/**
 * Explicit M6 entrypoint. No timer, startup scan, or flag-driven background
 * loop calls this service.
 */
export class CurationService {
  constructor(private readonly dependencies: {
    manifests: CurationManifestSource;
    evalCases: CurationEvalCaseSource;
    proposals: ProposalStore;
    executeProposalReview?: ProposalBodyExecutor;
    workerOwner?: string;
    clock?: () => number;
  }) {}

  async runExplicit(input: {
    scope: RunManifestScope;
    source: unknown;
    env?: NodeJS.ProcessEnv;
  }): Promise<RunCurationResult> {
    const diagnostics: CurationDiagnostic[] = [];
    const config = new LifecycleConfigReader(input.env).boolean(
      'SELF_EVOLUTION_ENABLED',
    );
    if (!config) {
      return {
        proposal: null,
        diagnostics: [{code: 'curation_disabled'}],
        observationsAnalyzed: 0,
      };
    }
    if (!isCanonicalPublicFeedbackCurationSource(input.source)) {
      return {
        proposal: null,
        diagnostics: [{
          code: 'curation_source_rejected',
          details: {
            requiredVisibility: 'public_scoped',
            requiredDurability: 'durable',
          },
        }],
        observationsAnalyzed: 0,
      };
    }
    const source = input.source as PublicFeedbackCurationSource;
    if (!sameScope(source.scope, input.scope)) {
      return {
        proposal: null,
        diagnostics: [{code: 'curation_scope_mismatch'}],
        observationsAnalyzed: 0,
      };
    }

    const evalCases = this.dependencies.evalCases.listCases(input.scope);
    const effectiveFeedback = await source.listEffective();
    const observations = effectiveFeedback.flatMap(feedback => {
      if (!feedback.runManifestId) {
        diagnostics.push({
          code: 'curation_feedback_manifest_missing',
          details: {feedbackId: feedback.feedbackId},
        });
        return [];
      }
      const manifest = this.dependencies.manifests.get(
        input.scope,
        feedback.runManifestId,
      );
      if (!manifest) {
        diagnostics.push({
          code: 'curation_feedback_manifest_missing',
          details: {
            feedbackId: feedback.feedbackId,
            runManifestId: feedback.runManifestId,
          },
        });
        return [];
      }
      if (
        feedback.runId !== manifest.runId ||
        feedback.sessionId !== manifest.sessionId ||
        !sameScope(feedback.scope, manifest.scope)
      ) {
        diagnostics.push({
          code: 'curation_feedback_manifest_mismatch',
          details: {feedbackId: feedback.feedbackId},
        });
        return [];
      }
      const matchingCases = evalCases.filter(evalCase =>
        evalCase.origin === 'labeled_run' &&
        evalCase.sourceRunId === manifest.runId &&
        sameScope(evalCase.scope, input.scope) &&
        evalCase.label?.rating === feedback.rating &&
        sameStringSet(
          evalCase.label.dimensions,
          feedback.dimensions,
        ));
      if (matchingCases.length === 0) {
        diagnostics.push({
          code: 'curation_eval_case_missing',
          details: {
            feedbackId: feedback.feedbackId,
            runId: manifest.runId,
          },
        });
        return [];
      }
      if (matchingCases.length !== 1) {
        diagnostics.push({
          code: 'curation_eval_case_ambiguous',
          details: {
            feedbackId: feedback.feedbackId,
            runId: manifest.runId,
            count: matchingCases.length,
          },
        });
        return [];
      }
      const traceContentHashes = uniqueSorted(
        matchingCases[0].traces.map(trace => trace.contentHash),
      );
      if (
        traceContentHashes.length === 0 ||
        traceContentHashes.some(hash => !CONTENT_HASH_RE.test(hash))
      ) {
        diagnostics.push({
          code: 'curation_eval_case_missing',
          details: {
            feedbackId: feedback.feedbackId,
            runId: manifest.runId,
            reason: 'trace_hash_missing',
          },
        });
        return [];
      }
      const observation: CurationRunObservation = {
        feedback,
        manifest,
        evalCase: matchingCases[0],
        traceContentHashes,
      };
      return [observation];
    });

    const technical = analyzeCurationHypotheses({observations});
    const retirement = proposeRetireInjectionHypotheses(observations);
    diagnostics.push(...technical.diagnostics, ...retirement.diagnostics);
    const template = loadProposalTemplate();
    if (!template) {
      diagnostics.push({
        code: 'proposal_not_generated',
        details: {reason: 'template_missing'},
      });
      return {
        proposal: null,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    const selected = selectSingleCurationCandidate({
      candidates: [
        ...technical.candidates,
        ...retirement.candidates,
      ],
      templateContentHash: template.contentHash,
    });
    if (!selected) {
      diagnostics.push({code: 'proposal_not_generated'});
      return {
        proposal: null,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    const existing = this.dependencies.proposals.getByIdempotencyKey(
      input.scope,
      selected.idempotencyKey,
    );
    if (existing) {
      return {
        proposal: existing,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    const enqueued = this.dependencies.proposals.enqueue(selected);
    const now = this.dependencies.clock?.() ?? Date.now();
    this.dependencies.proposals.expireStaleLeases(now);
    const leased = this.dependencies.proposals.leaseNext({
      scope: input.scope,
      jobId: enqueued.jobId,
      owner: this.dependencies.workerOwner ??
        `self-evolution-curation-${process.pid}`,
      now,
    });
    if (!leased) {
      diagnostics.push({
        code: 'proposal_not_generated',
        details: {reason: 'job_not_leasable'},
      });
      return {
        proposal: null,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    const generated = await generateCurationProposal({
      candidate: leased.job.candidate,
      template: template.content,
      execute: this.dependencies.executeProposalReview,
      now: () => new Date(this.dependencies.clock?.() ?? Date.now()),
    });
    if (!generated.ok || !generated.proposal) {
      try {
        this.dependencies.proposals.failLease(
          leased.fence,
          generated.details?.join('; ') ?? generated.reason ??
            'proposal generation failed',
          3,
          this.dependencies.clock?.() ?? Date.now(),
        );
      } catch (error) {
        if (!(error instanceof ScopedLeaseLostError)) throw error;
      }
      diagnostics.push({
        code: generated.reason === 'input_rejected'
          ? 'proposal_input_rejected'
          : generated.reason === 'output_rejected'
            ? 'proposal_output_rejected'
            : 'proposal_review_failed',
        details: {errors: generated.details ?? []},
      });
      return {
        proposal: null,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    try {
      this.dependencies.proposals.completeDraft(
        leased.fence,
        generated.proposal,
        this.dependencies.clock?.() ?? Date.now(),
      );
    } catch (error) {
      if (!(error instanceof ScopedLeaseLostError)) throw error;
      diagnostics.push({
        code: 'proposal_not_generated',
        details: {reason: 'completion_lease_lost'},
      });
      return {
        proposal: null,
        diagnostics,
        observationsAnalyzed: observations.length,
      };
    }
    return {
      proposal: generated.proposal,
      diagnostics,
      observationsAnalyzed: observations.length,
    };
  }
}

function sameScope(
  left: RunManifestScope,
  right: RunManifestScope,
): boolean {
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
