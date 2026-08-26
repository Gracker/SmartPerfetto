// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  discoverCoverageTargets,
  loadCatalog,
  resolveCaseTrace,
  validateCatalog,
} = require('../lib/catalog.cjs');
const {generatedFiles} = require('../lib/indexer.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-catalog-'));
  const trace = Buffer.from([0x0a, 0x00]);
  const overlay = Buffer.from([0x0a, 0x00]);
  const portableSql = [
    'INCLUDE PERFETTO MODULE android.frames.timeline;',
    'CREATE PERFETTO VIEW fixture_status AS SELECT 1 AS status;',
    '',
  ].join('\n');

  fs.cpSync(
    path.resolve(__dirname, '../../schema'),
    path.join(repoRoot, 'Trace/schema'),
    {recursive: true},
  );

  fs.mkdirSync(path.join(repoRoot, 'backend/skills/atomic'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/skills/_template'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/skills/pipelines'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/strategies'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/data'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'backend/sql/smartperfetto/test'), {recursive: true});
  fs.mkdirSync(path.join(repoRoot, 'scripts'), {recursive: true});
  writeJson(path.join(repoRoot, 'backend/data/perfettoSqlDocs.json'), {
    version: 1,
    generatedFrom: 'fixture-runtime',
    modules: [{
      package: 'android',
      module: 'android.frames.timeline',
      sourcePath: 'perfetto/src/trace_processor/perfetto_sql/stdlib/android/frames/timeline.sql',
      symbols: ['actual_frame_timeline_slice'],
    }],
    entries: [],
    symbolToModule: {},
  });
  fs.writeFileSync(
    path.join(repoRoot, 'scripts/trace-processor-pin.env'),
    'PERFETTO_VERSION=fixture-runtime\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'backend/sql/smartperfetto/test/status.sql'),
    portableSql,
  );
  writeJson(path.join(repoRoot, 'backend/sql/smartperfetto/PACKAGE.json'), {
    packageVersion: '0.1.0',
    symbols: [{
      name: 'smartperfetto.test.status',
      sqlName: 'fixture_status',
      kind: 'view',
      module: 'test/status.sql',
      dependencies: ['android.frames.timeline'],
      stability: 'experimental',
    }],
  });
  fs.writeFileSync(
    path.join(repoRoot, 'backend/skills/atomic/cpu_probe.skill.yaml'),
    [
      'name: cpu_probe',
      'type: composite',
      'prerequisites:',
      '  modules: [android.frames.timeline]',
      'steps:',
      '  - id: summary',
      '    type: atomic',
      '    display:',
      '      columns:',
      '        - name: status',
      '          type: number',
      '    sql: SELECT 1 AS status',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repoRoot, 'backend/skills/_template/ignored.skill.yaml'),
    'name: "{{SKILL_ID}}"\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'backend/skills/pipelines/_base.skill.yaml'),
    'name: "${PIPELINE_ID}"\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'backend/strategies/startup.strategy.md'),
    '---\nscene: startup\n---\n',
  );

  const realDir = path.join(repoRoot, 'Trace/real/real-startup');
  fs.mkdirSync(path.join(realDir, 'analysis'), {recursive: true});
  fs.writeFileSync(path.join(realDir, 'trace.pftrace'), trace);
  fs.writeFileSync(path.join(realDir, 'analysis/result.json'), '{}\n');
  writeJson(path.join(realDir, 'case.json'), {
    schema_version: 1,
    id: 'real-startup',
    kind: 'real',
    title: 'Real startup',
    description: 'Captured startup trace',
    scene: 'startup',
    tags: ['startup'],
    aliases: ['legacy-startup.pftrace'],
    trace: {
      file: 'trace.pftrace',
      format: 'perfetto-protobuf',
      sha256: sha256(trace),
      materialization: 'committed',
    },
    android: {
      release: '15',
      api_level: 35,
      device: 'fixture',
      build_fingerprint: null,
      compatibility: {min_api: 34, max_api: 35},
    },
    source: {
      origin: 'test fixture',
      captured_at: null,
      imported_at: '2026-07-13T00:00:00.000Z',
      license: 'Apache-2.0',
      consent: 'fixture-owned',
      privacy_review: 'approved',
      sanitization_review: 'approved',
      publication: 'public',
      evidence_tier: 'R1',
    },
    analysis: {results: ['analysis/result.json'], logs: []},
    coverage: {
      skills: [],
      strategies: ['startup'],
      expectations: [
        {id: 'strategy-startup', type: 'strategy', target: 'startup', query: '分析启动性能'},
        {
          id: 'sql-fixture-status',
          type: 'sql',
          target: 'smartperfetto.test.status',
          mode: 'semantic',
          source_file: 'backend/sql/smartperfetto/test/status.sql',
          source_sha256: sha256(portableSql),
          query: 'SELECT status FROM fixture_status',
          required_columns: ['status'],
          assertions: [{column: 'status', operator: 'eq', value: 1}],
        },
      ],
    },
  });

  const constructedDir = path.join(repoRoot, 'Trace/constructed/cpu-contention');
  fs.mkdirSync(path.join(constructedDir, 'analysis'), {recursive: true});
  fs.writeFileSync(path.join(constructedDir, 'trace.overlay.pftrace'), overlay);
  writeJson(path.join(constructedDir, 'scenario.json'), {
    schema_version: 1,
    clock: {anchor: 'trace-start', duration_ns: '1'},
    actors: {processes: [], threads: []},
    signals: [],
  });
  fs.writeFileSync(path.join(constructedDir, 'analysis/expected.json'), '{}\n');
  writeJson(path.join(constructedDir, 'case.json'), {
    schema_version: 1,
    id: 'cpu-contention',
    kind: 'constructed',
    title: 'CPU contention',
    description: 'Deterministic CPU contention overlay',
    scene: 'cpu',
    tags: ['cpu', 'scheduler'],
    aliases: [],
    trace: {
      file: 'trace.overlay.pftrace',
      format: 'perfetto-protobuf',
      sha256: sha256(overlay),
      materialization: 'base-plus-overlay',
    },
    android: {
      release: '15',
      api_level: 35,
      device: 'synthetic',
      build_fingerprint: null,
      compatibility: {min_api: 34, max_api: 36},
    },
    source: {
      origin: 'SmartPerfetto deterministic generator',
      captured_at: null,
      imported_at: '2026-07-13T00:00:00.000Z',
      license: 'AGPL-3.0-or-later',
      consent: 'generated',
      privacy_review: 'not-applicable',
      sanitization_review: 'not-applicable',
      publication: 'public',
      evidence_tier: 'R3',
    },
    analysis: {results: ['analysis/expected.json'], logs: []},
    construction: {
      base_case_id: 'real-startup',
      scenario_file: 'scenario.json',
      generator_version: 1,
      seed: 'cpu-contention-v1',
      output: 'Trace/.generated/constructed/cpu-contention/trace.pftrace',
      runtime_revision: 'fixture-runtime',
    },
    coverage: {
      skills: ['cpu_probe'],
      strategies: [],
      expectations: [
        {
          id: 'skill-cpu-probe',
          type: 'skill',
          target: 'cpu_probe',
          mode: 'semantic',
          source_file: 'backend/skills/atomic/cpu_probe.skill.yaml',
          required_steps: ['summary'],
          required_sql_steps: ['summary'],
          forced_sql_steps: [],
          expected_condition_skips: [],
          semantic_step: 'summary',
          required_columns: ['status'],
          assertions: [{column: 'status', operator: 'eq', value: 'ok'}],
        },
      ],
    },
  });

  return {repoRoot, realDir, constructedDir};
}

test('discovers runtime Skills and Strategies from source truth', () => {
  const fixture = createFixture();
  const targets = discoverCoverageTargets(fixture.repoRoot);

  assert.deepEqual(targets.skills, ['cpu_probe']);
  assert.deepEqual(targets.strategies, ['startup']);
});

test('loads and validates a complete two-kind catalog', () => {
  const fixture = createFixture();
  const catalog = loadCatalog(fixture.repoRoot);
  const validation = validateCatalog(fixture.repoRoot);

  assert.deepEqual(catalog.cases.map((entry) => entry.id), ['cpu-contention', 'real-startup']);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
  assert.deepEqual(validation.coverage.missing, {skills: [], strategies: []});
  assert.equal(resolveCaseTrace(fixture.repoRoot, 'real-startup'), path.join(fixture.realDir, 'trace.pftrace'));
  assert.equal(resolveCaseTrace(fixture.repoRoot, 'legacy-startup.pftrace'), path.join(fixture.realDir, 'trace.pftrace'));
});

test('rejects SQL inventory drift and definition-only SQL coverage', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.constructedDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectation = manifest.coverage.expectations[0];
  expectation.mode = 'definition';
  delete expectation.required_sql_steps;
  writeJson(manifestPath, manifest);

  let validation = validateCatalog(fixture.repoRoot);
  assert.ok(validation.issues.some((item) => item.code === 'sql-skill-definition-only'));

  expectation.mode = 'execution';
  expectation.required_sql_steps = ['not_the_source_step'];
  writeJson(manifestPath, manifest);
  validation = validateCatalog(fixture.repoRoot);
  assert.ok(validation.issues.some((item) => item.code === 'sql-inventory-mismatch'));
});

test('rejects ambiguous Skills that declare both root and step SQL', () => {
  const fixture = createFixture();
  const skillPath = path.join(fixture.repoRoot, 'backend/skills/atomic/cpu_probe.skill.yaml');
  fs.appendFileSync(skillPath, 'sql: SELECT 2 AS root_status\n');
  const validation = validateCatalog(fixture.repoRoot);
  assert.ok(validation.issues.some((item) => item.code === 'ambiguous-root-and-step-sql'));
});

test('rejects duplicate ids, unsafe paths, hash drift, and tracked private cases', () => {
  const fixture = createFixture();
  const duplicateDir = path.join(fixture.repoRoot, 'Trace/real/duplicate');
  fs.cpSync(fixture.realDir, duplicateDir, {recursive: true});
  const duplicateManifestPath = path.join(duplicateDir, 'case.json');
  const duplicate = JSON.parse(fs.readFileSync(duplicateManifestPath, 'utf8'));
  duplicate.trace.sha256 = '0'.repeat(64);
  duplicate.analysis.results = ['../real-startup/analysis/result.json'];
  duplicate.source.publication = 'private';
  writeJson(duplicateManifestPath, duplicate);
  fs.writeFileSync(path.join(fixture.repoRoot, 'backend/legacy-path.ts'), "const trace = 'test-traces/old.pftrace';\n");
  fs.mkdirSync(path.join(fixture.repoRoot, 'backend/test-output'), {recursive: true});
  fs.writeFileSync(
    path.join(fixture.repoRoot, 'backend/test-output/ignored-runtime-result.json'),
    '{"trace":"test-traces/runtime-only.pftrace"}\n',
  );
  fs.mkdirSync(path.join(fixture.repoRoot, 'backend/uploads/traces'), {recursive: true});
  fs.writeFileSync(
    path.join(fixture.repoRoot, 'backend/uploads/traces/runtime-upload.json'),
    '{"trace":"test-traces/runtime-upload.pftrace"}\n',
  );
  fs.mkdirSync(path.join(fixture.repoRoot, '.claude'), {recursive: true});
  fs.writeFileSync(
    path.join(fixture.repoRoot, '.claude/settings.local.json'),
    '{"allow":["Read(test-traces/**)"]}\n',
  );
  const nestedWorktreeDocs = path.join(
    fixture.repoRoot,
    '.claude',
    'worktrees',
    'old-branch',
    'docs',
  );
  fs.mkdirSync(nestedWorktreeDocs, {recursive: true});
  fs.writeFileSync(
    path.join(nestedWorktreeDocs, 'historical.md'),
    'old branch only: test-traces/legacy.pftrace\n',
  );

  const validation = validateCatalog(fixture.repoRoot);
  const codes = validation.issues.map((issue) => issue.code);
  const legacyIssues = validation.issues.filter((issue) => issue.code === 'legacy-trace-reference');

  assert.equal(validation.ok, false);
  assert.ok(codes.includes('duplicate-case-id'));
  assert.ok(codes.includes('unsafe-path'));
  assert.ok(codes.includes('hash-mismatch'));
  assert.ok(codes.includes('tracked-private-case'));
  assert.ok(codes.includes('legacy-trace-reference'));
  assert.equal(legacyIssues.length, 1);
  assert.equal(legacyIssues[0].file, path.join(fixture.repoRoot, 'backend/legacy-path.ts'));
});

test('requires bounded governance for legacy-tracked publication exceptions', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.realDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.source.publication = 'legacy-tracked';
  manifest.source.license = null;
  manifest.source.consent = null;
  manifest.source.privacy_review = 'pending';
  manifest.source.sanitization_review = 'pending';
  writeJson(manifestPath, manifest);

  let validation = validateCatalog(fixture.repoRoot);
  assert.ok(validation.issues.some((item) => item.code === 'missing-publication-exception'));

  const ledgerPath = path.join(
    fixture.repoRoot,
    'Trace/governance/legacy-publication-exceptions.json',
  );
  writeJson(ledgerPath, {
    schema_version: 1,
    exceptions: [{
      case_id: 'real-startup',
      owner: 'fixture owner',
      reason: 'Legacy fixture pending provenance review.',
      review_by: '2999-01-01',
      disposition: 'quarantine',
    }],
  });
  validation = validateCatalog(fixture.repoRoot);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.exceptions[0].review_by = '2000-01-01';
  writeJson(ledgerPath, ledger);
  validation = validateCatalog(fixture.repoRoot);
  assert.ok(validation.issues.some((item) => item.code === 'expired-publication-exception'));
});

test('reports an invalid publication exception ledger without throwing', () => {
  const fixture = createFixture();
  writeJson(
    path.join(fixture.repoRoot, 'Trace/governance/legacy-publication-exceptions.json'),
    {schema_version: 2, exceptions: []},
  );

  const validation = validateCatalog(fixture.repoRoot);

  assert.ok(validation.issues.some(
    (item) => item.code === 'publication-exception-ledger-invalid',
  ));
});

test('reports missing, stale, and expectation-free coverage targets', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.constructedDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.coverage.skills = ['removed_skill'];
  manifest.coverage.expectations = [];
  writeJson(manifestPath, manifest);

  const validation = validateCatalog(fixture.repoRoot);

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.coverage.missing.skills, ['cpu_probe']);
  assert.deepEqual(validation.coverage.stale.skills, ['removed_skill']);
  assert.ok(validation.issues.some((issue) => issue.code === 'coverage-without-expectation'));
});

test('does not count row-only execution as semantic coverage', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.constructedDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectation = manifest.coverage.expectations[0];
  delete expectation.assertions;
  delete expectation.required_columns;
  writeJson(manifestPath, manifest);

  const validation = validateCatalog(fixture.repoRoot);

  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) =>
    issue.code === 'semantic-expectation-without-columns',
  ));
});

test('rejects positive expectations that explicitly allow zero rows', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.constructedDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.coverage.expectations[0].mode = 'execution';
  manifest.coverage.expectations[0].min_rows = 0;
  delete manifest.coverage.expectations[0].assertions;
  writeJson(manifestPath, manifest);

  const validation = validateCatalog(fixture.repoRoot);

  assert.ok(validation.issues.some((issue) => issue.code === 'positive-expectation-allows-empty'));
});

test('requires semantic expectations to declare source-level result columns', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.constructedDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.coverage.expectations[0].required_columns;
  writeJson(manifestPath, manifest);

  const validation = validateCatalog(fixture.repoRoot);

  assert.ok(validation.issues.some((issue) => issue.code === 'semantic-expectation-without-columns'));
});

test('derives exact Skill SQL provenance from the pinned runtime source index', () => {
  const fixture = createFixture();
  const validation = validateCatalog(fixture.repoRoot);

  assert.equal(validation.coverage.sql_sources.runtime_revision, 'fixture-runtime');
  assert.deepEqual(validation.coverage.positive.sql_skills, ['cpu_probe']);
  assert.deepEqual(validation.coverage.deferred.skills, []);
  assert.deepEqual(validation.coverage.sql_sources.skills, [{
    target: 'cpu_probe',
    source_file: 'backend/skills/atomic/cpu_probe.skill.yaml',
    modules: [{
      name: 'android.frames.timeline',
      source_path: 'perfetto/src/trace_processor/perfetto_sql/stdlib/android/frames/timeline.sql',
    }],
    steps: [{
      id: 'summary',
      sha256: crypto.createHash('sha256').update('SELECT 1 AS status').digest('hex'),
      required_columns: ['status'],
    }],
  }]);
  assert.deepEqual(validation.coverage.sql_sources.portable, [{
    target: 'smartperfetto.test.status',
    source_file: 'backend/sql/smartperfetto/test/status.sql',
    sql_name: 'fixture_status',
    source_sha256: sha256(fs.readFileSync(
      path.join(fixture.repoRoot, 'backend/sql/smartperfetto/test/status.sql'),
    )),
    modules: [{
      name: 'android.frames.timeline',
      source_path: 'perfetto/src/trace_processor/perfetto_sql/stdlib/android/frames/timeline.sql',
    }],
  }]);
});

test('never counts explicitly deferred SQL Skills as positive coverage', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const validation = validateCatalog(repoRoot);
  const positive = new Set(validation.coverage.positive.sql_skills);

  assert.ok(validation.coverage.deferred.skills.length > 0);
  for (const skill of validation.coverage.deferred.skills) {
    assert.equal(positive.has(skill), false, `${skill} is both positive and deferred`);
  }
});

test('rejects canonical SQL expectations whose source hash drifts from PACKAGE.json', () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.realDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectation = manifest.coverage.expectations.find((item) => item.type === 'sql');
  expectation.source_sha256 = '0'.repeat(64);
  writeJson(manifestPath, manifest);

  const validation = validateCatalog(fixture.repoRoot);

  assert.ok(validation.issues.some((issue) => issue.code === 'portable-sql-source-mismatch'));
});

test('rejects evidence tiers and constructed runtime revisions that contradict the case kind', () => {
  const fixture = createFixture();
  const realManifestPath = path.join(fixture.realDir, 'case.json');
  const realManifest = JSON.parse(fs.readFileSync(realManifestPath, 'utf8'));
  realManifest.source.evidence_tier = 'R3';
  writeJson(realManifestPath, realManifest);
  const constructedManifestPath = path.join(fixture.constructedDir, 'case.json');
  const constructedManifest = JSON.parse(fs.readFileSync(constructedManifestPath, 'utf8'));
  constructedManifest.construction.runtime_revision = 'wrong-runtime';
  writeJson(constructedManifestPath, constructedManifest);

  const validation = validateCatalog(fixture.repoRoot);
  const codes = validation.issues.map((issue) => issue.code);

  assert.ok(codes.includes('case-evidence-tier-mismatch'));
  assert.ok(codes.includes('constructed-runtime-revision-mismatch'));
});

test('repository binds every real trace to source-pinned canonical SQL expectations', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const catalog = loadCatalog(repoRoot);
  const realCases = catalog.cases.filter((entry) => entry.kind === 'real');

  assert.equal(realCases.length, 6);
  for (const entry of realCases) {
    const sqlExpectations = entry.coverage.expectations.filter((item) => item.type === 'sql');
    assert.ok(sqlExpectations.length > 0, `${entry.id} has no canonical SQL expectation`);
    for (const expectation of sqlExpectations) {
      assert.match(expectation.source_file, /^backend\/sql\/smartperfetto\/.+\.sql$/);
      assert.match(expectation.source_sha256, /^[a-f0-9]{64}$/);
      assert.ok(['semantic', 'negative'].includes(expectation.mode));
    }
  }
});

test('generated corpus index publishes evidence tiers and pinned SQL source coverage', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const files = generatedFiles(repoRoot);
  const readme = files.get(path.join(repoRoot, 'Trace/README.md'));

  assert.match(readme, /Evidence tiers: R1=6, R2=0, R3=12/);
  assert.match(readme, /Pinned Perfetto SQL source: `[a-f0-9]{40}`/);
  assert.match(readme, /canonical portable SQL source checks/);
});

test('repository catalog preserves all six legacy trace fixtures and FPS reports', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const expected = new Map([
    ['launch_light.pftrace', 'android-startup-light'],
    ['lacunh_heavy.pftrace', 'android-startup-heavy'],
    ['scroll_Standard-AOSP-App-Without-PreAnimation.pftrace', 'android-scroll-standard'],
    ['scroll-demo-customer-scroll.pftrace', 'android-scroll-customer'],
    ['Scroll-Flutter-327-TextureView.pftrace', 'flutter-scroll-texture-view'],
    ['Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace', 'flutter-scroll-surface-view'],
  ]);
  const catalog = loadCatalog(repoRoot);

  assert.equal(catalog.cases.filter((entry) => entry.kind === 'real').length, 6);
  for (const [legacyName, caseId] of expected) {
    const entry = catalog.cases.find((candidate) => candidate.id === caseId);
    assert.ok(entry, `missing real case ${caseId}`);
    assert.ok(entry.aliases.includes(legacyName));
    assert.equal(resolveCaseTrace(repoRoot, legacyName), path.join(entry.case_dir, 'trace.pftrace'));
    assert.equal(entry.analysis.results.length, 1);
    assert.match(entry.analysis.results[0], /fps_report\.txt$/);
    assert.deepEqual(entry.analysis.logs, []);
  }
});

test('repository ignores private imports and materialized constructed traces', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

  assert.match(gitignore, /^\/Trace\/real\/\.private\/$/m);
  assert.match(gitignore, /^\/Trace\/\.generated\/$/m);
});

test('repository catalog explicitly covers every runtime Skill and Strategy', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const validation = validateCatalog(repoRoot);

  assert.deepEqual(validation.coverage.missing, {skills: [], strategies: []});
  assert.deepEqual(validation.coverage.stale, {skills: [], strategies: []});
  assert.equal(
    validation.issues.filter((issue) => issue.code === 'coverage-without-expectation').length,
    0,
  );
});
