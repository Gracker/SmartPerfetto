// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 用户问题回答生成器 v1.0
 *
 * 基于分析结果生成直接回答用户问题的自然语言
 * 将结构化数据转换为用户可理解的答案
 */

import { DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS } from '../../config/thresholds';

// =============================================================================
// 类型定义
// =============================================================================

export interface AnswerContext {
  /** 用户原始问题 */
  originalQuestion: string;
  /** 匹配的 skill ID */
  skillId: string;
  /** skill 名称 */
  skillName: string;
  /** 分析是否成功 */
  success: boolean;
  /** 诊断结果 */
  diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    suggestions?: string[];
  }>;
  /** 展示结果 */
  sections: Record<string, any>;
  /** 执行耗时 */
  executionTimeMs: number;
}

export type QuestionType = 'why' | 'how' | 'what' | 'where' | 'analysis';

export interface GeneratedAnswer {
  /** 直接回答 */
  answer: string;
  /** 问题类型 */
  questionType: QuestionType;
  /** 置信度 */
  confidence: 'high' | 'medium' | 'low';
}

// =============================================================================
// 问题主体映射
// =============================================================================

interface ProblemSubject {
  pattern: RegExp;
  subject: string;
  relatedSkills: string[];
}

const PROBLEM_SUBJECTS: ProblemSubject[] = [
  {
    pattern: /滑动|scroll|fling|列表|list|recyclerview/i,
    subject: '滑动卡顿',
    relatedSkills: ['scrolling_analysis', 'scroll_session_analysis'],
  },
  {
    pattern: /启动|launch|start|冷启动|热启动|cold|warm/i,
    subject: '启动慢',
    relatedSkills: ['startup_analysis', 'app_startup'],
  },
  {
    pattern: /内存|memory|oom|泄漏|leak/i,
    subject: '内存问题',
    relatedSkills: ['memory_analysis'],
  },
  {
    pattern: /anr|无响应|卡死|freeze|hang/i,
    subject: 'ANR/无响应',
    relatedSkills: ['anr_analysis'],
  },
  {
    pattern: /cpu|占用|负载|load/i,
    subject: 'CPU 占用高',
    relatedSkills: ['cpu_analysis', 'cpu_slice_analysis'],
  },
  {
    pattern: /binder|ipc|跨进程/i,
    subject: 'Binder 调用问题',
    relatedSkills: ['binder_analysis', 'binder_in_range'],
  },
  {
    pattern: /帧|frame|fps|刷新率|渲染/i,
    subject: '帧率问题',
    relatedSkills: ['frame_analysis', 'jank_frame_detail'],
  },
  {
    pattern: /卡顿|jank|掉帧|丢帧|stutter/i,
    subject: '卡顿',
    relatedSkills: ['jank_analysis', 'scrolling_analysis'],
  },
];

// =============================================================================
// 用户问题回答生成器
// =============================================================================

export class AnswerGenerator {
  /**
   * 生成直接回答
   */
  generateAnswer(context: AnswerContext): GeneratedAnswer {
    const { originalQuestion, success, sections } = context;

    // 分析失败的情况
    if (!success) {
      return {
        answer: this.generateFailureAnswer(context),
        questionType: 'analysis',
        confidence: 'low',
      };
    }

    // 检查是否有实际数据
    if (this.isEmptyResult(sections)) {
      return {
        answer: this.generateNoDataAnswer(context),
        questionType: 'analysis',
        confidence: 'low',
      };
    }

    // 识别问题类型
    const questionType = this.classifyQuestion(originalQuestion);

    // 根据问题类型生成回答
    let answer: string;
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    switch (questionType) {
      case 'why':
        answer = this.generateWhyAnswer(context);
        confidence = context.diagnostics.length > 0 ? 'high' : 'low';
        break;

      case 'how':
        answer = this.generateHowAnswer(context);
        confidence = context.diagnostics.some(d => d.suggestions?.length) ? 'high' : 'medium';
        break;

      case 'what':
        answer = this.generateWhatAnswer(context);
        confidence = 'medium';
        break;

      case 'where':
        answer = this.generateWhereAnswer(context);
        confidence = 'medium';
        break;

      default:
        answer = this.generateAnalysisAnswer(context);
        confidence = 'medium';
    }

    return { answer, questionType, confidence };
  }

  /**
   * 检查结果是否为空（没有实际数据）
   */
  private isEmptyResult(sections: Record<string, any>): boolean {
    for (const [key, section] of Object.entries(sections)) {
      // 跳过环境信息等元数据
      if (key === 'environment' || key === 'detect_refresh_rate') {
        continue;
      }

      if (section.data && Array.isArray(section.data) && section.data.length > 0) {
        // 检查数据是否都是空数组或者空文本
        const hasRealData = section.data.some((row: any) => {
          if (typeof row === 'object') {
            // 检查对象是否只包含空值
            const values = Object.values(row);
            return values.some(v =>
              v !== null &&
              v !== undefined &&
              v !== '' &&
              !(Array.isArray(v) && v.length === 0) &&
              v !== '[]'
            );
          }
          return row !== null && row !== undefined && row !== '' && row !== '[]';
        });
        if (hasRealData) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 生成无数据时的回答
   */
  private generateNoDataAnswer(context: AnswerContext): string {
    const subject = this.extractProblemSubject(context.originalQuestion);
    const skillName = context.skillName;

    return `**${skillName}分析结果：未检测到相关数据**

在当前 Trace 中未能检测到${subject}相关的事件或活动记录。

**可能的原因：**
1. Trace 采集期间没有进行相关操作（如滑动、点击等）
2. 应用在采集时未处于活跃状态
3. Trace 采集时间过短，未捕获到相关事件

**建议：**
- 确保在 Trace 采集期间进行目标操作
- 适当延长 Trace 采集时间（建议 3-10 秒）
- 确认要分析的应用处于前台运行状态`;
  }

  /**
   * 分类问题类型
   */
  private classifyQuestion(question: string): QuestionType {
    const lowerQ = question.toLowerCase();

    // "为什么" 类问题
    if (/为什么|why|原因|怎么回事|为啥|咋回事/.test(lowerQ)) {
      return 'why';
    }

    // "怎么办" 类问题
    if (/怎么|如何|how|优化|改进|解决|修复|提升|降低/.test(lowerQ)) {
      return 'how';
    }

    // "是什么" 类问题
    if (/是什么|什么是|what|有哪些|哪些|都有/.test(lowerQ)) {
      return 'what';
    }

    // "在哪里" 类问题
    if (/在哪|哪里|where|位置|定位/.test(lowerQ)) {
      return 'where';
    }

    // 默认为分析类
    return 'analysis';
  }

  /**
   * 生成 "为什么" 类问题的回答
   */
  private generateWhyAnswer(context: AnswerContext): string {
    const { originalQuestion, diagnostics, sections } = context;

    // 没有诊断结果
    if (diagnostics.length === 0) {
      return this.generateNoIssueAnswer(context);
    }

    // 提取问题主体
    const subject = this.extractProblemSubject(originalQuestion);

    // 按严重程度排序
    const sorted = this.sortDiagnostics(diagnostics);
    const primary = sorted[0];
    const secondary = sorted.slice(1, 3);

    const lines: string[] = [];

    // 主要原因
    lines.push(`**${subject}的主要原因是：${primary.message}**`);
    lines.push('');

    // 次要原因
    if (secondary.length > 0) {
      lines.push('此外还发现：');
      secondary.forEach(d => {
        lines.push(`- ${d.message}`);
      });
      lines.push('');
    }

    // 数据证据
    const evidence = this.extractEvidence(sections);
    if (evidence.length > 0) {
      lines.push('**数据支撑：**');
      evidence.forEach(e => {
        lines.push(`- ${e}`);
      });
      lines.push('');
    }

    // 首要建议
    if (primary.suggestions && primary.suggestions.length > 0) {
      lines.push(`**建议：** ${primary.suggestions[0]}`);
    }

    return lines.join('\n');
  }

  /**
   * 生成 "怎么办" 类问题的回答
   */
  private generateHowAnswer(context: AnswerContext): string {
    const { diagnostics, originalQuestion } = context;

    // 收集所有建议
    const allSuggestions: string[] = [];
    const sorted = this.sortDiagnostics(diagnostics);

    for (const diag of sorted) {
      if (diag.suggestions) {
        allSuggestions.push(...diag.suggestions);
      }
    }

    // 去重
    const uniqueSuggestions = [...new Set(allSuggestions)];

    if (uniqueSuggestions.length === 0) {
      return this.generateNoSuggestionAnswer(context);
    }

    const subject = this.extractProblemSubject(originalQuestion);
    const lines: string[] = [];

    lines.push(`**${subject}的优化方案：**`);
    lines.push('');

    uniqueSuggestions.slice(0, 5).forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });

    // 如果有诊断结论，添加背景说明
    if (diagnostics.length > 0) {
      lines.push('');
      lines.push('---');
      lines.push(`*基于诊断：${diagnostics.map(d => d.message).join('、')}*`);
    }

    return lines.join('\n');
  }

  /**
   * 生成 "是什么" 类问题的回答
   */
  private generateWhatAnswer(context: AnswerContext): string {
    const { diagnostics, sections, skillName } = context;

    const lines: string[] = [];

    lines.push(`**${skillName}发现：**`);
    lines.push('');

    if (diagnostics.length > 0) {
      diagnostics.forEach(d => {
        const icon = d.severity === 'critical' ? '🔴' :
                     d.severity === 'warning' ? '🟡' : '🟢';
        lines.push(`${icon} ${d.message}`);
      });
    } else {
      lines.push('未发现明显异常。');
    }

    // 添加关键指标
    const metrics = this.extractKeyMetrics(sections);
    if (metrics.length > 0) {
      lines.push('');
      lines.push('**关键指标：**');
      metrics.forEach(m => {
        lines.push(`- ${m}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * 生成 "在哪里" 类问题的回答
   */
  private generateWhereAnswer(context: AnswerContext): string {
    const { sections, diagnostics } = context;

    const lines: string[] = [];

    // 尝试找到具体位置信息
    const locations = this.extractLocations(sections);

    if (locations.length > 0) {
      lines.push('**问题定位：**');
      lines.push('');
      locations.forEach((loc, i) => {
        lines.push(`${i + 1}. ${loc}`);
      });
    } else if (diagnostics.length > 0) {
      lines.push('**问题区域：**');
      lines.push('');
      diagnostics.forEach(d => {
        lines.push(`- ${d.message}`);
      });
    } else {
      lines.push('未能定位到具体问题位置。');
    }

    return lines.join('\n');
  }

  /**
   * 生成分析类问题的回答
   */
  private generateAnalysisAnswer(context: AnswerContext): string {
    const { skillName, diagnostics, sections, executionTimeMs } = context;

    const lines: string[] = [];

    lines.push(`**${skillName}分析完成**`);
    lines.push('');

    // 诊断结论
    if (diagnostics.length > 0) {
      const critical = diagnostics.filter(d => d.severity === 'critical');
      const warning = diagnostics.filter(d => d.severity === 'warning');

      if (critical.length > 0) {
        lines.push(`🔴 发现 ${critical.length} 个严重问题`);
      }
      if (warning.length > 0) {
        lines.push(`🟡 发现 ${warning.length} 个潜在问题`);
      }
      if (critical.length === 0 && warning.length === 0) {
        lines.push('🟢 未发现严重问题');
      }

      lines.push('');

      // 列出问题
      diagnostics.slice(0, 5).forEach(d => {
        lines.push(`- ${d.message}`);
      });
    } else {
      lines.push('🟢 分析完成，未发现异常');
    }

    // 关键指标
    const metrics = this.extractKeyMetrics(sections);
    if (metrics.length > 0) {
      lines.push('');
      lines.push('**关键指标：**');
      metrics.slice(0, 4).forEach(m => {
        lines.push(`- ${m}`);
      });
    }

    lines.push('');
    lines.push(`*分析耗时 ${executionTimeMs}ms*`);

    return lines.join('\n');
  }

  /**
   * 生成失败回答
   */
  private generateFailureAnswer(context: AnswerContext): string {
    return `抱歉，${context.skillName}分析过程中遇到问题，无法完成分析。` +
           `请检查 trace 数据是否完整，或尝试其他分析方式。`;
  }

  /**
   * 生成无问题回答
   */
  private generateNoIssueAnswer(context: AnswerContext): string {
    const subject = this.extractProblemSubject(context.originalQuestion);
    const metrics = this.extractKeyMetrics(context.sections);

    let answer = `分析了您的 trace 数据，**未发现明显的${subject}问题**。`;

    if (metrics.length > 0) {
      answer += '\n\n当前性能指标：\n';
      metrics.slice(0, 3).forEach(m => {
        answer += `- ${m}\n`;
      });
    }

    return answer;
  }

  /**
   * 生成无建议回答
   */
  private generateNoSuggestionAnswer(context: AnswerContext): string {
    return `基于当前分析结果，性能表现正常，暂无具体优化建议。` +
           `\n\n如需深入分析，可以尝试：` +
           `\n1. 提供更长时间的 trace 数据` +
           `\n2. 在问题复现时采集 trace` +
           `\n3. 指定具体的应用包名进行分析`;
  }

  /**
   * 提取问题主体
   */
  private extractProblemSubject(question: string): string {
    for (const { pattern, subject } of PROBLEM_SUBJECTS) {
      if (pattern.test(question)) {
        return subject;
      }
    }
    return '性能问题';
  }

  /**
   * 排序诊断结果
   */
  private sortDiagnostics(diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    suggestions?: string[];
  }>): typeof diagnostics {
    const severityOrder: Record<string, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };

    return [...diagnostics].sort((a, b) => {
      const orderA = severityOrder[a.severity] ?? 3;
      const orderB = severityOrder[b.severity] ?? 3;
      return orderA - orderB;
    });
  }

  /**
   * 从 sections 中提取证据
   */
  private extractEvidence(sections: Record<string, any>): string[] {
    const evidence: string[] = [];

    for (const section of Object.values(sections)) {
      if (!section.data || !Array.isArray(section.data) || section.data.length === 0) {
        continue;
      }

      const row = section.data[0];

      // 提取关键证据
      if (row.jank_rate != null && row.jank_rate > 5) {
        evidence.push(`掉帧率 ${row.jank_rate}%`);
      }
      if (row.max_frame_ms != null && row.max_frame_ms > DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS.maxWarningMs) {
        evidence.push(`最大帧耗时 ${Number(row.max_frame_ms).toFixed(1)}ms（超过 2 帧）`);
      }
      if (row.estimated_fps != null && row.estimated_fps < 55) {
        evidence.push(`帧率仅 ${Math.round(row.estimated_fps)} fps`);
      }
      if (row.max_delay_ms != null && row.max_delay_ms > 10) {
        evidence.push(`Binder 最大延迟 ${Number(row.max_delay_ms).toFixed(1)}ms`);
      }
      if (row.max_runnable_ms != null && row.max_runnable_ms > 5) {
        evidence.push(`调度延迟最高 ${Number(row.max_runnable_ms).toFixed(1)}ms`);
      }
      if (row.total_cpu_ms != null && row.total_cpu_ms > 100) {
        evidence.push(`CPU 累计耗时 ${Number(row.total_cpu_ms).toFixed(1)}ms`);
      }
    }

    return evidence.slice(0, 5);
  }

  /**
   * 提取关键指标
   */
  private extractKeyMetrics(sections: Record<string, any>): string[] {
    const metrics: string[] = [];

    for (const section of Object.values(sections)) {
      if (!section.data || !Array.isArray(section.data) || section.data.length === 0) {
        continue;
      }

      const row = section.data[0];

      // 帧相关
      if (row.total_frames != null) {
        metrics.push(`总帧数: ${row.total_frames}`);
      }
      if (row.janky_frames != null) {
        metrics.push(`掉帧数: ${row.janky_frames}`);
      }
      if (row.jank_rate != null) {
        metrics.push(`掉帧率: ${row.jank_rate}%`);
      }
      if (row.estimated_fps != null) {
        metrics.push(`帧率: ${Math.round(row.estimated_fps)} fps`);
      }
      if (row.avg_frame_ms != null) {
        metrics.push(`平均帧耗时: ${Number(row.avg_frame_ms).toFixed(2)}ms`);
      }

      // 启动相关
      if (row.startup_time_ms != null) {
        metrics.push(`启动耗时: ${Number(row.startup_time_ms).toFixed(0)}ms`);
      }
    }

    return metrics.slice(0, 6);
  }

  /**
   * 提取位置信息
   */
  private extractLocations(sections: Record<string, any>): string[] {
    const locations: string[] = [];

    for (const section of Object.values(sections)) {
      if (!section.data || !Array.isArray(section.data)) {
        continue;
      }

      for (const row of section.data.slice(0, 5)) {
        // 函数/方法位置
        if (row.function_name || row.method_name) {
          const name = row.function_name || row.method_name;
          const time = row.dur_ms || row.time_ms;
          locations.push(`${name}${time != null ? ` (耗时 ${Number(time).toFixed(1)}ms)` : ''}`);
        }

        // 线程位置
        if (row.thread_name && row.total_cpu_ms != null) {
          locations.push(`线程 ${row.thread_name}: CPU ${Number(row.total_cpu_ms).toFixed(1)}ms`);
        }

        // 帧位置
        if (row.frame_number != null && row.ts_str) {
          locations.push(`第 ${row.frame_number} 帧 @ ${row.ts_str}`);
        }
      }
    }

    return locations.slice(0, 5);
  }
}

// =============================================================================
// 单例导出
// =============================================================================

export const answerGenerator = new AnswerGenerator();