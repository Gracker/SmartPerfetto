// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {getSmartPerfettoVersion} from '../../version';
import type {
  ApplicationBuildIdentity,
  ApplicationBuildTarget,
  ApplicationDistribution,
  ApplicationSigningMode,
  ApplicationUpdateChannel,
} from './types';

const DISTRIBUTIONS = new Set<ApplicationDistribution>([
  'source',
  'docker',
  'portable',
  'npm',
]);
const CHANNELS = new Set<ApplicationUpdateChannel>(['stable', 'nightly']);
const SIGNING_MODES = new Set<ApplicationSigningMode>([
  'source-checkout',
  'container',
  'npm-registry',
  'unsigned',
  'macos-adhoc',
  'macos-developer-id',
  'macos-developer-id-notarized',
]);

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function distributionFromEnvironment(
  env: NodeJS.ProcessEnv,
): ApplicationDistribution {
  const configured = trimmed(env.SMARTPERFETTO_DISTRIBUTION);
  if (configured && DISTRIBUTIONS.has(configured as ApplicationDistribution)) {
    return configured as ApplicationDistribution;
  }
  return env.SMARTPERFETTO_PACKAGE === '1' ? 'portable' : 'source';
}

function channelFromEnvironment(
  env: NodeJS.ProcessEnv,
): ApplicationUpdateChannel {
  const configured = trimmed(env.SMARTPERFETTO_UPDATE_CHANNEL);
  return configured && CHANNELS.has(configured as ApplicationUpdateChannel)
    ? configured as ApplicationUpdateChannel
    : 'stable';
}

function defaultSigningMode(
  distribution: ApplicationDistribution,
): ApplicationSigningMode {
  switch (distribution) {
    case 'source':
      return 'source-checkout';
    case 'docker':
      return 'container';
    case 'npm':
      return 'npm-registry';
    case 'portable':
      return 'unsigned';
  }
}

function signingModeFromEnvironment(
  env: NodeJS.ProcessEnv,
  distribution: ApplicationDistribution,
): ApplicationSigningMode {
  const configured = trimmed(env.SMARTPERFETTO_SIGNING_MODE);
  return configured && SIGNING_MODES.has(configured as ApplicationSigningMode)
    ? configured as ApplicationSigningMode
    : defaultSigningMode(distribution);
}

function targetFromEnvironment(env: NodeJS.ProcessEnv): ApplicationBuildTarget {
  const os = trimmed(env.SMARTPERFETTO_PACKAGE_TARGET_OS) ?? process.platform;
  const arch = trimmed(env.SMARTPERFETTO_PACKAGE_TARGET_ARCH) ?? process.arch;
  const id = trimmed(env.SMARTPERFETTO_PACKAGE_TARGET);
  return {os, arch, ...(id ? {id} : {})};
}

export function resolveApplicationBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<
    Pick<
      ApplicationBuildIdentity,
      'distribution' | 'channel' | 'commit' | 'target' | 'signingMode'
    >
  > = {},
): ApplicationBuildIdentity {
  const distribution =
    overrides.distribution ?? distributionFromEnvironment(env);
  const channel = overrides.channel ?? channelFromEnvironment(env);
  const commit =
    overrides.commit ?? trimmed(env.SMARTPERFETTO_BUILD_COMMIT);
  return {
    distribution,
    channel,
    version: getSmartPerfettoVersion(),
    ...(commit ? {commit} : {}),
    target: overrides.target ?? targetFromEnvironment(env),
    signingMode:
      overrides.signingMode ??
      signingModeFromEnvironment(env, distribution),
  };
}

export function applicationUpdateCacheKey(
  identity: ApplicationBuildIdentity,
): string {
  const targetId =
    identity.target.id ?? `${identity.target.os}-${identity.target.arch}`;
  return [
    identity.distribution,
    identity.channel,
    targetId,
  ]
    .join('-')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function portableTargetId(
  target: ApplicationBuildTarget,
): string | undefined {
  if (target.id) return target.id;
  const key = `${target.os}-${target.arch}`.toLowerCase();
  const mapping: Record<string, string> = {
    'windows-amd64': 'windows-x64',
    'win32-x64': 'windows-x64',
    'darwin-arm64': 'macos-arm64',
    'macos-arm64': 'macos-arm64',
    'linux-amd64': 'linux-x64',
    'linux-x64': 'linux-x64',
  };
  return mapping[key];
}
