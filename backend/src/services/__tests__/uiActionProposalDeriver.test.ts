// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { deriveUiActionProposals } from '../uiActionProposalDeriver';
import type { DataEnvelope } from '../../types/dataContract';

function tableEnvelope(): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis:jank_frames',
      skillId: 'scrolling_analysis',
      stepId: 'jank_frames',
      evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:abc',
      artifactId: 'artifact-jank-frames',
      sourceToolCallId: 'tool-1',
      traceId: 'trace-current',
      timestamp: 1000,
    },
    display: {
      layer: 'list',
      format: 'table',
      title: '掉帧帧列表',
      columns: [
        {
          name: 'ts_str',
          type: 'timestamp',
          unit: 'ns',
          clickAction: 'navigate_range',
          durationColumn: 'dur_str',
        },
        { name: 'dur_str', type: 'duration', unit: 'ns' },
        { name: 'frame_id', type: 'string' },
      ],
    },
    data: {
      columns: ['ts_str', 'dur_str', 'frame_id'],
      rows: [['1000000000', '16666667', 'frame-1']],
    },
  };
}

describe('deriveUiActionProposals', () => {
  it('derives range, open-table, and pin proposals from clickable current-trace evidence', () => {
    const proposals = deriveUiActionProposals({
      dataEnvelopes: [tableEnvelope()],
      currentTraceId: 'trace-current',
      outputLanguage: 'zh-CN',
    });

    expect(proposals.map(proposal => proposal.kind)).toEqual([
      'navigate_range',
      'open_evidence_table',
      'pin_evidence',
    ]);
    expect(proposals[0]).toEqual(expect.objectContaining({
      kind: 'navigate_range',
      source: expect.objectContaining({
        evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:abc',
        artifactId: 'artifact-jank-frames',
        skillId: 'scrolling_analysis',
        sourceToolCallId: 'tool-1',
      }),
      payload: {
        startNs: '1000000000',
        endNs: '1016666667',
        traceId: 'trace-current',
      },
      requiresConfirmation: true,
    }));
    expect(proposals[1]).toEqual(expect.objectContaining({
      kind: 'open_evidence_table',
      payload: {
        artifactId: 'artifact-jank-frames',
        evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:abc',
      },
    }));
    expect(proposals[2]).toEqual(expect.objectContaining({
      kind: 'pin_evidence',
      title: '收藏证据 掉帧帧列表',
      reason: '把这份证据或结果快照收藏到当前会话，可通过 /pins 查看；不会固定时间线泳道，也不会自动加入后续 AI 上下文。',
      payload: {
        evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:abc',
      },
    }));
  });

  it('falls back to point navigation when a timestamp column has no positive duration', () => {
    const env = tableEnvelope();
    env.data = {
      columns: ['end_ts', 'dur_str'],
      rows: [['2000000000', '0']],
    };
    env.display = {
      ...env.display,
      columns: [
        { name: 'end_ts', type: 'timestamp', unit: 'ns', clickAction: 'navigate_timeline' },
        { name: 'dur_str', type: 'duration', unit: 'ns' },
      ],
    };

    const proposals = deriveUiActionProposals({
      dataEnvelopes: [env],
      currentTraceId: 'trace-current',
    });

    expect(proposals[0]).toEqual(expect.objectContaining({
      kind: 'navigate_timeline',
      payload: { ts: '2000000000', traceId: 'trace-current' },
    }));
  });

  it('skips navigation proposals for reference-trace rows', () => {
    const env = tableEnvelope();
    env.meta.traceId = 'trace-reference';
    env.meta.traceSide = 'reference';

    const proposals = deriveUiActionProposals({
      dataEnvelopes: [env],
      currentTraceId: 'trace-current',
    });

    expect(proposals.some(proposal => proposal.kind === 'navigate_range')).toBe(false);
    expect(proposals.some(proposal => proposal.kind === 'navigate_timeline')).toBe(false);
    expect(proposals.some(proposal => proposal.kind === 'open_evidence_table')).toBe(true);
  });

  it('localizes derived runtime labels for English output', () => {
    const proposals = deriveUiActionProposals({
      dataEnvelopes: [tableEnvelope()],
      currentTraceId: 'trace-current',
      outputLanguage: 'en',
    });

    expect(proposals.map(proposal => proposal.title)).toEqual([
      'Inspect range 掉帧帧列表',
      'Open table 掉帧帧列表',
      'Save evidence 掉帧帧列表',
    ]);
    expect(proposals[0].reason).toBe(
      'This time range comes from the evidence table timestamp and duration columns.',
    );
    expect(proposals[2].reason).toBe(
      'Save this evidence or result snapshot in the current conversation and view it with /pins; this does not pin a timeline track or automatically add it to later AI context.',
    );
  });
});
