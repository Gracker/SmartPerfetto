// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {LifecycleConfigReader} from '../evolutionLifecycle/lifecycleConfig';

/**
 * Curated cases reach an analysis two ways, both off by default: retrieval
 * attaches matching cases to the final result, and background injection adds
 * them to the system prompt, which also needs retrieval.
 */
export interface CaseEvolutionConfig {
  retrieveEnabled: boolean;
  promptInjectEnabled: boolean;
}

/**
 * Settings of the retired learned-case pipeline. None is parsed, so no value
 * can stop the backend from starting; startup warns about each one still set.
 */
const RETIRED_CASE_EVOLUTION_SETTINGS = [
  'CASE_EVOLUTION_ENABLED',
  'CASE_EVOLUTION_CAPTURE_ENABLED',
  'CASE_EVOLUTION_REVIEW_ENABLED',
  'CASE_EVOLUTION_NOTES_WRITE_ENABLED',
  'CASE_EVOLUTION_INGEST_ENABLED',
  'CASE_EVOLUTION_INCLUDE_DRAFTS',
  'CASE_EVOLUTION_WORKER_CONCURRENCY',
  'CASE_EVOLUTION_QUEUE_MAX',
  'CASE_EVOLUTION_CANDIDATE_COOLDOWN_MS',
  'CASE_EVOLUTION_DAILY_BUDGET',
  'CASE_EVOLUTION_LEASE_MS',
  'CASE_EVOLUTION_MAX_ATTEMPTS',
  'CASE_EVOLUTION_POLL_INTERVAL_MS',
] as const;

export function loadCaseEvolutionConfig(env: NodeJS.ProcessEnv = process.env): CaseEvolutionConfig {
  const reader = new LifecycleConfigReader(env);
  return {
    retrieveEnabled: reader.boolean('CASE_EVOLUTION_RETRIEVE_ENABLED'),
    promptInjectEnabled: reader.boolean('CASE_EVOLUTION_PROMPT_INJECT_ENABLED'),
  };
}

export function isCaseBackgroundInjectionEnabled(config: CaseEvolutionConfig): boolean {
  return config.retrieveEnabled && config.promptInjectEnabled;
}

/** What startup reports once about the case settings in `env`. */
export function caseEvolutionStartupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = RETIRED_CASE_EVOLUTION_SETTINGS
    .filter(key => (env[key] ?? '').trim() !== '')
    .map(key => `${key} is ignored: learned cases are retired`);
  const config = loadCaseEvolutionConfig(env);
  if (config.promptInjectEnabled && !isCaseBackgroundInjectionEnabled(config)) {
    warnings.push(
      'CASE_EVOLUTION_PROMPT_INJECT_ENABLED requires CASE_EVOLUTION_RETRIEVE_ENABLED; case background injection stays off',
    );
  }
  return warnings;
}
