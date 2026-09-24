// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ClaudeAnalysisContext} from './types';
import {getFinalReportContract, loadPromptTemplate, renderTemplate} from './strategyLoader';
import {loadSourceUseDecisionPrompt} from '../services/codebase/sourceUseDecision';
import {DEFAULT_OUTPUT_LANGUAGE} from './outputLanguage';
import {resolveRuntimeTurnPolicy, type RuntimeTurnPolicy} from '../agentRuntime/runtimeTurnPolicy';
import {resolveAnalysisInvestigationRequirements} from '../agentRuntime/analysisInvestigationRequirements';
import {CONCLUSION_CONTRACT_SIDECAR_MARKER} from '../agent/core/conclusionContract';
import {SUPPORTED_DETERMINISTIC_CLAIM_RULES} from '../services/verifier/deterministicClaimVerifier';
import {buildFocusAppPromptData, packageProvenance} from '../agentRuntime/focusAppTarget';

/**
 * Rough token estimate for mixed Chinese/English text.
 * Chinese characters are ~1.5 tokens each; English words ~1.3 tokens.
 * This approximation is sufficient for budget enforcement.
 */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    // CJK characters: ~1.5 tokens each
    if (char.charCodeAt(0) > 0x2E80) {
      tokens += 1.5;
    } else {
      tokens += 0.3; // ASCII chars ~0.3 tokens average (space, punctuation, letters)
    }
  }
  return Math.ceil(tokens);
}

/** Input discipline only; never an output-length or conclusion-count limit.
 * Keep mandatory evidence/identity policy intact and measure real typed contexts.
 */
export const MAX_PROMPT_TOKENS = 16_000;

export type PromptTier = 1 | 2 | 3 | 4;

export interface PromptSegment {
  tier: PromptTier;
  /** Stable identifier for tests + logging (e.g. "role", "architecture"). */
  label: string;
  content: string;
  /** Whether the section may be dropped under token pressure. */
  droppable: boolean;
  /** Whether the section may be shortened under token pressure. */
  truncatable?: boolean;
  /** Character count after budget enforcement. */
  charCount: number;
  /** Rough token count after budget enforcement. */
  estimatedTokens: number;
  /** Character count before truncation, when truncation happened. */
  originalCharCount?: number;
  /** Rough token count before truncation, when truncation happened. */
  originalEstimatedTokens?: number;
  /** True when this segment was shortened to satisfy the prompt budget. */
  truncated?: boolean;
}

export interface SystemPromptParts {
  /** Joined Tier 1+2+3 — the cache-friendly prefix. */
  stablePrefix: string;
  /** Joined Tier 4 — varies every query. */
  volatileSuffix: string;
  /** Final string (`stablePrefix + '\n\n' + volatileSuffix` when both non-empty). */
  fullPrompt: string;
  /** Section-level breakdown after budget enforcement. */
  segments: PromptSegment[];
  /** Labels of sections dropped to fit the token budget. */
  droppedLabels: string[];
  /** Labels of sections truncated to fit the token budget. */
  truncatedLabels: string[];
}

function joinSegments(segments: PromptSegment[], tierFilter?: (segment: PromptSegment) => boolean): string {
  return segments
    .filter(segment => segment.content.length > 0)
    .filter(segment => tierFilter ? tierFilter(segment) : true)
    .map(segment => segment.content)
    .join('\n\n');
}

function joinSegmentsWithReplacement(
  segments: PromptSegment[],
  replacementIndex: number,
  replacementContent: string,
): string {
  return segments
    .map((segment, index) => index === replacementIndex ? replacementContent : segment.content)
    .filter(content => content.length > 0)
    .join('\n\n');
}

export function stripTemplateComments(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type TypedTurnPromptContext = Partial<ClaudeAnalysisContext> & {
  runtimeEvidenceContext?: string;
  quickMemoryContext?: string;
};

/** Narrow to broad; a run that gathered less than the intent implies wins. */
const PREFLIGHT_WIDTH: Readonly<Record<RuntimeTurnPolicy['preflight'], number>> =
  {none: 0, trace_facts: 1, full: 2};

/**
 * The run's own preflight, when it narrowed what the intent alone implies. A
 * conversation turn with no attached trace gathers no trace facts, and the
 * prompt must describe that run rather than advertise data nobody read. A
 * caller can only narrow, never widen: the intent's authorization is the
 * ceiling, exactly as it is for the density hint.
 */
function narrowerPreflight(
  policy: RuntimeTurnPolicy['preflight'],
  requested: RuntimeTurnPolicy['preflight'] | undefined,
): RuntimeTurnPolicy['preflight'] {
  if (requested === undefined) return policy;
  return PREFLIGHT_WIDTH[requested] < PREFLIGHT_WIDTH[policy] ? requested : policy;
}

/**
 * The typed path has one presentation contract for every runtime budget. Pinned
 * investigation evidence obligations apply within the question and access scope;
 * legacy scene prose, quick-answer recipes, and lexical plan triggers stay out.
 * Identity, authorization, and evidence obligations are not trimmable context.
 */
function buildTypedTurnSystemPromptParts(
  context: TypedTurnPromptContext,
  maxTokens = MAX_PROMPT_TOKENS,
): SystemPromptParts {
  const intent = context.turnIntent;
  const registry = context.strategyRegistry;
  if (!intent || !registry) throw new Error('[SystemPrompt] Missing typed turn intent or strategy registry pin');
  if (intent.registryFingerprint !== registry.registryFingerprint) {
    throw new Error('[SystemPrompt] Turn intent and strategy registry pin disagree');
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error('[SystemPrompt] Invalid prompt token budget');
  }
  const strategy = registry.getStrategy(intent.sceneId);
  if (intent.status === 'resolved' && (!strategy || strategy.strategyKind === 'contract_only')) {
    throw new Error('[SystemPrompt] Resolved scene is absent from the pinned strategy registry');
  }
  const policy = resolveRuntimeTurnPolicy(intent);
  const onDemandContext = policy.onDemandContext || context.onDemandContext === true;
  // A runtime may have gathered less than the intent alone implies — a
  // conversation turn with no attached trace has no trace to read facts from —
  // and the prompt has to describe the run that happened. Like the density hint
  // above, a caller can only narrow this, never widen it.
  const preflight = narrowerPreflight(policy.preflight, context.preflight);
  const language = context.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const segments: PromptSegment[] = [];
  const push = (tier: PromptTier, label: string, content: string, droppable = false, truncatable = false) => {
    if (!content) return;
    segments.push({tier, label, content, droppable, truncatable,
      charCount: content.length, estimatedTokens: estimatePromptTokens(content)});
  };
  const data = (tier: PromptTier, label: string, value: unknown, droppable = false, truncatable = false) => {
    if (value !== undefined) push(tier, label, JSON.stringify({context: label, data: value}), droppable, truncatable);
  };
  const requiredAsset = (name: string) => {
    const content = stripTemplateComments(loadPromptTemplate(name) ?? '');
    if (!content) throw new Error(`[SystemPrompt] Missing required typed-turn prompt template: ${name}`);
    return content;
  };

  push(1, 'turn_protocol', requiredAsset('prompt-turn-policy'));
  // Inject protocol syntax after authoring comments are removed. Applying the
  // comment stripper to the rendered asset would delete its sidecar example.
  push(1, 'conclusion_declaration', renderTemplate(requiredAsset('prompt-conclusion-contract-schema'), {
    sidecarOpeningMarker: CONCLUSION_CONTRACT_SIDECAR_MARKER,
    supportedProofRules: JSON.stringify(SUPPORTED_DETERMINISTIC_CLAIM_RULES),
  }));
  push(1, 'output_language', requiredAsset(language === 'en' ? 'prompt-language-en' : 'prompt-language-zh'));
  push(1, 'retrieved_context_safety', requiredAsset('retrieved-context-safety'));
  if (policy.allowNewEvidence) push(3, 'sql_discovery_guidance', requiredAsset('knowledge-perfetto-sql'));
  data(3, 'turn_policy', {
    schemaVersion: intent.schemaVersion, status: intent.status, taskKind: intent.taskKind,
    scope: intent.scope, deliverable: intent.deliverable, evidenceAccess: intent.evidenceAccess,
    sceneId: intent.sceneId, registryFingerprint: registry.registryFingerprint, onDemandContext,
    preflight,
  });
  data(3, 'source_authorization', {
    mode: context.codeAwareMode ?? 'off', codebaseIds: context.codebaseIds ?? [],
    evidenceAccess: intent.evidenceAccess,
  });

  // Scene meaning is a trace fact, not a scene-wide budget: a bounded question
  // still has to be read against the scene it is about. Only a run that read no
  // trace facts drops it — `existing_only`, which may acquire nothing, or a
  // runtime with no trace to read — and an unavailable classification,
  // which has no scene to describe, keeps the same neutrality as
  // `scene_strategy_details` below rather than presenting its fallback as one.
  if (preflight !== 'none' && intent.status === 'resolved' && strategy) {
    data(3, 'scene_context', {
      sceneId: strategy.scene, description: strategy.classificationDescription,
      requiredCapabilities: strategy.requiredCapabilities, optionalCapabilities: strategy.optionalCapabilities,
    });
  }
  if (intent.taskKind === 'investigation' || intent.taskKind === 'comparison') {
    data(3, 'investigation_requirements', resolveAnalysisInvestigationRequirements({
      intent, strategyRegistry: registry,
    }));
    push(3, 'investigation_findings', requiredAsset('prompt-investigation-findings'));
    if (intent.status === 'resolved') {
      data(3, 'scene_strategy_details', (strategy?.detailSections ?? []).map(({ref, title}) =>
        ({detailRef: ref, title})));
    }
  }
  if (intent.status === 'resolved' && policy.requiresReport) {
    const contract = getFinalReportContract(intent.sceneId, registry);
    data(3, 'report_requirements', {
      sceneId: intent.sceneId, registryFingerprint: registry.registryFingerprint,
      requirements: (contract?.requiredSections ?? []).map(({id, label, description, required, condition}) =>
        ({id, label, description, required, ...(condition ? {condition} : {})})),
    });
  }

  if (context.codeAwareMode && context.codeAwareMode !== 'off' && context.codebaseIds?.length) {
    if (policy.allowNewEvidence) {
      const sourceUseDecision = loadSourceUseDecisionPrompt({
        codeAwareMode: context.codeAwareMode, codebaseIds: context.codebaseIds, outputLanguage: language,
      });
      if (sourceUseDecision) push(3, 'source_use_decision', stripTemplateComments(sourceUseDecision));
    }
    push(3, 'code_reference_contract', requiredAsset(language === 'en'
      ? 'prompt-code-reference-contract-en' : 'prompt-code-reference-contract-zh'));
    if (context.codeAwareMode === 'provider_send' &&
        (intent.taskKind === 'investigation' || intent.taskKind === 'comparison')) {
      push(3, 'source_finding_binding', requiredAsset('prompt-source-finding-binding'));
    }
  }

  // No architecture guidance, focus-app default target, or probe suggestion is
  // inferred from missing data. These are facts/hints already supplied by the run.
  // The package carries its provenance: only `user` binds the target; an
  // auto-detected package is a ranked hypothesis, and an ambiguous detection
  // renders candidates without any package in effect.
  const focusApp = buildFocusAppPromptData(context.focusTarget);
  const currentPackage = packageProvenance(context.packageName, context.focusTarget);
  data(2, 'trace_context', {
    packageName: context.packageName, packageSource: currentPackage.source,
    packageConfidence: currentPackage.confidence, architecture: context.architecture,
    focusApp, traceOs: context.traceOs, traceFormat: context.traceFormat,
  }, true);
  if (focusApp || currentPackage.source === 'auto_detected') {
    push(2, 'focus_app_guidance', requiredAsset('knowledge-focus-app-context'), true);
  }
  data(2, 'trace_completeness', context.traceCompleteness, true);
  data(2, 'knowledge_base', context.knowledgeBaseContext, true);
  data(3, 'available_agents', context.availableAgents, true);

  // Selection and both sides of a comparison are atomic, non-droppable data.
  // A large description on one side can never evict the other trace's identity.
  data(4, 'selection_context', context.selectionContext);
  if (context.comparison) {
    const comparison = context.comparison;
    const pair = comparison.tracePairContext;
    const referencePackage = packageProvenance(comparison.referencePackageName, comparison.referenceFocusTarget,
      {userMayName: false});
    data(4, 'comparison_identity', {
      referenceTraceId: comparison.referenceTraceId,
      tracePairContext: pair && {
        schemaVersion: pair.schemaVersion, layout: pair.layout,
        primarySide: pair.primarySide, referenceSide: pair.referenceSide, activeSide: pair.activeSide,
        aliases: pair.aliases,
        panes: pair.panes.map(({side, traceSide, traceId, traceFingerprint, active, visualState}) =>
          ({side, traceSide, traceId, traceFingerprint, active, visualState})),
      },
      compareAnchor: comparison.compareAnchor,
      capabilityProbeStatus: comparison.capabilityProbeStatus ?? 'not_checked',
    });
    data(4, 'comparison_details', {
      currentPackageName: context.packageName, currentPackageSource: currentPackage.source,
      referencePackageName: comparison.referencePackageName,
      referencePackageSource: referencePackage.source, referencePackageConfidence: referencePackage.confidence,
      referenceArchitecture: comparison.referenceArchitecture,
      referenceFocusApp: buildFocusAppPromptData(comparison.referenceFocusTarget),
      commonCapabilities: comparison.commonCapabilities, capabilityDiff: comparison.capabilityDiff,
      traceNames: pair?.panes.map(({traceSide, traceName}) => ({traceSide, traceName})),
      workspaceOpen: pair?.workspaceOpen, splitPercent: pair?.splitPercent,
      maximizedTraceSide: pair?.maximizedTraceSide, minimizedTraceSides: pair?.minimizedTraceSides,
    }, true);
  }

  // Keep the supplied history intact unless the actual prompt budget requires a
  // visibly incomplete preview. Never silently turn a missing preview into proof.
  const history = {
    previousFindings: context.previousFindings, analysisNotes: context.analysisNotes,
    conversationSummary: context.conversationSummary, entityContext: context.entityContext,
    previousPlan: context.previousPlan, planHistory: context.planHistory,
    quickMemoryContext: context.quickMemoryContext,
  };
  if (Object.values(history).some(value => value !== undefined)) data(4, 'conversation_context', history, false, true);
  data(4, 'runtime_evidence', context.runtimeEvidenceContext, false, true);
  data(4, 'sql_error_pairs', context.sqlErrorFixPairs, true);
  data(4, 'pattern_context', context.patternContext, true);
  data(4, 'negative_pattern_context', context.negativePatternContext, true);
  data(4, 'case_background_context', context.caseBackgroundContext, true);

  const droppedLabels: string[] = [];
  const truncatedLabels: string[] = [];
  const tokenCount = () => estimatePromptTokens(joinSegments(segments));
  for (let index = segments.length - 1; index >= 0 && tokenCount() > maxTokens; index -= 1) {
    if (!segments[index].droppable) continue;
    droppedLabels.push(segments[index].label);
    segments.splice(index, 1);
  }
  for (let index = segments.length - 1; index >= 0 && tokenCount() > maxTokens; index -= 1) {
    const segment = segments[index];
    if (!segment.truncatable) continue;
    const original = segment.content;
    const preview = (length: number) => JSON.stringify({context: segment.label, data: {
      truncated: true, originalCharCount: original.length, preview: original.slice(0, length),
    }});
    if (estimatePromptTokens(preview(0)) >= segment.estimatedTokens) continue;
    let low = 0;
    let high = original.length;
    let best = preview(0);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = preview(middle);
      if (estimatePromptTokens(joinSegmentsWithReplacement(segments, index, candidate)) <= maxTokens) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    segment.originalCharCount = segment.charCount;
    segment.originalEstimatedTokens = segment.estimatedTokens;
    segment.content = best;
    segment.charCount = best.length;
    segment.estimatedTokens = estimatePromptTokens(best);
    segment.truncated = true;
    truncatedLabels.push(segment.label);
  }
  if (tokenCount() > maxTokens) {
    throw new Error(`[SystemPrompt] Typed turn context exceeds hard budget: ~${tokenCount()} tokens (budget: ${maxTokens})`);
  }
  // Preserve cache order as well as segment metadata in both public builders.
  segments.sort((a, b) => a.tier - b.tier);
  return {
    stablePrefix: joinSegments(segments, segment => segment.tier <= 3),
    volatileSuffix: joinSegments(segments, segment => segment.tier === 4),
    fullPrompt: joinSegments(segments), segments, droppedLabels, truncatedLabels,
  };
}

/** All callers use the same pinned intent, evidence and delivery contract. */
export function buildSystemPromptParts(
  context: TypedTurnPromptContext,
  maxTokens?: number,
): SystemPromptParts {
  return buildTypedTurnSystemPromptParts(context, maxTokens);
}

export function buildSystemPrompt(context: TypedTurnPromptContext, maxTokens?: number): string {
  return buildSystemPromptParts(context, maxTokens).fullPrompt;
}

/** Budget selection never switches to a reduced conclusion contract. */
export function buildQuickSystemPrompt(context: TypedTurnPromptContext, maxTokens?: number): string {
  return buildSystemPromptParts(context, maxTokens).fullPrompt;
}
