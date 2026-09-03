// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const backendRoot = path.resolve(__dirname, '../../..');
const cliPath = path.join(backendRoot, 'src/cli/index.ts');
const tracePath = path.join(
  backendRoot,
  '../Trace/real/android-scroll-standard/trace.pftrace',
);
const packageName = 'com.example.wechatfriendforcustomscroller';

function runCli(args: string[]): string {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, ...args],
    {
      cwd: backendRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TP_PORT_MIN: '9600',
        TP_PORT_MAX: '9699',
      },
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(
      `CLI exited with status ${String(result.status)}: ${String(result.error ?? '')}\n${output.slice(-4_000)}`,
    );
  }
  return output;
}

describe('legacy Skill CLI fragment wiring', () => {
  it('executes a fragment-backed Skill through the test command', () => {
    const output = runCli([
      'test',
      'scrolling_analysis',
      '--trace',
      tracePath,
      '--package',
      packageName,
    ]);

    expect(output).toContain('Status:');
    expect(output).toContain('SUCCESS');
    expect(output).not.toContain('Fragment not found');
    expect(output).not.toContain('no such table: vsync_config');
  });

  it('executes a fragment-backed Skill through the smoke command', () => {
    const output = runCli([
      'smoke',
      '--trace',
      tracePath,
      '--package',
      packageName,
      '--pattern',
      '/^scrolling_analysis$/',
      '--max-skill-errors',
      '1',
    ]);

    expect(output).toContain('Failed:');
    expect(output).toMatch(/Failed:\s+(?:\x1b\[[0-9;]*m)*0/);
    expect(output).not.toContain('Fragment not found');
    expect(output).not.toContain('no such table: vsync_config');
    expect(output).not.toContain('no such table: _cpu_topology');
  });
});
