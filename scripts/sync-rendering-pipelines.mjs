#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = join(REPO_ROOT, 'backend/skills/pipelines/index.yaml');
const DEFAULT_DOCS = join(REPO_ROOT, 'docs/rendering_pipelines');
const DEFAULT_PIPELINES = join(REPO_ROOT, 'backend/skills/pipelines');
const DEFAULT_PUBLIC_EXPORT = join(REPO_ROOT, 'backend/skills/public-export.yaml');
const DEFAULT_PUBLIC_FIXTURES = join(REPO_ROOT, 'backend/skills/public-fixtures.yaml');
const DEFAULT_DETECTOR = join(
  REPO_ROOT,
  'backend/skills/atomic/rendering_pipeline_detection.skill.yaml',
);
const ARCHITECTURE_TYPES = new Set([
  'STANDARD',
  'FLUTTER',
  'WEBVIEW',
  'COMPOSE',
  'SURFACEVIEW',
  'GLSURFACEVIEW',
  'SOFTWARE',
  'MIXED',
  'GAME_ENGINE',
  'CAMERA',
  'VIDEO_OVERLAY',
  'REACT_NATIVE',
  'UNKNOWN',
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort();
}

function expectedDocuments(catalog) {
  if (!Array.isArray(catalog?.documents) || catalog.documents.length === 0) {
    throw new Error('Catalog documents must be a non-empty array');
  }
  const documents = new Map();
  for (const document of catalog.documents) {
    if (!/^S(?:0[1-9]|1[0-4])_[A-Za-z0-9_]+\.md$/.test(document?.file ?? '')) {
      throw new Error(`Invalid rendering article filename: ${document?.file ?? '<missing>'}`);
    }
    if (!/^[a-f0-9]{64}$/.test(document?.sha256 ?? '')) {
      throw new Error(`Invalid sha256 for rendering article: ${document?.file ?? '<missing>'}`);
    }
    if (documents.has(document.file)) {
      throw new Error(`Duplicate rendering article: ${document.file}`);
    }
    documents.set(document.file, document);
  }
  const series = [...documents].map(([file]) => file.slice(0, 3));
  const expectedSeries = Array.from(
    { length: 14 },
    (_, index) => `S${String(index + 1).padStart(2, '0')}`,
  );
  if (series.join(',') !== expectedSeries.join(',')) {
    throw new Error(`Catalog must contain ordered S01-S14 articles, got: ${series.join(', ')}`);
  }
  return documents;
}

export function validatePublicExport(publicExport, catalog) {
  const expected = new Set(
    [...expectedDocuments(catalog).keys()].map((file) => `docs/rendering_pipelines/${file}`),
  );
  const pipelineDocs = publicExport?.pipeline_docs;
  if (!pipelineDocs || typeof pipelineDocs !== 'object') {
    throw new Error('Public export pipeline_docs must be a mapping');
  }
  const actual = new Set(Object.keys(pipelineDocs));
  const missing = [...expected].filter((path) => !actual.has(path));
  const unexpected = [...actual].filter((path) => !expected.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Public rendering docs mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    );
  }
  for (const [source, entry] of Object.entries(pipelineDocs)) {
    const file = source.split('/').at(-1);
    const expectedDestination = `references/generated/pipelines/docs/${file}`;
    if (entry?.disposition !== 'exported' || entry?.destination !== expectedDestination) {
      throw new Error(`Public rendering doc ${source} must export to ${expectedDestination}`);
    }
  }
}

export function validateRenderingFixtureQueries(publicFixtures, detector) {
  const detectorName = detector?.name;
  const stepIds = new Set((detector?.steps || []).map((step) => step?.id).filter(Boolean));
  if (detectorName !== 'rendering_pipeline_detection' || stepIds.size === 0) {
    throw new Error('Rendering detector must define named steps');
  }
  for (const fixture of publicFixtures?.fixtures || []) {
    for (const assertion of fixture?.assertions || []) {
      const queryId = assertion?.query_id;
      if (typeof queryId !== 'string' || !queryId.startsWith(`${detectorName}/`)) continue;
      const stepId = queryId.slice(detectorName.length + 1);
      if (!stepIds.has(stepId)) {
        throw new Error(`${queryId}: unknown detector step`);
      }
    }
  }
}

const SUPERSEDED_TEXT = [
  { pattern: /\bPhase E\b/, label: 'Phase E roadmap claim' },
  { pattern: /(?:24|17)\s*(?:个|种)\s*类型/, label: 'superseded rendering-type count' },
  { pattern: /(?:S01\s*§\s*4\s*)?4\s*特征分型/, label: 'superseded four-feature taxonomy' },
  { pattern: /android14-release/, label: 'superseded Android source tag' },
  { pattern: /present fence[^\n。]*影响可见上屏/, label: 'overstated present-fence visibility claim' },
];

export function findStaleRenderingReferences({ catalog, files }) {
  const allowedDocuments = new Set(expectedDocuments(catalog).keys());
  const failures = [];
  for (const [path, content] of files) {
    for (const match of content.matchAll(/rendering_pipelines\/([A-Za-z0-9_.-]+\.md)/g)) {
      if (!allowedDocuments.has(match[1])) {
        failures.push(`${path}: stale rendering article reference ${match[0]}`);
      }
    }
    for (const { pattern, label } of SUPERSEDED_TEXT) {
      const match = content.match(pattern);
      if (match) failures.push(`${path}: ${label}: ${match[0]}`);
    }
  }
  return failures;
}

function collectFiles(directory, files, excludedDirectoryNames = new Set()) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) collectFiles(path, files, excludedDirectoryNames);
      continue;
    }
    if (!/\.(?:md|ts|yaml|yml)$/.test(entry.name)) continue;
    files.set(path.slice(REPO_ROOT.length + 1), readFileSync(path, 'utf8'));
  }
}

function activeReferenceFiles() {
  const files = new Map();
  for (const file of ['README.md', 'docs/README.md', 'docs/README.en.md']) {
    files.set(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
  }
  collectFiles(join(REPO_ROOT, 'docs/architecture'), files);
  collectFiles(join(REPO_ROOT, 'docs/reference'), files);
  collectFiles(join(REPO_ROOT, 'backend/strategies'), files);
  collectFiles(join(REPO_ROOT, 'backend/skills'), files);
  collectFiles(
    join(REPO_ROOT, 'backend/src'),
    files,
    new Set(['node_modules', 'dist']),
  );
  return files;
}

function validateRepositoryReferences(catalog) {
  const publicExport = yaml.load(readFileSync(DEFAULT_PUBLIC_EXPORT, 'utf8'));
  validatePublicExport(publicExport, catalog);
  validateRenderingFixtureQueries(
    yaml.load(readFileSync(DEFAULT_PUBLIC_FIXTURES, 'utf8')),
    yaml.load(readFileSync(DEFAULT_DETECTOR, 'utf8')),
  );
  const failures = findStaleRenderingReferences({
    catalog,
    files: activeReferenceFiles(),
  });
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

export function loadCatalog(catalogPath = DEFAULT_CATALOG) {
  const catalog = yaml.load(readFileSync(catalogPath, 'utf8'));
  validateCatalog(catalog);
  return catalog;
}

export function validateCatalog(catalog) {
  const documents = expectedDocuments(catalog);
  const renderingTypes = catalog?.rendering_types;
  const pipelines = catalog?.pipelines;
  if (!renderingTypes || typeof renderingTypes !== 'object') {
    throw new Error('Catalog rendering_types must be a mapping');
  }
  if (!pipelines || typeof pipelines !== 'object') {
    throw new Error('Catalog pipelines must be a mapping');
  }

  for (const [typeId, definition] of Object.entries(renderingTypes)) {
    if (!['overview', 'concrete'].includes(definition?.kind)) {
      throw new Error(`Rendering type ${typeId} has invalid kind`);
    }
    if (!documents.has(definition?.document)) {
      throw new Error(`Rendering type ${typeId} references unknown document ${definition?.document}`);
    }
  }

  const files = new Set();
  for (const [pipelineId, entry] of Object.entries(pipelines)) {
    if (!entry?.file || files.has(entry.file)) {
      throw new Error(`Pipeline ${pipelineId} has a missing or duplicate file`);
    }
    files.add(entry.file);
    if (!['variant', 'feature'].includes(entry.classification_role)) {
      throw new Error(`Pipeline ${pipelineId} has invalid classification_role`);
    }
    if (!renderingTypes[entry.teaching_type_id]) {
      throw new Error(`Pipeline ${pipelineId} has unknown teaching_type_id`);
    }
    if (!ARCHITECTURE_TYPES.has(entry.architecture_type)) {
      throw new Error(`Pipeline ${pipelineId} has invalid architecture_type`);
    }
    if (!['app', 'global'].includes(entry.signal_scope)) {
      throw new Error(`Pipeline ${pipelineId} has invalid signal_scope`);
    }
    if (typeof entry.primary_eligible !== 'boolean' || typeof entry.feature_visible !== 'boolean') {
      throw new Error(`Pipeline ${pipelineId} selection flags must be booleans`);
    }
    if (entry.classification_role === 'variant') {
      if (!entry.primary_eligible || entry.feature_visible || !entry.rendering_type_id) {
        throw new Error(`Variant ${pipelineId} has contradictory selection metadata`);
      }
      if (renderingTypes[entry.rendering_type_id]?.kind !== 'concrete') {
        throw new Error(`Variant ${pipelineId} must reference a concrete rendering type`);
      }
      if (entry.rendering_type_id !== entry.teaching_type_id) {
        throw new Error(`Variant ${pipelineId} rendering and teaching types must match`);
      }
      if (entry.related_rendering_type_ids !== undefined) {
        throw new Error(`Variant ${pipelineId} cannot declare related_rendering_type_ids`);
      }
    } else {
      if (entry.primary_eligible || !entry.feature_visible || entry.rendering_type_id !== undefined) {
        throw new Error(`Feature ${pipelineId} has contradictory selection metadata`);
      }
      if (!Array.isArray(entry.related_rendering_type_ids)) {
        throw new Error(`Feature ${pipelineId} must declare related_rendering_type_ids`);
      }
      for (const typeId of entry.related_rendering_type_ids) {
        if (renderingTypes[typeId]?.kind !== 'concrete') {
          throw new Error(`Feature ${pipelineId} references unknown related type ${typeId}`);
        }
      }
    }
  }

  const defaultEntry = pipelines[catalog?.default?.pipeline_id];
  if (
    !defaultEntry ||
    defaultEntry.classification_role !== 'variant' ||
    defaultEntry.rendering_type_id !== catalog?.default?.rendering_type_id
  ) {
    throw new Error('Catalog default must reference a primary-eligible variant and its type');
  }
}

export function validateSource(sourceDir, catalog) {
  validateCatalog(catalog);
  const expected = expectedDocuments(catalog);
  const actual = markdownFiles(sourceDir);
  const expectedFiles = [...expected.keys()];
  const unexpected = actual.filter((file) => !expected.has(file));
  const missing = expectedFiles.filter((file) => !actual.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Rendering article inventory mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`,
    );
  }
  for (const [file, document] of expected) {
    const actualHash = sha256(readFileSync(join(sourceDir, file)));
    if (actualHash !== document.sha256) {
      throw new Error(`Rendering article sha256 mismatch for ${file}: ${actualHash}`);
    }
  }
}

function normalizeRepository(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export function validateGitSource(sourceDir, catalog) {
  const git = (...args) =>
    execFileSync('git', ['-C', sourceDir, ...args], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  const remote = normalizeRepository(git('remote', 'get-url', 'origin'));
  if (head !== catalog.source.commit) {
    throw new Error(`Source checkout HEAD ${head} does not match pinned commit ${catalog.source.commit}`);
  }
  if (remote !== normalizeRepository(catalog.source.repository)) {
    throw new Error(`Source checkout remote ${remote} does not match ${catalog.source.repository}`);
  }
}

function documentPathForPipeline(catalog, pipelineId) {
  const entry = catalog.pipelines[pipelineId];
  const document = catalog.rendering_types[entry.teaching_type_id].document;
  return `rendering_pipelines/${document}`;
}

function rewritePipelineYaml(content, docPath) {
  const lines = content.split('\n');
  const docPathIndex = lines.findIndex((line) => /^  doc_path:/.test(line));
  if (docPathIndex < 0) throw new Error('Pipeline YAML meta.doc_path is missing');
  lines[docPathIndex] = `  doc_path: ${docPath}`;

  const teachingIndex = lines.findIndex((line) => line === 'teaching:');
  if (teachingIndex < 0) throw new Error('Pipeline YAML teaching block is missing');
  let end = teachingIndex + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) {
    end += 1;
  }
  lines.splice(teachingIndex, end - teachingIndex, 'teaching:', `  source: "${docPath}"`);
  return lines.join('\n');
}

function sameBytes(path, content) {
  return existsSync(path) && readFileSync(path).equals(Buffer.from(content));
}

export function buildSyncPlan({ sourceDir, docsDir, pipelinesDir, catalog }) {
  validateSource(sourceDir, catalog);
  const expected = expectedDocuments(catalog);
  const deletes = markdownFiles(docsDir)
    .filter((file) => !expected.has(file))
    .map((file) => join(docsDir, file));
  const writes = [];

  for (const file of expected.keys()) {
    const content = readFileSync(join(sourceDir, file));
    const target = join(docsDir, file);
    if (!sameBytes(target, content)) writes.push({ path: target, content });
  }

  const expectedPipelineFiles = new Set();
  for (const [pipelineId, entry] of Object.entries(catalog.pipelines)) {
    expectedPipelineFiles.add(entry.file);
    const path = join(pipelinesDir, entry.file);
    if (!existsSync(path)) throw new Error(`Pipeline YAML is missing: ${entry.file}`);
    const content = readFileSync(path, 'utf8');
    const parsed = yaml.load(content);
    if (parsed?.meta?.pipeline_id !== pipelineId) {
      throw new Error(`Pipeline YAML ID mismatch: ${entry.file} declares ${parsed?.meta?.pipeline_id}`);
    }
    const rewritten = rewritePipelineYaml(content, documentPathForPipeline(catalog, pipelineId));
    if (rewritten !== content) writes.push({ path, content: rewritten });
  }

  const unexpectedPipelines = readdirSync(pipelinesDir)
    .filter((file) => !file.startsWith('_') && file.endsWith('.skill.yaml'))
    .filter((file) => !expectedPipelineFiles.has(file));
  if (unexpectedPipelines.length > 0) {
    throw new Error(`Uncataloged pipeline YAML: ${unexpectedPipelines.join(', ')}`);
  }

  return { deletes, writes };
}

export function applySyncPlan(plan) {
  for (const path of plan.deletes) rmSync(path, { force: true });
  for (const write of plan.writes) {
    mkdirSync(dirname(write.path), { recursive: true });
    writeFileSync(write.path, write.content);
  }
}

export function checkSynchronizedState(options) {
  const plan = buildSyncPlan(options);
  return [
    ...plan.deletes.map((path) => `unexpected legacy document: ${path}`),
    ...plan.writes.map((write) => `out-of-sync file: ${write.path}`),
  ];
}

function parseArgs(argv) {
  const options = { apply: false, source: DEFAULT_DOCS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--check') options.apply = false;
    else if (argument === '--source') options.source = resolve(argv[++index]);
    else if (argument === '--catalog') options.catalog = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(options.catalog);
  if (options.apply) validateGitSource(options.source, catalog);
  const syncOptions = {
    sourceDir: options.source,
    docsDir: DEFAULT_DOCS,
    pipelinesDir: DEFAULT_PIPELINES,
    catalog,
  };
  const plan = buildSyncPlan(syncOptions);
  if (options.apply) {
    applySyncPlan(plan);
    const failures = checkSynchronizedState({ ...syncOptions, sourceDir: DEFAULT_DOCS });
    if (failures.length > 0) throw new Error(failures.join('\n'));
    validateRepositoryReferences(catalog);
    console.log(`Rendering pipeline sync applied: ${catalog.documents.length} articles, ${Object.keys(catalog.pipelines).length} detection entries.`);
    return;
  }
  const failures = [
    ...plan.deletes.map((path) => `unexpected legacy document: ${path}`),
    ...plan.writes.map((write) => `out-of-sync file: ${write.path}`),
  ];
  if (failures.length > 0) throw new Error(failures.join('\n'));
  validateRepositoryReferences(catalog);
  console.log(`Rendering pipeline sync check passed: ${catalog.documents.length} articles, ${Object.keys(catalog.pipelines).length} detection entries.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Rendering pipeline sync failed: ${error.message}`);
    process.exit(1);
  }
}
