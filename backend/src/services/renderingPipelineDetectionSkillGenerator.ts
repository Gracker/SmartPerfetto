// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillDefinition } from './skillEngine/types';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  renderingTypeSource,
  type PipelineCatalog,
  type PipelineCatalogEntry,
  type PipelineDefinition,
} from './pipelineSkillLoader';

import {buildLayerSignalsSql, renderingAppScopeSql} from './renderingPipelineOutputEvidence';

type ScopeColumn = 'app_cnt' | 'global_cnt';
type SignalSource = 't' | 's';
type SignalOp = 'eq' | 'glob';
type SignalScope = 'a' | 'g';

interface SignalComponent {
  source: SignalSource;
  op: SignalOp;
  pattern: string;
}

const SCORE_THRESHOLD = 0.3;
const MAX_CANDIDATES = 5;

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValueLiteral(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return sqlStringLiteral(value);
}

function normalizePositiveInt(value: unknown, fallback = 1): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeNonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function getScopeColumn(entry: PipelineCatalogEntry): ScopeColumn {
  return entry.signal_scope === 'global' ? 'global_cnt' : 'app_cnt';
}

function getSignalScope(entry: PipelineCatalogEntry): SignalScope {
  return getScopeColumn(entry) === 'global_cnt' ? 'g' : 'a';
}

function buildSignalComponents(signal: {
  thread?: string;
  thread_pattern?: string;
  slice?: string;
  slice_pattern?: string;
  slice_patterns?: string[];
}): SignalComponent[] {
  const components: SignalComponent[] = [];

  if (signal.thread) {
    components.push({ source: 't', op: 'eq', pattern: signal.thread });
  }
  if (signal.thread_pattern) {
    components.push({ source: 't', op: 'glob', pattern: signal.thread_pattern });
  }
  if (signal.slice) {
    components.push({ source: 's', op: 'eq', pattern: signal.slice });
  }
  if (signal.slice_pattern) {
    components.push({ source: 's', op: 'glob', pattern: signal.slice_pattern });
  }
  for (const pattern of signal.slice_patterns || []) {
    components.push({ source: 's', op: 'glob', pattern });
  }

  return components;
}

function describeSignalKey(signal: {
  thread?: string;
  thread_pattern?: string;
  slice?: string;
  slice_pattern?: string;
  slice_patterns?: string[];
}): string {
  if (signal.thread) return `thread:${signal.thread}`;
  if (signal.thread_pattern) return `thread_pattern:${signal.thread_pattern}`;
  if (signal.slice) return `slice:${signal.slice}`;
  if (signal.slice_pattern) return `slice_pattern:${signal.slice_pattern}`;
  if (signal.slice_patterns) return `slice_patterns:${signal.slice_patterns.join('|')}`;
  return 'unknown';
}

function buildPipelineListSql(pipelines: PipelineDefinition[], defaultPipelineId: string): string {
  if (pipelines.length === 0) {
    return `(${sqlStringLiteral(defaultPipelineId)})`;
  }
  return pipelines
    .map((p) => `(${sqlStringLiteral(p.meta.pipeline_id)})`)
    .join(',\n        ');
}

function buildPipelineMetadataSql(catalog: PipelineCatalog): string {
  return Object.entries(catalog.pipelines)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pipelineId, entry]) => {
      return `(${[
        pipelineId, entry.rendering_type_id ?? null, entry.output_path ?? null,
        entry.feature_visible && entry.signal_scope === 'app' ? 1 : 0, renderingTypeSource(entry.teaching_type_id),
      ].map(sqlValueLiteral).join(', ')})`;
    })
    .join(',\n        ');
}

function buildPipelineRelatedRenderingTypesSql(catalog: PipelineCatalog): string {
  return Object.entries(catalog.pipelines)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([pipelineId, entry]) =>
      (entry.related_rendering_type_ids || [])
        .slice()
        .sort()
        .map(
          (renderingTypeId) =>
            `(${sqlStringLiteral(pipelineId)}, ${sqlStringLiteral(renderingTypeId)})`,
        ),
    )
    .join(',\n        ');
}

function buildSignalDefsSql(
  pipelines: PipelineDefinition[],
  entries: Record<string, PipelineCatalogEntry>,
  defaultPipelineId: string
): string {
  const rows: string[] = [];
  let signalId = 0;

  const addSignal = (
    pipelineId: string,
    signalType: 'r' | 's' | 'e',
    signalName: string,
    weight: number,
    minCount: number,
    signal: {
      thread?: string;
      thread_pattern?: string;
      slice?: string;
      slice_pattern?: string;
      slice_patterns?: string[];
    }
  ): void => {
    const components = buildSignalComponents(signal);
    if (components.length === 0) return;

    const currentSignalId = signalId++;
    const entry = entries[pipelineId];
    if (!entry) throw new Error(`Missing catalog entry for ${pipelineId}`);
    const scope = getSignalScope(entry);

    for (const component of components) {
      rows.push(`(${[
        currentSignalId,
        pipelineId,
        signalType,
        signalName,
        weight,
        minCount,
        component.source,
        component.op,
        component.pattern,
        scope,
      ].map(sqlValueLiteral).join(', ')})`);
    }
  };

  for (const pipeline of pipelines) {
    const pipelineId = pipeline.meta.pipeline_id;
    const detection = pipeline.detection;
    if (!detection) continue;

    for (const req of detection.required_signals || []) {
      const minCount = normalizePositiveInt(req.min_count, 1);
      if (buildSignalComponents(req).length === 0) {
        console.warn(`[rendering_pipeline_detection] Invalid required_signals entry for ${pipelineId}:`, req);
        continue;
      }
      addSignal(pipelineId, 'r', describeSignalKey(req), 0, minCount, req);
    }

    for (const sc of detection.scoring_signals || []) {
      const minCount = normalizePositiveInt(sc.min_count, 1);
      const weight = normalizeNonNegativeInt(sc.weight, 0);
      if (buildSignalComponents(sc).length === 0) {
        console.warn(`[rendering_pipeline_detection] Invalid scoring_signals entry for ${pipelineId} (${sc.signal}):`, sc);
        continue;
      }
      addSignal(pipelineId, 's', sc.signal, weight, minCount, sc);
    }

    for (const ex of detection.exclude_if || []) {
      if (buildSignalComponents(ex).length === 0) {
        console.warn(`[rendering_pipeline_detection] Invalid exclude_if entry for ${pipelineId}:`, ex);
        continue;
      }
      addSignal(pipelineId, 'e', describeSignalKey(ex), 0, 1, ex);
    }
  }

  if (rows.length === 0) {
    return `(0, ${sqlStringLiteral(defaultPipelineId)}, 's', 'noop', 0, 1, 's', 'eq', '__smartperfetto_noop__', 'a')`;
  }

  return rows.join(',\n        ');
}

function buildPipelineScoresSql(pipelines: PipelineDefinition[], catalog: PipelineCatalog): string {
  const pipelineListSql = buildPipelineListSql(pipelines, catalog.default.pipeline_id);
  const signalDefsSql = buildSignalDefsSql(
    pipelines,
    catalog.pipelines,
    catalog.default.pipeline_id
  );

  return `
      WITH
      ${renderingAppScopeSql},
      thread_counts AS (
        SELECT
          t.name as thread_name,
          SUM(CASE WHEN t.upid IN (SELECT upid FROM app_filter_upids) THEN 1 ELSE 0 END) as app_cnt,
          COUNT(*) as global_cnt
        FROM thread t
        WHERE t.name IS NOT NULL
        GROUP BY t.name
      ),
      slice_counts AS (
        SELECT
          s.name as slice_name,
          SUM(CASE WHEN p.upid IN (SELECT upid FROM app_filter_upids) THEN 1 ELSE 0 END) as app_cnt,
          COUNT(*) as global_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
        GROUP BY s.name
      ),
      pipeline_list(pipeline_id) AS (
        VALUES
        ${pipelineListSql}
      ),
      signal_defs(signal_id, pipeline_id, signal_type, signal_name, weight, min_count, source, op, pattern, scope) AS (
        VALUES
        ${signalDefsSql}
      ),
      signal_name_matches AS (
        SELECT
          sd.signal_id,
          sd.pipeline_id,
          sd.signal_type,
          sd.signal_name,
          sd.weight,
          sd.min_count,
          COALESCE(tc.thread_name, sc.slice_name) as source_name,
          -- Each source count is already grouped by the actual recorded name.
          -- Multiple alias patterns matching that name must contribute it once.
          MAX(
            CASE
              WHEN sd.source = 't' THEN CASE WHEN sd.scope = 'g' THEN COALESCE(tc.global_cnt, 0) ELSE COALESCE(tc.app_cnt, 0) END
              WHEN sd.source = 's' THEN CASE WHEN sd.scope = 'g' THEN COALESCE(sc.global_cnt, 0) ELSE COALESCE(sc.app_cnt, 0) END
              ELSE 0
            END
          ) as source_count
        FROM signal_defs sd
        LEFT JOIN thread_counts tc
          ON sd.source = 't'
         AND (
           (sd.op = 'eq' AND tc.thread_name = sd.pattern)
           OR (sd.op = 'glob' AND tc.thread_name GLOB sd.pattern)
         )
        LEFT JOIN slice_counts sc
          ON sd.source = 's'
         AND (
           (sd.op = 'eq' AND sc.slice_name = sd.pattern)
           OR (sd.op = 'glob' AND sc.slice_name GLOB sd.pattern)
         )
        GROUP BY sd.signal_id, sd.pipeline_id, sd.signal_type, sd.signal_name, sd.weight, sd.min_count, source_name
      ),
      signal_counts AS (
        SELECT signal_id, pipeline_id, signal_type, signal_name, weight, min_count,
          SUM(source_count) as cnt
        FROM signal_name_matches
        GROUP BY signal_id, pipeline_id, signal_type, signal_name, weight, min_count
      ),
      signal_agg AS (
        SELECT
          pipeline_id,
          MIN(
            CASE
              WHEN signal_type = 'r' THEN CASE WHEN cnt >= min_count THEN 1 ELSE 0 END
              ELSE 1
            END
          ) as required_ok,
          MAX(
            CASE
              WHEN signal_type = 'e' THEN CASE WHEN cnt > 0 THEN 1 ELSE 0 END
              ELSE 0
            END
          ) as excluded,
          SUM(CASE WHEN signal_type = 's' THEN weight ELSE 0 END) as total_weight,
          SUM(CASE WHEN signal_type = 's' AND cnt >= min_count THEN weight ELSE 0 END) as matched_weight
        FROM signal_counts
        GROUP BY pipeline_id
      ),
      pipeline_scores AS (
        SELECT
          pl.pipeline_id,
          COALESCE(sa.required_ok, 1) as required_ok,
          COALESCE(sa.excluded, 0) as excluded,
          COALESCE(sa.total_weight, 0) as total_weight,
          COALESCE(sa.matched_weight, 0) as matched_weight
        FROM pipeline_list pl
        LEFT JOIN signal_agg sa ON sa.pipeline_id = pl.pipeline_id
      ),
      scores AS (
        SELECT
          pipeline_id,
          required_ok,
          excluded,
          total_weight,
          matched_weight,
          CASE
            WHEN required_ok = 1 AND excluded = 0 AND total_weight > 0
            THEN matched_weight * 1.0 / total_weight
            ELSE 0
          END as score
        FROM pipeline_scores
      )
      SELECT * FROM scores
    `;
}

function buildDeterminePipelineSql(catalog: PipelineCatalog): string {
  const pipelineMetadataSql = buildPipelineMetadataSql(catalog);
  const pipelineRelatedRenderingTypesSql = buildPipelineRelatedRenderingTypesSql(catalog);
  return `
      WITH
      pipeline_scores AS (
        SELECT * FROM \${pipeline_scores}
      ),
      pipeline_metadata(
        pipeline_id,
        rendering_type_id,
        output_path,
        feature_visible,
        doc_path
      ) AS (
        VALUES
        ${pipelineMetadataSql}
      ),
      pipeline_related_rendering_types(
        pipeline_id,
        rendering_type_id
      ) AS (
        VALUES
        ${pipelineRelatedRenderingTypesSql}
      ),
      features AS (
        SELECT
          ps.pipeline_id,
          ps.score,
          ROW_NUMBER() OVER (ORDER BY ps.score DESC, ps.pipeline_id ASC) as rank
        FROM pipeline_scores ps
        JOIN pipeline_metadata pm USING (pipeline_id)
        WHERE pm.feature_visible = 1
          AND ps.score >= ${SCORE_THRESHOLD}
      ),
      related_rendering_type_scores AS (
        SELECT
          prt.rendering_type_id,
          MAX(f.score) as score
        FROM features f
        JOIN pipeline_related_rendering_types prt USING (pipeline_id)
        GROUP BY prt.rendering_type_id
      ),
      ranked_related_rendering_types AS (
        SELECT
          rendering_type_id,
          score,
          ROW_NUMBER() OVER (ORDER BY score DESC, rendering_type_id ASC) as rank
        FROM related_rendering_type_scores
      ),
      related_rendering_type_candidate_list AS (
        SELECT GROUP_CONCAT(rendering_type_id || ':' || ROUND(score, 2), ',') as related_rendering_type_candidates_list
        FROM (
          SELECT rendering_type_id, score
          FROM ranked_related_rendering_types
          WHERE rank <= ${MAX_CANDIDATES}
          ORDER BY rank ASC
        )
        GROUP BY 'all_related_rendering_type_candidates'
      ),
      feature_list AS (
        SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') as features_list
        FROM (
          SELECT pipeline_id, score
          FROM features
          ORDER BY rank ASC
        )
        GROUP BY 'all_features'
      )
      SELECT
        COALESCE(primary_pipeline.pipeline_id, 'UNKNOWN') AS primary_pipeline_id,
        COALESCE(primary_pipeline.rendering_type_id, 'UNKNOWN') AS primary_rendering_type_id,
        CASE WHEN primary_pipeline.pipeline_id IS NULL THEN 0 ELSE obs.output_share END AS primary_confidence,
        obs.observed_path AS primary_basis, obs.target_process, obs.hwui_draw_frames,
        obs.host_submissions, obs.surfaceview_submissions, obs.texture_submissions,
        obs.sf_host_frames, obs.sf_surfaceview_frames, obs.sf_surface_latches, obs.camera_latches, obs.video_latches, obs.webview_draw_frames,
        COALESCE(primary_pipeline.pipeline_id || ':' || ROUND(obs.output_share, 2), '') as candidates_list,
        COALESCE(primary_pipeline.rendering_type_id || ':' || ROUND(obs.output_share, 2), '') as rendering_type_candidates_list,
        COALESCE((SELECT related_rendering_type_candidates_list FROM related_rendering_type_candidate_list), '') as related_rendering_type_candidates_list,
        COALESCE((SELECT features_list FROM feature_list), '') as features_list,
        COALESCE(primary_pipeline.doc_path, '') AS doc_path
      FROM \${layer_signals} obs LEFT JOIN pipeline_metadata primary_pipeline ON primary_pipeline.output_path = obs.observed_path
    `;
}

function buildSubvariantsSql(): string {
  return `
      SELECT
        CASE WHEN primary_basis IN ('hwui_blast','surfaceview_blast') THEN 'BLAST' ELSE 'UNKNOWN' END AS buffer_mode,
        CASE primary_basis WHEN 'flutter_surface_impeller' THEN 'IMPELLER' WHEN 'flutter_surface_skia' THEN 'SKIA'
          ELSE 'UNKNOWN' END AS flutter_engine,
        CASE WHEN primary_basis = 'webview_functor' THEN 'GL_FUNCTOR' ELSE 'UNKNOWN' END AS webview_mode,
        'UNKNOWN' AS game_engine
      FROM \${pipeline_result}
    `;
}

function buildTraceRequirementsSql(): string {
  // Keep hints conservative and app-scoped where possible.
  return `
      WITH
      ${renderingAppScopeSql}
      SELECT
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND t.name = 'RenderThread'
              AND s.name GLOB 'DrawFrame*'
            LIMIT 1
          )
          THEN 'gfx: RenderThread/DrawFrame slices missing (enable atrace: gfx)'
          ELSE NULL
        END as hint_gfx,
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND s.name GLOB '*Choreographer#doFrame*'
            LIMIT 1
          )
          THEN 'input: Choreographer#doFrame missing (enable atrace: input/view)'
          ELSE NULL
        END as hint_input,
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE p.upid IN (SELECT upid FROM app_filter_upids)
              AND (
                s.name GLOB '*BLASTBufferQueue*'
                OR s.name GLOB '*applyTransaction*'
                OR s.name GLOB '*queueBuffer*'
                OR s.name GLOB '*dequeueBuffer*'
              )
            LIMIT 1
          )
          THEN 'BufferQueue/Transaction slices missing (enable atrace: gfx/sf)'
          ELSE NULL
        END as hint_buffer,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM process p WHERE p.name IN ('surfaceflinger','/system/bin/surfaceflinger') LIMIT 1)
          THEN 'SurfaceFlinger process missing (need system tracing / root on some devices)'
          ELSE NULL
        END as hint_sf,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM actual_frame_timeline_slice LIMIT 1)
          THEN 'FrameTimeline missing (enable SurfaceFlinger FrameTimeline / Android 12+)'
          ELSE NULL
        END as hint_timeline
    `;
}

function buildActiveRenderingProcessesSql(): string {
  return `
      WITH
      ${renderingAppScopeSql},
      marker_slices AS (
        SELECT
          p.upid,
          p.name as process_name,
          t.tid,
          t.name as thread_name
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.upid IN (SELECT upid FROM app_filter_upids)
          AND p.name IS NOT NULL
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FramePacing*')
            OR (s.name GLOB '*updateTexImage*')
            OR (s.name GLOB '*Rasterizer::DrawToSurfaces*')
            OR (s.name GLOB '*Engine::BeginFrame*')
            OR (s.name GLOB '*EntityPass*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*unlockCanvasAndPost*')
          )
      )
      SELECT
        upid,
        process_name,
        COUNT(*) as frame_count,
        MAX(CASE WHEN thread_name = 'RenderThread' THEN tid ELSE NULL END) as render_thread_tid
      FROM marker_slices
      GROUP BY upid
      HAVING frame_count > 5
      ORDER BY frame_count DESC
      LIMIT 10
    `;
}

// =============================================================================
/**
 * Supporting cadence-source evidence.
 * Detects non-vsync-app rhythm sources in the App scope:
 * - Swappy/SwappyVk frame pacing
 * - AChoreographer (NDK Choreographer)
 * - setFrameRate / setFrameRateCategory APIs
 * - Camera request activity candidate (slice-name match; not sensor-trigger proof)
 * - MediaCodec codec pacing
 * - Game engine main loop
 *
 * Used by LLM Agent to know whether the App relies on vsync-app or has its own rhythm.
 */
function buildExtraRhythmSignalsSql(): string {
  return `
      WITH
      ${renderingAppScopeSql},
      app_slices AS (
        SELECT s.name as slice_name, COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*Swappy*'), 0) as swappy_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*SwappyVk_*'), 0) as swappy_vk_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*AChoreographer*'), 0) as achoreographer_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*setFrameRate*'), 0) as set_frame_rate_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*setFrameRateCategory*'), 0) as set_frame_rate_category_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*PlayerLoop*' OR slice_name GLOB '*FEngineLoop*' OR slice_name GLOB '*MainLoop*'), 0) as engine_main_loop_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*processCaptureRequest*' OR slice_name GLOB '*processCaptureResult*'), 0) as camera_capture_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*releaseOutputBuffer*' OR slice_name GLOB '*MediaCodec*'), 0) as mediacodec_pacing_count,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*Swappy*' OR slice_name GLOB '*SwappyVk_*'), 0) > 0 THEN 'swappy_pacing'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*AChoreographer*'), 0) > 0 THEN 'achoreographer'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*PlayerLoop*' OR slice_name GLOB '*FEngineLoop*' OR slice_name GLOB '*MainLoop*'), 0) > 0 THEN 'engine_main_loop'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*processCaptureRequest*'), 0) > 0 THEN 'camera_request_activity'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*releaseOutputBuffer*'), 0) > 0 THEN 'video_codec_pacing'
          ELSE 'unknown'
        END as primary_rhythm_source
    `;
}

/** Inventory of queue, transaction and texture API activity in the target package. */
function buildBufferqueuePathSignalsSql(): string {
  return `
      WITH
      ${renderingAppScopeSql},
      app_slices AS (
        SELECT s.name as slice_name, COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) as blast_bq_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) as apply_transaction_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE (slice_name = 'queueBuffer' OR slice_name GLOB 'queueBuffer - *')), 0) as queue_buffer_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*updateTexImage*'), 0) as update_tex_image_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*lockCanvas*'), 0) as lock_canvas_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*unlockCanvasAndPost*'), 0) as unlock_canvas_post_count,
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*ASurfaceTransaction*'), 0) as asurface_transaction_count,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) > 0
            THEN 'BBQ_TRANSACTION_INPROC'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*ASurfaceTransaction*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
            THEN 'SURFACECONTROL_TRANSACTION_DIRECT'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*updateTexImage*'), 0) > 0
            THEN 'TEXTURE_UPDATE_OBSERVED'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*lockCanvas*' OR slice_name GLOB '*unlockCanvasAndPost*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
            THEN 'CANVAS_ACTIVITY_OBSERVED'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE (slice_name = 'queueBuffer' OR slice_name GLOB 'queueBuffer - *')), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) = 0
            THEN 'QUEUE_OBSERVED'
          ELSE 'UNKNOWN'
        END as bufferqueue_path
    `;
}

export async function generateRenderingPipelineDetectionSkill(): Promise<SkillDefinition> {
  await ensurePipelineSkillsInitialized();

  const pipelines = pipelineSkillLoader
    .getAllPipelines()
    .filter((p) => p?.meta?.pipeline_id)
    .sort((a, b) => a.meta.pipeline_id.localeCompare(b.meta.pipeline_id));
  const catalog = pipelineSkillLoader.getCatalog();

  const pipelineScoresSql = buildPipelineScoresSql(pipelines, catalog);
  const determinePipelineSql = buildDeterminePipelineSql(catalog);
  const subvariantsSql = buildSubvariantsSql();
  const traceRequirementsSql = buildTraceRequirementsSql();
  const activeProcessesSql = buildActiveRenderingProcessesSql();
  // Derive the functor aliases from the same probe used by the pipeline inventory.
  const webview = pipelines.find(p => catalog.pipelines[p.meta.pipeline_id]?.output_path === 'webview_functor');
  const drawPatterns = webview?.detection?.required_signals?.flatMap(buildSignalComponents)
    .filter(c => c.source === 's').map(c => `name ${c.op === 'eq' ? '=' : 'GLOB'} ${sqlStringLiteral(c.pattern)}`);
  const layerSignalsSql = buildLayerSignalsSql(drawPatterns?.join(' OR ') || '0');
  const extraRhythmSignalsSql = buildExtraRhythmSignalsSql();
  const bufferqueuePathSignalsSql = buildBufferqueuePathSignalsSql();

  return {
    name: 'rendering_pipeline_detection',
    version: '5.0',
    type: 'composite',
    category: 'rendering',
    meta: {
      display_name: '渲染管线检测 (YAML 驱动)',
      description: '从 catalog 与 pipeline YAML 生成子路径评分、主出图类型、候选与正交特性',
      icon: 'layers',
      tags: ['rendering', 'pipeline', 'detection', 'teaching', 'yaml'],
    },
    triggers: {
      keywords: {
        zh: ['渲染管线', '管线检测', '出图类型', 'SurfaceView', 'TextureView', 'Flutter', 'WebView'],
        en: ['rendering pipeline', 'rendering type', 'pipeline detection', 'surfaceview', 'textureview', 'flutter', 'webview'],
      },
      patterns: [
        '.*(渲染管线|出图类型|SurfaceView|TextureView|WebView|Flutter).*',
        '.*(rendering pipeline|rendering type|surfaceview|textureview|webview|flutter).*',
      ],
    },
    prerequisites: {
      required_tables: ['slice', 'thread_track', 'thread', 'process'],
      optional_tables: ['counter', 'counter_track'],
      modules: ['slices.with_context', 'android.frames.timeline'],
    },
    inputs: [
      {
        name: 'package',
        type: 'string',
        required: false,
        description: '应用包名 (可选，用于过滤)',
      },
    ],
    steps: [
      {
        id: 'score_pipelines',
        type: 'atomic',
        name: '计算管线类型评分 (YAML 驱动)',
        display: {
          level: 'detail',
          title: '候选特征评分',
        },
        sql: pipelineScoresSql,
        save_as: 'pipeline_scores',
      },
      {
        id: 'layer_signals',
        type: 'atomic',
        name: '核对目标应用出图与 SurfaceFlinger 消费',
        display: {
          level: 'detail',
          title: '目标图层与缓冲区',
        },
        sql: layerSignalsSql,
        save_as: 'layer_signals',
      },
      {
        id: 'determine_pipeline',
        type: 'atomic',
        name: '确定主管线 (YAML 驱动)',
        display: {
          level: 'summary',
          title: '渲染管线识别结果',
        },
        sql: determinePipelineSql,
        save_as: 'pipeline_result',
      },
      {
        id: 'subvariants',
        type: 'atomic',
        name: '确定子变体',
        display: {
          level: 'detail',
          title: '子变体检测',
        },
        sql: subvariantsSql,
        save_as: 'subvariants',
      },
      {
        id: 'trace_requirements',
        type: 'atomic',
        name: '检查采集完整性',
        display: {
          level: 'detail',
          title: '采集建议',
        },
        sql: traceRequirementsSql,
        save_as: 'trace_requirements',
      },
      {
        id: 'active_rendering_processes',
        type: 'atomic',
        name: '识别活跃渲染进程',
        display: {
          level: 'detail',
          title: '活跃渲染进程',
        },
        sql: activeProcessesSql,
        save_as: 'active_rendering_processes',
      },
      // Supplementary cadence and submission diagnostics.
      {
        id: 'extra_rhythm_signals',
        type: 'atomic',
        name: '额外节奏源 (辅助证据)',
        display: {
          level: 'detail',
          title: '额外节奏源',
        },
        sql: extraRhythmSignalsSql,
        save_as: 'extra_rhythm_signals',
      },
      {
        id: 'bufferqueue_path_signals',
        type: 'atomic',
        name: 'BufferQueue 路径证据',
        display: {
          level: 'detail',
          title: 'BufferQueue 路径',
        },
        sql: bufferqueuePathSignalsSql,
        save_as: 'bufferqueue_path_signals',
      },
      {
        id: 'pipeline_bundle',
        type: 'pipeline',
        name: '聚合渲染管线教学结果',
        pipeline_source: 'pipeline_result',
        active_processes_source: 'active_rendering_processes',
        trace_requirements_source: 'trace_requirements',
        display: {
          level: 'summary',
          title: '渲染管线教学聚合结果',
          format: 'summary',
        },
        save_as: 'pipeline_bundle',
      },
    ],
    output: {
      fields: [
        { name: 'pipeline_scores', label: '各管线类型得分 (调试用)' },
        { name: 'pipeline_result', label: '主管线识别结果' },
        { name: 'subvariants', label: '子变体信息' },
        { name: 'trace_requirements', label: '采集完整性检查' },
        { name: 'active_rendering_processes', label: '活跃渲染进程列表 (用于智能 Pin)' },
        // Supporting evidence axes used by the LLM Agent and downstream skills.
        { name: 'layer_signals', label: 'Layer 信号 (SF 侧 layer 数与命名模式)' },
        { name: 'extra_rhythm_signals', label: '额外节奏源 (Swappy/AChoreographer/Camera/Codec)' },
        { name: 'bufferqueue_path_signals', label: 'BufferQueue 路径分型' },
        { name: 'pipeline_bundle', label: '渲染管线教学聚合结果' },
      ],
    },
  };
}
