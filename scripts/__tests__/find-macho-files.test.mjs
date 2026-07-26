// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { findMachOFiles, isMachOFile } = require('../find-macho-files.cjs');

const machoMagics = [
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
];

test('isMachOFile recognizes thin and universal Mach-O headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'smartperfetto-macho-header-'));
  try {
    for (const magic of machoMagics) {
      const file = join(root, magic.toString(16));
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32BE(magic);
      writeFileSync(file, bytes);
      assert.equal(isMachOFile(file), true);
    }

    const textFile = join(root, 'plain.txt');
    writeFileSync(textFile, 'not a binary');
    assert.equal(isMachOFile(textFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findMachOFiles finds native binaries regardless of extension or mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'smartperfetto-macho-tree-'));
  try {
    const nested = join(root, 'node_modules', 'native', 'prebuilds');
    mkdirSync(nested, { recursive: true });
    const bareFile = join(nested, 'native-addon.bare');
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(0xfeedfacf);
    writeFileSync(bareFile, bytes, { mode: 0o644 });
    writeFileSync(join(nested, 'README'), 'documentation', { mode: 0o755 });

    assert.deepEqual(findMachOFiles(root), [bareFile]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
