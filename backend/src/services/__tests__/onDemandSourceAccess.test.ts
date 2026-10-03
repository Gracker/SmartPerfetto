// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  CodebaseRegistry,
  resetRegistrationChannelTrustForTests,
  trustLocalCliRegistrations,
} from '../codebase/codebaseRegistry';
import {
  OnDemandSourceAccessService,
  codebaseOnDemandAvailability,
} from '../codebase/onDemandSourceAccess';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {DeterministicFixtureSourceAccessService} from '../../testSupport/deterministicFixtureSourceAccess';

const scope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

let tmpDir: string;
let root: string;
let registry: CodebaseRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-demand-source-test-'));
  root = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(root, 'app', 'src'), {recursive: true});
  fs.mkdirSync(path.join(root, 'tools'), {recursive: true});
  fs.writeFileSync(path.join(root, 'app', 'src', 'MainActivity.kt'), [
    'package demo',
    '',
    'class MainActivity {',
    '  fun loadTimeline() = Unit',
    '  val api_key = "abcdefghijk"',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'tools', 'Ignored.kt'), 'class MainActivityIgnored\n');
  registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function register(sendToProvider = true, rootAuthorization?: 'local_cli' | 'native_picker') {
  return registry.register({
    kind: 'app_source',
    displayName: 'Demo App',
    rootPath: root,
    pathFilters: ['app/src'],
    excludeGlobs: ['**/generated/**'],
    sendToProvider,
    rootAuthorization,
    ...scope,
  });
}

function service(ripgrepPath = 'rg', allowlistRoots = [tmpDir]) {
  return new OnDemandSourceAccessService({
    registry,
    gate: new PathSecurityGate({allowlistRoots}),
    ripgrepPath,
  });
}

describe('OnDemandSourceAccessService', () => {
  it.each([
    {name: 'first', startLine: 1, maxLines: 2, end: 2, before: 0, after: 5, next: 3},
    {name: 'middle', startLine: 3, maxLines: 3, end: 5, before: 2, after: 2, next: 6},
    {name: 'tail', startLine: 6, maxLines: 10, end: 7, before: 5, after: 0, next: null},
    {name: 'full', startLine: 1, maxLines: 10, end: 7, before: 0, after: 0, next: null},
  ])('exposes unread file lines for a $name window without assessing symbols', async ({
    startLine, maxLines, end, before, after, next,
  }) => {
    const ref = register();
    const read = await service().read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/MainActivity.kt',
      startLine,
      maxLines,
      mode: 'provider_send',
    });

    expect(read.success).toBe(true);
    expect(read.reference?.lineRange).toEqual({start: startLine, end});
    expect(read.window).toMatchObject({
      totalLines: 7,
      omittedBefore: before,
      omittedAfter: after,
      nextStartLine: next,
      symbolCoverage: 'not_assessed',
    });
    expect(read.truncated).toBe(after > 0);
    expect(read).not.toHaveProperty('coverageComplete');
  });

  it.each([
    {content: 'first\r\nsecond', totalLines: 2, tail: 'second'},
    {content: 'first\r\nsecond\r\n', totalLines: 3, tail: 'second\n'},
    {content: 'first\nsecond\n', totalLines: 3, tail: 'second\n'},
  ])('keeps existing newline counting for $totalLines lines', async ({content, totalLines, tail}) => {
    fs.writeFileSync(path.join(root, 'app', 'src', 'Window.kt'), content);
    const ref = register();
    const read = await service().read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/Window.kt',
      startLine: 2,
      mode: 'provider_send',
    });

    expect(read.reference?.lineRange).toEqual({start: 2, end: totalLines});
    expect(read.reference?.text).toBe(tail);
    expect(read.window).toEqual({
      totalLines, omittedBefore: 1, omittedAfter: 0,
      nextStartLine: null, symbolCoverage: 'not_assessed',
    });
  });

  it.each(['off', 'provider_send'] as const)('does not disclose a read window when %s access is denied', async mode => {
    const ref = register(false);
    const read = await service().read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/MainActivity.kt',
      mode,
    });

    expect(read.success).toBe(false);
    expect(read).not.toHaveProperty('window');
    expect(read).not.toHaveProperty('reference');
  });

  it('searches and reads a registered codebase without an active index', async () => {
    const ref = register();
    expect(ref.activeGeneration).toBeUndefined();
    expect(ref.chunkCount).toBeUndefined();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
      maxResults: 5,
      contextLines: 0,
    });

    expect(search.success).toBe(true);
    expect(search.matches).toEqual([
      expect.objectContaining({
        codebaseId: ref.codebaseId,
        filePath: 'app/src/MainActivity.kt',
        lineRange: {start: 4, end: 4},
        text: '  fun loadTimeline() = Unit',
      }),
    ]);
    expect(JSON.stringify(search)).not.toContain(root);

    const read = await service().read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/MainActivity.kt',
      startLine: 3,
      maxLines: 3,
      mode: 'provider_send',
    });

    expect(read).toEqual(expect.objectContaining({
      success: true,
      reference: expect.objectContaining({
        filePath: 'app/src/MainActivity.kt',
        lineRange: {start: 3, end: 5},
      }),
    }));
    expect(read.reference?.text).toContain('class MainActivity');
    expect(read.reference?.text).toContain('[REDACTED_SECRET]');
    expect(read.reference?.text).not.toContain('abcdefghijk');
    expect(JSON.stringify(read)).not.toContain(root);
  });

  it('returns CodeRef metadata but no source text in metadata_only mode', async () => {
    const ref = register();
    const access = service('__smartperfetto_missing_rg__');

    const search = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'MainActivity',
      mode: 'metadata_only',
    });
    const read = await access.read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/MainActivity.kt',
      startLine: 1,
      maxLines: 10,
      mode: 'metadata_only',
    });

    expect(search.matches[0]).toEqual(expect.objectContaining({
      filePath: 'app/src/MainActivity.kt',
      lineRange: {start: 3, end: 3},
    }));
    expect(search.matches[0]).not.toHaveProperty('text');
    expect(search.backend).toBe('node');
    expect(read).toEqual(expect.objectContaining({
      success: true,
      reference: expect.objectContaining({
        filePath: 'app/src/MainActivity.kt',
        lineRange: {start: 1, end: 7},
      }),
    }));
    expect(read.reference).not.toHaveProperty('text');
    expect(read.window).toEqual({
      totalLines: 7, omittedBefore: 0, omittedAfter: 0,
      nextStartLine: null, symbolCoverage: 'not_assessed',
    });
    expect(JSON.stringify(read)).not.toContain('class MainActivity');
  });

  it('keeps win32 prefix pruning case-insensitive in the node fallback', async () => {
    fs.mkdirSync(path.join(root, 'SourceCase'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'SourceCase', 'WindowsCase.kt'),
      'val windowsPrefixNeedle = Unit\n',
    );
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Windows casing',
      rootPath: root,
      pathFilters: ['sourcecase'],
      ...scope,
    });
    const access = new OnDemandSourceAccessService({
      registry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      ripgrepPath: '__smartperfetto_missing_rg__',
      platform: 'win32',
    } as any);

    const search = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'windowsPrefixNeedle',
      mode: 'metadata_only',
    });

    // A finished Node walk covers every selected file; only its speed and
    // ignore-file semantics are degraded relative to ripgrep.
    expect(search.backend).toBe('node');
    expect(search.coverageComplete).toBe(true);
    expect(search.searchIncompleteReason).toBeUndefined();
    expect(search.backendFidelity).toBe('degraded');
    expect(search.matches).toEqual([
      expect.objectContaining({filePath: 'SourceCase/WindowsCase.kt'}),
    ]);
  });

  it('requires provider consent before returning source text', async () => {
    const ref = register(false);

    await expect(service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'MainActivity',
      mode: 'provider_send',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'no_send_to_provider_consent',
      matches: [],
    }));
  });

  it('keeps newly available languages metadata-only until the frozen grant opts in', async () => {
    fs.writeFileSync(path.join(root, 'app', 'src', 'main.dart'), 'void consentNeedle() {}\n');
    const ref = register();
    const registryPath = path.join(tmpDir, 'registry.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const migratedRegistry = new CodebaseRegistry(registryPath);
    const access = new OnDemandSourceAccessService({
      registry: migratedRegistry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
    });

    const metadata = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'consentNeedle',
      mode: 'metadata_only',
    });
    const provider = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'consentNeedle',
      mode: 'provider_send',
    });

    expect(metadata.matches).toEqual([
      expect.objectContaining({filePath: 'app/src/main.dart'}),
    ]);
    expect(metadata.matches[0]).not.toHaveProperty('text');
    expect(provider.matches).toEqual([]);
    await expect(access.read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'app/src/main.dart',
      mode: 'provider_send',
    })).resolves.toEqual({
      success: false,
      codebaseId: ref.codebaseId,
      truncated: false,
      unsupportedReason: 'source_path_outside_provider_grant',
    });
  });

  it.each(['metadata_only', 'provider_send'] as const)(
    'answers a %s read outside the registered path filters as a refusal without echoing the path',
    async mode => {
      const ref = register();
      const read = await service().read({
        codebaseId: ref.codebaseId,
        scope,
        filePath: 'tools/Ignored.kt',
        mode,
      });

      expect(read).toEqual({
        success: false,
        codebaseId: ref.codebaseId,
        truncated: false,
        unsupportedReason: 'source_path_outside_registered_filters',
      });
    },
  );

  it.each(['metadata_only', 'provider_send'] as const)(
    'answers a %s read of a non-source extension as a refusal without echoing the path',
    async mode => {
      fs.writeFileSync(path.join(root, 'app', 'src', 'notes.txt'), 'MainActivity notes\n');
      const ref = register();

      await expect(service().read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/notes.txt', mode}))
        .resolves.toEqual({
          success: false,
          codebaseId: ref.codebaseId,
          truncated: false,
          unsupportedReason: 'source_extension_not_allowed',
        });
    },
  );

  it.each([
    ['outside the registered filters', 'tools'],
    ['inside an excluded directory', 'app/src/build'],
    ['inside an exclude glob', 'app/src/generated'],
  ])('refuses a search whose path prefix is %s instead of reporting complete absence', async (_label, pathPrefix) => {
    fs.mkdirSync(path.join(root, 'app', 'src', 'build'), {recursive: true});
    fs.writeFileSync(path.join(root, 'app', 'src', 'build', 'Built.kt'), 'class MainActivityBuilt\n');
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'MainActivity',
      mode: 'provider_send',
      pathPrefix,
    });

    // A refusal searched nothing, so it carries no backend or coverage claim.
    expect(search).toEqual({
      success: false,
      codebaseId: ref.codebaseId,
      matches: [],
      truncated: false,
      unsupportedReason: 'source_path_prefix_outside_registered_filters',
    });
  });

  it('answers a consent refusal without a backend or coverage claim', async () => {
    const ref = register(false);

    await expect(service().search({codebaseId: ref.codebaseId, scope, query: 'MainActivity', mode: 'provider_send'}))
      .resolves.toEqual({success: false, codebaseId: ref.codebaseId, matches: [], truncated: false,
        unsupportedReason: 'no_send_to_provider_consent'});
  });

  it('compares a path prefix case-insensitively on win32, like the path gate', async () => {
    const ref = register();
    const win32 = new OnDemandSourceAccessService({registry, platform: 'win32',
      gate: new PathSecurityGate({allowlistRoots: [tmpDir], platform: 'win32'}),
      ripgrepPath: '__smartperfetto_missing_rg__'});

    const search = await win32.search({
      codebaseId: ref.codebaseId, scope, query: 'loadTimeline', mode: 'metadata_only', pathPrefix: 'APP/SRC',
    });

    expect(search).toEqual(expect.objectContaining({success: true, coverageScope: 'codebase'}));
  });

  it.each([
    ['equal to the registered filter', 'app/src', 'codebase'],
    ['an ancestor of the registered filter', 'app', 'codebase'],
    ['inside the registered filter', 'app/src/MainActivity.kt', 'path_prefix'],
  ])('scopes the coverage of a search whose path prefix is %s', async (_label, pathPrefix, coverageScope) => {
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId, scope, query: 'loadTimeline', mode: 'metadata_only', pathPrefix,
    });

    expect(search).toEqual(expect.objectContaining({success: true, coverageComplete: true, coverageScope,
      matches: [expect.objectContaining({filePath: 'app/src/MainActivity.kt'})]}));
  });

  describe('a provider-send grant narrower than the registered filters', () => {
    const narrowGrant = () => {
      fs.mkdirSync(path.join(root, 'app', 'private'), {recursive: true});
      fs.writeFileSync(path.join(root, 'app', 'private', 'Hidden.kt'), 'class GrantNeedle\n');
      const ref = registry.register({kind: 'app_source', displayName: 'Narrow grant', rootPath: root,
        pathFilters: ['app/src'], sendToProvider: true, ...scope});
      return registry.updateSelectionPolicy(ref.codebaseId, scope, {pathFilters: ['app']});
    };

    it('refuses a path prefix outside the grant', async () => {
      const ref = narrowGrant();

      await expect(service().search({codebaseId: ref.codebaseId, scope, query: 'GrantNeedle',
        mode: 'provider_send', pathPrefix: 'app/private'})).resolves.toEqual({success: false,
        codebaseId: ref.codebaseId, matches: [], truncated: false,
        unsupportedReason: 'source_path_prefix_outside_provider_grant'});
      // metadata_only sends no body, so the grant does not narrow it.
      await expect(service().search({codebaseId: ref.codebaseId, scope, query: 'GrantNeedle',
        mode: 'metadata_only', pathPrefix: 'app/private'})).resolves.toEqual(expect.objectContaining({
        success: true, matches: [expect.objectContaining({filePath: 'app/private/Hidden.kt'})]}));
    });

    it('flags a match withheld by the grant in the Node fallback too, so a fixture cannot upgrade it', async () => {
      const ref = narrowGrant();
      const node = new OnDemandSourceAccessService({registry, gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
        ripgrepPath: '__smartperfetto_missing_rg__'});

      const withheld = await node.search({codebaseId: ref.codebaseId, scope, query: 'GrantNeedle',
        mode: 'provider_send'});
      const clean = await node.search({codebaseId: ref.codebaseId, scope, query: 'NoSuchNeedleAnywhere',
        mode: 'provider_send'});

      expect(withheld).toEqual(expect.objectContaining({backend: 'node', matches: [], coverageComplete: false,
        searchIncompleteReason: 'provider_grant_scope'}));
      expect(clean).toEqual(expect.objectContaining({backend: 'node', coverageComplete: true}));
      expect(clean.searchIncompleteReason).toBeUndefined();
    });

    const nodeService = () => new OnDemandSourceAccessService({registry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}), ripgrepPath: '__smartperfetto_missing_rg__'});

    it('rejects a multi-line query up front, since every backend matches per line', async () => {
      const ref = narrowGrant();

      for (const query of ['class\nGrantNeedle', 'GrantNeedle\r']) {
        await expect(nodeService().search({codebaseId: ref.codebaseId, scope, query, mode: 'provider_send'}))
          .rejects.toThrow('source_query_invalid');
      }
    });

    it('matches a withheld file per line, like a granted one', async () => {
      const ref = narrowGrant();
      fs.writeFileSync(path.join(root, 'app', 'private', 'Split.kt'), 'val first = 1\nval second = 2\n');

      // Called below search(), which already rejects line breaks: the withheld branch must not match across lines.
      const node = nodeService() as any;
      const prepared = await node.prepareScopedLookup(ref, 'provider_send', undefined);
      const result = await node.searchCandidatesWithNode(ref, prepared, '1\nval second', true,
        () => true, () => 0);

      expect(result.grantWithheld).toBe(false);
      expect(result.stopReason).toBeUndefined();
    });

    it('yields the event loop after each withheld file it reads', async () => {
      const ref = narrowGrant();
      for (const name of ['A', 'B', 'C']) {
        fs.writeFileSync(path.join(root, 'app', 'private', `${name}.kt`), `class ${name}\n`);
      }
      const yields = jest.spyOn(global, 'setImmediate');
      try {
        await nodeService().search({codebaseId: ref.codebaseId, scope, query: 'NoSuchNeedleAnywhere',
          mode: 'provider_send'});
        // One granted file plus four withheld files, each followed by a yield.
        expect(yields.mock.calls.length).toBeGreaterThanOrEqual(5);
      } finally { yields.mockRestore(); }
    });

    it('is not upgraded to complete coverage by the deterministic fixture', async () => {
      fs.mkdirSync(path.join(root, 'flat', 'granted'), {recursive: true});
      fs.mkdirSync(path.join(root, 'flat', 'private'), {recursive: true});
      fs.writeFileSync(path.join(root, 'flat', 'granted', 'Granted.kt'), 'class Granted\n');
      fs.writeFileSync(path.join(root, 'flat', 'private', 'Hidden.kt'), 'class FixtureGrantNeedle\n');
      const fixtureRegistry = new CodebaseRegistry(path.join(tmpDir, 'fixture-registry.json'));
      const registered = fixtureRegistry.register({kind: 'app_source', displayName: 'Fixture', rootPath: root,
        rootAuthorization: 'native_picker', pathFilters: ['flat/granted'], sendToProvider: true, ...scope});
      const ref = fixtureRegistry.updateSelectionPolicy(registered.codebaseId, scope,
        {pathFilters: ['flat/granted', 'flat/private']});
      const fixture = new DeterministicFixtureSourceAccessService(fixtureRegistry);

      const withheld = await fixture.search({codebaseId: ref.codebaseId, scope, query: 'FixtureGrantNeedle',
        mode: 'provider_send'});
      const clean = await fixture.search({codebaseId: ref.codebaseId, scope, query: 'NoSuchNeedleAnywhere',
        mode: 'provider_send'});

      expect(withheld).toEqual(expect.objectContaining({matches: [], coverageComplete: false,
        searchIncompleteReason: 'provider_grant_scope'}));
      expect(clean).toEqual(expect.objectContaining({matches: [], coverageComplete: true}));
    });

    it('withholds a match outside the grant without claiming complete coverage', async () => {
      const ref = narrowGrant();

      const withheld = await service().search({codebaseId: ref.codebaseId, scope, query: 'GrantNeedle',
        mode: 'provider_send'});
      const clean = await service().search({codebaseId: ref.codebaseId, scope, query: 'NoSuchNeedleAnywhere',
        mode: 'provider_send'});

      expect(withheld).toEqual(expect.objectContaining({success: true, matches: [], coverageComplete: false,
        searchIncompleteReason: 'provider_grant_scope'}));
      expect(JSON.stringify(withheld)).not.toContain('Hidden');
      expect(clean).toEqual(expect.objectContaining({success: true, matches: [], coverageComplete: true}));
    });
  });

  it('evaluates a frozen provider grant once for a large rejected candidate set', async () => {
    const sourceRoot = path.join(root, 'grant-scale');
    fs.mkdirSync(sourceRoot, {recursive: true});
    for (let index = 0; index < 500; index += 1) {
      fs.writeFileSync(
        path.join(sourceRoot, `Candidate${index}.dart`),
        `void frozenGrantNeedle${index}() {}\n`,
      );
    }
    const excludeGlobs = Array.from({length: 128}, (_, index) =>
      `**/generated-${index}/**`);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Frozen grant scale',
      rootPath: root,
      pathFilters: ['grant-scale'],
      excludeGlobs,
      sendToProvider: true,
      ...scope,
    });
    const registryPath = path.join(tmpDir, 'registry.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.extensions = ['.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const migratedRegistry = new CodebaseRegistry(registryPath);
    const registered = migratedRegistry.get(ref.codebaseId, scope)!;
    let policyFieldReads = 0;
    const instrumented = new Proxy(registered, {
      get(target, property, receiver) {
        if (property === 'pathFilters' || property === 'excludeGlobs') {
          policyFieldReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const get = jest.spyOn(migratedRegistry, 'get').mockReturnValue(instrumented);
    const access = new OnDemandSourceAccessService({
      registry: migratedRegistry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      ripgrepPath: '__smartperfetto_missing_rg__',
      searchTimeoutMs: 30_000,
    });
    const search = await (async () => {
      try {
        return await access.search({
          codebaseId: ref.codebaseId,
          scope,
          query: 'frozenGrantNeedle',
          mode: 'provider_send',
        });
      } finally {
        get.mockRestore();
      }
    })();

    expect(policyFieldReads).toBeLessThan(10);
    expect(search.backend).toBe('node');
    expect(search.matches).toEqual([]);
  }, 30_000);

  it('searches and reads an explicitly selected noise directory', async () => {
    fs.mkdirSync(path.join(root, 'node_modules', 'custom'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'node_modules', 'custom', 'Explicit.ts'),
      'export const explicitNoiseNeedle = true;\n',
    );
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Explicit dependency source',
      rootPath: root,
      pathFilters: ['node_modules/custom'],
      sendToProvider: true,
      ...scope,
    });
    const access = service('__smartperfetto_missing_rg__');

    const search = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'explicitNoiseNeedle',
      mode: 'provider_send',
    });
    const read = await access.read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: 'node_modules/custom/Explicit.ts',
      mode: 'provider_send',
    });

    expect(search.matches).toEqual([
      expect.objectContaining({filePath: 'node_modules/custom/Explicit.ts'}),
    ]);
    expect(read.reference).toEqual(expect.objectContaining({
      filePath: 'node_modules/custom/Explicit.ts',
      text: expect.stringContaining('explicitNoiseNeedle'),
    }));
  });

  it('returns a successful empty search with or without the optional ripgrep backend', async () => {
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'definitelyMissingSymbol',
      mode: 'provider_send',
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      matches: [],
    }));
    expect(['ripgrep', 'node']).toContain(search.backend);
  });

  it('enforces registered filters and rejects traversal reads', async () => {
    const ref = register();
    const access = service('__smartperfetto_missing_rg__');

    const search = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'MainActivityIgnored',
      mode: 'provider_send',
    });

    expect(search.matches).toEqual([]);
    await expect(access.read({
      codebaseId: ref.codebaseId,
      scope,
      filePath: '../outside.kt',
      startLine: 1,
      maxLines: 10,
      mode: 'provider_send',
    })).rejects.toThrow('source_path_invalid');
    await expect(access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'MainActivity',
      mode: 'provider_send',
      pathPrefix: '../outside',
    })).rejects.toThrow('source_path_prefix_invalid');
  });

  it('applies registered exclusions before search results can exhaust output limits', async () => {
    const generated = path.join(root, 'app', 'src', 'generated');
    fs.mkdirSync(generated, {recursive: true});
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(
        path.join(generated, `Generated${index}.kt`),
        'loadTimeline\n'.repeat(14_000),
      );
    }
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      truncated: false,
    }));
    expect(search.matches).toEqual([
      expect.objectContaining({filePath: 'app/src/MainActivity.kt'}),
    ]);
  });

  it('streams common-query output past the legacy one-megabyte child buffer', async () => {
    for (let index = 0; index < 12; index += 1) {
      fs.writeFileSync(
        path.join(root, 'app', 'src', `Common${index}.kt`),
        'val commonNeedle = Unit\n'.repeat(7_000),
      );
    }
    const ref = register();
    let ripgrepPath = 'rg';
    if (process.platform !== 'win32') {
      const fakeRipgrep = path.join(tmpDir, 'fake-common-query-rg');
      const output = Array.from({length: 12}, (_, index) => JSON.stringify({
        type: 'match',
        data: {
          path: {text: `app/src/Common${index}.kt`},
          line_number: 1,
        },
      })).join('\n') + '\n';
      fs.writeFileSync(fakeRipgrep, [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(output)});`,
        '',
      ].join('\n'));
      fs.chmodSync(fakeRipgrep, 0o700);
      ripgrepPath = fakeRipgrep;
    }

    const search = await service(ripgrepPath).search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'commonNeedle',
      mode: 'provider_send',
      maxResults: 8,
    });

    // Showing 8 of 12 is paging: the traversal still saw every file.
    expect(search).toEqual(expect.objectContaining({
      success: true,
      truncated: false,
      traversal: 'complete',
      coverageComplete: true,
      moreResults: true,
      totalMatches: 12,
      fileCount: 8,
      enumerationBackend: 'ripgrep',
      backendFidelity: 'exact',
    }));
    expect(search.searchIncompleteReason).toBeUndefined();
    expect(search.matches).toHaveLength(8);
  });

  it('shows the best hits of one file in merged windows and pages the rest', async () => {
    if (process.platform === 'win32') return;
    const repeated = path.join(root, 'app', 'src', 'Repeated.kt');
    fs.writeFileSync(
      repeated,
      Array.from({length: 13}, (_, index) => `val repeatedNeedle${index} = Unit`).join('\n'),
    );
    const fakeRipgrep = path.join(tmpDir, 'fake-max-count-aware-rg');
    fs.writeFileSync(fakeRipgrep, [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      "const maxCountIndex = args.indexOf('--max-count');",
      'const count = maxCountIndex >= 0 ? Number(args[maxCountIndex + 1]) : 13;',
      'for (let index = 1; index <= count; index += 1) {',
      "  process.stdout.write(JSON.stringify({type: 'match', data: {path: {text: 'app/src/Repeated.kt'}, line_number: index}}) + '\\n');",
      '}',
      '',
    ].join('\n'));
    fs.chmodSync(fakeRipgrep, 0o700);
    const ref = register();

    const search = await service(fakeRipgrep).search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'repeatedNeedle',
      mode: 'provider_send',
      maxResults: 8,
    });

    // Eight adjacent hits share one context window; the other five are paged.
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]).toEqual(expect.objectContaining({
      lineRange: {start: 1, end: 10},
      matchLines: [1, 2, 3, 4, 5, 6, 7, 8],
    }));
    expect(search).toEqual(expect.objectContaining({
      truncated: false, coverageComplete: true, moreResults: true, totalMatches: 13, fileCount: 1}));
  });

  it('preserves ripgrep exit 2 matches with traversal-error coverage', async () => {
    if (process.platform === 'win32') return;
    const fakeRipgrep = path.join(tmpDir, 'fake-partial-search-rg');
    fs.writeFileSync(fakeRipgrep, [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({type: 'match', data: {path: {text: 'app/src/MainActivity.kt'}, line_number: 4}}) + '\\n');",
      'process.exitCode = 2;',
      '',
    ].join('\n'));
    fs.chmodSync(fakeRipgrep, 0o700);
    const ref = register();

    const search = await service(fakeRipgrep).search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      coverageComplete: false,
      searchIncompleteReason: 'traversal_error',
      matches: [expect.objectContaining({filePath: 'app/src/MainActivity.kt'})],
    }));
  });

  it('does not descend into unselected noise directories in the node fallback', async () => {
    const unscopedRoot = path.join(tmpDir, 'unscoped');
    fs.mkdirSync(path.join(unscopedRoot, 'src'), {recursive: true});
    fs.mkdirSync(path.join(unscopedRoot, 'node_modules', 'dependency'), {recursive: true});
    fs.writeFileSync(path.join(unscopedRoot, 'src', 'Main.kt'), 'val nodeNoiseNeedle = Unit\n');
    fs.writeFileSync(
      path.join(unscopedRoot, 'node_modules', 'dependency', 'Index.ts'),
      'export const nodeNoiseNeedle = true;\n',
    );
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Unscoped app',
      rootPath: unscopedRoot,
      sendToProvider: true,
      ...scope,
    });
    const opened: string[] = [];
    const originalOpendir = fs.promises.opendir.bind(fs.promises);
    const opendir = jest.spyOn(fs.promises, 'opendir').mockImplementation(async (...args: any[]) => {
      opened.push(String(args[0]));
      return originalOpendir(args[0], args[1]);
    });

    try {
      const search = await service('__smartperfetto_missing_rg__').search({
        codebaseId: ref.codebaseId,
        scope,
        query: 'nodeNoiseNeedle',
        mode: 'provider_send',
      });

      expect(search.matches.map(match => match.filePath)).toEqual(['src/Main.kt']);
      expect(opened.some(directory => directory.includes('node_modules'))).toBe(false);
    } finally {
      opendir.mockRestore();
    }
  });

  it('starts ripgrep with a fixed argument vector and sanitized config environment', async () => {
    if (process.platform === 'win32') return;
    const config = path.join(tmpDir, 'ripgreprc');
    const environmentCapture = path.join(tmpDir, 'rg-env');
    const argumentsCapture = path.join(tmpDir, 'rg-args');
    const fakeRipgrep = path.join(tmpDir, 'fake-rg.sh');
    fs.writeFileSync(config, '--pre=/tmp/hostile-preprocessor\n');
    fs.writeFileSync(fakeRipgrep, [
      '#!/bin/sh',
      `printf '%s' "\${RIPGREP_CONFIG_PATH-<unset>}" > '${environmentCapture}'`,
      `printf '%s\\n' "$@" > '${argumentsCapture}'`,
      `printf '%s\\n' '{"type":"match","data":{"path":{"text":"app/src/MainActivity.kt"},"line_number":4,"lines":{"text":"  fun loadTimeline() = Unit\\n"}}}'`,
      '',
    ].join('\n'));
    fs.chmodSync(fakeRipgrep, 0o700);
    const previousConfig = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = config;
    try {
      const ref = register();
      const search = await service(fakeRipgrep).search({
        codebaseId: ref.codebaseId,
        scope,
        query: 'loadTimeline',
        mode: 'provider_send',
        contextLines: 0,
      });

      expect(search.success).toBe(true);
      expect(search.matches).toEqual([
        expect.objectContaining({
          filePath: 'app/src/MainActivity.kt',
          text: '  fun loadTimeline() = Unit',
        }),
      ]);
      expect(fs.readFileSync(environmentCapture, 'utf8')).toBe('');
      const args = fs.readFileSync(argumentsCapture, 'utf8').split('\n').filter(Boolean);
      expect(args).toContain('--no-config');
      expect(args).not.toContain('-L');
      expect(args).not.toContain('--follow');
    } finally {
      if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previousConfig;
    }
  });

  it('marks coverage incomplete when a ripgrep locator cannot be safely re-read', async () => {
    if (process.platform === 'win32') return;
    const fakeRipgrep = path.join(tmpDir, 'stale-rg.sh');
    fs.writeFileSync(fakeRipgrep, [
      '#!/bin/sh',
      `printf '%s\\n' '{"type":"match","data":{"path":{"text":"app/src/Missing.kt"},"line_number":1,"lines":{"text":"loadTimeline\\n"}}}'`,
      '',
    ].join('\n'));
    fs.chmodSync(fakeRipgrep, 0o700);
    const ref = register();

    const search = await service(fakeRipgrep).search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      matches: [],
      coverageComplete: false,
      searchIncompleteReason: 'traversal_error',
    }));
  });

  it('bounds concurrent source searches without starting an extra subprocess', async () => {
    if (process.platform === 'win32') return;
    const fakeRipgrep = path.join(tmpDir, 'slow-rg.sh');
    fs.writeFileSync(fakeRipgrep, [
      '#!/bin/sh',
      'sleep 0.2',
      `printf '%s\\n' '{"type":"match","data":{"path":{"text":"app/src/MainActivity.kt"},"line_number":4,"lines":{"text":"  fun loadTimeline() = Unit\\n"}}}'`,
      '',
    ].join('\n'));
    fs.chmodSync(fakeRipgrep, 0o700);
    const ref = register();
    const access = new OnDemandSourceAccessService({
      registry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      ripgrepPath: fakeRipgrep,
      maxConcurrentSearches: 1,
      concurrencyWaitTimeoutMs: 25,
      searchTimeoutMs: 1_000,
    });
    const input = {
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send' as const,
    };

    const first = access.search(input);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const second = await access.search(input);

    expect(second).toEqual(expect.objectContaining({
      success: true,
      matches: [],
      coverageComplete: false,
      searchIncompleteReason: 'time_budget',
    }));
    await expect(first).resolves.toEqual(expect.objectContaining({
      matches: [expect.objectContaining({filePath: 'app/src/MainActivity.kt'})],
    }));
  });

  it('pages a finished degraded walk when ripgrep and full preview are unavailable', async () => {
    for (let index = 0; index < 10; index += 1) {
      fs.writeFileSync(
        path.join(root, 'app', 'src', `Fallback${index}.kt`),
        `val fallbackNeedle${index} = Unit\n`,
      );
    }
    const ref = register();
    const access = new OnDemandSourceAccessService({
      registry,
      gate: new PathSecurityGate({
        allowlistRoots: [tmpDir],
        maxVisitedEntries: 4,
        maxSkippedDiagnostics: 2,
      }),
      ripgrepPath: '__smartperfetto_missing_rg__',
    });

    const search = await access.search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'fallbackNeedle',
      mode: 'provider_send',
      maxResults: 3,
    });

    // The walk finishes (it is not bounded by the preview gate); 3 of 10 is paging.
    expect(search).toEqual(expect.objectContaining({
      success: true,
      truncated: false,
      coverageComplete: true,
      moreResults: true,
      totalMatches: 10,
      enumerationBackend: 'node-walk',
      backendFidelity: 'degraded',
    }));
    expect(search.matches).toHaveLength(3);
  });

  it('enforces the node fallback deadline inside a wide directory', async () => {
    fs.writeFileSync(path.join(root, 'app', 'src', 'Second.kt'), 'val deadlineNeedle = Unit\n');
    const ref = register();
    const access = new OnDemandSourceAccessService({
      registry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      ripgrepPath: '__smartperfetto_missing_rg__',
      searchTimeoutMs: 1_000,
    });
    const node = access as any;
    const prepared = await node.prepareScopedLookup(ref, 'provider_send', undefined);
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2_000);

    try {
      const result = await node.searchCandidatesWithNode(ref, prepared, 'deadlineNeedle', true,
        () => true, () => 0);

      expect(result.stopReason).toBe('time_budget');
    } finally {
      now.mockRestore();
    }
  });

  it('preserves exact-file semantics for requested and registered path prefixes', async () => {
    const directoryFiltered = register();
    const requestedFile = await service().search({
      codebaseId: directoryFiltered.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
      pathPrefix: 'app/src/MainActivity.kt',
    });
    const fileFiltered = registry.register({
      kind: 'app_source',
      displayName: 'Exact File App',
      rootPath: root,
      pathFilters: ['app/src/MainActivity.kt'],
      sendToProvider: true,
      ...scope,
    });
    const registeredFile = await service().search({
      codebaseId: fileFiltered.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
    });

    expect(requestedFile.matches).toEqual([
      expect.objectContaining({filePath: 'app/src/MainActivity.kt'}),
    ]);
    expect(registeredFile.matches).toEqual([
      expect.objectContaining({filePath: 'app/src/MainActivity.kt'}),
    ]);
  });

  it('does not scan an exact path whose extension is outside the source allowlist', async () => {
    fs.writeFileSync(
      path.join(root, 'app', 'src', 'Secret.txt'),
      'loadTimeline\n'.repeat(14_000),
    );
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'loadTimeline',
      mode: 'provider_send',
      pathPrefix: 'app/src/Secret.txt',
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      matches: [],
      truncated: false,
    }));
  });

  it('does not let ignore or hidden-file rules override the registered source policy', async () => {
    fs.writeFileSync(path.join(root, '.ignore'), 'app/src/GitIgnored.kt\n');
    fs.writeFileSync(path.join(root, 'app', 'src', 'GitIgnored.kt'), 'val registeredNeedle = 1\n');
    fs.mkdirSync(path.join(root, 'app', 'src', '.internal'));
    fs.writeFileSync(
      path.join(root, 'app', 'src', '.internal', 'Hidden.kt'),
      'val registeredNeedle = 2\n',
    );
    const ref = register();

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'registeredNeedle',
      mode: 'provider_send',
    });

    expect(search.matches.map(match => match.filePath).sort()).toEqual([
      'app/src/.internal/Hidden.kt',
      'app/src/GitIgnored.kt',
    ]);
  });

  it('reports missing and drifted roots as unavailable instead of requiring reindex', () => {
    const ref = register();
    expect(codebaseOnDemandAvailability(ref)).toEqual({available: true});

    const original = `${root}-original`;
    fs.renameSync(root, original);

    expect(codebaseOnDemandAvailability(ref)).toEqual({
      available: false,
      reason: 'codebase_root_unavailable',
    });
  });
});

describe('registration-channel root authorization', () => {
  const readWithoutAllowlist = (codebaseId: string) => service('rg', []).read({codebaseId, scope,
    filePath: 'app/src/MainActivity.kt', mode: 'provider_send'});

  afterEach(() => resetRegistrationChannelTrustForTests());

  it('reads a native-picker root without a configured allowlist', async () => {
    await expect(readWithoutAllowlist(register(true, 'native_picker').codebaseId)).resolves.toMatchObject({success: true});
  });

  it('requires the configured allowlist for local_cli and unrecorded roots until the CLI opts in', async () => {
    const cli = register(true, 'local_cli');
    const legacy = register(true);
    await expect(readWithoutAllowlist(cli.codebaseId)).rejects.toThrow('root_outside_allowlist');
    await expect(readWithoutAllowlist(legacy.codebaseId)).rejects.toThrow('root_outside_allowlist');
    trustLocalCliRegistrations();
    await expect(readWithoutAllowlist(cli.codebaseId)).resolves.toMatchObject({success: true});
    await expect(readWithoutAllowlist(legacy.codebaseId)).resolves.toMatchObject({success: true});
  });
});

describe('file-level read failures', () => {
  it('reports a missing file without the registered absolute root', async () => {
    const ref = register();
    const read = await service().read({codebaseId: ref.codebaseId, scope,
      filePath: 'app/src/Missing.kt', mode: 'provider_send'});
    expect(read).toMatchObject({success: false, unsupportedReason: 'source_file_not_found'});
    expect(JSON.stringify(read)).not.toContain(root);
  });

  it('returns the file length when the requested start line is past the end', async () => {
    const ref = register();
    const read = await service().read({codebaseId: ref.codebaseId, scope,
      filePath: 'app/src/MainActivity.kt', startLine: 99, mode: 'provider_send'});
    expect(read).toMatchObject({success: false, unsupportedReason: 'source_line_out_of_range',
      window: {totalLines: 7}});
  });

  describe('search and read v2', () => {
    const backends = [['ripgrep', 'rg'], ['node', '__smartperfetto_missing_rg__']] as const;
    const write = (relativePath: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, relativePath)), {recursive: true});
      fs.writeFileSync(path.join(root, relativePath), content);
    };

    it.each(backends)('ranks declarations and trace sites above uses and test paths (%s)', async (backend, rgPath) => {
      write('app/src/a/Caller.kt', 'fun call() {\n  StartupHooks.warmUp()\n}\n');
      write('app/src/test/WarmUpTest.kt', 'fun warmUp() = check()\n');
      write('app/src/z/StartupHooks.kt', 'object StartupHooks {\n  fun warmUp() {\n    Trace.beginSection("warmUp")\n  }\n}\n');
      const ref = register();
      const search = await service(rgPath).search({codebaseId: ref.codebaseId, scope, query: 'warmUp',
        mode: 'provider_send', contextLines: 0});

      expect(search.backend).toBe(backend);
      // A file's hits stay together (adjacent lines share a window); files
      // follow their best hit, and test code ranks below every production hit.
      expect(search.matches.map(match => [match.filePath, match.matchLines])).toEqual([
        ['app/src/z/StartupHooks.kt', [2, 3]],
        ['app/src/a/Caller.kt', [2]],
        ['app/src/test/WarmUpTest.kt', [1]],
      ]);
      expect(search).toEqual(expect.objectContaining({totalMatches: 4, fileCount: 3, moreResults: false,
        traversal: 'complete', caseSensitive: true}));
    });

    it.each(backends)('uses smart case and filters by file glob (%s)', async (_backend, rgPath) => {
      write('app/src/one/Frame.kt', 'val frameNeedle = 1\n');
      write('app/src/two/frame.java', 'int FRAMENEEDLE = 2;\n');
      const ref = register();
      const access = service(rgPath);
      const insensitive = await access.search({codebaseId: ref.codebaseId, scope, query: 'frameneedle',
        mode: 'provider_send'});
      const sensitive = await access.search({codebaseId: ref.codebaseId, scope, query: 'FRAMENEEDLE',
        mode: 'provider_send'});
      const globbed = await access.search({codebaseId: ref.codebaseId, scope, query: 'frameneedle',
        mode: 'provider_send', fileGlob: '*.kt'});

      expect(insensitive.caseSensitive).toBe(false);
      expect(insensitive.matches.map(match => match.filePath).sort())
        .toEqual(['app/src/one/Frame.kt', 'app/src/two/frame.java']);
      expect(sensitive.matches.map(match => match.filePath)).toEqual(['app/src/two/frame.java']);
      expect(globbed.matches.map(match => match.filePath)).toEqual(['app/src/one/Frame.kt']);
      await expect(access.search({codebaseId: ref.codebaseId, scope, query: 'x', mode: 'provider_send',
        fileGlob: '../*.kt'})).rejects.toThrow('source_file_glob_invalid');
    });

    it.each(backends)('returns only the location of a hit in a file above the read limit (%s)', async (_backend, rgPath) => {
      write('app/src/Big.kt', `${'// filler line\n'.repeat(200)}val bigNeedle = 1\n`);
      const ref = register();
      const access = new OnDemandSourceAccessService({registry, gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
        ripgrepPath: rgPath, readMaxFileBytes: 1_024});

      const search = await access.search({codebaseId: ref.codebaseId, scope, query: 'bigNeedle', mode: 'provider_send'});
      const read = await access.read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/Big.kt', mode: 'provider_send'});

      expect(search.matches).toEqual([expect.objectContaining({
        lineRange: {start: 201, end: 201}, matchLines: [201], bodyUnavailable: 'file_too_large'})]);
      expect(search.matches[0]).not.toHaveProperty('text');
      expect(search.coverageComplete).toBe(true);
      expect(read).toMatchObject({success: false, unsupportedReason: 'source_file_too_large'});
    });

    it('stamps search and read ranges with the live content they came from', async () => {
      write('app/src/Version.kt', 'class Version {\n  fun versionNeedle() = 1\n}\n');
      const ref = register();
      const access = service();
      const search = await access.search({codebaseId: ref.codebaseId, scope, query: 'versionNeedle', mode: 'provider_send'});
      const sameRead = await access.read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/Version.kt', mode: 'provider_send'});
      write('app/src/Version.kt', 'class Version {\n  fun versionNeedle() = 2\n}\n');
      const changedRead = await access.read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/Version.kt', mode: 'provider_send'});

      const hitVersion = search.matches[0]?.sourceGeneration;
      expect(hitVersion).toMatch(/^live-[0-9a-f]{16}$/);
      expect(sameRead.reference?.sourceGeneration).toBe(hitVersion);
      // A changed file never vouches for the hit that searched the old one.
      expect(changedRead.reference?.sourceGeneration).not.toBe(hitVersion);
    });

    it('reads around a line and names the enclosing declaration', async () => {
      write('app/src/Window.kt', ['class Window {', ...Array.from({length: 30}, (_, i) => `  // ${i}`),
        '  fun render() {', '    draw()', '  }', '}'].join('\n'));
      const ref = register();
      const read = await service().read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/Window.kt',
        aroundLine: 33, maxLines: 5, mode: 'provider_send'});

      expect(read.reference?.lineRange).toEqual({start: 31, end: 35});
      expect(read.window?.enclosingSymbol).toEqual({name: 'Window', line: 1, heuristic: true});
      await expect(service().read({codebaseId: ref.codebaseId, scope, filePath: 'app/src/Window.kt',
        aroundLine: 33, startLine: 1, mode: 'provider_send'})).resolves.toMatchObject({
        success: false, unsupportedReason: 'source_read_window_conflict'});
    });

    it.each(backends)('suggests files with the same name when a read misses (%s)', async (_backend, rgPath) => {
      write('app/src/deep/StartupHooks.kt', 'object StartupHooks\n');
      const ref = register();
      const read = await service(rgPath).read({codebaseId: ref.codebaseId, scope,
        filePath: 'app/src/StartupHooks.kt', mode: 'provider_send'});

      expect(read).toMatchObject({success: false, unsupportedReason: 'source_file_not_found',
        candidates: ['app/src/deep/StartupHooks.kt']});
    });

    it.each(backends)('finds files by name, path or glob without reading them (%s)', async (backend, rgPath) => {
      write('app/src/ui/RenderThread.kt', 'class RenderThread\n');
      write('app/src/ui/RenderThreadTest.kt', 'class RenderThreadTest\n');
      write('app/src/generated/RenderThreadGen.kt', 'class Gen\n');
      const ref = register();
      const access = service(rgPath);
      const byName = await access.find({codebaseId: ref.codebaseId, scope, pattern: 'renderthread', mode: 'metadata_only'});
      const byGlob = await access.find({codebaseId: ref.codebaseId, scope, pattern: 'ui/*Test.kt', mode: 'metadata_only'});

      expect(byName).toEqual(expect.objectContaining({success: true, backend, traversal: 'complete',
        coverageComplete: true, totalFiles: 2, moreResults: false}));
      // Exact name first; the registered exclude glob keeps generated files out.
      expect(byName.files).toEqual([{filePath: 'app/src/ui/RenderThread.kt'}, {filePath: 'app/src/ui/RenderThreadTest.kt'}]);
      expect(byGlob.files).toEqual([]);
      const anchored = await access.find({codebaseId: ref.codebaseId, scope, pattern: 'app/src/ui/*Test.kt', mode: 'metadata_only'});
      expect(anchored.files).toEqual([{filePath: 'app/src/ui/RenderThreadTest.kt'}]);
      expect(JSON.stringify(byName)).not.toContain(root);
    });

    it.each(backends)('withholds files outside the provider grant from find (%s)', async (_backend, rgPath) => {
      fs.mkdirSync(path.join(root, 'app', 'private'), {recursive: true});
      fs.writeFileSync(path.join(root, 'app', 'private', 'Hidden.kt'), 'class Hidden\n');
      const registered = registry.register({kind: 'app_source', displayName: 'Narrow grant', rootPath: root,
        pathFilters: ['app/src'], sendToProvider: true, ...scope});
      const ref = registry.updateSelectionPolicy(registered.codebaseId, scope, {pathFilters: ['app']});

      const sent = await service(rgPath).find({codebaseId: ref.codebaseId, scope, pattern: 'Hidden', mode: 'provider_send'});
      const located = await service(rgPath).find({codebaseId: ref.codebaseId, scope, pattern: 'Hidden', mode: 'metadata_only'});

      expect(sent).toEqual(expect.objectContaining({files: [], coverageComplete: false,
        searchIncompleteReason: 'provider_grant_scope'}));
      expect(located.files).toEqual([{filePath: 'app/private/Hidden.kt'}]);
    });
  });
});
