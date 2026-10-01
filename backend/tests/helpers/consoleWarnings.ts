// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {jest} from '@jest/globals';

/** What console.warn (or console.error) received while `act` ran, for asserting what a log line may contain. */
export function consoleCallsDuring(method: 'warn' | 'error', act: () => void): unknown[][] {
  const spy = jest.spyOn(console, method).mockImplementation(() => {});
  try {
    act();
    // Restoring a spy clears its calls, so they are copied first.
    return spy.mock.calls.map(call => [...call]);
  } finally {
    spy.mockRestore();
  }
}

export function warningsDuring(act: () => void): unknown[][] {
  return consoleCallsDuring('warn', act);
}

export async function warningsDuringAsync(act: () => Promise<unknown>): Promise<unknown[][]> {
  const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await act();
    return spy.mock.calls.map(call => [...call]);
  } finally {
    spy.mockRestore();
  }
}
