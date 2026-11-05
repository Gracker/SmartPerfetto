// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'node:crypto';
import {projectAgentE2ePerformance, readAgentE2eMetrics} from '../agentE2eMetrics';
import {measureModelRequestBody} from '../../agentRuntime/modelRequestMetrics';
import type {RunManifestV1} from '../../types/selfEvolution';

const performance = {
  schemaVersion: 1,
  phases: [{name: 'provider', startOffsetMs: 10, durationMs: 50, outcome: 'ok'}],
  tools: [], sql: [],
  modelCalls: [{purpose: 'answer_turn', model: 'deepseek-flash', providerOrigin: 'https://api.deepseek.com',
    startOffsetMs: 10, durationMs: 50, outcome: 'ok', output: {bodyChars: 12, sidecarChars: 34}}],
  modelRequests: [{dispatchOrdinal: 1, startOffsetMs: 10, fetchOutcome: 'headers', headersMs: 2, httpStatus: 200,
    body: {status: 'observed', bodyBytes: 123}}],
};
const identity = {runId: 'run-a', sessionId: 'session-a', scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'}};
const manifest = {...identity, schemaVersion: 1, sealedAt: 60, wallclockMs: 60, runtime: 'openai-agents-sdk',
  model: 'deepseek-flash', providerSnapshotHash: 'a'.repeat(64), performance} as unknown as RunManifestV1;

describe('same-process E2E metrics artifact', () => {
  it('reads the exact sealed run, preserving timings and unknown usage without exporting native content', () => {
    const read = jest.fn(() => manifest);
    const result = readAgentE2eMetrics(identity, read);
    expect(read).toHaveBeenCalledWith(identity.scope, identity.runId);
    expect(result).toMatchObject({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'sealed',
      runId: identity.runId, providerSnapshotHash: manifest.providerSnapshotHash,
      modelHash: createHash('sha256').update('deepseek-flash').digest('hex'),
      performance: {phases: performance.phases, modelCalls: [{purpose: 'answer_turn', durationMs: 50}],
        modelRequests: [{fetchOutcome: 'headers', headersMs: 2, body: {bodyBytes: 123}}]}});
    expect(JSON.stringify(result)).not.toContain('deepseek-flash');
    if (result.status !== 'sealed') throw new Error('expected sealed metrics');
    expect(result.performance.modelCalls?.[0]).not.toHaveProperty('usage');
    expect(result.performance.modelRequests?.[0]).not.toHaveProperty('durationMs');
  });

  it('projects nested whitelists even if stored data contains private fields', () => {
    const canary = 'PRIVATE_SOURCE_AND_REASONING_CANARY';
    const projected = projectAgentE2ePerformance({...performance, prompt: canary, activity: {raw: canary},
      modelCalls: [{...performance.modelCalls[0], reasoning_content: canary, headers: {Authorization: canary},
        usage: {inputTokens: 12, outputTokens: 4, source: canary}, output: {bodyChars: 12, text: canary}}],
      modelRequests: [{...performance.modelRequests[0], url: canary,
        body: {...performance.modelRequests[0].body, text: canary}}]});
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(projected.modelCalls?.[0]).toMatchObject({usage: {inputTokens: 12, outputTokens: 4}, output: {bodyChars: 12}});
  });

  it.each([
    {runId: 'other-run'}, {sessionId: 'other-session'},
    {scope: {...identity.scope, tenantId: 'other-tenant'}},
    {scope: {...identity.scope, workspaceId: 'other-workspace'}},
  ])('does not expose another run even when a store returns it: %j', override => {
    expect(readAgentE2eMetrics(identity, () => ({...manifest, ...override}))).toEqual({
      schemaVersion: 'llm_execution_metrics_artifact@1', status: 'identity_mismatch'});
  });

  it('preserves absent and invalid data as unavailable, never as zero cost or a pass', () => {
    expect(readAgentE2eMetrics(identity, () => undefined).status).toBe('unavailable');
    expect(readAgentE2eMetrics(identity, () => {throw new Error('SECRET_STORE_PAYLOAD');})).toEqual({
      schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
    expect(readAgentE2eMetrics(identity, () => ({...manifest, performance: {...performance,
      phases: [{name: 'provider', durationMs: -1, startOffsetMs: 0, outcome: 'ok'}]}} as RunManifestV1)).status)
      .toBe('invalid_receipt');
  });

  it('retains pending requests and truncation rather than counting headers as completed analysis', () => {
    const projected = projectAgentE2ePerformance({...performance,
      modelRequests: [{dispatchOrdinal: 2, startOffsetMs: 20, fetchOutcome: 'pending', body: {status: 'body_unobservable'}}],
      truncated: {modelRequests: 3}});
    expect(projected.modelRequests).toEqual([{dispatchOrdinal: 2, startOffsetMs: 20,
      fetchOutcome: 'pending', body: {status: 'body_unobservable'}}]);
    expect(projected.truncated).toEqual({modelRequests: 3});
  });

  it('keeps actual wire bytes separate from the observer\'s normalized component measurement', () => {
    const body = measureModelRequestBody('{ "messages": [{"role":"user", "content":"中文\\nwith space"}] }');
    const projected = projectAgentE2ePerformance({...performance,
      modelRequests: [{...performance.modelRequests[0], body}]});
    expect(projected.modelRequests?.[0]).toMatchObject({body});
    expect(body.normalized?.measurement).toBe('normalized_json_utf8');
    expect(body.normalized?.totalBytes).toBeLessThan(body.bodyBytes!);
  });
});
