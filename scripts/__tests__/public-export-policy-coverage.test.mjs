// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// backend/skills/public-export.yaml must classify every file the
// Perfetto-Skills exporter considers (tools/export_from_smartperfetto.py,
// validate_policy_sources). The exporter only runs at paired-sync time, so a
// file added without a classification otherwise surfaces after landing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(projectRoot, 'backend/package.json'));
const yaml = require('js-yaml');

function filesUnder(relativeRoot, accept, {optional = false, repoRoot = projectRoot} = {}) {
  const root = path.join(repoRoot, relativeRoot);
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (optional && dir === root && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && accept(entry.name)) found.push(path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

const policy = yaml.load(fs.readFileSync(path.join(projectRoot, 'backend/skills/public-export.yaml'), 'utf8'));

const sets = {
  strategies: filesUnder('backend/strategies', () => true),
  pipeline_docs: filesUnder('docs/rendering_pipelines', name => name.endsWith('.md'), {optional: true}),
  sql_fragments: fs.readdirSync(path.join(projectRoot, 'backend/skills/fragments'))
    .filter(name => name.endsWith('.sql'))
    .map(name => `backend/skills/fragments/${name}`)
    .sort(),
  vendor_overrides: filesUnder('backend/skills/vendors', name => name.endsWith('.override.yaml')),
};

function assertCoverage(key, mapping, current) {
  assert.equal(typeof mapping, 'object', `${key} must be a mapping`);
  const classified = new Set(Object.keys(mapping));
  const missing = current.filter(file => !classified.has(file));
  const stale = [...classified].filter(file => !current.includes(file)).sort();
  assert.deepEqual({missing, stale}, {missing: [], stale: []});
}

for (const [key, current] of Object.entries(sets)) {
  test(`public-export.yaml classifies exactly the current ${key}`, () => assertCoverage(key, policy[key], current));
}

test('an absent optional article directory is empty, while stale and unclassified exports still fail', () => {
  const repoRoot = fs.mkdtempSync(path.join(tmpdir(), 'public-export-coverage-'));
  const relativeRoot = 'docs/rendering_pipelines';
  const scan = () => filesUnder(relativeRoot, name => name.endsWith('.md'), {optional: true, repoRoot});
  try {
    assert.deepEqual(scan(), []);
    assertCoverage('pipeline_docs', {}, scan());
    const draft = `${relativeRoot}/draft.md`;
    assert.throws(() => assertCoverage('pipeline_docs', {[draft]: {}}, scan()), assert.AssertionError);
    fs.mkdirSync(path.join(repoRoot, relativeRoot), {recursive: true});
    fs.writeFileSync(path.join(repoRoot, draft), '# Fixture\n');
    assert.deepEqual(scan(), [draft]);
    assert.throws(() => assertCoverage('pipeline_docs', {}, scan()), assert.AssertionError);
    assertCoverage('pipeline_docs', {[draft]: {}}, scan());
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});

test('required roots and non-directory failures are not treated as optional empty inventories', () => {
  const repoRoot = fs.mkdtempSync(path.join(tmpdir(), 'public-export-coverage-'));
  try {
    assert.throws(() => filesUnder('required', () => true, {repoRoot}), {code: 'ENOENT'});
    fs.writeFileSync(path.join(repoRoot, 'file'), 'fixture');
    assert.throws(() => filesUnder('file', () => true, {optional: true, repoRoot}), {code: 'ENOTDIR'});
  } finally {
    fs.rmSync(repoRoot, {recursive: true, force: true});
  }
});
