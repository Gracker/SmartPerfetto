// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  BuildCapabilityManifestInput,
  CapabilityManifestCapabilityDefinition,
  CapabilityManifestContentV1,
  CapabilityManifestEntryV1,
  CapabilityManifestLegacyProbeResult,
  CapabilityManifestAttributionResolutionV1,
  CapabilityManifestAttributionV1,
  CapabilityManifestProbeCacheObservationV1,
  CapabilityManifestResolutionV1,
  CapabilityManifestTraceProcessorIdentityV1,
  CapabilityManifestV1,
} from '../types/capabilityManifest';
import {
  CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
} from '../types/capabilityManifest';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './selfEvolution/canonicalJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const CLOCK_VALUE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SAFE_DETAIL_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TRACE_PROCESSOR_UNAVAILABLE_REASONS = new Set([
  'external_rpc_binary_unavailable',
  'trace_processor_binary_unavailable',
  'unsupported_platform',
  'trace_processor_pin_unavailable',
  'identity_resolution_failed',
]);
const ATTRIBUTION_UNAVAILABLE_REASONS = new Set([
  'external_rpc_trace_fingerprint_unavailable',
  'trace_source_unavailable',
  'trace_file_unavailable',
  'trace_hash_failed',
  'identity_resolution_failed',
]);
const ATTRIBUTION_DETAIL_CODES = new Set([
  'file_identity_changed',
  'file_too_large',
  'non_regular_file',
]);

type LegacyBucketName =
  | 'available'
  | 'missingConfig'
  | 'insufficient'
  | 'notApplicable';

interface IndexedLegacyResult {
  bucket: LegacyBucketName;
  result: CapabilityManifestLegacyProbeResult;
}

const LEGACY_BUCKET_NAMES: readonly LegacyBucketName[] = [
  'available',
  'missingConfig',
  'insufficient',
  'notApplicable',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInputEnvelope(
  input: unknown,
): asserts input is BuildCapabilityManifestInput {
  if (!isPlainObject(input)) {
    throw new Error('capability_manifest_invalid_input');
  }
  if (!Array.isArray(input.definitions)) {
    throw new Error('capability_manifest_invalid_definitions');
  }
  if (!isPlainObject(input.legacyProbe)) {
    throw new Error('capability_manifest_invalid_legacy_probe');
  }
  if (!isPlainObject(input.traceProcessor)) {
    throw new Error('capability_manifest_invalid_trace_processor');
  }
  if (!isPlainObject(input.trace)) {
    throw new Error('capability_manifest_invalid_trace');
  }
  if (!isPlainObject(input.provenance)) {
    throw new Error('capability_manifest_invalid_provenance');
  }
  for (const bucket of LEGACY_BUCKET_NAMES) {
    if (!Array.isArray(input.legacyProbe[bucket])) {
      throw new Error(`capability_manifest_invalid_bucket:${bucket}`);
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateDefinitions(
  definitions: CapabilityManifestCapabilityDefinition[],
): Map<string, CapabilityManifestCapabilityDefinition> {
  const byId = new Map<string, CapabilityManifestCapabilityDefinition>();
  for (const [index, candidate] of definitions.entries()) {
    if (!isPlainObject(candidate)) {
      throw new Error(`capability_manifest_invalid_definition:${index}`);
    }
    const definition =
      candidate as unknown as CapabilityManifestCapabilityDefinition;
    if (typeof definition.id !== 'string') {
      throw new Error(`capability_manifest_invalid_definition_id:${index}`);
    }
    if (definition.id.trim().length === 0) {
      throw new Error(`capability_manifest_empty_definition_id:${index}`);
    }
    if (byId.has(definition.id)) {
      throw new Error(
        `capability_manifest_duplicate_definition_id:${definition.id}`,
      );
    }
    if (!isNonEmptyString(definition.displayName)) {
      throw new Error(
        `capability_manifest_invalid_definition_display_name:${definition.id}`,
      );
    }
    if (typeof definition.primaryTable !== 'string') {
      throw new Error(
        `capability_manifest_invalid_definition_primary_table:${definition.id}`,
      );
    }
    if (definition.primaryTable.trim().length === 0) {
      throw new Error(
        `capability_manifest_empty_primary_table:${definition.id}`,
      );
    }

    if (
      definition.requiredModules !== undefined &&
      !Array.isArray(definition.requiredModules)
    ) {
      throw new Error(
        `capability_manifest_invalid_required_modules:${definition.id}`,
      );
    }
    const requiredModules = definition.requiredModules ?? [];
    const seenModules = new Set<string>();
    for (const [moduleIndex, moduleName] of requiredModules.entries()) {
      if (typeof moduleName !== 'string') {
        throw new Error(
          `capability_manifest_invalid_required_module:${definition.id}:${moduleIndex}`,
        );
      }
      if (moduleName.trim().length === 0) {
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
    if (
      typeof traceProcessor.gitRevision !== 'string' ||
      !GIT_REVISION_PATTERN.test(traceProcessor.gitRevision)
    ) {
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
    if (
      typeof traceProcessor.binarySha256 !== 'string' ||
      !SHA256_PATTERN.test(traceProcessor.binarySha256)
    ) {
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
    if (
      typeof traceProcessor.unavailableReason !== 'string' ||
      !TRACE_PROCESSOR_UNAVAILABLE_REASONS.has(
        traceProcessor.unavailableReason,
      )
    ) {
      throw new Error('capability_manifest_invalid_tp_unavailable_reason');
    }
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
    unavailableReason: traceProcessor.unavailableReason,
  };
}

function validateTrace(input: BuildCapabilityManifestInput): void {
  if (
    typeof input.trace.fingerprintSha256 !== 'string' ||
    !SHA256_PATTERN.test(input.trace.fingerprintSha256)
  ) {
    throw new Error('capability_manifest_invalid_trace_fingerprint');
  }
  if (input.trace.fingerprintKind !== 'trace_bytes_sha256') {
    throw new Error('capability_manifest_invalid_trace_fingerprint_kind');
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
  if (!isPlainObject(clockRange)) {
    throw new Error('capability_manifest_invalid_clock_range');
  }
  if (
    typeof clockRange.startNs !== 'string' ||
    !CLOCK_VALUE_PATTERN.test(clockRange.startNs)
  ) {
    throw new Error('capability_manifest_invalid_clock_value:startNs');
  }
  if (
    typeof clockRange.endNs !== 'string' ||
    !CLOCK_VALUE_PATTERN.test(clockRange.endNs)
  ) {
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

function validateLegacyResultShape(
  bucket: LegacyBucketName,
  index: number,
  candidate: unknown,
): asserts candidate is CapabilityManifestLegacyProbeResult {
  if (!isPlainObject(candidate)) {
    throw new Error(`capability_manifest_invalid_result:${bucket}:${index}`);
  }
  if (!isNonEmptyString(candidate.id)) {
    throw new Error(
      `capability_manifest_invalid_result_id:${bucket}:${index}`,
    );
  }
  if (!isNonEmptyString(candidate.displayName)) {
    throw new Error(
      `capability_manifest_invalid_result_display_name:${bucket}:${index}`,
    );
  }
  if (typeof candidate.primaryTable !== 'string') {
    throw new Error(
      `capability_manifest_invalid_result_primary_table:${bucket}:${index}`,
    );
  }
  if (
    candidate.reason !== undefined &&
    !isNonEmptyString(candidate.reason)
  ) {
    throw new Error(
      `capability_manifest_invalid_result_reason:${bucket}:${candidate.id}`,
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
    for (const [resultIndex, candidate] of results.entries()) {
      validateLegacyResultShape(bucket, resultIndex, candidate);
      const result = candidate;
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
  validateInputEnvelope(input);
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
    fingerprintKind: input.trace.fingerprintKind,
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

function projectAttributionTraceProcessor(
  traceProcessor: CapabilityManifestTraceProcessorIdentityV1,
): CapabilityManifestTraceProcessorIdentityV1 {
  if (traceProcessor.source === 'bundled') {
    if (!GIT_REVISION_PATTERN.test(traceProcessor.gitRevision)) {
      throw new Error('capability_manifest_attribution_invalid_processor');
    }
    return {source: 'bundled', gitRevision: traceProcessor.gitRevision};
  }
  if (traceProcessor.source === 'custom') {
    if (!SHA256_PATTERN.test(traceProcessor.binarySha256)) {
      throw new Error('capability_manifest_attribution_invalid_processor');
    }
    return {source: 'custom', binarySha256: traceProcessor.binarySha256};
  }
  if (!TRACE_PROCESSOR_UNAVAILABLE_REASONS.has(
    traceProcessor.unavailableReason,
  )) {
    throw new Error('capability_manifest_attribution_invalid_processor');
  }
  return {
    source: 'unknown',
    unavailableReason: traceProcessor.unavailableReason,
  };
}

function projectAttributionResolution(
  resolution: CapabilityManifestResolutionV1,
): CapabilityManifestAttributionResolutionV1 {
  if (resolution.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: resolution.reason,
      ...(resolution.detailCode !== undefined &&
      SAFE_DETAIL_CODE.test(resolution.detailCode)
        ? {detailCode: resolution.detailCode}
        : {}),
    };
  }
  if (resolution.status === 'failed') {
    return {status: 'failed', reason: resolution.reason};
  }

  const {manifest} = resolution;
  let projectedContentHash: string;
  try {
    projectedContentHash = canonicalContentHash(manifest.content);
  } catch {
    throw new Error('capability_manifest_attribution_invalid_ready_resolution');
  }
  if (
    manifest.content.schemaVersion !== CAPABILITY_MANIFEST_SCHEMA_VERSION ||
    !SHA256_PATTERN.test(manifest.contentHash) ||
    projectedContentHash !== manifest.contentHash ||
    manifest.manifestId !== `capability_manifest:${manifest.contentHash}` ||
    !SHA256_PATTERN.test(manifest.content.trace.fingerprintSha256)
  ) {
    throw new Error('capability_manifest_attribution_invalid_ready_resolution');
  }
  return {
    status: 'ready',
    manifestId: manifest.manifestId,
    contentHash: manifest.contentHash,
    manifestSchemaVersion: manifest.content.schemaVersion,
    traceFingerprintSha256: manifest.content.trace.fingerprintSha256,
    traceProcessor: projectAttributionTraceProcessor(
      manifest.content.traceProcessor,
    ),
  };
}

export function projectCapabilityManifestAttribution(
  resolution: CapabilityManifestResolutionV1,
  probeCache: CapabilityManifestProbeCacheObservationV1,
): CapabilityManifestAttributionV1 {
  if (
    probeCache.outcome !== 'hit' &&
    probeCache.outcome !== 'miss' &&
    probeCache.outcome !== 'bypass'
  ) {
    throw new Error('capability_manifest_attribution_invalid_cache_outcome');
  }
  if (
    probeCache.keyHash !== undefined &&
    !SHA256_PATTERN.test(probeCache.keyHash)
  ) {
    throw new Error('capability_manifest_attribution_invalid_cache_key');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION,
    resolution: projectAttributionResolution(resolution),
    probeCache: {
      ...(probeCache.keyHash === undefined
        ? {}
        : {keyHash: probeCache.keyHash}),
      hits: probeCache.outcome === 'hit' ? 1 : 0,
      misses: probeCache.outcome === 'miss' ? 1 : 0,
      bypasses: probeCache.outcome === 'bypass' ? 1 : 0,
    },
  });
}

function sanitizeStoredTraceProcessorIdentity(
  value: unknown,
): CapabilityManifestTraceProcessorIdentityV1 | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.source === 'bundled') {
    if (
      typeof value.gitRevision !== 'string' ||
      !GIT_REVISION_PATTERN.test(value.gitRevision)
    ) {
      return undefined;
    }
    return {
      source: 'bundled',
      gitRevision: value.gitRevision,
    };
  }
  if (value.source === 'custom') {
    if (
      typeof value.binarySha256 !== 'string' ||
      !SHA256_PATTERN.test(value.binarySha256)
    ) {
      return undefined;
    }
    return {
      source: 'custom',
      binarySha256: value.binarySha256,
    };
  }
  if (
    value.source !== 'unknown' ||
    typeof value.unavailableReason !== 'string' ||
    !TRACE_PROCESSOR_UNAVAILABLE_REASONS.has(value.unavailableReason)
  ) {
    return undefined;
  }
  return {
    source: 'unknown',
    unavailableReason:
      value.unavailableReason as Extract<
        CapabilityManifestTraceProcessorIdentityV1,
        {source: 'unknown'}
      >['unavailableReason'],
  };
}

function sanitizeStoredAttributionResolution(
  value: unknown,
): CapabilityManifestAttributionResolutionV1 | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.status === 'ready') {
    if (
      typeof value.contentHash !== 'string' ||
      !SHA256_PATTERN.test(value.contentHash) ||
      value.manifestId !== `capability_manifest:${value.contentHash}` ||
      value.manifestSchemaVersion !== CAPABILITY_MANIFEST_SCHEMA_VERSION ||
      typeof value.traceFingerprintSha256 !== 'string' ||
      !SHA256_PATTERN.test(value.traceFingerprintSha256)
    ) {
      return undefined;
    }
    const traceProcessor = sanitizeStoredTraceProcessorIdentity(
      value.traceProcessor,
    );
    if (!traceProcessor) return undefined;
    return {
      status: 'ready',
      manifestId: value.manifestId,
      contentHash: value.contentHash,
      manifestSchemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
      traceFingerprintSha256: value.traceFingerprintSha256,
      traceProcessor,
    };
  }
  if (value.status === 'unavailable') {
    if (
      typeof value.reason !== 'string' ||
      !ATTRIBUTION_UNAVAILABLE_REASONS.has(value.reason)
    ) {
      return undefined;
    }
    return {
      status: 'unavailable',
      reason: value.reason as Extract<
        CapabilityManifestAttributionResolutionV1,
        {status: 'unavailable'}
      >['reason'],
      ...(typeof value.detailCode === 'string' &&
      ATTRIBUTION_DETAIL_CODES.has(value.detailCode)
        ? {detailCode: value.detailCode}
        : {}),
    };
  }
  return value.status === 'failed' &&
    value.reason === 'capability_manifest_build_failed'
    ? {status: 'failed', reason: 'capability_manifest_build_failed'}
    : undefined;
}

/**
 * Rebuild attribution loaded from any durable or cross-surface boundary.
 * Unknown fields are deliberately omitted and invalid known fields fail closed.
 */
export function sanitizeStoredCapabilityManifestAttribution(
  value: unknown,
): CapabilityManifestAttributionV1 | undefined {
  try {
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION ||
      !isPlainObject(value.probeCache)
    ) {
      return undefined;
    }
    const resolution = sanitizeStoredAttributionResolution(value.resolution);
    if (!resolution) return undefined;
    const {hits, misses, bypasses, keyHash} = value.probeCache;
    if (
      !isNonNegativeSafeInteger(hits) ||
      !isNonNegativeSafeInteger(misses) ||
      !isNonNegativeSafeInteger(bypasses) ||
      (keyHash !== undefined &&
        (typeof keyHash !== 'string' || !SHA256_PATTERN.test(keyHash)))
    ) {
      return undefined;
    }
    return immutableCanonicalSnapshot({
      schemaVersion: CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION,
      resolution,
      probeCache: {
        ...(typeof keyHash === 'string' ? {keyHash} : {}),
        hits,
        misses,
        bypasses,
      },
    });
  } catch {
    return undefined;
  }
}
