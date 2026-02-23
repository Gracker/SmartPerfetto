/**
 * 分析模板管理器
 * 根据用户问题自动选择合适的分析模板
 */

import { TraceProcessorService } from '../traceProcessorService';
import { FourQuadrantAnalyzer, FourQuadrantResult } from './fourQuadrantAnalysis';
import { CpuCoreAnalyzer, CpuCoreDistribution } from './cpuCoreAnalysis';
import { FrameStatsAnalyzer, FrameStatsResult } from './frameStatsAnalysis';

export type AnalysisTemplateName =
  | 'four_quadrant'
  | 'cpu_core_distribution'
  | 'frame_stats'
  | 'custom';

export interface AnalysisTemplateResult {
  templateName: AnalysisTemplateName;
  data: FourQuadrantResult | CpuCoreDistribution | FrameStatsResult | any;
  summary: string;
}

export interface TemplateSelectionContext {
  question: string;
  traceId: string;
  metadata?: {
    hasFrameData?: boolean;
    hasSchedData?: boolean;
    processNames?: string[];
    detectedVsyncPeriodNs?: string | bigint | number;
    deviceRefreshRate?: number;
  };
}

export class AnalysisTemplateManager {
  private fourQuadrantAnalyzer: FourQuadrantAnalyzer;
  private cpuCoreAnalyzer: CpuCoreAnalyzer;

  constructor(private traceProcessor: TraceProcessorService) {
    this.fourQuadrantAnalyzer = new FourQuadrantAnalyzer(traceProcessor);
    this.cpuCoreAnalyzer = new CpuCoreAnalyzer(traceProcessor);
  }

  /**
   * 根据用户问题自动选择并执行分析模板
   */
  async analyzeWithAutoTemplate(
    context: TemplateSelectionContext
  ): Promise<AnalysisTemplateResult | null> {
    const templateName = this.selectTemplate(context.question);

    if (templateName === 'custom') {
      return null; // 需要自定义 SQL
    }

    try {
      const result = await this.executeTemplate(templateName, context);
      return {
        templateName,
        data: result,
        summary: this.generateSummary(templateName, result),
      };
    } catch (error: any) {
      console.error(`Failed to execute template ${templateName}:`, error);
      return null;
    }
  }

  /**
   * 根据问题选择合适的模板
   */
  private selectTemplate(question: string): AnalysisTemplateName {
    const questionLower = question.toLowerCase();

    // 四大象限分析
    if (
      questionLower.includes('四大象限') ||
      questionLower.includes('binder') ||
      questionLower.includes('lock') ||
      questionLower.includes('io') ||
      (questionLower.includes('耗时') && questionLower.includes('分布')) ||
      questionLower.includes('时间占比')
    ) {
      return 'four_quadrant';
    }

    // CPU 核心分布
    if (
      questionLower.includes('cpu') ||
      questionLower.includes('核心') ||
      questionLower.includes('大核') ||
      questionLower.includes('小核') ||
      questionLower.includes('big core') ||
      questionLower.includes('little core')
    ) {
      return 'cpu_core_distribution';
    }

    // 帧率统计
    if (
      questionLower.includes('fps') ||
      questionLower.includes('帧率') ||
      questionLower.includes('掉帧') ||
      questionLower.includes('jank') ||
      questionLower.includes('卡顿') ||
      questionLower.includes('流畅') ||
      questionLower.includes('frame')
    ) {
      return 'frame_stats';
    }

    // 默认返回自定义
    return 'custom';
  }

  /**
   * 执行指定的分析模板
   */
  private async executeTemplate(
    templateName: AnalysisTemplateName,
    context: TemplateSelectionContext
  ): Promise<any> {
    switch (templateName) {
      case 'four_quadrant':
        return await this.executeFourQuadrant(context);

      case 'cpu_core_distribution':
        return await this.executeCpuCoreDistribution(context);

      case 'frame_stats':
        return await this.executeFrameStats(context);

      default:
        throw new Error(`Unknown template: ${templateName}`);
    }
  }

  private async executeFourQuadrant(
    context: TemplateSelectionContext
  ): Promise<FourQuadrantResult> {
    const params = await this.extractFourQuadrantParams(context);
    return await this.fourQuadrantAnalyzer.analyze(
      context.traceId,
      params.startTs,
      params.endTs,
      params.threadId
    );
  }

  private async executeCpuCoreDistribution(
    context: TemplateSelectionContext
  ): Promise<CpuCoreDistribution> {
    // 需要找到主线程的 utid
    // 简单实现：查找第一个进程的主线程
    const mainThreadUtid = await this.findMainThread(context.traceId);

    if (!mainThreadUtid) {
      throw new Error('Could not find main thread');
    }

    return await this.cpuCoreAnalyzer.analyze(context.traceId, mainThreadUtid);
  }

  private async executeFrameStats(
    context: TemplateSelectionContext
  ): Promise<FrameStatsResult> {
    const frameStatsAnalyzer = new FrameStatsAnalyzer(this.traceProcessor, {
      detectedVsyncPeriodNs: context.metadata?.detectedVsyncPeriodNs,
      deviceRefreshRate: context.metadata?.deviceRefreshRate,
    });

    // 尝试使用 actual_frame_timeline_slice
    try {
      return await frameStatsAnalyzer.analyze(context.traceId);
    } catch (error) {
      // 降级到基于 slice 的分析
      console.warn('Frame timeline not available, falling back to slice-based analysis');

      // 需要找到进程名
      const processName = await this.findMainProcess(context.traceId);
      return await frameStatsAnalyzer.analyzeFromSlices(
        context.traceId,
        processName || 'unknown'
      );
    }
  }

  /**
   * 查找主线程 utid
   */
  private async findMainThread(traceId: string): Promise<number | null> {
    try {
      const query = `
        SELECT utid
        FROM thread
        WHERE name = 'main' OR tid = pid
        LIMIT 1
      `;

      const result = await this.traceProcessor.query(traceId, query);
      if (result && result.rows && result.rows.length > 0) {
        return result.rows[0][0] as number;
      }
    } catch (error) {
      console.error('Failed to find main thread:', error);
    }
    return null;
  }

  /**
   * 查找主进程名称
   */
  private async findMainProcess(traceId: string): Promise<string | null> {
    try {
      const query = `
        SELECT name
        FROM process
        WHERE name IS NOT NULL
        ORDER BY upid
        LIMIT 1
      `;

      const result = await this.traceProcessor.query(traceId, query);
      if (result && result.rows && result.rows.length > 0) {
        return result.rows[0][0] as string;
      }
    } catch (error) {
      console.error('Failed to find main process:', error);
    }
    return null;
  }

  /**
   * 从问题中提取四大象限分析参数
   */
  private async extractFourQuadrantParams(
    context: TemplateSelectionContext
  ): Promise<{ startTs?: number; endTs?: number; threadId?: number }> {
    const { startTs, endTs } = this.parseTimeRange(context.question);
    const threadId = await this.resolveThreadId(context.traceId, context.question);
    return { startTs, endTs, threadId };
  }

  private parseTimeRange(question: string): { startTs?: number; endTs?: number } {
    const unitMatches = Array.from(
      question.matchAll(/(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|纳秒|微秒|毫秒|秒)/gi)
    );

    const toNs = (value: number, unit: string): number => {
      const normalized = unit.toLowerCase();
      switch (normalized) {
        case 'ns':
        case '纳秒':
          return value;
        case 'us':
        case 'µs':
        case '微秒':
          return value * 1e3;
        case 'ms':
        case '毫秒':
          return value * 1e6;
        case 's':
        case '秒':
          return value * 1e9;
        default:
          return value;
      }
    };

    if (unitMatches.length >= 2) {
      const start = toNs(parseFloat(unitMatches[0][1]), unitMatches[0][2]);
      const end = toNs(parseFloat(unitMatches[1][1]), unitMatches[1][2]);
      return start <= end ? { startTs: start, endTs: end } : { startTs: end, endTs: start };
    }

    const startMatch = question.match(/start(?:_ts)?\s*[:=]\s*(\d+)/i);
    const endMatch = question.match(/end(?:_ts)?\s*[:=]\s*(\d+)/i);
    if (startMatch && endMatch) {
      const start = Number.parseInt(startMatch[1], 10);
      const end = Number.parseInt(endMatch[1], 10);
      return start <= end ? { startTs: start, endTs: end } : { startTs: end, endTs: start };
    }

    const numberMatches = question.match(/\d+(?:\.\d+)?/g);
    if (numberMatches && numberMatches.length >= 2) {
      const hasMs = /ms|毫秒/i.test(question);
      const hasS = /(^|[^m])s|秒/i.test(question);
      const unit = hasMs ? 'ms' : (hasS ? 's' : '');
      if (unit) {
        const start = toNs(parseFloat(numberMatches[0]), unit);
        const end = toNs(parseFloat(numberMatches[1]), unit);
        return start <= end ? { startTs: start, endTs: end } : { startTs: end, endTs: start };
      }
    }

    return {};
  }

  private async resolveThreadId(traceId: string, question: string): Promise<number | undefined> {
    const utidMatch = question.match(/utid\s*[:=]\s*(\d+)/i);
    if (utidMatch) {
      return Number.parseInt(utidMatch[1], 10);
    }

    const tidMatch = question.match(/tid\s*[:=]\s*(\d+)/i);
    if (tidMatch) {
      const tid = Number.parseInt(tidMatch[1], 10);
      const utid = await this.findUtidByTid(traceId, tid);
      if (utid) return utid;
    }

    if (/主线程|main thread|ui thread/i.test(question)) {
      const mainThread = await this.findMainThread(traceId);
      if (mainThread) return mainThread;
    }

    return undefined;
  }

  private async findUtidByTid(traceId: string, tid: number): Promise<number | null> {
    try {
      const query = `
        SELECT utid
        FROM thread
        WHERE tid = ${tid}
        LIMIT 1
      `;
      const result = await this.traceProcessor.query(traceId, query);
      if (result && result.rows && result.rows.length > 0) {
        return result.rows[0][0] as number;
      }
    } catch (error) {
      console.error('Failed to resolve utid from tid:', error);
    }
    return null;
  }

  /**
   * 生成分析摘要
   */
  private generateSummary(templateName: AnalysisTemplateName, data: any): string {
    switch (templateName) {
      case 'four_quadrant':
        return this.summarizeFourQuadrant(data as FourQuadrantResult);

      case 'cpu_core_distribution':
        return this.summarizeCpuCoreDistribution(data as CpuCoreDistribution);

      case 'frame_stats':
        return this.summarizeFrameStats(data as FrameStatsResult);

      default:
        return 'Analysis completed';
    }
  }

  private summarizeFourQuadrant(result: FourQuadrantResult): string {
    const { summary } = result;
    const sorted = [...summary.breakdown].sort((a, b) => b.durationMs - a.durationMs);
    const top = sorted[0];

    return `总时长 ${summary.totalMs.toFixed(2)}ms，其中 ${this.getCategoryLabel(top.category)} 占比最高（${top.percentage.toFixed(1)}%，${top.durationMs.toFixed(2)}ms）`;
  }

  private summarizeCpuCoreDistribution(result: CpuCoreDistribution): string {
    const { summary } = result;

    return `大核使用 ${summary.bigCorePercentage.toFixed(1)}%（${summary.bigCoreMs.toFixed(2)}ms），小核使用 ${summary.littleCorePercentage.toFixed(1)}%（${summary.littleCoreMs.toFixed(2)}ms）`;
  }

  private summarizeFrameStats(result: FrameStatsResult): string {
    const { summary, percentiles } = result;

    return `平均帧率 ${summary.avgFps.toFixed(1)} FPS，掉帧率 ${summary.jankPercentage.toFixed(1)}%（${summary.jankCount}/${summary.totalFrames} 帧），P95延迟 ${percentiles.p95Ms.toFixed(2)}ms`;
  }

  private getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      binder: 'Binder调用',
      lock: 'Lock等待',
      io: 'IO操作',
      computation: 'CPU计算',
    };
    return labels[category] || category;
  }
}
