import { SkillDefinition } from './skillEngine/types';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  type PipelineDefinition,
} from './pipelineSkillLoader';

type ScopeColumn = 'app_cnt' | 'global_cnt';

const DEFAULT_PIPELINE_ID = 'ANDROID_VIEW_STANDARD_BLAST';
const DEFAULT_DOC_PATH = 'rendering_pipelines/android_view_standard.md';
const SCORE_THRESHOLD = 0.3;
const MAX_CANDIDATES = 5;

// Pipelines that represent orthogonal/system-level features, not the primary app rendering pipeline.
// These should not win primary pipeline selection when other candidates exist.
const FEATURE_ONLY_PIPELINE_IDS = new Set<string>(['VARIABLE_REFRESH_RATE', 'VIDEO_OVERLAY_HWC']);

// Pipelines that should be surfaced in the "features" list.
const FEATURE_PIPELINE_IDS = new Set<string>([
  'VARIABLE_REFRESH_RATE',
  'VIDEO_OVERLAY_HWC',
  'SURFACE_CONTROL_API',
]);

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

function getScopeColumn(pipelineId: string): ScopeColumn {
  return FEATURE_ONLY_PIPELINE_IDS.has(pipelineId) ? 'global_cnt' : 'app_cnt';
}

function buildCountSubquery(params: {
  table: 'thread_counts' | 'slice_counts';
  nameColumn: 'thread_name' | 'slice_name';
  op: '=' | 'GLOB';
  pattern: string;
  scopeColumn: ScopeColumn;
}): string {
  return `COALESCE((SELECT SUM(${params.scopeColumn}) FROM ${params.table} WHERE ${params.nameColumn} ${params.op} ${sqlStringLiteral(params.pattern)}), 0)`;
}

function buildSignalCountExpr(
  signal: {
    thread?: string;
    thread_pattern?: string;
    slice?: string;
    slice_pattern?: string;
  },
  scopeColumn: ScopeColumn
): string | null {
  const exprs: string[] = [];

  if (signal.thread) {
    exprs.push(
      buildCountSubquery({
        table: 'thread_counts',
        nameColumn: 'thread_name',
        op: '=',
        pattern: signal.thread,
        scopeColumn,
      })
    );
  }

  if (signal.thread_pattern) {
    exprs.push(
      buildCountSubquery({
        table: 'thread_counts',
        nameColumn: 'thread_name',
        op: 'GLOB',
        pattern: signal.thread_pattern,
        scopeColumn,
      })
    );
  }

  if (signal.slice) {
    exprs.push(
      buildCountSubquery({
        table: 'slice_counts',
        nameColumn: 'slice_name',
        op: '=',
        pattern: signal.slice,
        scopeColumn,
      })
    );
  }

  if (signal.slice_pattern) {
    exprs.push(
      buildCountSubquery({
        table: 'slice_counts',
        nameColumn: 'slice_name',
        op: 'GLOB',
        pattern: signal.slice_pattern,
        scopeColumn,
      })
    );
  }

  if (exprs.length === 0) return null;
  return exprs.join(' + ');
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

function buildPipelineListSql(pipelines: PipelineDefinition[]): string {
  if (pipelines.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id`;
  }
  return pipelines
    .map((p) => `SELECT ${sqlStringLiteral(p.meta.pipeline_id)} as pipeline_id`)
    .join('\n        UNION ALL\n        ');
}

function buildPipelineDocsSql(pipelines: PipelineDefinition[]): string {
  if (pipelines.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id, ${sqlStringLiteral(DEFAULT_DOC_PATH)} as doc_path`;
  }
  return pipelines
    .map((p) => {
      const docPath = p.meta.doc_path ? sqlStringLiteral(p.meta.doc_path) : 'NULL';
      return `SELECT ${sqlStringLiteral(p.meta.pipeline_id)} as pipeline_id, ${docPath} as doc_path`;
    })
    .join('\n        UNION ALL\n        ');
}

function buildSignalsRowsSql(pipelines: PipelineDefinition[]): string {
  const rows: string[] = [];

  for (const pipeline of pipelines) {
    const pipelineId = pipeline.meta.pipeline_id;
    const detection = pipeline.detection;
    if (!detection) continue;

    const scopeColumn = getScopeColumn(pipelineId);

    for (const req of detection.required_signals || []) {
      const minCount = normalizePositiveInt(req.min_count, 1);
      const cntExpr = buildSignalCountExpr(req, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid required_signals entry for ${pipelineId}:`, req);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'required' as signal_type, ${sqlStringLiteral(describeSignalKey(req))} as signal_name, 0 as weight, ${minCount} as min_count, (${cntExpr}) as cnt`
      );
    }

    for (const sc of detection.scoring_signals || []) {
      const minCount = normalizePositiveInt(sc.min_count, 1);
      const weight = normalizeNonNegativeInt(sc.weight, 0);
      const cntExpr = buildSignalCountExpr(sc, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid scoring_signals entry for ${pipelineId} (${sc.signal}):`, sc);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'score' as signal_type, ${sqlStringLiteral(sc.signal)} as signal_name, ${weight} as weight, ${minCount} as min_count, (${cntExpr}) as cnt`
      );
    }

    for (const ex of detection.exclude_if || []) {
      const cntExpr = buildSignalCountExpr(ex, scopeColumn);
      if (!cntExpr) {
        console.warn(`[rendering_pipeline_detection] Invalid exclude_if entry for ${pipelineId}:`, ex);
        continue;
      }
      rows.push(
        `SELECT ${sqlStringLiteral(pipelineId)} as pipeline_id, 'exclude' as signal_type, ${sqlStringLiteral(describeSignalKey(ex))} as signal_name, 0 as weight, 1 as min_count, (${cntExpr}) as cnt`
      );
    }
  }

  if (rows.length === 0) {
    return `SELECT ${sqlStringLiteral(DEFAULT_PIPELINE_ID)} as pipeline_id, 'score' as signal_type, 'noop' as signal_name, 0 as weight, 1 as min_count, 0 as cnt`;
  }

  return rows.join('\n        UNION ALL\n        ');
}

function buildDeterminePipelineSql(pipelines: PipelineDefinition[]): string {
  const pipelineListSql = buildPipelineListSql(pipelines);
  const pipelineDocsSql = buildPipelineDocsSql(pipelines);
  const signalsRowsSql = buildSignalsRowsSql(pipelines);

  const primaryExcludeSql = Array.from(FEATURE_ONLY_PIPELINE_IDS)
    .map((id) => sqlStringLiteral(id))
    .join(', ');

  const featureIdsSql = Array.from(FEATURE_PIPELINE_IDS)
    .map((id) => sqlStringLiteral(id))
    .join(', ');

  // NOTE: We intentionally avoid `${stepId}`-as-table substitution because SkillExecutor stores
  // step results as JS objects, not temp tables. This SQL is self-contained.
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
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
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
      pipeline_list AS (
        ${pipelineListSql}
      ),
      pipeline_docs AS (
        ${pipelineDocsSql}
      ),
      signals AS (
        ${signalsRowsSql}
      ),
      signal_agg AS (
        SELECT
          pipeline_id,
          MIN(
            CASE
              WHEN signal_type = 'required' THEN CASE WHEN cnt >= min_count THEN 1 ELSE 0 END
              ELSE 1
            END
          ) as required_ok,
          MAX(
            CASE
              WHEN signal_type = 'exclude' THEN CASE WHEN cnt > 0 THEN 1 ELSE 0 END
              ELSE 0
            END
          ) as excluded,
          SUM(CASE WHEN signal_type = 'score' THEN weight ELSE 0 END) as total_weight,
          SUM(CASE WHEN signal_type = 'score' AND cnt >= min_count THEN weight ELSE 0 END) as matched_weight
        FROM signals
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
          CASE
            WHEN required_ok = 1 AND excluded = 0 AND total_weight > 0
            THEN matched_weight * 1.0 / total_weight
            ELSE 0
          END as score
        FROM pipeline_scores
      ),
      ranked AS (
        SELECT
          pipeline_id,
          score,
          ROW_NUMBER() OVER (ORDER BY score DESC, pipeline_id ASC) as rank
        FROM scores
        WHERE score >= ${SCORE_THRESHOLD}
          ${primaryExcludeSql ? `AND pipeline_id NOT IN (${primaryExcludeSql})` : ''}
      ),
      primary_pipeline AS (
        SELECT pipeline_id, score FROM ranked WHERE rank = 1
      ),
      candidates AS (
        SELECT pipeline_id, score FROM ranked WHERE rank <= ${MAX_CANDIDATES}
      ),
      features AS (
        SELECT pipeline_id, score FROM scores
        WHERE pipeline_id IN (${featureIdsSql})
          AND score >= ${SCORE_THRESHOLD}
      ),
      result AS (
        SELECT
          COALESCE((SELECT pipeline_id FROM primary_pipeline), ${sqlStringLiteral(DEFAULT_PIPELINE_ID)}) as primary_pipeline_id,
          COALESCE((SELECT score FROM primary_pipeline), 0.50) as primary_confidence,
          COALESCE((SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') FROM candidates), '') as candidates_list,
          COALESCE((SELECT GROUP_CONCAT(pipeline_id || ':' || ROUND(score, 2), ',') FROM features), '') as features_list
      )
      SELECT
        r.primary_pipeline_id,
        r.primary_confidence,
        r.candidates_list,
        r.features_list,
        COALESCE((SELECT doc_path FROM pipeline_docs WHERE pipeline_id = r.primary_pipeline_id), ${sqlStringLiteral(DEFAULT_DOC_PATH)}) as doc_path
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
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
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
               AND COALESCE((SELECT SUM(cnt) FROM slice_counts WHERE slice_name GLOB '*EntityPass*'), 0) > 0
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
          WHEN COALESCE((SELECT SUM(cnt) FROM thread_counts WHERE thread_name = 'VizCompositor' OR thread_name GLOB 'VizCompositor*'), 0) > 0
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
        WHERE '\${package}' <> '' AND p.name GLOB '\${package}*'
        UNION
        SELECT p.upid
        FROM process p
        JOIN dominant_pkg dp
        WHERE '\${package}' = ''
          AND dp.pkg IS NOT NULL
          AND p.name GLOB dp.pkg || '*'
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
      SELECT
        p.upid,
        p.name as process_name,
        COUNT(*) as frame_count,
        MAX(t.tid) as render_thread_tid
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE t.name = 'RenderThread'
        AND s.name GLOB 'DrawFrame*'
        AND p.name IS NOT NULL
        AND (p.name GLOB '\${package}*' OR '\${package}' = '')
        AND p.name NOT LIKE 'com.android.systemui%'
        AND p.name NOT LIKE '/system/%'
        AND p.name NOT LIKE 'system_server%'
      GROUP BY p.upid
      HAVING frame_count > 5
      ORDER BY frame_count DESC
      LIMIT 10
    `;
}

export async function generateRenderingPipelineDetectionSkill(): Promise<SkillDefinition> {
  await ensurePipelineSkillsInitialized();

  const pipelines = pipelineSkillLoader
    .getAllPipelines()
    .filter((p) => p?.meta?.pipeline_id)
    .sort((a, b) => a.meta.pipeline_id.localeCompare(b.meta.pipeline_id));

  const determinePipelineSql = buildDeterminePipelineSql(pipelines);
  const subvariantsSql = buildSubvariantsSql();
  const traceRequirementsSql = buildTraceRequirementsSql();
  const activeProcessesSql = buildActiveRenderingProcessesSql();

  return {
    name: 'rendering_pipeline_detection',
    version: '3.0',
    type: 'composite',
    category: 'rendering',
    meta: {
      display_name: '渲染管线检测 (YAML 驱动)',
      description: '从 pipeline YAML detection 配置生成打分规则，输出主管线/候选/特性',
      icon: 'layers',
      tags: ['rendering', 'pipeline', 'detection', 'teaching', 'yaml'],
    },
    prerequisites: {
      required_tables: ['thread', 'process'],
      optional_tables: ['slice', 'thread_track', 'counter', 'counter_track'],
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
    ],
    output: {
      fields: [
        { name: 'pipeline_result', label: '主管线识别结果' },
        { name: 'subvariants', label: '子变体信息' },
        { name: 'trace_requirements', label: '采集完整性检查' },
        { name: 'active_rendering_processes', label: '活跃渲染进程列表 (用于智能 Pin)' },
      ],
    },
  };
}
