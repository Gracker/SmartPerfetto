import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('every asset-copy run removes obsolete article caches and preserves required processor pins', () => {
  const obsolete = join(root, 'backend/dist/rendering_pipelines');
  mkdirSync(obsolete, {recursive: true});
  writeFileSync(join(obsolete, 'obsolete.md'), '# Old reference article\n');
  execFileSync('node', ['backend/scripts/copy-runtime-assets.cjs'], {cwd: root});
  assert.equal(existsSync(obsolete), false);
  for (const file of ['trace-processor-pin.env', 'perfetto-recording-tools-pin.env']) {
    assert.deepEqual(readFileSync(join(root, 'backend/dist', file)), readFileSync(join(root, 'scripts', file)));
  }
});

test('Docker does not import reference articles and package verification rejects them', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /COPY docs\/rendering_pipelines/);
  const packageCheck = readFileSync(join(root, 'backend/scripts/check-cli-pack.cjs'), 'utf8');
  assert.match(packageCheck, /unpublished rendering article in package/);
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(rootPackage.scripts['sync:rendering-pipelines'], undefined);
  assert.match(rootPackage.scripts['verify:pr'], /verify:rendering-pipelines/);
});
