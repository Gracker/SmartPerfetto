// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { ENTERPRISE_SECURITY_AUDIT_CHECKLIST } from './enterpriseSecurityAuditChecklist';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const EXPECTED_IDS = [
  'id-enumeration-trace-session-report',
  'cross-tenant-owner-guard',
  'provider-management-permission',
  'report-read-permission',
  'memory-admin-permission',
] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('enterprise security audit checklist', () => {
  it('keeps the enterprise security audit scope explicit', () => {
    expect(ENTERPRISE_SECURITY_AUDIT_CHECKLIST.map(item => item.id)).toEqual(EXPECTED_IDS);
    expect(new Set(ENTERPRISE_SECURITY_AUDIT_CHECKLIST.map(item => item.auditArea)).size).toBe(EXPECTED_IDS.length);
  });

  it('verifies every audit item against source-level evidence', () => {
    for (const item of ENTERPRISE_SECURITY_AUDIT_CHECKLIST) {
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const evidence of item.evidence) {
        const evidencePath = path.join(REPO_ROOT, evidence.file);
        expect(fs.existsSync(evidencePath)).toBe(true);

        const content = readRepoFile(evidence.file);
        for (const pattern of evidence.patterns) {
          expect(content).toContain(pattern);
        }
      }
    }
  });
});
