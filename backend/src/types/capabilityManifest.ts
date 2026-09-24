// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const CAPABILITY_MANIFEST_SCHEMA_VERSION =
  'capability_manifest@1' as const;
export const CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION =
  'capability_manifest_attribution@1' as const;

export type CapabilityManifestStatus =
  | 'available'
  | 'missing'
  | 'insufficient'
  | 'not_applicable';

export type CapabilitySourceState =
  | 'present_with_data'
  | 'present_empty'
  | 'schema_missing'
  | 'not_applicable'
  /** The probe could not determine the source: a module or query did not finish. */
  | 'unprobed';

/**
 * Reason codes for a capability the probe could not determine. They ride in the
 * legacy `missingConfig` bucket and map to status `missing`, but never claim
 * the schema or the data is absent.
 */
export const CAPABILITY_UNPROBED_REASON_CODES = [
  'probe_module_unavailable',
  'probe_query_failed',
] as const;

export type CapabilityUnprobedReasonCode =
  typeof CAPABILITY_UNPROBED_REASON_CODES[number];

export function isCapabilityUnprobedReasonCode(
  code: unknown,
): code is CapabilityUnprobedReasonCode {
  return (CAPABILITY_UNPROBED_REASON_CODES as readonly unknown[]).includes(code);
}

export type CapabilityReasonCode =
  | 'schema_missing'
  | 'empty_or_scene_absent'
  | 'sparse_or_scene_absent'
  | 'not_applicable'
  | CapabilityUnprobedReasonCode;

export interface CapabilityManifestCapabilityDefinition {
  id: string;
  displayName: string;
  primaryTable: string;
  requiredModules?: string[];
  /**
   * Bounded count query used instead of the `primaryTable` row count. A single
   * SELECT returning one integer. It is part of the definition identity because
   * one capability can be rewritten to count something else — a different track
   * type, a different threshold — while keeping its id, displayName and
   * primaryTable. Two manifests are comparable only if they agree on what was
   * counted, so the content hash has to carry the query itself.
   */
  probeSql?: string;
}

export interface CapabilityManifestLegacyProbeResult {
  id: string;
  displayName: string;
  status:
    | 'available'
    | 'missing_config_suspected'
    | 'not_applicable'
    | 'insufficient_or_scene_absent';
  primaryTable: string;
  rowEstimate?: number;
  /**
   * Only on a `missingConfig` result the probe could not determine; routine
   * causes are derived from the bucket and `rowEstimate`.
   */
  reasonCode?: CapabilityUnprobedReasonCode;
  reason?: string;
}

export interface CapabilityManifestLegacyProbeInput {
  available: CapabilityManifestLegacyProbeResult[];
  missingConfig: CapabilityManifestLegacyProbeResult[];
  notApplicable: CapabilityManifestLegacyProbeResult[];
  insufficient: CapabilityManifestLegacyProbeResult[];
  diagnosedAt: number;
}

export type CapabilityManifestTraceProcessorUnavailableReason =
  | 'external_rpc_binary_unavailable'
  | 'trace_processor_binary_unavailable'
  | 'unsupported_platform'
  | 'trace_processor_pin_unavailable'
  | 'identity_resolution_failed';

export type CapabilityManifestTraceProcessorIdentityV1 =
  | {
      source: 'bundled';
      gitRevision: string;
      reportedVersion?: string;
      rpcApiVersion?: string;
      stdlibRevision?: string;
    }
  | {
      source: 'custom';
      binarySha256: string;
      reportedVersion?: string;
      rpcApiVersion?: string;
      stdlibRevision?: string;
    }
  | {
      source: 'unknown';
      reportedVersion?: string;
      rpcApiVersion?: string;
      stdlibRevision?: string;
      unavailableReason: CapabilityManifestTraceProcessorUnavailableReason;
    };

export interface CapabilityManifestEntryV1 {
  id: string;
  displayName: string;
  primaryTable: string;
  requiredModules?: string[];
  probeSql?: string;
  status: CapabilityManifestStatus;
  sourceState: CapabilitySourceState;
  reasonCode?: CapabilityReasonCode;
  rowEstimate?: number;
}

export interface CapabilityManifestTraceContentIdentityV1 {
  fingerprintSha256: string;
  fingerprintKind: 'trace_bytes_sha256';
  traceSide: 'current' | 'reference';
  androidApiLevel?: number;
  machineId?: string;
  clockRangeNs?: {
    startNs: string;
    endNs: string;
  };
}

export interface CapabilityManifestContentV1 {
  schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  traceProcessor: CapabilityManifestTraceProcessorIdentityV1;
  trace: CapabilityManifestTraceContentIdentityV1;
  capabilities: CapabilityManifestEntryV1[];
}

export interface CapabilityManifestProvenanceV1 {
  traceId: string;
  processorKey?: string;
  leaseId?: string;
  rpcEndpoint?: string;
  diagnosedAt: number;
  generatedAt: number;
}

export interface CapabilityManifestV1 {
  content: CapabilityManifestContentV1;
  provenance: CapabilityManifestProvenanceV1;
  manifestId: string;
  contentHash: string;
}

export type CapabilityManifestResolutionV1 =
  | {status: 'ready'; manifest: CapabilityManifestV1}
  | {
      status: 'unavailable';
      reason:
        | 'external_rpc_trace_fingerprint_unavailable'
        | 'trace_source_unavailable'
        | 'trace_file_unavailable'
        | 'trace_hash_failed'
        | 'identity_resolution_failed';
      detailCode?: string;
    }
  | {status: 'failed'; reason: 'capability_manifest_build_failed'};

export type CapabilityManifestProbeCacheOutcome = 'hit' | 'miss' | 'bypass';

export interface CapabilityManifestProbeCacheObservationV1 {
  outcome: CapabilityManifestProbeCacheOutcome;
  keyHash?: string;
}

export interface CapabilityManifestProbeCacheCountersV1 {
  keyHash?: string;
  hits: number;
  misses: number;
  bypasses: number;
}

export type CapabilityManifestAttributionResolutionV1 =
  | {
      status: 'ready';
      manifestId: string;
      contentHash: string;
      manifestSchemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
      traceFingerprintSha256: string;
      traceProcessor: CapabilityManifestTraceProcessorIdentityV1;
    }
  | Extract<CapabilityManifestResolutionV1, {status: 'unavailable'}>
  | Extract<CapabilityManifestResolutionV1, {status: 'failed'}>;

export interface CapabilityManifestAttributionV1 {
  schemaVersion: typeof CAPABILITY_MANIFEST_ATTRIBUTION_SCHEMA_VERSION;
  resolution: CapabilityManifestAttributionResolutionV1;
  probeCache: CapabilityManifestProbeCacheCountersV1;
}

export interface BuildCapabilityManifestInput {
  definitions: CapabilityManifestCapabilityDefinition[];
  legacyProbe: CapabilityManifestLegacyProbeInput;
  traceProcessor: CapabilityManifestTraceProcessorIdentityV1;
  trace: CapabilityManifestTraceContentIdentityV1;
  provenance: Pick<
    CapabilityManifestProvenanceV1,
    'traceId' | 'processorKey' | 'leaseId' | 'rpcEndpoint'
  >;
  generatedAt: number;
}
