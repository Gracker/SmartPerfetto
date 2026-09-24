// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import { buildFocusAppEvidencePayload } from '../focusAppEvidence';
import {
  buildQuickFocusAppDirectAnswer,
  shouldUseQuickFocusAppDirectAnswer,
} from '../quickFocusAppDirectAnswer';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';

const selectionContext = {
  kind: 'area' as const,
  source: 'area_selection' as const,
  startNs: 506_731_662_000_000,
  endNs: 506_731_900_000_000,
};

function scopedFocusEvidence() {
  return buildFocusAppEvidencePayload({
    method: 'frame_timeline',
    primaryApp: 'com.example.wechatfriendforcustomscroller',
    timeRange: {
      startNs: selectionContext.startNs,
      endNs: selectionContext.endNs,
    },
    apps: [{
      packageName: 'com.example.wechatfriendforcustomscroller',
      totalDurationNs: 175_703_635,
      switchCount: 29,
    }],
  }, 'trace-1');
}

function traceWideFocusEvidence() {
  return buildFocusAppEvidencePayload({
    method: 'frame_timeline',
    primaryApp: 'com.example.wechatfriendforcustomscroller',
    apps: [{
      packageName: 'com.example.wechatfriendforcustomscroller',
      totalDurationNs: 1_700_000_000,
      switchCount: 347,
    }],
  }, 'trace-1');
}

describe('quick focus app direct answer', () => {
  it('renders selected-range legacy focus data without certifying uncaptured claims', () => {
    const evidence = scopedFocusEvidence();
    const beforeEvidence = structuredClone(evidence);
    const beforeSelection = structuredClone(selectionContext);
    const answer = buildQuickFocusAppDirectAnswer({
      query: '这个选区的焦点应用是什么？',
      evidence,
      selectionContext,
      outputLanguage: 'zh-CN',
    });

    expect(answer).toBeDefined();
    expect(answer?.conclusion).toContain('com.example.wechatfriendforcustomscroller');
    expect(answer?.conclusion).toContain('当前选区/范围内');
    expect(answer?.conclusionContract.claims?.[0]?.references.map(ref => ref.column)).toEqual(
      expect.arrayContaining([
        'package_name',
        'foreground_duration_ns',
        'foreground_count',
        'scope_start_ns',
        'scope_end_ns',
      ]),
    );
    expect(evidence.envelope?.meta).toMatchObject({traceId: 'trace-1', traceSide: 'current'});
    const claims = answer!.conclusionContract.claims!;
    expect(claims).toHaveLength(1);
    expect(claims[0].references.map(({column, value, evidenceRefId, rowIndex}) => ({column, value, evidenceRefId, rowIndex})))
      .toEqual(Object.entries({package_name: 'com.example.wechatfriendforcustomscroller', foreground_duration_ns: 175_703_635,
        foreground_count: 29, count_source: 'frame_count', detection_method: 'frame_timeline',
        scope_start_ns: 506_731_662_000_000, scope_end_ns: 506_731_900_000_000})
        .map(([column, value]) => ({column, value, evidenceRefId: evidence.envelope!.meta.evidenceRefId, rowIndex: 0})));
    const beforeAnswer = structuredClone(answer);

    const verified = runClaimVerification({
      conclusionContract: answer?.conclusionContract,
      dataEnvelopes: evidence.envelope ? [evidence.envelope] : [],
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      schemaVersion: 'claim_verifier@2',
      status: 'not_checked',
      passed: false,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
    expect(verified.claimVerificationResult.claimResults).toHaveLength(claims.length);
    verified.claimVerificationResult.claimResults.forEach((checked, index) => {
      expect(claims[index].semantics).toBeUndefined();
      expect(claims[index].references.length).toBeGreaterThan(0);
      expect(checked).toMatchObject({claimId: claims[index].id, status: 'not_checked',
        deterministicProof: {status: 'not_checked', reason: 'semantics_not_declared'}});
      expect(checked.referenceResults).toHaveLength(claims[index].references.length);
      checked.referenceResults!.forEach((reference, refIndex) => {
        expect(reference).toMatchObject({status: 'not_checked',
          evidenceRefId: claims[index].references[refIndex].evidenceRefId,
          sourceToolCallId: claims[index].references[refIndex].sourceToolCallId});
      });
      expect(checked.referenceCells).toEqual(checked.referenceResults);
    });
    expect(evidence).toEqual(beforeEvidence);
    expect(selectionContext).toEqual(beforeSelection);
    expect(answer).toEqual(beforeAnswer);
  });

  it('answers trace-wide current app identity from runtime focus evidence', () => {
    const evidence = traceWideFocusEvidence();
    const answer = buildQuickFocusAppDirectAnswer({
      query: '当前应用是谁？',
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(answer?.conclusion).toContain('com.example.wechatfriendforcustomscroller');
    expect(answer?.conclusion).toContain('当前 trace');
    expect(answer?.conclusionContract.claims?.[0]?.references.map(ref => ref.column)).toEqual(
      expect.arrayContaining([
        'package_name',
        'foreground_duration_ns',
        'foreground_count',
      ]),
    );
  });

  it('lists ranked candidates instead of naming a focus app when detection is ambiguous', () => {
    const evidence = buildFocusAppEvidencePayload({
      method: 'oom_adj',
      confidence: 'ambiguous',
      apps: [
        {packageName: 'com.example.a', totalDurationNs: 5_000_000_000, switchCount: 1},
        {packageName: 'com.example.b', totalDurationNs: 4_800_000_000, switchCount: 1},
      ],
    }, 'trace-1');
    expect(evidence.envelope?.data.rows?.map(row => (row as unknown[])[2])).toEqual([false, false]);

    const answer = buildQuickFocusAppDirectAnswer({query: '当前应用是谁？', evidence, outputLanguage: 'zh-CN'});

    expect(answer?.conclusion).toContain('焦点应用无法确定');
    expect(answer?.conclusion).toContain('com.example.a, com.example.b');
    expect(answer?.confidence).toBe(0.5);
    expect(answer?.conclusionContract.claims?.[0]?.references.map(ref => ref.rowIndex)).toEqual([0, 1]);
  });

  it('describes a CPU-activity inference as such', () => {
    const evidence = buildFocusAppEvidencePayload({
      method: 'sched_activity',
      confidence: 'medium',
      primaryApp: 'com.tencent.mm',
      apps: [{packageName: 'com.tencent.mm', totalDurationNs: 2_411_938_838, switchCount: 0}],
    }, 'trace-1');
    const answer = buildQuickFocusAppDirectAnswer({query: '当前应用是谁？', evidence, outputLanguage: 'zh-CN'});

    expect(answer?.conclusion).toContain('按 CPU 活动推断');
    expect(answer?.conclusion).not.toContain('前台时长');
  });

  it('keeps non-identity focus app questions on the model path', () => {
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '当前应用是谁？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '哪个应用在前台？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'foreground package?',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'what is the foreground package?',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '前台包名是什么？',
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '选中的应用是什么？',
      selectionContext,
    })).toBe(true);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '这个选区的焦点应用为什么掉帧？',
      selectionContext,
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '焦点应用有多少进程？',
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: '当前应用为什么慢？',
    })).toBe(false);
    expect(shouldUseQuickFocusAppDirectAnswer({
      query: 'foreground package jank?',
    })).toBe(false);
  });
});
