// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  evaluateCodebaseModeAuthorization,
  evaluateCodebaseRoot,
  resetRegistrationChannelTrustForTests,
} from '../codebase/codebaseCapability';
import {CodebaseRegistry, type CodebaseRef} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';

let tmpDir: string;
let root: string;
let registry: CodebaseRegistry;
let allowed: PathSecurityGate;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-capability-')));
  root = path.join(tmpDir, 'repo');
  fs.mkdirSync(root);
  registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
  allowed = new PathSecurityGate({allowlistRoots: [tmpDir]});
});

afterEach(() => {
  resetRegistrationChannelTrustForTests();
  if (fs.existsSync(root)) fs.chmodSync(root, 0o755);
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function register(overrides: Partial<Parameters<CodebaseRegistry['register']>[0]> = {}): CodebaseRef {
  return registry.register({kind: 'app_source', displayName: 'App', rootPath: root, sendToProvider: true, ...overrides});
}

describe('evaluateCodebaseRoot', () => {
  it('answers each unreadable root with one fixed reason, in check order', () => {
    const ref = register();
    expect(evaluateCodebaseRoot(ref, {gate: allowed})).toEqual({available: true, rootRealpath: root});
    expect(evaluateCodebaseRoot({...ref, lifecycleState: 'deleting'}, {gate: allowed}))
      .toEqual({available: false, reason: 'deleting'});
    expect(evaluateCodebaseRoot(ref, {gate: new PathSecurityGate({allowlistRoots: []})}))
      .toEqual({available: false, reason: 'outside_allowlist'});

    if (process.getuid?.() !== 0) {
      fs.chmodSync(root, 0o000);
      expect(evaluateCodebaseRoot(ref, {gate: allowed})).toEqual({available: false, reason: 'unreadable'});
      fs.chmodSync(root, 0o755);
    }

    fs.renameSync(root, `${root}-moved`);
    fs.writeFileSync(root, 'a file now');
    expect(evaluateCodebaseRoot(ref, {gate: allowed})).toEqual({available: false, reason: 'root_not_directory'});
    fs.rmSync(root);
    expect(evaluateCodebaseRoot(ref, {gate: allowed})).toEqual({available: false, reason: 'root_missing'});
    fs.symlinkSync(`${root}-moved`, root);
    expect(evaluateCodebaseRoot(ref, {gate: allowed})).toEqual({available: false, reason: 'root_identity_changed'});
    fs.rmSync(root);
    fs.renameSync(`${root}-moved`, root);
  });

  it('admits a root its registration channel authorized without the configured allowlist', () => {
    const picked = register({rootAuthorization: 'native_picker'});
    const cli = register({rootAuthorization: 'local_cli'});
    const noAllowlist = new PathSecurityGate({allowlistRoots: []});
    expect(evaluateCodebaseRoot(picked, {gate: noAllowlist})).toEqual({available: true, rootRealpath: root});
    // The server does not trust a CLI registration on its own.
    expect(evaluateCodebaseRoot(cli, {gate: noAllowlist})).toEqual({available: false, reason: 'outside_allowlist'});
  });
});

describe('evaluateCodebaseModeAuthorization', () => {
  it('needs consent and a current grant only for provider_send', () => {
    const consented = register({pathFilters: ['app']});
    const metadataOnly = register({sendToProvider: false});
    const stale: CodebaseRef = {
      ...consented,
      consent: {...consented.consent, grant: {...consented.consent.grant!, includePrefixes: ['app/src']}},
    };

    for (const mode of ['off', 'metadata_only'] as const) {
      expect(evaluateCodebaseModeAuthorization(metadataOnly, mode)).toEqual({authorized: true});
      expect(evaluateCodebaseModeAuthorization(stale, mode)).toEqual({authorized: true});
    }
    expect(evaluateCodebaseModeAuthorization(consented, 'provider_send')).toEqual({authorized: true});
    expect(evaluateCodebaseModeAuthorization(metadataOnly, 'provider_send'))
      .toEqual({authorized: false, reason: 'consent_required'});
    expect(evaluateCodebaseModeAuthorization(stale, 'provider_send'))
      .toEqual({authorized: false, reason: 'consent_scope_stale'});
  });
});
