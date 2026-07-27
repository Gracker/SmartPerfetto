// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PAIRED_HEADING_MARKER,
  pairedHeadingErrors,
} from '../i18n-heading-contract.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-i18n-headings-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'docs', 'nested'), {recursive: true});
  return root;
}

function writePair(root, relativeBase, left, right) {
  const basePath = path.join(root, 'docs', relativeBase);
  fs.mkdirSync(path.dirname(basePath), {recursive: true});
  fs.writeFileSync(`${basePath}.md`, `${left}\n`);
  fs.writeFileSync(`${basePath}.en.md`, `${right}\n`);
}

test('discovers marked pairs recursively without a hand-maintained file list', t => {
  const root = fixture(t);
  writePair(
    root,
    'nested/contract',
    `# 中文\n\n${PAIRED_HEADING_MARKER}\n\n## 一\n\n### 二`,
    `# English\n\n${PAIRED_HEADING_MARKER}\n\n## One\n\n### Two`,
  );
  assert.deepEqual(pairedHeadingErrors(root), []);
});

test('rejects a pair whose heading levels drift', t => {
  const root = fixture(t);
  writePair(
    root,
    'contract',
    `# 中文\n\n${PAIRED_HEADING_MARKER}\n\n## 一`,
    `# English\n\n${PAIRED_HEADING_MARKER}\n\n### One`,
  );
  assert.match(pairedHeadingErrors(root).join('\n'), /different heading structures/u);
});

test('requires both sides of an opted-in pair to carry the marker', t => {
  const root = fixture(t);
  writePair(
    root,
    'contract',
    `# 中文\n\n${PAIRED_HEADING_MARKER}`,
    '# English',
  );
  assert.match(pairedHeadingErrors(root).join('\n'), /does not/u);
});
