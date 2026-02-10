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
  paramMapping: Record<string, string>;
  enrichmentQuery?: string;
}

export const DRILL_DOWN_SKILL_REGISTRY: Record<DrillDownEntityType, DrillDownSkillConfig> = {
  frame: {
    skillId: 'jank_frame_detail',
    domain: 'frame',
    agentId: 'frame_agent',
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
