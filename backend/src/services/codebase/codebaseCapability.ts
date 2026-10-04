// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';

import type {CodeAwareMode} from './codeAwareFeature';
import type {CodebaseRef, CodebaseRootAuthorization} from './codebaseRegistry';
import {PathSecurityGate, sameCanonicalPath} from './pathSecurityGate';
import {effectiveConsentGrant, grantMatchesSelection} from './sourceDisclosure';
import {sourceSelectionForRef} from './sourceSelectionPolicy';

/**
 * What a registered codebase can do, in two layers every consumer shares:
 *
 * - `evaluateCodebaseRoot` decides whether the registered root can be read at
 *   all, independent of any analysis mode: the management list and detail,
 *   the analysis start gate, a run's capability view and every on-demand call.
 * - `evaluateCodebaseModeAuthorization` decides whether a known mode may use
 *   it: only where the mode is known (start gate, capability view, each
 *   on-demand call).
 *
 * Both answer fixed reason codes only; a reason never carries a path, a
 * realpath, allowlist content or a native error.
 */

/** Registration channels this process trusts in place of the configured allowlist. */
let trustedRootChannels: ReadonlySet<CodebaseRootAuthorization> = new Set(['native_picker']);
/** Channel assumed for records written before registration recorded one; unset on the server. */
let unrecordedRootChannel: CodebaseRootAuthorization | undefined;

/**
 * The CLI trusts roots its local user registered, including records written
 * before registration recorded the channel. The server never calls this, so a
 * `local_cli` record it reads still needs the configured allowlist.
 */
export function trustLocalCliRegistrations(): void {
  trustedRootChannels = new Set(['native_picker', 'local_cli']);
  unrecordedRootChannel = 'local_cli';
}

/** @internal Test seam: restores the server's default channel trust between cases. */
export function resetRegistrationChannelTrustForTests(): void {
  trustedRootChannels = new Set(['native_picker']);
  unrecordedRootChannel = undefined;
}

/** Gate options for a root authorized by its registration channel rather than the allowlist. */
export function channelAuthorizedRoots(
  ref: Pick<CodebaseRef, 'rootAuthorization' | 'rootRealpath'>,
): {additionalAllowlistRoots: string[]} | undefined {
  const channel = ref.rootAuthorization ?? unrecordedRootChannel;
  return channel && trustedRootChannels.has(channel)
    ? {additionalAllowlistRoots: [ref.rootRealpath]}
    : undefined;
}

/** Whether the provider-send grant covers exactly the current path selection. */
export function codebaseProviderGrantScopeCurrent(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
): boolean {
  return grantMatchesSelection(effectiveConsentGrant(ref), sourceSelectionForRef(ref));
}

/** Why a registered root cannot be read, in the order they are checked. */
export type CodebaseRootUnavailableReason =
  | 'deleting'
  | 'root_missing'
  | 'root_identity_changed'
  | 'root_not_directory'
  | 'outside_allowlist'
  | 'unreadable';

/** An available root carries its canonical path, so callers never resolve it again. */
export type CodebaseRootCapability =
  | {available: true; rootRealpath: string}
  | {available: false; reason: CodebaseRootUnavailableReason};

export interface CodebaseRootEvaluationOptions {
  /** The allowlist this process enforces; the configured environment by default. */
  gate?: Pick<PathSecurityGate, 'rootWithinAllowlist'>;
  platform?: NodeJS.Platform;
}

function unavailable(reason: CodebaseRootUnavailableReason): CodebaseRootCapability {
  return {available: false, reason};
}

/** The configured-environment allowlist, read at each call. */
let defaultGate: PathSecurityGate | undefined;

/**
 * The one root check: lifecycle, the canonical root still being the
 * registered one, a directory, admitted by the allowlist or the registration
 * channel, and readable and traversable. The first failing check is the reason.
 */
export function evaluateCodebaseRoot(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'rootRealpath' | 'rootAuthorization'>,
  options: CodebaseRootEvaluationOptions = {},
): CodebaseRootCapability {
  if ((ref.lifecycleState ?? 'active') !== 'active') return unavailable('deleting');
  let current: string;
  let stats: fs.Stats;
  try {
    current = fs.realpathSync(ref.rootRealpath);
    stats = fs.statSync(current);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unavailable(code === 'ENOENT' || code === 'ENOTDIR' ? 'root_missing' : 'unreadable');
  }
  if (!sameCanonicalPath(current, ref.rootRealpath, options.platform)) return unavailable('root_identity_changed');
  if (!stats.isDirectory()) return unavailable('root_not_directory');
  const gate = options.gate ?? (defaultGate ??= new PathSecurityGate());
  if (!gate.rootWithinAllowlist(current, channelAuthorizedRoots(ref))) return unavailable('outside_allowlist');
  try {
    fs.accessSync(current, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return unavailable('unreadable');
  }
  return {available: true, rootRealpath: current};
}

/** Why a known analysis mode may not use a codebase whose root is available. */
export type CodebaseModeAuthorizationFailure = 'consent_required' | 'consent_scope_stale';

export type CodebaseModeAuthorization =
  | {authorized: true}
  | {authorized: false; reason: CodebaseModeAuthorizationFailure};

/**
 * `provider_send` needs the codebase's own consent, and a grant that covers
 * exactly the current selection: a grant is never partial, so one that no
 * longer matches the selection authorizes nothing until it is renewed.
 * Other modes send no source body and need neither.
 */
export function evaluateCodebaseModeAuthorization(
  ref: Pick<CodebaseRef, 'kind' | 'pathFilters' | 'excludeGlobs' | 'consent'>,
  mode: CodeAwareMode,
): CodebaseModeAuthorization {
  if (mode !== 'provider_send') return {authorized: true};
  if (!ref.consent.sendToProvider) return {authorized: false, reason: 'consent_required'};
  if (!codebaseProviderGrantScopeCurrent(ref)) return {authorized: false, reason: 'consent_scope_stale'};
  return {authorized: true};
}
