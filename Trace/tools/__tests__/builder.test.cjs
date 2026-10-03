// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  bindGroundTruthTrace,
  materializeCatalogCases,
  staleCaseExpectations,
  updateBuildManifest,
  updateCaseExpectations,
} = require('../lib/builder.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeCase(repoRoot, relativeDir, manifest, traceName, trace) {
  const caseDir = path.join(repoRoot, 'Trace', relativeDir);
  fs.mkdirSync(caseDir, {recursive: true});
  fs.writeFileSync(path.join(caseDir, traceName), trace);
  fs.writeFileSync(path.join(caseDir, 'case.json'), `${JSON.stringify(manifest)}\n`);
}

function fixture(output = 'Trace/.generated/constructed/derived/trace.pftrace') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-materialize-test-'));
  const base = Buffer.from([1, 2, 3]);
  const overlay = Buffer.from([4, 5]);
  writeCase(repoRoot, 'real/base', {
    id: 'base',
    kind: 'real',
    trace: {file: 'trace.pftrace', sha256: sha256(base)},
  }, 'trace.pftrace', base);
  writeCase(repoRoot, 'constructed/derived', {
    id: 'derived',
    kind: 'constructed',
    trace: {file: 'trace.overlay.pftrace', sha256: sha256(overlay)},
    construction: {base_case_id: 'base', output},
  }, 'trace.overlay.pftrace', overlay);
  return {repoRoot, base, overlay};
}

test('materializes committed base and overlay without Perfetto proto sources', () => {
  const {repoRoot, base, overlay} = fixture();
  try {
    const result = materializeCatalogCases(repoRoot);
    assert.equal(result.length, 1);
    const output = path.join(repoRoot, 'Trace/.generated/constructed/derived/trace.pftrace');
    assert.deepEqual(fs.readFileSync(output), Buffer.concat([base, overlay]));
    assert.deepEqual(
      fs.readdirSync(path.dirname(output)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects manifest hash drift before materialization', () => {
  const {repoRoot} = fixture();
  try {
    const baseManifestPath = path.join(repoRoot, 'Trace/real/base/case.json');
    const manifest = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
    manifest.trace.sha256 = '0'.repeat(64);
    fs.writeFileSync(baseManifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /base trace hash mismatch/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('a rebuild stamps the overlay hash and the runtime that reparsed it', () => {
  const {repoRoot} = fixture();
  try {
    const manifestPath = path.join(repoRoot, 'Trace/constructed/derived/case.json');
    const entry = {manifest_path: manifestPath};
    const before = fs.readFileSync(manifestPath, 'utf8');
    const {trace: {sha256: overlaySha}} = JSON.parse(before);
    updateBuildManifest(entry, {sha256: overlaySha, runtimeRevision: 'a'.repeat(40)});
    const stamped = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(stamped.trace.sha256, overlaySha);
    assert.equal(stamped.construction.runtime_revision, 'a'.repeat(40));
    assert.equal(stamped.construction.base_case_id, 'base');

    const written = fs.readFileSync(manifestPath, 'utf8');
    updateBuildManifest(entry, {sha256: overlaySha, runtimeRevision: 'a'.repeat(40)});
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), written);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects constructed output paths outside the case generated directory', () => {
  const {repoRoot} = fixture('Trace/.generated/constructed/other/trace.pftrace');
  try {
    assert.throws(() => materializeCatalogCases(repoRoot), /constructed output must be/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects base trace paths that escape the case directory', () => {
  const {repoRoot} = fixture();
  try {
    const manifestPath = path.join(repoRoot, 'Trace/real/base/case.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.trace.file = '../outside.pftrace';
    fs.writeFileSync(path.join(repoRoot, 'Trace/real/outside.pftrace'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /base trace path escapes/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects overlay trace paths that escape the case directory', () => {
  const {repoRoot} = fixture();
  try {
    const manifestPath = path.join(repoRoot, 'Trace/constructed/derived/case.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.trace.file = '../outside.pftrace';
    fs.writeFileSync(path.join(repoRoot, 'Trace/constructed/outside.pftrace'), Buffer.from([4, 5]));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => materializeCatalogCases(repoRoot), /overlay trace path escapes/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('rejects non-regular trace inputs', () => {
  const {repoRoot} = fixture();
  try {
    const overlayPath = path.join(repoRoot, 'Trace/constructed/derived/trace.overlay.pftrace');
    fs.rmSync(overlayPath);
    fs.mkdirSync(overlayPath);
    assert.throws(() => materializeCatalogCases(repoRoot), /overlay trace must be a regular file/);
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

function expectationsFixture(t) {
  const {repoRoot} = fixture();
  t.after(() => fs.rmSync(repoRoot, {recursive: true, force: true}));
  const caseDir = path.join(repoRoot, 'Trace/constructed/derived');
  const manifestPath = path.join(caseDir, 'case.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.schema_version = 1;
  manifest.coverage = {expectations: [{id: 'one', type: 'sql', assertions: [{value: '9007199254740993'}]}]};
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return {repoRoot, caseDir, manifestPath, manifest, output: path.join(caseDir, 'analysis/expected.json')};
}

test('expectations updates only the selected constructed projection and preserves extra truth', t => {
  const f = expectationsFixture(t);
  fs.mkdirSync(path.dirname(f.output));
  const truth = {trace: {overlaySha256: 'original-gold'}, facts: [{ts: '9007199254740993'}]};
  fs.writeFileSync(f.output, JSON.stringify({schema_version: 0, case_id: 'old', marker: 'old', expectations: [],
    source_trace_ground_truth: truth, native_oracle: {rows: 7}}));
  const scenario = path.join(f.caseDir, 'scenario.json');
  fs.writeFileSync(scenario, '{"authored":true}\n');
  const other = path.join(f.repoRoot, 'Trace/constructed/other');
  fs.mkdirSync(path.join(other, 'analysis'), {recursive: true});
  // A target-only operation must not even require unrelated manifests to parse.
  fs.writeFileSync(path.join(other, 'case.json'), 'unrelated in-progress edit');
  fs.writeFileSync(path.join(other, 'analysis/expected.json'), 'other gold');
  const untouched = [f.manifestPath, scenario, path.join(f.caseDir, 'trace.overlay.pftrace'),
    path.join(other, 'case.json'), path.join(other, 'analysis/expected.json')];
  const before = untouched.map(file => fs.readFileSync(file));
  const result = updateCaseExpectations(f.repoRoot, {caseId: 'derived'});
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')), {schema_version: 1, case_id: 'derived',
    marker: 'SmartPerfetto::CASE::derived', expectations: f.manifest.coverage.expectations,
    source_trace_ground_truth: truth, native_oracle: {rows: 7}});
  untouched.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  const beforeStat = fs.statSync(f.output);
  assert.equal(updateCaseExpectations(f.repoRoot, {caseId: 'derived', check: true}).changed, false);
  assert.equal(updateCaseExpectations(f.repoRoot, {caseId: 'derived'}).changed, false);
  assert.equal(fs.statSync(f.output).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), ['expected.json']);
});

test('expectations check is read-only for missing and stale output', t => {
  const f = expectationsFixture(t);
  assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'derived', check: true}), /stale expectations/);
  assert.equal(fs.existsSync(path.dirname(f.output)), false);
  updateCaseExpectations(f.repoRoot, {caseId: 'derived'});
  const previous = fs.readFileSync(f.output);
  f.manifest.coverage.expectations.push({id: 'new'});
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'derived', check: true}), /stale expectations/);
  assert.deepEqual(fs.readFileSync(f.output), previous);
});

test('rebinds a generated ground truth to the trace a build produced, keeping its facts', t => {
  const f = expectationsFixture(t);
  fs.mkdirSync(path.dirname(f.output));
  const facts = {marker: 'M', atNs: 120};
  fs.writeFileSync(f.output, JSON.stringify({expectations: [], source_trace_ground_truth: {traceFacts: facts,
    trace: {baseCaseId: 'base', baseSha256: 'old', overlaySha256: 'old', outputSha256: 'old', runtimeRevision: 'old'}}}));
  const entry = {case_dir: f.caseDir};
  const provenance = {base_sha256: 'b', overlay_sha256: 'o', output_sha256: 'u'};
  const before = fs.readFileSync(f.output);
  assert.equal(bindGroundTruthTrace(entry, provenance, 'rev', true), true);
  assert.deepEqual(fs.readFileSync(f.output), before);
  assert.equal(bindGroundTruthTrace(entry, provenance, 'rev', false), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')).source_trace_ground_truth, {traceFacts: facts,
    trace: {baseCaseId: 'base', baseSha256: 'b', overlaySha256: 'o', outputSha256: 'u', runtimeRevision: 'rev'}});
  assert.equal(bindGroundTruthTrace(entry, provenance, 'rev', true), false);
  // A case without generated ground truth is left alone.
  fs.writeFileSync(f.output, '{"expectations": []}');
  assert.equal(bindGroundTruthTrace(entry, provenance, 'rev', false), false);
  assert.equal(fs.readFileSync(f.output, 'utf8'), '{"expectations": []}');
});

test('lists the constructed cases whose projection fell behind their manifest', t => {
  const f = expectationsFixture(t);
  assert.deepEqual(staleCaseExpectations(f.repoRoot, ['derived']), ['derived']);
  updateCaseExpectations(f.repoRoot, {caseId: 'derived'});
  assert.deepEqual(staleCaseExpectations(f.repoRoot, ['derived']), []);
  f.manifest.coverage.expectations.push({id: 'new'});
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const previous = fs.readFileSync(f.output);
  assert.deepEqual(staleCaseExpectations(f.repoRoot, ['derived']), ['derived']);
  assert.deepEqual(fs.readFileSync(f.output), previous);
  // A case that cannot be read is an error, not a stale projection.
  assert.throws(() => staleCaseExpectations(f.repoRoot, ['missing']), /ENOENT/);
});

test('expectations requires a safe explicit constructed case id and valid source', t => {
  const f = expectationsFixture(t);
  for (const caseId of [undefined, '', '../real/base', 'a/b', 'a\\b', '/tmp/escape']) {
    assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId}), /--case requires/);
  }
  assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'base'}), /ENOENT/);
  for (const replacement of [{...f.manifest, kind: 'real'}, {...f.manifest, id: 'other'},
    {...f.manifest, coverage: {expectations: null}}]) {
    fs.writeFileSync(f.manifestPath, JSON.stringify(replacement));
    assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'derived'}), /invalid constructed expectations source/);
  }
  assert.equal(fs.existsSync(f.output), false);
});

test('expectations refuses symlinked path components, manifests and output files', t => {
  for (const target of ['Trace', 'constructed', 'derived', 'case.json', 'analysis', 'expected.json']) {
    const f = expectationsFixture(t);
    fs.mkdirSync(path.dirname(f.output));
    fs.writeFileSync(f.output, '{}');
    const paths = {Trace: path.join(f.repoRoot, 'Trace'), constructed: path.join(f.repoRoot, 'Trace/constructed'),
      derived: f.caseDir, 'case.json': f.manifestPath, analysis: path.dirname(f.output), 'expected.json': f.output};
    const original = paths[target];
    const moved = `${original}-original`;
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'derived'}), /symlink|regular file/);
  }
});

test('expectations atomically replaces a hard-linked output without modifying its other name', t => {
  const f = expectationsFixture(t);
  fs.mkdirSync(path.dirname(f.output));
  const gold = path.join(f.repoRoot, 'unrelated-gold.json');
  fs.writeFileSync(gold, '{"native_oracle":{"retained":true}}\n');
  fs.linkSync(gold, f.output);
  const before = fs.readFileSync(gold);
  updateCaseExpectations(f.repoRoot, {caseId: 'derived'});
  assert.deepEqual(fs.readFileSync(gold), before);
  assert.equal(JSON.parse(fs.readFileSync(f.output, 'utf8')).native_oracle.retained, true);
});

test('expectations rejects malformed existing truth instead of discarding it', t => {
  const f = expectationsFixture(t);
  fs.mkdirSync(path.dirname(f.output));
  for (const content of ['in-progress gold', 'null', '[]']) {
    fs.writeFileSync(f.output, content);
    assert.throws(() => updateCaseExpectations(f.repoRoot, {caseId: 'derived'}));
    assert.equal(fs.readFileSync(f.output, 'utf8'), content);
  }
});
