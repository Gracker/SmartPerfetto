// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawn} from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  CapabilityManifestTraceContentIdentityV1,
  CapabilityManifestTraceProcessorIdentityV1,
} from '../types/capabilityManifest';
import {
  resolveCapabilityTraceIdentity,
  resolveCapabilityTraceProcessorIdentity,
  type ResolveCapabilityTraceProcessorIdentityInput,
} from './capabilityManifestRuntimeIdentity';
import {
  getCoreTraceSummarySpecV1,
  renderTraceSummarySpecV1,
  type TraceSummaryMetricDefinitionV1,
  type TraceSummarySpecIdentityV1,
} from './traceSummarySpecRegistry';
import {getTraceProcessorPath} from './workingTraceProcessor';

export const TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION =
  'trace_summary_execution@1' as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 512 * 1024;

export interface TraceSummaryCommandInput {
  binaryPath: string;
  args: string[];
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}

export interface TraceSummaryCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputLimitExceeded?: 'stdout' | 'stderr';
}

export type TraceSummaryCommandRunner = (
  input: TraceSummaryCommandInput,
) => Promise<TraceSummaryCommandResult>;

export interface TraceSummaryMetricResultV1 extends TraceSummaryMetricDefinitionV1 {
  status: 'available' | 'missing';
  value?: number;
  missingReason?: 'no_rows';
}

export interface ParsedTraceSummaryV1 {
  metrics: TraceSummaryMetricResultV1[];
}

export type TraceSummaryExecutionV1 =
  | {
      schemaVersion: typeof TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION;
      status: 'ready';
      spec: TraceSummarySpecIdentityV1;
      trace: CapabilityManifestTraceContentIdentityV1;
      traceProcessor: CapabilityManifestTraceProcessorIdentityV1;
      resultDigestSha256: string;
      metrics: TraceSummaryMetricResultV1[];
      durationMs: number;
    }
  | {
      schemaVersion: typeof TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION;
      status: 'unavailable';
      spec: TraceSummarySpecIdentityV1;
      reason:
        | 'trace_identity_unavailable'
        | 'trace_processor_identity_unavailable'
        | 'trace_processor_session_unavailable'
        | 'trace_source_unavailable'
        | 'external_rpc_unsupported';
    }
  | {
      schemaVersion: typeof TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION;
      status: 'error';
      spec: TraceSummarySpecIdentityV1;
      reason:
        | 'temp_spec_failed'
        | 'temp_cleanup_failed'
        | 'timeout'
        | 'output_limit'
        | 'process_failed'
        | 'invalid_output';
      durationMs: number;
    };

export interface ExecuteTraceSummaryInput {
  tracePath: string;
  traceSide: 'current' | 'reference';
  timeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  remotePort?: number;
}

export interface ExecuteTraceSummaryDependencies {
  binaryPath?: string;
  binarySelection?: Extract<ResolveCapabilityTraceProcessorIdentityInput, {source: 'local_binary'}>;
  commandRunner?: TraceSummaryCommandRunner;
  removeTemporaryRoot?: (temporaryRoot: string) => Promise<void>;
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  throw new Error('trace_summary_unbalanced_textproto');
}

function namedBlocks(source: string, field: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`\\b${field}\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const openIndex = source.indexOf('{', match.index);
    const closeIndex = matchingBrace(source, openIndex);
    blocks.push(source.slice(openIndex + 1, closeIndex));
    pattern.lastIndex = closeIndex + 1;
  }
  return blocks;
}

function requiredIdentifier(block: string, field: string): string {
  const match = new RegExp(`\\b${field}\\s*:\\s*"([a-z0-9_.-]+)"`).exec(block);
  if (!match) throw new Error(`trace_summary_missing_${field}`);
  return match[1];
}

function requiredEnum(block: string, field: string): string {
  const match = new RegExp(`\\b${field}\\s*:\\s*([A-Z][A-Z0-9_]*)`).exec(block);
  if (!match) throw new Error(`trace_summary_missing_${field}`);
  return match[1];
}

function numericValue(block: string): number {
  const match = /\b(?:double_value|int64_value|uint64_value)\s*:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/.exec(block);
  if (!match) throw new Error('trace_summary_invalid_value');
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new Error('trace_summary_non_finite_value');
  return value;
}

function metricResult(
  definition: TraceSummaryMetricDefinitionV1,
  value: number | undefined,
): TraceSummaryMetricResultV1 {
  return value === undefined
    ? {...definition, dimensions: [...definition.dimensions], status: 'missing', missingReason: 'no_rows'}
    : {...definition, dimensions: [...definition.dimensions], status: 'available', value};
}

export function parseTraceSummaryTextV1(
  text: string,
  spec: TraceSummarySpecIdentityV1,
): ParsedTraceSummaryV1 {
  const definitions = new Map(spec.metrics.map(metric => [metric.id, metric]));
  const values = new Map<string, number | undefined>();
  const bundles = namedBlocks(text, 'metric_bundles');
  if (bundles.length === 0) throw new Error('trace_summary_missing_bundles');

  for (const bundle of bundles) {
    const specBlocks = namedBlocks(bundle, 'specs');
    if (specBlocks.length === 0) throw new Error('trace_summary_missing_specs');
    const bundleDefinitions = specBlocks.map(specBlock => {
      const id = requiredIdentifier(specBlock, 'id');
      const definition = definitions.get(id);
      if (!definition) throw new Error('trace_summary_unknown_spec');
      if (values.has(id)) throw new Error('trace_summary_duplicate_spec');
      if (requiredEnum(specBlock, 'unit') !== definition.unit) {
        throw new Error('trace_summary_unit_mismatch');
      }
      if (requiredEnum(specBlock, 'polarity') !== definition.polarity) {
        throw new Error('trace_summary_polarity_mismatch');
      }
      values.set(id, undefined);
      return definition;
    });

    const rows = namedBlocks(bundle, 'row');
    if (rows.length > 1) throw new Error('trace_summary_unique_metric_multiple_rows');
    if (rows.length === 0) continue;
    if (namedBlocks(rows[0], 'dimension').length > 0) {
      throw new Error('trace_summary_unexpected_dimensions');
    }
    const valueBlocks = namedBlocks(rows[0], 'values');
    if (valueBlocks.length !== bundleDefinitions.length) {
      throw new Error('trace_summary_value_count_mismatch');
    }
    bundleDefinitions.forEach((definition, index) => {
      values.set(definition.id, numericValue(valueBlocks[index]));
    });
  }

  for (const metricId of spec.metricIds) {
    if (!values.has(metricId)) throw new Error('trace_summary_declared_spec_missing');
  }
  return {
    metrics: spec.metrics.map(definition => metricResult(definition, values.get(definition.id))),
  };
}

const defaultCommandRunner: TraceSummaryCommandRunner = input => new Promise(resolve => {
  const child = spawn(input.binaryPath, input.args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputLimitExceeded: 'stdout' | 'stderr' | undefined;
  let settled = false;

  const terminate = (): void => {
    if (!child.killed) child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  timer.unref();

  const append = (target: Buffer[], chunk: Buffer, kind: 'stdout' | 'stderr'): void => {
    const limit = kind === 'stdout' ? input.stdoutLimitBytes : input.stderrLimitBytes;
    if (kind === 'stdout') stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if ((kind === 'stdout' ? stdoutBytes : stderrBytes) > limit) {
      outputLimitExceeded = kind;
      terminate();
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk, 'stderr'));
  child.on('error', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({exitCode: null, stdout: '', stderr: ''});
  });
  child.on('close', code => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      exitCode: code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      ...(timedOut ? {timedOut: true} : {}),
      ...(outputLimitExceeded ? {outputLimitExceeded} : {}),
    });
  });
});

function executionError(
  spec: TraceSummarySpecIdentityV1,
  reason: Extract<TraceSummaryExecutionV1, {status: 'error'}>['reason'],
  startedAt: number,
): TraceSummaryExecutionV1 {
  return {
    schemaVersion: TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION,
    status: 'error',
    spec,
    reason,
    durationMs: Date.now() - startedAt,
  };
}

export function unavailableTraceSummaryV1(
  reason: Extract<TraceSummaryExecutionV1, {status: 'unavailable'}>['reason'],
): TraceSummaryExecutionV1 {
  return {
    schemaVersion: TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION,
    status: 'unavailable',
    spec: getCoreTraceSummarySpecV1(),
    reason,
  };
}

function selectionOrigin(binaryPath: string, explicit: boolean): 'default' | 'env_override' | 'explicit' {
  if (explicit) return 'explicit';
  const configured = process.env.TRACE_PROCESSOR_PATH?.trim();
  return configured && path.resolve(configured) === path.resolve(binaryPath)
    ? 'env_override'
    : 'default';
}

export async function executeTraceSummaryV1(
  input: ExecuteTraceSummaryInput,
  dependencies: ExecuteTraceSummaryDependencies = {},
): Promise<TraceSummaryExecutionV1> {
  const startedAt = Date.now();
  const spec = getCoreTraceSummarySpecV1();
  if (input.remotePort !== undefined &&
    (!Number.isInteger(input.remotePort) || input.remotePort < 1 || input.remotePort > 65535)) {
    return unavailableTraceSummaryV1('trace_processor_session_unavailable');
  }
  const binarySelection = dependencies.binarySelection ?? {
    source: 'local_binary' as const,
    selectedPath: dependencies.binaryPath ?? getTraceProcessorPath(),
    selectionOrigin: selectionOrigin(
      dependencies.binaryPath ?? getTraceProcessorPath(),
      dependencies.binaryPath !== undefined,
    ),
  };
  const binaryPath = binarySelection.selectedPath;
  const traceResolution = await resolveCapabilityTraceIdentity({
    source: 'local_file', filePath: input.tracePath, traceSide: input.traceSide,
  });
  if (traceResolution.status !== 'ready') {
    return {
      schemaVersion: TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION,
      status: 'unavailable', spec, reason: 'trace_identity_unavailable',
    };
  }
  const traceProcessor = await resolveCapabilityTraceProcessorIdentity(binarySelection);
  if (traceProcessor.source === 'unknown') {
    return {
      schemaVersion: TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION,
      status: 'unavailable', spec, reason: 'trace_processor_identity_unavailable',
    };
  }

  let temporaryRoot: string | undefined;
  let result: TraceSummaryExecutionV1;
  try {
    temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-trace-summary-'));
    const specPath = path.join(temporaryRoot, 'spec.textproto');
    await fs.promises.writeFile(specPath, renderTraceSummarySpecV1(), {encoding: 'utf8', mode: 0o600});
    const command = await (dependencies.commandRunner ?? defaultCommandRunner)({
      binaryPath,
      args: input.remotePort === undefined
        ? [
            'summarize', '--format', 'text', '--metrics-v2', spec.metricIds.join(','),
            input.tracePath, specPath,
          ]
        : [
            'summarize', '--remote', `127.0.0.1:${input.remotePort}`,
            '--format', 'text', '--metrics-v2', spec.metricIds.join(','), specPath,
          ],
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutLimitBytes: input.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
      stderrLimitBytes: input.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
    });
    if (command.timedOut) {
      result = executionError(spec, 'timeout', startedAt);
    } else if (command.outputLimitExceeded) {
      result = executionError(spec, 'output_limit', startedAt);
    } else if (command.exitCode !== 0) {
      result = executionError(spec, 'process_failed', startedAt);
    } else {
      try {
        const parsed = parseTraceSummaryTextV1(command.stdout, spec);
        result = {
          schemaVersion: TRACE_SUMMARY_EXECUTION_SCHEMA_VERSION,
          status: 'ready',
          spec,
          trace: traceResolution.identity,
          traceProcessor,
          resultDigestSha256: crypto.createHash('sha256').update(command.stdout).digest('hex'),
          metrics: parsed.metrics,
          durationMs: Date.now() - startedAt,
        };
      } catch {
        result = executionError(spec, 'invalid_output', startedAt);
      }
    }
  } catch {
    result = executionError(spec, 'temp_spec_failed', startedAt);
  }
  if (temporaryRoot) {
    try {
      await (dependencies.removeTemporaryRoot ?? (root =>
        fs.promises.rm(root, {recursive: true, force: true})))(temporaryRoot);
    } catch {
      return executionError(spec, 'temp_cleanup_failed', startedAt);
    }
  }
  return result;
}
