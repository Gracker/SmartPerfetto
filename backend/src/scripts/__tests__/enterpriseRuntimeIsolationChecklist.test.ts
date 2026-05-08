// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { RUNTIME_ISOLATION_CHECKLIST } from '../enterpriseRuntimeIsolationChecklist';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const README_PATH = 'docs/features/enterprise-multi-tenant/README.md';
const CHECKLIST_DOC_PATH = 'docs/features/enterprise-multi-tenant/runtime-isolation-checklist.md';

const EXPECTED_IDS = [
  'proxy-status-websocket-query',
  'http-rpc-target-lease-proxy',
  'websocket-fifo-query-order',
  'agent-frontend-same-lease-stats',
  'sse-terminal-events-persisted',
  'running-run-independent-cleanup',
  'upload-temp-path-unique',
  'url-upload-streaming',
  'legacy-register-rpc-disabled',
  'cleanup-draining-audit',
  'window-scoped-session-storage',
  'report-generation-isolated-priority',
  'single-supervisor-crash-recovery',
  'timeout-health-admin-drain',
  'rss-budget-observed-highwater',
] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function readGitlink(relativePath: string): string {
  return execFileSync('git', ['ls-files', '-s', relativePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

function isPerfettoSubmoduleEvidence(relativePath: string): boolean {
  return relativePath.startsWith('perfetto/');
}

describe('enterprise runtime isolation checklist', () => {
  it('keeps the §11.11 checklist as an explicit 15-item contract', () => {
    expect(RUNTIME_ISOLATION_CHECKLIST.map(item => item.id)).toEqual(EXPECTED_IDS);
    expect(new Set(RUNTIME_ISOLATION_CHECKLIST.map(item => item.vulnerability)).size).toBe(EXPECTED_IDS.length);
    expect(new Set(RUNTIME_ISOLATION_CHECKLIST.map(item => item.acceptance)).size).toBe(EXPECTED_IDS.length);
  });

  it('maps every README §11.11 vulnerability and acceptance row to the checklist', () => {
    const readme = readRepoFile(README_PATH);

    for (const item of RUNTIME_ISOLATION_CHECKLIST) {
      expect(readme).toContain(item.vulnerability);
      expect(readme).toContain(item.acceptance);
    }
    expect(readme).toContain('- [x] 4.12 §11.11 漏洞清单：每行设计验收都打勾验证');
    expect(readme).toContain(`- [x] \`${CHECKLIST_DOC_PATH}\``);
  });

  it('verifies the evidence file and pattern for every checklist item', () => {
    const checkedEvidence = new Set<string>();
    const missingRootEvidence: string[] = [];

    for (const item of RUNTIME_ISOLATION_CHECKLIST) {
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const evidence of item.evidence) {
        const evidencePath = path.join(REPO_ROOT, evidence.file);
        if (!fs.existsSync(evidencePath)) {
          if (isPerfettoSubmoduleEvidence(evidence.file)) {
            expect(readGitlink('perfetto')).toMatch(/^160000 [0-9a-f]{40} 0\tperfetto$/);
            checkedEvidence.add(`${evidence.file}:perfetto-submodule-gitlink`);
            continue;
          }
          missingRootEvidence.push(evidence.file);
          continue;
        }

        const content = readRepoFile(evidence.file);
        expect(evidence.patterns.length).toBeGreaterThan(0);
        for (const pattern of evidence.patterns) {
          expect(content).toContain(pattern);
          checkedEvidence.add(`${evidence.file}:${pattern}`);
        }
      }
    }

    expect(missingRootEvidence).toEqual([]);
    expect(checkedEvidence.size).toBeGreaterThanOrEqual(EXPECTED_IDS.length * 2);
  });

  it('keeps the runtime isolation checklist document synchronized with the contract', () => {
    const doc = readRepoFile(CHECKLIST_DOC_PATH);

    for (const item of RUNTIME_ISOLATION_CHECKLIST) {
      expect(doc).toContain(item.id);
      expect(doc).toContain(item.vulnerability);
      expect(doc).toContain(item.acceptance);
    }
    expect(doc).toContain('cd backend && npx jest --runInBand src/scripts/__tests__/enterpriseRuntimeIsolationChecklist.test.ts');
  });
});
