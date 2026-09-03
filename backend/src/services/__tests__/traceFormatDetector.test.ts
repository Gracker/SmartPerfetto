// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {detectTraceFormat} from '../traceFormatDetector';

const tempDirs: string[] = [];

function writePerfettoFixture(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-trace-format-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'trace.ptrace');
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([0x0a, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
    Buffer.from(body),
  ]));
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

describe('detectTraceFormat', () => {
  it('does not treat an Android H: tracing marker as HarmonyOS', async () => {
    const filePath = writePerfettoFixture('C|790|H:CPU_LOAD_RESET|33\nB|790|H:CPU_LOAD_RESET:33');

    await expect(detectTraceFormat(filePath)).resolves.toMatchObject({
      format: 'perfetto_protobuf',
      os: 'android',
      detectionMethod: 'magic',
    });
  });

  it('still detects a strong HarmonyOS marker inside Perfetto protobuf', async () => {
    const filePath = writePerfettoFixture('trace marker: ArkTS application lifecycle');

    await expect(detectTraceFormat(filePath)).resolves.toMatchObject({
      format: 'perfetto_protobuf',
      os: 'harmonyos',
      detectionMethod: 'content_scan',
    });
  });
});
