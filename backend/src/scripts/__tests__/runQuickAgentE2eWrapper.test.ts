// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { spawnSync } from 'child_process';
import path from 'path';

const backendRoot = path.resolve(__dirname, '../../..');
const wrapperPath = path.join(backendRoot, 'scripts/run-quick-agent-e2e.cjs');

function runWrapper(args: string[]) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
}

describe('run-quick-agent-e2e wrapper', () => {
  it('dry-runs the mixed trace/scrolling quick suite with strict quick-mode gates', () => {
    const result = runWrapper([
      '--suite',
      'mixed-trace-scrolling',
      '--runtime',
      'claude-agent-sdk',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] suite=mixed-trace-scrolling');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('SMARTPERFETTO_AGENT_RUNTIME=claude-agent-sdk');
    expect(result.stdout).toContain('--require-quick-run');
    expect(result.stdout).toContain('--require-data-envelope');
    expect(result.stdout).toContain('--forbid-degraded-fallback quick_full_report_shape');
    expect(result.stdout).toContain('--max-analysis-completed-conclusion-chars 900');
    expect(result.stdout).not.toContain('--max-rounds');
    expect(result.stdout).toContain('## 快速 Triage');
    expect(result.stdout).toContain('## 逐句数据引用（结构化来源）');
  });

  it('dry-runs the all-runtime matrix without provider credential requirements', () => {
    const result = runWrapper([
      '--suite',
      'trace-fact',
      '--runtime',
      'all',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=openai-agents-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=pi-agent-core');
    expect(result.stdout).toContain('[quick-e2e] runtime=opencode');
    expect(result.stdout).not.toContain('DEEPSEEK_API_KEY');
    expect(result.stdout).not.toContain('OPENAI_API_KEY is required');
  });
});
