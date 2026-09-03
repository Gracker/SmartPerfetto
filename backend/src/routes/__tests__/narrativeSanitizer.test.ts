// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { sanitizeNarrativeForClient } from '../narrativeSanitizer';

describe('internal identifier stripping', () => {
  // Measured on 13 real provider conclusions: 103 `art-N` artifact ids and 7
  // `execute_sql:N` tool-call ids reached the text users read. The sanitizer
  // already strips `ev_*` evidence ids; artifact and tool-call ids are the same
  // class of internal plumbing and were simply not covered.
  it('removes artifact ids from user-facing narrative', () => {
    const out = sanitizeNarrativeForClient('art-11 聚合：49/49 帧全覆盖（art-26）。');
    expect(out).not.toMatch(/\bart-\d+\b/);
    expect(out).toContain('49/49 帧全覆盖');
  });

  it('removes tool-call ids from user-facing narrative', () => {
    const out = sanitizeNarrativeForClient('全量验证（execute_sql:6:07787eaf）：49/49 帧命中。');
    expect(out).not.toMatch(/execute_sql:\d+/);
    expect(out).toContain('49/49 帧命中');
  });

  it('still strips evidence ids and keeps ordinary text', () => {
    const out = sanitizeNarrativeForClient('主线程忙碌 ev_0123456789ab 导致迟到。');
    expect(out).not.toMatch(/ev_[0-9a-f]{12}/);
    expect(out).toContain('主线程忙碌');
    expect(out).toContain('导致迟到');
  });

  it('leaves no dangling separator where an id was removed inside parentheses', () => {
    const out = sanitizeNarrativeForClient('全量模式验证（定向 SQL，execute_sql:6:07787eaf）：49/49 命中。');
    expect(out).not.toMatch(/[，,、]\s*[）)]/);
    expect(out).toContain('定向 SQL');
    expect(out).toContain('49/49 命中');
  });

  it('does not damage words that merely contain the token', () => {
    const out = sanitizeNarrativeForClient('smart-artifact 与 chart-1 不是内部 ID。');
    expect(out).toContain('smart-artifact');
    expect(out).toContain('chart-1');
  });
});

describe('narrativeSanitizer', () => {
  test('removes internal ev_ ids while keeping evidence text', () => {
    const input = `## 证据链（对应上述结论）
- C1: 规则裁决=混合型（APP 触发 + SF 放大） （ev_5f64858c9de6|ev_0a31195bb6f3）
- C2: 责任分布样本 SF=25 (100.0%)，APP=0 (0.0%) （ev_eb7fcff0ba20）
- 证据索引（自动补全）: (ev_111111111111) [frame_agent] analyze_scrolling`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('## 证据链（对应上述结论）');
    expect(output).toContain('- 证据1（对应结论1）：规则裁决=混合型（APP 触发 + SF 放大）');
    expect(output).toContain('- 证据2（对应结论2）：责任分布样本 SF=25 (100.0%)，APP=0 (0.0%)');
    expect(output).not.toContain('ev_5f64858c9de6');
    expect(output).not.toContain('ev_0a31195bb6f3');
    expect(output).not.toContain('证据索引（自动补全）');
  });

  test('keeps plain narrative unchanged when no internal ids exist', () => {
    const input = `## 结论（按可能性排序）
1. 这是混合型掉帧。

## 下一步（最高信息增益）
- 扩大样本量验证。`;

    expect(sanitizeNarrativeForClient(input)).toBe(input);
  });

  test('removes empty evidence field and connector-only placeholders after id stripping', () => {
    const input = `**evidence_chain:**
- {"conclusion":"C1","evidence":"ev_111111111111","data":"逐帧根因统计显示主线程耗时操作占65%（41/63帧）"}
- 区间1掉帧数数据不一致（ev_aaaaaaaaaaaa vs ev_bbbbbbbbbbbb）`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('{"conclusion":"C1","data":"逐帧根因统计显示主线程耗时操作占65%（41/63帧）"}');
    expect(output).not.toContain('"evidence":""');
    expect(output).not.toContain('（ vs ）');
    expect(output).not.toContain('ev_111111111111');
    expect(output).not.toContain('ev_aaaaaaaaaaaa');
    expect(output).not.toContain('ev_bbbbbbbbbbbb');
  });

  test('humanizes jargon-heavy mechanism terms for client narrative', () => {
    const input = `## 结论（按可能性排序）
- 触发因子: 主线程耗时操作（65%）
- 供给约束: 阻塞等待（57.1%）
- 放大路径: SF消费端背压（100%）`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('直接原因');
    expect(output).toContain('资源问题');
    expect(output).toContain('放大因素');
    expect(output).not.toContain('触发因子');
    expect(output).not.toContain('供给约束');
    expect(output).not.toContain('放大路径');
    expect(output).toContain('阻塞等待（线程等待锁/IO/Binder）');
    expect(output).toContain('显示系统处理不过来（SF消费端背压）');
  });

  test('is idempotent for already-humanized jargon phrases', () => {
    const input = '放大因素: 显示系统处理不过来（SF消费端背压）';

    const once = sanitizeNarrativeForClient(input);
    const twice = sanitizeNarrativeForClient(once);

    expect(twice).toBe(once);
  });

  test('humanizes K/C labels and enforces parent-child hierarchy in cluster section', () => {
    const input = `## 掉帧聚类（先看大头）
- 聚类帧聚合（全量帧，覆盖 6 帧）
- K1（4帧）: 1435500 / 1435508 / 1435517 / 1435526
- K2（2帧）: 1435601 / 1435609
- K1: 主线程耗时操作/频率不足/显示系统处理不过来（SF消费端背压）

## 证据链（对应上述结论）
- C1: 逐帧统计显示主线程耗时占比 65%
- C2: 频率拉升存在延迟`;

    const output = sanitizeNarrativeForClient(input);

    expect(output).toContain('- 聚类帧分组（全量帧，覆盖 6 帧）');
    expect(output).toContain('  - 第1类（4帧）: 1435500 / 1435508 / 1435517 / 1435526');
    expect(output).toContain('  - 第2类（2帧）: 1435601 / 1435609');
    expect(output).toContain('  - 第1类：主线程耗时操作/频率不足（CPU频率偏低）/显示系统处理不过来（SF消费端背压）');
    expect(output).toContain('- 证据1（对应结论1）：逐帧统计显示主线程耗时占比 65%');
    expect(output).toContain('- 证据2（对应结论2）：频率拉升存在延迟');
    expect(output).not.toContain('K1');
    expect(output).not.toContain('K2');
    expect(output).not.toContain('- C1:');
  });
});