// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill 执行事件收集器 v1.0
 *
 * 收集 skill 执行过程中的事件，用于：
 * 1. 前端进度展示
 * 2. 调试和监控
 * 3. 性能分析
 */

import { SkillEvent, SkillEventType } from './types';

// =============================================================================
// 类型定义
// =============================================================================

export interface EventSummary {
  /** 事件总数 */
  totalEvents: number;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 总耗时(ms) */
  totalDurationMs: number;
  /** 各类型事件计数 */
  eventCounts: Record<SkillEventType, number>;
  /** 已完成步骤数 */
  completedSteps: number;
  /** 失败步骤数 */
  failedSteps: number;
  /** 是否有 AI 调用 */
  hasAICall: boolean;
  /** AI 调用次数 */
  aiCallCount: number;
}

// =============================================================================
// 事件收集器
// =============================================================================

export class SkillEventCollector {
  private events: SkillEvent[] = [];

  /**
   * 添加事件
   */
  addEvent(event: SkillEvent): void {
    this.events.push(event);
  }

  /**
   * 获取所有事件
   */
  getEvents(): SkillEvent[] {
    return [...this.events];
  }

  /**
   * 获取事件摘要
   */
  getSummary(): EventSummary {
    const eventCounts: Record<SkillEventType, number> = {
      skill_started: 0,
      step_started: 0,
      step_completed: 0,
      display_result: 0,
      diagnostic_found: 0,
      ai_thinking: 0,
      ai_response: 0,
      skill_completed: 0,
      skill_error: 0,
    };

    let completedSteps = 0;
    let failedSteps = 0;
    let aiCallCount = 0;

    for (const event of this.events) {
      eventCounts[event.type]++;

      if (event.type === 'step_completed') {
        if (event.data?.success) {
          completedSteps++;
        } else {
          failedSteps++;
        }
      }

      if (event.type === 'ai_thinking') {
        aiCallCount++;
      }
    }

    const startTime = this.events.length > 0 ? this.events[0].timestamp : Date.now();
    const endTime = this.events.length > 0 ? this.events[this.events.length - 1].timestamp : Date.now();

    return {
      totalEvents: this.events.length,
      startTime,
      endTime,
      totalDurationMs: endTime - startTime,
      eventCounts,
      completedSteps,
      failedSteps,
      hasAICall: aiCallCount > 0,
      aiCallCount,
    };
  }
}

// =============================================================================
// 单例导出
// =============================================================================

export function createEventCollector(): SkillEventCollector {
  return new SkillEventCollector();
}