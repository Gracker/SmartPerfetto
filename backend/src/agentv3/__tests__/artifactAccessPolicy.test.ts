// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * artifactAccessPolicy unit tests
 *
 * This policy is a hard tool boundary: `forbidRows` can block artifact row
 * evidence outright. Summary-first guidance belongs in Strategies, so the only
 * thing this module may act on is an explicit user row-access directive.
 * These tests pin both directions — the ban must fire when asked for, and it
 * must not fire for pagination/verbosity preferences or incidental "rows"
 * mentions.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveArtifactAccessPolicy } from '../artifactAccessPolicy';

describe('resolveArtifactAccessPolicy', () => {
  describe('default: rows stay available', () => {
    it.each([undefined, '', '   '])('leaves every constraint off for %p', query => {
      expect(resolveArtifactAccessPolicy(query)).toEqual({
        forbidRows: false,
        requireSummaryBeforeRows: false,
        forbidRowsWhenSummaryComplete: false,
      });
    });

    it.each([
      '分析滑动性能',
      '给我看几个代表帧的 rows',
      'show me the rows for the worst frames',
      '摘要里缺字段就读 rows',
      '不要只看 summary，要读 rows',
      "don't just read the summary, read the rows",
    ])('keeps rows fetchable for %p', query => {
      expect(resolveArtifactAccessPolicy(query).forbidRows).toBe(false);
    });
  });

  describe('pagination/verbosity preferences are not a row ban', () => {
    it.each([
      '不要分页',
      '不要机械分页，直接给结论',
      '不要逐帧分析',
      "don't paginate",
      '不需要读取所有 row',
    ])('does not forbid rows for %p', query => {
      const policy = resolveArtifactAccessPolicy(query);
      expect(policy.forbidRows).toBe(false);
      expect(policy.forbidRowsWhenSummaryComplete).toBe(false);
    });
  });

  describe('incidental row mentions are not a row ban', () => {
    it.each([
      '这些帧不要用 rows 之外的方式解释',
      '为什么有的 row 没有 rows 数据',
      '分析卡顿，别漏掉 rows 里的代表帧',
    ])('does not forbid rows for %p', query => {
      expect(resolveArtifactAccessPolicy(query).forbidRows).toBe(false);
    });
  });

  describe('explicit row prohibition is enforced', () => {
    it.each([
      '不要读 rows',
      '不要读取任何 artifact 的原始 rows',
      '不要读行数据',
      '别读取逐行数据',
      'do not read rows',
      "don't fetch any raw rows",
      'Do Not Read Rows',
    ])('forbids rows for %p', query => {
      expect(resolveArtifactAccessPolicy(query).forbidRows).toBe(true);
    });

    it('finds the directive in a later clause of a multi-clause query', () => {
      expect(resolveArtifactAccessPolicy('分析滑动性能。不要读 rows').forbidRows).toBe(true);
    });
  });

  describe('conditional prohibition stays conditional', () => {
    it.each([
      'aggregate.complete=true 时不要再读 rows',
      '聚合已经完整就不要读 rows',
    ])('scopes the ban to a complete summary for %p', query => {
      const policy = resolveArtifactAccessPolicy(query);
      expect(policy.forbidRows).toBe(false);
      expect(policy.forbidRowsWhenSummaryComplete).toBe(true);
      expect(policy.requireSummaryBeforeRows).toBe(true);
    });
  });

  describe('summary-first request does not remove row access', () => {
    it.each(['先看 summary 再决定', 'summary first, then decide'])(
      'requires summary before rows without forbidding them for %p',
      query => {
        const policy = resolveArtifactAccessPolicy(query);
        expect(policy.requireSummaryBeforeRows).toBe(true);
        expect(policy.forbidRows).toBe(false);
      },
    );
  });
});
