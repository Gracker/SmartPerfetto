// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const {loadCatalog, resolveCaseTrace} = require('./catalog.cjs');
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

function updateTraceHash(entry, sha256) {
  const manifest = JSON.parse(fs.readFileSync(entry.manifest_path, 'utf8'));
  manifest.trace.sha256 = sha256;
  fs.writeFileSync(entry.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
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
      if (!options.check && !overlayHashMatches) updateTraceHash(entry, build.provenance.overlay_sha256);

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

module.exports = {buildCatalogCases, materializeCatalogCases, safeCaseFile, safeGeneratedPath};
