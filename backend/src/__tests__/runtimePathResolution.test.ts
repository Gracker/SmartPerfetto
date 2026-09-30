// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Runtime roots are resolved on use, never while a module is evaluated.
 *
 * The npm CLI imports its whole module graph before `bootstrap()` sets
 * SMARTPERFETTO_BACKEND_LOG_DIR / _DATA_DIR and pins cwd to the package root.
 * A module-scope `backendLogPath(...)` therefore captures `<shell cwd>/logs`
 * and the CLI writes its stores wherever the user happened to run `smp`.
 */

import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';
import * as ts from 'typescript';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
const CLI_ENTRY = path.join(SRC_ROOT, 'cli-user', 'bin.ts');
// bin.ts imports this first so env files load before the rest evaluates. The
// probe leaves it out on purpose: modules must not resolve runtime paths at
// import even when nothing prepared the environment (tests, scripts, the Web
// server), so it loads them in that worst-case order and bootstraps after.
const CLI_ENV_ENTRY = path.join(SRC_ROOT, 'cli-user', 'envEntry.ts');

/**
 * Functions whose result depends on env or cwd at the moment they run. The
 * static guard sees direct calls only; the CLI probe below also catches
 * indirect ones (a module-scope wrapper or constructor), for the CLI graph.
 */
const RUNTIME_ROOT_RESOLVERS = new Set([
  'backendLogPath',
  'backendDataPath',
  'userDataPath',
  'resolveUserDataRoot',
  'process.cwd',
]);

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runtimeImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** Every repository module the CLI entry can load, static or lazy. */
function cliModuleGraph(): string[] {
  const seen = new Set<string>();
  const pending = [CLI_ENTRY];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    for (const specifier of runtimeImportSpecifiers(sourceFile)) {
      const resolved = resolveLocalImport(file, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return [...seen].sort();
}

function productionSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests are not production modules; entry scripts own their process,
      // so cwd and env do not change under them after import.
      if (!['__tests__', '__mocks__', 'tests', 'scripts'].includes(entry.name)) {
        productionSourceFiles(entryPath, out);
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

function calleeName(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.getText(sourceFile);
  return '';
}

/** True when the node runs only once something calls or constructs it. */
function runsAfterModuleEvaluation(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      if (!isImmediatelyInvoked(current)) return true;
      continue;
    }
    if (ts.isPropertyDeclaration(current)
      && !(ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Static)) {
      return true;
    }
  }
  return false;
}

function isImmediatelyInvoked(fn: ts.Node): boolean {
  let callee: ts.Node = fn;
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
}

function moduleScopeResolverCalls(fileName: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node, sourceFile);
      if (RUNTIME_ROOT_RESOLVERS.has(name) && !runsAfterModuleEvaluation(node)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        hits.push(`${fileName}:${line} ${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

/**
 * Runs in a child process under tsx, the loader `smp` uses from source: load
 * every CLI module from an unrelated shell cwd, recording each repository
 * frame that asks for cwd while modules evaluate; then bootstrap exactly as
 * bin.ts does and write through the stores the analysis path uses.
 */
const CLI_ORDER_PROBE = String.raw`
const fs = require('fs');
const path = require('path');
const input = JSON.parse(process.env.RUNTIME_PATH_PROBE_INPUT);
const srcRoot = input.srcRoot + path.sep;
const runtimePathsFile = path.join(input.srcRoot, 'runtimePaths.ts');

process.chdir(input.shellCwd);
Error.stackTraceLimit = 64;
const realCwd = process.cwd.bind(process);
const importTimeResolutions = [];
let evaluatingModules = true;
process.cwd = function probedCwd() {
  if (evaluatingModules) {
    const sites = (new Error().stack || '').split('\n').slice(2)
      .map(line => {
        const frame = line.match(/\((.+):(\d+):\d+\)$/) || line.match(/^\s*at (.+):(\d+):\d+$/);
        return frame ? frame[1] + ':' + frame[2] : '';
      });
    let index = 0;
    while (index < sites.length && sites[index].startsWith(runtimePathsFile + ':')) index += 1;
    const site = sites[index] || '';
    if (site.startsWith(srcRoot)) importTimeResolutions.push(path.relative(input.backendRoot, site));
  }
  return realCwd();
};

const loadFailures = [];
for (const modulePath of input.modules) {
  try {
    require(modulePath);
  } catch (err) {
    loadFailures.push(path.relative(input.backendRoot, modulePath) + ': ' + String(err && err.message).split('\n')[0]);
  }
}
evaluatingModules = false;

(async () => {
  const load = rel => require(path.join(input.srcRoot, rel));
  load('cli-user/bootstrap.ts').bootstrap({envFile: input.envFile});

  load('agentv3/agentMetrics.ts').persistSessionMetrics({sessionId: input.probeId, toolExecutions: []});
  const note = load('agentv3/selfImprove/skillNotesWriter.ts').writeSkillNote({
    failureCategoryEnum: 'unknown',
    evidenceSummary: 'runtime path probe',
    skillId: input.probeId,
    sourceSessionId: input.probeId,
    sourceTurnIndex: 0,
    failureModeHash: 'cafebabe12345678',
  });
  const notesRead = load('agentv3/selfImprove/skillNotesInjector.ts')
    .loadSkillNotesFromSources(input.probeId, {curatedDir: input.emptyDir}).length;
  const durableLearning = load('services/security/durableLearning.ts');
  const learning = durableLearning.resolveDurableLearningPermission(durableLearning.withDurableLearningPermission(
    {runId: input.probeId}, load('services/security/analysisPrivateContext.ts').NO_PRIVATE_CONTEXT));
  await load('agentv3/analysisPatternMemory.ts')
    .saveAnalysisPattern(['arch:standard', 'scene:scrolling'], ['runtime path probe'], 'scrolling', undefined, undefined,
      {learning});

  fs.writeFileSync(input.resultFile, JSON.stringify({
    moduleCount: input.modules.length,
    loadFailures,
    importTimeResolutions,
    logRoot: process.env.SMARTPERFETTO_BACKEND_LOG_DIR,
    noteWritten: Boolean(note && note.ok),
    notesRead,
  }));
  process.exit(0);
})().catch(err => {
  fs.writeFileSync(input.resultFile, JSON.stringify({fatal: String(err && err.stack || err)}));
  process.exit(1);
});
`;

interface ProbeResult {
  moduleCount: number;
  loadFailures: string[];
  importTimeResolutions: string[];
  logRoot: string;
  noteWritten: boolean;
  notesRead: number;
  fatal?: string;
}

describe('runtime path resolution under the CLI bootstrap order', () => {
  const tempDirs: string[] = [];
  const makeTempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('resolves no runtime path while loading and writes stores under the configured log root', () => {
    const shellCwd = makeTempDir('smp-shell-cwd-');
    const home = makeTempDir('smp-home-');
    const emptyDir = makeTempDir('smp-empty-');
    const envFile = path.join(home, 'probe.env');
    fs.writeFileSync(envFile, '');
    const resultFile = path.join(home, 'probe-result.json');
    const probeId = `runtime_path_probe_${process.pid}`;
    const modules = cliModuleGraph().filter(file => file !== CLI_ENTRY && file !== CLI_ENV_ENTRY);

    const child = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', CLI_ORDER_PROBE], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        SMARTPERFETTO_HOME: home,
        RUNTIME_PATH_PROBE_INPUT: JSON.stringify({
          srcRoot: SRC_ROOT,
          backendRoot: BACKEND_ROOT,
          shellCwd,
          envFile,
          emptyDir,
          resultFile,
          probeId,
          modules,
        }),
      },
    });
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as ProbeResult;
    expect(result.fatal).toBeUndefined();
    expect(child.status).toBe(0);

    expect(result.moduleCount).toBeGreaterThan(100);
    expect(result.loadFailures).toEqual([]);
    expect(result.importTimeResolutions).toEqual([]);

    const logRoot = path.join(home, 'runtime', 'logs');
    expect(result.logRoot).toBe(logRoot);
    expect(result.noteWritten).toBe(true);
    expect(result.notesRead).toBe(1);
    expect(fs.existsSync(path.join(logRoot, 'metrics', `session_${probeId}_metrics.json`))).toBe(true);
    expect(fs.existsSync(path.join(logRoot, 'skill_notes', `${probeId}.notes.json`))).toBe(true);
    expect(fs.existsSync(path.join(logRoot, 'analysis_patterns.json'))).toBe(true);
    expect(fs.existsSync(path.join(shellCwd, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(BACKEND_ROOT, 'logs', 'metrics', `session_${probeId}_metrics.json`))).toBe(false);
  }, 300_000);
});

describe('module-scope runtime path guard', () => {
  it('keeps every production module free of module-evaluation root resolution', () => {
    const hits = productionSourceFiles(SRC_ROOT).flatMap(file =>
      moduleScopeResolverCalls(path.relative(BACKEND_ROOT, file), fs.readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('recognizes module evaluation, including in-place invocations and static members', () => {
    const source = [
      "const a = backendLogPath('a');",
      "const b = (() => backendDataPath('b'))();",
      "class C { static d = userDataPath('d'); e = backendLogPath('e'); static { process.cwd(); } }",
      "const f = () => backendLogPath('f');",
      "function g(dir = backendLogPath('g')) { return process.cwd(); }",
    ].join('\n');
    expect(moduleScopeResolverCalls('guard.ts', source)).toEqual([
      'guard.ts:1 backendLogPath()',
      'guard.ts:2 backendDataPath()',
      'guard.ts:3 userDataPath()',
      'guard.ts:3 process.cwd()',
    ]);
  });
});
