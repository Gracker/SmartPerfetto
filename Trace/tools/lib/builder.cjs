// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const {loadCatalog, resolveCaseTrace, runtimePerfettoRevision} = require('./catalog.cjs');
const {buildConstructedTrace, materializeTrace, resolveTraceProcessor} = require('./generator.cjs');
const {sha256File} = require('./hash.cjs');

function traceProcessorProvenance(repoRoot) {
  const executable = resolveTraceProcessor(repoRoot);
  const version = spawnSync(executable, ['--version'], {encoding: 'utf8'});
  if (version.error) throw version.error;
  if (version.status !== 0) throw new Error(`trace_processor_shell --version failed: ${version.stderr}`);
  return {
    path: path.relative(repoRoot, executable).split(path.sep).join('/'),
    sha256: sha256File(executable),
    version: version.stdout.trim().split(/\r?\n/)[0],
  };
}

function safeGeneratedPath(repoRoot, relativePath, caseId) {
  const generatedRoot = path.resolve(repoRoot, 'Trace/.generated/constructed', caseId);
  const output = path.resolve(repoRoot, relativePath);
  if (output !== path.join(generatedRoot, 'trace.pftrace')) {
    throw new Error(`constructed output must be Trace/.generated/constructed/${caseId}/trace.pftrace`);
  }
  return output;
}

function safeCaseFile(entry, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} path must be a relative file inside case ${entry.id}`);
  }
  const caseDir = path.resolve(entry.case_dir);
  const candidate = path.resolve(caseDir, relativePath);
  if (!candidate.startsWith(`${caseDir}${path.sep}`)) {
    throw new Error(`${label} path escapes case ${entry.id}: ${relativePath}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} file is missing for case ${entry.id}: ${relativePath}`);
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file for case ${entry.id}: ${relativePath}`);
  }
  return candidate;
}

// A rebuild records the overlay it produced and the pinned runtime that just
// reparsed it; validation rejects a manifest whose runtime differs from the pin.
function updateBuildManifest(entry, {sha256, runtimeRevision}) {
  const manifest = JSON.parse(fs.readFileSync(entry.manifest_path, 'utf8'));
  if (manifest.trace.sha256 === sha256 && manifest.construction.runtime_revision === runtimeRevision) return;
  manifest.trace.sha256 = sha256;
  manifest.construction.runtime_revision = runtimeRevision;
  fs.writeFileSync(entry.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Re-binds a generated source/trace ground truth (analysis/expected.json
 * source_trace_ground_truth.trace) to the trace a build produced. The facts it
 * asserts stay as generated; only the hashes and runtime that identify the
 * trace they were read from follow the rebuild. Returns whether it was stale.
 */
function bindGroundTruthTrace(entry, provenance, runtimeRevision, check) {
  const expectedPath = path.join(entry.case_dir, 'analysis', 'expected.json');
  if (!fs.existsSync(expectedPath)) return false;
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const trace = expected.source_trace_ground_truth?.trace;
  if (!trace) return false;
  const binding = {
    baseSha256: provenance.base_sha256,
    overlaySha256: provenance.overlay_sha256,
    outputSha256: provenance.output_sha256,
    runtimeRevision,
  };
  const stale = Object.entries(binding).some(([key, value]) => trace[key] !== value);
  if (stale && !check) {
    Object.assign(trace, binding);
    fs.writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
  }
  return stale;
}

function buildCatalogCases(repoRoot, options = {}) {
  const catalog = loadCatalog(repoRoot);
  const constructed = catalog.cases.filter((entry) => entry.kind === 'constructed');
  const requested = options.caseIds ? new Set(options.caseIds) : null;
  if (requested) {
    const known = new Set(constructed.map((entry) => entry.id));
    const unknown = [...requested].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown constructed case(s): ${unknown.join(', ')}`);
  }
  const selected = requested ? constructed.filter((entry) => requested.has(entry.id)) : constructed;
  const results = [];
  // An empty selection is a valid no-op for catalog-only fixtures. Resolve the
  // executable only when a trace will actually be built.
  const traceProcessor = selected.length > 0 ? traceProcessorProvenance(repoRoot) : null;
  const runtimeRevision = runtimePerfettoRevision(repoRoot);
  if (selected.length > 0 && !options.check && !runtimeRevision) {
    throw new Error('scripts/trace-processor-pin.env has no PERFETTO_VERSION');
  }

  for (const entry of selected) {
    const outputPath = safeGeneratedPath(repoRoot, entry.construction.output, entry.id);
    const committedOverlayPath = path.resolve(entry.case_dir, entry.trace.file);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `trace-build-${entry.id}-`));
    const generatedOverlayPath = options.check
      ? path.join(tempDir, 'trace.overlay.pftrace')
      : committedOverlayPath;
    try {
      const build = buildConstructedTrace(repoRoot, {
        caseId: entry.id,
        basePath: resolveCaseTrace(repoRoot, entry.construction.base_case_id),
        scenarioPath: path.resolve(entry.case_dir, entry.construction.scenario_file),
        overlayPath: generatedOverlayPath,
        outputPath,
      });
      const overlayHashMatches = build.provenance.overlay_sha256 === entry.trace.sha256;
      if (options.check && !overlayHashMatches) {
        throw new Error(
          `constructed overlay drift for ${entry.id}: manifest=${entry.trace.sha256}, generated=${build.provenance.overlay_sha256}`,
        );
      }
      if (!options.check) {
        updateBuildManifest(entry, {sha256: build.provenance.overlay_sha256, runtimeRevision});
      }
      if (bindGroundTruthTrace(entry, build.provenance, runtimeRevision, options.check) && options.check) {
        throw new Error(`constructed ground truth drift for ${entry.id}: its trace binding does not match the build`);
      }

      const provenancePath = path.join(path.dirname(outputPath), 'build-provenance.json');
      const provenance = {
        schema_version: 1,
        generator_version: entry.construction.generator_version,
        base_case_id: entry.construction.base_case_id,
        scenario_file: path.relative(repoRoot, path.resolve(entry.case_dir, entry.construction.scenario_file)).split(path.sep).join('/'),
        overlay_file: path.relative(repoRoot, committedOverlayPath).split(path.sep).join('/'),
        output_file: entry.construction.output,
        trace_processor: traceProcessor,
        ...build.provenance,
      };
      fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
      results.push({
        case_id: entry.id,
        output: entry.construction.output,
        provenance_file: path.relative(repoRoot, provenancePath).split(path.sep).join('/'),
        overlay_hash_matches: options.check ? overlayHashMatches : true,
      });
    } finally {
      fs.rmSync(tempDir, {recursive: true, force: true});
    }
  }
  return results;
}

function materializeCatalogCases(repoRoot, options = {}) {
  const catalog = loadCatalog(repoRoot);
  const casesById = new Map(catalog.cases.map((entry) => [entry.id, entry]));
  const constructed = catalog.cases.filter((entry) => entry.kind === 'constructed');
  const requested = options.caseIds ? new Set(options.caseIds) : null;
  if (requested) {
    const unknown = [...requested].filter((id) => !casesById.has(id) || casesById.get(id).kind !== 'constructed');
    if (unknown.length > 0) throw new Error(`Unknown constructed case(s): ${unknown.join(', ')}`);
  }
  const selected = requested ? constructed.filter((entry) => requested.has(entry.id)) : constructed;
  const results = [];

  for (const entry of selected) {
    const base = casesById.get(entry.construction.base_case_id);
    if (!base || base.kind !== 'real') {
      throw new Error(`constructed case ${entry.id} references unknown real base ${entry.construction.base_case_id}`);
    }
    const outputPath = safeGeneratedPath(repoRoot, entry.construction.output, entry.id);
    const basePath = safeCaseFile(base, base.trace.file, 'base trace');
    const overlayPath = safeCaseFile(entry, entry.trace.file, 'overlay trace');
    const actualBaseHash = sha256File(basePath);
    if (actualBaseHash !== base.trace.sha256) {
      throw new Error(`base trace hash mismatch for ${entry.id}: manifest=${base.trace.sha256}, actual=${actualBaseHash}`);
    }
    const actualOverlayHash = sha256File(overlayPath);
    if (actualOverlayHash !== entry.trace.sha256) {
      throw new Error(`overlay trace hash mismatch for ${entry.id}: manifest=${entry.trace.sha256}, actual=${actualOverlayHash}`);
    }
    const materialization = materializeTrace(
      fs.readFileSync(basePath),
      fs.readFileSync(overlayPath),
      outputPath,
    );
    const provenancePath = path.join(path.dirname(outputPath), 'build-provenance.json');
    fs.writeFileSync(provenancePath, `${JSON.stringify({
      schema_version: 1,
      materialization: 'committed-base-plus-overlay',
      case_id: entry.id,
      base_case_id: base.id,
      base_sha256: materialization.base_sha256,
      overlay_sha256: materialization.overlay_sha256,
      output_sha256: materialization.output_sha256,
      base_bytes: materialization.base_bytes,
      overlay_bytes: materialization.overlay_bytes,
      output_bytes: materialization.output_bytes,
    }, null, 2)}\n`);
    results.push({case_id: entry.id, output: entry.construction.output});
  }
  return results;
}

/** A constructed case's expected.json as it is and as its manifest projects it. */
function caseExpectationsProjection(repoRoot, caseId) {
  if (typeof caseId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseId)) {
    throw new Error('--case requires one lowercase kebab-case constructed case id');
  }
  const root = fs.realpathSync(repoRoot);
  let caseDir = root;
  for (const segment of ['Trace', 'constructed', caseId]) {
    caseDir = path.join(caseDir, segment);
    const stat = fs.lstatSync(caseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`constructed case directory must not be a symlink: ${caseDir}`);
  }
  const manifestPath = path.join(caseDir, 'case.json');
  if (!fs.lstatSync(manifestPath).isFile()) throw new Error(`case manifest must be a regular file: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.id !== caseId || manifest.kind !== 'constructed' ||
      !Array.isArray(manifest.coverage?.expectations)) {
    throw new Error(`invalid constructed expectations source: ${manifestPath}`);
  }
  const analysisDir = path.join(caseDir, 'analysis');
  let analysisExists = false;
  try {
    const stat = fs.lstatSync(analysisDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`analysis directory must not be a symlink: ${analysisDir}`);
    analysisExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const outputPath = path.join(analysisDir, 'expected.json');
  let previous;
  let extras = {};
  try {
    if (!fs.lstatSync(outputPath).isFile()) throw new Error(`expectations must be a regular file: ${outputPath}`);
    previous = fs.readFileSync(outputPath, 'utf8');
    const current = JSON.parse(previous);
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`invalid expectations document: ${outputPath}`);
    // Preserve independently generated truth such as source_trace_ground_truth and native_oracle.
    const {schema_version, case_id, marker, expectations, ...additionalFields} = current;
    extras = additionalFields;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const content = `${JSON.stringify({schema_version: 1, case_id: caseId,
    marker: `SmartPerfetto::CASE::${caseId}`, expectations: manifest.coverage.expectations, ...extras}, null, 2)}\n`;
  return {root, analysisDir, analysisExists, outputPath, content, changed: previous !== content};
}

/** Regenerate only the authored expectations projection; trace gold and overlays stay untouched. */
function updateCaseExpectations(repoRoot, options = {}) {
  const caseId = options.caseId;
  const {root, analysisDir, analysisExists, outputPath, content, changed} = caseExpectationsProjection(repoRoot, caseId);
  if (options.check && changed) throw new Error(`stale expectations file: ${outputPath}`);
  if (!options.check && changed) {
    if (!analysisExists) fs.mkdirSync(analysisDir);
    const temporary = path.join(analysisDir, `.expected-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, {flag: 'wx'});
      fs.renameSync(temporary, outputPath);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
  }
  return {case_id: caseId, output: path.relative(root, outputPath).split(path.sep).join('/'), changed};
}

/**
 * The constructed cases whose expected.json no longer projects their manifest.
 * Nothing else reads the two together, so a manifest edit without
 * `expectations --case` used to leave the projection behind unnoticed.
 */
function staleCaseExpectations(repoRoot, caseIds) {
  return caseIds.filter((caseId) => caseExpectationsProjection(repoRoot, caseId).changed);
}

module.exports = {
  bindGroundTruthTrace,
  buildCatalogCases,
  materializeCatalogCases,
  updateBuildManifest,
  updateCaseExpectations,
  staleCaseExpectations,
  safeCaseFile,
  safeGeneratedPath,
};
