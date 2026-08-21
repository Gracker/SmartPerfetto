// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  BuildCapabilityManifestInput,
  CapabilityManifestCapabilityDefinition,
  CapabilityManifestContentV1,
  CapabilityManifestEntryV1,
  CapabilityManifestLegacyProbeResult,
  CapabilityManifestTraceProcessorIdentityV1,
  CapabilityManifestV1,
} from '../types/capabilityManifest';
import {CAPABILITY_MANIFEST_SCHEMA_VERSION} from '../types/capabilityManifest';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './selfEvolution/canonicalJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const CLOCK_VALUE_PATTERN = /^(?:0|[1-9][0-9]*)$/;

type LegacyBucketName =
  | 'available'
  | 'missingConfig'
  | 'insufficient'
  | 'notApplicable';

interface IndexedLegacyResult {
  bucket: LegacyBucketName;
  result: CapabilityManifestLegacyProbeResult;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateDefinitions(
  definitions: CapabilityManifestCapabilityDefinition[],
): Map<string, CapabilityManifestCapabilityDefinition> {
  const byId = new Map<string, CapabilityManifestCapabilityDefinition>();
  for (const [index, definition] of definitions.entries()) {
    if (!isNonEmptyString(definition.id)) {
      throw new Error(`capability_manifest_empty_definition_id:${index}`);
    }
    if (byId.has(definition.id)) {
      throw new Error(
        `capability_manifest_duplicate_definition_id:${definition.id}`,
      );
    }
    if (!isNonEmptyString(definition.primaryTable)) {
      throw new Error(
        `capability_manifest_empty_primary_table:${definition.id}`,
      );
    }

    const requiredModules = definition.requiredModules ?? [];
    const seenModules = new Set<string>();
    for (const moduleName of requiredModules) {
      if (!isNonEmptyString(moduleName)) {
        throw new Error(
          `capability_manifest_empty_required_module:${definition.id}`,
        );
      }
      if (seenModules.has(moduleName)) {
        throw new Error(
          `capability_manifest_duplicate_required_module:${definition.id}:${moduleName}`,
        );
      }
      seenModules.add(moduleName);
    }
    byId.set(definition.id, definition);
  }
  return byId;
}

function validateOptionalString(value: unknown, errorCode: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new Error(errorCode);
  }
}

function validateTraceProcessor(
  traceProcessor: BuildCapabilityManifestInput['traceProcessor'],
): void {
  const fields = traceProcessor as unknown as Record<string, unknown>;
  validateOptionalString(
    fields.reportedVersion,
    'capability_manifest_invalid_tp_reported_version',
  );
  validateOptionalString(
    fields.rpcApiVersion,
    'capability_manifest_invalid_tp_rpc_api_version',
  );
  if (
    fields.stdlibRevision !== undefined &&
    (
      typeof fields.stdlibRevision !== 'string' ||
      !GIT_REVISION_PATTERN.test(fields.stdlibRevision)
    )
  ) {
    throw new Error('capability_manifest_invalid_tp_stdlib_revision');
  }

  if (traceProcessor.source === 'bundled') {
    if ('binarySha256' in fields) {
      throw new Error(
        'capability_manifest_tp_cross_kind_field:binarySha256',
      );
    }
    if ('unavailableReason' in fields) {
      throw new Error(
        'capability_manifest_tp_cross_kind_field:unavailableReason',
      );
    }
    if (!GIT_REVISION_PATTERN.test(traceProcessor.gitRevision)) {
      throw new Error('capability_manifest_invalid_tp_git_revision');
    }
    return;
  }

  if (traceProcessor.source === 'custom') {
    if ('gitRevision' in fields) {
      throw new Error('capability_manifest_tp_cross_kind_field:gitRevision');
    }
    if ('unavailableReason' in fields) {
      throw new Error(
        'capability_manifest_tp_cross_kind_field:unavailableReason',
      );
    }
    if (!SHA256_PATTERN.test(traceProcessor.binarySha256)) {
      throw new Error('capability_manifest_invalid_tp_binary_sha256');
    }
    return;
  }

  if (traceProcessor.source === 'unknown') {
    if ('gitRevision' in fields) {
      throw new Error('capability_manifest_tp_cross_kind_field:gitRevision');
    }
    if ('binarySha256' in fields) {
      throw new Error(
        'capability_manifest_tp_cross_kind_field:binarySha256',
      );
    }
    validateOptionalString(
      traceProcessor.unavailableReason,
      'capability_manifest_invalid_tp_unavailable_reason',
    );
    return;
  }

  throw new Error('capability_manifest_invalid_tp_source');
}

function projectTraceProcessor(
  traceProcessor: BuildCapabilityManifestInput['traceProcessor'],
): CapabilityManifestTraceProcessorIdentityV1 {
  const common = {
    ...(traceProcessor.reportedVersion === undefined
      ? {}
      : {reportedVersion: traceProcessor.reportedVersion}),
    ...(traceProcessor.rpcApiVersion === undefined
      ? {}
      : {rpcApiVersion: traceProcessor.rpcApiVersion}),
    ...(traceProcessor.stdlibRevision === undefined
      ? {}
      : {stdlibRevision: traceProcessor.stdlibRevision}),
  };
  if (traceProcessor.source === 'bundled') {
    return {
      source: 'bundled',
      gitRevision: traceProcessor.gitRevision,
      ...common,
    };
  }
  if (traceProcessor.source === 'custom') {
    return {
      source: 'custom',
      binarySha256: traceProcessor.binarySha256,
      ...common,
    };
  }
  return {
    source: 'unknown',
    ...common,
    ...(traceProcessor.unavailableReason === undefined
      ? {}
      : {unavailableReason: traceProcessor.unavailableReason}),
  };
}

function validateTrace(input: BuildCapabilityManifestInput): void {
  if (!SHA256_PATTERN.test(input.trace.fingerprintSha256)) {
    throw new Error('capability_manifest_invalid_trace_fingerprint');
  }
  if (
    input.trace.traceSide !== 'current' &&
    input.trace.traceSide !== 'reference'
  ) {
    throw new Error('capability_manifest_invalid_trace_side');
  }
  if (
    input.trace.androidApiLevel !== undefined &&
    (
      !Number.isInteger(input.trace.androidApiLevel) ||
      input.trace.androidApiLevel <= 0
    )
  ) {
    throw new Error('capability_manifest_invalid_android_api_level');
  }
  validateOptionalString(
    input.trace.machineId,
    'capability_manifest_invalid_machine_id',
  );

  const clockRange = input.trace.clockRangeNs;
  if (clockRange === undefined) {
    return;
  }
  if (!CLOCK_VALUE_PATTERN.test(clockRange.startNs)) {
    throw new Error('capability_manifest_invalid_clock_value:startNs');
  }
  if (!CLOCK_VALUE_PATTERN.test(clockRange.endNs)) {
    throw new Error('capability_manifest_invalid_clock_value:endNs');
  }
  if (BigInt(clockRange.startNs) > BigInt(clockRange.endNs)) {
    throw new Error('capability_manifest_invalid_clock_range');
  }
}

function validateTimestamp(value: number, errorCode: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(errorCode);
  }
}

function validateProvenance(input: BuildCapabilityManifestInput): void {
  if (!isNonEmptyString(input.provenance.traceId)) {
    throw new Error('capability_manifest_invalid_provenance_trace_id');
  }
  validateOptionalString(
    input.provenance.processorKey,
    'capability_manifest_invalid_provenance_processor_key',
  );
  validateOptionalString(
    input.provenance.leaseId,
    'capability_manifest_invalid_provenance_lease_id',
  );
  validateOptionalString(
    input.provenance.rpcEndpoint,
    'capability_manifest_invalid_provenance_rpc_endpoint',
  );
  validateTimestamp(
    input.legacyProbe.diagnosedAt,
    'capability_manifest_invalid_diagnosed_at',
  );
  validateTimestamp(
    input.generatedAt,
    'capability_manifest_invalid_generated_at',
  );
}

function validateBucketResult(
  bucket: LegacyBucketName,
  result: CapabilityManifestLegacyProbeResult,
  definition: CapabilityManifestCapabilityDefinition,
): void {
  const expectedStatus = {
    available: 'available',
    missingConfig: 'missing_config_suspected',
    insufficient: 'insufficient_or_scene_absent',
    notApplicable: 'not_applicable',
  } as const;
  if (result.status !== expectedStatus[bucket]) {
    throw new Error(
      `capability_manifest_bucket_status_mismatch:${bucket}:${result.id}`,
    );
  }
  if (result.primaryTable !== definition.primaryTable) {
    throw new Error(`capability_manifest_primary_table_mismatch:${result.id}`);
  }

  const rowEstimate = result.rowEstimate;
  const validPositiveInteger =
    Number.isFinite(rowEstimate) &&
    Number.isInteger(rowEstimate) &&
    (rowEstimate as number) > 0;
  const valid =
    bucket === 'available' || bucket === 'insufficient'
      ? validPositiveInteger
      : bucket === 'missingConfig'
        ? rowEstimate === undefined || rowEstimate === 0
        : rowEstimate === undefined;
  if (!valid) {
    throw new Error(
      `capability_manifest_invalid_row_estimate:${bucket}:${result.id}`,
    );
  }
}

function indexLegacyResults(
  input: BuildCapabilityManifestInput,
  definitionsById: Map<string, CapabilityManifestCapabilityDefinition>,
): Map<string, IndexedLegacyResult> {
  const indexed = new Map<string, IndexedLegacyResult>();
  const buckets: Array<[
    LegacyBucketName,
    CapabilityManifestLegacyProbeResult[],
  ]> = [
    ['available', input.legacyProbe.available],
    ['missingConfig', input.legacyProbe.missingConfig],
    ['insufficient', input.legacyProbe.insufficient],
    ['notApplicable', input.legacyProbe.notApplicable],
  ];

  for (const [bucket, results] of buckets) {
    for (const result of results) {
      if (indexed.has(result.id)) {
        throw new Error(`capability_manifest_duplicate_result_id:${result.id}`);
      }
      const definition = definitionsById.get(result.id);
      if (!definition) {
        throw new Error(`capability_manifest_unknown_result_id:${result.id}`);
      }
      validateBucketResult(bucket, result, definition);
      indexed.set(result.id, {bucket, result});
    }
  }
  return indexed;
}

function mapEntry(
  definition: CapabilityManifestCapabilityDefinition,
  indexed: IndexedLegacyResult,
): CapabilityManifestEntryV1 {
  const shared = {
    id: definition.id,
    displayName: definition.displayName,
    primaryTable: definition.primaryTable,
    ...(definition.requiredModules === undefined
      ? {}
      : {requiredModules: [...definition.requiredModules]}),
  };
  if (indexed.bucket === 'available') {
    return {
      ...shared,
      status: 'available',
      sourceState: 'present_with_data',
      rowEstimate: indexed.result.rowEstimate,
    };
  }
  if (indexed.bucket === 'missingConfig') {
    return indexed.result.rowEstimate === 0
      ? {
          ...shared,
          status: 'insufficient',
          sourceState: 'present_empty',
          reasonCode: 'empty_or_scene_absent',
          rowEstimate: 0,
        }
      : {
          ...shared,
          status: 'missing',
          sourceState: 'schema_missing',
          reasonCode: 'schema_missing',
        };
  }
  if (indexed.bucket === 'insufficient') {
    return {
      ...shared,
      status: 'insufficient',
      sourceState: 'present_with_data',
      reasonCode: 'sparse_or_scene_absent',
      rowEstimate: indexed.result.rowEstimate,
    };
  }
  return {
    ...shared,
    status: 'not_applicable',
    sourceState: 'not_applicable',
    reasonCode: 'not_applicable',
  };
}

export function capabilityManifestContentProjection(
  input: BuildCapabilityManifestInput,
): CapabilityManifestContentV1 {
  const definitionsById = validateDefinitions(input.definitions);
  validateTraceProcessor(input.traceProcessor);
  validateTrace(input);
  validateProvenance(input);
  const legacyResults = indexLegacyResults(input, definitionsById);
  const capabilities = input.definitions.map(definition => {
    const indexed = legacyResults.get(definition.id);
    if (!indexed) {
      throw new Error(`capability_manifest_missing_result:${definition.id}`);
    }
    return mapEntry(definition, indexed);
  });

  const traceProcessor = projectTraceProcessor(input.traceProcessor);
  const trace = {
    fingerprintSha256: input.trace.fingerprintSha256,
    traceSide: input.trace.traceSide,
    ...(input.trace.androidApiLevel === undefined
      ? {}
      : {androidApiLevel: input.trace.androidApiLevel}),
    ...(input.trace.machineId === undefined
      ? {}
      : {machineId: input.trace.machineId}),
    ...(input.trace.clockRangeNs === undefined
      ? {}
      : {clockRangeNs: {...input.trace.clockRangeNs}}),
  };
  return immutableCanonicalSnapshot({
    schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    traceProcessor,
    trace,
    capabilities,
  });
}

export function buildCapabilityManifest(
  input: BuildCapabilityManifestInput,
): CapabilityManifestV1 {
  const content = capabilityManifestContentProjection(input);
  const contentHash = canonicalContentHash(content);
  const provenance = {
    traceId: input.provenance.traceId,
    ...(input.provenance.processorKey === undefined
      ? {}
      : {processorKey: input.provenance.processorKey}),
    ...(input.provenance.leaseId === undefined
      ? {}
      : {leaseId: input.provenance.leaseId}),
    ...(input.provenance.rpcEndpoint === undefined
      ? {}
      : {rpcEndpoint: input.provenance.rpcEndpoint}),
    diagnosedAt: input.legacyProbe.diagnosedAt,
    generatedAt: input.generatedAt,
  };
  return immutableCanonicalSnapshot({
    content,
    provenance,
    manifestId: `capability_manifest:${contentHash}`,
    contentHash,
  });
}
