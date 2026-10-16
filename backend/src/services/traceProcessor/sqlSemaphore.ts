// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Small FIFO semaphore used by Smart Analysis Mode to keep nested per-scene SQL
 * pressure bounded. Legacy scene reconstruction does not opt in.
 */
export class SqlSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`SqlSemaphore maxConcurrent must be a positive integer, got ${maxConcurrent}`);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

const smartSemaphores = new Map<string, SqlSemaphore>();

export function runWithSmartTraceSqlSemaphore<T>(
  traceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  let semaphore = smartSemaphores.get(traceId);
  if (!semaphore) {
    semaphore = new SqlSemaphore(1);
    smartSemaphores.set(traceId, semaphore);
  }
  return semaphore.run(fn);
}
