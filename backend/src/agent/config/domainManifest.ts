/**
 * Domain Manifest
 *
 * Centralizes domain-level routing preferences and evidence checklist mappings.
 * This reduces hard-coded branching in orchestrator and provides one place
 * to evolve domain behavior for new scenarios.
 */

export type StrategyExecutionPolicy = 'prefer_strategy' | 'prefer_hypothesis';
export type AnalysisPlanModeLike =
  | 'strategy'
  | 'hypothesis'
  | 'clarify'
  | 'compare'
  | 'extend'
  | 'drill_down';

export type SceneTypeGroup =
  | 'startup'
  | 'scroll'
  | 'interaction'
  | 'navigation'
  | 'app_switch'
  | 'idle'
  | 'jank_region'
  | 'all';

export interface SceneReconstructionRouteRule {
  id: string;
  sceneTypes?: string[];
  sceneTypeGroups?: SceneTypeGroup[];
  excludeSceneTypes?: string[];
  agentId: string;
  domain: string;
  directSkillId: string;
  descriptionTemplate: string;
  paramMapping: Record<string, string>;
  skillParams?: Record<string, any>;
  priority?: number;
}

export interface DomainManifest {
  strategyExecutionPolicies: Record<string, StrategyExecutionPolicy>;
  aspectEvidenceMap: Record<string, string[]>;
  modeEvidenceMap: Partial<Record<AnalysisPlanModeLike, string[]>>;
  sceneReconstructionRoutes: SceneReconstructionRouteRule[];
  baselineEvidence: string;
  fallbackEvidence: string[];
}

export interface StrategyLoopDecisionInput {
  strategyId: string;
  forceStrategy?: boolean;
  preferredLoopMode?: string | null;
}

export const DEFAULT_DOMAIN_MANIFEST: DomainManifest = {
  strategyExecutionPolicies: {
    // Deterministic deep-dive paths with stable contracts should keep strategy mode.
    scrolling: 'prefer_strategy',
    startup: 'prefer_strategy',
    scene_reconstruction: 'prefer_strategy',
    scene_reconstruction_quick: 'prefer_strategy',
  },
  aspectEvidenceMap: {
    scrolling: ['滑动会话与区间级 FPS/掉帧率'],
    jank: ['卡顿帧列表、jank 类型分布与严重度'],
    frame: ['App/SF 帧时序、帧预算与超时类型'],
    cpu: ['主线程与关键线程 CPU 调度、频率与等待'],
    memory: ['内存分配热点、GC 暂停与内存压力'],
    binder: ['Binder 调用耗时、阻塞链与锁竞争'],
    startup: ['启动阶段拆解与关键阶段耗时'],
    interaction: ['输入到渲染链路延迟与交互响应'],
    anr: ['阻塞线程、等待对象与 ANR 证据链'],
    system: ['系统负载、热限频、I/O 抖动与后台干扰'],
    gpu: ['GPU 渲染耗时、Fence 等待与合成延迟'],
    render: ['RenderThread/绘制阶段耗时与瓶颈'],
    timeline: ['关键事件时间线与关联区间'],
  },
  modeEvidenceMap: {
    compare: ['对比对象统一口径指标（同窗口/同刷新率）'],
    clarify: ['已确认发现与证据链摘要'],
    drill_down: ['目标实体区间内的逐层证据（frame/cpu/binder/memory）'],
    extend: ['未覆盖实体的同类证据补齐与模式一致性'],
  },
  sceneReconstructionRoutes: [
    {
      id: 'startup_scene',
      sceneTypeGroups: ['startup'],
      agentId: 'startup_agent',
      domain: 'startup',
      directSkillId: 'startup_detail',
      descriptionTemplate: '分析启动场景: {{scopeLabel}}',
      paramMapping: {
        startup_id: 'startupId',
        start_ts: 'startTs',
        end_ts: 'endTs',
        dur_ms: 'durationMs',
        package: 'processName',
        startup_type: 'startupType',
        ttid_ms: 'ttidMs',
        ttfd_ms: 'ttfdMs',
      },
    },
    {
      id: 'non_startup_scene',
      sceneTypeGroups: ['all'],
      excludeSceneTypes: ['cold_start', 'warm_start', 'hot_start'],
      agentId: 'frame_agent',
      domain: 'scroll',
      directSkillId: 'scrolling_analysis',
      descriptionTemplate: '分析帧性能: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
      skillParams: {
        enable_frame_details: false,
      },
    },
  ],
  baselineEvidence: '关键指标基线（时间窗、进程、刷新率口径一致）',
  fallbackEvidence: [
    '帧时序与掉帧统计',
    '线程调度与关键耗时切片',
    'IPC/锁竞争与系统侧干扰指标',
  ],
};

const SCENE_TYPE_GROUPS: Record<Exclude<SceneTypeGroup, 'all'>, string[]> = {
  startup: ['cold_start', 'warm_start', 'hot_start'],
  scroll: ['scroll', 'inertial_scroll'],
  interaction: ['tap', 'long_press'],
  navigation: ['navigation'],
  app_switch: ['app_switch'],
  idle: ['idle'],
  jank_region: ['jank_region'],
};

function normalizeToken(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeStringArray(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values || []) {
    const normalized = normalizeToken(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function collectRouteSceneTypes(route: SceneReconstructionRouteRule): Set<string> {
  const out = new Set<string>();

  for (const sceneType of normalizeStringArray(route.sceneTypes || [])) {
    out.add(sceneType);
  }

  for (const group of route.sceneTypeGroups || []) {
    if (group === 'all') continue;
    for (const sceneType of SCENE_TYPE_GROUPS[group] || []) {
      const normalized = normalizeToken(sceneType);
      if (normalized) out.add(normalized);
    }
  }

  return out;
}

export function getSceneReconstructionRoutes(
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): SceneReconstructionRouteRule[] {
  const routes = Array.isArray(manifest.sceneReconstructionRoutes)
    ? manifest.sceneReconstructionRoutes
    : [];
  return routes.length > 0 ? routes : DEFAULT_DOMAIN_MANIFEST.sceneReconstructionRoutes;
}

export function matchesSceneReconstructionRoute(
  sceneType: string,
  route: SceneReconstructionRouteRule
): boolean {
  const normalizedSceneType = normalizeToken(sceneType);
  if (!normalizedSceneType) return false;

  const excluded = new Set(normalizeStringArray(route.excludeSceneTypes || []));
  if (excluded.has(normalizedSceneType)) return false;

  const hasAllGroup = (route.sceneTypeGroups || []).some(group => group === 'all');
  if (hasAllGroup) return true;

  const included = collectRouteSceneTypes(route);
  if (included.size === 0) return false;

  return included.has(normalizedSceneType);
}

export function resolveSceneReconstructionRoute(
  sceneType: string,
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): SceneReconstructionRouteRule | null {
  for (const route of getSceneReconstructionRoutes(manifest)) {
    if (matchesSceneReconstructionRoute(sceneType, route)) {
      return route;
    }
  }
  return null;
}

export function getStrategyExecutionPolicy(
  strategyId: string,
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): StrategyExecutionPolicy {
  const id = normalizeToken(strategyId);
  if (!id) return 'prefer_hypothesis';
  return manifest.strategyExecutionPolicies[id] || 'prefer_hypothesis';
}

export function shouldPreferHypothesisLoop(
  input: StrategyLoopDecisionInput,
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): boolean {
  if (input.forceStrategy) return false;
  if (normalizeToken(input.preferredLoopMode || '') !== 'hypothesis_experiment') return false;
  const policy = getStrategyExecutionPolicy(input.strategyId, manifest);
  return policy !== 'prefer_strategy';
}

export function getAspectEvidenceChecklist(
  aspects: string[],
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): string[] {
  const rows: string[] = [];
  for (const raw of aspects || []) {
    const key = normalizeToken(raw);
    if (!key) continue;
    const mapped = manifest.aspectEvidenceMap[key];
    if (!mapped) continue;
    rows.push(...mapped);
  }
  return rows;
}

export function getModeSpecificEvidenceChecklist(
  mode: AnalysisPlanModeLike,
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): string[] {
  return [...(manifest.modeEvidenceMap[mode] || [])];
}
