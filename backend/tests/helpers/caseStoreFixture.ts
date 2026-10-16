// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';

import type {CaseNode} from '../../src/types/sparkContracts';

/** A reviewed, shareable case without knowledge, for tests of curation and recall. */
export function curatedCaseNode(caseId: string, overrides: Partial<CaseNode> = {}): CaseNode {
  return {
    schemaVersion: 1,
    source: 'curated_markdown_case',
    createdAt: 1,
    caseId,
    title: `${caseId} shader compile jank`,
    status: 'reviewed',
    redactionState: 'redacted',
    traceArtifactId: `artifact-${caseId}`,
    tags: ['scrolling', 'shader_compile'],
    findings: [{id: 'f1', severity: 'warning', title: 'Pipeline creation inside the frame'}],
    ...overrides,
  };
}

/**
 * Write the case file as a release before curation attestations persisted it:
 * `{schemaVersion, cases}` only. The cases already there are kept and `records`
 * replace theirs by id; every attestation in the file is dropped.
 */
export function writeCaseFileWithoutAttestations(libraryPath: string, ...records: CaseNode[]): void {
  const stored: CaseNode[] = fs.existsSync(libraryPath)
    ? (JSON.parse(fs.readFileSync(libraryPath, 'utf-8')) as {cases: CaseNode[]}).cases
    : [];
  const ids = new Set(records.map(record => record.caseId));
  fs.writeFileSync(libraryPath, JSON.stringify({
    schemaVersion: 1,
    cases: [...stored.filter(record => !ids.has(record.caseId)), ...records],
  }));
}
