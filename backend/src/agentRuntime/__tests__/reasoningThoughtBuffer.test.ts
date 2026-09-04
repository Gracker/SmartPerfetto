// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { ReasoningThoughtBuffer } from '../reasoningThoughtBuffer';

describe('ReasoningThoughtBuffer', () => {
  it('joins streamed fragments into one line', () => {
    const buffer = new ReasoningThoughtBuffer();
    for (const fragment of ['先看', '全量掉帧类型分布，', '再决定下钻哪一帧。']) {
      buffer.append(fragment);
    }
    expect(buffer.flush()).toBe('先看全量掉帧类型分布，再决定下钻哪一帧。');
  });

  it('says nothing for a fragment too short to be a thought', () => {
    const buffer = new ReasoningThoughtBuffer();
    buffer.append('好的');
    expect(buffer.flush()).toBe('');
  });

  it('clears even when it emits nothing', () => {
    const buffer = new ReasoningThoughtBuffer();
    buffer.append('好的');
    buffer.flush();
    expect(buffer.hasPending()).toBe(false);
  });

  it('flattens markdown so the process view stays one line per step', () => {
    const buffer = new ReasoningThoughtBuffer();
    buffer.append('## 计划\n- 读取 art-8\n- 再看 art-11 的 reason_code 分布');
    expect(buffer.flush()).toBe('计划 读取 art-8 再看 art-11 的 reason_code 分布');
  });

  it('drops fenced code rather than pasting it into the timeline', () => {
    const buffer = new ReasoningThoughtBuffer();
    buffer.append('先验证一下这个查询是否可行：\n```sql\nSELECT * FROM slice\n```');
    const text = buffer.flush();
    expect(text).toContain('先验证一下这个查询是否可行');
    expect(text).not.toContain('SELECT');
  });

  it('truncates a long stretch instead of flooding the view', () => {
    const buffer = new ReasoningThoughtBuffer();
    buffer.append('根因分析。'.repeat(200));
    const text = buffer.flush();
    expect(text.length).toBeLessThanOrEqual(220);
    expect(text.endsWith('…')).toBe(true);
  });

  it('stops accumulating a runaway turn', () => {
    const buffer = new ReasoningThoughtBuffer();
    for (let i = 0; i < 5000; i += 1) buffer.append('x'.repeat(100));
    expect(buffer.flush().length).toBeLessThanOrEqual(220);
  });

  it('reports whether anything is waiting to be shown', () => {
    const buffer = new ReasoningThoughtBuffer();
    expect(buffer.hasPending()).toBe(false);
    buffer.append('   ');
    expect(buffer.hasPending()).toBe(false);
    buffer.append('主线程被合成负载占满');
    expect(buffer.hasPending()).toBe(true);
  });
});
