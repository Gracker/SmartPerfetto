// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {GitNexusCodeGraphNavigator} from '../codebase/gitNexusCodeGraphNavigator';
import {PathSecurityGate} from '../codebase/pathSecurityGate';

const scope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GITNEXUS_HOME = process.env.GITNEXUS_HOME;

let tmpDir: string;
let root: string;
let registry: CodebaseRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-navigator-test-'));
  root = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(root, 'app', 'src'), {recursive: true});
  fs.mkdirSync(path.join(root, 'app', 'generated'), {recursive: true});
  fs.writeFileSync(path.join(root, 'app', 'src', 'StartupHooks.kt'), 'class StartupHooks\n');
  fs.writeFileSync(path.join(root, 'app', 'generated', 'Generated.kt'), 'class Generated\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.gitnexus/\n');
  execFileSync('git', ['init'], {cwd: root});
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: root});
  execFileSync('git', ['config', 'user.name', 'Test User'], {cwd: root});
  execFileSync('git', ['add', '.'], {cwd: root});
  execFileSync('git', ['commit', '-m', 'initial'], {cwd: root});
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  fs.mkdirSync(path.join(root, '.gitnexus'), {recursive: true});
  fs.writeFileSync(path.join(root, '.gitnexus', 'meta.json'), JSON.stringify({
    lastCommit: head,
  }));
  registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }
  if (ORIGINAL_GITNEXUS_HOME === undefined) {
    delete process.env.GITNEXUS_HOME;
  } else {
    process.env.GITNEXUS_HOME = ORIGINAL_GITNEXUS_HOME;
  }
});

function register(
  pathFilters: string[] = ['app/src'],
  excludeGlobs: string[] = ['**/generated/**'],
) {
  return registry.register({
    kind: 'app_source',
    displayName: 'Demo App',
    rootPath: root,
    rootAuthorization: 'native_picker',
    pathFilters,
    excludeGlobs,
    sendToProvider: true,
    ...scope,
  });
}

function fakeGitNexus(output: unknown, capturePath = path.join(tmpDir, 'capture.json')): string {
  const command = path.join(
    tmpDir,
    `gitnexus-fake-${path.basename(capturePath).replace(/[^a-zA-Z0-9_.-]/g, '_')}.js`,
  );
  fs.writeFileSync(command, [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({argv: process.argv.slice(2), env: process.env}));`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`,
    '',
  ].join('\n'));
  fs.chmodSync(command, 0o755);
  return command;
}

function service(command: string, timeoutMs = 10_000) {
  return new GitNexusCodeGraphNavigator({
    registry,
    gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
    command,
    timeoutMs,
  });
}

describe('GitNexusCodeGraphNavigator', () => {
  it('queries GitNexus with a trusted root and sanitizes references without --content', async () => {
    process.env.OPENAI_API_KEY = 'secret-openai-key';
    process.env.GITNEXUS_HOME = path.join(tmpDir, 'gitnexus-home');
    const ref = register([], []);
    const capturePath = path.join(tmpDir, 'capture.json');
    const canonicalRoot = fs.realpathSync(root);
    const command = fakeGitNexus({
      results: [
        {
          filePath: path.join(canonicalRoot, 'app', 'src', 'StartupHooks.kt'),
          line: 7,
          symbol: `StartupHooks.install ${canonicalRoot}`,
          kind: `function ${canonicalRoot}`,
          content: 'PRIVATE_SOURCE_CANARY',
        },
      ],
      affected_processes: [{
        processName: 'StartupFlow',
        processType: 'cross_community',
        summary: `Uses ${root}/app/src/StartupHooks.kt`,
      }],
    }, capturePath);
    const result = await service(command).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
      limit: 5,
    });
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));

    expect(capture.argv).toEqual([
      'query',
      '--repo',
      canonicalRoot,
      '--query=StartupHooks',
      '--limit',
      '5',
    ]);
    expect(capture.argv).not.toContain('--content');
    expect(capture.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(capture.env.GITNEXUS_HOME).toBe(path.join(tmpDir, 'gitnexus-home'));
    expect(result).toEqual(expect.objectContaining({
      success: true,
      graph: {engine: 'gitnexus', freshness: 'current', verificationRequired: true},
      references: [expect.objectContaining({
        codebaseId: ref.codebaseId,
        filePath: 'app/src/StartupHooks.kt',
        lineRange: {start: 7, end: 7},
        symbol: 'StartupHooks.install [registered-root]',
        kind: 'function [path]',
      })],
      processes: [expect.objectContaining({name: 'StartupFlow'})],
    }));
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_CANARY');
    expect(JSON.stringify(result)).not.toContain('/app/src/StartupHooks.kt');
  });

  it('filters traversal, excluded paths, outside roots, and disallowed extensions', async () => {
    const ref = register();
    const command = fakeGitNexus({
      results: [
        {filePath: 'app/src/StartupHooks.kt', line: 1, symbol: 'allowed'},
        {filePath: '../outside/Secret.kt', line: 1, symbol: 'traversal'},
        {filePath: path.join(tmpDir, 'outside', 'Secret.kt'), line: 1, symbol: 'outside'},
        {filePath: 'app/generated/Generated.kt', line: 1, symbol: 'excluded'},
        {filePath: 'app/src/notes.txt', line: 1, symbol: 'extension'},
      ],
      affected_processes: [{
        processName: 'ExcludedGeneratedFlowCanary',
        processType: 'cross_community',
        summary: 'GeneratedSecretCanary',
      }],
    });

    const result = await service(command).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
      limit: 10,
    });

    expect(result.references).toEqual([
      expect.objectContaining({filePath: 'app/src/StartupHooks.kt', symbol: 'allowed'}),
    ]);
    expect(result.processes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Secret.kt');
    expect(JSON.stringify(result)).not.toContain('Generated.kt');
    expect(JSON.stringify(result)).not.toContain('notes.txt');
    expect(JSON.stringify(result)).not.toContain('ExcludedGeneratedFlowCanary');
    expect(JSON.stringify(result)).not.toContain('GeneratedSecretCanary');
  });

  it('marks stale indexes as verification-required navigation', async () => {
    fs.writeFileSync(path.join(root, '.gitnexus', 'meta.json'), JSON.stringify({
      lastCommit: 'b'.repeat(40),
    }));
    const ref = register();
    const command = fakeGitNexus({results: [{filePath: 'app/src/StartupHooks.kt', line: 1}]});

    const result = await service(command).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    });

    expect(result.graph).toEqual({
      engine: 'gitnexus',
      freshness: 'stale',
      verificationRequired: true,
    });
    expect(result.success).toBe(true);
  });

  it('marks dirty worktrees as stale even when the indexed commit matches HEAD', async () => {
    const ref = register();
    fs.writeFileSync(path.join(root, 'app', 'src', 'Dirty.kt'), 'class Dirty\n');
    const command = fakeGitNexus({results: [{filePath: 'app/src/StartupHooks.kt', line: 1}]});

    const result = await service(command).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    });

    expect(result.graph).toEqual({
      engine: 'gitnexus',
      freshness: 'stale',
      verificationRequired: true,
    });
  });

  it('returns structured fallback for missing index and missing binary', async () => {
    const ref = register();
    fs.rmSync(path.join(root, '.gitnexus'), {recursive: true, force: true});

    await expect(service('__missing_gitnexus__').query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'missing_gitnexus_index',
    }));

    fs.mkdirSync(path.join(root, '.gitnexus'), {recursive: true});
    await expect(service(path.join(tmpDir, 'missing-binary')).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'missing_gitnexus_binary',
    }));
  });

  it('returns structured fallback for malformed JSON, timeout, and nonzero exit', async () => {
    const ref = register();
    const malformed = path.join(tmpDir, 'malformed.js');
    fs.writeFileSync(malformed, '#!/usr/bin/env node\nprocess.stdout.write("not-json");\n');
    fs.chmodSync(malformed, 0o755);
    const timeout = path.join(tmpDir, 'timeout.js');
    fs.writeFileSync(timeout, '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);\n');
    fs.chmodSync(timeout, 0o755);
    const nonzero = path.join(tmpDir, 'nonzero.js');
    fs.writeFileSync(nonzero, '#!/usr/bin/env node\nconsole.error("ABSOLUTE /secret/path"); process.exit(2);\n');
    fs.chmodSync(nonzero, 0o755);

    await expect(service(malformed).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'malformed_gitnexus_json',
    }));
    await expect(service(timeout, 20).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'gitnexus_timeout',
    }));
    const failed = await service(nonzero).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'StartupHooks',
    });
    expect(failed).toEqual(expect.objectContaining({
      success: false,
      unsupportedReason: 'gitnexus_nonzero_exit',
    }));
    expect(JSON.stringify(failed)).not.toContain('/secret/path');
  });

  it('inspects symbols with an optional registered relative file path', async () => {
    const ref = register();
    const capturePath = path.join(tmpDir, 'inspect-capture.json');
    const command = fakeGitNexus({
      references: [{file: 'app/src/StartupHooks.kt', startLine: 3, endLine: 4, name: 'StartupHooks'}],
    }, capturePath);
    const canonicalRoot = fs.realpathSync(root);

    const result = await service(command).inspectSymbol({
      codebaseId: ref.codebaseId,
      scope,
      symbol: 'StartupHooks',
      filePath: 'app/src/StartupHooks.kt',
      limit: 3,
    });
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));

    expect(capture.argv).toEqual([
      'context',
      '--repo',
      canonicalRoot,
      '--file=app/src/StartupHooks.kt',
      '--limit',
      '3',
      '--',
      'StartupHooks',
    ]);
    expect(result.references[0]).toEqual(expect.objectContaining({
      filePath: 'app/src/StartupHooks.kt',
      lineRange: {start: 3, end: 4},
      symbol: 'StartupHooks',
    }));
  });

  it('recognizes real GitNexus process schemas without treating file IDs as processes', async () => {
    const ref = register([], []);
    const rootCanary = fs.realpathSync(root);
    const queryCommand = fakeGitNexus({
      definitions: [{
        filePath: 'app/src/StartupHooks.kt',
        startLine: 2,
        endLine: 3,
        id: 'File:app/src/StartupHooks.kt',
        summary: 'definition summary should not become a process',
      }],
      processes: [
        {
          id: 'proc_startup',
          summary: `Startup flow references ${rootCanary}/app/src/StartupHooks.kt`,
          process_type: `cross_community ${rootCanary}`,
        },
        {
          id: 'proc_fallback',
          process_type: 'analysis',
        },
      ],
    }, path.join(tmpDir, 'query-process-capture.json'));
    const contextCommand = fakeGitNexus({
      context: {
        process: {
          id: 'proc_context',
          name: `Context flow ${rootCanary}`,
          step_index: 1,
          step_count: 4,
        },
      },
      definitions: [{
        id: 'File:app/src/StartupHooks.kt',
        summary: 'file definition only',
      }],
    }, path.join(tmpDir, 'context-process-capture.json'));

    const query = await service(queryCommand).query({
      codebaseId: ref.codebaseId,
      scope,
      query: 'createClaudeMcpServer',
      limit: 2,
    });
    const context = await service(contextCommand).inspectSymbol({
      codebaseId: ref.codebaseId,
      scope,
      symbol: 'StartupHooks',
      limit: 2,
    });

    expect(query.references).toEqual([
      expect.objectContaining({
        filePath: 'app/src/StartupHooks.kt',
        lineRange: {start: 2, end: 3},
      }),
    ]);
    expect(query.processes).toEqual([
      expect.objectContaining({
        name: 'Startup flow references [registered-root][path]',
        kind: 'cross_community [path]',
      }),
      expect.objectContaining({
        name: 'proc_fallback',
        kind: 'analysis',
      }),
    ]);
    expect(context.processes).toEqual([
      expect.objectContaining({
        name: 'Context flow [registered-root]',
      }),
    ]);
    expect(JSON.stringify({query, context})).not.toContain('definition summary should not become a process');
    expect(JSON.stringify({query, context})).not.toContain(rootCanary);
  });

  it('keeps malicious --content values from becoming GitNexus flags', async () => {
    const ref = register();
    fs.writeFileSync(path.join(root, 'app', 'src', '--content.kt'), 'class ContentNamedFile\n');
    const queryCapture = path.join(tmpDir, 'query-content-capture.json');
    const inspectCapture = path.join(tmpDir, 'inspect-content-capture.json');
    const queryCommand = fakeGitNexus({
      results: [{
        filePath: 'app/src/StartupHooks.kt',
        line: 1,
        symbol: '--content',
        content: 'PRIVATE_SOURCE_CANARY',
      }],
    }, queryCapture);
    const inspectCommand = fakeGitNexus({
      references: [{
        file: 'app/src/--content.kt',
        line: 1,
        name: '--content',
        content: 'PRIVATE_SOURCE_CANARY',
      }],
    }, inspectCapture);

    const query = await service(queryCommand).query({
      codebaseId: ref.codebaseId,
      scope,
      query: '--content',
    });
    const inspect = await service(inspectCommand).inspectSymbol({
      codebaseId: ref.codebaseId,
      scope,
      symbol: '--content',
      filePath: 'app/src/--content.kt',
    });
    const queryArgv = JSON.parse(fs.readFileSync(queryCapture, 'utf8')).argv;
    const inspectArgv = JSON.parse(fs.readFileSync(inspectCapture, 'utf8')).argv;

    expect(queryArgv).toContain('--query=--content');
    expect(queryArgv).not.toContain('--content');
    expect(inspectArgv).toEqual([
      'context',
      '--repo',
      fs.realpathSync(root),
      '--file=app/src/--content.kt',
      '--limit',
      '8',
      '--',
      '--content',
    ]);
    expect(inspectArgv.slice(0, inspectArgv.indexOf('--'))).not.toContain('--content');
    expect(JSON.stringify({query, inspect})).not.toContain('PRIVATE_SOURCE_CANARY');
  });
});
