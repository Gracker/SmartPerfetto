// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import os from 'os';

import {parseFlagValue} from '../utils/envFlag';

export const TP_ADMISSION_CONTROL_ENV = 'SMARTPERFETTO_TP_ADMISSION_CONTROL';
export const TP_RAM_BUDGET_BYTES_ENV = 'SMARTPERFETTO_TP_RAM_BUDGET_BYTES';
export const TP_RAM_BUDGET_FACTOR_ENV = 'SMARTPERFETTO_TP_RAM_BUDGET_FACTOR';
export const TP_ESTIMATE_MULTIPLIER_ENV = 'SMARTPERFETTO_TP_ESTIMATE_MULTIPLIER';
export const TP_MIN_ESTIMATE_BYTES_ENV = 'SMARTPERFETTO_TP_MIN_ESTIMATE_BYTES';
export const TP_OS_SAFETY_RESERVE_BYTES_ENV = 'SMARTPERFETTO_TP_OS_SAFETY_RESERVE_BYTES';
export const TP_UPLOAD_RESERVE_BYTES_ENV = 'SMARTPERFETTO_TP_UPLOAD_RESERVE_BYTES';

const GIB = 1024 * 1024 * 1024;
const DEFAULT_ESTIMATE_MULTIPLIER = 1.5;
const DEFAULT_MIN_ESTIMATE_BYTES = 128 * 1024 * 1024;

export interface TraceProcessorMemorySample {
  traceId?: string;
  rssBytes: number | null;
}

export interface TraceProcessorRamBudgetStats {
  enabled: boolean;
  totalMemoryBytes: number;
  nodeRssBytes: number;
  osSafetyReserveBytes: number;
  uploadReserveBytes: number;
  machineFactor: number;
  budgetBytes: number;
  observedProcessorRssBytes: number;
  availableForNewLeaseBytes: number;
  activeProcessorCount: number;
  unknownRssProcessorCount: number;
  estimateMultiplier: number;
  minEstimateBytes: number;
}

export interface TraceProcessorAdmissionDecision {
  admitted: boolean;
  traceId: string;
  traceSizeBytes: number;
  estimatedRssBytes: number;
  stats: TraceProcessorRamBudgetStats;
  reason?: string;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveTraceProcessorMachineFactor(
  totalMemoryBytes = os.totalmem(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = parsePositiveNumber(env[TP_RAM_BUDGET_FACTOR_ENV]);
  if (configured !== null) return Math.min(configured, 1);
  if (totalMemoryBytes < 16 * GIB) return 0.60;
  if (totalMemoryBytes <= 32 * GIB) return 0.75;
  return 0.85;
}

export function estimateTraceProcessorRssBytes(
  traceSizeBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const multiplier = parsePositiveNumber(env[TP_ESTIMATE_MULTIPLIER_ENV]) ?? DEFAULT_ESTIMATE_MULTIPLIER;
  const minEstimate = parsePositiveNumber(env[TP_MIN_ESTIMATE_BYTES_ENV]) ?? DEFAULT_MIN_ESTIMATE_BYTES;
  const size = Number.isFinite(traceSizeBytes) && traceSizeBytes > 0 ? traceSizeBytes : 0;
  return Math.max(Math.ceil(size * multiplier), minEstimate);
}

export function traceProcessorAdmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlagValue(env[TP_ADMISSION_CONTROL_ENV]) ?? true;
}

export function getTraceProcessorRamBudgetStats(
  processors: TraceProcessorMemorySample[],
  env: NodeJS.ProcessEnv = process.env,
): TraceProcessorRamBudgetStats {
  const totalMemoryBytes = os.totalmem();
  const nodeRssBytes = process.memoryUsage().rss;
  const osSafetyReserveBytes = Math.floor(
    parsePositiveNumber(env[TP_OS_SAFETY_RESERVE_BYTES_ENV]) ?? Math.max(GIB, totalMemoryBytes * 0.05),
  );
  const uploadReserveBytes = Math.floor(parsePositiveNumber(env[TP_UPLOAD_RESERVE_BYTES_ENV]) ?? 0);
  const machineFactor = resolveTraceProcessorMachineFactor(totalMemoryBytes, env);
  const configuredBudget = parsePositiveNumber(env[TP_RAM_BUDGET_BYTES_ENV]);
  const derivedAvailable = Math.max(0, totalMemoryBytes - nodeRssBytes - osSafetyReserveBytes - uploadReserveBytes);
  const budgetBytes = Math.floor(configuredBudget ?? (derivedAvailable * machineFactor));
  const observedProcessorRssBytes = processors.reduce((sum, processor) => {
    return sum + (processor.rssBytes && processor.rssBytes > 0 ? processor.rssBytes : 0);
  }, 0);
  const unknownRssProcessorCount = processors.filter(processor => processor.rssBytes === null).length;

  return {
    enabled: traceProcessorAdmissionEnabled(env),
    totalMemoryBytes,
    nodeRssBytes,
    osSafetyReserveBytes,
    uploadReserveBytes,
    machineFactor,
    budgetBytes,
    observedProcessorRssBytes,
    availableForNewLeaseBytes: Math.max(0, budgetBytes - observedProcessorRssBytes),
    activeProcessorCount: processors.length,
    unknownRssProcessorCount,
    estimateMultiplier: parsePositiveNumber(env[TP_ESTIMATE_MULTIPLIER_ENV]) ?? DEFAULT_ESTIMATE_MULTIPLIER,
    minEstimateBytes: parsePositiveNumber(env[TP_MIN_ESTIMATE_BYTES_ENV]) ?? DEFAULT_MIN_ESTIMATE_BYTES,
  };
}

export function decideTraceProcessorAdmission(input: {
  traceId: string;
  traceSizeBytes: number;
  processors: TraceProcessorMemorySample[];
  env?: NodeJS.ProcessEnv;
}): TraceProcessorAdmissionDecision {
  const env = input.env ?? process.env;
  const estimatedRssBytes = estimateTraceProcessorRssBytes(input.traceSizeBytes, env);
  const stats = getTraceProcessorRamBudgetStats(input.processors, env);
  if (!stats.enabled) {
    return {
      admitted: true,
      traceId: input.traceId,
      traceSizeBytes: input.traceSizeBytes,
      estimatedRssBytes,
      stats,
    };
  }
  if (estimatedRssBytes <= stats.availableForNewLeaseBytes) {
    return {
      admitted: true,
      traceId: input.traceId,
      traceSizeBytes: input.traceSizeBytes,
      estimatedRssBytes,
      stats,
    };
  }

  return {
    admitted: false,
    traceId: input.traceId,
    traceSizeBytes: input.traceSizeBytes,
    estimatedRssBytes,
    stats,
    reason: `estimated trace_processor RSS ${estimatedRssBytes} exceeds available budget ${stats.availableForNewLeaseBytes}`,
  };
}

export class TraceProcessorAdmissionError extends Error {
  constructor(readonly decision: TraceProcessorAdmissionDecision) {
    super(decision.reason || 'Trace processor RAM admission rejected');
    this.name = 'TraceProcessorAdmissionError';
  }
}

export function assertTraceProcessorAdmission(input: {
  traceId: string;
  traceSizeBytes: number;
  processors: TraceProcessorMemorySample[];
  env?: NodeJS.ProcessEnv;
}): TraceProcessorAdmissionDecision {
  const decision = decideTraceProcessorAdmission(input);
  if (!decision.admitted) {
    throw new TraceProcessorAdmissionError(decision);
  }
  return decision;
}
