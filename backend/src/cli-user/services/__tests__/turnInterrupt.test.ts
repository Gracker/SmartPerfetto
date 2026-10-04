// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {ForwardingInterruptSource, TurnInterruptController} from '../turnInterrupt';

function controller(options: {graceMs?: number; watchdogMs?: number} = {}) {
  const source = new ForwardingInterruptSource();
  const exit = jest.fn<(code: number) => void>();
  const notices: string[] = [];
  const value = new TurnInterruptController({source, exit, notify: message => notices.push(message),
    language: 'en', graceMs: options.graceMs ?? 10_000, watchdogMs: options.watchdogMs ?? 10_000});
  return {source, exit, notices, value};
}

describe('TurnInterruptController', () => {
  it('after a printed answer: review-only, then full abort, then exit 130', () => {
    const {source, exit, notices, value} = controller();
    try {
      value.markProvisionalDelivered('Answer.');
      source.interrupt();
      expect(value.reviewStopSignal.aborted).toBe(true);
      expect(value.signal.aborted).toBe(false);
      expect(notices[0]).toContain('saved as unverified');
      source.interrupt();
      expect(value.signal.aborted).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      source.interrupt();
      expect(exit).toHaveBeenCalledWith(130);
    } finally {value.dispose();}
  });

  it('before the answer (and always for json/ndjson): the first press is the full abort', () => {
    const {source, exit, value} = controller();
    try {
      source.interrupt();
      expect(value.signal.aborted).toBe(true);
      expect(value.interrupted).toBe(true);
      // A delivery that races the abort cannot turn the next press into a review stop.
      value.markProvisionalDelivered('Answer.');
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

  it('escalates a review-only stop to the full abort when the commit outlives the watchdog', async () => {
    const {source, notices, value} = controller({watchdogMs: 5});
    try {
      value.markProvisionalDelivered('Answer.');
      source.interrupt();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(value.signal.aborted).toBe(true);
      expect(notices[1]).toContain('not saved');
    } finally {value.dispose();}
  });

  it('a committed turn releases Ctrl-C and is never aborted by a pending review watchdog', async () => {
    const {source, exit, value} = controller({watchdogMs: 5, graceMs: 5});
    value.markProvisionalDelivered('Answer.');
    source.interrupt();
    value.markCommitted();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(value.signal.aborted).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(source.interrupt()).toBe(false);
  });
});
