// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildCapabilityManifest,
  capabilityManifestContentProjection,
} from '../capabilityManifest';
import {canonicalContentHash} from '../selfEvolution/canonicalJson';
import {
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  type BuildCapabilityManifestInput,
  type CapabilityManifestLegacyProbeResult,
  type CapabilityManifestTraceProcessorIdentityV1,
} from '../../types/capabilityManifest';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const GIT_A = 'a'.repeat(40);
const GIT_B = 'b'.repeat(40);

function legacyResult(
  id: string,
  status: CapabilityManifestLegacyProbeResult['status'],
  primaryTable: string,
  rowEstimate?: number,
): CapabilityManifestLegacyProbeResult {
  return {
    id,
    displayName: id === 'frame_rendering' ? 'Frame rendering' : 'Startup',
    status,
    primaryTable,
    ...(rowEstimate === undefined ? {} : {rowEstimate}),
  };
}

function baseInput(): BuildCapabilityManifestInput {
  return {
    definitions: [
      {
        id: 'frame_rendering',
        displayName: 'Frame rendering',
        primaryTable: 'slice',
        requiredModules: ['android.frames'],
      },
      {
        id: 'startup',
        displayName: 'Startup',
        primaryTable: 'android_startups',
      },
    ],
    legacyProbe: {
      available: [],
      missingConfig: [
        legacyResult(
          'frame_rendering',
          'missing_config_suspected',
          'slice',
          0,
        ),
        legacyResult(
          'startup',
          'missing_config_suspected',
          'android_startups',
        ),
      ],
      notApplicable: [],
      insufficient: [],
      diagnosedAt: 1_000,
    },
    traceProcessor: {
      source: 'bundled',
      gitRevision: GIT_A,
      reportedVersion: 'v50.1',
      rpcApiVersion: 'v1',
      stdlibRevision: GIT_B,
    },
    trace: {
      fingerprintSha256: SHA_A,
      traceSide: 'current',
      androidApiLevel: 35,
      machineId: 'device-1',
      clockRangeNs: {startNs: '0', endNs: '12345678901234567890'},
    },
    provenance: {
      traceId: 'trace-1',
      processorKey: 'processor-1',
      leaseId: 'lease-1',
      rpcEndpoint: 'http://127.0.0.1:9001',
    },
    generatedAt: 2_000,
  };
}

function expectErrorCode(input: BuildCapabilityManifestInput, code: string): void {
  expect(() => buildCapabilityManifest(input)).toThrow(code);
}

describe('CapabilityManifest contract', () => {
  it('maps legacy present-empty and schema-missing results into v1 content', () => {
    const manifest = buildCapabilityManifest(baseInput());
    const byId = new Map(manifest.content.capabilities.map(entry => [entry.id, entry]));

    expect(CAPABILITY_MANIFEST_SCHEMA_VERSION).toBe('capability_manifest@1');
    expect(manifest.content.schemaVersion).toBe('capability_manifest@1');
    expect(byId.get('frame_rendering')).toMatchObject({
      status: 'insufficient',
      sourceState: 'present_empty',
      reasonCode: 'empty_or_scene_absent',
      rowEstimate: 0,
    });
    expect(byId.get('startup')).toMatchObject({
      status: 'missing',
      sourceState: 'schema_missing',
      reasonCode: 'schema_missing',
    });
  });

  it('maps available, sparse, and not-applicable legacy buckets', () => {
    const input = baseInput();
    input.definitions.push({
      id: 'power',
      displayName: 'Power',
      primaryTable: 'android_battery_stats',
    });
    input.legacyProbe.missingConfig = [];
    input.legacyProbe.available = [
      legacyResult('frame_rendering', 'available', 'slice', 20),
    ];
    input.legacyProbe.insufficient = [
      legacyResult(
        'startup',
        'insufficient_or_scene_absent',
        'android_startups',
        1,
      ),
    ];
    input.legacyProbe.notApplicable = [
      legacyResult('power', 'not_applicable', 'android_battery_stats'),
    ];

    const byId = new Map(
      buildCapabilityManifest(input).content.capabilities.map(entry =>
        [entry.id, entry]),
    );
    expect(byId.get('frame_rendering')).toMatchObject({
      status: 'available',
      sourceState: 'present_with_data',
      rowEstimate: 20,
    });
    expect(byId.get('frame_rendering')).not.toHaveProperty('reasonCode');
    expect(byId.get('startup')).toMatchObject({
      status: 'insufficient',
      sourceState: 'present_with_data',
      reasonCode: 'sparse_or_scene_absent',
      rowEstimate: 1,
    });
    expect(byId.get('power')).toMatchObject({
      status: 'not_applicable',
      sourceState: 'not_applicable',
      reasonCode: 'not_applicable',
    });
    expect(byId.get('power')).not.toHaveProperty('rowEstimate');
  });

  it.each([
    ['generatedAt', (input: BuildCapabilityManifestInput) => { input.generatedAt++; }],
    ['diagnosedAt', (input: BuildCapabilityManifestInput) => { input.legacyProbe.diagnosedAt++; }],
    ['traceId', (input: BuildCapabilityManifestInput) => { input.provenance.traceId += '-changed'; }],
    ['processorKey', (input: BuildCapabilityManifestInput) => { input.provenance.processorKey += '-changed'; }],
    ['leaseId', (input: BuildCapabilityManifestInput) => { input.provenance.leaseId += '-changed'; }],
    ['rpcEndpoint', (input: BuildCapabilityManifestInput) => { input.provenance.rpcEndpoint += '/changed'; }],
  ])('excludes %s from content identity', (_name, mutate) => {
    const baseline = buildCapabilityManifest(baseInput());
    const changedInput = baseInput();
    mutate(changedInput);
    const changed = buildCapabilityManifest(changedInput);

    expect(changed.contentHash).toBe(baseline.contentHash);
    expect(changed.manifestId).toBe(baseline.manifestId);
  });

  it.each([
    ['trace fingerprint', (input: BuildCapabilityManifestInput) => { input.trace.fingerprintSha256 = SHA_B; }],
    ['bundled TP revision', (input: BuildCapabilityManifestInput) => {
      (input.traceProcessor as Extract<CapabilityManifestTraceProcessorIdentityV1, {source: 'bundled'}>).gitRevision = GIT_B;
    }],
  ])('changes content identity when %s changes', (_name, mutate) => {
    const baseline = buildCapabilityManifest(baseInput());
    const changedInput = baseInput();
    mutate(changedInput);
    const changed = buildCapabilityManifest(changedInput);

    expect(changed.contentHash).not.toBe(baseline.contentHash);
    expect(changed.manifestId).not.toBe(baseline.manifestId);
  });

  it('uses the shared canonical content hash exactly', () => {
    const manifest = buildCapabilityManifest(baseInput());
    expect(manifest.contentHash).toBe(canonicalContentHash(manifest.content));
    expect(manifest.manifestId).toBe(`capability_manifest:${manifest.contentHash}`);
    expect(capabilityManifestContentProjection(baseInput())).toEqual(manifest.content);
    expect(manifest).not.toHaveProperty('schemaVersion');
  });

  it.each([
    ['duplicate definition ID', (input: BuildCapabilityManifestInput) => {
      input.definitions.push({...input.definitions[0]});
    }, 'capability_manifest_duplicate_definition_id:frame_rendering'],
    ['duplicate result ID', (input: BuildCapabilityManifestInput) => {
      input.legacyProbe.available.push(
        legacyResult('frame_rendering', 'available', 'slice', 1),
      );
    }, 'capability_manifest_duplicate_result_id:frame_rendering'],
    ['unknown result ID', (input: BuildCapabilityManifestInput) => {
      input.legacyProbe.available.push(
        legacyResult('unknown', 'available', 'slice', 1),
      );
    }, 'capability_manifest_unknown_result_id:unknown'],
    ['missing result', (input: BuildCapabilityManifestInput) => {
      input.legacyProbe.missingConfig = input.legacyProbe.missingConfig
        .filter(result => result.id !== 'startup');
    }, 'capability_manifest_missing_result:startup'],
  ])('rejects %s deterministically', (_name, mutate, code) => {
    const input = baseInput();
    mutate(input);
    expectErrorCode(input, code);
  });

  it.each([
    ['available status', 'available', 'missing_config_suspected', 1],
    ['missing status', 'missingConfig', 'available', 0],
    ['insufficient status', 'insufficient', 'available', 1],
    ['not-applicable status', 'notApplicable', 'available', undefined],
  ] as const)('rejects %s mismatch', (_name, bucket, status, rowEstimate) => {
    const input = baseInput();
    input.legacyProbe.missingConfig = input.legacyProbe.missingConfig
      .filter(result => result.id !== 'frame_rendering');
    input.legacyProbe[bucket].push(
      legacyResult('frame_rendering', status, 'slice', rowEstimate),
    );
    expectErrorCode(
      input,
      `capability_manifest_bucket_status_mismatch:${bucket}:frame_rendering`,
    );
  });

  it.each([
    ['available zero', 'available', 0],
    ['available fraction', 'available', 1.5],
    ['available infinity', 'available', Number.POSITIVE_INFINITY],
    ['missing negative', 'missingConfig', -1],
    ['missing positive', 'missingConfig', 1],
    ['insufficient zero', 'insufficient', 0],
    ['not-applicable row', 'notApplicable', 0],
  ] as const)('rejects invalid row estimate: %s', (_name, bucket, rowEstimate) => {
    const input = baseInput();
    input.legacyProbe.missingConfig = input.legacyProbe.missingConfig
      .filter(result => result.id !== 'frame_rendering');
    const statuses = {
      available: 'available',
      missingConfig: 'missing_config_suspected',
      insufficient: 'insufficient_or_scene_absent',
      notApplicable: 'not_applicable',
    } as const;
    input.legacyProbe[bucket].push(
      legacyResult('frame_rendering', statuses[bucket], 'slice', rowEstimate),
    );
    expectErrorCode(
      input,
      `capability_manifest_invalid_row_estimate:${bucket}:frame_rendering`,
    );
  });

  it('rejects a primary-table mismatch', () => {
    const input = baseInput();
    input.legacyProbe.missingConfig[0].primaryTable = 'wrong_table';
    expectErrorCode(
      input,
      'capability_manifest_primary_table_mismatch:frame_rendering',
    );
  });

  it.each([
    ['empty ID', (input: BuildCapabilityManifestInput) => { input.definitions[0].id = ''; }, 'capability_manifest_empty_definition_id:0'],
    ['empty table', (input: BuildCapabilityManifestInput) => { input.definitions[0].primaryTable = ''; }, 'capability_manifest_empty_primary_table:frame_rendering'],
    ['empty module', (input: BuildCapabilityManifestInput) => { input.definitions[0].requiredModules = ['']; }, 'capability_manifest_empty_required_module:frame_rendering'],
    ['duplicate module', (input: BuildCapabilityManifestInput) => { input.definitions[0].requiredModules = ['android.frames', 'android.frames']; }, 'capability_manifest_duplicate_required_module:frame_rendering:android.frames'],
  ])('rejects invalid registry content: %s', (_name, mutate, code) => {
    const input = baseInput();
    mutate(input);
    expectErrorCode(input, code);
  });

  it.each([
    ['bundled malformed Git revision', {source: 'bundled', gitRevision: SHA_A}, 'capability_manifest_invalid_tp_git_revision'],
    ['bundled binary field', {source: 'bundled', gitRevision: GIT_A, binarySha256: SHA_A}, 'capability_manifest_tp_cross_kind_field:binarySha256'],
    ['custom malformed binary hash', {source: 'custom', binarySha256: GIT_A}, 'capability_manifest_invalid_tp_binary_sha256'],
    ['custom Git field', {source: 'custom', binarySha256: SHA_A, gitRevision: GIT_A}, 'capability_manifest_tp_cross_kind_field:gitRevision'],
    ['unknown Git field', {source: 'unknown', gitRevision: GIT_A}, 'capability_manifest_tp_cross_kind_field:gitRevision'],
    ['unknown binary field', {source: 'unknown', binarySha256: SHA_A}, 'capability_manifest_tp_cross_kind_field:binarySha256'],
    ['empty reported version', {source: 'unknown', reportedVersion: ''}, 'capability_manifest_invalid_tp_reported_version'],
    ['empty RPC API version', {source: 'unknown', rpcApiVersion: ''}, 'capability_manifest_invalid_tp_rpc_api_version'],
    ['malformed stdlib revision', {source: 'unknown', stdlibRevision: SHA_A}, 'capability_manifest_invalid_tp_stdlib_revision'],
    ['empty unavailable reason', {source: 'unknown', unavailableReason: ''}, 'capability_manifest_invalid_tp_unavailable_reason'],
  ])('rejects malformed trace processor identity: %s', (_name, identity, code) => {
    const input = baseInput();
    input.traceProcessor = identity as CapabilityManifestTraceProcessorIdentityV1;
    expectErrorCode(input, code);
  });

  it.each([
    ['fingerprint', (input: BuildCapabilityManifestInput) => { input.trace.fingerprintSha256 = GIT_A; }, 'capability_manifest_invalid_trace_fingerprint'],
    ['trace side', (input: BuildCapabilityManifestInput) => { (input.trace as {traceSide: string}).traceSide = 'baseline'; }, 'capability_manifest_invalid_trace_side'],
    ['zero API', (input: BuildCapabilityManifestInput) => { input.trace.androidApiLevel = 0; }, 'capability_manifest_invalid_android_api_level'],
    ['fractional API', (input: BuildCapabilityManifestInput) => { input.trace.androidApiLevel = 34.5; }, 'capability_manifest_invalid_android_api_level'],
    ['empty machine', (input: BuildCapabilityManifestInput) => { input.trace.machineId = ''; }, 'capability_manifest_invalid_machine_id'],
    ['leading-zero start', (input: BuildCapabilityManifestInput) => { input.trace.clockRangeNs = {startNs: '01', endNs: '2'}; }, 'capability_manifest_invalid_clock_value:startNs'],
    ['negative end', (input: BuildCapabilityManifestInput) => { input.trace.clockRangeNs = {startNs: '0', endNs: '-1'}; }, 'capability_manifest_invalid_clock_value:endNs'],
    ['reversed clock range', (input: BuildCapabilityManifestInput) => { input.trace.clockRangeNs = {startNs: '2', endNs: '1'}; }, 'capability_manifest_invalid_clock_range'],
  ])('rejects invalid trace identity: %s', (_name, mutate, code) => {
    const input = baseInput();
    mutate(input);
    expectErrorCode(input, code);
  });

  it.each([
    ['trace ID', (input: BuildCapabilityManifestInput) => { input.provenance.traceId = ''; }, 'capability_manifest_invalid_provenance_trace_id'],
    ['processor key', (input: BuildCapabilityManifestInput) => { input.provenance.processorKey = ''; }, 'capability_manifest_invalid_provenance_processor_key'],
    ['lease ID', (input: BuildCapabilityManifestInput) => { input.provenance.leaseId = ''; }, 'capability_manifest_invalid_provenance_lease_id'],
    ['RPC endpoint', (input: BuildCapabilityManifestInput) => { input.provenance.rpcEndpoint = ''; }, 'capability_manifest_invalid_provenance_rpc_endpoint'],
    ['diagnosed timestamp', (input: BuildCapabilityManifestInput) => { input.legacyProbe.diagnosedAt = -1; }, 'capability_manifest_invalid_diagnosed_at'],
    ['fractional diagnosed timestamp', (input: BuildCapabilityManifestInput) => { input.legacyProbe.diagnosedAt = 1.5; }, 'capability_manifest_invalid_diagnosed_at'],
    ['generated timestamp', (input: BuildCapabilityManifestInput) => { input.generatedAt = Number.NaN; }, 'capability_manifest_invalid_generated_at'],
    ['fractional generated timestamp', (input: BuildCapabilityManifestInput) => { input.generatedAt = 1.5; }, 'capability_manifest_invalid_generated_at'],
  ])('rejects invalid provenance: %s', (_name, mutate, code) => {
    const input = baseInput();
    mutate(input);
    expectErrorCode(input, code);
  });

  it('returns a snapshot isolated from later input mutation', () => {
    const input = baseInput();
    const manifest = buildCapabilityManifest(input);
    const before = JSON.stringify(manifest);

    input.definitions[0].displayName = 'Changed';
    input.definitions[0].requiredModules?.push('changed.module');
    input.legacyProbe.missingConfig[0].rowEstimate = undefined;
    input.trace.fingerprintSha256 = SHA_B;
    input.trace.clockRangeNs!.endNs = '999';
    (input.traceProcessor as {reportedVersion?: string}).reportedVersion = 'changed';
    input.provenance.traceId = 'changed';

    expect(JSON.stringify(manifest)).toBe(before);
  });

  it('deep-freezes the manifest and every nested collection/object', () => {
    const manifest = buildCapabilityManifest(baseInput());
    const first = manifest.content.capabilities[0];

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.content)).toBe(true);
    expect(Object.isFrozen(manifest.provenance)).toBe(true);
    expect(Object.isFrozen(manifest.content.capabilities)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.requiredModules)).toBe(true);
    expect(Object.isFrozen(manifest.content.traceProcessor)).toBe(true);
    expect(Object.isFrozen(manifest.content.trace)).toBe(true);
    expect(Object.isFrozen(manifest.content.trace.clockRangeNs)).toBe(true);
  });
});
