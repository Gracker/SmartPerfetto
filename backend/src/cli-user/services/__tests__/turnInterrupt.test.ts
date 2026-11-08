// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {ForwardingInterruptSource, TurnInterruptController} from '../turnInterrupt';

function controller(options: {graceMs?: number} = {}) {
  const source = new ForwardingInterruptSource();
  const exit = jest.fn<(code: number) => void>();
  const notices: string[] = [];
  const value = new TurnInterruptController({source, exit, notify: message => notices.push(message),
    language: 'en', graceMs: options.graceMs ?? 10_000});
  return {source, exit, notices, value};
}

describe('TurnInterruptController', () => {
  it('the first press is the full abort; the next press exits 130', () => {
    const {source, exit, notices, value} = controller();
    try {
      source.interrupt();
      expect(value.signal.aborted).toBe(true);
      expect(value.interrupted).toBe(true);
      expect(notices[0]).toContain('will not be saved');
      expect(exit).not.toHaveBeenCalled();
      source.interrupt();
      expect(exit).toHaveBeenCalledWith(130);
    } finally {value.dispose();}
  });

  it('exits 130 when an aborted turn does not unwind within the grace period', async () => {
    const {source, exit, value} = controller({graceMs: 5});
    try {
      source.interrupt();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(exit).toHaveBeenCalledWith(130);
    } finally {value.dispose();}
  });

  it('does not exit once the turn unwound and disposed', async () => {
    const {source, exit, value} = controller({graceMs: 5});
    source.interrupt();
    value.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(exit).not.toHaveBeenCalled();
    // The subscription is gone: the REPL gets Ctrl+C back.
    expect(source.interrupt()).toBe(false);
  });

  it('a committed turn releases Ctrl-C', () => {
    const {source, exit, value} = controller({graceMs: 5});
    value.markCommitted();
    expect(source.interrupt()).toBe(false);
    expect(value.signal.aborted).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
});
