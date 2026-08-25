// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const fs = require('node:fs');
const path = require('node:path');

const {probeTrace: defaultProbeTrace} = require('./generator.cjs');
const {sha256File} = require('./hash.cjs');
const {validateCatalog: defaultValidateCatalog} = require('./catalog.cjs');
const {writeIndexes: defaultWriteIndexes} = require('./indexer.cjs');

const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

function copyEvidence(paths, stagingDir, category) {
  const targetDir = path.join(stagingDir, 'analysis', category);
  const seen = new Set();
  return paths.map((sourcePath) => {
    requireFile(sourcePath, `${category} file`);
    const name = path.basename(sourcePath);
    if (seen.has(name)) throw new Error(`duplicate ${category} filename: ${name}`);
    seen.add(name);
    fs.mkdirSync(targetDir, {recursive: true});
    fs.copyFileSync(sourcePath, path.join(targetDir, name), fs.constants.COPYFILE_EXCL);
    return `analysis/${category}/${name}`;
  });
}

function importRealCase(repoRoot, options) {
  if (!CASE_ID_PATTERN.test(String(options.id ?? ''))) {
    throw new Error('case id must be lowercase kebab-case');
  }
  for (const field of ['title', 'description', 'scene', 'origin']) {
    if (typeof options[field] !== 'string' || options[field].trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  requireFile(options.tracePath, 'trace');
  const privateRoot = path.join(repoRoot, 'Trace', 'real', '.private');
  const finalDir = path.join(privateRoot, options.id);
  if (fs.existsSync(finalDir)) throw new Error(`case already exists: ${options.id}`);
  fs.mkdirSync(privateRoot, {recursive: true});
  const stagingDir = fs.mkdtempSync(path.join(privateRoot, `.${options.id}.tmp-`));

  try {
    const tracePath = path.join(stagingDir, 'trace.pftrace');
    fs.copyFileSync(options.tracePath, tracePath, fs.constants.COPYFILE_EXCL);
    const probe = (options.probeTrace ?? defaultProbeTrace)(repoRoot, tracePath);
    const results = copyEvidence(options.resultPaths ?? [], stagingDir, 'results');
    const logs = copyEvidence(options.logPaths ?? [], stagingDir, 'logs');
    const apiLevel = options.android?.api_level ?? null;
    const manifest = {
      schema_version: 1,
      id: options.id,
      kind: 'real',
      title: options.title,
      description: options.description,
      scene: options.scene,
      tags: [...new Set(options.tags ?? [options.scene])].sort(),
      aliases: [],
      trace: {
        file: 'trace.pftrace',
        format: 'perfetto-protobuf',
        sha256: sha256File(tracePath),
        materialization: 'committed',
      },
      android: {
        release: options.android?.release ?? null,
        api_level: apiLevel,
        device: options.android?.device ?? null,
        build_fingerprint: options.android?.build_fingerprint ?? null,
        compatibility: {min_api: apiLevel, max_api: apiLevel},
      },
      source: {
        origin: options.origin,
        captured_at: options.capturedAt ?? null,
        imported_at: options.now ?? new Date().toISOString(),
        license: null,
        consent: null,
        privacy_review: 'pending',
        sanitization_review: 'pending',
        publication: 'private',
        evidence_tier: 'R1',
      },
      analysis: {results, logs},
      trace_probe: {
        start_ns: probe.start_ns,
        end_ns: probe.end_ns,
        process_count_hint: probe.used_pids.size,
      },
      coverage: {skills: [], strategies: [], expectations: []},
    };
    fs.writeFileSync(path.join(stagingDir, 'case.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(stagingDir, finalDir);
    return {caseDir: finalDir, manifest};
  } catch (error) {
    fs.rmSync(stagingDir, {recursive: true, force: true});
    throw error;
  }
}

function promoteRealCase(repoRoot, options) {
  if (!CASE_ID_PATTERN.test(String(options.id ?? ''))) {
    throw new Error('case id must be lowercase kebab-case');
  }
  for (const field of ['license', 'consent']) {
    if (typeof options[field] !== 'string' || options[field].trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  for (const [field, value] of [
    ['privacyReview', options.privacyReview],
    ['sanitizationReview', options.sanitizationReview],
  ]) {
    if (!['approved', 'not-applicable'].includes(value)) {
      throw new Error(`${field} must be approved or not-applicable`);
    }
  }

  const privateDir = path.join(repoRoot, 'Trace', 'real', '.private', options.id);
  const publicDir = path.join(repoRoot, 'Trace', 'real', options.id);
  const manifestPath = path.join(privateDir, 'case.json');
  requireFile(manifestPath, 'private case manifest');
  if (fs.existsSync(publicDir)) throw new Error(`public case already exists: ${options.id}`);

  const originalManifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifestText);
  if (manifest.id !== options.id || manifest.kind !== 'real' || manifest.source?.publication !== 'private') {
    throw new Error(`case ${options.id} is not a private real-case draft`);
  }
  manifest.source = {
    ...manifest.source,
    license: options.license,
    consent: options.consent,
    privacy_review: options.privacyReview,
    sanitization_review: options.sanitizationReview,
    publication: 'public',
  };

  const validateCatalog = options.validateCatalog ?? defaultValidateCatalog;
  const writeIndexes = options.writeIndexes ?? defaultWriteIndexes;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(privateDir, publicDir);
  try {
    const validation = validateCatalog(repoRoot);
    if (!validation.ok) {
      throw new Error(validation.issues.map((item) => item.message).join('; ') || 'catalog validation failed');
    }
    writeIndexes(repoRoot);
    return {caseDir: publicDir, manifest};
  } catch (error) {
    fs.renameSync(publicDir, privateDir);
    fs.writeFileSync(path.join(privateDir, 'case.json'), originalManifestText);
    throw error;
  }
}

module.exports = {importRealCase, promoteRealCase};
