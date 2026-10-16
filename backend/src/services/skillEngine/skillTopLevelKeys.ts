// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {PipelineDefinition} from '../pipelineSkillLoader';
import type {SkillDefinition} from './types';

/**
 * The top-level keys a Skill YAML may declare. A key nothing reads is not
 * harmless: it reads as configuration that takes effect (a `diagnostics:`
 * block, `thresholds`, a `synthesis` template, vendor `thresholds_override`
 * all sat in the corpus doing nothing, and the public projection rendered
 * them as live). Each set is the type its loader produces, checked at compile
 * time to name every field and nothing else.
 */
const SKILL_DEFINITION_KEYS = {
  investigation_evidence: true, name: true, version: true, type: true, category: true, tier: true,
  meta: true, triggers: true, prerequisites: true, identity: true, inputs: true, context: true,
  steps: true, sql: true, sql_fragments: true, process_scope: true, exact_sql: true, source: true,
  comparison: true, batch_analysis: true, output: true, module: true,
} as const satisfies Record<keyof SkillDefinition, true>;

/**
 * Older spellings `normalizeSkillDefinition` folds into `output.display` and
 * `meta`. It reads them through this type, so a new one must be named here.
 */
export interface LegacySkillSpellings {
  display?: unknown;
  description?: unknown;
  tags?: unknown;
  icon?: unknown;
  display_name?: unknown;
  displayName?: unknown;
}

const LEGACY_SKILL_SPELLINGS = {
  display: true, description: true, tags: true, icon: true, display_name: true, displayName: true,
} as const satisfies Record<keyof LegacySkillSpellings, true>;

const PIPELINE_DEFINITION_KEYS = {
  name: true, version: true, type: true, category: true, meta: true,
  detection: true, teaching: true, auto_pin: true, analysis: true,
} as const satisfies Record<keyof PipelineDefinition, true>;

/** A vendor override as the registry reads it; the hint it yields names only these steps. */
export interface VendorOverrideSource {
  extends: string;
  version?: unknown;
  meta?: Record<string, unknown>;
  vendor_detection?: {
    signatures?: Array<{
      pattern: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
  };
  additional_steps?: unknown[];
}

const VENDOR_OVERRIDE_KEYS = {
  extends: true, version: true, meta: true, vendor_detection: true, additional_steps: true,
} as const satisfies Record<keyof VendorOverrideSource, true>;

const SKILL_KEYS: ReadonlySet<string> = new Set([...Object.keys(SKILL_DEFINITION_KEYS), ...Object.keys(LEGACY_SKILL_SPELLINGS)]);
const PIPELINE_KEYS: ReadonlySet<string> = new Set(Object.keys(PIPELINE_DEFINITION_KEYS));
const VENDOR_KEYS: ReadonlySet<string> = new Set(Object.keys(VENDOR_OVERRIDE_KEYS));

/**
 * Top-level keys of a Skill definition that no loader reads. A pipeline is
 * not normalized, so only a Skill may use the legacy spellings.
 */
export function unknownSkillTopLevelKeys(definition: object): string[] {
  const allowed = (definition as {type?: unknown}).type === 'pipeline_definition' ? PIPELINE_KEYS : SKILL_KEYS;
  return Object.keys(definition).filter(key => !allowed.has(key));
}

/** The message validation reports for a top-level key no loader reads. */
export const UNKNOWN_TOP_LEVEL_KEY_MESSAGE = 'No loader reads this top-level key, so it has no effect.';

/** Top-level keys of a vendor override that the registry does not read. */
export function unknownVendorOverrideKeys(source: object): string[] {
  return Object.keys(source).filter(key => !VENDOR_KEYS.has(key));
}
