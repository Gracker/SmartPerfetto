// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'node:crypto';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import {projectAgentE2ePerformance, readAgentE2eMetrics} from '../agentE2eMetrics';
import {measureModelRequestBody} from '../../agentRuntime/modelRequestMetrics';
import {RUNTIME_DECLARATION_AUTHORING_STATUSES, RUNTIME_DECLARATION_AUTHORING_VERSIONS} from '../../agentRuntime/runtimePerformance';
import type {RunManifestV1} from '../../types/selfEvolution';
import {OPENAI_TYPED_FINAL_CONTRACTS} from '../../agentRuntime/finalSubmissionImplementation';

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

const policyObservation = {schemaVersion: 'model_execution_policy@1', purpose: 'review', selection: 'minimum_legal_candidate',
  executionFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: `sha256:${'b'.repeat(64)}`},
  authored: 'absent', sdkEffective: 'unknown', mapped: {mode: 'disabled'}, outcome: 'candidate_applied',
  reason: 'candidate_minimum_legal', wireObservation: 'not_observed', observationOrdinal: 1, observedOffsetMs: 12};

describe('same-process E2E metrics artifact', () => {
  it.each(['canonical_v1', 'authoring_v1', 'authoring_v2'] as const)('preserves requested syntax %s without inventing observed codec state', syntax => {
    const result = readAgentE2eMetrics(identity, () => ({...manifest, conclusionDeclarationSyntax: syntax} as RunManifestV1));
    expect(result).toMatchObject({status: 'sealed', conclusionDeclarationSyntax: syntax});
    expect(JSON.stringify(result)).not.toContain('declarationAuthoringVersion');
    expect(readAgentE2eMetrics(identity, () => manifest as RunManifestV1)).not.toHaveProperty('conclusionDeclarationSyntax');
  });

  it.each(RUNTIME_DECLARATION_AUTHORING_VERSIONS)('exports actual %s only with a successful codec observation', version => {
    const output = {...performance.modelCalls[0].output, declarationAuthoringStatus: 'expanded', declarationAuthoringVersion: version};
    expect(projectAgentE2ePerformance({...performance, modelCalls: [{...performance.modelCalls[0], output}]}).modelCalls?.[0])
      .toMatchObject({output});
    for (const status of ['invalid', 'not_observed', undefined]) {
      const stored = {...manifest, performance: {...performance, modelCalls: [{...performance.modelCalls[0],
        output: {...output, declarationAuthoringStatus: status}}]}};
      expect(readAgentE2eMetrics(identity, () => stored as unknown as RunManifestV1)).toEqual({
        schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
    }
  });

  it('rejects unknown stored syntax and observed version without echoing the values', () => {
    expect(readAgentE2eMetrics(identity, () => ({...manifest, conclusionDeclarationSyntax: 'PRIVATE_VERSION_CANARY'} as unknown as RunManifestV1)))
      .toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
    const stored = {...manifest, performance: {...performance, modelCalls: [{...performance.modelCalls[0], output: {
      ...performance.modelCalls[0].output, declarationAuthoringStatus: 'expanded', declarationAuthoringVersion: 'PRIVATE_VERSION_CANARY',
    }}]}};
    expect(readAgentE2eMetrics(identity, () => stored as unknown as RunManifestV1)).toEqual({
      schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });

  it.each(RUNTIME_DECLARATION_AUTHORING_STATUSES)('preserves the observed authoring status %s as a distinct optional output field', status => {
    const output = {...performance.modelCalls[0].output, declarationAuthoringStatus: status};
    expect(projectAgentE2ePerformance({...performance, modelCalls: [{...performance.modelCalls[0], output}]})
      .modelCalls?.[0]).toMatchObject({output});
    expect(projectAgentE2ePerformance(performance).modelCalls?.[0]).toMatchObject({output: performance.modelCalls[0].output});
    expect((projectAgentE2ePerformance(performance).modelCalls?.[0] as any).output).not.toHaveProperty('declarationAuthoringStatus');
  });

  it.each(['canonical', 'PRIVATE_CODEC_STATUS_CANARY'])('rejects forged stored authoring status %s without echoing it', status => {
    const output = {...performance.modelCalls[0].output, declarationAuthoringStatus: status};
    const stored = {...manifest, performance: {...performance, modelCalls: [{...performance.modelCalls[0], output}]}};
    expect(readAgentE2eMetrics(identity, () => stored as unknown as RunManifestV1)).toEqual({
      schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });

  it('exports bounded policy observations independently and strips nested native content', () => {
    const canary = 'PRIVATE_POLICY_CANARY';
    const result = projectAgentE2ePerformance({...performance, modelCalls: [], modelRequests: [],
      policyObservations: [{...policyObservation, modelId: canary, url: canary, rawPayload: canary,
        executionFingerprint: {...policyObservation.executionFingerprint, headers: canary},
        mapped: {mode: 'disabled', secret: canary}}], truncated: {policyObservations: 3}});
    expect(result.policyObservations).toEqual([policyObservation]);
    expect(result.modelCalls).toEqual([]);
    expect(result.modelRequests).toEqual([]);
    expect(result.truncated).toEqual({policyObservations: 3});
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(projectAgentE2ePerformance(performance)).not.toHaveProperty('policyObservations');
  });

  it.each([
    {observationOrdinal: 0}, {observationOrdinal: 1.5}, {observationOrdinal: 513}, {observationOrdinal: Number.MAX_SAFE_INTEGER + 1},
    {observedOffsetMs: -1}, {observedOffsetMs: NaN}, {observedOffsetMs: Infinity},
    {wireObservation: 'observed'}, {purpose: 'PRIVATE_PURPOSE'}, {reason: 'PRIVATE_REASON'},
    {executionFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: 'PRIVATE_FINGERPRINT'}},
    {mapped: {mode: 'disabled', effort: 'low'}}, {sdkEffective: {mode: 'enabled', effort: 'PRIVATE_EFFORT'}},
  ])('rejects invalid known policy values in stored metrics without quoting them: %j', mutation => {
    const stored = {...manifest, performance: {...performance, policyObservations: [{...policyObservation, ...mutation}]}};
    expect(readAgentE2eMetrics(identity, () => stored as unknown as RunManifestV1))
      .toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });

  it('rejects an oversized stored policy array instead of silently dropping observations', () => {
    expect(readAgentE2eMetrics(identity, () => ({...manifest, performance: {...performance,
      policyObservations: Array.from({length: 513}, () => policyObservation)}} as unknown as RunManifestV1)))
      .toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });
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
      modelCalls: [{...performance.modelCalls[0], reasoning: 'enabled', reasoningEffort: 'low',
        reasoning_content: canary, headers: {Authorization: canary},
        usage: {inputTokens: 12, outputTokens: 4, source: canary}, output: {bodyChars: 12, text: canary}}],
      modelRequests: [{...performance.modelRequests[0], url: canary,
        body: {...performance.modelRequests[0].body, text: canary}}]});
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(projected.modelCalls?.[0]).toMatchObject({reasoning: 'enabled', reasoningEffort: 'low',
      usage: {inputTokens: 12, outputTokens: 4}, output: {bodyChars: 12}});
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

  it('projects per-request investigation receipts through the recorder projection, and reads older receipts without them', () => {
    const request = {requestIndex: 1, attempt: 1, purpose: 'answer_turn', offsetMs: 9, status: 'observed',
      agentContext: {messageCount: 2, toolCount: 5, approxMessageChars: 900, approxToolChars: 400, lowerBound: true},
      requirements: {contract: 'resolved', observed: 1, notObserved: 1, unknownNoProducer: 2, notApplicable: 0},
      evidence: 'read', turns: {used: 0, limit: 6, total: 8}, elapsedMs: 9, remainingMs: 100, decision: 'no_change'};
    const failed = {requestIndex: 2, attempt: 1, purpose: 'continuation', offsetMs: 20, status: 'view_failed'};
    const projected = projectAgentE2ePerformance({...performance, investigationRequests: [request, failed],
      modelCalls: [{...performance.modelCalls[0], requestIndex: 1, usage: {inputTokens: 900, cachedInputTokens: 700}}],
      truncated: {investigationRequests: 4}});
    expect(projected.investigationRequests).toEqual([request, failed]);
    expect(projected.modelCalls?.[0]).toMatchObject({requestIndex: 1, usage: {inputTokens: 900, cachedInputTokens: 700}});
    expect(projected.truncated).toEqual({investigationRequests: 4});
    expect(projectAgentE2ePerformance(performance)).not.toHaveProperty('investigationRequests');
    const canary = 'PRIVATE_INVESTIGATION_CANARY';
    for (const invalid of [{...request, status: 'passed'}, {...request, agentContext: {...request.agentContext, lowerBound: 'yes'}},
      {...request, view: canary}, {...request, requirements: {...request.requirements, ids: [canary]}}]) {
      const stored = {...manifest, performance: {...performance, investigationRequests: [invalid]}};
      const result = readAgentE2eMetrics(identity, () => stored as unknown as RunManifestV1);
      expect(result.status).toBe('invalid_receipt');
      expect(JSON.stringify(result)).not.toContain(canary);
    }
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


describe('W0 sealed actual transport projection', () => {
  // Hand-authored stored fixture: the pre-existing metrics entry must not silently drop this receipt.
  const payload = {sequence: 1, offsetMs: 5, kind: 'not_exercised', reason: 'program_ack'};
  const receipt = {schemaVersion: 'final_transport_observation@1',
    events: [{...payload, eventKey: canonicalContentHash(payload)}], truncated: 0};

  it('preserves the sealed transport observation without inventing a main call from requested mode', () => {
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      finalSubmission: 'assistant_text', conclusionDeclarationSyntax: 'canonical_v1',
      performance: {...performance, finalTransportObservation: receipt}} as unknown as RunManifestV1));
    expect(result).toMatchObject({status: 'sealed', requestedOutputConfig: {finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'},
      performance: {finalTransportObservation: receipt}});
    expect(projectAgentE2ePerformance(performance)).not.toHaveProperty('finalTransportObservation');
    expect(readAgentE2eMetrics(identity, () => manifest)).not.toHaveProperty('requestedOutputConfig');
  });

  it('seals a current manifest that records the output mode but no retired declaration syntax', () => {
    const result = readAgentE2eMetrics(identity, () => ({...manifest, finalSubmission: 'assistant_text'} as unknown as RunManifestV1));
    expect(result).toMatchObject({status: 'sealed', requestedOutputConfig: {finalSubmission: 'assistant_text'}});
    expect((result as {requestedOutputConfig?: object}).requestedOutputConfig).not.toHaveProperty('declarationSyntax');
  });

  it.each([
    {schemaVersion: 'wrong'}, {truncated: -1}, {privateBody: 'PRIVATE'},
    {events: [{...receipt.events[0], eventKey: '0'.repeat(64)}]},
    {events: [{...receipt.events[0], sequence: 2}]},
    {events: [receipt.events[0], receipt.events[0]]},
    {events: [{...receipt.events[0], privateRawArguments: 'PRIVATE'}]},
  ])('rejects malformed stored actual observations instead of dropping them: %j', mutation => {
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation: {...receipt, ...mutation}}} as unknown as RunManifestV1));
    expect(result).toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps explicit truncation and requested-only configuration distinct from complete actual evidence', () => {
    expect(projectAgentE2ePerformance({...performance, finalTransportObservation: {...receipt, truncated: 2}}))
      .toHaveProperty('finalTransportObservation.truncated', 2);
    const requested = readAgentE2eMetrics(identity, () => ({...manifest,
      finalSubmission: 'authored_claim_document_v1', conclusionDeclarationSyntax: 'canonical_v1'} as RunManifestV1));
    expect(requested).toMatchObject({status: 'sealed', requestedOutputConfig: {finalSubmission: 'authored_claim_document_v1'}});
    expect(requested).not.toHaveProperty('performance.finalTransportObservation');
  });
});


describe('model-source metrics do not upgrade configured fallbacks', () => {
  it.each(['configured', 'provider_reported'] as const)('preserves explicit %s independently of the model hash', modelSource => {
    expect(projectAgentE2ePerformance({...performance, modelCalls: [{...performance.modelCalls[0], modelSource}]}).modelCalls?.[0])
      .toMatchObject({modelSource, modelHash: createHash('sha256').update('deepseek-flash').digest('hex')});
    expect(projectAgentE2ePerformance(performance).modelCalls?.[0]).not.toHaveProperty('modelSource');
  });
  it.each([{model: undefined}, {model: ''}, {model: ' model '}, {modelSource: 'unknown_private_value'}])(
    'rejects inconsistent stored provenance without inventing actual identity: %j', mutation => {
      expect(() => projectAgentE2ePerformance({...performance, modelCalls: [{...performance.modelCalls[0],
        modelSource: 'provider_reported', ...mutation}]})).toThrow('metrics_');
    });
});


describe('R11 typed material metrics consumption', () => {
  function material() {
    return {schemaVersion: 'typed_output_material@1', wireToolRole: 'final_role',
      transport: {doneSeen: true, eofSeen: true, framing: 'valid', finishReason: 'length'},
      decoded: {arguments: {utf8Bytes: 1048577, utf16Chars: 1048577, utf8Precision: 'lower_bound', utf16Precision: 'lower_bound'},
        companion: {utf8Bytes: 1, utf16Chars: 1, utf8Precision: 'exact', utf16Precision: 'exact'}},
      retention: {arguments: {status: 'over_limit', retainedUtf8Bytes: 1000}, companion: {status: 'not_retained', retainedUtf8Bytes: 0},
        refusal: {status: 'not_observed', retainedUtf8Bytes: 0}, combinedRetainedUtf8Bytes: 1000},
      json: {status: 'not_parsed'}, representation: 'unknown', structure: {status: 'not_observed'}};
  }
  function observation(value: unknown) {
    const event = {kind: 'typed_output_observed', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      collectorDispatchOrdinal: 2, material: value, sequence: 1, offsetMs: 1};
    return {schemaVersion: 'final_transport_observation@1', events: [{...event, eventKey: canonicalContentHash(event)}], truncated: 0};
  }
  it('preserves failed output material separately from usage, actual transport and delivery status', () => {
    const finalTransportObservation = observation(material());
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation}} as unknown as RunManifestV1));
    expect(result).toMatchObject({status: 'sealed', performance: {finalTransportObservation}});
    expect(JSON.stringify(result)).not.toContain('typed_issued_after_drain');
    expect(JSON.stringify(result)).not.toContain('candidate_retained');
  });
  it.each([
    {privateText: 'PRIVATE_R11_METRICS_CANARY'},
    {structure: {status: 'not_observed', claims: 0}},
    {retention: {...material().retention, combinedRetainedUtf8Bytes: 999}},
    {decoded: {arguments: {...material().decoded.arguments, utf16Chars: -1}}},
    {transport: {...material().transport, finishReason: 'PRIVATE_R11_METRICS_CANARY'}},
    {json: {status: 'complete_json'}},
  ])('rejects legally rehashed malformed material without exposing its content: %j', mutation => {
    const finalTransportObservation = observation({...material(), ...mutation});
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation}} as unknown as RunManifestV1));
    expect(result).toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_R11');
  });
  it('rejects impossible complete-retention facts even after the event is legitimately rehashed', () => {
    const value = {...material(), decoded: {...material().decoded,
      arguments: {utf8Bytes: 1_000_000_000, utf16Chars: 1_000_000_000, utf8Precision: 'exact', utf16Precision: 'exact'}},
      retention: {...material().retention, arguments: {status: 'complete', retainedUtf8Bytes: 1_000_000_000},
        combinedRetainedUtf8Bytes: 1_000_000_000}};
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation: observation(value)}} as unknown as RunManifestV1));
    expect(result).toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });
  it('does not invent an observation when default assistant has no final role', () => {
    expect(projectAgentE2ePerformance(performance)).not.toHaveProperty('finalTransportObservation');
  });
});


describe('R11 Stage B issued tuple metrics', () => {
  it('preserves the actual admission3/wire2 receipt through the existing shared projector', () => {
    const event = {kind: 'typed_issued_after_drain', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      responseKey: 'c'.repeat(64), callKey: 'd'.repeat(64), actualModel: {status: 'observed', hash: 'e'.repeat(64)},
      nativeStatus: 'completed', drainStatus: 'fulfilled', nativeBodyHash: 'f'.repeat(64),
      ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3'], sequence: 1, offsetMs: 1};
    const finalTransportObservation = {schemaVersion: 'final_transport_observation@1',
      events: [{...event, eventKey: canonicalContentHash(event)}], truncated: 0};
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation}} as unknown as RunManifestV1));
    expect(result).toMatchObject({status: 'sealed', performance: {finalTransportObservation}});
  });

  it('rejects individually known but mismatched legacy versions after a valid event hash', () => {
    const event = {kind: 'typed_issued_after_drain', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      responseKey: 'c'.repeat(64), callKey: 'd'.repeat(64), actualModel: {status: 'observed', hash: 'e'.repeat(64)},
      nativeStatus: 'completed', drainStatus: 'fulfilled', nativeBodyHash: 'f'.repeat(64),
      representationVersion: 'authored_claim_document@2', compilerVersion: 'authored_claim_document_compiler@1',
      admissionVersion: 'openai_typed_final_admission@2', sequence: 1, offsetMs: 1};
    const finalTransportObservation = {schemaVersion: 'final_transport_observation@1',
      events: [{...event, eventKey: canonicalContentHash(event)}], truncated: 0};
    const result = readAgentE2eMetrics(identity, () => ({...manifest,
      performance: {...performance, finalTransportObservation}} as unknown as RunManifestV1));
    expect(result).toEqual({schemaVersion: 'llm_execution_metrics_artifact@1', status: 'invalid_receipt'});
  });
});


describe('R13 observed assistant document metrics', () => {
  it('retains the actual dual requested configuration and distinct issued source, without treating either as proof', () => {
    const event = {kind: 'assistant_document_issued_after_drain', sourceKind: 'assistant_json', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      responseKey: 'c'.repeat(64), messageKey: 'c'.repeat(64), nativeTerminalEventKey: 'd'.repeat(64), rawAssistantTextHash: 'e'.repeat(64),
      compiledBodyHash: 'f'.repeat(64), nativeCandidateKey: '1'.repeat(64), actualModel: {status: 'observed', hash: '2'.repeat(64)},
      nativeStatus: 'completed', drainStatus: 'fulfilled', representationVersion: 'authored_claim_document@2', compilerVersion: 'authored_claim_document_compiler@2',
      admissionVersion: 'openai_typed_final_admission@4', wireVersion: 'openai_chat_final_wire@3', sequence: 1, offsetMs: 1};
    const finalTransportObservation = {schemaVersion: 'final_transport_observation@1', events: [{...event, eventKey: canonicalContentHash(event)}], truncated: 0};
    const stored = {...manifest, finalSubmission: 'authored_claim_document_v2_dual', conclusionDeclarationSyntax: 'authoring_v2',
      performance: {...performance, finalTransportObservation}} as unknown as RunManifestV1;
    expect(readAgentE2eMetrics(identity, () => stored)).toMatchObject({status: 'sealed',
      requestedOutputConfig: {finalSubmission: 'authored_claim_document_v2_dual', declarationSyntax: 'authoring_v2'}, performance: {finalTransportObservation}});
    expect(JSON.stringify(readAgentE2eMetrics(identity, () => stored))).not.toContain('rawArguments');
  });
});
