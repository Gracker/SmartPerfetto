// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {spawnSync} from 'child_process';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  runCodebaseAuditCommand,
  runCodebaseAuthorizeExtensionsCommand,
  runCodebaseAuthorizeSelectionCommand,
  runCodebaseConsentCommand,
  runCodebaseDeleteCommand,
  runCodebaseListCommand,
  runCodebasePendingCommand,
  runCodebasePreviewCommand,
  runCodebaseRegisterCommand,
  runCodebaseReindexCommand,
  runCodebaseSelectionCommand,
  runCodebaseSymbolsCommand,
} from '../codebase';
import {CodebaseManagementService} from '../../../services/codebase/codebaseManagementService';
import {CodebaseRegistry, type IndexCoverage} from '../../../services/codebase/codebaseRegistry';
import {PathSecurityGate} from '../../../services/codebase/pathSecurityGate';
import {SourceEnumerator} from '../../../services/codebase/sourceEnumerator';
import {RagStore} from '../../../services/ragStore';

let tmpDir: string;
let sessionDir: string;
let root: string;
let logSpy: jest.SpiedFunction<typeof console.log>;
let errorSpy: jest.SpiedFunction<typeof console.error>;
let registry: CodebaseRegistry;
let store: RagStore;
let managementService: CodebaseManagementService;
const DEFAULT_SCOPE = {
  tenantId: 'default-dev-tenant',
  workspaceId: 'default-workspace',
  userId: 'dev-user-123',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-codebase-'));
  sessionDir = path.join(tmpDir, 'sessions');
  root = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(root, 'drivers/android'), {recursive: true});
  fs.writeFileSync(path.join(root, 'drivers/android/binder.c'), [
    '// SPDX-License-Identifier: GPL-2.0-only',
    'int binder_wait_for_work(void) { return 0; }',
  ].join('\n'));
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  managementService = new CodebaseManagementService({
    registry,
    store,
    gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
    sourceEnumerator: new SourceEnumerator(),
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('smp codebase command handlers', () => {
  it('previews through the source enumerator and reports backend coverage', async () => {
    fs.writeFileSync(path.join(root, 'lib.dart'), 'void main() {}\n');

    const code = await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'app_source',
      pathFilters: [],
      excludeGlobs: [],
      sessionDir,
    });

    expect(code).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('"enumerationBackend":');
    expect(logSpy.mock.calls.join('\n')).toContain('"backendFidelity":');
  });

  it('supports dry-run registration without writing registry state', async () => {
    const code = await runCodebaseRegisterCommand({
      rootPath: root,
      kind: 'kernel_source',
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
      excludeGlobs: ['**/generated/**'],
      dryRun: true,
      sessionDir,
    });

    expect(code).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('"kind": "kernel_source"');
    expect(logSpy.mock.calls.join('\n')).toContain('"excludeGlobs"');
    expect(fs.existsSync(path.join(sessionDir, 'codebase_registry.json'))).toBe(false);
  });

  it('keeps the empty-selection code stable and prints an actionable explanation', async () => {
    const emptyRoot = path.join(tmpDir, 'empty-repo');
    fs.mkdirSync(emptyRoot, {recursive: true});

    const code = await runCodebaseRegisterCommand({
      rootPath: emptyRoot,
      kind: 'app_source',
      sessionDir,
    });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain('effective_source_selection_empty');
    expect(errorSpy.mock.calls.join('\n')).toMatch(/no source files.*filter|filter.*no source files/i);
  });

  it.each([
    ['kernel_source', {pathFilters: ['drivers/android'] as string[]}, 'vendor'],
    ['kernel_source', {vendor: 'mtk'}, 'pathFilters'],
    ['aosp', {}, 'licenseTag'],
    ['oem_sdk', {vendor: 'vendor'}, 'licenseTag'],
  ] as const)('enforces %s registration metadata before dry-run', async (kind, options, missing) => {
    const code = await runCodebaseRegisterCommand({
      rootPath: root,
      kind,
      dryRun: true,
      sessionDir,
      ...options,
    });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain(`\`${missing}\` is required`);
    expect(fs.existsSync(path.join(sessionDir, 'codebase_registry.json'))).toBe(false);
  });

  it('registers, reindexes, and resolves kernel symbols', async () => {
    await runCodebaseRegisterCommand({
      rootPath: root,
      kind: 'kernel_source',
      name: 'mtk-kernel',
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
      sendToProvider: true,
      sessionDir,
    });
    const firstLine = String(logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0] ?? '');
    const codebaseId = firstLine.split('\t')[0];

    const reindex = await runCodebaseReindexCommand({codebaseId, sessionDir});
    expect(reindex).toBe(0);

    const symbols = await runCodebaseSymbolsCommand({
      symbol: 'binder_wait_for_work',
      codebaseId,
      sessionDir,
    });
    expect(symbols).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('binder_wait_for_work');
  });

  it('prints rich safe list state in table and stable JSON formats', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Managed App',
      rootPath: root,
      rootRealpath: root,
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });

    expect(await runCodebaseListCommand({
      sessionDir,
      managementService,
      format: 'table',
    })).toBe(0);
    const table = logSpy.mock.calls.join('\n');
    expect(table).toContain(ref.codebaseId);
    expect(table).toContain('root=available');
    expect(table).toContain('index=none');
    expect(table).toContain('selection=1');
    expect(table).toContain('grant=current');

    logSpy.mockClear();
    expect(await runCodebaseListCommand({
      sessionDir,
      managementService,
      format: 'json',
    })).toBe(0);
    const json = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(JSON.parse(json)).toEqual({success: true, codebases: [expect.objectContaining({
      codebaseId: ref.codebaseId,
      rootAvailable: true,
      activeIndexState: 'none',
      selectionPolicyRevision: 1,
    })]});
    expect(json).not.toContain(root);
    expect(json).not.toContain('rootAuthorization');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('sanitizes token-shaped diagnostics in CLI list/audit JSON and preserves known codes', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Diagnostic CLI',
      rootPath: root,
      rootRealpath: root,
      ...DEFAULT_SCOPE,
    });
    const tokenCanary = 'CLI_TOKEN_SECRET_CANARY_123456';
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'failed',
      lastIngestError: tokenCanary,
    }, DEFAULT_SCOPE);

    expect(await runCodebaseListCommand({
      sessionDir,
      managementService,
      format: 'json',
    })).toBe(0);
    const listJson = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(listJson).not.toContain(tokenCanary);
    expect(listJson).toContain('codebase_operation_failed');

    logSpy.mockClear();
    expect(await runCodebaseAuditCommand({
      codebaseId: ref.codebaseId,
      sessionDir,
      managementService,
      format: 'json',
    })).toBe(0);
    const auditJson = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(auditJson).not.toContain(tokenCanary);
    expect(auditJson).toContain('codebase_operation_failed');
    expect(errorSpy).not.toHaveBeenCalled();

    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'blocked_by_security',
      lastIngestError: 'codebase_root_realpath_drift',
    }, DEFAULT_SCOPE);
    logSpy.mockClear();
    expect(await runCodebaseAuditCommand({
      codebaseId: ref.codebaseId,
      sessionDir,
      managementService,
      format: 'json',
    })).toBe(0);
    expect(String(logSpy.mock.calls[0]?.[0] ?? ''))
      .toContain('codebase_root_realpath_drift');
  });

  it('uses service preview projection for AOSP manifest suggestions and degradation', async () => {
    fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
    fs.writeFileSync(path.join(root, '.repo/manifest.xml'), [
      '<manifest>',
      '  <project name="platform/frameworks/base" path="frameworks/base" groups="default,pdk" />',
      '</manifest>',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'frameworks/base'), {recursive: true});
    fs.writeFileSync(path.join(root, 'frameworks/base/Foo.java'), 'class Foo {}\n');

    expect(await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'aosp',
      sessionDir,
      managementService,
    })).toBe(0);
    const preview = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''));
    expect(preview).toMatchObject({
      manifestProjects: [expect.objectContaining({path: 'frameworks/base'})],
      manifestGroups: ['default', 'pdk'],
    });
    expect(JSON.stringify(preview)).not.toContain(root);
  });

  it('sanitizes CLI manifest degradation reasons while preserving known codes and root drift', async () => {
    const previewServiceFor = (reason: string) => new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: new SourceEnumerator(),
      readAospManifestProjects: async () => {
        throw new Error(reason);
      },
    });

    const secretCanary = 'secret_token_canary';
    expect(await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'aosp',
      sessionDir,
      managementService: previewServiceFor(secretCanary),
    })).toBe(0);
    const unknown = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(JSON.parse(unknown).manifestUnavailableReason)
      .toBe('aosp_manifest_discovery_failed');
    expect(unknown).not.toContain(secretCanary);

    logSpy.mockClear();
    expect(await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'aosp',
      sessionDir,
      managementService: previewServiceFor('source_metadata_too_large'),
    })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '')).manifestUnavailableReason)
      .toBe('source_metadata_too_large');

    logSpy.mockClear();
    expect(await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'aosp',
      sessionDir,
      managementService: previewServiceFor('codebase_root_realpath_drift'),
    })).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: false,
      code: 'CODEBASE_ROOT_DRIFT',
      error: 'codebase_root_realpath_drift',
    });
  });

  it('replaces selection intentionally and reports index invalidation in JSON', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Selection App',
      rootPath: root,
      rootRealpath: root,
      pathFilters: ['drivers'],
      excludeGlobs: ['**/old/**'],
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });

    const code = await runCodebaseSelectionCommand({
      codebaseId: ref.codebaseId,
      pathFilters: ['drivers/android'],
      excludeGlobs: ['**/generated/**'],
      format: 'json',
      sessionDir,
      managementService,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''));
    expect(payload).toMatchObject({
      success: true,
      codebase: {
        pathFilters: ['drivers/android'],
        excludeGlobs: ['**/generated/**'],
        selectionPolicyRevision: 2,
        activeIndexState: 'none',
        reindexRequired: 'selection_scope_changed',
      },
      reindexWarning: true,
    });
  });

  it('validates consent flags and prints informed consent/authorization results', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Consent App',
      rootPath: root,
      rootRealpath: root,
      sendToProvider: false,
      ...DEFAULT_SCOPE,
    });

    expect(await runCodebaseConsentCommand({
      codebaseId: ref.codebaseId,
      enable: true,
      disable: true,
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: false,
      code: 'CODEBASE_CONSENT_ACTION_INVALID',
    });

    logSpy.mockClear();
    expect(await runCodebaseConsentCommand({
      codebaseId: ref.codebaseId,
      enable: true,
      format: 'table',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toMatch(/provider.*enabled|enabled.*provider/i);

    expect(await runCodebaseAuthorizeExtensionsCommand({
      codebaseId: ref.codebaseId,
      format: 'table',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toMatch(/extension.*authorized/i);

    registry.updateSelectionPolicy(ref.codebaseId, DEFAULT_SCOPE, {pathFilters: ['drivers']});
    expect(await runCodebaseAuthorizeSelectionCommand({
      codebaseId: ref.codebaseId,
      format: 'table',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toMatch(/selection.*authorized/i);
  });

  it('accepts and rejects the exact pending candidate with stable CAS errors', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Pending App',
      rootPath: root,
      rootRealpath: root,
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });
    const candidateCoverage: IndexCoverage = {
      selectionPolicyRevision: 1,
      enumerationBackend: 'ripgrep',
      backendFidelity: 'exact',
      enumerationComplete: true,
      deterministic: true,
      filesEnumerated: 1,
      filesSelected: 1,
      bytesSelected: 10,
      chunksIndexed: 1,
      truncated: true,
      complete: false,
      truncationReason: 'file_budget',
    };
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'candidate-a',
      coverage: candidateCoverage,
      contentFingerprint: 'candidate-a-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });

    expect(await runCodebasePendingCommand({
      codebaseId: ref.codebaseId,
      accept: true,
      candidateId: 'wrong',
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(4);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: false,
      code: 'PENDING_GENERATION_STALE',
    });

    logSpy.mockClear();
    expect(await runCodebasePendingCommand({
      codebaseId: ref.codebaseId,
      accept: true,
      candidateId: 'candidate-a',
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: true,
      action: 'accepted',
      codebase: {activeGeneration: 'candidate-a'},
    });

    const current = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, current.indexGeneration, {
      candidateGenerationId: 'candidate-b',
      coverage: candidateCoverage,
      contentFingerprint: 'candidate-b-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    logSpy.mockClear();
    expect(await runCodebasePendingCommand({
      codebaseId: ref.codebaseId,
      reject: true,
      candidateId: 'candidate-b',
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: true,
      action: 'rejected',
    });
  });

  it('renders safe audit JSON and makes confirmed deletion idempotent', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Delete App',
      rootPath: root,
      rootRealpath: root,
      ...DEFAULT_SCOPE,
    });

    expect(await runCodebaseAuditCommand({
      codebaseId: ref.codebaseId,
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(0);
    const auditJson = String(logSpy.mock.calls[0]?.[0] ?? '');
    expect(JSON.parse(auditJson)).toMatchObject({
      success: true,
      audit: {codebaseId: ref.codebaseId, activeIndexState: 'none'},
    });
    expect(auditJson).not.toContain(root);
    expect(auditJson).not.toContain('rootAuthorization');

    logSpy.mockClear();
    expect(await runCodebaseDeleteCommand({
      codebaseId: ref.codebaseId,
      yes: false,
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(2);
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)).toBeDefined();

    logSpy.mockClear();
    expect(await runCodebaseDeleteCommand({
      codebaseId: ref.codebaseId,
      yes: true,
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: true,
      codebaseId: ref.codebaseId,
    });

    logSpy.mockClear();
    expect(await runCodebaseDeleteCommand({
      codebaseId: ref.codebaseId,
      yes: true,
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: true,
      alreadyDeleted: true,
    });
  });

  it('reports missing and wrong-scope ids with stable JSON error/exit codes', async () => {
    registry.register({
      kind: 'app_source',
      displayName: 'Other Scope',
      rootPath: root,
      rootRealpath: root,
      tenantId: 'other-tenant',
      workspaceId: 'other-workspace',
      userId: 'other-user',
    });

    expect(await runCodebaseAuditCommand({
      codebaseId: 'missing-or-wrong-scope',
      format: 'json',
      sessionDir,
      managementService,
    })).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? ''))).toMatchObject({
      success: false,
      code: 'CODEBASE_NOT_FOUND',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ['codebase', 'selection', 'cb-test', '--help'],
      expectedStatus: 0,
      stdout: /Usage:/,
      stderr: /^$/,
    },
    {
      args: ['codebase', 'consent', 'cb-test', '--enable', '--disable'],
      expectedStatus: 2,
      stdout: /^$/,
      stderr: /cannot be used with option/i,
    },
    {
      args: ['codebase', 'authorize-extensions', 'cb-test', '--help'],
      expectedStatus: 0,
      stdout: /Usage:/,
      stderr: /^$/,
    },
    {
      args: ['codebase', 'authorize-selection', 'cb-test', '--help'],
      expectedStatus: 0,
      stdout: /Usage:/,
      stderr: /^$/,
    },
    {
      args: ['codebase', 'pending', 'cb-test', '--accept', '--reject', '--candidate', 'candidate'],
      expectedStatus: 2,
      stdout: /^$/,
      stderr: /cannot be used with option/i,
    },
    {
      args: ['codebase', 'pending', 'cb-test', '--accept'],
      expectedStatus: 2,
      stdout: /^$/,
      stderr: /required option.*candidate/i,
    },
    {
      args: ['codebase', 'audit', 'cb-test', '--format', 'xml'],
      expectedStatus: 2,
      stdout: /^$/,
      stderr: /invalid codebase output format/i,
    },
    {
      args: ['codebase', 'audit', 'cb-test', '--help'],
      expectedStatus: 0,
      stdout: /Usage:/,
      stderr: /^$/,
    },
    {
      args: ['codebase', 'delete', 'cb-test'],
      expectedStatus: 2,
      stdout: /^$/,
      stderr: /required option.*yes/i,
    },
    {
      args: ['--version'],
      expectedStatus: 0,
      stdout: /^\d+\.\d+\.\d+\s*$/,
      stderr: /^$/,
    },
  ])('parses codebase command $args with the expected exit status', ({
    args,
    expectedStatus,
    stdout,
    stderr,
  }) => {
    const backendRoot = path.resolve(__dirname, '../../../..');
    const result = spawnSync(process.execPath, [
      path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(backendRoot, 'src/cli-user/bin.ts'),
      ...args,
    ], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SMARTPERFETTO_CLI_UPDATE_NOTICE: '0',
      },
    });

    expect(result.status).toBe(expectedStatus);
    expect(result.stdout).toMatch(stdout);
    expect(result.stderr).toMatch(stderr);
  });
});
