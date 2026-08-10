// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { isConclusionLikePlanPhase } from '../planPhaseSemantics';

describe('plan phase semantics', () => {
  it.each([
    ['结构化结论', '输出 Delta 表格与分层建议'],
    ['结构化报告', '汇总已验证证据'],
    ['Structured Conclusion', 'Present verified findings'],
    ['Structured Report', 'Present verified findings'],
  ])('recognizes conclusion-only phase name %s', (name, goal) => {
    expect(isConclusionLikePlanPhase({ id: 'p-final', name, goal })).toBe(true);
  });

  it('does not classify an evidence drill as a conclusion phase', () => {
    expect(isConclusionLikePlanPhase({
      id: 'p-detail',
      name: '启动阶段深钻',
      goal: '运行 startup_detail 采集双端证据',
    })).toBe(false);
  });

  it.each([
    ['根因综合与报告输出', '综合已验证证据并形成可执行建议'],
    ['根因综合', '输出启动分析报告'],
    ['根因综合', '输出完整启动性能分析报告与优化建议'],
    ['根因综合', '输出启动分析报告、关键调用关系与分层建议'],
    ['根因综合', '输出启动分析报告、SQL查询结果与分层建议'],
    ['根因综合', '输出启动分析报告、运行限制与置信度'],
  ])('recognizes Chinese report-delivery phase %s', (name, goal) => {
    expect(isConclusionLikePlanPhase({id: 'p-final', name, goal})).toBe(true);
  });

  it.each([
    ['报告输出格式校验', '校验模板字段和 Markdown 格式'],
    ['启动证据采集', '输出分析报告所需的原始数据'],
    ['数据表生成', '输出供后续分析报告使用的数据表'],
    ['报告证据采集', '运行 startup_detail 获取关键证据'],
    ['分析报告数据准备', '整理 SQL 查询结果'],
    ['输出分析数据表', '保存阶段性聚合指标'],
    ['报告输出及证据补采', '先交付报告，再补采缺失证据'],
    ['报告输出及证据采集', '先交付报告，再继续收集证据'],
    ['根因综合', '输出启动分析报告及补采缺失证据'],
    ['阶段数据导出', '输出中间数据。启动分析报告'],
    ['阶段数据导出', '输出阶段结果！稍后编写分析报告'],
    ['根因综合', '输出启动分析报告、证据采集并给出优化建议'],
    ['报告输出及证据采集', '形成优化建议'],
    ['根因综合', '输出启动分析报告、证据补采并给出最终结论'],
  ])('does not treat report-preparation phase %s as a conclusion phase', (name, goal) => {
    expect(isConclusionLikePlanPhase({id: 'p-data', name, goal})).toBe(false);
  });

  it('does not match a Chinese report-delivery phrase across phase fields', () => {
    expect(isConclusionLikePlanPhase({
      id: 'p-data',
      name: '输出启动',
      goal: '分析报告数据准备',
    })).toBe(false);
  });
});
