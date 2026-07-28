// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {applyEffectiveFeedbackProjection} from '../../agentv3/analysisPatternMemory';
import {backendLogPath} from '../../runtimePaths';
import type {
  AppendFeedbackEventInput,
  AppendFeedbackEventResult,
} from '../../types/selfEvolution';
import {CaseLibrary} from '../caseLibrary';
import {
  openCaseCandidateOutbox,
  type CaseCandidateOutboxHandle,
} from '../caseEvolution/caseCandidateOutbox';
import {
  syncCaseCandidateFeedbackProjection,
  type SyncCaseCandidateFeedbackProjectionResult,
} from '../caseEvolution/caseCandidateFeedback';
import type {KnowledgeScope} from '../scopedKnowledgeStore';
import {
  FeedbackEventStore,
  type FeedbackProjectionTarget,
} from './feedbackEventStore';

export interface FeedbackProjectionServiceOptions {
  store: FeedbackEventStore;
  knowledgeScope: KnowledgeScope;
  openOutbox?: () => CaseCandidateOutboxHandle;
  caseLibrary?: CaseLibrary;
}

export interface AppendAndProjectFeedbackResult
  extends AppendFeedbackEventResult {
  patternStatus: string | null;
  caseCandidateProjection: SyncCaseCandidateFeedbackProjectionResult | null;
}

/**
 * Bridges the durable event/index transaction to the existing Pattern and Case
 * projections. Dirty revisions make this crash-recoverable without pretending
 * that JSONL, SQLite, filesystem pattern stores, and CaseLibrary are one ACID
 * database.
 */
export class FeedbackProjectionService {
  private readonly store: FeedbackEventStore;
  private readonly knowledgeScope: KnowledgeScope;
  private readonly openOutbox: () => CaseCandidateOutboxHandle;
  private readonly caseLibrary: CaseLibrary;

  constructor(options: FeedbackProjectionServiceOptions) {
    this.store = options.store;
    this.knowledgeScope = options.knowledgeScope;
    this.openOutbox = options.openOutbox ?? (() => openCaseCandidateOutbox());
    this.caseLibrary = options.caseLibrary ??
      new CaseLibrary(backendLogPath('case_library.json'));
  }

  async append(
    input: AppendFeedbackEventInput,
  ): Promise<AppendAndProjectFeedbackResult> {
    const appended = await this.store.append(input);
    const projected = await this.projectDirtyTargets();
    const targetId = appended.event.targetId ?? appended.event.sessionId;
    return {
      ...appended,
      patternStatus:
        projected.patternStatuses.get(targetId) ?? null,
      caseCandidateProjection:
        projected.caseCandidates.get(targetId) ?? null,
    };
  }

  async projectDirtyTargets(): Promise<{
    patternStatuses: Map<string, string | null>;
    caseCandidates: Map<string, SyncCaseCandidateFeedbackProjectionResult>;
  }> {
    const patternStatuses = new Map<string, string | null>();
    const caseCandidates =
      new Map<string, SyncCaseCandidateFeedbackProjectionResult>();
    for (const target of this.store.listDirtyTargets()) {
      await this.projectTarget(target, patternStatuses, caseCandidates);
    }
    return {patternStatuses, caseCandidates};
  }

  private async projectTarget(
    target: FeedbackProjectionTarget,
    patternStatuses: Map<string, string | null>,
    caseCandidates: Map<string, SyncCaseCandidateFeedbackProjectionResult>,
  ): Promise<void> {
    const feedback = this.store.getEffectiveForTarget(
      target.targetKind,
      target.targetId,
    );
    if (target.targetKind === 'pattern') {
      const status = await applyEffectiveFeedbackProjection(
        target.targetId,
        feedback,
        this.knowledgeScope,
      );
      if (status === null) throw new Error('feedback_pattern_target_not_found');
      patternStatuses.set(target.targetId, status);
    } else if (target.targetKind === 'case_candidate') {
      const outbox = this.openOutbox();
      try {
        const result = syncCaseCandidateFeedbackProjection({
          candidateId: target.targetId,
          feedback,
          outbox,
          library: this.caseLibrary,
          knowledgeScope: this.knowledgeScope,
        });
        if (!result.found) {
          throw new Error(
            result.reason === 'scope_mismatch'
              ? 'feedback_case_candidate_scope_mismatch'
              : 'feedback_case_candidate_target_not_found',
          );
        }
        caseCandidates.set(target.targetId, result);
      } finally {
        outbox.close();
      }
    }
    if (!this.store.markTargetApplied(target)) {
      throw new Error('feedback_projection_revision_changed');
    }
  }
}
