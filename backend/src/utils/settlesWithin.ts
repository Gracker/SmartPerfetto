// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** True when the promise settled (resolved or rejected) within `timeoutMs` milliseconds. */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(resolve, Math.max(0, Math.min(timeoutMs, 2_147_483_647)));
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), expired.then(() => false)]);
  } finally {
    clearTimeout(timer);
  }
}
