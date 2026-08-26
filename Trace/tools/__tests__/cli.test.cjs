// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');

const {writeIndexes} = require('../lib/indexer.cjs');
const {importRealCase, promoteRealCase} = require('../lib/import-real.cjs');
const {parseArgs} = require('../trace-corpus.cjs');

const cliPath = path.resolve(__dirname, '../trace-corpus.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createIndexFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-index-'));
  fs.cpSync(
    path.resolve(__dirname, '../../schema'),
    path.join(repoRoot, 'Trace/schema'),
    {recursive: true},
  );
  fs.mkdirSync(path.join(repoRoot, 'backend/skills'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/strategies'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/data'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/sql/smartperfetto'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  writeJson(path.join(repoRoot, 'backend/data/perfettoSqlDocs.json'), {
    version: 1,
    generatedFrom: 'fixture-runtime',
    modules: [],
    entries: [],
    symbolToModule: {},
  });
  writeJson(path.join(repoRoot, 'backend/sql/smartperfetto/PACKAGE.json'), {
    packageVersion: '0.1.0',
    symbols: [],
  });
  fs.writeFileSync(
    path.join(repoRoot, 'scripts/trace-processor-pin.env'),
    'PERFETTO_VERSION=fixture-runtime\n',
  );
  const caseDir = path.join(repoRoot, 'Trace/real/android-startup');
  const trace = Buffer.from([0x0a, 0x00]);
  fs.mkdirSync(path.join(caseDir, 'analysis'), {recursive: true});
  fs.writeFileSync(path.join(caseDir, 'trace.pftrace'), trace);
  fs.writeFileSync(path.join(caseDir, 'analysis/result.txt'), 'result\n');
  writeJson(path.join(caseDir, 'case.json'), {
    schema_version: 1,
    id: 'android-startup',
    kind: 'real',
    title: 'Android Startup',
    description: 'Representative startup',
    scene: 'startup',
    tags: ['startup'],
    aliases: ['launch.pftrace'],
    trace: {
      file: 'trace.pftrace',
      format: 'perfetto-protobuf',
      sha256: sha256(trace),
      materialization: 'committed',
    },
    android: {
      release: '15',
      api_level: 35,
      device: 'Pixel fixture',
      build_fingerprint: null,
      compatibility: {min_api: 34, max_api: 35},
    },
    source: {
      origin: 'fixture',
      captured_at: null,
      imported_at: '2026-07-13T00:00:00.000Z',
      license: 'Apache-2.0',
      consent: 'fixture-owned',
      privacy_review: 'approved',
      sanitization_review: 'approved',
      publication: 'public',
      evidence_tier: 'R1',
    },
    analysis: {results: ['analysis/result.txt'], logs: []},
    coverage: {skills: [], strategies: [], expectations: []},
  });
  return {repoRoot};
}

test('writes deterministic root, real, constructed, catalog, and coverage indexes', () => {
  const fixture = createIndexFixture();

  const first = writeIndexes(fixture.repoRoot);
  const second = writeIndexes(fixture.repoRoot, {check: true});

  assert.equal(first.changed.length, 5);
  assert.deepEqual(second.changed, []);
  const rootReadme = fs.readFileSync(path.join(fixture.repoRoot, 'Trace/README.md'), 'utf8');
  const realReadme = fs.readFileSync(path.join(fixture.repoRoot, 'Trace/real/README.md'), 'utf8');
  assert.match(rootReadme, /Android Startup/);
  assert.match(rootReadme, /\.\/real\/android-startup\//);
  assert.match(realReadme, /API 35/);
  assert.match(realReadme, /\.\/android-startup\//);
  const catalog = JSON.parse(fs.readFileSync(path.join(fixture.repoRoot, 'Trace/catalog.json'), 'utf8'));
  assert.equal(catalog.cases[0].id, 'android-startup');
  assert.equal(catalog.cases[0].case_dir, 'Trace/real/android-startup');
});

test('check mode rejects a stale generated index without rewriting it', () => {
  const fixture = createIndexFixture();
  writeIndexes(fixture.repoRoot);
  const readmePath = path.join(fixture.repoRoot, 'Trace/README.md');
  fs.appendFileSync(readmePath, 'stale\n');

  assert.throws(() => writeIndexes(fixture.repoRoot, {check: true}), /stale generated file/);
  assert.match(fs.readFileSync(readmePath, 'utf8'), /stale/);
});

test('imports real cases into ignored private staging with results and logs', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-import-'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-import-source-'));
  const tracePath = path.join(sourceDir, 'typical.pftrace');
  const resultPath = path.join(sourceDir, 'analysis.json');
  const logPath = path.join(sourceDir, 'session.log');
  fs.writeFileSync(tracePath, Buffer.from([0x0a, 0x00]));
  fs.writeFileSync(resultPath, '{}\n');
  fs.writeFileSync(logPath, 'analysis log\n');

  const imported = importRealCase(repoRoot, {
    id: 'typical-startup',
    title: 'Typical startup',
    description: 'A typical captured startup trace',
    scene: 'startup',
    tracePath,
    resultPaths: [resultPath],
    logPaths: [logPath],
    origin: 'local capture',
    android: {release: '15', api_level: 35, device: 'Pixel fixture'},
    now: '2026-07-13T00:00:00.000Z',
    probeTrace: () => ({start_ns: '1', end_ns: '2', used_pids: new Set([1])}),
  });

  assert.equal(imported.manifest.source.publication, 'private');
  assert.equal(imported.manifest.source.evidence_tier, 'R1');
  assert.equal(imported.caseDir, path.join(repoRoot, 'Trace/real/.private/typical-startup'));
  assert.ok(fs.existsSync(path.join(imported.caseDir, 'trace.pftrace')));
  assert.ok(fs.existsSync(path.join(imported.caseDir, 'analysis/results/analysis.json')));
  assert.ok(fs.existsSync(path.join(imported.caseDir, 'analysis/logs/session.log')));
  assert.deepEqual(imported.manifest.analysis.results, ['analysis/results/analysis.json']);
  assert.deepEqual(imported.manifest.analysis.logs, ['analysis/logs/session.log']);
});

test('failed imports leave no final or staging directory', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-import-fail-'));
  const tracePath = path.join(repoRoot, 'trace.pftrace');
  fs.writeFileSync(tracePath, Buffer.from([0x0a, 0x00]));

  assert.throws(
    () => importRealCase(repoRoot, {
      id: 'broken-import',
      title: 'Broken import',
      description: 'Probe fails',
      scene: 'startup',
      tracePath,
      resultPaths: [],
      logPaths: [],
      origin: 'local capture',
      android: {release: null, api_level: null, device: null},
      now: '2026-07-13T00:00:00.000Z',
      probeTrace: () => { throw new Error('probe failed'); },
    }),
    /probe failed/,
  );
  const privateRoot = path.join(repoRoot, 'Trace/real/.private');
  assert.deepEqual(fs.existsSync(privateRoot) ? fs.readdirSync(privateRoot) : [], []);
});

test('promotion requires explicit publication approvals and rolls back failed validation', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-promote-'));
  const tracePath = path.join(repoRoot, 'source.pftrace');
  fs.writeFileSync(tracePath, Buffer.from([0x0a, 0x00]));
  importRealCase(repoRoot, {
    id: 'reviewed-case',
    title: 'Reviewed case',
    description: 'Ready for explicit review',
    scene: 'startup',
    tracePath,
    origin: 'maintainer capture',
    probeTrace: () => ({start_ns: '1', end_ns: '2', used_pids: new Set([1])}),
  });

  assert.throws(
    () => promoteRealCase(repoRoot, {id: 'reviewed-case', license: '', consent: 'owner'}),
    /license must be a non-empty string/,
  );
  const privateDir = path.join(repoRoot, 'Trace/real/.private/reviewed-case');
  assert.ok(fs.existsSync(privateDir));

  assert.throws(
    () => promoteRealCase(repoRoot, {
      id: 'reviewed-case',
      license: 'CC-BY-4.0',
      consent: 'owner-approved',
      privacyReview: 'approved',
      sanitizationReview: 'approved',
      validateCatalog: () => ({ok: false, issues: [{message: 'fixture validation failed'}]}),
    }),
    /fixture validation failed/,
  );
  assert.ok(fs.existsSync(privateDir));
  assert.equal(JSON.parse(fs.readFileSync(path.join(privateDir, 'case.json'), 'utf8')).source.publication, 'private');

  const promoted = promoteRealCase(repoRoot, {
    id: 'reviewed-case',
    license: 'CC-BY-4.0',
    consent: 'owner-approved',
    privacyReview: 'approved',
    sanitizationReview: 'approved',
    validateCatalog: () => ({ok: true, issues: []}),
    writeIndexes: () => ({changed: []}),
  });
  assert.equal(promoted.manifest.source.publication, 'public');
  assert.equal(promoted.caseDir, path.join(repoRoot, 'Trace/real/reviewed-case'));
  assert.ok(fs.existsSync(path.join(promoted.caseDir, 'trace.pftrace')));
  assert.equal(fs.existsSync(privateDir), false);
});

test('CLI indexes, validates, reports coverage, and resolves selectors', () => {
  const fixture = createIndexFixture();
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args, '--repo', fixture.repoRoot], {
    encoding: 'utf8',
  });

  const index = run('index');
  assert.equal(index.status, 0, index.stderr);
  assert.match(index.stdout, /generated 5 file/);

  const validate = run('validate', '--check-generated');
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /PASS/);

  const coverage = run('coverage');
  assert.equal(coverage.status, 0, coverage.stderr);
  assert.match(coverage.stdout, /Skills: 0\/0/);

  const build = run('build', '--check');
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /built 0 constructed case/);

  const resolve = run('resolve', 'launch.pftrace');
  assert.equal(resolve.status, 0, resolve.stderr);
  assert.equal(resolve.stdout.trim(), path.join(fixture.repoRoot, 'Trace/real/android-startup/trace.pftrace'));
});

test('CLI parser preserves repeated evidence flags without treating values as positionals', () => {
  const parsed = parseArgs([
    'import-real', '--id', 'typical-startup', '--result', 'one.json', '--result', 'two.json',
    '--log', 'run.log', '--repo', '/tmp/trace-repo',
  ]);
  assert.equal(parsed.command, 'import-real');
  assert.equal(parsed.value('--id'), 'typical-startup');
  assert.deepEqual(parsed.values('--result'), ['one.json', 'two.json']);
  assert.deepEqual(parsed.values('--log'), ['run.log']);
  assert.deepEqual(parsed.positional, []);
  assert.equal(parsed.repoRoot, '/tmp/trace-repo');
});
