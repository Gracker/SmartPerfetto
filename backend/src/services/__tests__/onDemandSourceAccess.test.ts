// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {
  OnDemandSourceAccessService,
  codebaseOnDemandAvailability,
} from '../codebase/onDemandSourceAccess';
import {PathSecurityGate} from '../codebase/pathSecurityGate';

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

function register(sendToProvider = true) {
  return registry.register({
    kind: 'app_source',
    displayName: 'Demo App',
    rootPath: root,
    pathFilters: ['app/src'],
    excludeGlobs: ['**/generated/**'],
    sendToProvider,
    ...scope,
  });
}

function service(ripgrepPath = 'rg') {
  return new OnDemandSourceAccessService({
    registry,
    gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
    ripgrepPath,
  });
}

describe('OnDemandSourceAccessService', () => {
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
    expect(JSON.stringify(read)).not.toContain('class MainActivity');
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
    })).rejects.toThrow('source_path_outside_provider_grant');
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

    const search = await service().search({
      codebaseId: ref.codebaseId,
      scope,
      query: 'commonNeedle',
      mode: 'provider_send',
      maxResults: 8,
    });

    expect(search).toEqual(expect.objectContaining({
      success: true,
      truncated: true,
      coverageComplete: false,
      searchIncompleteReason: 'enumeration_budget',
      enumerationBackend: 'ripgrep',
      backendFidelity: 'exact',
    }));
    expect(search.matches).toHaveLength(8);
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

  it('returns bounded degraded coverage when ripgrep and full preview are unavailable', async () => {
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

    expect(search).toEqual(expect.objectContaining({
      success: true,
      truncated: true,
      coverageComplete: false,
      searchIncompleteReason: 'backend_degraded',
      enumerationBackend: 'node-walk',
      backendFidelity: 'degraded',
    }));
    expect(search.matches).toHaveLength(3);
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
