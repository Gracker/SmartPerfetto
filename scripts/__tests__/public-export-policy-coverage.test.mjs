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
import {createRequire} from 'node:module';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(projectRoot, 'backend/package.json'));
const yaml = require('js-yaml');

function filesUnder(relativeRoot, accept) {
  const root = path.join(projectRoot, relativeRoot);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && accept(entry.name)) found.push(path.relative(projectRoot, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return found.sort();
}

const policy = yaml.load(fs.readFileSync(path.join(projectRoot, 'backend/skills/public-export.yaml'), 'utf8'));

const sets = {
  strategies: filesUnder('backend/strategies', () => true),
  pipeline_docs: filesUnder('docs/rendering_pipelines', name => name.endsWith('.md')),
  sql_fragments: fs.readdirSync(path.join(projectRoot, 'backend/skills/fragments'))
    .filter(name => name.endsWith('.sql'))
    .map(name => `backend/skills/fragments/${name}`)
    .sort(),
  vendor_overrides: filesUnder('backend/skills/vendors', name => name.endsWith('.override.yaml')),
};

for (const [key, current] of Object.entries(sets)) {
  test(`public-export.yaml classifies exactly the current ${key}`, () => {
    const mapping = policy[key];
    assert.equal(typeof mapping, 'object', `${key} must be a mapping`);
    const classified = new Set(Object.keys(mapping));
    const missing = current.filter(file => !classified.has(file));
    const stale = [...classified].filter(file => !current.includes(file)).sort();
    assert.deepEqual({missing, stale}, {missing: [], stale: []});
  });
}
