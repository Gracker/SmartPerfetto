// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {shouldCloseConversationStream} from '../agentConversationRoutes';

describe('conversation stream lifecycle', () => {
  it.each(['run_completed', 'run_failed'] as const)('closes on the terminal event %s', (eventType) => {
    expect(shouldCloseConversationStream({eventType})).toBe(true);
  });

  it.each(['run_started', 'runtime_update', 'provisional_answer'] as const)(
    'stays open on the non-terminal event %s', (eventType) => {
      expect(shouldCloseConversationStream({eventType})).toBe(false);
    });

  it('closes a replay once the run has settled, and only then', () => {
    expect(shouldCloseConversationStream({replay: true, runSettled: true})).toBe(true);
    expect(shouldCloseConversationStream({replay: true, runSettled: false})).toBe(false);
    expect(shouldCloseConversationStream({replay: true})).toBe(false);
  });
});
