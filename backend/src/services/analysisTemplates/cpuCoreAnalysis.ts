/**
 * CPU 大小核分布分析模板
 * 分析线程在不同 CPU 核心上的运行时间分布
 */

import { TraceProcessorService } from '../traceProcessorService';

export interface CpuCoreDistribution {
  summary: {
    totalMs: number;
    littleCoreMs: number;
    bigCoreMs: number;
    littleCorePercentage: number;
    bigCorePercentage: number;
  };
  breakdown: CoreBreakdown[];
  visualization: {
    type: 'bar_chart';
    data: {
      label: string;
      value: number;
      percentage: number;
      color: string;
    }[];
  };
  frequencyDistribution?: FrequencyDistribution;
}

export interface CoreBreakdown {
  cpu: number;
  coreType: 'little' | 'big' | 'unknown';
  sliceCount: number;
  totalMs: number;
  avgMs: number;
  percentage: number;
}

export interface FrequencyDistribution {
  avgFrequencyMhz: number;
  timeByFrequency: {
    frequencyMhz: number;
    durationMs: number;
    percentage: number;
  }[];
}

export class CpuCoreAnalyzer {
  // Android 常见的核心配置
  // 大部分设备：CPU 0-3 小核，4-7 大核
  // 也有 0-5 小核，6-7 大核的配置
  private littleCores: number[] = [0, 1, 2, 3];
  private bigCores: number[] = [4, 5, 6, 7];

  constructor(private traceProcessor: TraceProcessorService) {}

  /**
   * 执行 CPU 核心分布分析
   * @param traceId Trace ID
   * @param threadId 线程 ID（utid）
   * @param startTs 开始时间戳（纳秒），可选
   * @param endTs 结束时间戳（纳秒），可选
   */
  async analyze(
    traceId: string,
    threadId: number,
    startTs?: number,
    endTs?: number
  ): Promise<CpuCoreDistribution> {
    // 首先尝试自动检测大小核配置
    await this.detectCoreConfiguration(traceId);

    const timeCondition = this.buildTimeCondition(startTs, endTs);

    // 查询线程在各个 CPU 上的运行时间
    const query = `
      SELECT
        cpu,
        COUNT(*) as slice_count,
        SUM(dur) / 1e6 as total_ms,
        AVG(dur) / 1e6 as avg_ms
      FROM sched_slice
      WHERE utid = ${threadId}
        ${timeCondition}
      GROUP BY cpu
      ORDER BY cpu
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);

    if (rows.length === 0) {
      throw new Error('No scheduling data found for the specified thread');
    }

    // 计算总时间
    const totalMs = rows.reduce((sum, row) => sum + parseFloat(row.total_ms), 0);

    // 按核心类型分类
    const breakdown: CoreBreakdown[] = rows.map(row => {
      const cpu = parseInt(row.cpu);
      const coreType = this.getCoreType(cpu);
      const cpuTotalMs = parseFloat(row.total_ms);

      return {
        cpu,
        coreType,
        sliceCount: parseInt(row.slice_count),
        totalMs: cpuTotalMs,
        avgMs: parseFloat(row.avg_ms),
        percentage: (cpuTotalMs / totalMs) * 100,
      };
    });

    // 计算大小核总时间
    const littleCoreMs = breakdown
      .filter(b => b.coreType === 'little')
      .reduce((sum, b) => sum + b.totalMs, 0);

    const bigCoreMs = breakdown
      .filter(b => b.coreType === 'big')
      .reduce((sum, b) => sum + b.totalMs, 0);

    const frequencyDistribution = await this.analyzeFrequency(traceId, threadId, startTs, endTs);

    return {
      summary: {
        totalMs,
        littleCoreMs,
        bigCoreMs,
        littleCorePercentage: (littleCoreMs / totalMs) * 100,
        bigCorePercentage: (bigCoreMs / totalMs) * 100,
      },
      breakdown,
      visualization: {
        type: 'bar_chart',
        data: breakdown.map(b => ({
          label: `CPU ${b.cpu} (${b.coreType})`,
          value: b.totalMs,
          percentage: b.percentage,
          color: this.getCoreColor(b.coreType),
        })),
      },
      frequencyDistribution: frequencyDistribution || undefined,
    };
  }

  /**
   * 自动检测大小核配置
   * 基于 CPU 最大频率来判断
   */
  private async detectCoreConfiguration(traceId: string): Promise<void> {
    try {
      // 查询各个 CPU 的最大频率
      const query = `
        SELECT
          cpu,
          MAX(value) as max_freq
        FROM counter c
        JOIN cpu_counter_track t ON c.track_id = t.id
        WHERE t.name = 'cpufreq'
        GROUP BY cpu
        ORDER BY cpu
      `;

      const result = await this.traceProcessor.query(traceId, query);
      const rows = this.resultToRows(result);

      if (rows.length === 0) {
        // 无法检测，使用默认配置
        return;
      }

      // 按最大频率排序
      const sortedByFreq = rows
        .map(r => ({
          cpu: parseInt(r.cpu),
          maxFreq: parseFloat(r.max_freq),
        }))
        .sort((a, b) => a.maxFreq - b.maxFreq);

      // 简单策略：频率最低的一半是小核
      const mid = Math.floor(sortedByFreq.length / 2);
      this.littleCores = sortedByFreq.slice(0, mid).map(c => c.cpu);
      this.bigCores = sortedByFreq.slice(mid).map(c => c.cpu);

      console.log(`Detected core configuration: Little=${this.littleCores}, Big=${this.bigCores}`);
    } catch (error) {
      console.warn('Failed to detect core configuration, using default:', error);
    }
  }

  private getCoreType(cpu: number): 'little' | 'big' | 'unknown' {
    if (this.littleCores.includes(cpu)) return 'little';
    if (this.bigCores.includes(cpu)) return 'big';
    return 'unknown';
  }

  private getCoreColor(coreType: string): string {
    const colors: Record<string, string> = {
      little: '#10b981',  // 绿色 - 小核
      big: '#f59e0b',     // 橙色 - 大核
      unknown: '#6b7280', // 灰色
    };
    return colors[coreType] || '#6b7280';
  }

  private buildTimeCondition(startTs?: number, endTs?: number): string {
    if (!startTs && !endTs) return '';
    if (startTs && !endTs) return `AND ts >= ${startTs}`;
    if (!startTs && endTs) return `AND ts <= ${endTs}`;
    return `AND ts >= ${startTs} AND ts <= ${endTs}`;
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

  /**
   * 分析 CPU 频率分布（可选功能）
   */
  private async analyzeFrequency(
    traceId: string,
    threadId: number,
    startTs?: number,
    endTs?: number
  ): Promise<FrequencyDistribution | null> {
    const bounds = await this.resolveThreadTimeRange(traceId, threadId, startTs, endTs);
    if (!bounds) {
      return null;
    }

    const { start, end } = bounds;
    const timeCondition = this.buildTimeCondition(start, end);

    const query = `
      WITH freq AS (
        SELECT
          t.cpu AS cpu,
          c.ts AS ts,
          COALESCE(
            LEAD(c.ts) OVER (PARTITION BY t.cpu ORDER BY c.ts),
            ${end}
          ) - c.ts AS dur,
          c.value AS freq_khz
        FROM counter c
        JOIN cpu_counter_track t ON c.track_id = t.id
        WHERE t.name = 'cpufreq'
      ),
      sched AS (
        SELECT
          ts,
          dur,
          cpu
        FROM sched_slice
        WHERE utid = ${threadId}
          ${timeCondition}
      ),
      overlap AS (
        SELECT
          f.freq_khz AS freq_khz,
          MAX(0, MIN(s.ts + s.dur, f.ts + f.dur) - MAX(s.ts, f.ts)) AS overlap_dur
        FROM sched s
        JOIN freq f
          ON s.cpu = f.cpu
         AND f.dur > 0
         AND s.ts < f.ts + f.dur
         AND f.ts < s.ts + s.dur
      )
      SELECT
        freq_khz,
        SUM(overlap_dur) AS total_dur_ns
      FROM overlap
      WHERE overlap_dur > 0
      GROUP BY freq_khz
      ORDER BY freq_khz
    `;

    const result = await this.traceProcessor.query(traceId, query);
    const rows = this.resultToRows(result);
    if (rows.length === 0) {
      return null;
    }

    const totalDurNs = rows.reduce((sum, row) => sum + Number(row.total_dur_ns || 0), 0);
    if (totalDurNs <= 0) {
      return null;
    }

    const timeByFrequency = rows.map(row => {
      const freqMhz = Number(row.freq_khz) / 1000;
      const durationMs = Number(row.total_dur_ns) / 1e6;
      return {
        frequencyMhz: freqMhz,
        durationMs,
        percentage: (Number(row.total_dur_ns) / totalDurNs) * 100,
      };
    });

    const avgFrequencyMhz = rows.reduce((sum, row) => {
      const freqMhz = Number(row.freq_khz) / 1000;
      return sum + freqMhz * (Number(row.total_dur_ns) / totalDurNs);
    }, 0);

    return {
      avgFrequencyMhz,
      timeByFrequency,
    };
  }

  private async resolveThreadTimeRange(
    traceId: string,
    threadId: number,
    startTs?: number,
    endTs?: number
  ): Promise<{ start: number; end: number } | null> {
    if (startTs !== undefined && endTs !== undefined) {
      return { start: startTs, end: endTs };
    }

    try {
      const query = `
        SELECT
          MIN(ts) AS start_ts,
          MAX(ts + dur) AS end_ts
        FROM sched_slice
        WHERE utid = ${threadId}
      `;
      const result = await this.traceProcessor.query(traceId, query);
      if (result && result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        const start = startTs ?? (row[0] as number);
        const end = endTs ?? (row[1] as number);
        if (start !== null && end !== null && start !== undefined && end !== undefined) {
          return { start, end };
        }
      }
    } catch (error) {
      console.warn('Failed to resolve thread time range:', error);
    }

    if (startTs !== undefined && endTs === undefined) {
      return { start: startTs, end: startTs + 1 };
    }

    return null;
  }
}
