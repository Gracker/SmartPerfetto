// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {userDataPath} from '../../runtimePaths';
import type {ApplicationBuildIdentity} from '../applicationUpdate/types';
import type {
  LastReconciledBuildIdentityRecordV1,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {atomicWriteFileSync} from '../../utils/atomicFileWriter';

const DISTRIBUTIONS = new Set(['source', 'docker', 'portable', 'npm']);
const CHANNELS = new Set(['stable', 'nightly']);
const SIGNING_MODES = new Set([
  'source-checkout',
  'container',
  'npm-registry',
  'unsigned',
  'macos-adhoc',
  'macos-developer-id',
  'macos-developer-id-notarized',
]);
const GIT_COMMIT = /^[a-f0-9]{40}$/i;

const RECORD_KEYS = new Set([
  'schemaVersion',
  'lastReconciledBuildIdentity',
  'reconciledAt',
]);
const IDENTITY_KEYS = new Set([
  'distribution',
  'channel',
  'version',
  'commit',
  'target',
  'signingMode',
]);
const TARGET_KEYS = new Set(['os', 'arch', 'id']);

export interface BuildIdentityStoreOptions {
  filePath?: string;
}

export interface SaveBuildIdentityStoreOptions extends BuildIdentityStoreOptions {
  persistence: SelfEvolutionPersistenceCapability;
  reconciledAt?: string;
}

function defaultFilePath(): string {
  return userDataPath(
    'self_improve',
    'reconciliation',
    'last_reconciled_build_identity.json',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildIdentityValidationError(
  identity: ApplicationBuildIdentity,
): 'missing_build_commit' | 'invalid_build_commit' | null {
  if (identity.commit !== undefined && !GIT_COMMIT.test(identity.commit)) {
    return 'invalid_build_commit';
  }
  if (
    (identity.distribution === 'source' || identity.channel === 'nightly') &&
    !identity.commit
  ) {
    return 'missing_build_commit';
  }
  return null;
}

function isBuildIdentity(value: unknown): value is ApplicationBuildIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, IDENTITY_KEYS)) return false;
  if (
    typeof value.distribution !== 'string' ||
    !DISTRIBUTIONS.has(value.distribution)
  ) return false;
  if (typeof value.channel !== 'string' || !CHANNELS.has(value.channel)) return false;
  if (
    typeof value.signingMode !== 'string' ||
    !SIGNING_MODES.has(value.signingMode)
  ) return false;
  if (!isNonEmptyString(value.version)) return false;
  if (value.commit !== undefined && !isNonEmptyString(value.commit)) return false;
  if (!isRecord(value.target) || !hasOnlyKeys(value.target, TARGET_KEYS)) return false;
  if (!isNonEmptyString(value.target.os) || !isNonEmptyString(value.target.arch)) {
    return false;
  }
  if (value.target.id !== undefined && !isNonEmptyString(value.target.id)) {
    return false;
  }
  return buildIdentityValidationError(
    value as unknown as ApplicationBuildIdentity,
  ) === null;
}

function parseRecord(value: unknown): LastReconciledBuildIdentityRecordV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) {
    throw new Error('invalid_last_reconciled_build_identity_record');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('unsupported_last_reconciled_build_identity_schema');
  }
  if (!isBuildIdentity(value.lastReconciledBuildIdentity)) {
    throw new Error('invalid_last_reconciled_build_identity');
  }
  if (
    !isNonEmptyString(value.reconciledAt) ||
    !Number.isFinite(Date.parse(value.reconciledAt)) ||
    new Date(value.reconciledAt).toISOString() !== value.reconciledAt
  ) {
    throw new Error('invalid_last_reconciled_build_identity_timestamp');
  }
  return value as unknown as LastReconciledBuildIdentityRecordV1;
}

export function loadLastReconciledBuildIdentity(
  options: BuildIdentityStoreOptions = {},
): LastReconciledBuildIdentityRecordV1 | null {
  const filePath = options.filePath ?? defaultFilePath();
  if (!fs.existsSync(filePath)) return null;
  return parseRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function saveLastReconciledBuildIdentity(
  identity: ApplicationBuildIdentity,
  options: SaveBuildIdentityStoreOptions,
): LastReconciledBuildIdentityRecordV1 {
  if (options.persistence.persistence !== 'available') {
    throw new Error('self_evolution_persistence_unavailable');
  }
  const record = parseRecord({
    schemaVersion: 1,
    lastReconciledBuildIdentity: identity,
    reconciledAt: options.reconciledAt ?? new Date().toISOString(),
  });
  const filePath = options.filePath ?? defaultFilePath();
  fs.mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
  atomicWriteFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
