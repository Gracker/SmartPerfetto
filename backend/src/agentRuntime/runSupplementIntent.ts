// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate, stripPromptComments} from '../agentv3/strategyLoader';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import {parseStrictJsonObject} from '../utils/llmJson';
import {member} from './analysisTurnIntent';
import type {RunSupplementDecision} from './runSupplementChannel';

const FIELD_ENUMS = {
  goal: ['refine_current_goal', 'add_focus', 'change_goal', 'override_rules'],
  scopeEffect: ['none', 'narrows', 'widens'],
  target: ['current_trace', 'other_trace'],
  evidenceNeed: ['none', 'existing_only', 'new_acquisition'],
  requiredAccess: ['none', 'run_evidence', 'source', 'knowledge', 'other_provider', 'authorization_change'],
  deliverable: ['answer', 'report'],
  budget: ['unchanged', 'more'],
} as const;

type RunSupplementIntentFields = {[K in keyof typeof FIELD_ENUMS]: typeof FIELD_ENUMS[K][number]};

export type RunSupplementIntentDecision = RunSupplementIntentFields & {sceneId: string};

export interface RunSupplementRunFacts {
  sceneId: string;
  evidenceAccess: 'existing_only' | 'read_new';
  deliverable: RunSupplementIntentFields['deliverable'];
  sourceSelected: boolean;
  knowledgeSelected: boolean;
}

export const RUN_SUPPLEMENT_INTENT_OUTPUT_BYTE_LIMIT = 2048;
const PROMPT_BYTE_LIMIT = 64 * 1024;

function selectableScenes(registry: ReadonlyStrategyRegistrySnapshot) {
  return registry.getAllStrategies().filter(scene => scene.strategyKind !== 'contract_only');
}

function hasValidFields(value: Record<string, unknown>): value is Record<string, unknown> & RunSupplementIntentFields {
  return Object.entries(FIELD_ENUMS).every(([field, values]) => member(value[field], values as readonly string[]));
}

/** Closed schema from the pinned registry: strict parsing is the only way into the decision table. */
export function buildRunSupplementIntentSchema(registry: ReadonlyStrategyRegistrySnapshot): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    sceneId: {type: 'string', enum: selectableScenes(registry).map(scene => scene.scene)},
  };
  for (const [field, values] of Object.entries(FIELD_ENUMS)) properties[field] = {type: 'string', enum: values};
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/** Any deviation, including prose around the JSON, fails closed. */
export function parseRunSupplementIntentDecision(
  text: string,
  registry: ReadonlyStrategyRegistrySnapshot,
): RunSupplementIntentDecision | undefined {
  const value = parseStrictJsonObject(text, RUN_SUPPLEMENT_INTENT_OUTPUT_BYTE_LIMIT);
  if (!value) return undefined;
  const keys = ['sceneId', ...Object.keys(FIELD_ENUMS)];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return undefined;
  const scene = typeof value.sceneId === 'string' ? registry.getStrategy(value.sceneId) : undefined;
  if (!scene || scene.strategyKind === 'contract_only') return undefined;
  return hasValidFields(value) ? {...value, sceneId: scene.scene} : undefined;
}

/**
 * Deterministic decision table. A supplement that would change what the run
 * reads, for whom, or at what cost never applies in place: the tools and scope
 * are fixed at run start, so the model's text can only ever change emphasis.
 */
export function decideRunSupplement(
  decision: RunSupplementIntentDecision,
  run: RunSupplementRunFacts,
): RunSupplementDecision {
  if (decision.goal === 'override_rules') return {disposition: 'rejected', reason: 'policy'};
  if (decision.target === 'other_trace') return restart('trace_changed');
  if (decision.requiredAccess === 'other_provider') return restart('provider_changed');
  if (decision.requiredAccess === 'authorization_change') return restart('authorization_changed');
  if ((decision.requiredAccess === 'source' && !run.sourceSelected)
    || (decision.requiredAccess === 'knowledge' && !run.knowledgeSelected)) return restart('needs_selection');
  if (decision.goal === 'change_goal') return restart('goal_changed');
  if (decision.sceneId !== run.sceneId) return restart('scene_changed');
  if (decision.scopeEffect === 'widens') return restart('scope_changed');
  if (decision.evidenceNeed === 'new_acquisition' && run.evidenceAccess === 'existing_only') {
    return restart('evidence_access_changed');
  }
  if (decision.deliverable !== run.deliverable) return restart('deliverable_changed');
  if (decision.budget === 'more') return restart('budget_changed');
  return {disposition: 'in_place'};
}

function restart(reason: Extract<RunSupplementDecision, {disposition: 'restart_required'}>['reason']): RunSupplementDecision {
  return {disposition: 'restart_required', reason};
}

/** Undefined when the template or its size budget is unavailable; callers fail closed. */
export function buildRunSupplementIntentPrompt(input: {
  text: string;
  run: RunSupplementRunFacts;
  registry: ReadonlyStrategyRegistrySnapshot;
  template?: string;
}): string | undefined {
  const template = input.template ?? loadPromptTemplate('prompt-run-supplement-intent');
  if (!template) return undefined;
  const sceneCatalog = selectableScenes(input.registry).map(scene => ({
    id: scene.scene,
    ...(scene.classificationDescription ? {description: scene.classificationDescription} : {}),
  }));
  const prompt = renderTemplate(stripPromptComments(template), {
    decisionSchema: JSON.stringify(buildRunSupplementIntentSchema(input.registry)),
    sceneCatalog: JSON.stringify(sceneCatalog),
    runFacts: JSON.stringify(input.run),
    supplement: JSON.stringify({text: input.text}),
  });
  return Buffer.byteLength(prompt, 'utf8') > PROMPT_BYTE_LIMIT ? undefined : prompt;
}
