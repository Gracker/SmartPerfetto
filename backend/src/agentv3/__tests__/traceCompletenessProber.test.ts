// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {mkdtemp, rm, writeFile} from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CapabilityManifestV1 } from '../../types/capabilityManifest';
import {projectCapabilityManifestAttribution} from '../../services/capabilityManifest';
import {clearCapabilityRuntimeIdentityCaches} from '../../services/capabilityManifestRuntimeIdentity';
import {
  RunManifestLifecycle,
  withRunManifestLifecycle,
} from '../../services/selfEvolution/runManifestLifecycle';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import type { TraceCompleteness } from '../types';
import {
  CAPABILITY_REGISTRY,
  clearTraceCompletenessProbeCache,
  probeTraceCompleteness,
} from '../traceCompletenessProber';

const TRACE_SHA256 = 'a'.repeat(64);
const TP_GIT_REVISION = 'b'.repeat(40);
const BOUNDED_OPTIONS = {
  priority: 'p1',
  timeoutMs: 2000,
  maxRows: 1,
  maxResponseBytes: 4096,
  suppressErrorLog: true,
} as const;

type ManifestDependencies = {
  resolveTraceIdentity?: (...args: any[]) => Promise<any>;
  resolveTraceProcessorIdentity?: (...args: any[]) => Promise<any>;
  buildManifest?: (...args: any[]) => CapabilityManifestV1;
  projectAttribution?: (...args: any[]) => any;
  attributionSink?: any;
};

const tempRoots: string[] = [];

afterEach(async () => {
  clearTraceCompletenessProbeCache();
  clearCapabilityRuntimeIdentityCaches();
  jest.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map(root =>
    rm(root, {recursive: true, force: true})));
});

async function probeWithManifestDependencies(
  tps: any,
  traceId: string,
  dependencies: ManifestDependencies,
): Promise<TraceCompleteness & {capabilityManifestResolution?: unknown}> {
  return (probeTraceCompleteness as unknown as (
    service: any,
    id: string,
    architecture: undefined,
    manifestDependencies: ManifestDependencies,
  ) => Promise<TraceCompleteness & {capabilityManifestResolution?: unknown}>)(
    tps,
    traceId,
    undefined,
    dependencies,
  );
}

function legacySnapshot(result: TraceCompleteness): TraceCompleteness {
  return {
    available: result.available,
    missingConfig: result.missingConfig,
    notApplicable: result.notApplicable,
    insufficient: result.insufficient,
    diagnosedAt: result.diagnosedAt,
  };
}

function allCapabilityTables(rowCount: number): Record<string, number> {
  return Object.fromEntries(
    CAPABILITY_REGISTRY.map(capability => [capability.primaryTable, rowCount]),
  );
}

function expectedAllAvailableLegacy(diagnosedAt: number): TraceCompleteness {
  return {
    available: CAPABILITY_REGISTRY.map(capability => ({
      id: capability.id,
      displayName: capability.displayName,
      status: 'available' as const,
      primaryTable: capability.primaryTable,
      rowEstimate: 3,
    })),
    missingConfig: [],
    notApplicable: [],
    insufficient: [],
    diagnosedAt,
  };
}

function makeTraceProcessorMock(tables: Record<string, number>) {
  const query = jest.fn(async (_traceId: string, sql: string) => {
    if (sql.startsWith('INCLUDE PERFETTO MODULE')) {
      return { columns: [], rows: [], durationMs: 1 };
    }

    if (sql.includes('sqlite_master')) {
      return {
        columns: ['name'],
        rows: Object.keys(tables).map(name => [name]),
        durationMs: 1,
      };
    }

    if (sql.includes('UNION ALL')) {
      return {
        columns: ['tbl', 'cnt'],
        rows: Object.entries(tables).map(([name, count]) => [name, count]),
        durationMs: 1,
      };
    }

    const tableCountMatch = sql.match(/SELECT '([^']+)' AS tbl, COUNT\(\*\) AS cnt FROM/);
    if (tableCountMatch) {
      const tableName = tableCountMatch[1];
      return {
        columns: ['tbl', 'cnt'],
        rows: [[tableName, tables[tableName] ?? 0]],
        durationMs: 1,
      };
    }

    throw new Error(`Unexpected SQL in trace completeness test: ${sql}`);
  });

  const queryBounded = jest.fn(async (_traceId: string, sql: string) => {
    if (sql.includes("name = 'trace_processor_version'")) {
      return {columns: ['reported_version'], rows: [], durationMs: 1};
    }
    if (sql.includes('FROM trace_bounds')) {
      return {
        columns: ['start_ns', 'end_ns'],
        rows: [['100', '200']],
        durationMs: 1,
      };
    }
    throw new Error(`Unexpected bounded SQL in trace completeness test: ${sql}`);
  });

  return {
    query,
    queryBounded,
    getTraceSourceKind: jest.fn(() => 'local_file'),
    getTrace: jest.fn(() => ({filePath: '/fixtures/trace.pftrace'})),
    getRunningCapabilityTraceProcessorInput: jest.fn(() => ({
      source: 'local_binary',
      selectedPath: '/fixtures/trace_processor_shell',
      selectionOrigin: 'default',
    })),
  } as any;
}

function readyDependencies(
  overrides: ManifestDependencies = {},
): ManifestDependencies {
  return {
    resolveTraceIdentity: jest.fn(async (input: any) => input.source === 'external_rpc'
      ? {
          status: 'unavailable',
          reason: 'external_rpc_trace_fingerprint_unavailable',
        }
      : {
          status: 'ready',
          identity: {
            fingerprintSha256: TRACE_SHA256,
            fingerprintKind: 'trace_bytes_sha256',
            traceSide: input.traceSide,
            ...(input.clockRangeNs ? {clockRangeNs: input.clockRangeNs} : {}),
          },
        }),
    resolveTraceProcessorIdentity: jest.fn(async () => ({
      source: 'bundled',
      gitRevision: TP_GIT_REVISION,
    })),
    ...overrides,
  };
}

async function makeProductionCacheFixture(
  traceBytes = 'trace-cache-bytes',
  processorBytes = 'trace-processor-cache-bytes',
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-completeness-cache-'));
  tempRoots.push(root);
  const tracePath = path.join(root, 'trace.pftrace');
  const processorPath = path.join(root, 'trace_processor_shell');
  await Promise.all([
    writeFile(tracePath, traceBytes),
    writeFile(processorPath, processorBytes),
  ]);
  const tps = makeTraceProcessorMock(allCapabilityTables(3));
  tps.getTrace.mockReturnValue({filePath: tracePath});
  tps.getRunningCapabilityTraceProcessorInput.mockReturnValue({
    source: 'local_binary',
    selectedPath: processorPath,
    selectionOrigin: 'explicit',
  });
  return {tps, tracePath, processorPath};
}

function schemaProbeCount(tps: any): number {
  return tps.query.mock.calls.filter(
    (call: unknown[]) => String(call[1]).includes('sqlite_master'),
  ).length;
}

function createRunManifestLifecycle(): RunManifestLifecycle {
  return new RunManifestLifecycle({
    runId: 'run-cache',
    sessionId: 'session-cache',
    scope: {tenantId: 'tenant-cache', workspaceId: 'workspace-cache'},
    runtime: 'claude-agent-sdk',
    providerId: null,
    outputLanguage: 'en',
    analysisMode: 'full',
    skillRegistry: {registryFingerprint: 'registry-cache', skills: []},
  });
}

function readyProjectionResolution(): any {
  const content = {
    schemaVersion: 'capability_manifest@1' as const,
    traceProcessor: {
      source: 'custom' as const,
      binarySha256: 'b'.repeat(64),
    },
    trace: {
      fingerprintSha256: TRACE_SHA256,
      fingerprintKind: 'trace_bytes_sha256' as const,
      traceSide: 'current' as const,
    },
    capabilities: [],
  };
  const contentHash = canonicalContentHash(content);
  return {
    status: 'ready',
    manifest: {
      content,
      provenance: {
        traceId: 'trace-1',
        processorKey: '/private/processor-key',
        leaseId: '/private/lease',
        rpcEndpoint: 'http://127.0.0.1:9001',
        diagnosedAt: 1_000,
        generatedAt: 2_000,
      },
      manifestId: `capability_manifest:${contentHash}`,
      contentHash,
    },
  };
}

describe('probeTraceCompleteness', () => {
  it('projects path-free versioned attribution with one deterministic cache observation', () => {
    const readyResolution = readyProjectionResolution();
    const attribution = projectCapabilityManifestAttribution(
      readyResolution,
      {outcome: 'miss', keyHash: 'd'.repeat(64)},
    );

    expect(attribution).toEqual({
      schemaVersion: 'capability_manifest_attribution@1',
      resolution: {
        status: 'ready',
        manifestId: readyResolution.manifest.manifestId,
        contentHash: readyResolution.manifest.contentHash,
        manifestSchemaVersion: 'capability_manifest@1',
        traceFingerprintSha256: TRACE_SHA256,
        traceProcessor: {
          source: 'custom',
          binarySha256: 'b'.repeat(64),
        },
      },
      probeCache: {
        keyHash: 'd'.repeat(64),
        hits: 0,
        misses: 1,
        bypasses: 0,
      },
    });
    expect(JSON.stringify(attribution)).not.toContain('/private/');
    expect(Object.isFrozen(attribution)).toBe(true);

    expect(projectCapabilityManifestAttribution(
      {
        status: 'unavailable',
        reason: 'trace_hash_failed',
        detailCode: '/private/unsafe-detail',
      },
      {outcome: 'bypass'},
    )).toEqual({
      schemaVersion: 'capability_manifest_attribution@1',
      resolution: {status: 'unavailable', reason: 'trace_hash_failed'},
      probeCache: {hits: 0, misses: 0, bypasses: 1},
    });
    expect(projectCapabilityManifestAttribution(
      {status: 'failed', reason: 'capability_manifest_build_failed'},
      {outcome: 'bypass'},
    ).resolution).toEqual({
      status: 'failed',
      reason: 'capability_manifest_build_failed',
    });
  });

  it('rejects a ready attribution whose content no longer matches its hash', () => {
    const resolution = readyProjectionResolution();
    resolution.manifest.content.capabilities.push({
      id: 'tampered',
      displayName: 'tampered',
      primaryTable: 'slice',
      status: 'available',
      sourceState: 'present_with_data',
    });

    expect(() => projectCapabilityManifestAttribution(
      resolution,
      {outcome: 'miss', keyHash: 'd'.repeat(64)},
    )).toThrow('capability_manifest_attribution_invalid_ready_resolution');
  });

  it('rejects an unknown cache outcome instead of recording zero counters', () => {
    expect(() => projectCapabilityManifestAttribution(
      {status: 'failed', reason: 'capability_manifest_build_failed'},
      {outcome: 'stale' as 'hit'},
    )).toThrow('capability_manifest_attribution_invalid_cache_outcome');
  });

  it('rekeys the production cache when trace bytes change', async () => {
    const {tps, tracePath} = await makeProductionCacheFixture();

    const first = await probeTraceCompleteness(tps, 'trace-bytes-key', 'STANDARD');
    await writeFile(tracePath, 'trace-cache-bytes-changed-and-longer');
    const second = await probeTraceCompleteness(tps, 'trace-bytes-key', 'STANDARD');

    expect(schemaProbeCount(tps)).toBe(2);
    expect((first.capabilityManifestResolution as any).manifest.contentHash)
      .not.toBe((second.capabilityManifestResolution as any).manifest.contentHash);
  });

  it('rekeys the production cache when the running processor bytes change', async () => {
    const {tps, processorPath} = await makeProductionCacheFixture();

    const first = await probeTraceCompleteness(tps, 'processor-key', 'STANDARD');
    await writeFile(processorPath, 'trace-processor-cache-bytes-changed-and-longer');
    const second = await probeTraceCompleteness(tps, 'processor-key', 'STANDARD');

    expect(schemaProbeCount(tps)).toBe(2);
    expect((first.capabilityManifestResolution as any).manifest.content.traceProcessor)
      .not.toEqual((second.capabilityManifestResolution as any).manifest.content.traceProcessor);
  });

  it('keys production cache entries by architecture and reuses each exact identity', async () => {
    const {tps} = await makeProductionCacheFixture();

    await probeTraceCompleteness(tps, 'architecture-key', 'STANDARD');
    await probeTraceCompleteness(tps, 'architecture-key', 'FLUTTER');
    await probeTraceCompleteness(tps, 'architecture-key', 'STANDARD');

    expect(schemaProbeCount(tps)).toBe(2);
  });

  it('deduplicates concurrent production probes and materializes fresh timestamps', async () => {
    const {tps} = await makeProductionCacheFixture();
    const originalQuery = tps.query.getMockImplementation();
    let releaseSchema!: () => void;
    const schemaGate = new Promise<void>(resolve => {
      releaseSchema = resolve;
    });
    tps.query.mockImplementation(async (traceId: string, sql: string) => {
      if (sql.includes('sqlite_master')) await schemaGate;
      return originalQuery!(traceId, sql);
    });
    let tick = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => ++tick);

    const firstPromise = probeTraceCompleteness(tps, 'concurrent-key', 'STANDARD');
    const secondPromise = probeTraceCompleteness(tps, 'concurrent-key', 'STANDARD');
    await new Promise(resolve => setImmediate(resolve));
    releaseSchema();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(schemaProbeCount(tps)).toBe(1);
    expect(first.available).toEqual(second.available);
    expect(first.diagnosedAt).not.toBe(second.diagnosedAt);
    expect((first.capabilityManifestResolution as any).manifest.provenance.diagnosedAt)
      .toBe(first.diagnosedAt);
    expect((second.capabilityManifestResolution as any).manifest.provenance.diagnosedAt)
      .toBe(second.diagnosedAt);
    expect((first.capabilityManifestResolution as any).manifest.provenance.generatedAt)
      .not.toBe((second.capabilityManifestResolution as any).manifest.provenance.generatedAt);
  });

  it('evicts a rejected in-flight production probe', async () => {
    const {tps} = await makeProductionCacheFixture();
    jest.spyOn(console, 'log')
      .mockImplementationOnce(() => {
        throw new Error('first probe rejected');
      })
      .mockImplementation(() => undefined);

    await expect(probeTraceCompleteness(tps, 'rejection-key', 'STANDARD'))
      .rejects.toThrow('first probe rejected');
    await expect(probeTraceCompleteness(tps, 'rejection-key', 'STANDARD'))
      .resolves.toMatchObject({available: expect.any(Array)});

    expect(schemaProbeCount(tps)).toBe(2);
  });

  it('bounds completed and in-flight production entries to the 32 most recent keys', async () => {
    const {tps} = await makeProductionCacheFixture();

    for (let index = 0; index < 33; index++) {
      await probeTraceCompleteness(tps, `lru-key-${index}`, 'STANDARD');
    }
    await probeTraceCompleteness(tps, 'lru-key-0', 'STANDARD');

    expect(schemaProbeCount(tps)).toBe(34);
  });

  it('records one miss and one hit on the current RunManifest attribution sink', async () => {
    const {tps} = await makeProductionCacheFixture();
    const lifecycle = createRunManifestLifecycle();

    await withRunManifestLifecycle(lifecycle, async () => {
      await probeTraceCompleteness(tps, 'manifest-counters', 'STANDARD');
      await probeTraceCompleteness(tps, 'manifest-counters', 'STANDARD');
    });

    const attribution = lifecycle.builder.seal().capabilityManifest;
    expect(attribution?.probeCache).toEqual({
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      hits: 1,
      misses: 1,
      bypasses: 0,
    });
    expect(JSON.stringify(attribution)).not.toContain(tempRoots[0]);
  });

  it('bypasses the shared cache for external, injected, and unresolved identity', async () => {
    const external = makeTraceProcessorMock(allCapabilityTables(3));
    external.getTraceSourceKind.mockReturnValue('external_rpc');
    await probeTraceCompleteness(external, 'external-bypass', 'STANDARD');
    await probeTraceCompleteness(external, 'external-bypass', 'STANDARD');
    expect(schemaProbeCount(external)).toBe(2);

    const injected = makeTraceProcessorMock(allCapabilityTables(3));
    const dependencies = readyDependencies();
    await probeWithManifestDependencies(injected, 'injected-bypass', dependencies);
    await probeWithManifestDependencies(injected, 'injected-bypass', dependencies);
    expect(schemaProbeCount(injected)).toBe(2);

    const unresolved = makeTraceProcessorMock(allCapabilityTables(3));
    unresolved.getRunningCapabilityTraceProcessorInput.mockReturnValue(undefined);
    await probeTraceCompleteness(unresolved, 'unresolved-bypass', 'STANDARD');
    await probeTraceCompleteness(unresolved, 'unresolved-bypass', 'STANDARD');
    expect(schemaProbeCount(unresolved)).toBe(2);
  });

  it.each([
    {
      name: 'projector',
      dependencies: () => readyDependencies({
        projectAttribution: jest.fn(() => {
          throw new Error('/private/projector-error');
        }),
      }),
      diagnostic: 'capability_manifest_attribution_projection_failed',
    },
    {
      name: 'sink',
      dependencies: () => readyDependencies({
        attributionSink: {
          recordCapabilityManifest: () => {
            throw new Error('/private/sink-error');
          },
        },
      }),
      diagnostic: 'capability_manifest_attribution_sink_failed',
    },
  ])('isolates $name failures behind a fixed diagnostic code', async ({dependencies, diagnostic}) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await probeWithManifestDependencies(
      makeTraceProcessorMock(allCapabilityTables(3)),
      'attribution-isolation',
      dependencies(),
    );

    expect(legacySnapshot(result)).toEqual(
      expectedAllAvailableLegacy(result.diagnosedAt),
    );
    expect(result.capabilityManifestResolution).toMatchObject({status: 'ready'});
    expect(warn).toHaveBeenCalledWith(`[TraceCompleteness] ${diagnostic}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/');
  });

  it('loads power prerequisite modules before probing M2.0 capabilities', async () => {
    const tps = makeTraceProcessorMock({
      android_power_rails_counters: 3,
      android_battery_charge: 3,
      cpu_idle_counters: 3,
      android_gpu_work_period_track: 3,
    });

    const result = await probeTraceCompleteness(tps, 'trace-1');

    const includeSql = tps.query.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((sql: string) => sql.startsWith('INCLUDE PERFETTO MODULE'));

    expect(includeSql).toEqual(expect.arrayContaining([
      'INCLUDE PERFETTO MODULE android.power_rails;',
      'INCLUDE PERFETTO MODULE android.battery;',
      'INCLUDE PERFETTO MODULE linux.cpu.idle;',
      'INCLUDE PERFETTO MODULE android.gpu.work_period;',
    ]));

    expect(result.available.map(cap => cap.id)).toEqual(expect.arrayContaining([
      'power_rails',
      'battery_counters',
      'cpu_freq_idle',
      'gpu_work_period',
    ]));
  });

  it('reports actionable capture guidance when power capability tables are absent', async () => {
    const tps = makeTraceProcessorMock({});

    const result = await probeTraceCompleteness(tps, 'trace-1');

    const missingById = new Map(result.missingConfig.map(cap => [cap.id, cap.reason ?? '']));
    expect(missingById.get('power_rails')).toContain('collect_power_rails');
    expect(missingById.get('battery_counters')).toContain('battery_poll_ms');
    expect(missingById.get('cpu_freq_idle')).toContain('cpu_idle');
    expect(missingById.get('gpu_work_period')).toContain('android.gpu.work_period');
  });

  it('registers network packet capability with packet-stage boundary guidance', async () => {
    const tps = makeTraceProcessorMock({
      android_network_packets: 12,
    });

    const result = await probeTraceCompleteness(tps, 'trace-1');

    const includeSql = tps.query.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((sql: string) => sql.startsWith('INCLUDE PERFETTO MODULE'));

    expect(includeSql).toContain('INCLUDE PERFETTO MODULE android.network_packets;');
    expect(result.available.map(cap => cap.id)).toContain('network_packets');

    const registryEntry = CAPABILITY_REGISTRY.find(cap => cap.id === 'network_packets');
    expect(registryEntry?.captureHint).toContain('不能直接证明 DNS/TCP/TLS/TTFB');
  });

  it('keeps key evidence-boundary capability ids registered', () => {
    const ids = CAPABILITY_REGISTRY.map(cap => cap.id);
    expect(ids).toEqual(expect.arrayContaining([
      'power_rails',
      'battery_counters',
      'cpu_freq_idle',
      'gpu_work_period',
      'network_packets',
    ]));
  });

  it('freezes the legacy five-field result before attaching shadow resolution', async () => {
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValue(3_000);
    try {
      const result = await probeWithManifestDependencies(
        makeTraceProcessorMock(allCapabilityTables(3)),
        'trace-1',
        readyDependencies(),
      );

      expect(legacySnapshot(result)).toEqual(expectedAllAvailableLegacy(3_000));
      expect(result.capabilityManifestResolution).toMatchObject({status: 'ready'});
    } finally {
      now.mockRestore();
    }
  });

  it('maps present-empty to insufficient only inside the ready manifest', async () => {
    const tps = makeTraceProcessorMock({android_startups: 0});
    const dependencies = readyDependencies();

    const result = await probeWithManifestDependencies(tps, 'trace-1', dependencies);

    const legacyStartup = result.missingConfig.find(cap => cap.id === 'startup');
    expect(legacyStartup).toMatchObject({
      status: 'missing_config_suspected',
      rowEstimate: 0,
    });
    const resolution = result.capabilityManifestResolution as any;
    expect(resolution.status).toBe('ready');
    expect(resolution.manifest.content.capabilities.find((cap: any) => cap.id === 'startup'))
      .toMatchObject({
        status: 'insufficient',
        sourceState: 'present_empty',
        reasonCode: 'empty_or_scene_absent',
        rowEstimate: 0,
      });
    expect(resolution.manifest.content.trace).toMatchObject({
      fingerprintSha256: TRACE_SHA256,
      fingerprintKind: 'trace_bytes_sha256',
      clockRangeNs: {startNs: '100', endNs: '200'},
    });
    expect(tps.queryBounded).toHaveBeenCalledWith(
      'trace-1',
      "SELECT str_value AS reported_version\nFROM metadata\nWHERE name = 'trace_processor_version'\nLIMIT 1",
      BOUNDED_OPTIONS,
    );
    expect(tps.queryBounded).toHaveBeenCalledWith(
      'trace-1',
      'SELECT CAST(start_ts AS TEXT) AS start_ns,\n' +
        '       CAST(end_ts AS TEXT) AS end_ns\n' +
        'FROM trace_bounds\n' +
        'LIMIT 1',
      BOUNDED_OPTIONS,
    );
  });

  it.each([
    {
      name: 'trace source getter throws',
      mutate: (tps: any) => tps.getTraceSourceKind.mockImplementation(() => {
        throw new Error('/private/source-path');
      }),
      dependencies: () => readyDependencies(),
      expected: {status: 'unavailable', reason: 'trace_source_unavailable'},
    },
    {
      name: 'trace file getter throws',
      mutate: (tps: any) => tps.getTrace.mockImplementation(() => {
        throw new Error('/private/trace-path');
      }),
      dependencies: () => readyDependencies(),
      expected: {status: 'unavailable', reason: 'trace_source_unavailable'},
    },
    {
      name: 'trace identity resolver throws',
      mutate: () => undefined,
      dependencies: () => readyDependencies({
        resolveTraceIdentity: jest.fn(async () => {
          throw new Error('/private/hash-path');
        }),
      }),
      expected: {status: 'unavailable', reason: 'identity_resolution_failed'},
    },
    {
      name: 'manifest builder throws',
      mutate: () => undefined,
      dependencies: () => readyDependencies({
        buildManifest: jest.fn(() => {
          throw new Error('/private/builder-path');
        }),
      }),
      expected: {status: 'failed', reason: 'capability_manifest_build_failed'},
    },
  ])('isolates $name from the legacy result', async ({mutate, dependencies, expected}) => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(7_000);
    try {
      const tps = makeTraceProcessorMock(allCapabilityTables(3));
      mutate(tps);

      const result = await probeWithManifestDependencies(tps, 'trace-1', dependencies());

      expect(legacySnapshot(result)).toEqual(expectedAllAvailableLegacy(7_000));
      expect(result.capabilityManifestResolution).toEqual(expected);
      expect(JSON.stringify(result.capabilityManifestResolution)).not.toContain('/private/');
    } finally {
      now.mockRestore();
    }
  });

  it('keeps building with unknown processor identity when the selection getter throws', async () => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    tps.getRunningCapabilityTraceProcessorInput.mockImplementation(() => {
      throw new Error('/private/processor-selection');
    });

    const result = await probeWithManifestDependencies(tps, 'trace-1', readyDependencies());

    expect(legacySnapshot(result)).toEqual(
      expectedAllAvailableLegacy(result.diagnosedAt),
    );
    expect(result.capabilityManifestResolution).toMatchObject({
      status: 'ready',
      manifest: {
        content: {
          traceProcessor: {
            source: 'unknown',
            unavailableReason: 'identity_resolution_failed',
          },
        },
      },
    });
  });

  it('keeps building with unknown processor identity when its resolver throws', async () => {
    const result = await probeWithManifestDependencies(
      makeTraceProcessorMock(allCapabilityTables(3)),
      'trace-1',
      readyDependencies({
        resolveTraceProcessorIdentity: jest.fn(async () => {
          throw new Error('/private/processor-path');
        }),
      }),
    );

    expect(legacySnapshot(result)).toEqual(
      expectedAllAvailableLegacy(result.diagnosedAt),
    );
    expect(result.capabilityManifestResolution).toMatchObject({
      status: 'ready',
      manifest: {
        content: {
          traceProcessor: {
            source: 'unknown',
            unavailableReason: 'identity_resolution_failed',
          },
        },
      },
    });
  });

  it.each([
    ['version query', "name = 'trace_processor_version'", 'reportedVersion'],
    ['bounds query', 'FROM trace_bounds', 'clockRangeNs'],
  ])('omits metadata when the %s throws', async (_name, sqlNeedle, omittedField) => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    const defaultQueryBounded = tps.queryBounded.getMockImplementation();
    tps.queryBounded.mockImplementation(async (traceId: string, sql: string, options: any) => {
      if (sql.includes(sqlNeedle)) throw new Error('/private/bounded-query');
      return defaultQueryBounded!(traceId, sql, options);
    });

    const result = await probeWithManifestDependencies(tps, 'trace-1', readyDependencies());

    expect(legacySnapshot(result)).toEqual(
      expectedAllAvailableLegacy(result.diagnosedAt),
    );
    expect(result.capabilityManifestResolution).toMatchObject({status: 'ready'});
    const manifest = (result.capabilityManifestResolution as any).manifest;
    if (omittedField === 'reportedVersion') {
      expect(manifest.content.traceProcessor).not.toHaveProperty(omittedField);
    } else {
      expect(manifest.content.trace).not.toHaveProperty(omittedField);
    }
  });

  it('attaches only a sanitized reported trace processor version', async () => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    const defaultQueryBounded = tps.queryBounded.getMockImplementation();
    tps.queryBounded.mockImplementation(async (traceId: string, sql: string, options: any) => {
      if (sql.includes("name = 'trace_processor_version'")) {
        return {columns: ['reported_version'], rows: [['  Perfetto v50.1  ']], durationMs: 1};
      }
      return defaultQueryBounded!(traceId, sql, options);
    });

    const result = await probeWithManifestDependencies(tps, 'trace-1', readyDependencies());

    expect(result.capabilityManifestResolution).toMatchObject({
      status: 'ready',
      manifest: {
        content: {
          traceProcessor: {reportedVersion: 'Perfetto v50.1'},
        },
      },
    });
  });

  it.each([
    ['RPC error', {columns: ['reported_version'], rows: [['v50']], durationMs: 1, error: 'failed'}],
    ['unexpected columns', {columns: ['version'], rows: [['v50']], durationMs: 1}],
    ['extra rows', {columns: ['reported_version'], rows: [['v50'], ['v51']], durationMs: 1}],
    ['extra cells', {columns: ['reported_version'], rows: [['v50', 'extra']], durationMs: 1}],
    ['non-string value', {columns: ['reported_version'], rows: [[50]], durationMs: 1}],
    ['unsafe path text', {columns: ['reported_version'], rows: [['path=/private/tp']], durationMs: 1}],
  ])('omits a malformed reported version result: %s', async (_name, malformedResult) => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    const defaultQueryBounded = tps.queryBounded.getMockImplementation();
    tps.queryBounded.mockImplementation(async (traceId: string, sql: string, options: any) => {
      if (sql.includes("name = 'trace_processor_version'")) return malformedResult;
      return defaultQueryBounded!(traceId, sql, options);
    });

    const result = await probeWithManifestDependencies(tps, 'trace-1', readyDependencies());

    expect((result.capabilityManifestResolution as any).manifest.content.traceProcessor)
      .not.toHaveProperty('reportedVersion');
  });

  it.each([
    ['RPC error', {columns: ['start_ns', 'end_ns'], rows: [['1', '2']], durationMs: 1, error: 'failed'}],
    ['unexpected columns', {columns: ['start', 'end'], rows: [['1', '2']], durationMs: 1}],
    ['extra rows', {columns: ['start_ns', 'end_ns'], rows: [['1', '2'], ['3', '4']], durationMs: 1}],
    ['extra cells', {columns: ['start_ns', 'end_ns'], rows: [['1', '2', '3']], durationMs: 1}],
    ['non-string value', {columns: ['start_ns', 'end_ns'], rows: [[1, '2']], durationMs: 1}],
    ['non-canonical start', {columns: ['start_ns', 'end_ns'], rows: [['01', '2']], durationMs: 1}],
    ['negative end', {columns: ['start_ns', 'end_ns'], rows: [['1', '-2']], durationMs: 1}],
    ['reversed range', {columns: ['start_ns', 'end_ns'], rows: [['2', '1']], durationMs: 1}],
  ])('omits malformed trace bounds: %s', async (_name, malformedResult) => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    const defaultQueryBounded = tps.queryBounded.getMockImplementation();
    tps.queryBounded.mockImplementation(async (traceId: string, sql: string, options: any) => {
      if (sql.includes('FROM trace_bounds')) return malformedResult;
      return defaultQueryBounded!(traceId, sql, options);
    });

    const result = await probeWithManifestDependencies(tps, 'trace-1', readyDependencies());

    expect((result.capabilityManifestResolution as any).manifest.content.trace)
      .not.toHaveProperty('clockRangeNs');
  });

  it('passes through fixed trace identity unavailability without raw detail', async () => {
    const result = await probeWithManifestDependencies(
      makeTraceProcessorMock(allCapabilityTables(3)),
      'trace-1',
      readyDependencies({
        resolveTraceIdentity: jest.fn(async () => ({
          status: 'unavailable',
          reason: 'trace_hash_failed',
          detail: 'file_identity_changed',
        })),
      }),
    );

    expect(result.capabilityManifestResolution).toEqual({
      status: 'unavailable',
      reason: 'trace_hash_failed',
      detailCode: 'file_identity_changed',
    });
  });

  it.each([
    ['external_rpc', 'external_rpc_trace_fingerprint_unavailable'],
    [undefined, 'trace_source_unavailable'],
  ] as const)('does not invent a trace hash for %s source', async (source, reason) => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    tps.getTraceSourceKind.mockReturnValue(source);
    const dependencies = readyDependencies();

    const result = await probeWithManifestDependencies(tps, 'trace-1', dependencies);

    expect(result.capabilityManifestResolution).toEqual({status: 'unavailable', reason});
    if (source === 'external_rpc') {
      expect(dependencies.resolveTraceIdentity).toHaveBeenCalledWith({
        source: 'external_rpc',
        traceSide: 'current',
      });
    } else {
      expect(dependencies.resolveTraceIdentity).not.toHaveBeenCalled();
    }
  });

  it('uses production defaults for an existing three-argument invocation', async () => {
    const tps = makeTraceProcessorMock(allCapabilityTables(3));
    tps.getTraceSourceKind.mockReturnValue('external_rpc');

    const result = await probeTraceCompleteness(tps, 'trace-1', undefined);

    expect((result as any).capabilityManifestResolution).toEqual({
      status: 'unavailable',
      reason: 'external_rpc_trace_fingerprint_unavailable',
    });
  });
});
