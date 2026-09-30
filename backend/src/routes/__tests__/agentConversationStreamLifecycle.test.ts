// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {shouldCloseConversationStream} from '../agentConversationRoutes';

describe('conversation stream source enrichment lifecycle', () => {
  it('keeps the stream open after a primary completion with pending enrichment', () => {
    expect(shouldCloseConversationStream({
      eventType: 'run_completed',
      enrichmentPending: true,
    })).toBe(false);
    expect(shouldCloseConversationStream({
      eventType: 'run_completed',
      enrichmentPending: false,
    })).toBe(true);
  });

  it.each([
    'source_enrichment_completed',
    'source_enrichment_failed',
    'source_enrichment_cancelled',
    'run_failed',
  ] as const)('closes on terminal event %s', (eventType) => {
    expect(shouldCloseConversationStream({eventType})).toBe(true);
  });

  it('uses the enrichment state for replay closure', () => {
    expect(shouldCloseConversationStream({
      replay: true,
      primarySettled: true,
      enrichmentStatus: 'running',
    })).toBe(false);
    expect(shouldCloseConversationStream({
      replay: true,
      primarySettled: true,
      enrichmentStatus: 'completed',
    })).toBe(true);
    expect(shouldCloseConversationStream({
      replay: true,
      primarySettled: true,
    })).toBe(true);
  });
});
