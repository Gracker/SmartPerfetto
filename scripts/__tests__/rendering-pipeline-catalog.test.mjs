import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import * as yaml from 'js-yaml';
import {checkRenderingCatalog} from '../check-rendering-pipelines.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'rendering-cards-'));
  const directory = join(root, 'backend/skills/pipelines');
  mkdirSync(directory, {recursive: true});
  const catalog = {version: '3.0', rendering_types: {STANDARD: {kind: 'concrete', teaching: {title: 'Window'}}},
    pipelines: {STANDARD: {file: 'standard.skill.yaml', teaching_type_id: 'STANDARD'}}};
  const pipeline = {meta: {pipeline_id: 'STANDARD', doc_path: 'skills/pipelines/index.yaml#rendering_types.STANDARD'},
    teaching: {source: 'skills/pipelines/index.yaml#rendering_types.STANDARD'}};
  const save = () => {
    writeFileSync(join(directory, 'index.yaml'), yaml.dump(catalog));
    writeFileSync(join(directory, 'standard.skill.yaml'), yaml.dump(pipeline));
  };
  writeFileSync(join(root, 'backend/skills/public-export.yaml'), 'pipeline_docs: {}\n');
  save();
  try { run({root, directory, catalog, pipeline, save}); }
  finally { rmSync(root, {recursive: true, force: true}); }
}

test('repository teaching sources resolve without original articles', () => checkRenderingCatalog());

test('fails closed when a pipeline points to a different teaching card', () => fixture(({root, pipeline, save}) => {
  pipeline.teaching.source = 'missing.md'; save();
  assert.throws(() => checkRenderingCatalog(root), /source mismatch/);
}));

test('rejects an unsafe pipeline file and missing card', () => fixture(({root, catalog, save}) => {
  catalog.pipelines.STANDARD.file = '../outside.skill.yaml'; save();
  assert.throws(() => checkRenderingCatalog(root), /Invalid/);
  catalog.pipelines.STANDARD.file = 'standard.skill.yaml';
  delete catalog.rendering_types.STANDARD.teaching; save();
  assert.throws(() => checkRenderingCatalog(root), /Missing teaching card/);
}));

test('rejects article imports, their distribution and their public projection', () => fixture(({root, catalog, save}) => {
  catalog.documents = []; save();
  assert.throws(() => checkRenderingCatalog(root), /without article imports/);
  delete catalog.documents; save();
  writeFileSync(join(root, 'backend/skills/public-export.yaml'), 'pipeline_docs:\n  draft.md: {disposition: exported}\n');
  assert.throws(() => checkRenderingCatalog(root), /publicly projected/);
  writeFileSync(join(root, 'backend/skills/public-export.yaml'), 'pipeline_docs: {}\n');
  mkdirSync(join(root, 'docs/rendering_pipelines'), {recursive: true});
  writeFileSync(join(root, 'docs/rendering_pipelines/draft.md'), '# Draft\n');
  assert.throws(() => checkRenderingCatalog(root), /cannot be distributed/);
}));
