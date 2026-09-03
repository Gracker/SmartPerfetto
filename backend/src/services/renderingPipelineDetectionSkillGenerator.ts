// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { SkillDefinition } from './skillEngine/types';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  type PipelineCatalog,
  type PipelineCatalogEntry,
  type PipelineDefinition,
} from './pipelineSkillLoader';

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

  return components;
}

function describeSignalKey(signal: {
  thread?: string;
  thread_pattern?: string;
  slice?: string;
  slice_pattern?: string;
}): string {
  if (signal.thread) return `thread:${signal.thread}`;
  if (signal.thread_pattern) return `thread_pattern:${signal.thread_pattern}`;
  if (signal.slice) return `slice:${signal.slice}`;
  if (signal.slice_pattern) return `slice_pattern:${signal.slice_pattern}`;
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
      const renderingTypeId = entry.rendering_type_id
        ? sqlStringLiteral(entry.rendering_type_id)
        : 'NULL';
      const document = catalog.rendering_types[entry.teaching_type_id].document;
      return `(${[
        pipelineId,
        renderingTypeId,
        entry.primary_eligible ? 1 : 0,
        entry.feature_visible ? 1 : 0,
        `rendering_pipelines/${document}`,
      ].map((value) => typeof value === 'string' && (value === 'NULL' || /^'.*'$/.test(value)) ? value : sqlValueLiteral(value as string | number)).join(', ')})`;
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
      -- Identify a dominant app (when package is not provided) by looking for rendering-related slices,
      -- then include *all* processes that share the same package prefix. This reduces false positives
      -- from multi-app traces while still supporting multi-process apps (e.g. WebView renderers).
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
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
      signal_counts AS (
        SELECT
          sd.signal_id,
          sd.pipeline_id,
          sd.signal_type,
          sd.signal_name,
          sd.weight,
          sd.min_count,
          SUM(
            CASE
              WHEN sd.source = 't' THEN CASE WHEN sd.scope = 'g' THEN COALESCE(tc.global_cnt, 0) ELSE COALESCE(tc.app_cnt, 0) END
              WHEN sd.source = 's' THEN CASE WHEN sd.scope = 'g' THEN COALESCE(sc.global_cnt, 0) ELSE COALESCE(sc.app_cnt, 0) END
              ELSE 0
            END
          ) as cnt
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
        GROUP BY sd.signal_id, sd.pipeline_id, sd.signal_type, sd.signal_name, sd.weight, sd.min_count
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
  const defaultPipelineId = catalog.default.pipeline_id;
  const defaultRenderingTypeId = catalog.default.rendering_type_id;
  const defaultDocument = catalog.rendering_types[defaultRenderingTypeId].document;
  return `
      WITH
      pipeline_scores AS (
        SELECT * FROM \${pipeline_scores}
      ),
      pipeline_metadata(
        pipeline_id,
        rendering_type_id,
        primary_eligible,
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
      ranked AS (
        SELECT
          ps.pipeline_id,
          ps.score,
          pm.rendering_type_id,
          ROW_NUMBER() OVER (ORDER BY ps.score DESC, ps.pipeline_id ASC) as rank
        FROM pipeline_scores ps
        JOIN pipeline_metadata pm USING (pipeline_id)
        WHERE ps.score >= ${SCORE_THRESHOLD}
          AND pm.primary_eligible = 1
      ),
      primary_pipeline AS (
        SELECT pipeline_id, rendering_type_id, score FROM ranked WHERE rank = 1
      ),
      candidates AS (
        SELECT pipeline_id, rendering_type_id, score, rank
        FROM ranked
        WHERE rank <= ${MAX_CANDIDATES}
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
      rendering_type_scores AS (
        SELECT
          rendering_type_id,
          MAX(score) as score
        FROM ranked
        WHERE rendering_type_id IS NOT NULL
        GROUP BY rendering_type_id
      ),
      ranked_rendering_types AS (
        SELECT
          rendering_type_id,
          score,
          ROW_NUMBER() OVER (ORDER BY score DESC, rendering_type_id ASC) as rank
        FROM rendering_type_scores
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
      candidate_list AS (
        SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') as candidates_list
        FROM (
          SELECT pipeline_id, score
          FROM candidates
          ORDER BY rank ASC
        )
        GROUP BY 'all_candidates'
      ),
      rendering_type_candidate_list AS (
        SELECT GROUP_CONCAT(rendering_type_id || ':' || ROUND(score, 2), ',') as rendering_type_candidates_list
        FROM (
          SELECT rendering_type_id, score
          FROM ranked_rendering_types
          WHERE rank <= ${MAX_CANDIDATES}
          ORDER BY rank ASC
        )
        GROUP BY 'all_rendering_type_candidates'
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
      ),
      result AS (
        SELECT
          COALESCE((SELECT pipeline_id FROM primary_pipeline), ${sqlStringLiteral(defaultPipelineId)}) as primary_pipeline_id,
          COALESCE((SELECT rendering_type_id FROM primary_pipeline), ${sqlStringLiteral(defaultRenderingTypeId)}) as primary_rendering_type_id,
          COALESCE((SELECT score FROM primary_pipeline), 0.50) as primary_confidence,
          COALESCE((SELECT candidates_list FROM candidate_list), '') as candidates_list,
          COALESCE((SELECT rendering_type_candidates_list FROM rendering_type_candidate_list), '') as rendering_type_candidates_list,
          COALESCE((SELECT related_rendering_type_candidates_list FROM related_rendering_type_candidate_list), '') as related_rendering_type_candidates_list,
          COALESCE((SELECT features_list FROM feature_list), '') as features_list
      )
      SELECT
        r.primary_pipeline_id,
        r.primary_rendering_type_id,
        r.primary_confidence,
        r.candidates_list,
        r.rendering_type_candidates_list,
        r.related_rendering_type_candidates_list,
        r.features_list,
        COALESCE((SELECT doc_path FROM pipeline_metadata WHERE pipeline_id = r.primary_pipeline_id), ${sqlStringLiteral(`rendering_pipelines/${defaultDocument}`)}) as doc_path
      FROM result r
    `;
}

function buildSubvariantsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
      thread_counts AS (
        SELECT
          t.name as thread_name,
          COUNT(*) as cnt
        FROM thread t
        WHERE t.name IS NOT NULL
          AND t.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY t.name
      ),
      slice_counts AS (
        SELECT
          s.name as slice_name,
          COUNT(*) as cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name IS NOT NULL
          AND p.upid IN (SELECT upid FROM app_filter_upids)
        GROUP BY s.name
      )
      SELECT
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) > 0 THEN 'BLAST'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*queueBuffer*'), 0) > 0 THEN 'LEGACY'
          ELSE 'UNKNOWN'
        END as buffer_mode,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*Impeller*' OR slice_name GLOB '*EntityPass*'), 0) > 0
          THEN 'IMPELLER'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*SkGpu*' OR slice_name GLOB '*SkiaGpu*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*EntityPass*'), 0) = 0
          THEN 'SKIA'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name IN ('ui', '1.ui')), 0) > 0
          THEN 'UNKNOWN'
          ELSE 'N/A'
        END as flutter_engine,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts
                         WHERE thread_name = 'VizCompositorThread'
                            OR thread_name GLOB 'VizCompositorThread*'
                            OR thread_name = 'VizCompositor'
                            OR thread_name GLOB 'VizCompositor*'), 0) > 0
          THEN 'SURFACE_CONTROL'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*DrawGL*' OR slice_name GLOB '*DrawFunctor*'), 0) > 0
          THEN 'GL_FUNCTOR'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*TBS*' OR slice_name GLOB '*X5*' OR slice_name GLOB '*UCCore*'), 0) > 0
          THEN 'TEXTUREVIEW_CUSTOM'
          WHEN COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*WebView*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*SurfaceView*'), 0) > 0
          THEN 'SURFACEVIEW_WRAPPER'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB '*Chrome*' OR thread_name GLOB 'CrRendererMain*'), 0) > 0
          THEN 'UNKNOWN'
          ELSE 'N/A'
        END as webview_mode,
        CASE
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'UnityMain*'), 0) > 0 THEN 'UNITY'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'GameThread*' OR thread_name GLOB 'RHIThread*'), 0) > 0 THEN 'UNREAL'
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name GLOB 'GodotMain*'), 0) > 0 THEN 'GODOT'
          ELSE 'N/A'
        END as game_engine
    `;
}

function buildTraceRequirementsSql(): string {
  // Keep hints conservative and app-scoped where possible.
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      )
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
          WHEN NOT EXISTS (SELECT 1 FROM process p WHERE p.name = 'surfaceflinger' LIMIT 1)
          THEN 'SurfaceFlinger process missing (need system tracing / root on some devices)'
          ELSE NULL
        END as hint_sf,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM slice s WHERE s.name GLOB '*FrameTimeline*' LIMIT 1)
          THEN 'FrameTimeline missing (enable SurfaceFlinger FrameTimeline / Android 12+)'
          ELSE NULL
        END as hint_timeline
    `;
}

function buildActiveRenderingProcessesSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (t.name = 'main' AND s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*lockCanvas*')
            OR (s.name GLOB '*unlockCanvasAndPost*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*Swappy*')
            OR (s.name GLOB '*FramePacing*')
            OR (s.name GLOB '*FrameTimeline*')
            OR (s.name GLOB '*updateTexImage*')
            OR (s.name GLOB '*Rasterizer::DrawToSurfaces*')
            OR (s.name GLOB '*Engine::BeginFrame*')
            OR (s.name GLOB '*EntityPass*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
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
// Supporting evidence-axis extractors
// =============================================================================
// These outputs help explain Producer, layer, submission-path, and cadence
// evidence. They are not a standalone rendering-type proof and do not modify
// primary ranking.
// =============================================================================

/**
 * Supporting layer-count evidence.
 * Queries SurfaceFlinger-side layer information for the dominant App.
 *
 * Layer count is the article's decisive signal:
 * - Standard HWUI / Compose / TextureView: 1 layer (host window only)
 * - SurfaceView / Mixed (with SV) / Multi-window: ≥2 layers
 * - WebView Functor / TextureView Custom: 0 independent layer (回宿主)
 * - WebView SurfaceControl: N overlay candidates
 */
function buildLayerSignalsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
            OR (s.name GLOB '*FrameTimeline*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_layers AS (
        -- FrameTimeline 提供 layer_name 维度（Android 12+）
        SELECT DISTINCT layer_name
        FROM android_frames_layers
        WHERE layer_name IS NOT NULL
          AND (
            ('\${package}' <> '' AND layer_name GLOB '*' || '\${package}' || '*')
            OR ('\${package}' = '' AND layer_name GLOB '*' || (SELECT pkg FROM dominant_pkg) || '*')
          )
      )
      SELECT
        COALESCE((SELECT COUNT(*) FROM app_layers), 0) as app_layer_count,
        COALESCE((SELECT GROUP_CONCAT(layer_name, '; ') FROM app_layers), '') as app_layer_names,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*SurfaceView*' OR layer_name GLOB 'SurfaceView*') > 0 THEN 1
          ELSE 0
        END as has_surfaceview_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*video*' OR layer_name GLOB '*Video*' OR layer_name GLOB '*MediaCodec*') > 0 THEN 1
          ELSE 0
        END as has_video_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*io.flutter*' OR layer_name GLOB '*Flutter*') > 0 THEN 1
          ELSE 0
        END as has_flutter_layer,
        CASE
          WHEN (SELECT COUNT(*) FROM app_layers WHERE layer_name GLOB '*Camera*' OR layer_name GLOB '*camera*') > 0 THEN 1
          ELSE 0
        END as has_camera_layer
    `;
}

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
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
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
          ELSE 'vsync_app_only'
        END as primary_rhythm_source
    `;
}

/**
 * Supporting BufferQueue-path evidence.
 * Distinguishes the BufferQueue path:
 * - BBQ_TRANSACTION_INPROC (BLAST: applyTransaction + BLASTBufferQueue both present)
 * - BUFFERQUEUE_INPROC (Legacy: queueBuffer present BUT no BLAST signals)
 * - HOST_RESAMPLE (TextureView: updateTexImage on RenderThread + SurfaceTexture)
 * - ACQUIRE_FENCE_NONE_INPROC (Software: lockCanvas/unlockCanvasAndPost)
 * - SURFACECONTROL_TRANSACTION_DIRECT (NDK: ASurfaceTransaction without BLAST)
 *
 * Used by LLM Agent to know which buffer path the trace exhibits, regardless of
 * which primary pipeline got selected by detection scoring.
 */
function buildBufferqueuePathSignalsSql(): string {
  return `
      WITH
      dominant_process AS (
        SELECT
          p.upid,
          p.name as process_name,
          COUNT(*) as render_cnt
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name IS NOT NULL
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
          AND s.name IS NOT NULL
          AND (
            (t.name = 'RenderThread' AND s.name GLOB 'DrawFrame*')
            OR (s.name GLOB '*Choreographer#doFrame*')
            OR (s.name GLOB '*eglSwapBuffers*')
            OR (s.name GLOB '*vkQueuePresentKHR*')
          )
        GROUP BY p.upid
        HAVING COUNT(*) > 5
        ORDER BY render_cnt DESC
        LIMIT 1
      ),
      dominant_pkg AS (
        SELECT
          CASE
            WHEN instr(process_name, ':') > 0 THEN substr(process_name, 1, instr(process_name, ':') - 1)
            ELSE process_name
          END as pkg
        FROM dominant_process
      ),
      app_filter_upids AS (
        SELECT p.upid
        FROM process p
        WHERE '\${package}' <> '' AND (p.name = '\${package}' OR p.name GLOB '\${package}:*')
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND (p.name = dp.pkg OR p.name GLOB dp.pkg || ':*')
          AND p.name NOT LIKE 'com.android.systemui%'
          AND p.name NOT LIKE 'system_server%'
          AND p.name NOT LIKE '/system/%'
      ),
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
        COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*queueBuffer*'), 0) as queue_buffer_count,
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
            THEN 'HOST_RESAMPLE'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*lockCanvas*' OR slice_name GLOB '*unlockCanvasAndPost*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
            THEN 'ACQUIRE_FENCE_NONE_INPROC'
          WHEN COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*queueBuffer*'), 0) > 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*BLASTBufferQueue*'), 0) = 0
               AND COALESCE((SELECT SUM(cnt) FROM app_slices WHERE slice_name GLOB '*applyTransaction*'), 0) = 0
            THEN 'BUFFERQUEUE_INPROC'
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
  // Supporting evidence axes: layer count, cadence, and BufferQueue path.
  const layerSignalsSql = buildLayerSignalsSql();
  const extraRhythmSignalsSql = buildExtraRhythmSignalsSql();
  const bufferqueuePathSignalsSql = buildBufferqueuePathSignalsSql();

  return {
    name: 'rendering_pipeline_detection',
    version: '4.0',
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
          title: '管线类型评分',
        },
        sql: pipelineScoresSql,
        save_as: 'pipeline_scores',
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
      // Supporting evidence axes; none is sufficient for type proof by itself.
      {
        id: 'layer_signals',
        type: 'atomic',
        name: 'SF Layer 数与名字模式 (辅助证据)',
        display: {
          level: 'detail',
          title: 'Layer 信号',
        },
        sql: layerSignalsSql,
        save_as: 'layer_signals',
      },
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
