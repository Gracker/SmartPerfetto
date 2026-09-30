// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 智能摘要生成器 v1.0
 *
 * 基于规则生成有意义的自然语言摘要（无需 AI）
 * 当 AI 服务不可用时作为兜底方案
 */

import { DisplayResult, DiagnosticResult } from './types';
import { DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS } from '../../config/thresholds';

// =============================================================================
// 类型定义
// =============================================================================

export interface SummaryContext {
  skillId: string;
  skillName: string;
  displayResults: DisplayResult[];
  diagnostics: DiagnosticResult[];
  executionTimeMs: number;
}

export interface GeneratedSummary {
  /** 完整摘要文本 */
  text: string;
  /** 摘要各部分 */
  sections: {
    diagnosis?: string;
    metrics?: string;
    suggestions?: string;
  };
  /** 是否有实质内容 */
  hasContent: boolean;
}

// =============================================================================
// 指标配置
// =============================================================================

interface MetricConfig {
  label: string;
  unit?: string;
  threshold?: {
    warning?: number;
    critical?: number;
  };
  format?: (value: any) => string;
}

const METRIC_CONFIGS: Record<string, MetricConfig> = {
  // 帧相关
  jank_rate: {
    label: '掉帧率',
    unit: '%',
    threshold: { warning: 5, critical: 15 },
  },
  janky_frames: {
    label: '掉帧数',
    threshold: { warning: 3, critical: 10 },
  },
  total_frames: {
    label: '总帧数',
  },
  avg_frame_ms: {
    label: '平均帧耗时',
    unit: 'ms',
    threshold: {
      warning: DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgWarningMs,
      critical: DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.avgCriticalMs,
    },
  },
  max_frame_ms: {
    label: '最大帧耗时',
    unit: 'ms',
    threshold: {
      warning: DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.maxWarningMs,
      critical: DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.maxCriticalMs,
    },
  },
  estimated_fps: {
    label: '帧率',
    unit: 'fps',
    threshold: { warning: 55, critical: 45 },
    format: (v) => `${Math.round(v)} fps`,
  },

  // CPU 相关
  total_cpu_ms: {
    label: 'CPU 总耗时',
    unit: 'ms',
  },
  running_ms: {
    label: '运行时间',
    unit: 'ms',
  },
  runnable_ms: {
    label: '等待调度时间',
    unit: 'ms',
    threshold: { warning: 5, critical: 20 },
  },
  max_runnable_ms: {
    label: '最大调度延迟',
    unit: 'ms',
    threshold: { warning: 5, critical: 15 },
  },

  // Binder 相关
  max_delay_ms: {
    label: '最大 Binder 延迟',
    unit: 'ms',
    threshold: { warning: 10, critical: 50 },
  },
  slow_calls: {
    label: '慢调用数',
    threshold: { warning: 1, critical: 5 },
  },
  call_count: {
    label: 'Binder 调用数',
  },

  // 启动相关
  startup_time_ms: {
    label: '启动耗时',
    unit: 'ms',
    threshold: { warning: 1000, critical: 3000 },
  },
  ttid_ms: {
    label: 'TTID',
    unit: 'ms',
    threshold: { warning: 500, critical: 1500 },
  },
  ttfd_ms: {
    label: 'TTFD',
    unit: 'ms',
    threshold: { warning: 1000, critical: 3000 },
  },
};

// =============================================================================
// 智能摘要生成器
// =============================================================================

export class SmartSummaryGenerator {
  /**
   * 生成智能摘要
   */
  generate(context: SummaryContext): GeneratedSummary {
    const sections: GeneratedSummary['sections'] = {};
    const parts: string[] = [];

    // 1. 诊断结论（最重要）
    if (context.diagnostics.length > 0) {
      sections.diagnosis = this.generateDiagnosisSummary(context.diagnostics);
      parts.push(sections.diagnosis);
    }

    // 2. 关键指标
    const metrics = this.extractKeyMetrics(context.displayResults);
    if (metrics.length > 0) {
      sections.metrics = this.formatMetricsSummary(metrics);
      parts.push(sections.metrics);
    }

    // 3. 优化建议
    const suggestions = this.aggregateSuggestions(context.diagnostics);
    if (suggestions.length > 0) {
      sections.suggestions = this.formatSuggestionsSummary(suggestions);
      parts.push(sections.suggestions);
    }

    // 如果都没有内容，生成兜底摘要
    if (parts.length === 0) {
      const fallback = this.generateFallbackSummary(context);
      return {
        text: fallback,
        sections: {},
        hasContent: false,
      };
    }

    return {
      text: parts.join('\n\n'),
      sections,
      hasContent: true,
    };
  }

  /**
   * 生成诊断摘要
   */
  private generateDiagnosisSummary(diagnostics: DiagnosticResult[]): string {
    // 按严重程度排序
    const sorted = this.sortDiagnosticsBySeverity(diagnostics);

    const critical = sorted.filter(d => d.severity === 'critical');
    const warning = sorted.filter(d => d.severity === 'warning');
    const info = sorted.filter(d => d.severity === 'info');

    const lines: string[] = [];

    // 严重问题
    if (critical.length > 0) {
      lines.push(`**发现 ${critical.length} 个严重问题：**`);
      critical.forEach((d, i) => {
        const confidence = Math.round(d.confidence * 100);
        lines.push(`${i + 1}. ${d.diagnosis}（置信度 ${confidence}%）`);
      });
    }

    // 警告问题
    if (warning.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`**${warning.length} 个潜在问题：**`);
      warning.forEach(d => {
        lines.push(`- ${d.diagnosis}`);
      });
    }

    // 信息（只在没有严重/警告问题时显示）
    if (critical.length === 0 && warning.length === 0 && info.length > 0) {
      lines.push(`**分析发现：**`);
      info.forEach(d => {
        lines.push(`- ${d.diagnosis}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * 从 displayResults 中提取关键指标
   */
  private extractKeyMetrics(displayResults: DisplayResult[]): Array<{
    name: string;
    label: string;
    value: any;
    formattedValue: string;
    status: 'normal' | 'warning' | 'critical';
  }> {
    const metrics: Array<{
      name: string;
      label: string;
      value: any;
      formattedValue: string;
      status: 'normal' | 'warning' | 'critical';
    }> = [];

    for (const result of displayResults) {
      // 只从 summary 和 key 级别的结果中提取
      if (result.level !== 'summary' && result.level !== 'key') {
        continue;
      }

      const { data } = result;
      if (!data.rows || data.rows.length === 0 || !data.columns) {
        continue;
      }

      // 取第一行数据
      const row = data.rows[0];

      data.columns.forEach((col, idx) => {
        const value = row[idx];
        const config = METRIC_CONFIGS[col];

        if (config && value != null && value !== '') {
          const status = this.evaluateMetricStatus(col, value, config);
          const formattedValue = this.formatMetricValue(value, config);

          metrics.push({
            name: col,
            label: config.label,
            value,
            formattedValue,
            status,
          });
        }
      });
    }

    // 按重要性排序：有异常的排前面
    return metrics.sort((a, b) => {
      const statusOrder = { critical: 0, warning: 1, normal: 2 };
      return statusOrder[a.status] - statusOrder[b.status];
    });
  }

  /**
   * 评估指标状态
   */
  private evaluateMetricStatus(
    name: string,
    value: number,
    config: MetricConfig
  ): 'normal' | 'warning' | 'critical' {
    if (!config.threshold) return 'normal';

    // 特殊处理：帧率是越高越好
    if (name === 'estimated_fps') {
      if (config.threshold.critical && value < config.threshold.critical) return 'critical';
      if (config.threshold.warning && value < config.threshold.warning) return 'warning';
      return 'normal';
    }

    // 其他指标是越低越好
    if (config.threshold.critical && value >= config.threshold.critical) return 'critical';
    if (config.threshold.warning && value >= config.threshold.warning) return 'warning';
    return 'normal';
  }

  /**
   * 格式化指标值
   */
  private formatMetricValue(value: any, config: MetricConfig): string {
    if (config.format) {
      return config.format(value);
    }

    if (typeof value === 'number') {
      // 保留合适的小数位
      const formatted = Number.isInteger(value) ? value : value.toFixed(2);
      return config.unit ? `${formatted} ${config.unit}` : String(formatted);
    }

    return String(value);
  }

  /**
   * 格式化指标摘要
   */
  private formatMetricsSummary(metrics: Array<{
    name: string;
    label: string;
    value: any;
    formattedValue: string;
    status: 'normal' | 'warning' | 'critical';
  }>): string {
    const lines: string[] = ['**关键指标：**'];

    // 最多显示 6 个关键指标
    const topMetrics = metrics.slice(0, 6);

    topMetrics.forEach(m => {
      const icon = m.status === 'critical' ? '🔴' :
                   m.status === 'warning' ? '🟡' : '🟢';
      lines.push(`${icon} ${m.label}: ${m.formattedValue}`);
    });

    return lines.join('\n');
  }

  /**
   * 汇总优化建议
   */
  private aggregateSuggestions(diagnostics: DiagnosticResult[]): string[] {
    const allSuggestions: string[] = [];

    // 按严重程度排序后收集建议
    const sorted = this.sortDiagnosticsBySeverity(diagnostics);

    for (const diag of sorted) {
      if (diag.suggestions) {
        allSuggestions.push(...diag.suggestions);
      }
    }

    // 去重
    return [...new Set(allSuggestions)];
  }

  /**
   * 格式化建议摘要
   */
  private formatSuggestionsSummary(suggestions: string[]): string {
    const lines: string[] = ['**优化建议：**'];

    // 最多显示 5 条建议
    suggestions.slice(0, 5).forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });

    return lines.join('\n');
  }

  /**
   * 按严重程度排序诊断结果
   */
  private sortDiagnosticsBySeverity(diagnostics: DiagnosticResult[]): DiagnosticResult[] {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    return [...diagnostics].sort((a, b) => {
      const orderA = severityOrder[a.severity] ?? 3;
      const orderB = severityOrder[b.severity] ?? 3;
      if (orderA !== orderB) return orderA - orderB;
      // 同等严重程度，按置信度排序
      return b.confidence - a.confidence;
    });
  }

  /**
   * 生成兜底摘要
   */
  private generateFallbackSummary(context: SummaryContext): string {
    const { skillName, displayResults, executionTimeMs } = context;

    if (displayResults.length === 0) {
      return `${skillName}分析完成，未发现异常情况。（耗时 ${executionTimeMs}ms）`;
    }

    // 尝试从结果中提取一些数字
    let dataPoints = 0;
    for (const result of displayResults) {
      if (result.data.rows) {
        dataPoints += result.data.rows.length;
      }
    }

    if (dataPoints > 0) {
      return `${skillName}分析完成，共分析 ${dataPoints} 条数据记录。（耗时 ${executionTimeMs}ms）`;
    }

    return `${skillName}分析完成。（耗时 ${executionTimeMs}ms）`;
  }
}

// =============================================================================
// 单例导出
// =============================================================================

export const smartSummaryGenerator = new SmartSummaryGenerator();