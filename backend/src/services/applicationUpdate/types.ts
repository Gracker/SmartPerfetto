// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ApplicationDistribution = 'source' | 'docker' | 'portable' | 'npm';
export type ApplicationUpdateChannel = 'stable' | 'nightly';
export type ApplicationSigningMode =
  | 'source-checkout'
  | 'container'
  | 'npm-registry'
  | 'unsigned'
  | 'macos-adhoc'
  | 'macos-developer-id'
  | 'macos-developer-id-notarized';

export interface ApplicationBuildTarget {
  os: string;
  arch: string;
  id?: string;
}

export interface ApplicationBuildIdentity {
  distribution: ApplicationDistribution;
  channel: ApplicationUpdateChannel;
  version: string;
  commit?: string;
  target: ApplicationBuildTarget;
  signingMode: ApplicationSigningMode;
}

export type ApplicationUpdateState =
  | 'disabled'
  | 'unknown'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'ahead'
  | 'unsupported_channel'
  | 'error';

export type ApplicationUpdateSource =
  | 'github-releases'
  | 'github-main'
  | 'npm-registry';

export interface ApplicationUpdateLatest {
  version: string;
  commit?: string;
  publishedAt?: string;
  releaseUrl: string;
  asset?: {
    name: string;
    url: string;
    sha256?: string;
  };
}

export type ApplicationUpgradeAction =
  | {
      kind: 'npm';
      command: string;
      url: string;
    }
  | {
      kind: 'docker';
      command: string;
      url: string;
      imageTag: string;
    }
  | {
      kind: 'portable';
      url: string;
      sha256?: string;
    }
  | {
      kind: 'source';
      command: string;
      url: string;
    };

export interface ApplicationUpdateError {
  code:
    | 'network_error'
    | 'timeout'
    | 'rate_limited'
    | 'invalid_response'
    | 'response_too_large'
    | 'cache_error';
  message: string;
  at: string;
}

export interface ApplicationUpdateStatus {
  schemaVersion: 1;
  state: ApplicationUpdateState;
  checkedAt?: string;
  stale?: boolean;
  source?: ApplicationUpdateSource;
  current: ApplicationBuildIdentity;
  latest?: ApplicationUpdateLatest;
  action?: ApplicationUpgradeAction;
  lastError?: ApplicationUpdateError;
}

export interface ApplicationUpdateCandidate {
  source: ApplicationUpdateSource;
  version: string;
  commit?: string;
  publishedAt?: string;
  releaseUrl: string;
  asset?: {
    name: string;
    url: string;
    sha256?: string;
  };
}

export interface ApplicationUpdateCacheRecord {
  schemaVersion: 1;
  key: string;
  checkedAt: string;
  etag?: string;
  candidate: ApplicationUpdateCandidate;
  lastError?: ApplicationUpdateError;
}
