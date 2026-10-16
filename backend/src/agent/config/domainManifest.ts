// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Domain Manifest
 *
 * Centralizes scene reconstruction routing (Stage 2 batch routes and
 * per-event deep-dive routes) in one place.
 */

export type SceneTypeGroup =
  | 'startup'
  | 'scroll'
  | 'interaction'
  | 'navigation'
  | 'app_switch'
  | 'idle'
  | 'device_state'
  | 'jank_region'
  | 'anr'
  | 'all';

export type SceneRouteProfile = 'legacy' | 'smart';

export interface SceneReconstructionRouteRule {
  id: string;
  routeProfile: SceneRouteProfile;
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

/**
 * Scene Deep-Dive Route — maps user-clicked scene events to drill-down skills.
 *
 * Intentionally kept separate from SceneReconstructionRouteRule: Stage2 batch
 * routes match by scene category (coarse), deep-dive routes match by individual
 * event type (fine). The two concepts deliberately do not share a data model.
 */
export interface SceneDeepDiveRoute {
  /** Stable identifier for logs and debugging */
  id: string;
  /** Event types this route matches (e.g. cold_start/warm_start/hot_start) */
  eventTypes: string[];
  /** Skill to execute when user clicks an event of these types */
  skillId: string;
  /** User-facing description (Chinese) */
  description: string;
  /** How to map DisplayedScene fields into skill params */
  paramMapping: Record<string, string>;
  /** Fallback route used when no eventTypes match */
  fallback?: boolean;
}

export interface DomainManifest {
  sceneReconstructionRoutes: SceneReconstructionRouteRule[];
  sceneDeepDiveRoutes: SceneDeepDiveRoute[];
}

export const DEFAULT_DOMAIN_MANIFEST: DomainManifest = {
  sceneReconstructionRoutes: [
    {
      id: 'startup_scene',
      routeProfile: 'legacy',
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
      routeProfile: 'legacy',
      // Whitelist gesture-like scene types only. Earlier this rule used
      // sceneTypeGroups: ['all'] with excludeSceneTypes for the three startup
      // types, which would also catch idle / screen_on/off/sleep / app_switch
      // / scroll_start and route them through scrolling_analysis — none of
      // those scenes have a meaningful Stage 2 analysis path.
      sceneTypeGroups: ['scroll', 'interaction'],
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
    {
      id: 'smart_startup_scene',
      routeProfile: 'smart',
      sceneTypeGroups: ['startup'],
      agentId: 'startup_agent',
      domain: 'startup',
      directSkillId: 'startup_detail',
      descriptionTemplate: '智能分析启动场景: {{scopeLabel}}',
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
      id: 'smart_scroll_scene',
      routeProfile: 'smart',
      // `scroll_start` is a zero-duration marker, useful in the reconstructed
      // timeline but not a valid frame-analysis interval.
      sceneTypes: ['scroll', 'inertial_scroll'],
      agentId: 'frame_agent',
      domain: 'scroll',
      directSkillId: 'scrolling_analysis',
      descriptionTemplate: '智能分析滑动场景: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
      skillParams: {
        enable_frame_details: false,
      },
    },
    {
      id: 'smart_click_scene',
      routeProfile: 'smart',
      sceneTypes: ['tap', 'long_press', 'screen_unlock'],
      agentId: 'interaction_agent',
      domain: 'interaction',
      directSkillId: 'click_response_analysis',
      descriptionTemplate: '智能分析点击响应场景: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
      skillParams: {
        enable_per_event_detail: false,
      },
    },
    {
      id: 'smart_navigation_scene',
      routeProfile: 'smart',
      sceneTypes: ['navigation', 'back_key', 'home_key', 'recents_key', 'window_transition'],
      agentId: 'interaction_agent',
      domain: 'navigation',
      directSkillId: 'navigation_analysis',
      descriptionTemplate: '智能分析导航/返回场景: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
    },
    {
      id: 'smart_anr_scene',
      routeProfile: 'smart',
      sceneTypes: ['anr', 'jank_region'],
      agentId: 'anr_agent',
      domain: 'anr',
      directSkillId: 'anr_analysis',
      descriptionTemplate: '智能分析 ANR/严重卡顿场景: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        process_name: 'processName',
        package: 'processName',
      },
    },
    {
      id: 'smart_device_state_scene',
      routeProfile: 'smart',
      sceneTypeGroups: ['device_state'],
      agentId: 'system_agent',
      domain: 'system',
      directSkillId: 'device_state_snapshot',
      descriptionTemplate: '智能分析设备状态场景: {{scopeLabel}}',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
      },
    },
  ],
  sceneDeepDiveRoutes: [
    {
      id: 'startup_deep_dive',
      eventTypes: ['cold_start', 'warm_start', 'hot_start'],
      skillId: 'startup_analysis',
      description: '启动性能分析',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
        startup_id: 'metadata.startupId',
        startup_type: 'metadata.startupType',
        ttid_ms: 'metadata.ttidMs',
        ttfd_ms: 'metadata.ttfdMs',
      },
    },
    {
      id: 'scroll_deep_dive',
      eventTypes: ['scroll', 'inertial_scroll'],
      skillId: 'scrolling_analysis',
      description: '滑动流畅性分析',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
    },
    {
      id: 'tap_deep_dive',
      eventTypes: ['tap', 'long_press', 'screen_unlock'],
      skillId: 'click_response_analysis',
      description: '点击响应分析',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
    },
    {
      id: 'idle_deep_dive',
      eventTypes: ['idle'],
      skillId: 'device_state_snapshot',
      description: '设备状态快照',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
      },
    },
  ],
};

const SCENE_TYPE_GROUPS: Record<Exclude<SceneTypeGroup, 'all'>, string[]> = {
  startup: ['cold_start', 'warm_start', 'hot_start'],
  scroll: ['scroll', 'inertial_scroll'],
  interaction: ['tap', 'long_press', 'ime_show', 'ime_hide'],
  navigation: ['navigation', 'back_key', 'home_key', 'recents_key', 'window_transition'],
  app_switch: ['app_switch', 'home_screen', 'app_foreground'],
  idle: ['idle'],
  device_state: ['screen_on', 'screen_off', 'screen_sleep', 'idle'],
  jank_region: ['jank_region'],
  anr: ['anr'],
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
  profileOrManifest: SceneRouteProfile | DomainManifest = 'legacy',
  maybeManifest?: DomainManifest
): SceneReconstructionRouteRule[] {
  const routeProfile = typeof profileOrManifest === 'string'
    ? normalizeRouteProfile(profileOrManifest)
    : 'legacy';
  const manifest = typeof profileOrManifest === 'string'
    ? (maybeManifest ?? DEFAULT_DOMAIN_MANIFEST)
    : profileOrManifest;
  const routes = Array.isArray(manifest.sceneReconstructionRoutes)
    ? manifest.sceneReconstructionRoutes
    : [];
  const effectiveRoutes = routes.length > 0 ? routes : DEFAULT_DOMAIN_MANIFEST.sceneReconstructionRoutes;
  return effectiveRoutes.filter((route) => {
    const routeProfileForRule = normalizeRouteProfile(route.routeProfile);
    return routeProfileForRule === routeProfile;
  });
}

/**
 * Get all scene deep-dive routes from manifest, with fallback to defaults.
 */
export function getSceneDeepDiveRoutes(
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): SceneDeepDiveRoute[] {
  const routes = Array.isArray(manifest.sceneDeepDiveRoutes)
    ? manifest.sceneDeepDiveRoutes
    : [];
  return routes.length > 0 ? routes : DEFAULT_DOMAIN_MANIFEST.sceneDeepDiveRoutes;
}

/**
 * Look up a deep-dive route by scene/event type.
 * Returns the first route whose eventTypes includes the given type,
 * or the first fallback route if no match, or null.
 */
export function getSceneDeepDiveRoute(
  eventType: string,
  manifest: DomainManifest = DEFAULT_DOMAIN_MANIFEST
): SceneDeepDiveRoute | null {
  const normalized = String(eventType || '').trim().toLowerCase();
  if (!normalized) return null;
  const routes = getSceneDeepDiveRoutes(manifest);
  for (const route of routes) {
    if (route.eventTypes.some((t) => String(t).toLowerCase() === normalized)) {
      return route;
    }
  }
  const fallback = routes.find((r) => r.fallback);
  return fallback ?? null;
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

/** First route of the list that matches the scene type. */
export function findSceneReconstructionRoute(
  sceneType: string,
  routes: SceneReconstructionRouteRule[],
): SceneReconstructionRouteRule | null {
  return routes.find(route => matchesSceneReconstructionRoute(sceneType, route)) ?? null;
}

function normalizeRouteProfile(value: unknown): SceneRouteProfile {
  if (value === 'legacy' || value === 'smart') return value;
  throw new Error(`Invalid scene reconstruction routeProfile: ${String(value)}`);
}
