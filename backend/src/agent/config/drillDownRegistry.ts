// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Drill-Down Skill Registry
 *
 * Single source of truth for entity -> drill-down skill mapping.
 * Used by both DirectDrillDownExecutor and drillDownResolver to avoid
 * drift when adding new entity types.
 */

export type DrillDownEntityType = 'frame' | 'session' | 'startup';

export interface DrillDownSkillConfig {
  skillId: string;
  domain: string;
  agentId: string;
  /** Reject registered drill-down calls that provide neither an entity nor a complete interval. */
  requiresEntityOrInterval?: boolean;
  paramMapping: Record<string, string>;
  intervalBindings?: ReadonlyArray<{
    skillId: string;
    paramMapping: Record<string, string>;
    dropEntityParamAfterResolution?: boolean;
  }>;
  enrichmentQuery?: string;
}

export const DRILL_DOWN_SKILL_REGISTRY: Record<DrillDownEntityType, DrillDownSkillConfig> = {
  frame: {
    skillId: 'jank_frame_detail',
    domain: 'frame',
    agentId: 'frame_agent',
    requiresEntityOrInterval: true,
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
      package: 'processName',
      frame_id: 'frameId',
      jank_type: 'jankType',
      dur_ms: 'durMs',
      main_start_ts: 'mainStartTs',
      main_end_ts: 'mainEndTs',
      render_start_ts: 'renderStartTs',
      render_end_ts: 'renderEndTs',
      pid: 'pid',
      session_id: 'sessionId',
      layer_name: 'layerName',
      token_gap: 'tokenGap',
      vsync_missed: 'vsyncMissed',
      jank_responsibility: 'jankResponsibility',
      frame_index: 'frameIndex',
    },
    intervalBindings: [
      {
        skillId: 'frame_blocking_calls',
        paramMapping: {
          frame_id: 'frameId',
          start_ts: 'startTs',
          end_ts: 'endTs',
          package: 'processName',
        },
        dropEntityParamAfterResolution: true,
      },
      {
        skillId: 'blocking_chain_analysis',
        paramMapping: {
          frame_id: 'frameId',
          start_ts: 'startTs',
          end_ts: 'endTs',
          package: 'processName',
        },
        dropEntityParamAfterResolution: true,
      },
    ],
    enrichmentQuery: `
      SELECT
        COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
        a.ts as start_ts,
        a.ts + a.dur as end_ts,
        a.dur,
        p.name as process_name,
        a.jank_type,
        a.layer_name,
        NULL as vsync_missed
      FROM actual_frame_timeline_slice a
      LEFT JOIN process p ON a.upid = p.upid
      WHERE COALESCE(a.display_frame_token, a.surface_frame_token) = $frame_id
        AND ($process_name = '' OR p.name = $process_name OR p.name GLOB $process_name || ':*')
      ORDER BY a.ts
      LIMIT 1
    `,
  },
  session: {
    skillId: 'scrolling_analysis',
    domain: 'frame',
    agentId: 'frame_agent',
    paramMapping: {
      start_ts: 'startTs',
      end_ts: 'endTs',
      package: 'processName',
      session_id: 'sessionId',
    },
    enrichmentQuery: `
      SELECT
        session_id,
        MIN(ts) as start_ts,
        MAX(ts + dur) as end_ts,
        process_name
      FROM (
        SELECT
          af.frame_id,
          af.ts,
          af.dur,
          ej.scroll_id as session_id,
          p.name as process_name
        FROM android_frames af
        LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
        LEFT JOIN process p ON af.upid = p.upid
        WHERE ej.scroll_id = $session_id
          AND ($process_name = '' OR p.name = $process_name OR p.name GLOB $process_name || ':*')
      )
      GROUP BY session_id
    `,
  },
  startup: {
    skillId: 'startup_detail',
    domain: 'startup',
    agentId: 'startup_agent',
    paramMapping: {
      startup_id: 'startupId',
      start_ts: 'startTs',
      end_ts: 'endTs',
      dur_ms: 'durMs',
      package: 'processName',
      startup_type: 'startupType',
      ttid_ms: 'ttidMs',
      ttfd_ms: 'ttfdMs',
    },
    enrichmentQuery: `
      SELECT
        s.startup_id,
        s.ts as start_ts,
        s.ts + s.dur as end_ts,
        s.dur / 1e6 as dur_ms,
        s.package as process_name,
        s.startup_type,
        ttd.time_to_initial_display / 1e6 as ttid_ms,
        ttd.time_to_full_display / 1e6 as ttfd_ms
      FROM android_startups s
      LEFT JOIN android_startup_time_to_display ttd USING (startup_id)
      WHERE s.startup_id = $startup_id
        AND ($process_name = '' OR s.package = $process_name OR s.package GLOB $process_name || ':*')
      LIMIT 1
    `,
  },
};

export function isDrillDownEntityType(value: string): value is DrillDownEntityType {
  return value === 'frame' || value === 'session' || value === 'startup';
}

export function getDrillDownSkillConfig(entityType: DrillDownEntityType): DrillDownSkillConfig {
  return DRILL_DOWN_SKILL_REGISTRY[entityType];
}

export function findDrillDownSkillConfig(skillId: string): {
  entityType: DrillDownEntityType;
  config: DrillDownSkillConfig;
  paramMapping: Record<string, string>;
  dropEntityParamAfterResolution: boolean;
  requiresEntityOrInterval: boolean;
} | undefined {
  for (const [entityType, config] of Object.entries(DRILL_DOWN_SKILL_REGISTRY)) {
    if (config.skillId === skillId) {
      return {
        entityType: entityType as DrillDownEntityType,
        config,
        paramMapping: config.paramMapping,
        dropEntityParamAfterResolution: false,
        requiresEntityOrInterval: config.requiresEntityOrInterval === true,
      };
    }
    const binding = config.intervalBindings?.find(candidate => candidate.skillId === skillId);
    if (binding) {
      return {
        entityType: entityType as DrillDownEntityType,
        config,
        paramMapping: binding.paramMapping,
        dropEntityParamAfterResolution: binding.dropEntityParamAfterResolution === true,
        requiresEntityOrInterval: false,
      };
    }
  }
  return undefined;
}
