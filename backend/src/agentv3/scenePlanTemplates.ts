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

export interface ScenePlanTemplateAspect {
  matchKeywords: string[];
  suggestion: string;
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
  'interaction',
]);

/**
 * Resolve the plan template for a scene. Returns `undefined` for scenes
 * in {@link SCENES_WITHOUT_PLAN_TEMPLATE} or unknown scenes — callers
 * should treat both cases as "skip mandatory-aspect validation".
 */
export function getScenePlanTemplate(scene: SceneType): ScenePlanTemplate | undefined {
  return SCENE_PLAN_TEMPLATES[scene];
}

/** Enumerated scene keys that have a non-empty plan template. */
export function listScenePlanTemplateKeys(): SceneType[] {
  return Object.keys(SCENE_PLAN_TEMPLATES);
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
}

/**
 * Detect mandatory aspects of a scene's plan template that a submitted
 * `phases` array fails to mention. Returns empty arrays for scenes without
 * a template or when all aspects are covered.
 *
 * Pure function — both `submit_plan` and `revise_plan` delegate here so
 * the hard-gate cannot be bypassed by silently re-issuing a plan via the
 * revise endpoint.
 */
export function validatePlanAgainstSceneTemplate(
  phases: ReadonlyArray<{ name: string; goal: string; expectedTools: string[] }>,
  scene: SceneType | undefined,
): PlanValidationResult {
  const template = scene ? getScenePlanTemplate(scene) : undefined;
  if (!template) return { warnings: [], missingAspectIds: [] };

  const planText = phases
    .map(p => `${p.name} ${p.goal} ${p.expectedTools.join(' ')}`)
    .join(' ')
    .toLowerCase();

  const warnings: string[] = [];
  const missingAspectIds: string[] = [];
  for (const aspect of template.mandatoryAspects) {
    const covered = aspect.matchKeywords.some(kw => planText.includes(kw.toLowerCase()));
    if (!covered) {
      warnings.push(aspect.suggestion);
      missingAspectIds.push(aspect.matchKeywords[0]);
    }
  }
  return { warnings, missingAspectIds };
}
