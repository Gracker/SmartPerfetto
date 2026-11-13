#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkRenderingCatalog(repoRoot = root) {
  const directory = join(repoRoot, 'backend/skills/pipelines');
  const catalog = yaml.load(fs.readFileSync(join(directory, 'index.yaml'), 'utf8'));
  if (catalog?.version !== '3.0' || 'source' in catalog || 'documents' in catalog) {
    throw new Error('Rendering knowledge must use product teaching cards, without article imports');
  }
  const files = new Set();
  for (const [id, entry] of Object.entries(catalog.pipelines)) {
    if (typeof entry.file !== 'string' || !/^[A-Za-z0-9_-]+\.skill\.yaml$/.test(entry.file) || files.has(entry.file)) {
      throw new Error(`Invalid or duplicate pipeline file: ${id}`);
    }
    files.add(entry.file);
    if (!catalog.rendering_types[entry.teaching_type_id]?.teaching) {
      throw new Error(`Missing teaching card: ${id}`);
    }
    const pipeline = yaml.load(fs.readFileSync(join(directory, entry.file), 'utf8'));
    const source = `skills/pipelines/index.yaml#rendering_types.${entry.teaching_type_id}`;
    if (pipeline.meta?.pipeline_id !== id || pipeline.meta.doc_path !== source || pipeline.teaching?.source !== source) {
      throw new Error(`Pipeline teaching source mismatch: ${id}`);
    }
  }
  const actual = fs.readdirSync(directory).filter((file) => !file.startsWith('_') && file.endsWith('.skill.yaml'));
  if (actual.length !== files.size || actual.some((file) => !files.has(file))) {
    throw new Error('Pipeline catalog inventory mismatch');
  }
  const policy = yaml.load(fs.readFileSync(join(repoRoot, 'backend/skills/public-export.yaml'), 'utf8'));
  if (!policy.pipeline_docs || Object.keys(policy.pipeline_docs).length > 0) {
    throw new Error('Unpublished rendering articles cannot be publicly projected');
  }
  const articles = join(repoRoot, 'docs/rendering_pipelines');
  if (fs.existsSync(articles) && fs.readdirSync(articles).length > 0) {
    throw new Error('Unpublished rendering articles cannot be distributed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRenderingCatalog();
  console.log('Product rendering catalog and teaching sources are consistent; no article distribution.');
}
