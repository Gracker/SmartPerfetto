// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import os from 'os';
import {spawnSync} from 'child_process';

export type ProcessCpuTimeReader = (pid: number) => number | undefined;

export interface TraceProcessorCpuSampleMetadata {
  platform: NodeJS.Platform;
  sampleIntervalMs: number;
  staleThresholdMs: number;
  logicalCpuCount: number;
}

export interface TraceProcessorCpuSamplerOptions {
  resolvePids: () => readonly number[];
  recordSample: (
    cumulativeCpuMs: number,
    metadata: TraceProcessorCpuSampleMetadata,
  ) => void;
  readProcessCpuMs?: ProcessCpuTimeReader;
  platform?: NodeJS.Platform;
  sampleIntervalMs?: number;
  staleThresholdMs?: number;
  logicalCpuCount?: number;
  countNewProcessesFromZero?: boolean;
  onError?: (error: unknown) => void;
}

interface ProcessSampleState {
  baselineMs: number;
  lastObservedMs: number;
}

function parseProcessTime(value: string): number | undefined {
  const normalized = value.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(
    normalized,
  );
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const totalMs = (
    (((days * 24) + hours) * 60 + minutes) * 60
    + seconds
  ) * 1_000;
  return Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : undefined;
}

function positivePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

export function createProcessCpuTimeReader(
  platform: NodeJS.Platform = process.platform,
): ProcessCpuTimeReader {
  if (platform === 'win32') {
    return pid => {
      if (!positivePid(pid)) return undefined;
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`,
        ],
        {
          encoding: 'utf8',
          timeout: 2_000,
          windowsHide: true,
        },
      );
      if (result.status !== 0) return undefined;
      const value = Number(result.stdout.trim());
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return pid => {
      if (!positivePid(pid)) return undefined;
      const result = spawnSync(
        'ps',
        ['-o', 'time=', '-p', String(pid)],
        {
          encoding: 'utf8',
          timeout: 2_000,
          windowsHide: true,
        },
      );
      return result.status === 0
        ? parseProcessTime(result.stdout)
        : undefined;
    };
  }
  return () => undefined;
}

export class TraceProcessorCpuSampler {
  private readonly resolvePids: () => readonly number[];
  private readonly recordSample: TraceProcessorCpuSamplerOptions['recordSample'];
  private readonly readProcessCpuMs: ProcessCpuTimeReader;
  private readonly metadata: TraceProcessorCpuSampleMetadata;
  private readonly onError?: TraceProcessorCpuSamplerOptions['onError'];
  private readonly countNewProcessesFromZero: boolean;
  private readonly states = new Map<number, ProcessSampleState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sampleError: unknown;

  constructor(options: TraceProcessorCpuSamplerOptions) {
    this.resolvePids = options.resolvePids;
    this.recordSample = options.recordSample;
    this.onError = options.onError;
    this.countNewProcessesFromZero =
      options.countNewProcessesFromZero ?? false;
    this.metadata = {
      platform: options.platform ?? process.platform,
      sampleIntervalMs: Math.max(50, options.sampleIntervalMs ?? 250),
      staleThresholdMs: Math.max(100, options.staleThresholdMs ?? 1_000),
      logicalCpuCount: Math.max(
        1,
        options.logicalCpuCount ?? os.availableParallelism(),
      ),
    };
    this.readProcessCpuMs = options.readProcessCpuMs
      ?? createProcessCpuTimeReader(this.metadata.platform);
  }

  start(): void {
    if (this.timer) throw new Error('evaluation_cpu_sampler_already_started');
    this.sample();
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch (error) {
        this.sampleError ??= error;
        this.onError?.(error);
      }
    }, this.metadata.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!this.sampleError) {
      try {
        this.sample();
      } catch (error) {
        this.sampleError = error;
      }
    }
    if (this.sampleError) throw this.sampleError;
  }

  sample(): number | undefined {
    const pids = [...new Set(this.resolvePids().filter(positivePid))].sort(
      (left, right) => left - right,
    );
    let observed = false;
    for (const pid of pids) {
      const currentMs = this.readProcessCpuMs(pid);
      if (currentMs === undefined) continue;
      observed = true;
      const existing = this.states.get(pid);
      if (!existing) {
        this.states.set(pid, {
          baselineMs: this.countNewProcessesFromZero ? 0 : currentMs,
          lastObservedMs: currentMs,
        });
        continue;
      }
      if (currentMs >= existing.lastObservedMs) {
        existing.lastObservedMs = currentMs;
      }
    }
    if (!observed && this.states.size === 0) return undefined;
    const cumulativeCpuMs = [...this.states.values()].reduce(
      (total, state) =>
        total + Math.max(0, state.lastObservedMs - state.baselineMs),
      0,
    );
    this.recordSample(cumulativeCpuMs, this.metadata);
    return cumulativeCpuMs;
  }
}

export const __testing = {
  parseProcessTime,
};
