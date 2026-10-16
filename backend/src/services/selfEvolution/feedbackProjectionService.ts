// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {applyEffectiveFeedbackProjection} from '../../agentv3/analysisPatternMemory';
import type {
  AppendFeedbackEventInput,
  AppendFeedbackEventResult,
} from '../../types/selfEvolution';
import type {KnowledgeScope} from '../scopedKnowledgeStore';
import {FeedbackEventStore} from './feedbackEventStore';

export interface FeedbackProjectionServiceOptions {
  store: FeedbackEventStore;
  knowledgeScope: KnowledgeScope;
}

export interface AppendAndProjectFeedbackResult
  extends AppendFeedbackEventResult {
  patternStatus: string | null;
}

/**
 * Bridges the durable event/index transaction to the Pattern projection.
 * Dirty revisions make this crash-recoverable without pretending that JSONL,
 * SQLite and filesystem pattern stores are one ACID database. Targets without
 * a projection (sessions, findings, claims, ...) are marked applied as they
 * are; the store never lists a retired target as dirty, so it is never marked.
 */
export class FeedbackProjectionService {
  private readonly store: FeedbackEventStore;
  private readonly knowledgeScope: KnowledgeScope;

  constructor(options: FeedbackProjectionServiceOptions) {
    this.store = options.store;
    this.knowledgeScope = options.knowledgeScope;
  }

  async append(
    input: AppendFeedbackEventInput,
  ): Promise<AppendAndProjectFeedbackResult> {
    const appended = await this.store.append(input);
    const patternStatuses = await this.projectDirtyTargets();
    const targetId = appended.event.targetId ?? appended.event.sessionId;
    return {
      ...appended,
      patternStatus: patternStatuses.get(targetId) ?? null,
    };
  }

  async projectDirtyTargets(): Promise<Map<string, string | null>> {
    const patternStatuses = new Map<string, string | null>();
    for (const target of this.store.listDirtyTargets()) {
      if (target.targetKind === 'pattern') {
        const status = await applyEffectiveFeedbackProjection(
          target.targetId,
          this.store.getEffectiveForTarget(target.targetKind, target.targetId),
          this.knowledgeScope,
        );
        if (status === null) throw new Error('feedback_pattern_target_not_found');
        patternStatuses.set(target.targetId, status);
      }
      if (!this.store.markTargetApplied(target)) {
        throw new Error('feedback_projection_revision_changed');
      }
    }
    return patternStatuses;
  }
}
