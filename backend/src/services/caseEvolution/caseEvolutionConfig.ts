// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseEvolutionConfig } from '../../types/caseEvolution';
import {LifecycleConfigReader} from '../evolutionLifecycle/lifecycleConfig';

export function loadCaseEvolutionConfig(env: NodeJS.ProcessEnv = process.env): CaseEvolutionConfig {
  const reader = new LifecycleConfigReader(env);
  return {
    captureEnabled: reader.boolean('CASE_EVOLUTION_CAPTURE_ENABLED'),
    reviewEnabled: reader.boolean('CASE_EVOLUTION_REVIEW_ENABLED'),
    notesWriteEnabled: reader.boolean('CASE_EVOLUTION_NOTES_WRITE_ENABLED'),
    ingestEnabled: reader.boolean('CASE_EVOLUTION_INGEST_ENABLED'),
    retrieveEnabled: reader.boolean('CASE_EVOLUTION_RETRIEVE_ENABLED'),
    promptInjectEnabled: reader.boolean('CASE_EVOLUTION_PROMPT_INJECT_ENABLED'),
    includeDrafts: reader.boolean('CASE_EVOLUTION_INCLUDE_DRAFTS'),
    workerConcurrency: reader.positiveInteger(
      'CASE_EVOLUTION_WORKER_CONCURRENCY',
      1,
      {max: 2},
    ),
    queueMax: reader.positiveInteger('CASE_EVOLUTION_QUEUE_MAX', 100),
    cooldownMs: reader.positiveInteger(
      'CASE_EVOLUTION_CANDIDATE_COOLDOWN_MS',
      5 * 60 * 1000,
    ),
    dailyBudget: reader.positiveInteger('CASE_EVOLUTION_DAILY_BUDGET', 50),
    leaseMs: reader.positiveInteger(
      'CASE_EVOLUTION_LEASE_MS',
      5 * 60 * 1000,
    ),
    maxAttempts: reader.positiveInteger('CASE_EVOLUTION_MAX_ATTEMPTS', 3),
    pollIntervalMs: reader.positiveInteger(
      'CASE_EVOLUTION_POLL_INTERVAL_MS',
      60 * 1000,
    ),
  };
}

export interface CaseEvolutionConfigValidation {
  ok: boolean;
  effectiveConfig: CaseEvolutionConfig;
  warnings: string[];
  errors: string[];
}

export function validateCaseEvolutionConfig(
  config: CaseEvolutionConfig,
): CaseEvolutionConfigValidation {
  const effectiveConfig = {...config};
  const warnings: string[] = [];
  const errors: string[] = [];

  if (effectiveConfig.reviewEnabled && !effectiveConfig.captureEnabled) {
    warnings.push('REVIEW_ENABLED requires CAPTURE_ENABLED; disabling review worker');
    effectiveConfig.reviewEnabled = false;
  }
  if (effectiveConfig.notesWriteEnabled && !effectiveConfig.reviewEnabled) {
    warnings.push('NOTES_WRITE_ENABLED requires REVIEW_ENABLED; disabling sidecar writes');
    effectiveConfig.notesWriteEnabled = false;
  }
  if (effectiveConfig.ingestEnabled && !effectiveConfig.reviewEnabled) {
    warnings.push('INGEST_ENABLED requires REVIEW_ENABLED; disabling learned-case ingest');
    effectiveConfig.ingestEnabled = false;
  }
  if (effectiveConfig.promptInjectEnabled && !effectiveConfig.retrieveEnabled) {
    errors.push('PROMPT_INJECT_ENABLED requires RETRIEVE_ENABLED; disabling prompt injection');
    effectiveConfig.promptInjectEnabled = false;
  }
  if (
    effectiveConfig.includeDrafts &&
    (!effectiveConfig.retrieveEnabled || !effectiveConfig.promptInjectEnabled)
  ) {
    errors.push('INCLUDE_DRAFTS requires RETRIEVE_ENABLED and PROMPT_INJECT_ENABLED; disabling draft inclusion');
    effectiveConfig.includeDrafts = false;
  }

  return {
    ok: errors.length === 0,
    effectiveConfig,
    warnings,
    errors,
  };
}

export function isCaseEvolutionCaptureEnabled(config: CaseEvolutionConfig): boolean {
  return config.captureEnabled;
}

export function isCaseEvolutionReviewEnabled(config: CaseEvolutionConfig): boolean {
  return config.reviewEnabled;
}

export function isCaseEvolutionNotesWriteEnabled(config: CaseEvolutionConfig): boolean {
  return config.notesWriteEnabled;
}

export function isCaseEvolutionRetrieveEnabled(config: CaseEvolutionConfig): boolean {
  return config.retrieveEnabled;
}
