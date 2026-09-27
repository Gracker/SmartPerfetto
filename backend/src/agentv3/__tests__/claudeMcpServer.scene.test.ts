// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createClaudeMcpServer} from '../claudeMcpServer';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {activateSceneRuntime, createSceneRunDispatchBinding, consumeSceneRuntimeSeal,
  sceneRunOwnerKey, type SceneRunDispatchBinding} from '../../agent/scene/sceneRuntimeBinding';
import {resolveRuntimeEvidenceStore} from '../../agentRuntime/runtimeEvidenceContext';
import {sceneRunState, type SceneRunContext} from '../../agent/scene/sceneRunContext';
import type {SceneTimelineSegment} from '../../agent/scene/sceneTimelineContract';
import type {SceneCoverageRegistrySnapshot} from '../../agent/scene/sceneCoveragePlan';
import {isPolicyRefusalResult} from '../toolNarration';
import {readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {sceneTimelineProposalSchema, sceneTimelineSegmentSchema, sceneTimelineSegmentToolSchema,
  sceneTimelineProposalToolShape, sceneEvidenceReferenceSchema} from '../../agent/scene/sceneTimelineContract';

const bindings: SceneRunDispatchBinding[] = [];
const scope = {runId: 'run-scene-mcp', sessionId: 'session-scene-mcp', traceId: 'trace-scene-mcp', ownerKey: sceneRunOwnerKey({})};
function fixture(sceneCoverageRegistry?: SceneCoverageRegistrySnapshot) {
  const query = jest.fn(async () => ({columns: ['start_ns', 'end_ns'], rows: [['0', '1000']], durationMs: 0}));
  const traceProcessorService = {query} as unknown as TraceProcessorService;
  const skillExecutor = new SkillExecutor(traceProcessorService);
  const controller = new AbortController();
  const binding = createSceneRunDispatchBinding({scope, signal: controller.signal, assertCurrent() {}});
  bindings.push(binding);
  const options = binding.bindOptions({runId: scope.runId});
  const artifactStore = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('unexpected fallback');});
  let open = true;
  const server = (sceneRunContext?: SceneRunContext) => createClaudeMcpServer({
    ...scope, traceProcessorService, skillExecutor, artifactStore, sceneRunContext,
    canInvokeTool: () => open, androidInternalsPackStore: null,
  });
  const activate = () => activateSceneRuntime(options, {...scope, deadlineMs: Date.now() + 60000,
    artifactStore, traceProcessorService, sceneCoverageRegistry, signal: controller.signal, canInvokeTool: () => open});
  return {server, activate, binding, controller, query, close: () => {open = false;}};
}
function segment(id: string): SceneTimelineSegment {
  return {id, startNs: '0', endNs: '1000', object: {kind: 'trace', key: scope.traceId},
    userAction: 'Input unavailable', deviceState: 'Device state unavailable', appResponse: 'No inferred app response',
    evidenceRefs: [], boundaries: {start: {source: 'trace_bound'}, end: {source: 'trace_bound'}}, dependencies: [], supersedes: []};
}
afterEach(() => {bindings.splice(0).forEach(binding => binding.release()); jest.restoreAllMocks();});

describe('shared scene proposal capability', () => {
  it('does not expose the tool in an ordinary MCP server', () => {
    const f = fixture();
    expect(f.server().toolDefinitions.some(tool => tool.name === 'propose_scene_timeline')).toBe(false);
    expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses forged and JSON-copied capabilities', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    expect(() => f.server({bindOptions: value => value})).toThrow('unissued_scene_runtime_capability');
    expect(() => f.server(JSON.parse(JSON.stringify(capability)))).toThrow('unissued_scene_runtime_capability');
  });
  it('registers the shared schema and returns bounded revision diagnostics while retaining full state privately', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const mcp = f.server(capability);
    const tool = mcp.toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    expect(mcp.allowedTools).toContain('mcp__smartperfetto__propose_scene_timeline');
    expect(tool.shared.inputSchema).toHaveProperty('baseRevision');
    expect(tool.evidenceEffect).toBe('read_existing');
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'p1',
      segments: Array.from({length: 50}, (_, index) => segment(`segment-${index}`)), unresolved: []}, {});
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({accepted: true, revision: 1,
      omittedChangedSegmentCount: 18, omittedDiagnosticCount: 26});
    expect(response.structuredContent?.changedSegmentIds).toHaveLength(32);
    expect(response.structuredContent?.diagnostics).toHaveLength(24);
    expect(response.structuredContent).not.toHaveProperty('segments');
    expect(response.structuredContent).not.toHaveProperty('evidence');
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(20000);
    const snapshot = consumeSceneRuntimeSeal(f.binding.seal()!, scope);
    expect(snapshot.segments).toHaveLength(50);
    expect(snapshot.segments.every(item => item.semanticStatus === 'unverified')).toBe(true);
  });
  it('preserves the committed revision when the model supplies proof fields', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'forged', segments: [segment('s')],
      verified: true, unresolved: []}, {});
    expect(response.structuredContent).toMatchObject({accepted: false, revision: 0,
      diagnostics: [{code: 'invalid_proposal'}]});
    expect(sceneRunState(capability).revision).toBe(0);
  });
  it('returns required query gaps without turning an accepted candidate into capture proof', async () => {
    const f = fixture({skills: [], fragments: new Map(), strategyRegistryFingerprint: 'fixture-strategy',
      profileRefs: [{id: 'scene_reconstruction', version: 1}]});
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'gaps', segments: [segment('s')]}, {});
    const coverage = response.structuredContent?.coverage as any;
    expect(coverage).toMatchObject({captureStatus: 'unknown', omittedTargetCount: 0});
    expect(coverage.targets).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'input_observations', capabilityStatus: 'unknown', scanStatus: 'unknown', unscannedWindowCount: 1,
    })]));
    expect(JSON.stringify(coverage)).not.toContain('receipts');
    expect(JSON.stringify(coverage)).not.toContain('ownerKey');
    expect(JSON.stringify(coverage)).not.toContain('definitionFingerprint');
  });
  it('rejects tool work after runtime acquisition closes and after product release', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    f.close();
    const result = await tool.shared.handler({baseRevision: 0, proposalId: 'late', segments: [segment('s')], unresolved: []}, {});
    expect(result.isError).toBe(true);
    expect(sceneRunState(capability).revision).toBe(0);
    f.binding.release();
    expect(() => f.server(capability)).toThrow('unissued_scene_runtime_capability');
  });
  it('accepts the registry-published planPhaseId and emits plan receipt facts', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    expect(tool.shared.inputSchema).toHaveProperty('planPhaseId');
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'with-phase', planPhaseId: 'p4',
      segments: [segment('s')], unresolved: []}, {});
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({success: true, accepted: true, revision: 1});
    expect(readRuntimeToolResultFacts(response).success).toBe(true);
  });
  it('returns an actionable rejection as a policy refusal with its rejected groups', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    const response = await tool.shared.handler({baseRevision: 0, proposalId: 'bad', segments: [
      {...segment('s'), evidenceRefs: [{evidenceRefId: 'not-issued', rowIndex: 0}]}]}, {});
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({success: false, accepted: false,
      action_required: 'repair_scene_proposal', rejectedGroups: [{segmentIds: ['s']}]});
    expect(isPolicyRefusalResult(response)).toBe(true);
  });
  it('paces acquisition after the lifecycle guard and reopens it after a proposal attempt', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tools = f.server(capability).toolDefinitions;
    const sql = tools.find(tool => tool.name === 'execute_sql')!;
    const propose = tools.find(tool => tool.name === 'propose_scene_timeline')!;
    const query = () => sql.shared.handler({sql: 'SELECT 1 AS value'}, {});
    const facts = [];
    for (let index = 0; index < 6; index++) facts.push(readRuntimeToolResultFacts(await query()).success);
    expect(facts).toEqual([true, true, true, true, true, true]);
    const paused = await query();
    expect(paused.structuredContent).toMatchObject({success: false, action_required: 'submit_first_scene_revision',
      unsupportedReason: 'scene_first_revision_due', committedSegments: 0});
    expect(isPolicyRefusalResult(paused)).toBe(true);
    await propose.shared.handler({baseRevision: 0, proposalId: 'attempt', segments: [
      {...segment('s'), evidenceRefs: [{evidenceRefId: 'not-issued', rowIndex: 0}]}]}, {});
    expect(readRuntimeToolResultFacts(await query()).success).toBe(true);
    f.close();
    const closed = await query();
    expect(closed.structuredContent).toMatchObject({action_required: 'deliver_existing_conclusion', unsupportedReason: 'acquisition_closed'});
  });
  it('lets representational noise through MCP input validation so the strict contract decides per group', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const tool = f.server(capability).toolDefinitions.find(tool => tool.name === 'propose_scene_timeline')!;
    // MCP hosts validate arguments against the published shape before any handler runs.
    const host = new McpServer({name: 'smartperfetto', version: '1'});
    host.tool(tool.name, tool.shared.description, tool.shared.inputSchema, (args: any, extra: any) => tool.shared.handler(args, extra) as any);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await host.connect(serverSide);
    const client = new Client({name: 'scene-test', version: '1'});
    await client.connect(clientSide);
    const call = async (args: Record<string, unknown>) => {
      const result: any = await client.callTool({name: tool.name, arguments: args});
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    try {
      expect(await call({baseRevision: 0, proposalId: 'nulls', planPhaseId: 'p1', segments: [
        {...segment('s'), object: {kind: 'trace', key: scope.traceId, machineId: null}, dependencies: null}]}))
        .toMatchObject({accepted: true, revision: 1});
      expect(await call({baseRevision: 1, proposalId: 'nested', segments: [{...segment('t'), note: 'x'}]}))
        .toMatchObject({accepted: false, action_required: 'repair_scene_proposal',
          rejectedGroups: [{segmentIds: ['t'], diagnostics: [{code: 'invalid_segment'}]}]});
    } finally {await client.close(); await host.close();}
  });
  it('publishes the same fields as the strict contract', () => {
    const keys = (shape: object) => Object.keys(shape).sort();
    expect(keys(sceneTimelineSegmentToolSchema.shape)).toEqual(keys(sceneTimelineSegmentSchema.shape));
    expect(keys(sceneTimelineProposalToolShape)).toEqual(keys(sceneTimelineProposalSchema.shape));
    const nested = (schema: any, key: string) => keys(schema.shape[key].unwrap?.().shape ?? schema.shape[key].shape);
    expect(nested(sceneTimelineSegmentToolSchema, 'object')).toEqual(nested(sceneTimelineSegmentSchema, 'object'));
    expect(keys((sceneTimelineSegmentToolSchema.shape.evidenceRefs as any).element.shape))
      .toEqual(keys((sceneEvidenceReferenceSchema as any).shape ?? (sceneEvidenceReferenceSchema as any)._def.schema.shape));
  });
  it('commits a proposal that cites the inline rowIndex of a fetched artifact page', async () => {
    const f = fixture();
    const rows = Array.from({length: 60}, (_, index) => [String(index * 1000), String(index * 1000 + 500), `event-${index}`]);
    f.query.mockImplementation((async (_traceId: string, sql: string) => sql.includes('scene_events')
      ? {columns: ['start_ns', 'end_ns', 'name'], rows, durationMs: 0}
      : {columns: ['start_ns', 'end_ns'], rows: [['0', '100000']], durationMs: 0}) as any);
    const capability = (await f.activate())!;
    const tools = f.server(capability).toolDefinitions;
    const call = async (name: string, args: Record<string, unknown>) =>
      (await tools.find(tool => tool.name === name)!.shared.handler(args, {})).structuredContent as any;
    const summary = await call('execute_sql', {sql: 'SELECT start_ns, end_ns, name FROM scene_events'});
    expect(summary).toMatchObject({mode: 'summary', rowShape: 'indexed_rows@1'});
    const page = await call('fetch_artifact', {artifactId: summary.artifactId, detail: 'rows', offset: 50, limit: 2});
    const cited = page.rows[1];
    expect(cited).toEqual({rowIndex: 51, values: ['51000', '51500', 'event-51']});
    const cite = (rowIndex: number) => ({...segment('s'), startNs: cited.values[0], endNs: cited.values[1],
      evidenceRefs: [{artifactId: summary.artifactId, rowIndex, column: 'name', value: cited.values[2]}]});
    // The page position (1) names another row, so the old arithmetic-free citation is rejected.
    expect(await call('propose_scene_timeline', {baseRevision: 0, proposalId: 'position', segments: [cite(1)]}))
      .toMatchObject({accepted: false, revision: 0,
        rejectedGroups: [{segmentIds: ['s'], diagnostics: [{code: 'evidence_value_mismatch'}]}]});
    expect(await call('propose_scene_timeline', {baseRevision: 0, proposalId: 'inline', segments: [cite(cited.rowIndex)]}))
      .toMatchObject({accepted: true, revision: 1});
  });
  it('refuses acquisition once the scene run is released even if the runtime still admits tools', async () => {
    const f = fixture();
    const capability = (await f.activate())!;
    const sql = f.server(capability).toolDefinitions.find(tool => tool.name === 'execute_sql')!;
    f.binding.release();
    const refused = await sql.shared.handler({sql: 'SELECT 1 AS value'}, {});
    expect(refused.structuredContent).toMatchObject({success: false, action_required: 'deliver_existing_conclusion',
      unsupportedReason: 'acquisition_closed'});
    expect(f.query).not.toHaveBeenCalledWith(expect.anything(), 'SELECT 1 AS value', expect.anything());
  });
});
