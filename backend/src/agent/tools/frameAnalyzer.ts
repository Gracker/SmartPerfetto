// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Tool, ToolContext, ToolResult, ToolDefinition } from '../types';
import { sqlExecutorTool } from './sqlExecutor';

interface FrameAnalyzerParams {
  start_ts: string;
  end_ts: string;
  package?: string;
  include_quadrants?: boolean;
  include_binder?: boolean;
  include_slices?: boolean;
  include_cpu_freq?: boolean;
}

interface QuadrantData {
  thread_type: string;
  q1_pct: number;
  q2_pct: number;
  q3_pct: number;
  q4_pct: number;
}

interface BinderCall {
  server_process: string;
  call_count: number;
  total_ms: number;
  max_ms: number;
}

interface SliceData {
  name: string;
  total_ms: number;
  count: number;
  max_ms: number;
}

interface CPUFreqData {
  core_type: string;
  avg_freq_mhz: number;
  max_freq_mhz: number;
  min_freq_mhz: number;
}

interface FrameAnalyzerResult {
  quadrants?: QuadrantData[];
  binderCalls?: BinderCall[];
  mainThreadSlices?: SliceData[];
  renderThreadSlices?: SliceData[];
  cpuFrequency?: CPUFreqData[];
}

const definition: ToolDefinition = {
  name: 'analyze_frame',
  description: 'Analyze a single frame in detail, including thread state distribution (quadrants), Binder calls, main thread operations, and CPU frequency.',
  category: 'analysis',
  parameters: [
    { name: 'start_ts', type: 'timestamp', required: true, description: 'Frame start timestamp (nanoseconds as string)' },
    { name: 'end_ts', type: 'timestamp', required: true, description: 'Frame end timestamp (nanoseconds as string)' },
    { name: 'package', type: 'string', required: false, description: 'Package name filter' },
    { name: 'include_quadrants', type: 'boolean', required: false, description: 'Include thread state quadrant analysis' },
    { name: 'include_binder', type: 'boolean', required: false, description: 'Include Binder call analysis' },
    { name: 'include_slices', type: 'boolean', required: false, description: 'Include thread slice analysis' },
    { name: 'include_cpu_freq', type: 'boolean', required: false, description: 'Include CPU frequency analysis' },
  ],
  returns: {
    type: 'FrameAnalyzerResult',
    description: 'Comprehensive frame analysis data',
  },
};

const CPU_TOPOLOGY_CTE = `
  observed_sched_cpus AS (
    SELECT cpu as cpu_id FROM sched_slice WHERE cpu IS NOT NULL
    UNION
    SELECT cpu as cpu_id
    FROM thread_state
    WHERE cpu IS NOT NULL AND state = 'Running'
  ),
  observed_counter_cpus AS (
    SELECT t.cpu as cpu_id
    FROM cpu_counter_track t
    JOIN counter c ON c.track_id = t.id
    WHERE t.name = 'cpufreq'
      AND t.cpu IS NOT NULL
      AND c.value > 0
    GROUP BY t.cpu
  ),
  cpu_universe AS (
    SELECT cpu_id, 'sched_observed' as universe_source
    FROM observed_sched_cpus
    UNION
    SELECT cpu_id, 'cpufreq_observed_fallback' as universe_source
    FROM observed_counter_cpus
    WHERE NOT EXISTS (SELECT 1 FROM observed_sched_cpus)
    UNION
    SELECT id as cpu_id, 'cpu_table_fallback_no_observed' as universe_source
    FROM cpu
    WHERE NOT EXISTS (SELECT 1 FROM observed_sched_cpus)
      AND NOT EXISTS (SELECT 1 FROM observed_counter_cpus)
  ),
  cpu_capacity AS (
    SELECT
      cu.cpu_id,
      cu.universe_source,
      COALESCE(c.capacity, 0) as capacity
    FROM cpu_universe cu
    LEFT JOIN cpu c ON c.id = cu.cpu_id
  ),
  cpu_max_freq AS (
    SELECT t.cpu as cpu_id, MAX(c.value) as max_freq
    FROM counter c
    JOIN cpu_counter_track t ON c.track_id = t.id
    WHERE t.name = 'cpufreq'
      AND t.cpu IN (SELECT cpu_id FROM cpu_universe)
    GROUP BY t.cpu
  ),
  selected_scale_source AS (
    SELECT
        CASE
          WHEN (SELECT COUNT(*) FROM cpu_capacity) > 0
            AND (SELECT COUNT(*) FROM cpu_capacity WHERE universe_source = 'cpu_table_fallback_no_observed') = 0
            AND (SELECT COUNT(*) FROM cpu_capacity WHERE capacity > 0) = (SELECT COUNT(*) FROM cpu_capacity)
            THEN 'capacity_scale'
          WHEN (SELECT COUNT(*) FROM cpu_capacity) > 0
            AND (SELECT COUNT(*) FROM cpu_capacity WHERE universe_source = 'cpu_table_fallback_no_observed') = 0
            AND (SELECT COUNT(*) FROM cpu_max_freq WHERE max_freq > 0) = (SELECT COUNT(*) FROM cpu_capacity)
            THEN 'freq_rank'
          ELSE 'observed_no_scale'
        END as source
  ),
  raw_cpu_scale AS (
    SELECT
      cc.cpu_id,
      cc.universe_source,
      CASE
        WHEN s.source = 'capacity_scale' THEN cc.capacity
        WHEN s.source = 'freq_rank' THEN cf.max_freq
        ELSE NULL
      END as scale_value
    FROM cpu_capacity cc
    LEFT JOIN cpu_max_freq cf ON cc.cpu_id = cf.cpu_id
    CROSS JOIN selected_scale_source s
  ),
  scale_bounds AS (
    SELECT MAX(scale_value) as max_scale
    FROM raw_cpu_scale
    WHERE scale_value > 0
  ),
  cpu_scale AS (
    SELECT
      rs.*,
      CASE
        WHEN rs.scale_value > 0 AND (SELECT max_scale FROM scale_bounds) > 0
          THEN CAST(ROUND(rs.scale_value * 20.0 / (SELECT max_scale FROM scale_bounds)) AS INTEGER)
        ELSE NULL
      END as scale_bucket
    FROM raw_cpu_scale rs
  ),
  distinct_scales AS (
    SELECT
      scale_bucket,
      avg_scale_value,
      ROW_NUMBER() OVER (ORDER BY scale_bucket ASC) as cluster_rank,
      COUNT(*) OVER () as cluster_count
    FROM (
      SELECT scale_bucket, AVG(scale_value) as avg_scale_value
      FROM cpu_scale
      WHERE scale_bucket IS NOT NULL AND scale_bucket > 0
      GROUP BY scale_bucket
    )
  ),
  scale_clusters AS (
    SELECT
      ds.scale_bucket,
      ds.avg_scale_value,
      ds.cluster_rank,
      ds.cluster_count,
      COUNT(cs.cpu_id) as cores_in_cluster
    FROM distinct_scales ds
    JOIN cpu_scale cs ON cs.scale_bucket = ds.scale_bucket
    GROUP BY ds.scale_bucket, ds.avg_scale_value, ds.cluster_rank, ds.cluster_count
  ),
  cpu_topology AS (
    SELECT
      cs.cpu_id,
      CASE
        WHEN cs.scale_bucket IS NULL OR cs.scale_bucket <= 0 THEN 'unknown'
        WHEN sc.cluster_count <= 1 THEN 'unknown'
        WHEN sc.cluster_count = 2 AND sc.cluster_rank = sc.cluster_count THEN 'big'
        WHEN sc.cluster_rank = 1 THEN 'little'
        WHEN sc.cluster_rank = sc.cluster_count AND sc.cores_in_cluster = 1 THEN 'prime'
        WHEN sc.cluster_rank = sc.cluster_count THEN 'big'
        WHEN sc.cluster_rank = sc.cluster_count - 1
          AND (SELECT cores_in_cluster FROM scale_clusters WHERE cluster_rank = sc.cluster_count) = 1 THEN 'big'
        ELSE 'medium'
      END as core_type
    FROM cpu_scale cs
    LEFT JOIN scale_clusters sc ON cs.scale_bucket = sc.scale_bucket
  )
`;

export const frameAnalyzerTool: Tool<FrameAnalyzerParams, FrameAnalyzerResult> = {
  definition,

  async execute(params: FrameAnalyzerParams, context: ToolContext): Promise<ToolResult<FrameAnalyzerResult>> {
    const startTime = Date.now();
    const result: FrameAnalyzerResult = {};
    const pkg = params.package || '';

    try {
      const includeAll = !params.include_quadrants && !params.include_binder && 
                         !params.include_slices && !params.include_cpu_freq;

      if (includeAll || params.include_quadrants) {
        const quadrantSQL = `
          WITH ${CPU_TOPOLOGY_CTE},
          target_threads AS (
            SELECT t.utid, t.tid, t.name as thread_name, p.pid,
              CASE
                WHEN t.tid = p.pid THEN 'MainThread'
                WHEN t.name = 'RenderThread' THEN 'RenderThread'
                ELSE 'Other'
              END as thread_type
            FROM thread t
            JOIN process p ON t.upid = p.upid
            WHERE (p.name GLOB '${pkg}*' OR '${pkg}' = '')
              AND (t.tid = p.pid OR t.name = 'RenderThread')
          ),
          thread_states AS (
            SELECT
              tt.thread_type,
              ts.state,
              ts.cpu,
              ts.dur,
              CASE
                WHEN ts.state = 'Running' AND COALESCE(ct.core_type, 'unknown') IN ('prime', 'big') THEN 'Q1'
                WHEN ts.state = 'Running' AND COALESCE(ct.core_type, 'unknown') IN ('medium', 'little') THEN 'Q2'
                WHEN ts.state = 'R' THEN 'Q3'
                WHEN ts.state IN ('S', 'D', 'I') THEN 'Q4'
                ELSE 'Other'
              END as quadrant
            FROM thread_state ts
            JOIN target_threads tt ON ts.utid = tt.utid
            LEFT JOIN cpu_topology ct ON ts.cpu = ct.cpu_id
            WHERE ts.ts >= ${params.start_ts} AND ts.ts < ${params.end_ts}
          )
          SELECT
            thread_type,
            ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q1' THEN dur ELSE 0 END) / NULLIF(SUM(dur), 0), 1) as q1_pct,
            ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q2' THEN dur ELSE 0 END) / NULLIF(SUM(dur), 0), 1) as q2_pct,
            ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q3' THEN dur ELSE 0 END) / NULLIF(SUM(dur), 0), 1) as q3_pct,
            ROUND(100.0 * SUM(CASE WHEN quadrant = 'Q4' THEN dur ELSE 0 END) / NULLIF(SUM(dur), 0), 1) as q4_pct
          FROM thread_states
          GROUP BY thread_type
        `;
        const quadrantResult = await sqlExecutorTool.execute({ sql: quadrantSQL }, context);
        if (quadrantResult.success && quadrantResult.data) {
          result.quadrants = quadrantResult.data.rows.map(row => ({
            thread_type: row[0],
            q1_pct: row[1] || 0,
            q2_pct: row[2] || 0,
            q3_pct: row[3] || 0,
            q4_pct: row[4] || 0,
          }));
        }
      }

      if (includeAll || params.include_binder) {
        const binderSQL = `
          SELECT
            server_process,
            COUNT(*) as call_count,
            ROUND(SUM(client_dur) / 1e6, 2) as total_ms,
            ROUND(MAX(client_dur) / 1e6, 2) as max_ms
          FROM android_binder_txns
          WHERE client_ts >= ${params.start_ts} AND client_ts < ${params.end_ts}
            AND (client_process GLOB '${pkg}*' OR '${pkg}' = '')
          GROUP BY server_process
          HAVING total_ms > 0.5
          ORDER BY total_ms DESC
          LIMIT 5
        `;
        const binderResult = await sqlExecutorTool.execute({ sql: binderSQL }, context);
        if (binderResult.success && binderResult.data) {
          result.binderCalls = binderResult.data.rows.map(row => ({
            server_process: row[0],
            call_count: row[1],
            total_ms: row[2],
            max_ms: row[3],
          }));
        }
      }

      if (includeAll || params.include_slices) {
        const mainSlicesSQL = `
          WITH main_thread AS (
            SELECT t.utid FROM thread t
            JOIN process p ON t.upid = p.upid
            WHERE (p.name GLOB '${pkg}*' OR '${pkg}' = '') AND t.tid = p.pid
          )
          SELECT s.name, ROUND(SUM(s.dur) / 1e6, 2) as total_ms, COUNT(*) as count, ROUND(MAX(s.dur) / 1e6, 2) as max_ms
          FROM slice s
          JOIN thread_track tt ON s.track_id = tt.id
          WHERE tt.utid IN (SELECT utid FROM main_thread)
            AND s.ts >= ${params.start_ts} AND s.ts < ${params.end_ts}
            AND s.dur >= 1000000
          GROUP BY s.name
          HAVING total_ms > 1
          ORDER BY total_ms DESC
          LIMIT 10
        `;
        const mainResult = await sqlExecutorTool.execute({ sql: mainSlicesSQL }, context);
        if (mainResult.success && mainResult.data) {
          result.mainThreadSlices = mainResult.data.rows.map(row => ({
            name: row[0],
            total_ms: row[1],
            count: row[2],
            max_ms: row[3],
          }));
        }

        const renderSlicesSQL = `
          WITH render_thread AS (
            SELECT t.utid FROM thread t
            JOIN process p ON t.upid = p.upid
            WHERE (p.name GLOB '${pkg}*' OR '${pkg}' = '') AND t.name = 'RenderThread'
          )
          SELECT s.name, ROUND(SUM(s.dur) / 1e6, 2) as total_ms, COUNT(*) as count, ROUND(MAX(s.dur) / 1e6, 2) as max_ms
          FROM slice s
          JOIN thread_track tt ON s.track_id = tt.id
          WHERE tt.utid IN (SELECT utid FROM render_thread)
            AND s.ts >= ${params.start_ts} AND s.ts < ${params.end_ts}
            AND s.dur >= 500000
          GROUP BY s.name
          HAVING total_ms > 0.5
          ORDER BY total_ms DESC
          LIMIT 10
        `;
        const renderResult = await sqlExecutorTool.execute({ sql: renderSlicesSQL }, context);
        if (renderResult.success && renderResult.data) {
          result.renderThreadSlices = renderResult.data.rows.map(row => ({
            name: row[0],
            total_ms: row[1],
            count: row[2],
            max_ms: row[3],
          }));
        }
      }

      if (includeAll || params.include_cpu_freq) {
        const freqSQL = `
          WITH ${CPU_TOPOLOGY_CTE},
          freq_data AS (
            SELECT t.cpu, COALESCE(ct.core_type, 'unknown') as core_type, c.value as freq_khz
            FROM counter c
            JOIN cpu_counter_track t ON c.track_id = t.id
            LEFT JOIN cpu_topology ct ON t.cpu = ct.cpu_id
            WHERE t.name = 'cpufreq' AND c.ts >= ${params.start_ts} AND c.ts < ${params.end_ts}
          )
          SELECT core_type, ROUND(AVG(freq_khz) / 1000, 0) as avg_freq_mhz,
                 ROUND(MAX(freq_khz) / 1000, 0) as max_freq_mhz,
                 ROUND(MIN(freq_khz) / 1000, 0) as min_freq_mhz
          FROM freq_data
          GROUP BY core_type
        `;
        const freqResult = await sqlExecutorTool.execute({ sql: freqSQL }, context);
        if (freqResult.success && freqResult.data) {
          result.cpuFrequency = freqResult.data.rows.map(row => ({
            core_type: row[0],
            avg_freq_mhz: row[1],
            max_freq_mhz: row[2],
            min_freq_mhz: row[3],
          }));
        }
      }

      return {
        success: true,
        data: result,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  },
};
