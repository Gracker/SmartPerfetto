/**
 * 帧率统计分析模板
 * 分析应用的帧率性能：FPS、掉帧、P95/P99延迟等
 */

import { TraceProcessorService } from '../traceProcessorService';
import { inferVsyncPeriodNs } from '../../config/thresholds';

export interface FrameStatsResult {
  summary: {
    totalFrames: number;
    avgFps: number;
    jankCount: number;
    jankPercentage: number;
    avgFrameDurationMs: number;
  };
  percentiles: {
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  jankFrames: {
    timestamp: number;
    durationMs: number;
    vsyncsMissed: number;
  }[];
  visualization: {
    type: 'histogram';
    data: {
      bucketStart: number;
      bucketEnd: number;
      count: number;
    }[];
  };
}

export interface FrameStatsAnalyzerConfig {
  /** Target frame time in milliseconds (default: derived from 60Hz) */
  targetFrameTimeMs?: number;
  /** Number of VSync periods missed before counting as jank (default: 2) */
  jankVsyncThreshold?: number;
  /** Detected VSync period in nanoseconds from trace metadata */
  detectedVsyncPeriodNs?: string | bigint | number;
  /** Device refresh rate in Hz from trace metadata */
  deviceRefreshRate?: number;
}

export class FrameStatsAnalyzer {
  /**
   * Target frame time in milliseconds.
   * Derived from the configured VSync period (default 60Hz = 16.67ms).
   */
  private readonly targetFrameTimeMs: number;

  /**
   * Jank threshold in milliseconds.
   * Default: 2 * targetFrameTimeMs (missing 2+ VSyncs = jank).
   */
  private readonly jankThresholdMs: number;

  constructor(
    private traceProcessor: TraceProcessorService,
    config?: FrameStatsAnalyzerConfig
  ) {
    // Use configured value or derive from centralized VSync config.
    // For frame stats fallback, use 60Hz baseline unless trace metadata provides a better value.
    const defaultVsyncMs = Number(
      inferVsyncPeriodNs({
        detectedVsyncPeriodNs: config?.detectedVsyncPeriodNs,
        deviceRefreshRate: config?.deviceRefreshRate ?? 60,
      })
    ) / 1_000_000;
    this.targetFrameTimeMs = config?.targetFrameTimeMs ?? defaultVsyncMs;

    // Jank threshold: default 2 VSyncs missed
    const jankVsyncThreshold = config?.jankVsyncThreshold ?? 2;
    this.jankThresholdMs = this.targetFrameTimeMs * jankVsyncThreshold;
  }

  /**
   * 执行帧率统计分析
   * @param traceId Trace ID
   * @param packageName 应用包名，可选
   * @param startTs 开始时间戳（纳秒），可选
   * @param endTs 结束时间戳（纳秒），可选
   */
  async analyze(
    traceId: string,
    packageName?: string,
    startTs?: number,
    endTs?: number
  ): Promise<FrameStatsResult> {
    const timeCondition = this.buildTimeCondition(startTs, endTs);
    const packageCondition = packageName
      ? `AND process.name LIKE '%${this.escapeLikePattern(packageName)}%' ESCAPE '\\'`
      : '';

    // 查询所有帧的时长
    // 使用 actual_frame_timeline_slice 表（Android 的帧时间线）
    const query = `
      SELECT
        ts,
        dur / 1e6 as dur_ms,
        frame_number
      FROM actual_frame_timeline_slice slice
      JOIN process_track track ON slice.track_id = track.id
      JOIN process ON track.upid = process.upid
      WHERE dur > 0
        ${timeCondition}
        ${packageCondition}
      ORDER BY ts
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      throw new Error('No frame data found. Make sure the trace contains frame timing information.');
    }

    // 计算基本统计
    const durations = rows.map(r => parseFloat(r.dur_ms));
    const totalFrames = durations.length;
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / totalFrames;

    // 计算时间范围（秒）
    const firstTs = parseInt(rows[0].ts);
    const lastTs = parseInt(rows[rows.length - 1].ts);
    const rawTotalTimeSec = (lastTs - firstTs) / 1e9;
    const totalTimeSec = rawTotalTimeSec > 0 ? rawTotalTimeSec : 1e-6;
    const avgFps = totalFrames / totalTimeSec;

    // 识别掉帧
    const allJankFrames = rows
      .filter(r => parseFloat(r.dur_ms) > this.jankThresholdMs)
      .map(r => ({
        timestamp: parseInt(r.ts),
        durationMs: parseFloat(r.dur_ms),
        vsyncsMissed: Math.floor(parseFloat(r.dur_ms) / this.targetFrameTimeMs),
      }));
    const jankFrames = allJankFrames.slice(0, 100); // 限制返回前 100 个掉帧点

    const jankCount = allJankFrames.length;
    const jankPercentage = (jankCount / totalFrames) * 100;

    // 计算百分位数
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const percentiles = {
      p50Ms: this.getPercentile(sortedDurations, 50),
      p90Ms: this.getPercentile(sortedDurations, 90),
      p95Ms: this.getPercentile(sortedDurations, 95),
      p99Ms: this.getPercentile(sortedDurations, 99),
      maxMs: Math.max(...durations),
    };

    // 生成直方图数据
    const histogram = this.generateHistogram(durations);

    return {
      summary: {
        totalFrames,
        avgFps,
        jankCount,
        jankPercentage,
        avgFrameDurationMs: avgDuration,
      },
      percentiles,
      jankFrames,
      visualization: {
        type: 'histogram',
        data: histogram,
      },
    };
  }

  /**
   * 简化版分析：基于 slice 表（适用于没有 actual_frame_timeline_slice 的trace）
   */
  async analyzeFromSlices(
    traceId: string,
    processName: string,
    startTs?: number,
    endTs?: number
  ): Promise<FrameStatsResult> {
    const timeCondition = this.buildTimeCondition(startTs, endTs);

    // 查找渲染相关的 slice
    const query = `
      SELECT
        ts,
        dur / 1e6 as dur_ms,
        name
      FROM slice
      WHERE (
        name LIKE 'Choreographer#doFrame'
        OR name LIKE 'DrawFrame'
        OR name LIKE 'performTraversals'
      )
      ${timeCondition}
      ORDER BY ts
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      throw new Error('No frame data found in slice table');
    }

    // 使用类似的统计方法
    const durations = rows.map(r => parseFloat(r.dur_ms));
    const totalFrames = durations.length;
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / totalFrames;

    const firstTs = parseInt(rows[0].ts);
    const lastTs = parseInt(rows[rows.length - 1].ts);
    const rawTotalTimeSec = (lastTs - firstTs) / 1e9;
    const totalTimeSec = rawTotalTimeSec > 0 ? rawTotalTimeSec : 1e-6;
    const avgFps = totalFrames / totalTimeSec;

    const allJankFrames = rows
      .filter(r => parseFloat(r.dur_ms) > this.jankThresholdMs)
      .map(r => ({
        timestamp: parseInt(r.ts),
        durationMs: parseFloat(r.dur_ms),
        vsyncsMissed: Math.floor(parseFloat(r.dur_ms) / this.targetFrameTimeMs),
      }));
    const jankFrames = allJankFrames.slice(0, 100);

    const sortedDurations = [...durations].sort((a, b) => a - b);

    return {
      summary: {
        totalFrames,
        avgFps,
        jankCount: allJankFrames.length,
        jankPercentage: (allJankFrames.length / totalFrames) * 100,
        avgFrameDurationMs: avgDuration,
      },
      percentiles: {
        p50Ms: this.getPercentile(sortedDurations, 50),
        p90Ms: this.getPercentile(sortedDurations, 90),
        p95Ms: this.getPercentile(sortedDurations, 95),
        p99Ms: this.getPercentile(sortedDurations, 99),
        maxMs: Math.max(...durations),
      },
      jankFrames,
      visualization: {
        type: 'histogram',
        data: this.generateHistogram(durations),
      },
    };
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  private generateHistogram(durations: number[]): {
    bucketStart: number;
    bucketEnd: number;
    count: number;
  }[] {
    // 创建直方图桶：0-8ms, 8-16ms, 16-24ms, 24-32ms, 32+ms
    const buckets = [
      { start: 0, end: 8, count: 0 },
      { start: 8, end: 16, count: 0 },
      { start: 16, end: 24, count: 0 },
      { start: 24, end: 32, count: 0 },
      { start: 32, end: Infinity, count: 0 },
    ];

    durations.forEach(dur => {
      const bucket = buckets.find(b => dur >= b.start && dur < b.end);
      if (bucket) {
        bucket.count++;
      }
    });

    return buckets.map(b => ({
      bucketStart: b.start,
      bucketEnd: b.end === Infinity ? 999 : b.end,
      count: b.count,
    }));
  }

  private buildTimeCondition(startTs?: number, endTs?: number): string {
    const safeStart = this.normalizeTimestamp(startTs);
    const safeEnd = this.normalizeTimestamp(endTs);
    if (safeStart === undefined && safeEnd === undefined) return '';
    if (safeStart !== undefined && safeEnd === undefined) return `AND ts >= ${safeStart}`;
    if (safeStart === undefined && safeEnd !== undefined) return `AND ts <= ${safeEnd}`;
    return `AND ts >= ${safeStart} AND ts <= ${safeEnd}`;
  }

  private normalizeTimestamp(ts?: number): number | undefined {
    if (ts === undefined || ts === null) return undefined;
    const n = Number(ts);
    if (!Number.isFinite(n)) return undefined;
    return Math.floor(n);
  }

  private escapeLikePattern(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/'/g, "''");
  }

  private resultToRows(result: any): any[] {
    if (!result || !result.columns || !result.rows) {
      return [];
    }

    return result.rows.map((row: any[]) => {
      const obj: any = {};
      result.columns.forEach((col: string, idx: number) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }
}
