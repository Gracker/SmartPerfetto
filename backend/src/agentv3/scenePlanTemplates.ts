// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Scene plan templates — mandatory aspects per scene type, used by
 * `submit_plan` / `revise_plan` to validate that an agent's plan covers
 * scene-critical phases.
 *
 * Keys MUST match `*.strategy.md` frontmatter `scene:` ids (underscore
 * form for compound names — `touch_tracking`, NOT `touch-tracking`).
 * A hyphen-form key silently disables hard-gate for the affected scene;
 * the coverage test guards against that regression.
 */

import type { SceneType } from './sceneClassifier';
import {
  getPlanTemplate as getPlanTemplateFromFrontmatter,
  getRegisteredScenes,
} from './strategyLoader';
import {buildSourceInvestigationPlanAspect} from './sourceInvestigationPolicy';
import type {SourceInvestigationPlanAspect} from './sourceInvestigationPolicy';
import {isSourceLookupToolName} from '../services/codebase/sourceLookupTools';
import type { ExpectedCall } from './types';

export interface ScenePlanTemplateAspect {
  /**
   * Stable identifier for the aspect — populated when the template comes
   * from strategy frontmatter (Phase 2.1) and synthesised from the first
   * matchKeyword for legacy hardcoded entries.
   */
  id?: string;
  matchKeywords: string[];
  /** Enforce this aspect only when the submitted plan mentions one of these terms. */
  triggerKeywords?: string[];
  suggestion: string;
  requiredExpectedCalls?: ExpectedCall[];
  alternativeExpectedCalls?: ExpectedCall[];
  /** Calls selected by detected context; every matching group is additive. */
  conditionalRequiredExpectedCalls?: Array<{
    triggerKeywords: string[];
    requiredExpectedCalls: ExpectedCall[];
  }>;
  /** Defaults to true. Set false in strategy frontmatter for hard plan gates. */
  waivable?: boolean;
}

export interface ScenePlanTemplate {
  mandatoryAspects: ScenePlanTemplateAspect[];
}

const SCENE_PLAN_TEMPLATES: Partial<Record<SceneType, ScenePlanTemplate>> = {
  scrolling: {
    mandatoryAspects: [
      { matchKeywords: ['frame', 'jank', 'scroll', '帧', '卡顿', '滑动', 'scrolling_analysis', 'consumer_jank'],
        suggestion: '滑动场景建议包含帧渲染/卡顿分析阶段 (scrolling_analysis, consumer_jank_detection)' },
      { matchKeywords: ['root', 'cause', 'diagnos', '根因', '诊断', '深入', 'deep', 'jank_frame_detail'],
        suggestion: '滑动场景建议包含卡顿帧根因分析阶段 (jank_frame_detail)' },
    ],
  },
  startup: {
    mandatoryAspects: [
      { matchKeywords: ['startup', 'ttid', 'ttfd', 'launch', '启动', 'startup_analysis'],
        suggestion: '启动场景建议包含启动耗时测量阶段 (startup_analysis)' },
      { matchKeywords: ['phase', 'breakdown', 'block', '阶段', '分解', '阻塞', 'startup_detail'],
        suggestion: '启动场景建议包含启动阶段分解和阻塞因素分析' },
      { matchKeywords: ['type', 'cold', 'warm', 'hot', 'bindApplication', '类型', '冷启动', '温启动', '热启动', '判定'],
        suggestion: '启动场景建议验证启动类型 (cold/warm/hot)：bindApplication 存在→冷启动，仅 performCreate→温启动' },
    ],
  },
  anr: {
    mandatoryAspects: [
      { matchKeywords: ['anr', 'deadlock', 'block', '死锁', '阻塞', 'not_responding', 'anr_analysis'],
        suggestion: 'ANR 场景建议包含 ANR 原因定位阶段 (anr_analysis)' },
    ],
  },
  teaching: {
    mandatoryAspects: [
      { matchKeywords: ['detect_architecture', 'architecture', '架构', 'pipeline', '管线', '教学'],
        suggestion: '教学场景建议包含架构检测阶段 (detect_architecture)' },
      { matchKeywords: ['teach', 'explain', '说明', '解释', 'thread', '线程', 'slice', 'mermaid', 'invoke_skill'],
        suggestion: '教学场景建议包含管线教学内容获取阶段 (invoke_skill with pipeline skill)' },
    ],
  },
  scroll_response: {
    mandatoryAspects: [
      { matchKeywords: ['input', 'gesture', 'motion', 'action_move', '输入', '手势', '触摸', 'input_events'],
        suggestion: '滑动响应场景建议包含输入事件定位阶段 (input event detection)' },
      { matchKeywords: ['latency', 'response', 'delay', '延迟', '响应', '分解', 'breakdown', '首帧'],
        suggestion: '滑动响应场景建议包含端到端延迟分解阶段 (latency breakdown)' },
    ],
  },
  pipeline: {
    mandatoryAspects: [
      { matchKeywords: ['detect_architecture', 'architecture', '架构', '检测', 'detection'],
        suggestion: '管线识别场景建议包含架构自动检测阶段 (detect_architecture)' },
      { matchKeywords: ['pipeline', '管线', 'mermaid', 'thread', '线程', 'teaching', '教学', 'invoke_skill'],
        suggestion: '管线识别场景建议包含管线教学内容展示阶段 (pipeline skill invocation)' },
    ],
  },
  memory: {
    mandatoryAspects: [
      { matchKeywords: ['memory', 'oom', 'gc', '内存', 'heap', 'lmk', 'memory_analysis'],
        suggestion: '内存场景建议包含内存使用趋势和 GC 分析阶段 (memory_analysis)' },
    ],
  },
  game: {
    mandatoryAspects: [
      { matchKeywords: ['game', 'fps', '游戏', 'gpu', 'frame', '帧率'],
        suggestion: '游戏场景建议包含帧率分析和 GPU 状态检查阶段' },
    ],
  },
  overview: {
    mandatoryAspects: [
      { matchKeywords: ['scene', 'overview', '场景', '概览', 'detect', '检测', 'timeline'],
        suggestion: '概览场景建议包含场景检测和问题场景深钻阶段' },
    ],
  },
  touch_tracking: {
    mandatoryAspects: [
      { matchKeywords: ['input', 'touch', '跟手', '延迟', 'latency', 'per_frame', 'tracking'],
        suggestion: '跟手度场景建议包含逐帧 Input-to-Display 延迟测量阶段' },
    ],
  },
};

/**
 * Scenes that intentionally have no mandatory plan aspects. Listing them
 * explicitly distinguishes "deliberately absent" from "accidentally
 * missing" (forgotten when adding a new scene).
 */
export const SCENES_WITHOUT_PLAN_TEMPLATE: ReadonlySet<SceneType> = new Set([
  'general',
]);

/**
 * Resolve the plan template for a scene. Returns `undefined` for scenes
 * in {@link SCENES_WITHOUT_PLAN_TEMPLATE}, unknown scenes, or scenes that
 * have deliberately opted out via empty `mandatoryAspects`.
 *
 * Phase 2.1 of v2.1 — strategies that ship a `plan_template:` block in
 * their `*.strategy.md` frontmatter take priority. The hardcoded
 * `SCENE_PLAN_TEMPLATES` map remains as a fallback for scenes that have
 * not yet migrated; once every scene migrates it can be removed.
 */
export function getScenePlanTemplate(scene: SceneType): ScenePlanTemplate | undefined {
  const fromFrontmatter = getPlanTemplateFromFrontmatter(scene);
  if (fromFrontmatter && fromFrontmatter.mandatoryAspects.length > 0) {
    return fromFrontmatter;
  }
  return SCENE_PLAN_TEMPLATES[scene];
}

/**
 * Enumerated scene keys that have a non-empty plan template — covers
 * both frontmatter-sourced and legacy hardcoded scenes.
 */
export function listScenePlanTemplateKeys(): SceneType[] {
  const keys = new Set<SceneType>(Object.keys(SCENE_PLAN_TEMPLATES));
  for (const def of getRegisteredScenes()) {
    const frontmatterTemplate = getPlanTemplateFromFrontmatter(def.scene);
    if (frontmatterTemplate && frontmatterTemplate.mandatoryAspects.length > 0) {
      keys.add(def.scene);
    }
  }
  return Array.from(keys);
}

export interface PlanValidationResult {
  /** Human-readable suggestions for any uncovered aspect (one per aspect). */
  warnings: string[];
  /**
   * Stable handles for the missing aspects, derived from the first
   * matchKeyword. Lets callers (e.g. revise_plan diff) tell whether the
   * same aspects keep recurring across attempts.
   */
  missingAspectIds: string[];
  /** Missing aspects that explicitly disallow plan-level waivers/force-accept. */
  nonWaivableMissingAspectIds?: string[];
  /** Machine-readable expectedCall requirements for each uncovered aspect. */
  missingAspectRequirements?: Array<{
    aspectId: string;
    requiredExpectedCalls: ExpectedCall[];
    alternativeExpectedCalls: ExpectedCall[];
  }>;
}

export interface PlanValidationOptions {
  /**
   * Extra text outside the submitted plan that should trigger conditional
   * aspects, e.g. user query keywords or cached architecture detection.
   * It is not used to mark an aspect as covered; only phase text and
   * expectedCalls can cover the aspect.
   */
  triggerContext?: string | readonly string[];
  /** Opt in only for a Full analysis with an authorized codebase selection. */
  sourceInvestigation?: {
    mode: 'code_aware_full';
    /** A bounded decision already accepted by the source-use control surface. */
    decision?: SourceInvestigationDecisionRecord;
  };
}

export interface SourceInvestigationDecisionRecord {
  status: string;
  reason: string;
}

/** Minimum justification length for a waiver to be accepted. */
export const MIN_WAIVER_REASON_CHARS = 50;
const MIN_SOURCE_DECISION_REASON_CHARS = 30;

function shortToolName(toolName: string): string {
  const MCP_PREFIX = 'mcp__smartperfetto__';
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

function expectedCallMatchesExpectedCall(required: ExpectedCall, declared: ExpectedCall): boolean {
  if (shortToolName(required.tool) !== shortToolName(declared.tool)) return false;
  if (required.skillId && required.skillId !== declared.skillId) return false;
  return true;
}

function formatExpectedCallForPlanText(call: ExpectedCall): string {
  const tool = shortToolName(call.tool);
  return call.skillId ? `${tool} ${call.skillId} ${tool}(${call.skillId})` : tool;
}

function uniqueExpectedCalls(calls: readonly ExpectedCall[]): ExpectedCall[] {
  const seen = new Set<string>();
  return calls.filter(call => {
    const key = `${shortToolName(call.tool)}\u0000${call.skillId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceAspectCovered(
  aspect: SourceInvestigationPlanAspect,
  declaredExpectedCalls: readonly ExpectedCall[],
  decision: SourceInvestigationDecisionRecord | undefined,
): boolean {
  const structuredLookup = declaredExpectedCalls.some(call =>
    isSourceLookupToolName(call.tool),
  );
  if (structuredLookup) return true;
  return Boolean(
    decision &&
    aspect.decisionStatuses.includes(decision.status) &&
    decision.reason.trim().length >= MIN_SOURCE_DECISION_REASON_CHARS,
  );
}

/**
 * Detect mandatory aspects of a scene's plan template that a submitted
 * `phases` array fails to mention. Returns empty arrays for scenes without
 * a template or when all aspects are covered.
 *
 * `waivers` is an optional set of agent-declared opt-outs; a waivable aspect with
 * a matching `aspectId` and a `reason` of at least
 * {@link MIN_WAIVER_REASON_CHARS} characters is treated as covered.
 *
 * Pure function — both `submit_plan` and `revise_plan` delegate here so
 * the hard-gate cannot be bypassed by silently re-issuing a plan via the
 * revise endpoint.
 */
export function validatePlanAgainstSceneTemplate(
  phases: ReadonlyArray<{ name: string; goal: string; expectedTools?: string[]; expectedCalls?: ExpectedCall[] }>,
  scene: SceneType | undefined,
  waivers?: ReadonlyArray<{ aspectId: string; reason: string }>,
  options: PlanValidationOptions = {},
): PlanValidationResult {
  const template = scene ? getScenePlanTemplate(scene) : undefined;
  const mandatoryAspects = [...(template?.mandatoryAspects ?? [])];
  let sourceAspect: SourceInvestigationPlanAspect | undefined;
  if (scene && options.sourceInvestigation?.mode === 'code_aware_full') {
    sourceAspect = buildSourceInvestigationPlanAspect(scene);
    if (sourceAspect) {
      if (mandatoryAspects.some(aspect => aspect.id === sourceAspect!.id)) {
        throw new Error(`source_investigation_aspect_duplicate:${scene}`);
      }
      mandatoryAspects.push(sourceAspect);
    }
  }
  if (mandatoryAspects.length === 0) return { warnings: [], missingAspectIds: [] };

  const planText = phases
    .map(p => `${p.name} ${p.goal} ${(p.expectedTools ?? []).join(' ')} ${(p.expectedCalls ?? []).map(formatExpectedCallForPlanText).join(' ')}`)
    .join(' ')
    .toLowerCase();
  const triggerContext = typeof options.triggerContext === 'string'
    ? options.triggerContext
    : (options.triggerContext ?? []).join(' ');
  const triggerText = `${planText} ${triggerContext}`.toLowerCase();
  const detectedContextText = triggerContext.toLowerCase();
  const declaredExpectedCalls = phases.flatMap(p => p.expectedCalls ?? []);

  const acceptedWaiverIds = new Set(
    (waivers ?? [])
      .filter(w => typeof w.reason === 'string' && w.reason.trim().length >= MIN_WAIVER_REASON_CHARS)
      .map(w => w.aspectId),
  );

  const warnings: string[] = [];
  const missingAspectIds: string[] = [];
  const nonWaivableMissingAspectIds: string[] = [];
  const missingAspectRequirements: NonNullable<PlanValidationResult['missingAspectRequirements']> = [];
  for (const aspect of mandatoryAspects) {
    const aspectId = aspect.id || aspect.matchKeywords[0];
    const waivable = aspect.waivable !== false;
    if (waivable && acceptedWaiverIds.has(aspectId)) continue;
    if ((aspect.triggerKeywords ?? []).length > 0 &&
      !aspect.triggerKeywords!.some(kw => triggerText.includes(kw.toLowerCase()))) {
      continue;
    }
    const covered = sourceAspect === aspect
      ? sourceAspectCovered(
          sourceAspect,
          declaredExpectedCalls,
          options.sourceInvestigation?.decision,
        )
      : aspect.matchKeywords.some(kw => planText.includes(kw.toLowerCase()));
    const matchedConditionalGroups = (aspect.conditionalRequiredExpectedCalls ?? [])
      .filter(group => group.triggerKeywords.some(keyword =>
        detectedContextText.includes(keyword.toLowerCase()),
      ));
    const requiredCalls = uniqueExpectedCalls([
      ...(aspect.requiredExpectedCalls ?? []),
      ...matchedConditionalGroups.flatMap(group => group.requiredExpectedCalls),
    ]);
    const missingRequiredCalls = requiredCalls
      .filter(required => !declaredExpectedCalls.some(declared =>
        expectedCallMatchesExpectedCall(required, declared),
      ));
    const alternatives = matchedConditionalGroups.length > 0
      ? []
      : aspect.alternativeExpectedCalls ?? [];
    const missingAlternative = alternatives.length > 0 &&
      !alternatives.some(required => declaredExpectedCalls.some(declared =>
        expectedCallMatchesExpectedCall(required, declared),
      ));
    if (!covered || missingRequiredCalls.length > 0 || missingAlternative) {
      warnings.push(aspect.suggestion);
      missingAspectIds.push(aspectId);
      missingAspectRequirements.push({
        aspectId,
        requiredExpectedCalls: requiredCalls.map(call => ({ ...call })),
        alternativeExpectedCalls: alternatives.map(call => ({ ...call })),
      });
      if (!waivable) nonWaivableMissingAspectIds.push(aspectId);
    }
  }
  return {
    warnings,
    missingAspectIds,
    ...(nonWaivableMissingAspectIds.length > 0 ? { nonWaivableMissingAspectIds } : {}),
    ...(missingAspectRequirements.length > 0 ? { missingAspectRequirements } : {}),
  };
}
