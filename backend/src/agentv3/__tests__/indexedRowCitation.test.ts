// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Rows the model sees out of order (an interest-sorted SQL summary) or from a
 * non-zero page offset carry their artifact-wide rowIndex inline. A claim that
 * copies that index resolves to the original captured row; a wrong cell is
 * still a contradiction.
 *
 * Regression for a real run: a 15-row thread query ordered main thread first
 * was summarized by slice_count, putting HeapTaskDaemon at sample position 0.
 * The model cited sample positions as rowIndex and a correct answer ended `!`.
 */

import {describe, expect, it, jest} from '@jest/globals';
import {createClaudeMcpServer} from '../claudeMcpServer';
import {ArtifactStore} from '../artifactStore';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {QueryResult, TraceProcessorService} from '../../services/traceProcessorService';
import {parseConclusionContractDeclaration, type ConclusionContractClaimReference} from '../../agent/core/conclusionContract';
import {prepareClaimEvidence} from '../../services/evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../services/verifier/claimVerificationRunner';

const TRACE_ID = 'trace-indexed-rows';
const PROBE_ROWS: QueryResult['rows'] = [
  ['com.example.app', 1, 40],
  ['HeapTaskDaemon', 0, 90],
  ...Array.from({length: 13}, (_, index) => [`worker-${index}`, 0, 10 - index]),
];
const METRIC_ROWS: QueryResult['rows'] = Array.from({length: 60}, (_, index) => [index, `slice-${index}`]);

function fixture() {
  const query = jest.fn(async (_traceId: string, sql: string): Promise<QueryResult> => {
    if (sql.includes('probe_threads')) {
      return {columns: ['thread_name', 'is_main_thread', 'slice_count'], rows: PROBE_ROWS, durationMs: 1};
    }
    if (sql.includes('metric_rows')) return {columns: ['id', 'slice_name'], rows: METRIC_ROWS, durationMs: 1};
    return {columns: [], rows: [], durationMs: 0};
  });
  const traceProcessorService = {query} as unknown as TraceProcessorService;
  const artifactStore = new ArtifactStore();
  const mcp = createClaudeMcpServer({
    sessionId: 'session-indexed-rows', traceId: TRACE_ID,
    traceProcessorService, skillExecutor: new SkillExecutor(traceProcessorService), artifactStore,
    emitUpdate: () => {},
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const definition = mcp.toolDefinitions.find(tool => tool.name === name)!;
    const response = await definition.shared.handler(args, {});
    expect(response.isError).not.toBe(true);
    return response.structuredContent as Record<string, any>;
  };
  // A read view admits the captures that exist when it is created, like finalization.
  const readView = () => artifactStore.createEvidenceReadView({
    ownerKey: 'indexed-rows-owner', allowedTraces: [{traceId: TRACE_ID, traceSide: 'current'}]});
  return {call, readView};
}

async function verifyCell(readView: () => ReturnType<ArtifactStore['createEvidenceReadView']>,
  reference: ConclusionContractClaimReference) {
  const conclusionContract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: [{id: 'cell', kind: 'identity', text: `The cited cell is ${String(reference.value)}.`, references: [reference],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'captured.cell', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [reference]}}}],
  }).contract!;
  const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: readView()});
  const claim = runClaimVerification({conclusionContract, preparedEvidence}).claimVerificationResult.claimResults[0];
  return {reference: claim.referenceResults?.[0]?.status, proof: claim.deterministicProof?.status};
}

describe('indexed model-visible rows', () => {
  it('lets a claim cite the inline rowIndex of an interest-sorted summary sample', async () => {
    const {call, readView} = fixture();
    const result = await call('execute_sql', {sql: 'SELECT * FROM probe_threads', summary: true});
    expect(result).toMatchObject({mode: 'summary', rowShape: 'indexed_rows@1', totalRows: 15});
    // Sample position 0 is the busier daemon; the main thread is second but keeps rowIndex 0.
    expect(result.sampleRows.slice(0, 2)).toEqual([
      {rowIndex: 1, values: ['HeapTaskDaemon', 0, 90]},
      {rowIndex: 0, values: ['com.example.app', 1, 40]},
    ]);
    const main = result.sampleRows.find((sample: any) => sample.values[1] === 1);
    const cite = (rowIndex: number, value: string) =>
      ({evidenceRefId: result.evidenceRefId, rowIndex, column: 'thread_name', value});

    expect(await verifyCell(readView, cite(main.rowIndex, 'com.example.app')))
      .toEqual({reference: 'matched', proof: 'proved'});
    // The failure the inline index removes: the sample position names another row.
    const position = result.sampleRows.indexOf(main);
    expect(await verifyCell(readView, cite(position, 'com.example.app'))).toMatchObject({reference: 'value_mismatch'});
    // Strictness is unchanged: a wrong cell at the right row is still a contradiction.
    expect(await verifyCell(readView, cite(main.rowIndex, 'HeapTaskDaemon'))).toMatchObject({reference: 'value_mismatch'});
  });

  it('numbers fetched artifact pages from their offset and resolves them to the captured row', async () => {
    const {call, readView} = fixture();
    const summary = await call('execute_sql', {sql: 'SELECT * FROM metric_rows'});
    expect(summary).toMatchObject({autoSummarized: true, rowShape: 'indexed_rows@1'});
    const page = await call('fetch_artifact', {artifactId: summary.artifactId, detail: 'rows', offset: 50, limit: 3});
    expect(page.rowShape).toBe('indexed_rows@1');
    expect(page.rows).toEqual([50, 51, 52].map(rowIndex => ({rowIndex, values: [rowIndex, `slice-${rowIndex}`]})));
    expect(await verifyCell(readView,
      {artifactId: summary.artifactId, rowIndex: page.rows[1].rowIndex, column: 'slice_name', value: 'slice-51'}))
      .toEqual({reference: 'matched', proof: 'proved'});
    // detail="full" keeps the original structure, numbered from 0 in order.
    const full = await call('fetch_artifact', {artifactId: summary.artifactId, detail: 'full'});
    expect(full).not.toHaveProperty('rowShape');
    expect(full.data.rows[0]).toEqual([0, 'slice-0']);
  });
});
