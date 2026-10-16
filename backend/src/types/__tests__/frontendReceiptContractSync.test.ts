// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import {describe, expect, it} from '@jest/globals';

import {
  ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS,
  ANALYSIS_RECEIPT_PUBLIC_TYPE_PATHS,
  analysisPublicTypeFragments,
  findOutOfSyncContractFragments,
} from '../../../scripts/frontendContractFragments';

const backendSrc = path.resolve(__dirname, '../..');
const read = (sourcePath: string): string => fs.readFileSync(path.join(backendSrc, sourcePath), 'utf8');
const DATA_CONTRACT = 'types/dataContract.ts';

/** The receipt fragment, optionally from edited backend sources. */
function receiptFragment(edit: (sourcePath: string, content: string) => string = (_path, content) => content): string {
  const source = (sourcePath: string) => edit(sourcePath, read(sourcePath));
  return analysisPublicTypeFragments(
    source(DATA_CONTRACT),
    ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS.map(source),
    ANALYSIS_RECEIPT_PUBLIC_TYPE_PATHS.map(source),
  ).analysisReceipt;
}

const fragment = receiptFragment();
/** A generated module as `check:types` sees it: the fragment between other declarations. */
const generated = `/** header */\n\nexport type Before = 1;\n\n${fragment}\n\nexport type After = 2;\n`;
const outOfSync = (frontend: string, content = fragment) =>
  findOutOfSyncContractFragments(frontend, [{name: 'AnalysisReceipt', content}]);

describe('AnalysisReceipt frontend contract', () => {
  it('extracts the complete receipt declarations and their dependencies from the backend source', () => {
    for (const declaration of [
      'export type AnalysisReceipt = AnalysisReceiptV1 | AnalysisReceiptV2;',
      'export interface AnalysisReceiptV2 extends AnalysisReceiptBase',
      'export interface AnalysisReceiptBase',
      'export interface AdaptiveRoutingReceiptV1',
      'export interface CapabilityManifestAttributionV1',
      'export interface TraceSummaryAttributionV1',
      'export type AnalysisReceiptRuntime = AgentRuntimeKind;',
    ]) expect(fragment).toContain(declaration);
    for (const field of [
      'knowledgeReferenceCount?: number;',
      'referencesMatchedClaims?: number;',
      'propositionProvedClaims?: number;',
      'adaptiveRouting?: AdaptiveRoutingReceiptV1;',
    ]) expect(fragment).toContain(field);
    // The AnalysisCompletedEvent fragment already emits AgentRuntimeKind.
    expect(fragment).not.toMatch(/export type AgentRuntimeKind\b/);
    expect(fragment).not.toContain('import(');
    expect(fragment).not.toContain('typeof ');
    expect(fragment).not.toContain('SPDX-License-Identifier');
    // A receipt carries a manifest attribution, never the manifest or where it was probed.
    for (const internal of ['CapabilityManifestV1', 'CapabilityManifestContentV1', 'CapabilityManifestProvenanceV1',
      'CapabilityManifestEntryV1', 'processorKey', 'leaseId', 'rpcEndpoint', 'probeSql']) {
      expect(fragment).not.toContain(internal);
    }
    expect(fragment).toContain('export type CapabilityManifestUnresolvedV1');
    expect(outOfSync(generated)).toEqual([]);
    expect(outOfSync(generated.replace(/;\n/g, ';   \r\n'))).toEqual([]);
  });

  const mutations: Array<[string, string, string]> = [
    ['a renamed nested field', 'sqlCount: number;', 'sqlCounts: number;'],
    ['an optional nested field made required', 'knowledgeReferenceCount?: number;', 'knowledgeReferenceCount: number;'],
    ['a required field made optional', 'runManifestId: string;', 'runManifestId?: string;'],
    ['a dropped union member', "'passed' | 'partial' | 'not_applicable'", "'passed' | 'not_applicable'"],
  ];

  it.each(mutations)('fails when the frontend copy has %s', (_label, from, to) => {
    expect(generated).toContain(from);
    expect(outOfSync(generated.replace(from, to))).toEqual(['AnalysisReceipt']);
  });

  it.each(mutations)('fails when the backend source has %s', (_label, from, to) => {
    const edited = receiptFragment((sourcePath, content) => {
      if (sourcePath !== DATA_CONTRACT) return content;
      expect(content).toContain(from);
      return content.replace(from, to);
    });
    expect(outOfSync(generated, edited)).toEqual(['AnalysisReceipt']);
  });

  it('fails when a dependency in another backend module changes', () => {
    const edited = receiptFragment((sourcePath, content) => {
      if (sourcePath !== 'types/adaptiveRouting.ts') return content;
      expect(content).toContain("  | 'return_gap';");
      return content.replace("  | 'return_gap';", ';');
    });
    expect(edited).not.toBe(fragment);
    expect(outOfSync(generated, edited)).toEqual(['AnalysisReceipt']);
  });
});
