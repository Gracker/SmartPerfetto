import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '../..');
const {
  generateFullStdlibDocs,
  loadFullStdlibDocs,
  normalizeModuleDoc,
} = require('../../backend/scripts/perfetto-stdlib-docs.cjs');
const {
  parseRuntimeRevision,
  runRuntimeAssetGeneration,
} = require('../../backend/scripts/perfetto-runtime-source.cjs');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-stdlib-docs-test-'));
  const stdlibRoot = path.join(root, 'perfetto', 'src', 'trace_processor', 'perfetto_sql', 'stdlib');
  fs.mkdirSync(path.join(stdlibRoot, 'zeta'), {recursive: true});
  fs.mkdirSync(path.join(stdlibRoot, 'alpha'), {recursive: true});
  fs.writeFileSync(path.join(stdlibRoot, 'zeta', 'two.sql'), '-- two\n');
  fs.writeFileSync(path.join(stdlibRoot, 'alpha', 'one.sql'), '-- one\n');
  return {root, stdlibRoot};
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function writeRuntimeAssetOutputs(repoRoot, revision) {
  for (const relativePath of [
    'backend/data/perfettoSqlDocs.json',
    'backend/data/perfettoStdlibSymbols.json',
    'backend/data/perfettoSqlIndex.light.json',
    'backend/data/perfettoSqlIndex.json',
  ]) {
    writeJson(path.join(repoRoot, relativePath), {generatedFrom: revision});
  }
}

const fullDocs = [
  {
    name: 'android',
    modules: [
      {
        module_name: 'android.example',
        module_doc: {name: 'Example', desc: 'Observed module documentation.'},
      },
    ],
  },
];

test('keeps legacy full documentation without invoking the upstream generator', () => {
  const {root, stdlibRoot} = createFixture();
  try {
    const docsPath = path.join(root, 'stdlib_docs.json');
    writeJson(docsPath, fullDocs);
    let called = false;

    const loaded = loadFullStdlibDocs({
      docsPath,
      repoRoot: root,
      stdlibRoot,
      runGenerator() {
        called = true;
      },
    });

    assert.equal(called, false);
    assert.equal(loaded.sourceDocsMode, 'full-json');
    assert.deepEqual(loaded.docs, fullDocs);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('expands metadata-only documentation with sorted absolute SQL inputs and cleans temp files', () => {
  const {root, stdlibRoot} = createFixture();
  let tempRoot;
  try {
    const docsPath = path.join(root, 'stdlib_docs.json');
    writeJson(docsPath, {
      'android.example': {tags: ['android'], includes: [], data_check_sql: null},
    });

    const loaded = loadFullStdlibDocs({
      docsPath,
      repoRoot: root,
      stdlibRoot,
      runGenerator({inputListPath, outputPath}) {
        tempRoot = path.dirname(inputListPath);
        const inputs = fs.readFileSync(inputListPath, 'utf8').trim().split('\n');
        assert.deepEqual(inputs, [...inputs].sort());
        assert.ok(inputs.every(input => path.isAbsolute(input)));
        assert.deepEqual(
          inputs.map(input => path.relative(stdlibRoot, input).split(path.sep).join('/')),
          ['alpha/one.sql', 'zeta/two.sql'],
        );
        writeJson(outputPath, fullDocs);
      },
    });

    assert.equal(loaded.sourceDocsMode, 'metadata-plus-source-generator');
    assert.deepEqual(loaded.docs, fullDocs);
    assert.ok(tempRoot);
    assert.equal(fs.existsSync(tempRoot), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('cleans temp files and rejects generator failures or non-full output', () => {
  for (const mode of ['throws', 'metadata-output']) {
    const {root, stdlibRoot} = createFixture();
    let tempRoot;
    try {
      const docsPath = path.join(root, 'stdlib_docs.json');
      writeJson(docsPath, {
        'android.example': {tags: [], includes: [], data_check_sql: null},
      });

      assert.throws(
        () => loadFullStdlibDocs({
          docsPath,
          repoRoot: root,
          stdlibRoot,
          runGenerator({inputListPath, outputPath}) {
            tempRoot = path.dirname(inputListPath);
            if (mode === 'throws') throw new Error('generator failed');
            writeJson(outputPath, {
              'android.example': {tags: [], includes: [], data_check_sql: null},
            });
          },
        }),
        mode === 'throws' ? /generator failed/ : /full documentation array/,
      );
      assert.ok(tempRoot);
      assert.equal(fs.existsSync(tempRoot), false);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
});

test('rejects unknown documentation shapes without invoking the generator', () => {
  const {root, stdlibRoot} = createFixture();
  try {
    const docsPath = path.join(root, 'stdlib_docs.json');
    writeJson(docsPath, {unexpected: {modules: []}});
    let called = false;

    assert.throws(
      () => loadFullStdlibDocs({
        docsPath,
        repoRoot: root,
        stdlibRoot,
        runGenerator() {
          called = true;
        },
      }),
      /unsupported stdlib documentation shape/,
    );
    assert.equal(called, false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('preserves both legacy string and structured module descriptions', () => {
  assert.equal(normalizeModuleDoc('Legacy docs.'), 'Legacy docs.');
  assert.equal(
    normalizeModuleDoc({name: 'Example', desc: ' Structured\nmodule docs. '}),
    'Structured module docs.',
  );
  assert.equal(normalizeModuleDoc(null), '');
});

test('generates full docs directly from a runtime source tree', () => {
  const {root, stdlibRoot} = createFixture();
  let tempRoot;
  try {
    const loaded = generateFullStdlibDocs({
      perfettoRoot: path.join(root, 'perfetto'),
      stdlibRoot,
      runGenerator({inputListPath, outputPath}) {
        tempRoot = path.dirname(inputListPath);
        writeJson(outputPath, fullDocs);
      },
    });
    assert.deepEqual(loaded, fullDocs);
    assert.equal(fs.existsSync(tempRoot), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('runtime asset generation requires an exact immutable revision', () => {
  assert.equal(
    parseRuntimeRevision(`PERFETTO_VERSION=${'a'.repeat(40)}\n`),
    'a'.repeat(40),
  );
  for (const value of ['v57.2', 'abc123', 'A'.repeat(40)]) {
    assert.throws(
      () => parseRuntimeRevision(`PERFETTO_VERSION=${value}\n`),
      /40-character lowercase commit/,
    );
  }
});

test('public export Perfetto identities match the runtime pin and release artifact', () => {
  const normalizeNewlines = (value) => value.replace(/\r\n/g, '\n');
  assert.equal(normalizeNewlines('a\r\nb\r\n'), 'a\nb\n');
  const pinText = normalizeNewlines(fs.readFileSync(
    path.join(projectRoot, 'scripts/trace-processor-pin.env'),
    'utf8',
  ));
  const policyText = normalizeNewlines(fs.readFileSync(
    path.join(projectRoot, 'backend/skills/public-export.yaml'),
    'utf8',
  ));
  const pinValue = (key) => pinText.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1];
  const blockValue = (block, key) => policyText
    .match(new RegExp(`${block}:\\n([\\s\\S]*?)(?=\\n\\S|$)`))?.[1]
    ?.match(new RegExp(`^  ${key}: (.+)$`, 'm'))?.[1];
  const git = (...args) => execFileSync('git', ['-C', 'perfetto', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();

  const revision = pinValue('PERFETTO_VERSION');
  const release = pinValue('PERFETTO_ARTIFACT_VERSION');
  assert.equal(blockValue('runtime_perfetto', 'revision'), revision);
  assert.equal(blockValue('runtime_perfetto', 'reported_version'), release);
  assert.equal(
    blockValue('runtime_perfetto', 'stdlib_tree'),
    git('rev-parse', `${revision}:src/trace_processor/perfetto_sql/stdlib`),
  );
  assert.equal(blockValue('official_perfetto', 'tag'), release);
  assert.equal(blockValue('official_perfetto', 'commit'), git('rev-parse', `${release}^{}`));
  assert.equal(
    blockValue('official_perfetto', 'stdlib_tree'),
    git('rev-parse', `${release}:src/trace_processor/perfetto_sql/stdlib`),
  );
});

test('runtime asset generation binds every child to one temporary revision checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-test-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'perfetto'), {recursive: true});
  const revision = 'b'.repeat(40);
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
    `PERFETTO_VERSION=${revision}\n`,
  );
  const calls = [];
  try {
    runRuntimeAssetGeneration({
      repoRoot,
      assets: ['docs', 'symbols', 'index'],
      runCommand(command, args, options) {
        calls.push({command, args, options});
        if (command !== 'git') writeRuntimeAssetOutputs(repoRoot, revision);
      },
    });
    const childCalls = calls.filter(call => call.command !== 'git');
    assert.deepEqual(
      childCalls.map(call => call.options.env.PERFETTO_GENERATED_FROM),
      [revision, revision, revision],
    );
    assert.equal(new Set(childCalls.map(call => call.options.env.PERFETTO_SOURCE_ROOT)).size, 1);
    assert.match(calls[1].args.join(' '), new RegExp(revision));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('runtime asset generation removes inherited source overrides from every child', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-env-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'perfetto'), {recursive: true});
  const revision = 'd'.repeat(40);
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
    `PERFETTO_VERSION=${revision}\n`,
  );
  const previous = {
    PERFETTO_STDLIB_PATH: process.env.PERFETTO_STDLIB_PATH,
    PERFETTO_STDLIB_DOCS_PATH: process.env.PERFETTO_STDLIB_DOCS_PATH,
    PFSQL_BIN: process.env.PFSQL_BIN,
  };
  process.env.PERFETTO_STDLIB_PATH = path.join(root, 'forged-stdlib');
  process.env.PERFETTO_STDLIB_DOCS_PATH = path.join(root, 'forged-docs.json');
  process.env.PFSQL_BIN = path.join(root, 'forged-pfsql');
  const childEnvironments = [];
  try {
    runRuntimeAssetGeneration({
      repoRoot,
      assets: ['docs', 'symbols', 'index'],
      runCommand(command, _args, options) {
        if (command !== 'git') {
          childEnvironments.push(options.env);
          writeRuntimeAssetOutputs(repoRoot, revision);
        }
      },
    });
    assert.equal(childEnvironments.length, 3);
    for (const environment of childEnvironments) {
      assert.equal(environment.PERFETTO_STDLIB_PATH, undefined);
      assert.equal(environment.PERFETTO_STDLIB_DOCS_PATH, undefined);
      assert.equal(environment.PFSQL_BIN, undefined);
      assert.equal(environment.PERFETTO_GENERATED_FROM, revision);
      assert.match(environment.PERFETTO_SOURCE_ROOT, /smartperfetto-perfetto-runtime-/);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('runtime asset generation rejects output that claims a different revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-provenance-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'perfetto'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend', 'data'), {recursive: true});
  const revision = 'e'.repeat(40);
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
    `PERFETTO_VERSION=${revision}\n`,
  );
  try {
    assert.throws(
      () => runRuntimeAssetGeneration({
        repoRoot,
        assets: ['docs'],
        runCommand(command) {
          if (command !== 'git') {
            writeJson(
              path.join(repoRoot, 'backend', 'data', 'perfettoSqlDocs.json'),
              {generatedFrom: 'f'.repeat(40)},
            );
          }
        },
      }),
      /perfettoSqlDocs\.json.*does not match runtime revision/,
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('runtime asset generation fails when the temporary worktree cannot be removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-cleanup-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'perfetto'), {recursive: true});
  const revision = 'f'.repeat(40);
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
    `PERFETTO_VERSION=${revision}\n`,
  );
  const cleanupEvents = [];
  try {
    assert.throws(
      () => runRuntimeAssetGeneration({
        repoRoot,
        assets: [],
        runCommand(command, args) {
          if (command === 'git' && args.includes('remove')) {
            cleanupEvents.push('remove');
            throw new Error('worktree cleanup failed');
          }
          if (command === 'git' && args.includes('prune')) cleanupEvents.push('prune');
        },
        removeTree(directory, options) {
          cleanupEvents.push('remove-tree');
          fs.rmSync(directory, options);
        },
      }),
      /worktree cleanup failed/,
    );
    assert.deepEqual(cleanupEvents, ['remove', 'remove-tree', 'prune']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('runtime asset generation removes its worktree after a child failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-assets-failure-'));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'perfetto'), {recursive: true});
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'trace-processor-pin.env'),
    `PERFETTO_VERSION=${'c'.repeat(40)}\n`,
  );
  let runtimeRoot;
  try {
    assert.throws(
      () => runRuntimeAssetGeneration({
        repoRoot,
        assets: ['docs'],
        runCommand(command, args, options) {
          if (command !== 'git') {
            runtimeRoot = options.env.PERFETTO_SOURCE_ROOT;
            throw new Error('generator failed');
          }
        },
      }),
      /generator failed/,
    );
    assert.equal(fs.existsSync(runtimeRoot), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
