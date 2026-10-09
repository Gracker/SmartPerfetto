// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import type {SkillDefinition} from '../../services/skillEngine/types';
import type {InvestigationEvidenceDeclaration} from '../../services/evidence/investigationEvidenceLedger';

const declaration: InvestigationEvidenceDeclaration = {window: {start: 'start', end: 'end'},
  identity: {upid: 'upid', utid: 'utid'}, metrics: [{domain: 'cpu_frequency', metric_id: 'system.cpu.frequency.time_weighted',
    value: 'freq', unit: 'kHz', status: 'status', coverage: 'coverage', denominator: 'denominator'}]};
const fixtureSkill = {name: 'entry_fixture', version: '1', type: 'atomic',
  meta: {display_name: 'Entry fixture', description: 'Scene overview'}, process_scope: {role: 'global_context'},
  inputs: [{name: 'start_ts', type: 'timestamp', required: false}],
  sql: 'SELECT * FROM actual_overview', investigation_evidence: declaration,
  output: {display: {layer: 'overview', level: 'key', format: 'table', columns: [{name: 'freq', type: 'number'}]}},
} as unknown as SkillDefinition;

jest.mock('../../services/skillEngine/skillLoader', () => {
  const registry = {
    getSkill: (id: string) => id === 'entry_fixture' ? fixtureSkill : undefined,
    // External authorship skips the built-in localization catalog.
    getSkillOrigin: () => ({origin: 'external_pack'}),
    hasVendorOverrides: () => false,
    getVendorOverride: () => undefined,
    getAllSkills: () => [fixtureSkill],
    getFragmentCache: () => new Map(),
    isInitialized: () => true,
  };
  return {skillRegistry: registry, ensureSkillRegistryInitialized: async () => undefined};
});

import {ArtifactStore} from '../artifactStore';
import {createClaudeMcpServer} from '../claudeMcpServer';
import {executePreparedSkillRun, prepareSkillRun, type SkillRunDeps} from '../skillRunCore';
import {summarizeToolCallInput} from '../toolCallSummary';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {SkillRegistryView} from '../../services/skillEngine/skillAnalysisAdapter';
import {runWithinRuntimeToolInvocation} from '../../agentRuntime/runtimeToolInvocationContext';
import {decodeRuntimeToolResult} from '../../agentRuntime/runtimeToolResult';

const TRACE = 'trace-core';
const COLUMNS = ['start', 'end', 'upid', 'utid', 'freq', 'status', 'coverage', 'denominator'];
const ROW = [10, 110, 42, 43, 1234, 'observed', 100, 100];
const registry = {getSkill: (id: string) => id === 'entry_fixture' ? fixtureSkill : undefined} as unknown as SkillRegistryView;
const tp = () => ({query: async () => ({columns: COLUMNS, rows: [ROW], durationMs: 1})}) as any;

function executor(): SkillExecutor {
  const created = new SkillExecutor(tp());
  created.registerSkill(fixtureSkill);
  return created;
}

const ledgerRecords = (store: ArtifactStore, runId?: string) => store.createEvidenceReadView({ownerKey: 'owner',
  ...(runId ? {currentRunId: runId} : {}), allowedTraces: [{traceId: TRACE, traceSide: 'current'}]}).investigationEvidence!();

/** What both paths must agree on, without the producer call id each path names. */
function producerFree<T>(value: T): unknown {
  // A query review's id hashes its producer call; everything else must match.
  return JSON.parse(JSON.stringify(value, (key, field) =>
    ['sourceToolCallId', 'tool', 'purpose', 'storedAt', 'lastAccessedAt', 'producerReason'].includes(key)
      || (key === 'id' && typeof field === 'string' && field.startsWith('qr:')) ? undefined : field));
}

async function viaInvokeSkill(params: Record<string, unknown>) {
  const store = new ArtifactStore();
  const mcp = createClaudeMcpServer({traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor(),
    artifactStore: store, outputLanguage: 'en', runId: 'run-1'} as any);
  const invokeSkill = mcp.toolDefinitions.find(definition => definition.name === 'invoke_skill')!;
  const result = await invokeSkill.shared.handler({skillId: 'entry_fixture', params}, {toolCallId: 'model-call-1'});
  return {store, payload: decodeRuntimeToolResult(result).body as any};
}

async function viaCore(params: Record<string, unknown>, producerId: string) {
  const store = new ArtifactStore();
  const deps: SkillRunDeps = {traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor(),
    artifactStore: store, outputLanguage: 'en'};
  const preparation = await prepareSkillRun(deps, {skillId: 'entry_fixture', params, registry});
  if (preparation.status !== 'ready') throw new Error('not ready');
  const paramsHash = summarizeToolCallInput('invoke_skill',
    {skillId: 'entry_fixture', params: preparation.prepared.effectiveParams}).paramsHash;
  // The product path observes its own call, as the scene entry helper does.
  const event = {toolCallId: producerId, toolName: 'scene_entry_evidence', params: {}, extra: {}};
  store.observeInvestigationTool({...event, phase: 'started'}, 'run-1');
  const outcome = await runWithinRuntimeToolInvocation({toolCallId: producerId, runId: 'run-1'}, () =>
    executePreparedSkillRun(deps, preparation.prepared, {producer: {sourceToolCallId: producerId, paramsHash}}));
  store.observeInvestigationTool({...event, phase: 'completed', result: {content: []}}, 'run-1');
  return {store, outcome};
}

describe('shared Skill-run core', () => {
  it('produces the same evidence locators, artifacts, captures and query reviews as invoke_skill', async () => {
    const params = {start_ts: '1000'};
    const model = await viaInvokeSkill(params);
    const product = await viaCore(params, 'scene-entry:entry_fixture:abc');
    if (product.outcome.status !== 'committed') throw new Error('not committed');

    expect(model.payload.success).toBe(true);
    const modelArtifact = model.payload.artifacts[0];
    expect(product.outcome.artifactIdsByDisplayIndex).toEqual([modelArtifact.id]);
    expect(product.outcome.evidenceRefIdsByDisplayIndex).toEqual([modelArtifact.evidenceRefId]);
    expect(producerFree(product.store.get(modelArtifact.id))).toEqual(producerFree(model.store.get(modelArtifact.id)));
    expect(producerFree(product.outcome.queryReviewsByDisplayIndex[0]))
      .toEqual(producerFree(model.store.get(modelArtifact.id)!.queryReview));
    expect(product.outcome.queryReviewsByDisplayIndex[0]).toBeDefined();
    expect(product.outcome.captureCount).toBe(1);
    const modelRecords = ledgerRecords(model.store, 'run-1').records;
    const productRecords = ledgerRecords(product.store, 'run-1').records;
    expect(productRecords.map(record => record.status)).toEqual(['observed']);
    expect(productRecords.length).toBe(modelRecords.length);
    expect(producerFree(productRecords.map(({captureId: _c, recordId: _r, ...rest}) => rest)))
      .toEqual(producerFree(modelRecords.map(({captureId: _c, recordId: _r, ...rest}) => rest)));
  });

  it('writes nothing when the commit check refuses after the Skill returned', async () => {
    const store = new ArtifactStore();
    const deps: SkillRunDeps = {traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor(),
      artifactStore: store, outputLanguage: 'en'};
    const preparation = await prepareSkillRun(deps, {skillId: 'entry_fixture', params: {}, registry});
    if (preparation.status !== 'ready') throw new Error('not ready');
    const outcome = await executePreparedSkillRun(deps, preparation.prepared,
      {producer: {sourceToolCallId: 'p', paramsHash: 'h'}, beforeCommit: () => 'cancelled'});
    expect(outcome).toMatchObject({status: 'commit_refused', reason: 'cancelled'});
    expect(outcome.result.success).toBe(true);
    expect(store.get('art-1')).toBeUndefined();
    expect(ledgerRecords(store).records).toEqual([]);
  });

  it.each([
    ['an unknown Skill', 'missing_skill', {}, 'unavailable'],
    ['an undeclared parameter', 'entry_fixture', {frame_id: 3}, 'undeclared_params'],
  ])('refuses %s before running anything', async (_label, skillId, params, kind) => {
    const deps: SkillRunDeps = {traceId: TRACE, traceProcessorService: tp(), skillExecutor: executor(),
      artifactStore: new ArtifactStore(), outputLanguage: 'en'};
    const execute = jest.spyOn(deps.skillExecutor, 'execute');
    const preparation = await prepareSkillRun(deps, {skillId, params, registry});
    expect(preparation).toMatchObject({status: 'refused', refusal: {kind}});
    expect(execute).not.toHaveBeenCalled();
  });
});
