// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import type {RuntimeFinalTransportEventInput} from '../runtimePerformance';
import {TYPED_OUTPUT_MATERIAL_LIMITS, type RuntimeTypedOutputMaterial} from '../typedOutputMaterial';
import {CONCLUSION_PROTOCOL_VALUES} from '../../agent/core/conclusionContract';
import {OPENAI_TYPED_FINAL_CONTRACTS} from '../finalSubmissionImplementation';
import {describe, expect, it, jest} from '@jest/globals';

import {
  createRuntimePerformanceRecorder,
  createRuntimePerformanceRun,
  normalizeModelCallUsage,
  recordRuntimeDeliveryBudget,
  recordRuntimeFinalReview,
  recordRuntimeDeclarationRepair,
  recordRuntimeFinalDeclaration,
  runtimeModelCallInputBytesBucket,
  runtimeProviderOrigin,
  startRuntimeModelCall,
  projectRuntimeModelPolicyReceipt,
  recordRuntimeModelExecutionPolicy,
  buildRuntimeConfigCommitments,
  runtimeConfigCommitmentsFingerprint,
  runtimeConfigControlsFingerprint,
  alignRuntimeConfigCommitments,
  parseRuntimeBenchmarkConfigCommitments,
  buildRuntimeCommonModelConfig,
  buildRuntimeAppliedModelControls,
  buildRuntimeExecutionProfileObservation,
  recordRuntimeFinalTransportEvent,
  dropRuntimeFinalTransportObservation,
  findRuntimeRetainedTransportEvent,
  projectRuntimeFinalTransportObservation,
  runtimeCandidateObservationKey,
  runtimeObservationHash,
  RUNTIME_DECLARATION_AUTHORING_STATUSES,
  RUNTIME_DECLARATION_AUTHORING_VERSIONS,
} from '../runtimePerformance';
import {createRuntimePerformanceScope, resolveRuntimePerformanceRecorder, bindRuntimePerformanceContext, withRuntimePerformanceSuppressed} from '../runtimePerformanceContext';
import {resolveModelExecutionProfile} from '../../services/providerManager/modelExecutionProfile';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {parseRuntimeActivitySnapshot} from '../runtimeActivity';
import {dispatchWithModelCallRecord} from '../intentTransport';

function expectedRuntimeHash(value: string, salt = ''): string {
  return `sha256:${createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value.trim())
    .digest('hex')
    .slice(0, 32)}`;
}

function policyReceipt() {
  return {schemaVersion: 'model_execution_policy@1', purpose: 'classification', selection: 'preserve',
    executionFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: `sha256:${'a'.repeat(64)}`},
    authored: 'absent', mapped: 'unchanged', sdkEffective: 'unknown', outcome: 'preserved',
    reason: 'preserve_requested', wireObservation: 'not_observed'};
}

describe('closed model execution policy observations', () => {
  it('copies only closed settings and fingerprints, never model names or nested private fields', () => {
    const canary = 'PRIVATE_POLICY_SOURCE_CANARY';
    const input = {...policyReceipt(), modelId: canary, url: canary, headers: {Authorization: canary}, rawPayload: canary,
      executionFingerprint: {...policyReceipt().executionFingerprint, secret: canary},
      authored: {mode: 'enabled', effort: 'low', secret: canary},
      mapped: {mode: 'disabled', raw: canary}, sdkEffective: {mode: 'enabled', effort: 'high', url: canary}};
    const projected = projectRuntimeModelPolicyReceipt(input);
    expect(projected).toEqual({...policyReceipt(), authored: {mode: 'enabled', effort: 'low'},
      mapped: {mode: 'disabled'}, sdkEffective: {mode: 'enabled', effort: 'high'}});
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(input.authored.secret).toBe(canary);
  });

  it.each([
    {schemaVersion: 'PRIVATE_VERSION'}, {purpose: 'PRIVATE_PURPOSE'}, {selection: 'PRIVATE_SELECTION'},
    {outcome: 'PRIVATE_OUTCOME'}, {reason: 'PRIVATE_REASON'}, {wireObservation: 'observed'},
    {executionFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: 'private-url?token=SECRET'}},
    {executionFingerprint: {schemaVersion: 'wrong', value: `sha256:${'a'.repeat(64)}`}},
    {authored: {mode: 'disabled', effort: 'low'}}, {authored: {mode: 'enabled', effort: 'PRIVATE_EFFORT'}},
    {authored: null}, {mapped: 'absent'}, {sdkEffective: 'unchanged'},
  ])('rejects invalid known policy values without echoing them: %j', mutation => {
    const recorder = createRuntimePerformanceRecorder();
    const input = {...policyReceipt(), ...mutation};
    expect(projectRuntimeModelPolicyReceipt(input)).toBeUndefined();
    expect(() => recordRuntimeModelExecutionPolicy({runtimePerformanceRecorder: recorder}, input)).not.toThrow();
    expect(recorder.seal().policyObservations).toBeUndefined();
  });

  it('caps observations independently, preserving their meaning as policy rather than dispatch', () => {
    let now = 100;
    const recorder = createRuntimePerformanceRecorder({now: () => now, maxPolicyObservations: 2});
    for (let index = 0; index < 3; index++) {
      now += 10;
      recordRuntimeModelExecutionPolicy({runtimePerformanceRecorder: recorder}, policyReceipt());
    }
    const receipt = recorder.seal();
    expect(receipt.policyObservations).toEqual([1, 2].map(index => ({...policyReceipt(), observationOrdinal: index, observedOffsetMs: index * 10})));
    expect(receipt.truncated?.policyObservations).toBe(1);
    expect(receipt.modelCalls).toBeUndefined();
    expect(receipt.modelRequests).toBeUndefined();
    expect(Object.isFrozen(receipt.policyObservations![0].executionFingerprint)).toBe(true);
    expect(() => recordRuntimeModelExecutionPolicy({runtimePerformanceRecorder: recorder}, policyReceipt())).not.toThrow();
    expect(recorder.seal()).toBe(receipt);
  });

  it('records only the active matching owner and suppresses detached, disposed and conflicting observations', () => {
    const identity = {runId: 'policy-run', sessionId: 'policy-session', scope: {tenantId: 't', workspaceId: 'w'}};
    const recorder = createRuntimePerformanceRecorder();
    const source = {identity, runtimePerformanceRecorder: recorder};
    expect(() => recordRuntimeModelExecutionPolicy(undefined, policyReceipt())).not.toThrow();
    const scope = createRuntimePerformanceScope({identity, recorder, assertCurrent() {}});
    const callback = scope.run(() => bindRuntimePerformanceContext(() => recordRuntimeModelExecutionPolicy(source, policyReceipt())));
    scope.run(callback);
    scope.dispose();
    callback();
    expect(recorder.seal().policyObservations).toHaveLength(1);

    const active = createRuntimePerformanceRecorder();
    const foreign = createRuntimePerformanceRecorder();
    const activeScope = createRuntimePerformanceScope({identity, recorder: active, assertCurrent() {}});
    activeScope.run(() => recordRuntimeModelExecutionPolicy({identity: {...identity, runId: 'foreign'}, runtimePerformanceRecorder: foreign}, policyReceipt()));
    expect(active.seal().policyObservations).toBeUndefined();
    expect(foreign.seal().policyObservations).toBeUndefined();
    activeScope.dispose();
  });

  it('rejects an expired current owner before disposal, including an explicit recorder outside async scope', () => {
    const identity = {runId: 'expired-run', sessionId: 'session', scope: {tenantId: 't', workspaceId: 'w'}};
    const recorder = createRuntimePerformanceRecorder();
    const source = {identity, runtimePerformanceRecorder: recorder};
    let current = true;
    const scope = createRuntimePerformanceScope({identity, recorder,
      assertCurrent() { if (!current) throw new Error('OWNER_EXPIRED_PRIVATE_DETAIL'); }});
    const callback = scope.run(() => bindRuntimePerformanceContext(() => recordRuntimeModelExecutionPolicy(source, policyReceipt())));
    current = false;
    expect(callback).not.toThrow();
    expect(() => recordRuntimeModelExecutionPolicy(source, policyReceipt())).not.toThrow();
    expect(recorder.hasRecordedData).toBe(false);
    expect(recorder.seal().policyObservations).toBeUndefined();
    scope.dispose();
  });

  it('does not add policy fields to old receipts and cannot throw an observer failure into a transport', () => {
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.seal()).not.toHaveProperty('policyObservations');
    const faulty = createRuntimePerformanceRecorder();
    jest.spyOn(faulty, 'recordModelExecutionPolicy').mockImplementation(() => {throw new Error('SECRET_OBSERVER_ERROR');});
    expect(() => recordRuntimeModelExecutionPolicy({runtimePerformanceRecorder: faulty}, policyReceipt())).not.toThrow();
  });
});

describe('runtime performance receipt', () => {
  it('records overlapping phases as separate bounded immutable spans', () => {
    let now = 100;
    const recorder = createRuntimePerformanceRecorder({now: () => now});

    const classification = recorder.startPhase('classification');
    now = 110;
    const provider = recorder.startPhase('provider');
    now = 140;
    classification.end();
    now = 160;
    provider.end();

    const receipt = recorder.seal();

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      phases: [
        {
          name: 'classification',
          startOffsetMs: 0,
          durationMs: 40,
          outcome: 'ok',
        },
        {
          name: 'provider',
          startOffsetMs: 10,
          durationMs: 50,
          outcome: 'ok',
        },
      ],
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.phases)).toBe(true);
    expect(receipt.tools).toEqual([]);
    expect(receipt.sql).toEqual([]);
  });

  it('does not fabricate unobserved runtime phases during finalization', () => {
    let now = 10;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 20;
    run.finishClassification();
    now = 30;
    run.finalize('ok');

    expect(recorder.seal().phases.map(phase => phase.name)).toEqual([
      'classification',
    ]);
  });

  it('records real finalization span duration only when the runtime starts and ends it', () => {
    let now = 100;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 105;
    run.finishClassification();
    now = 110;
    const finalization = run.startPhase('finalization');
    now = 145;
    finalization.end('cancelled');
    now = 200;
    run.finalize('cancelled');

    expect(recorder.seal().phases).toEqual([
      expect.objectContaining({
        name: 'classification',
        startOffsetMs: 0,
        durationMs: 5,
        outcome: 'ok',
      }),
      expect.objectContaining({
        name: 'finalization',
        startOffsetMs: 10,
        durationMs: 35,
        outcome: 'cancelled',
      }),
    ]);
  });

  it('finalize closes an already-started classification span with terminal outcome only', () => {
    let now = 50;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 75;
    run.finalize('error');

    expect(recorder.seal().phases).toEqual([
      {
        name: 'classification',
        startOffsetMs: 0,
        durationMs: 25,
        outcome: 'error',
      },
    ]);
  });

  it('assigns first output once and records phase outcomes', () => {
    let now = 1_000;
    const recorder = createRuntimePerformanceRecorder({now: () => now});

    const verification = recorder.startPhase('verification');
    now = 1_025;
    recorder.recordFirstOutput();
    now = 1_080;
    recorder.recordFirstOutput();
    verification.end('error');
    const finalization = recorder.startPhase('finalization');
    finalization.end('cancelled');

    expect(recorder.seal()).toMatchObject({
      firstOutputMs: 25,
      phases: [
        expect.objectContaining({name: 'verification', outcome: 'error'}),
        expect.objectContaining({name: 'finalization', outcome: 'cancelled'}),
      ],
    });
  });

  it('rejects privacy-bearing fields and hashes raw tool ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'raw-tool-id-123',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 2,
      outcome: 'ok',
    });
    expect(() => recorder.recordTool({
      toolCallId: 'safe',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 2,
      outcome: 'ok',
      prompt: 'must-not-leak',
    } as any)).toThrow('runtime_performance_privacy_field:prompt');
    expect(() => recorder.recordSql({
      processorKey: 'processor-a',
      priority: 'p1',
      queueWaitMs: 1,
      executionMs: 2,
      outcome: 'ok',
      sql: 'SELECT secret',
    } as any)).toThrow('runtime_performance_privacy_field:sql');

    const receipt = recorder.seal();

    expect(receipt.tools).toHaveLength(1);
    expect(receipt.tools[0].toolCallIdHash).toMatch(/^sha256:/);
    expect(JSON.stringify(receipt)).not.toContain('raw-tool-id-123');
  });

  it('records bounded tool concurrency fallback reasons without leaking raw ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'raw-fallback-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 12,
      durationMs: 2,
      outcome: 'ok',
      fallbackReason: 'disabled_by_env',
    } as any);
    recorder.recordTool({
      toolCallId: 'raw-demoted-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 1,
      durationMs: 3,
      outcome: 'error',
      fallbackReason: 'commutative_read_not_admitted',
    } as any);
    expect(() => recorder.recordTool({
      toolCallId: 'bad-fallback-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
      fallbackReason: 'raw_query_disabled_by_secret',
    } as any)).toThrow('runtime_performance_invalid_tool_fallback_reason');

    const receipt = recorder.seal();

    expect(receipt.tools).toEqual([
      expect.objectContaining({
        fallbackReason: 'disabled_by_env',
        schedulerWaitMs: 12,
      }),
      expect.objectContaining({
        fallbackReason: 'commutative_read_not_admitted',
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain('raw-fallback-tool-id');
    expect(JSON.stringify(receipt)).not.toContain('raw-demoted-tool-id');
    expect(JSON.stringify(receipt)).not.toContain('raw_query_disabled_by_secret');
  });

  it('omits fallbackReason for older exclusive tool receipts', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'legacy-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    });

    expect(recorder.seal().tools[0]).not.toHaveProperty('fallbackReason');
  });

  it('hashes the exact canonical SQL processor key without leaking trace or lease ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});
    const processorKey = 'trace-a:lease:lease-a';

    recorder.recordSql({
      processorKey,
      priority: 'p0',
      queueWaitMs: 7,
      executionMs: 13,
      outcome: 'ok',
    });

    expect(recorder.seal().sql).toEqual([{
      processorKeyHash: expectedRuntimeHash(processorKey),
      priority: 'p0',
      queueWaitMs: 7,
      executionMs: 13,
      outcome: 'ok',
    }]);
    expect(JSON.stringify(recorder.seal())).not.toContain('trace-a');
    expect(JSON.stringify(recorder.seal())).not.toContain('lease-a');
  });

  it('rejects over-cap hash inputs instead of truncating into collisions', () => {
    const recorder = createRuntimePerformanceRecorder({
      now: () => 0,
      maxHashInputBytes: 8,
    });

    expect(() => recorder.recordTool({
      toolCallId: 'abcdefgh-collision-a',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(() => recorder.recordTool({
      toolCallId: 'abcdefgh-collision-b',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(() => recorder.recordSql({
      processorKey: 'abcdefgh:lease:collision-a',
      priority: 'p1',
      queueWaitMs: 1,
      executionMs: 2,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(recorder.seal().tools).toEqual([]);
    expect(recorder.seal().sql).toEqual([]);
  });

  it('hard-caps phase, tool, sql arrays and records dropped counts', () => {
    let now = 0;
    const recorder = createRuntimePerformanceRecorder({
      now: () => now,
      maxPhases: 1,
      maxTools: 1,
      maxSql: 1,
      maxHashInputBytes: 64,
    });

    const first = recorder.startPhase('classification');
    now = 1;
    first.end();
    const droppedPhase = recorder.startPhase('provider');
    now = 2;
    droppedPhase.end();
    recorder.recordTool({
      toolCallId: 'tool-call-id-one',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 3,
      outcome: 'ok',
    });
    recorder.recordTool({
      toolCallId: 'tool-call-id-two',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 4,
      outcome: 'error',
    });
    recorder.recordSql({
      processorKey: 'trace-a',
      priority: 'p1',
      queueWaitMs: 5,
      executionMs: 6,
      outcome: 'ok',
    });
    recorder.recordSql({
      processorKey: 'trace-b',
      priority: 'p2',
      queueWaitMs: 7,
      executionMs: 8,
      outcome: 'error',
    });

    const receipt = recorder.seal();

    expect(receipt.phases).toHaveLength(1);
    expect(receipt.tools).toHaveLength(1);
    expect(receipt.sql).toHaveLength(1);
    expect(receipt.truncated).toEqual({
      phases: 1,
      tools: 1,
      sql: 1,
    });
    expect(receipt.tools[0].toolCallIdHash).toMatch(/^sha256:/);
    expect(JSON.stringify(receipt)).not.toContain('tool-call-id-one');
  });

  it('rejects late writes after seal', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});
    const phase = recorder.startPhase('classification');
    phase.end();
    recorder.seal();

    expect(() => recorder.startPhase('provider')).toThrow(
      'runtime_performance_already_sealed:start_phase',
    );
    expect(() => recorder.recordFirstOutput()).toThrow(
      'runtime_performance_already_sealed:record_first_output',
    );
  });

  it('records the runtime five-phase spine without public output content', () => {
    let now = 10;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 20;
    run.finishClassification();
    now = 30;
    const quickEvidence = run.startPhase('quick_evidence');
    now = 40;
    quickEvidence.end();
    now = 50;
    const provider = run.startPhase('provider');
    now = 65;
    run.recordFirstOutput();
    now = 80;
    provider.end();
    now = 90;
    const verification = run.startPhase('verification');
    now = 95;
    verification.end();
    now = 100;
    run.finalize('ok');

    const receipt = recorder.seal();

    expect(receipt.firstOutputMs).toBe(55);
    expect(receipt.phases.map(phase => phase.name)).toEqual([
      'classification',
      'quick_evidence',
      'provider',
      'verification',
    ]);
    expect(JSON.stringify(receipt)).not.toContain('SELECT');
  });

  it('records each model call with purpose, time to first output and provider usage', () => {
    let now = 0;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});
    now = 10;
    const call = run.startModelCall({purpose: 'declaration_repair', trigger: 'invalid_declaration',
      model: 'requested-model', reasoning: 'provider_default'});
    now = 25;
    call.recordFirstOutput();
    now = 30;
    call.recordFirstOutput();
    now = 40;
    call.markDone({inputTokens: 100, outputTokens: 20, outputTokensDetails: {reasoning_tokens: 5},
      inputTokensDetails: {cached_tokens: 64}});
    now = 90;
    call.end({model: 'provider-model', output: {bodyChars: 12, sidecarChars: 300}});
    call.end({outcome: 'error'});

    expect(recorder.seal().modelCalls).toEqual([{purpose: 'declaration_repair', trigger: 'invalid_declaration',
      model: 'provider-model', reasoning: 'provider_default', startOffsetMs: 10, durationMs: 30, firstOutputMs: 15,
      outcome: 'ok', output: {bodyChars: 12, sidecarChars: 300},
      usage: {inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cachedInputTokens: 64}}]);
  });

  it('reads raw Chat Completions usage and ignores anything that is not a token count', () => {
    expect(normalizeModelCallUsage({prompt_tokens: 7, completion_tokens: 3,
      completion_tokens_details: {reasoning_tokens: 2}, prompt_tokens_details: {cached_tokens: 1}}))
      .toEqual({inputTokens: 7, outputTokens: 3, reasoningTokens: 2, cachedInputTokens: 1});
    expect(normalizeModelCallUsage({prompt_tokens: -1, completion_tokens: 'many'})).toBeUndefined();
    expect(normalizeModelCallUsage('usage')).toBeUndefined();
  });

  it.each(RUNTIME_DECLARATION_AUTHORING_STATUSES)('records the observed declaration codec result %s without implying verification', status => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startModelCall({purpose: 'answer_turn'}).end({
      output: {bodyChars: 12, sidecarChars: 300, declarationAuthoringStatus: status},
    });
    expect(recorder.seal().modelCalls?.[0].output).toEqual({bodyChars: 12, sidecarChars: 300,
      declarationAuthoringStatus: status});
    expect(recorder.seal()).not.toHaveProperty('declaration');
  });

  it.each(RUNTIME_DECLARATION_AUTHORING_VERSIONS)('records actual %s only for an expanded declaration', version => {
    const recorder = createRuntimePerformanceRecorder();
    for (const status of RUNTIME_DECLARATION_AUTHORING_STATUSES) {
      recorder.startModelCall({purpose: 'answer_turn'}).end({output: {bodyChars: 12, sidecarChars: 300,
        declarationAuthoringStatus: status, declarationAuthoringVersion: version}});
    }
    expect(recorder.seal().modelCalls?.map(call => call.output)).toEqual(RUNTIME_DECLARATION_AUTHORING_STATUSES.map(status => ({
      bodyChars: 12, sidecarChars: 300, declarationAuthoringStatus: status,
      ...(status === 'expanded' ? {declarationAuthoringVersion: version} : {}),
    })));
  });

  it('drops unknown observed grammar versions without exporting arbitrary content', () => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startModelCall({purpose: 'answer_turn'}).end({output: {bodyChars: 1, sidecarChars: 20,
      declarationAuthoringStatus: 'expanded', declarationAuthoringVersion: 'PRIVATE_VERSION_CANARY'} as any});
    expect(recorder.seal().modelCalls?.[0].output).toEqual({bodyChars: 1, sidecarChars: 20, declarationAuthoringStatus: 'expanded'});
    expect(JSON.stringify(recorder.seal())).not.toContain('PRIVATE_VERSION_CANARY');
  });

  it.each(['canonical', 'PRIVATE_AUTHORING_STATUS_CANARY'])('drops unknown authoring status %s and does not backfill older output records', canary => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startModelCall({purpose: 'answer_turn'}).end({output: {bodyChars: 12, sidecarChars: 300,
      declarationAuthoringStatus: canary} as any});
    recorder.startModelCall({purpose: 'answer_turn'}).end({output: {bodyChars: 12, sidecarChars: 300}});
    const receipt = recorder.seal();
    expect(receipt.modelCalls?.map(call => call.output)).toEqual([
      {bodyChars: 12, sidecarChars: 300}, {bodyChars: 12, sidecarChars: 300},
    ]);
    expect(JSON.stringify(receipt)).not.toContain(canary);
  });

  it('records the first final review decision once and never throws once sealed', () => {
    const recorder = createRuntimePerformanceRecorder();
    recordRuntimeFinalReview(recorder, {necessity: 'not_required',
      triggers: ['report', 'report'], declaredClaimCount: 2});
    recordRuntimeFinalReview(recorder, {necessity: 'required', triggers: ['source'], declaredClaimCount: 5});
    expect(recorder.seal().finalReview).toEqual({necessity: 'not_required', triggers: ['report'], declaredClaimCount: 2});
    expect(() => recordRuntimeFinalReview(recorder, {necessity: 'required', triggers: [], declaredClaimCount: 0})).not.toThrow();
    const late = startRuntimeModelCall(recorder, {purpose: 'review'});
    expect(() => {late.recordFirstOutput(); late.markDone(); late.end();}).not.toThrow();
    expect(recorder.seal().modelCalls).toBeUndefined();
  });

  it('passes a transport request through unchanged without a recorder and observes it with one', async () => {
    const input = {prompt: 'p', systemPrompt: '', deadlineMs: Date.now() + 1_000, outputByteLimit: 10};
    const dispatch = jest.fn(async (request: typeof input & {observer?: any}) => {
      request.observer?.reasoning?.('disabled');
      request.observer?.firstOutput?.();
      request.observer?.usage?.({input_tokens: 4, output_tokens: 2});
      return {status: 'ok' as const, text: '{}', actualModel: 'light-reported'};
    });
    await dispatchWithModelCallRecord(undefined, {purpose: 'classification'}, input, dispatch);
    expect(dispatch.mock.calls[0][0]).toBe(input);

    const recorder = createRuntimePerformanceRecorder();
    await dispatchWithModelCallRecord(recorder, {purpose: 'review'}, input, dispatch);
    expect(recorder.seal().modelCalls).toEqual([expect.objectContaining({purpose: 'review', model: 'light-reported',
      reasoning: 'disabled', outcome: 'ok', firstOutputMs: expect.any(Number), usage: {inputTokens: 4, outputTokens: 2}})]);
  });
  it('distinguishes enabled effort from disabled reasoning and never records arbitrary controls', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const input = {prompt: 'p', systemPrompt: '', deadlineMs: Date.now() + 1_000, outputByteLimit: 10};
    await dispatchWithModelCallRecord(recorder, {purpose: 'review'}, input, async request => {
      request.observer?.reasoning?.('enabled', 'low');
      return {status: 'ok', text: '{}'};
    });
    startRuntimeModelCall(recorder, {purpose: 'classification', reasoning: 'PRIVATE_CANARY' as any,
      reasoningEffort: 'PRIVATE_CANARY' as any}).end();
    startRuntimeModelCall(recorder, {purpose: 'classification', reasoning: 'disabled', reasoningEffort: 'high'}).end();
    const calls = recorder.seal().modelCalls!;
    expect(calls[0]).toMatchObject({reasoning: 'enabled', reasoningEffort: 'low'});
    expect(calls[1]).not.toHaveProperty('reasoning');
    expect(calls[1]).not.toHaveProperty('reasoningEffort');
    expect(calls[2]).toMatchObject({reasoning: 'disabled'});
    expect(calls[2]).not.toHaveProperty('reasoningEffort');
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_CANARY');
  });

  it('keeps only a closed provider origin and input-size bucket on a model call receipt', async () => {
    expect(runtimeProviderOrigin('https://user:secret@api.deepseek.com/v1?key=x')).toBe('https://api.deepseek.com');
    expect(runtimeProviderOrigin('file:///etc/passwd')).toBeUndefined();
    expect(runtimeProviderOrigin('not a url')).toBeUndefined();
    expect([0, 32 * 1024, 32 * 1024 + 1, 128 * 1024, 128 * 1024 + 1, -1, 1.5].map(runtimeModelCallInputBytesBucket))
      .toEqual(['le32k', 'le32k', 'le128k', 'le128k', 'gt128k', undefined, undefined]);

    const recorder = createRuntimePerformanceRecorder();
    startRuntimeModelCall(recorder, {purpose: 'continuation', providerOrigin: 'https://open.bigmodel.cn/api/paas/v4',
      inputBytesBucket: 'le128k'}).end();
    startRuntimeModelCall(recorder, {purpose: 'continuation', providerOrigin: 'ftp://host',
      inputBytesBucket: 'huge' as never}).end();
    const input = {prompt: 'x'.repeat(40 * 1024), systemPrompt: 'y', deadlineMs: Date.now() + 1_000, outputByteLimit: 10};
    await dispatchWithModelCallRecord(recorder, {purpose: 'review', providerOrigin: 'https://api.z.ai/api/paas/v4'}, input,
      async () => ({status: 'ok' as const, text: '{}'}));
    const calls = recorder.seal().modelCalls!;
    expect(calls[0]).toMatchObject({providerOrigin: 'https://open.bigmodel.cn', inputBytesBucket: 'le128k'});
    expect(calls[1]).not.toHaveProperty('providerOrigin');
    expect(calls[1]).not.toHaveProperty('inputBytesBucket');
    expect(calls[2]).toMatchObject({purpose: 'review', providerOrigin: 'https://api.z.ai', inputBytesBucket: 'le128k'});
  });

  it('records delivery budget decisions and never throws once sealed', () => {
    const recorder = createRuntimePerformanceRecorder();
    recordRuntimeDeliveryBudget(recorder, {purpose: 'review', decision: 'skip', source: 'default', estimateMs: 90_000,
      remainingMs: 1_000, diagnostic: 'no_samples'});
    expect(recorder.seal().deliveryBudgets).toEqual([{purpose: 'review', decision: 'skip', source: 'default',
      estimateMs: 90_000, remainingMs: 1_000, diagnostic: 'no_samples'}]);
    expect(() => recordRuntimeDeliveryBudget(recorder, {purpose: 'review', decision: 'dispatch', source: 'stats',
      estimateMs: 1, remainingMs: 2})).not.toThrow();
    expect(recorder.seal().deliveryBudgets).toHaveLength(1);
  });
});

describe('canonical declaration receipt', () => {
  it.each(['absent', 'valid', 'partially_valid', 'invalid'] as const)(
    'retains a declaration-only %s receipt with no model or provider content', status => {
      const recorder = createRuntimePerformanceRecorder();
      expect(recorder.hasRecordedData).toBe(false);
      const declaredClaimCount = status === 'absent' ? 0 : 2;
      recordRuntimeFinalDeclaration(recorder, {status, declaredClaimCount});
      expect(recorder.hasRecordedData).toBe(true);
      expect(recorder.seal()).toEqual({schemaVersion: 1, phases: [], tools: [], sql: [],
        declaration: {status, declaredClaimCount, repair: 'not_requested'}});
      expect(Object.isFrozen(recorder.seal().declaration)).toBe(true);
    });

  it.each(['not_completed', 'cancelled', 'error'] as const)(
    'records a dispatched repair as %s without inferring acceptance from native success', outcome => {
      const recorder = createRuntimePerformanceRecorder();
      startRuntimeModelCall(recorder, {purpose: 'declaration_repair'}).end({outcome: outcome === 'not_completed' ? 'ok' : outcome});
      recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
      expect(recorder.seal().declaration).toEqual({status: 'absent', declaredClaimCount: 0, repair: outcome});
    });

  it.each(['started', 'dispatch_budget'] as const)('keeps a %s repair without a terminal decision explicitly incomplete', mode => {
    const recorder = createRuntimePerformanceRecorder();
    if (mode === 'started') startRuntimeModelCall(recorder, {purpose: 'declaration_repair'});
    else recordRuntimeDeliveryBudget(recorder, {purpose: 'declaration_repair', decision: 'dispatch', source: 'default',
      estimateMs: 180_000, remainingMs: 40_000});
    recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
    expect(recorder.seal().declaration?.repair).toBe('not_completed');
  });

  it.each(['accepted', 'rejected'] as const)('requires an explicit %s decision and preserves it across late transport facts', outcome => {
    const recorder = createRuntimePerformanceRecorder();
    const call = startRuntimeModelCall(recorder, {purpose: 'declaration_repair'});
    recordRuntimeDeclarationRepair(recorder, outcome);
    call.end({outcome: 'ok'});
    recordRuntimeFinalDeclaration(recorder, {status: outcome === 'accepted' ? 'valid' : 'invalid', declaredClaimCount: 1});
    expect(recorder.seal().declaration?.repair).toBe(outcome);
  });

  it('preserves repair cancellation even when the timing array is truncated', () => {
    const recorder = createRuntimePerformanceRecorder({maxModelCalls: 1});
    startRuntimeModelCall(recorder, {purpose: 'answer_turn'}).end();
    startRuntimeModelCall(recorder, {purpose: 'declaration_repair'}).end({outcome: 'cancelled'});
    recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
    const receipt = recorder.seal();
    expect(receipt.modelCalls).toHaveLength(1);
    expect(receipt.modelCalls![0].purpose).toBe('answer_turn');
    expect(receipt.truncated?.modelCalls).toBe(1);
    expect(receipt.declaration?.repair).toBe('cancelled');
  });

  it('preserves the repair skip even when earlier budget records fill the array', () => {
    const recorder = createRuntimePerformanceRecorder();
    for (let index = 0; index < 600; index++) recordRuntimeDeliveryBudget(recorder, {
      purpose: 'review', decision: 'dispatch', source: 'default', estimateMs: 1, remainingMs: 2});
    recordRuntimeDeliveryBudget(recorder, {purpose: 'declaration_repair', decision: 'skip', source: 'default',
      estimateMs: 180_000, remainingMs: 40_000});
    recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
    const receipt = recorder.seal();
    expect(receipt.deliveryBudgets!.length).toBeLessThan(600);
    expect(receipt.deliveryBudgets!.some(item => item.purpose === 'declaration_repair')).toBe(false);
    expect(receipt.declaration?.repair).toBe('budget_skipped');
  });

  it('freezes both declaration and repair at the first canonical result before seal', () => {
    const recorder = createRuntimePerformanceRecorder();
    const pending = startRuntimeModelCall(recorder, {purpose: 'declaration_repair'});
    recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
    pending.end({outcome: 'cancelled'});
    recordRuntimeDeclarationRepair(recorder, 'accepted');
    recordRuntimeDeliveryBudget(recorder, {purpose: 'declaration_repair', decision: 'skip', source: 'default',
      estimateMs: 1, remainingMs: 0});
    startRuntimeModelCall(recorder, {purpose: 'declaration_repair'}).end({outcome: 'error'});
    recordRuntimeFinalDeclaration(recorder, {status: 'valid', declaredClaimCount: 9});
    expect(recorder.seal().declaration).toEqual({status: 'absent', declaredClaimCount: 0, repair: 'not_completed'});
  });

  it.each([
    {status: 'SECRET_PROVIDER_TEXT', declaredClaimCount: 0},
    {status: 'valid', declaredClaimCount: -1},
    {status: 'valid', declaredClaimCount: 1.5},
    {status: 'valid', declaredClaimCount: Number.MAX_SAFE_INTEGER + 1},
    {status: 'valid', declaredClaimCount: 1, prompt: 'SECRET_PROVIDER_TEXT'},
    {status: 'valid', declaredClaimCount: 1, repair: 'accepted'},
  ])('rejects invalid or open declaration facts without persisting them: %#', input => {
    const recorder = createRuntimePerformanceRecorder();
    expect(() => recorder.recordFinalDeclaration(input as any)).toThrow();
    expect(() => recordRuntimeFinalDeclaration(recorder, input as any)).not.toThrow();
    expect(recorder.hasRecordedData).toBe(false);
    expect(recorder.seal().declaration).toBeUndefined();
    expect(JSON.stringify(recorder.seal())).not.toContain('SECRET_PROVIDER_TEXT');
  });

  it('ignores invalid repair decisions and remains inert without a recorder or after seal', () => {
    const recorder = createRuntimePerformanceRecorder();
    expect(() => recorder.recordDeclarationRepair('SECRET_PROVIDER_TEXT' as never)).toThrow();
    expect(() => recordRuntimeDeclarationRepair(recorder, 'SECRET_PROVIDER_TEXT' as never)).not.toThrow();
    recordRuntimeFinalDeclaration(recorder, {status: 'absent', declaredClaimCount: 0});
    const receipt = recorder.seal();
    expect(receipt.declaration?.repair).toBe('not_requested');
    for (const target of [undefined, recorder]) {
      expect(() => recordRuntimeDeclarationRepair(target, 'accepted')).not.toThrow();
      expect(() => recordRuntimeFinalDeclaration(target, {status: 'valid', declaredClaimCount: 1})).not.toThrow();
    }
    expect(recorder.seal()).toBe(receipt);
    expect(JSON.stringify(receipt)).not.toContain('SECRET_PROVIDER_TEXT');
  });
});

describe('scene entry evidence receipt', () => {
  it('records one closed receipt and the scene_evidence phase, first record wins', () => {
    let now = 0;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});
    const phase = run.startPhase('scene_evidence');
    now = 40;
    phase.end('ok');
    run.recordSceneEvidence({skillId: 'scrolling_analysis', status: 'ran', durationMs: 40, artifactCount: 12, captureCount: 11});
    run.recordSceneEvidence({skillId: 'startup_analysis', status: 'not_run', reason: 'timeout', durationMs: 1,
      artifactCount: 0, captureCount: 0});
    const receipt = recorder.seal();
    expect(receipt.sceneEvidence).toEqual({skillId: 'scrolling_analysis', status: 'ran', durationMs: 40,
      artifactCount: 12, captureCount: 11});
    expect(receipt.phases).toEqual([{name: 'scene_evidence', startOffsetMs: 0, durationMs: 40, outcome: 'ok'}]);
    expect(receipt.tools).toEqual([]);
  });

  it.each([
    [{skillId: 'Scrolling Analysis', status: 'ran'}],
    [{skillId: 'scrolling_analysis', status: 'ran', reason: 'timeout'}],
    [{skillId: 'scrolling_analysis', status: 'not_run'}],
    [{skillId: 'scrolling_analysis', status: 'not_run', reason: 'free_text'}],
    [{skillId: 'scrolling_analysis', status: 'ran', artifactCount: -1}],
    [{skillId: 'scrolling_analysis', status: 'ran', sql: 'SELECT 1'}],
  ])('refuses an open or private field %#', partial => {
    const recorder = createRuntimePerformanceRecorder();
    expect(() => recorder.recordSceneEvidence({durationMs: 1, artifactCount: 0, captureCount: 0, ...partial} as any)).toThrow();
    // The run wrapper never throws into the run it observes.
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});
    expect(() => run.recordSceneEvidence({durationMs: 1, artifactCount: 0, captureCount: 0, ...partial} as any)).not.toThrow();
    expect(recorder.seal().sceneEvidence).toBeUndefined();
  });
});


describe('run activity observation', () => {
  const identity = (runId: string) => ({runId, sessionId: `session-${runId}`,
    scope: {tenantId: 'tenant', workspaceId: 'workspace'}});

  it('counts exact calls independent of key order without retaining tool inputs or hashes', () => {
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.activitySnapshot()).toMatchObject({observation: 'unavailable'});
    const one = recorder.startToolActivity('execute_sql', {query: 'PRIVATE SQL', params: {upid: 42, start: 10}});
    one.dispatched(); one.end('returned', {success: true});
    const two = recorder.startToolActivity('execute_sql', {params: {start: 10, upid: 42}, query: 'PRIVATE SQL'});
    two.dispatched(); two.end('returned', {success: false, refused: true});
    recorder.startToolActivity('execute_sql', {query: 'PRIVATE SQL', params: {upid: 43, start: 10}}).end('cancelled');
    const activity = recorder.seal().activity!;
    expect(activity).toMatchObject({observation: 'observed', attempted: 3, dispatched: 2, repeatedExactCalls: 1,
      returned: 2, succeeded: 1, refused: 1, failed: 0, cancelled: 1, inFlight: 0, evidenceNovelty: 'not_assessed'});
    expect(parseRuntimeActivitySnapshot(activity)).toEqual(activity);
    expect(JSON.stringify(activity)).not.toMatch(/PRIVATE|execute_sql|upid|sha256/);
    const other = createRuntimePerformanceRecorder();
    other.startToolActivity('execute_sql', {query: 'PRIVATE SQL', params: {upid: 42, start: 10}}).end('returned');
    expect(other.activitySnapshot()).toMatchObject({repeatedExactCalls: 0, unknownOutcome: 1});
  });

  it.each(['oversized', 'cyclic', 'getter', 'undefined'])(
    'keeps %s argument comparison incomplete rather than matching a truncated prefix', kind => {
      const recorder = createRuntimePerformanceRecorder();
      const args: Record<string, unknown> = kind === 'oversized' ? {query: 'X'.repeat(70_000)} : {};
      if (kind === 'cyclic') args.self = args;
      if (kind === 'getter') Object.defineProperty(args, 'query', {enumerable: true, get: () => {throw new Error('getter must not run');}});
      if (kind === 'undefined') args.query = undefined;
      recorder.startToolActivity('execute_sql', args).end('returned');
      recorder.startToolActivity('execute_sql', args).end('returned');
      const activity = recorder.activitySnapshot();
      expect(activity).toMatchObject({observation: 'partial', attempted: 2});
      expect(activity.repeatedExactCalls).toBeUndefined();
    });

  it('bounds retained comparison state and exposes incomplete counts at the cap', () => {
    const recorder = createRuntimePerformanceRecorder();
    for (let index = 0; index < 513; index++) recorder.startToolActivity('tool', {index}).end('returned');
    expect(recorder.activitySnapshot()).toMatchObject({observation: 'partial', attempted: 512, dropped: 1, inFlight: 0});
    expect(recorder.activitySnapshot().repeatedExactCalls).toBeUndefined();
  });

  it('uses a private no-manifest scope for phases/model/finalization and ignores late spans', async () => {
    const recorder = createRuntimePerformanceRecorder();
    let authorized = true;
    const scope = createRuntimePerformanceScope({identity: identity('one'), recorder,
      assertCurrent: () => {if (!authorized) throw new Error('revoked');}});
    let pending!: ReturnType<typeof recorder.startToolActivity>;
    let phase!: ReturnType<typeof recorder.startPhase>;
    await scope.run(async () => {
      expect(resolveRuntimePerformanceRecorder()).toBe(recorder);
      const run = createRuntimePerformanceRun();
      run.finishClassification();
      const model = startRuntimeModelCall(undefined, {purpose: 'answer_turn'});
      model.end();
      recordRuntimeFinalReview(undefined, {necessity: 'not_required', triggers: [], declaredClaimCount: 0});
      pending = recorder.startToolActivity('tool', {});
      phase = run.startPhase('provider');
    });
    authorized = false;
    scope.dispose();
    const sealed = recorder.seal();
    pending.end('cancelled');
    expect(() => phase.end()).not.toThrow();
    expect(recorder.seal()).toBe(sealed);
    expect(sealed.activity).toMatchObject({observation: 'partial', inFlight: 1});
    expect(sealed.modelCalls).toHaveLength(1);
    expect(sealed.finalReview?.necessity).toBe('not_required');
    expect(sealed.phases.map(item => item.name)).toEqual(['classification']);
    expect(scope.run(() => resolveRuntimePerformanceRecorder())).toBeUndefined();
  });

  it('suppresses identity conflicts without changing a foreign or successor recorder', () => {
    const current = createRuntimePerformanceRecorder();
    const foreign = createRuntimePerformanceRecorder();
    const scope = createRuntimePerformanceScope({identity: identity('current'), recorder: current, assertCurrent() {}});
    scope.run(() => {
      expect(resolveRuntimePerformanceRecorder({identity: identity('other'), runtimePerformanceRecorder: foreign})).toBeUndefined();
      expect(resolveRuntimePerformanceRecorder()).toBeUndefined();
      startRuntimeModelCall(undefined, {purpose: 'answer_turn'}).end();
    });
    expect(current.activitySnapshot().observation).toBe('partial');
    expect(foreign.activitySnapshot().observation).toBe('unavailable');
    expect(current.seal().modelCalls).toBeUndefined();
    scope.dispose();
  });

  it('bounds capture registrations independently of tool observation and never retains witness ids', () => {
    const recorder = createRuntimePerformanceRecorder();
    for (let index = 0; index < 513; index++) recorder.recordCaptureActivity({captureId: `private-${index}`},
      {rowSlots: 1, unavailable: false, origin: 'current_run'});
    const activity = recorder.seal().activity!;
    expect(activity).toMatchObject({observation: 'unavailable', captureActivity: {observation: 'partial',
      tables: 512, rowSlots: 512, dropped: 1, currentRunTables: 512}});
    expect(parseRuntimeActivitySnapshot(activity)).toEqual(activity);
    expect(JSON.stringify(activity)).not.toContain('private');
    expect(() => parseRuntimeActivitySnapshot({...activity,
      captureActivity: {...activity.captureActivity, rowSlots: -1}})).toThrow('runtime_capture_activity_invalid');
    expect(() => parseRuntimeActivitySnapshot({...activity,
      captureActivity: {...activity.captureActivity, captureId: 'private'}})).toThrow('runtime_capture_activity_invalid');
  });

  it('suppresses nested pre-bound callbacks without invalidating either run recorder', () => {
    const first = createRuntimePerformanceRecorder();
    const second = createRuntimePerformanceRecorder();
    const firstScope = createRuntimePerformanceScope({identity: identity('first'), recorder: first, assertCurrent() {}});
    const secondScope = createRuntimePerformanceScope({identity: identity('second'), recorder: second, assertCurrent() {}});
    const callback = firstScope.run(() => bindRuntimePerformanceContext(() => {
      expect(resolveRuntimePerformanceRecorder()).toBeUndefined();
      startRuntimeModelCall(undefined, {purpose: 'answer_turn'}).end();
    }));
    secondScope.run(() => withRuntimePerformanceSuppressed(callback));
    expect(first.activitySnapshot().observation).toBe('unavailable');
    expect(second.activitySnapshot().observation).toBe('unavailable');
    firstScope.run(() => expect(resolveRuntimePerformanceRecorder()).toBe(first));
    secondScope.run(() => expect(resolveRuntimePerformanceRecorder()).toBe(second));
    firstScope.dispose(); secondScope.dispose();
  });

  it('rejects activity payload fields and inconsistent closed counts', () => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startToolActivity('tool', {}).end('returned', {success: true});
    const activity = recorder.activitySnapshot();
    expect(() => parseRuntimeActivitySnapshot({...activity, sql: 'private'})).toThrow('runtime_activity_invalid');
    expect(() => parseRuntimeActivitySnapshot({...activity, attempted: 0})).toThrow('runtime_activity_invalid');
    expect(() => parseRuntimeActivitySnapshot({...activity, observation: 'partial'})).toThrow('runtime_activity_invalid');
  });
});


describe('W0 actual transport observations and private configuration commitments', () => {
  const output = {finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'} as const;
  const hash = (value: string) => runtimeObservationHash(value);
  const rows = (value: unknown) => buildRuntimeConfigCommitments(value)!;

  it('masks only the two treatment leaves after side alignment, without descendant values in parent commitments', () => {
    const base = rows({environment: {SMARTPERFETTO_FINAL_SUBMISSION: 'assistant_text',
      SMARTPERFETTO_CONCLUSION_AUTHORING: 'canonical_v1', OPENAI_MAX_TURNS: '100'}, settings: [0, false]});
    const candidate = rows({environment: {SMARTPERFETTO_FINAL_SUBMISSION: 'authored_claim_document_v2',
      SMARTPERFETTO_CONCLUSION_AUTHORING: 'authoring_v2', OPENAI_MAX_TURNS: '100'}, settings: [0, false]});
    const aligned = alignRuntimeConfigCommitments(base, candidate)!;
    expect(runtimeConfigCommitmentsFingerprint(aligned[0])).not.toBe(runtimeConfigCommitmentsFingerprint(aligned[1]));
    expect(runtimeConfigControlsFingerprint(aligned[0])).toBe(runtimeConfigControlsFingerprint(aligned[1]));
    expect(aligned[0].find(row => row.field === '/environment')).toEqual(aligned[1].find(row => row.field === '/environment'));
    const artifact = {schemaVersion: 'benchmark_config_commitments@2', fields: aligned[0],
      fullFingerprint: runtimeConfigCommitmentsFingerprint(aligned[0]), controlsFingerprint: runtimeConfigControlsFingerprint(aligned[0]),
      legacyConfigFingerprint: 'a'.repeat(64)};
    expect(parseRuntimeBenchmarkConfigCommitments(artifact)).toEqual(artifact);
    expect(parseRuntimeBenchmarkConfigCommitments({...artifact, fullFingerprint: 'b'.repeat(64)})).toBeUndefined();
  });

  it.each([{settings: [false, 0]}, {settings: [0, false, null]}, {newControl: true}, {effort: 'low'}])(
    'retains array order/structure and every non-treatment control: %j', mutation => {
      const original = rows({settings: [0, false], effort: 'high'});
      const changed = rows({settings: [0, false], effort: 'high', ...mutation});
      const [left, right] = alignRuntimeConfigCommitments(original, changed)!;
      expect(runtimeConfigControlsFingerprint(left)).not.toBe(runtimeConfigControlsFingerprint(right));
    });

  it('uses collision-free JSON Pointer paths and explicit absent/undefined/number types', () => {
    const result = rows({'a/b': {'~': 0}, a: {b: -0}, '0': false, undefinedValue: undefined, values: [0]});
    expect(result.map(row => row.field)).toEqual(expect.arrayContaining(['/a~1b/~0', '/a/b', '/0', '/values/0']));
    expect(result.find(row => row.field === '/a~1b/~0')!.valueCommitment).not.toBe(result.find(row => row.field === '/a/b')!.valueCommitment);
    const [left, right] = alignRuntimeConfigCommitments(rows({}), rows({extra: undefined}))!;
    expect(left.find(row => row.field === '/extra')).toMatchObject({presence: 'absent', type: 'absent'});
    expect(right.find(row => row.field === '/extra')).toMatchObject({presence: 'present', type: 'undefined'});
    expect(runtimeConfigCommitmentsFingerprint(left)).not.toBe(runtimeConfigCommitmentsFingerprint(right));
  });

  it('does not inspect proxies or getters and never exposes committed private values', () => {
    const getter = jest.fn(() => 'PRIVATE');
    const value = Object.defineProperty({}, 'secret', {enumerable: true, get: getter});
    const trap = jest.fn();
    expect(buildRuntimeConfigCommitments(value)).toBeUndefined();
    expect(buildRuntimeConfigCommitments(new Proxy({}, {ownKeys: () => {trap(); return [];}}))).toBeUndefined();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
    expect(JSON.stringify(rows({url: 'https://user:PRIVATE@example.invalid/?key=PRIVATE'}))).not.toContain('PRIVATE');
    const cycle: any = {}; cycle.self = cycle;
    expect(buildRuntimeConfigCommitments(cycle)).toBeUndefined();
  });

  it('keeps all actual controls, normalizes only exact cwd, and excludes credentials/output choices', () => {
    const common = buildRuntimeCommonModelConfig({cwd: process.cwd(), apiKey: 'PRIVATE', outputConfig: output,
      newlyAddedBehavior: {budget: 7}}, {runtime: 'openai-agents-sdk',
      sdk: {packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'}})!;
    expect(common).toMatchObject({cwd: '<process.cwd>', newlyAddedBehavior: {budget: 7}});
    expect(common).not.toHaveProperty('apiKey'); expect(common).not.toHaveProperty('outputConfig');
    expect(buildRuntimeCommonModelConfig({cwd: `${process.cwd()}/custom`})!.cwd).toBe(`${process.cwd()}/custom`);
    const controls = buildRuntimeAppliedModelControls({requestedOutput: output, commonConfig: common,
      appliedSettings: {providerData: {thinking: {type: 'disabled'}}, extraActualParameter: true}})!;
    expect(controls.appliedSettings.some(row => row.field === '/extraActualParameter')).toBe(true);
    expect(JSON.stringify(controls)).not.toContain('PRIVATE');
  });

  it('preserves the real complete profile fingerprint and commits its structure without re-running eligibility', () => {
    const profile = resolveModelExecutionProfile({runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions',
      modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
      sdk: {packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'},
      sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', reasoningRoundtrip: 'unknown', source: 'contract_test'},
      effective: {maxOutputTokens: 3000}});
    const observed = buildRuntimeExecutionProfileObservation(profile, {role: 'stage_policy', purpose: 'review'})!;
    expect(observed.originalFingerprint).toEqual(profile.fingerprint);
    expect(observed.structureFingerprint).toBe(runtimeConfigCommitmentsFingerprint(observed.fields));
    expect(buildRuntimeExecutionProfileObservation({...profile, fingerprint: {...profile.fingerprint, value: `sha256:${'0'.repeat(64)}`}},
      {role: 'stage_policy', purpose: 'review'})).toBeUndefined();
  });

  it('records a bounded immutable event sequence and only looks up the exact retained candidate', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 10});
    const source = {runtimePerformanceRecorder: recorder};
    const nativeCandidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'run:attempt', conclusionFingerprint: hash('body')};
    const candidate = runtimeCandidateObservationKey(nativeCandidate);
    expect(candidate).toBe(analysisDeliveryFingerprint(nativeCandidate));
    const terminal = recordRuntimeFinalTransportEvent(source, {kind: 'native_terminal', fact: {attemptKey: hash('attempt'),
      logicalCallKey: hash('call'), response: {status: 'observed', hash: hash('response')}, actualModel: {status: 'unknown'},
      nativeStatus: 'completed', finish: 'stop', rawMaterial: {status: 'observed', hash: hash('body')},
      nativeContract: 'openai_native_completion_observer@1', sdkStreamCompleted: true}, drainStatus: 'fulfilled'})!;
    const retained = recordRuntimeFinalTransportEvent(source, {kind: 'candidate_retained', nativeCandidateKey: candidate,
      carrier: 'assistant_text', transform: 'native', authors: [{role: 'body_and_declaration', terminalEventKey: terminal}],
      declaredBody: 'present', declaredClaims: 'absent', productStatus: 'completed'})!;
    expect(findRuntimeRetainedTransportEvent(source, candidate)).toEqual({eventKey: retained, nativeCandidateKey: candidate});
    expect(findRuntimeRetainedTransportEvent(source, hash('other'))).toBeUndefined();
    const receipt = recorder.seal().finalTransportObservation!;
    expect(receipt.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(projectRuntimeFinalTransportObservation(receipt)).toEqual(receipt);
    expect(Object.isFrozen(receipt.events[0])).toBe(true);
    expect(recordRuntimeFinalTransportEvent(source, {kind: 'not_exercised', reason: 'program_ack'})).toBeUndefined();
    expect(findRuntimeRetainedTransportEvent(source, candidate)).toBeUndefined();
  });

  it('keeps malformed/dropped observations incomplete and never echoes unknown private event fields', () => {
    const recorder = createRuntimePerformanceRecorder({maxFinalTransportEvents: 1});
    const source = {runtimePerformanceRecorder: recorder};
    expect(recordRuntimeFinalTransportEvent(source, {kind: 'not_exercised', reason: 'program_ack'})).toMatch(/^[a-f0-9]{64}$/);
    expect(recordRuntimeFinalTransportEvent(source, {kind: 'not_exercised', reason: 'direct_without_main'})).toBeUndefined();
    expect(recorder.seal().finalTransportObservation!.truncated).toBe(1);
    const invalid = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: invalid},
      {kind: 'not_exercised', reason: 'program_ack', privatePrompt: 'PRIVATE'} as any)).toBeUndefined();
    expect(invalid.seal().finalTransportObservation).toEqual({schemaVersion: 'final_transport_observation@1', events: [], truncated: 1});
    expect(JSON.stringify(invalid.seal())).not.toContain('PRIVATE');
  });
});


describe('explicit provider model provenance', () => {
  it.each([
    [{}, 'configured', 'configured'],
    [{model: 'provider', modelSource: 'provider_reported'}, 'provider', 'provider_reported'],
    [{model: 'provider'}, 'provider', undefined],
    [{modelSource: 'provider_reported'}, 'configured', undefined],
    [{model: '', modelSource: 'provider_reported'}, 'configured', undefined],
    [{model: ' provider ', modelSource: 'provider_reported'}, 'provider', undefined],
    [{model: 'provider', modelSource: 'invented'}, 'provider', undefined],
  ] as const)('requires the producer tag and that same exact valid end model: %j', (end, expectedModel, source) => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startModelCall({purpose: 'classification', model: 'configured'}).end(end as any);
    expect(recorder.seal().modelCalls![0].model).toBe(expectedModel);
    expect(recorder.seal().modelCalls![0].modelSource).toBe(source);
  });

  it('never claims a model source when no model exists', () => {
    const recorder = createRuntimePerformanceRecorder();
    recorder.startModelCall({purpose: 'review'}).end({modelSource: 'provider_reported'});
    expect(recorder.seal().modelCalls![0]).not.toHaveProperty('model');
    expect(recorder.seal().modelCalls![0]).not.toHaveProperty('modelSource');
  });
});


describe('R11 closed typed output material observations', () => {
  function material(): RuntimeTypedOutputMaterial {
    return {
      schemaVersion: 'typed_output_material@1', wireToolRole: 'final_role',
      transport: {doneSeen: true, eofSeen: true, framing: 'valid', finishReason: 'length'},
      decoded: {arguments: {utf8Bytes: 1000, utf16Chars: 1000, utf8Precision: 'exact', utf16Precision: 'exact'},
        companion: {utf8Bytes: 12, utf16Chars: 4, utf8Precision: 'exact', utf16Precision: 'exact'}},
      retention: {arguments: {status: 'complete', retainedUtf8Bytes: 1000},
        companion: {status: 'not_retained', retainedUtf8Bytes: 0}, refusal: {status: 'not_observed', retainedUtf8Bytes: 0},
        combinedRetainedUtf8Bytes: 1000},
      json: {status: 'complete_json'}, representation: 'authored_claim_document@2',
      structure: {status: 'measured', collections: {
        referenceDictionary: {status: 'array', items: 0}, semanticFrames: {status: 'array', items: 0},
        claims: {status: 'array', items: 3}, bodyParts: {status: 'array', items: 3},
        relationProposals: {status: 'null'}, sourceClaimBindings: {status: 'missing'}},
        claimKinds: {counts: Object.fromEntries(CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => [kind, kind === 'numeric' ? 1 : 0])) as
          Record<typeof CONCLUSION_PROTOCOL_VALUES.claimKind[number], number>, absent: 1, unclassified: 1},
        bodyParts: {literalPartCount: 1, literalPartTextUtf8Bytes: 6, claimTextUseCount: 1, unclassifiedPartCount: 1},
        explicitNullCount: 3,
        exactTextReuse: {duplicateClaimTextCount: 1, duplicateClaimTextUtf8Bytes: 4,
          literalPartMatchingClaimTextCount: 1, literalPartMatchingClaimTextUtf8Bytes: 6},
        partition: {status: 'measured', totalNormalizedUtf8Bytes: 400, referenceDictionary: 2, semanticFrames: 2,
          claims: 100, bodyParts: 100, contractOther: 20, overhead: 176}},
    };
  }
  function event(value: unknown = material(), collectorDispatchOrdinal = 1): RuntimeFinalTransportEventInput {
    return {kind: 'typed_output_observed', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      collectorDispatchOrdinal, material: value} as unknown as RuntimeFinalTransportEventInput;
  }
  const mutable = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  function paths(value: Record<string, unknown>, select: 'object' | 'number', prefix: string[] = []): string[][] {
    return [...(select === 'object' ? [prefix] : []), ...Object.entries(value).flatMap(([key, child]) =>
      child !== null && typeof child === 'object' ? paths(child as Record<string, unknown>, select, [...prefix, key]) :
        select === 'number' && typeof child === 'number' ? [[...prefix, key]] : [])];
  }
  function at(value: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
    return path.reduce<Record<string, unknown>>((current, key) => current[key] as Record<string, unknown>, value);
  }
  function dropped(value: unknown, ordinal = 1): void {
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value, ordinal))).toBeUndefined();
    expect(recorder.seal().finalTransportObservation).toEqual({schemaVersion: 'final_transport_observation@1', events: [], truncated: 1});
  }

  it('preserves counts for complete length-terminated JSON without granting authorship, native status or proof', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event())).toMatch(/^[a-f0-9]{64}$/);
    const receipt = recorder.seal();
    expect(receipt.finalTransportObservation?.events).toEqual([expect.objectContaining(event())]);
    expect(projectRuntimeFinalTransportObservation(receipt.finalTransportObservation)).toEqual(receipt.finalTransportObservation);
    expect(receipt.finalTransportObservation?.events[0]).not.toHaveProperty('nativeStatus');
    expect(findRuntimeRetainedTransportEvent({runtimePerformanceRecorder: recorder}, 'a'.repeat(64))).toBeUndefined();
    expect(Object.isFrozen(receipt.finalTransportObservation?.events[0])).toBe(true);
  });

  it('retains not_observed for absent structure measurement and distinct nullable/missing collections', () => {
    const unknown = {...material(), structure: {status: 'not_observed'}};
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(unknown))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: {structure: {status: 'not_observed'}}});
    const partial = mutable(material());
    const structure = at(partial, ['structure']);
    at(structure, ['collections']).claims = {status: 'null'};
    at(structure, ['collections']).bodyParts = {status: 'missing'};
    delete structure.claimKinds; delete structure.bodyParts; delete structure.exactTextReuse;
    structure.partition = {status: 'unsupported_shape'};
    const partialRecorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: partialRecorder}, event(partial))).toBeDefined();
    expect(partialRecorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: {structure: {
      collections: {claims: {status: 'null'}, bodyParts: {status: 'missing'}}}}});
  });

  it.each(['other_tool', 'no_tool'] as const)('records %s wire transport without final-document structure', wireToolRole => {
    const value = {...material(), wireToolRole, json: {status: 'not_parsed'}, representation: 'not_applicable',
      structure: {status: 'not_applicable'}};
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: value});
  });

  it('accepts interrupted lower-bound counts without making EOF or parse facts', () => {
    const value = {...material(), transport: {doneSeen: false, eofSeen: false, framing: 'unknown'},
      decoded: {arguments: {utf8Bytes: 1048577, utf16Chars: 1048577, utf8Precision: 'lower_bound', utf16Precision: 'lower_bound'}},
      retention: {arguments: {status: 'over_limit', retainedUtf8Bytes: 1000}, companion: {status: 'not_observed', retainedUtf8Bytes: 0},
        refusal: {status: 'not_observed', retainedUtf8Bytes: 0}, combinedRetainedUtf8Bytes: 1000},
      json: {status: 'not_parsed'}, representation: 'unknown', structure: {status: 'not_observed'}};
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: value});
  });

  it('keeps genuine empty arrays and empty text counts as measured zero', () => {
    const value = mutable(material()), structure = at(value, ['structure']);
    at(structure, ['collections']).claims = {status: 'array', items: 0};
    at(structure, ['collections']).bodyParts = {status: 'array', items: 0};
    for (const path of paths(structure, 'number')) at(structure, path.slice(0, -1))[path[path.length - 1]] = 0;
    structure.explicitNullCount = 1;
    structure.partition = {status: 'measured', totalNormalizedUtf8Bytes: 400, referenceDictionary: 2, semanticFrames: 2,
      claims: 2, bodyParts: 2, contractOther: 20, overhead: 372};
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: {structure: {
      collections: {claims: {status: 'array', items: 0}}, claimKinds: {absent: 0, unclassified: 0}}}});
  });

  it('rejects an unknown private key at every material object boundary', () => {
    for (const path of paths(mutable(material()), 'object')) {
      const value = mutable(material()); at(value, path).privatePayload = 'PRIVATE_R11_MATERIAL_CANARY'; dropped(value);
    }
  });

  it('rejects each non-safe count independently at every numeric material leaf', () => {
    for (const path of paths(mutable(material()), 'number')) for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
      const value = mutable(material()); at(value, path.slice(0, -1))[path[path.length - 1]] = invalid; dropped(value);
    }
    for (const invalid of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) dropped(material(), invalid);
  });

  it('rejects inconsistent conditional facts instead of filling missing material with zero', () => {
    const changes: Array<(value: Record<string, unknown>) => void> = [
      value => {at(value, ['retention']).combinedRetainedUtf8Bytes = 999;},
      value => {at(value, ['retention', 'companion']).retainedUtf8Bytes = 1; at(value, ['retention']).combinedRetainedUtf8Bytes = 1001;},
      value => {at(value, ['transport']).eofSeen = false;},
      value => {at(value, ['transport']).framing = 'invalid';},
      value => {at(value, ['retention', 'arguments']).status = 'over_limit';},
      value => {at(value, ['decoded', 'arguments']).utf8Precision = 'lower_bound';},
      value => {at(value, ['decoded', 'arguments']).utf8Bytes = 999;},
      value => {at(value, ['json']).status = 'not_parsed';},
      value => {value.representation = 'unknown';},
      value => {value.wireToolRole = 'ambiguous';},
      value => {delete at(value, ['structure']).claimKinds;},
      value => {at(value, ['structure', 'claimKinds']).absent = 0;},
      value => {at(value, ['structure', 'claimKinds', 'counts']).made_up = 0;},
      value => {delete at(value, ['structure', 'claimKinds', 'counts']).numeric;},
      value => {delete at(value, ['structure']).bodyParts;},
      value => {at(value, ['structure', 'bodyParts']).unclassifiedPartCount = 0;},
      value => {at(value, ['structure', 'bodyParts']).literalPartCount = 0; at(value, ['structure', 'bodyParts']).unclassifiedPartCount = 2;},
      value => {at(value, ['structure', 'exactTextReuse']).duplicateClaimTextCount = 3;},
      value => {at(value, ['structure', 'exactTextReuse']).literalPartMatchingClaimTextCount = 2;},
      value => {at(value, ['structure', 'exactTextReuse']).literalPartMatchingClaimTextUtf8Bytes = 7;},
      value => {at(value, ['structure', 'partition']).overhead = 177;},
      value => {at(value, ['structure', 'collections']).referenceDictionary = {status: 'missing'};},
      value => {at(value, ['structure']).status = 'resource_limit';},
    ];
    for (const change of changes) {const value = mutable(material()); change(value); dropped(value);}
  });

  it('rejects impossible measured node counts and disjoint collection totals', () => {
    const cases: Array<(value: Record<string, unknown>) => void> = [
      value => {at(value, ['structure', 'collections', 'referenceDictionary']).items = TYPED_OUTPUT_MATERIAL_LIMITS.structureNodes + 1;},
      value => {at(value, ['structure']).explicitNullCount = TYPED_OUTPUT_MATERIAL_LIMITS.structureNodes + 1;},
      value => {
        at(value, ['structure', 'collections', 'referenceDictionary']).items = 6000;
        at(value, ['structure', 'collections', 'semanticFrames']).items = 6000;
      },
    ];
    for (const change of cases) {
      const value = mutable(material()); at(value, ['structure']).partition = {status: 'unsupported_shape'};
      change(value); dropped(value);
    }
  });

  it('rejects decoded domain overflow and an exact saturation sentinel independently of JSON parsing', () => {
    for (const channel of ['arguments', 'companion', 'refusal']) for (const dimension of ['utf8Bytes', 'utf16Chars']) {
      const cap = dimension === 'utf8Bytes' ? TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes : TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf16Chars;
      const precision = dimension === 'utf8Bytes' ? 'utf8Precision' : 'utf16Precision';
      for (const [count, accuracy] of [[cap + 1, 'exact'], [cap + 2, 'lower_bound'], [1_000_000_000, 'exact']] as const) {
        const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
        at(value, ['retention'])[channel] = {status: 'not_retained', retainedUtf8Bytes: 0};
        at(value, ['retention']).combinedRetainedUtf8Bytes = channel === 'arguments' ? 0 : 1000;
        at(value, ['decoded'])[channel] = {utf8Bytes: 1, utf16Chars: 1, utf8Precision: 'lower_bound', utf16Precision: 'lower_bound', [dimension]: count, [precision]: accuracy};
        dropped(value);
      }
    }
  });

  it('rejects retained bytes beyond their independent domain and combined retained overflow', () => {
    for (const channel of ['arguments', 'companion', 'refusal']) {
      const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
      at(value, ['decoded'])[channel] = {utf8Bytes: TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes + 1,
        utf16Chars: TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf16Chars, utf8Precision: 'lower_bound', utf16Precision: 'exact'};
      at(value, ['retention'])[channel] = {status: 'over_limit', retainedUtf8Bytes: TYPED_OUTPUT_MATERIAL_LIMITS.retainedUtf8Bytes + 1};
      at(value, ['retention']).combinedRetainedUtf8Bytes = TYPED_OUTPUT_MATERIAL_LIMITS.retainedUtf8Bytes + 1 + (channel === 'arguments' ? 0 : 1000);
      dropped(value);
    }
    const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
    for (const channel of ['arguments', 'companion']) {
      at(value, ['decoded'])[channel] = {utf8Bytes: 600000, utf16Chars: 600000, utf8Precision: 'exact', utf16Precision: 'exact'};
      at(value, ['retention'])[channel] = {status: 'complete', retainedUtf8Bytes: 600000};
    }
    at(value, ['retention']).combinedRetainedUtf8Bytes = 1200000; dropped(value);
  });

  it('bounds measured text bytes and normalized outer partition independently from wire retention', () => {
    for (const path of [['bodyParts', 'literalPartTextUtf8Bytes'], ['exactTextReuse', 'duplicateClaimTextUtf8Bytes'],
      ['exactTextReuse', 'literalPartMatchingClaimTextUtf8Bytes']]) {
      const value = mutable(material());
      at(value, ['structure', ...path.slice(0, -1)])[path[path.length - 1]] = TYPED_OUTPUT_MATERIAL_LIMITS.normalizedDocumentUtf8Bytes + 1;
      if (path[1] === 'literalPartMatchingClaimTextUtf8Bytes') at(value, ['structure', 'bodyParts']).literalPartTextUtf8Bytes = TYPED_OUTPUT_MATERIAL_LIMITS.normalizedDocumentUtf8Bytes + 1;
      dropped(value);
    }
    const value = mutable(material()), partition = at(value, ['structure', 'partition']);
    const next = TYPED_OUTPUT_MATERIAL_LIMITS.normalizedOuterUtf8Bytes + 1;
    partition.overhead = Number(partition.overhead) + next - Number(partition.totalNormalizedUtf8Bytes);
    partition.totalNormalizedUtf8Bytes = next; dropped(value);
  });

  it('records real three-byte text with saturated UTF8 and still-exact UTF16 counts', () => {
    const text = '中'.repeat(Math.ceil((TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes + 1) / 3));
    expect(Buffer.byteLength(text)).toBeGreaterThan(TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes);
    expect(text.length).toBeLessThan(TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf16Chars);
    const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
    at(value, ['decoded']).arguments = {utf8Bytes: TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes + 1,
      utf16Chars: text.length, utf8Precision: 'lower_bound', utf16Precision: 'exact'};
    at(value, ['retention']).arguments = {status: 'over_limit', retainedUtf8Bytes: 0};
    at(value, ['retention']).combinedRetainedUtf8Bytes = 0;
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({material: value});
  });

  it.each([
    {utf8Bytes: 3, utf16Chars: 4, utf8Precision: 'exact', utf16Precision: 'exact'},
    {utf8Bytes: 4, utf16Chars: 1, utf8Precision: 'exact', utf16Precision: 'exact'},
    {utf8Bytes: 1000, utf16Chars: TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf16Chars + 1, utf8Precision: 'exact', utf16Precision: 'lower_bound'},
    {utf8Bytes: TYPED_OUTPUT_MATERIAL_LIMITS.decodedUtf8Bytes + 1, utf16Chars: 1000, utf8Precision: 'lower_bound', utf16Precision: 'exact'},
  ])('rejects physically impossible cross-axis decoded facts: %j', decoded => {
    const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
    at(value, ['decoded']).arguments = decoded;
    at(value, ['retention']).arguments = {status: 'over_limit', retainedUtf8Bytes: 0};
    at(value, ['retention']).combinedRetainedUtf8Bytes = 0;
    dropped(value);
  });

  it('does not infer an ordering between two incomplete lower bounds', () => {
    for (const [utf8Bytes, utf16Chars] of [[1000, 2000], [4000, 1000]]) {
      const value = mutable(material()); value.json = {status: 'not_parsed'}; value.representation = 'unknown'; value.structure = {status: 'not_observed'};
      at(value, ['decoded']).arguments = {utf8Bytes, utf16Chars, utf8Precision: 'lower_bound', utf16Precision: 'lower_bound'};
      at(value, ['retention']).arguments = {status: 'over_limit', retainedUtf8Bytes: 0};
      at(value, ['retention']).combinedRetainedUtf8Bytes = 0;
      const recorder = createRuntimePerformanceRecorder();
      expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    }
  });

  it('accepts a real normalized outer boundary above wire cap when lone-surrogate escaping accounts for the difference', () => {
    const document = {representationVersion: 'authored_claim_document@2', referenceDictionary: [], semanticFrames: [],
      contract: {claims: []}, bodyParts: ['\ud800'.repeat(5)]};
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    document.bodyParts[0] += 'x'.repeat(TYPED_OUTPUT_MATERIAL_LIMITS.normalizedDocumentUtf8Bytes - bytes(document));
    const normalized = JSON.stringify({document});
    // JSON permits the literal lone surrogate; the normalized serializer escapes it.
    const raw = normalized.split('\\ud800').join('\ud800');
    expect(JSON.parse(raw)).toEqual({document});
    expect(bytes(document)).toBe(TYPED_OUTPUT_MATERIAL_LIMITS.normalizedDocumentUtf8Bytes);
    expect(Buffer.byteLength(raw)).toBeLessThan(TYPED_OUTPUT_MATERIAL_LIMITS.retainedUtf8Bytes);
    expect(Buffer.byteLength(normalized)).toBe(TYPED_OUTPUT_MATERIAL_LIMITS.normalizedOuterUtf8Bytes);
    const buckets = {referenceDictionary: bytes(document.referenceDictionary), semanticFrames: bytes(document.semanticFrames),
      claims: bytes(document.contract.claims), bodyParts: bytes(document.bodyParts), contractOther: bytes({})};
    const value: RuntimeTypedOutputMaterial = {schemaVersion: 'typed_output_material@1', wireToolRole: 'final_role',
      transport: {doneSeen: true, eofSeen: true, framing: 'valid'},
      decoded: {arguments: {utf8Bytes: Buffer.byteLength(raw), utf16Chars: raw.length, utf8Precision: 'exact', utf16Precision: 'exact'}},
      retention: {arguments: {status: 'complete', retainedUtf8Bytes: Buffer.byteLength(raw)},
        companion: {status: 'not_observed', retainedUtf8Bytes: 0}, refusal: {status: 'not_observed', retainedUtf8Bytes: 0},
        combinedRetainedUtf8Bytes: Buffer.byteLength(raw)},
      json: {status: 'complete_json'}, representation: 'authored_claim_document@2',
      structure: {status: 'measured', collections: {referenceDictionary: {status: 'array', items: 0},
        semanticFrames: {status: 'array', items: 0}, claims: {status: 'array', items: 0}, bodyParts: {status: 'array', items: 1},
        relationProposals: {status: 'missing'}, sourceClaimBindings: {status: 'missing'}},
        claimKinds: {counts: Object.fromEntries(CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => [kind, 0])) as
          Record<typeof CONCLUSION_PROTOCOL_VALUES.claimKind[number], number>, absent: 0, unclassified: 0},
        bodyParts: {literalPartCount: 1, literalPartTextUtf8Bytes: Buffer.byteLength(document.bodyParts[0]),
          claimTextUseCount: 0, unclassifiedPartCount: 0}, explicitNullCount: 0,
        exactTextReuse: {duplicateClaimTextCount: 0, duplicateClaimTextUtf8Bytes: 0,
          literalPartMatchingClaimTextCount: 0, literalPartMatchingClaimTextUtf8Bytes: 0},
        partition: {status: 'measured', ...buckets, totalNormalizedUtf8Bytes: Buffer.byteLength(normalized),
          overhead: Buffer.byteLength(normalized) - Object.values(buckets).reduce((sum, count) => sum + count, 0)}}};
    const recorder = createRuntimePerformanceRecorder();
    expect(recordRuntimeFinalTransportEvent({runtimePerformanceRecorder: recorder}, event(value))).toBeDefined();
    expect(projectRuntimeFinalTransportObservation(recorder.seal().finalTransportObservation)).toEqual(recorder.seal().finalTransportObservation);
  });

  it('requires observed exact channel counts for complete retention even when JSON was not parsed', () => {
    const changes: Array<(value: Record<string, unknown>) => void> = [
      value => {delete at(value, ['decoded']).arguments;},
      value => {at(value, ['decoded', 'arguments']).utf8Precision = 'lower_bound';},
      value => {at(value, ['decoded', 'arguments']).utf16Precision = 'lower_bound';},
      value => {at(value, ['decoded', 'arguments']).utf8Bytes = 1001;},
    ];
    for (const change of changes) {
      const value = mutable(material()); value.json = {status: 'not_parsed'};
      value.representation = 'unknown'; value.structure = {status: 'not_observed'};
      change(value); dropped(value);
    }
  });

  it('requires an actually counted channel for not_retained instead of inventing an absent zero', () => {
    const value = mutable(material()); delete at(value, ['decoded']).companion; dropped(value);
  });

  it('does not execute material getters/proxy traps and makes invalid observations drops only', () => {
    const getter = jest.fn(() => material());
    const value = Object.defineProperty({}, 'schemaVersion', {enumerable: true, get: getter});
    dropped(value); expect(getter).not.toHaveBeenCalled();
    const trap = jest.fn();
    dropped(new Proxy({}, {ownKeys: () => {trap(); return [];}})); expect(trap).not.toHaveBeenCalled();
  });

  it('counts explicit unbound/conflicting observation drops only while collecting, leaving sealed receipts unchanged', () => {
    const drop = dropRuntimeFinalTransportObservation;
    const recorder = createRuntimePerformanceRecorder(); const source = {runtimePerformanceRecorder: recorder};
    drop(source); drop(source);
    expect(recorder.seal().finalTransportObservation).toEqual({schemaVersion: 'final_transport_observation@1', events: [], truncated: 2});
    const before = JSON.stringify(recorder.seal());
    expect(() => drop(source)).not.toThrow();
    expect(recordRuntimeFinalTransportEvent(source, event())).toBeUndefined();
    expect(JSON.stringify(recorder.seal())).toBe(before);
  });
});


describe('R11 Stage B exact typed issued implementation tuples', () => {
  function issued(tuple: Record<string, unknown>): RuntimeFinalTransportEventInput {
    return {kind: 'typed_issued_after_drain', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      responseKey: 'c'.repeat(64), callKey: 'd'.repeat(64), actualModel: {status: 'observed', hash: 'e'.repeat(64)},
      nativeStatus: 'completed', drainStatus: 'fulfilled', nativeBodyHash: 'f'.repeat(64), ...tuple} as unknown as RuntimeFinalTransportEventInput;
  }
  it.each(['openai_typed_final_admission@1', 'openai_typed_final_admission@2'] as const)('preserves historical %s bytes without manufacturing wire observations', admission => {
    const {wireVersion: _wire, ...tuple} = OPENAI_TYPED_FINAL_CONTRACTS[admission];
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.recordFinalTransportEvent(issued(tuple))).toBeDefined();
    const receipt = recorder.seal().finalTransportObservation!;
    expect(receipt.events[0]).not.toHaveProperty('wireVersion');
    expect(projectRuntimeFinalTransportObservation(receipt)).toEqual(receipt);
  });
  it('requires and preserves the actual mixed admission3/wire2 tuple', () => {
    const recorder = createRuntimePerformanceRecorder();
    const input = issued(OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']);
    expect(recorder.recordFinalTransportEvent(input)).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject(input);
    expect(projectRuntimeFinalTransportObservation(recorder.seal().finalTransportObservation)).toEqual(recorder.seal().finalTransportObservation);
  });
  it.each(['missing_wire', 'old_wire', 'wrong_compiler', 'unknown_admission', 'extra'])(
    'does not accept an incomplete or contradictory mixed tuple: %s', mutation => {
      const tuple: Record<string, unknown> = {...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
      if (mutation === 'missing_wire') delete tuple.wireVersion;
      if (mutation === 'old_wire') tuple.wireVersion = 'openai_chat_final_wire@1';
      if (mutation === 'wrong_compiler') tuple.compilerVersion = 'authored_claim_document_compiler@1';
      if (mutation === 'unknown_admission') tuple.admissionVersion = 'openai_typed_final_admission@4';
      if (mutation === 'extra') tuple.privatePayload = 'PRIVATE';
      const recorder = createRuntimePerformanceRecorder();
      expect(recorder.recordFinalTransportEvent(issued(tuple))).toBeUndefined();
      expect(recorder.seal().finalTransportObservation?.truncated).toBe(1);
    });
  it.each(['openai_typed_final_admission@1', 'openai_typed_final_admission@2'] as const)('preserves explicitly observed old wire1 for %s', admission => {
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.recordFinalTransportEvent(issued(OPENAI_TYPED_FINAL_CONTRACTS[admission]))).toBeDefined();
    expect(recorder.seal().finalTransportObservation?.events[0]).toMatchObject({wireVersion: 'openai_chat_final_wire@1'});
  });
  it.each([
    {representationVersion: 'authored_claim_document@1', compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@1'},
    {representationVersion: 'authored_claim_document@2', compilerVersion: 'authored_claim_document_compiler@1', admissionVersion: 'openai_typed_final_admission@2'},
    {representationVersion: 'authored_claim_document@2', compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@1'},
    {representationVersion: 'authored_claim_document@1', compilerVersion: 'authored_claim_document_compiler@1', admissionVersion: 'openai_typed_final_admission@2'},
  ])('rejects a Cartesian-product tuple even though all its version strings are individually known: %j', tuple => {
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.recordFinalTransportEvent(issued(tuple))).toBeUndefined();
    expect(recorder.seal().finalTransportObservation).toEqual({schemaVersion: 'final_transport_observation@1', events: [], truncated: 1});
  });
});


describe('R13 assistant document observation schema', () => {
  function assistantIssued(): RuntimeFinalTransportEventInput {
    return {kind: 'assistant_document_issued_after_drain', sourceKind: 'assistant_json', attemptKey: 'a'.repeat(64), logicalCallKey: 'b'.repeat(64),
      responseKey: 'c'.repeat(64), messageKey: 'c'.repeat(64), nativeTerminalEventKey: 'd'.repeat(64), rawAssistantTextHash: 'e'.repeat(64),
      compiledBodyHash: 'f'.repeat(64), nativeCandidateKey: '1'.repeat(64), actualModel: {status: 'observed', hash: '2'.repeat(64)},
      nativeStatus: 'completed', drainStatus: 'fulfilled', representationVersion: 'authored_claim_document@2',
      compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@4', wireVersion: 'openai_chat_final_wire@3'};
  }
  it('records the disjoint assistant source without inventing function identity or material', () => {
    const recorder = createRuntimePerformanceRecorder();
    const key = recorder.recordFinalTransportEvent(assistantIssued());
    expect(key).toBeDefined();
    expect(recorder.recordFinalTransportEvent({kind: 'candidate_retained', nativeCandidateKey: '1'.repeat(64), carrier: 'assistant_document',
      transform: 'native', authors: [{role: 'body_and_declaration', terminalEventKey: key!}], declaredBody: 'present', declaredClaims: 'present', productStatus: 'completed'})).toBeDefined();
    const result = recorder.seal().finalTransportObservation!;
    expect(projectRuntimeFinalTransportObservation(result)).toEqual(result);
    expect(result.events[0]).not.toHaveProperty('callKey');
    expect(result.events[0]).not.toHaveProperty('rawArguments');
    expect(result.events[0]).not.toHaveProperty('material');
  });
  it('drops every missing required source field and all function-only or private additions', () => {
    const source = assistantIssued() as unknown as Record<string, unknown>;
    for (const field of Object.keys(source)) {
      const input = {...source}; delete input[field];
      const recorder = createRuntimePerformanceRecorder();
      expect(recorder.recordFinalTransportEvent(input as unknown as RuntimeFinalTransportEventInput)).toBeUndefined();
      expect(recorder.seal().finalTransportObservation?.truncated).toBe(1);
    }
    for (const field of ['callKey', 'rawArguments', 'rawAssistantText', 'handlerAck']) {
      const recorder = createRuntimePerformanceRecorder();
      expect(recorder.recordFinalTransportEvent({...source, [field]: 'PRIVATE'} as unknown as RuntimeFinalTransportEventInput)).toBeUndefined();
      expect(JSON.stringify(recorder.seal())).not.toContain('PRIVATE');
    }
  });
  it.each([{sourceKind: 'function'}, {messageKey: '9'.repeat(64)}, {nativeStatus: 'failed'}, {drainStatus: 'rejected'},
    {admissionVersion: 'openai_typed_final_admission@3'}, {wireVersion: 'openai_chat_final_wire@2'},
    {compilerVersion: 'authored_claim_document_compiler@1'}, {nativeTerminalEventKey: ''}])('rejects contradictory assistant facts: %j', mutation => {
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.recordFinalTransportEvent({...assistantIssued(), ...mutation} as RuntimeFinalTransportEventInput)).toBeUndefined();
  });
});

import * as t0Runtime from '../runtimePerformance';
import * as t0Implementation from '../finalSubmissionImplementation';
import {canonicalContentHash as t0ContentHash} from '../../services/selfEvolution/canonicalJson';

/** Synthetic schema fixtures only: neither a private issuer nor an execution capability. */
const t0QuoteTuple = {representationVersion: 'authored_claim_document@3', compilerVersion: 'authored_claim_document_compiler@3',
  admissionVersion: 'openai_typed_final_admission@5', wireVersion: 'openai_chat_final_wire@4'} as const;
const t0QuoteRenderer = 'program_evidence_quote_render@1';
const t0QuoteMode = 'authored_claim_document_v3_quotes';
const t0H = (value: string) => runtimeObservationHash(value);
function t0PrivateCore(adoption: Record<string, unknown>) {
  return {schemaVersion: 'program_quote_issuer_core@1', ownerBindingHash: adoption.ownerBindingHash,
    implementation: {...t0QuoteTuple, rendererVersion: adoption.rendererVersion},
    nativeIdentity: {source: adoption.actualNativeSource, dispatchOrdinal: adoption.collectorDispatchOrdinal,
      responseKey: adoption.responseKey, ...(adoption.actualNativeSource === 'assistant_json'
        ? {messageKey: adoption.messageKey} : {callKey: adoption.callKey})},
    rawSourceIdentity: {utf16Hash: adoption.rawSourceUtf16Hash, utf8Hash: adoption.rawSourceUtf8Hash, utf16Length: adoption.rawSourceUtf16Length},
    bodyHash: adoption.bodyHash, provenanceHash: adoption.provenanceHash, nativeCandidateKey: adoption.nativeCandidateKey,
    componentCount: adoption.componentCount, renderedComponentCount: adoption.renderedComponentCount,
    unavailableComponentCount: adoption.unavailableComponentCount, quotedCellOccurrences: adoption.quotedCellOccurrences,
    independentClaimCount: adoption.independentClaimCount};
}
function t0QuoteAdoption(source: 'function_arguments' | 'assistant_json' = 'assistant_json', count = 1) {
  const adoption: Record<string, unknown> = {schemaVersion: 'program_quote_adoption@1', status: 'issued', ...t0QuoteTuple,
    rendererVersion: t0QuoteRenderer, ownerBindingHash: t0H('owner'), actualNativeSource: source,
    httpRequestKey: t0H('http-ticket'), collectorDispatchOrdinal: 2, responseKey: t0H('response'), nativeTerminalEventKey: t0H('native-event'),
    rawSourceUtf16Hash: t0H('utf16-source'), rawSourceUtf8Hash: t0H('utf8-source'), rawSourceUtf16Length: 100,
    nativeCandidateKey: t0H('candidate'), bodyHash: t0H('body'), provenanceHash: t0H('semantic-provenance'),
    actualModel: {status: 'observed', hash: t0H('model')}, nativeStatus: 'completed', drainStatus: 'fulfilled',
    componentCount: count, renderedComponentCount: count, unavailableComponentCount: 0, quotedCellOccurrences: count * 2, independentClaimCount: 1,
    ...(source === 'assistant_json' ? {messageKey: t0H('response')} : {callKey: t0H('call')})};
  adoption.issuerLineageHash = t0ContentHash(t0PrivateCore(adoption));
  return {kind: 'program_quote_adoption', attemptKey: t0H('attempt'), logicalCallKey: t0H('logical'), adoption};
}
function t0QuoteEnvelope(payload: unknown, version = 'final_transport_observation@2') {
  const event = {...payload as Record<string, unknown>, sequence: 1, offsetMs: 0};
  return {schemaVersion: version, events: [{...event, eventKey: t0ContentHash(event)}], truncated: 0};
}
function t0RecordQuote(recorder: ReturnType<typeof createRuntimePerformanceRecorder>, input: unknown) {
  const method = (recorder as unknown as {recordQuoteTransportEvent?: (input: unknown) => string | undefined}).recordQuoteTransportEvent;
  expect(typeof method).toBe('function');
  return method!.call(recorder, input);
}

describe('R15 T0 quote observation contracts remain independent from active mode policy', () => {
  it('adds a closed observed descriptor while leaving configuration activation off', () => {
    const api = t0Implementation as unknown as {getObservedFinalSubmissionModeDescriptor?: (value: unknown) => unknown;
      getObservedOpenAiTypedFinalContractIdentity?: (value: unknown) => unknown};
    expect(typeof api.getObservedOpenAiTypedFinalContractIdentity).toBe('function');
    expect(api.getObservedOpenAiTypedFinalContractIdentity!('openai_typed_final_admission@5')).toEqual(t0QuoteTuple);
    expect(t0Implementation.getOpenAiTypedFinalContractIdentity('openai_typed_final_admission@5')).toBeUndefined();
    expect(Object.keys(t0Implementation.OPENAI_TYPED_FINAL_CONTRACTS)).toHaveLength(4);
    expect(typeof api.getObservedFinalSubmissionModeDescriptor).toBe('function');
    expect(api.getObservedFinalSubmissionModeDescriptor!(t0QuoteMode)).toEqual({kind: 'typed', requiredDeclarationSyntax: 'authoring_v2',
      sourcePolicy: 'function_or_assistant_json', ...t0QuoteTuple, rendererVersion: t0QuoteRenderer});
    expect(t0Implementation.getFinalSubmissionModeDescriptor(t0QuoteMode)).toBeUndefined();
    expect(t0Implementation.isAuthoredFinalSubmissionMode(t0QuoteMode)).toBe(false);
    expect(api.getObservedFinalSubmissionModeDescriptor!('authored_claim_document_v3')).toBeUndefined();
    expect(api.getObservedFinalSubmissionModeDescriptor!(null)).toBeUndefined();
  });

  it('can record requested v3 controls without manufacturing an issued observation', () => {
    const controls = buildRuntimeAppliedModelControls({requestedOutput: {finalSubmission: t0QuoteMode, declarationSyntax: 'authoring_v2'} as
      unknown as Parameters<typeof buildRuntimeAppliedModelControls>[0]['requestedOutput'], commonConfig: {model: 'fixture'}, appliedSettings: {store: false}});
    expect(controls).toHaveProperty('requestedOutput.finalSubmission', t0QuoteMode);
    expect(controls).not.toHaveProperty('adoption');
  });

  it.each(['function_arguments', 'assistant_json'] as const)('preserves the exact issued %s contract in a new envelope', source => {
    const event = t0QuoteAdoption(source), recorder = createRuntimePerformanceRecorder({now: () => 1});
    expect(t0RecordQuote(recorder, event)).toMatch(/^[a-f0-9]{64}$/);
    const sealed = recorder.seal().finalTransportObservation;
    expect(sealed).toMatchObject({schemaVersion: 'final_transport_observation@2', events: [expect.objectContaining(event)], truncated: 0});
    expect(projectRuntimeFinalTransportObservation(sealed)).toEqual(sealed);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toMatch(/rawArguments|rawAssistantText|presentationOrigin|verified|token/);
  });

  it('keeps zero components as an observed valid representation, with zero actual quoted cells', () => {
    const payload = t0QuoteAdoption('assistant_json', 0), value = t0QuoteEnvelope(payload);
    expect(projectRuntimeFinalTransportObservation(value)).toEqual(value);
    expect(payload.adoption).toMatchObject({status: 'issued', componentCount: 0, renderedComponentCount: 0,
      unavailableComponentCount: 0, quotedCellOccurrences: 0, independentClaimCount: 1});
  });

  it('does not promote new kinds or the new tuple through the old envelope and issued kind', () => {
    expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope(t0QuoteAdoption(), 'final_transport_observation@1'))).toBeUndefined();
    const recorder = createRuntimePerformanceRecorder();
    expect(recorder.recordFinalTransportEvent({kind: 'typed_issued_after_drain', attemptKey: t0H('attempt'), logicalCallKey: t0H('logical'),
      responseKey: t0H('response'), callKey: t0H('call'), nativeBodyHash: t0H('body'), actualModel: {status: 'observed', hash: t0H('model')},
      nativeStatus: 'completed', drainStatus: 'fulfilled', ...t0QuoteTuple} as unknown as RuntimeFinalTransportEventInput)).toBeUndefined();
    expect(recorder.seal().finalTransportObservation).toMatchObject({schemaVersion: 'final_transport_observation@1', events: [], truncated: 1});
  });

  it('rejects every missing issued field after valid outer-event rehashing', () => {
    for (const field of Object.keys(t0QuoteAdoption().adoption)) {
      const value = t0QuoteAdoption(); delete value.adoption[field];
      expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope(value))).toBeUndefined();
    }
    for (const field of ['privateText', 'rawArguments', 'rawAssistantText', 'presentationOrigin', 'proof']) {
      const value = t0QuoteAdoption(); value.adoption[field] = 'PRIVATE_CANARY';
      expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope(value))).toBeUndefined();
    }
  });

  it.each([
    {representationVersion: 'authored_claim_document@2'}, {compilerVersion: 'authored_claim_document_compiler@2'},
    {admissionVersion: 'openai_typed_final_admission@4'}, {wireVersion: 'openai_chat_final_wire@3'}, {rendererVersion: 'program_evidence_quote_render@2'},
    {actualNativeSource: 'requested'}, {messageKey: t0H('other-response')}, {callKey: t0H('fake-call')},
    {componentCount: -1}, {componentCount: 10001}, {componentCount: 1.5}, {renderedComponentCount: 2},
    {unavailableComponentCount: 1}, {componentCount: 0, renderedComponentCount: 0, quotedCellOccurrences: 1},
    {independentClaimCount: Number.MAX_SAFE_INTEGER + 1}, {collectorDispatchOrdinal: 0}, {nativeStatus: 'failed'}, {drainStatus: 'rejected'},
  ])('rejects a contradictory closed quote payload: %j', mutation => {
    const event = t0QuoteAdoption(); Object.assign(event.adoption, mutation);
    expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope(event))).toBeUndefined();
  });

  it('retains a truthful not-issued fact without inventing zero counts or observation failure as execution failure', () => {
    const event = {kind: 'program_quote_adoption', attemptKey: t0H('attempt'), logicalCallKey: t0H('logical'),
      adoption: {schemaVersion: 'program_quote_adoption@1', status: 'not_issued', reason: 'composition_rejected', actualNativeSource: 'assistant_json'}};
    expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope(event))).toEqual(t0QuoteEnvelope(event));
    for (const extra of [{componentCount: 0}, {issuerLineageHash: t0H('made-up')}, {reason: 'observation_unavailable'}]) {
      expect(projectRuntimeFinalTransportObservation(t0QuoteEnvelope({...event, adoption: {...event.adoption, ...extra}}))).toBeUndefined();
    }
  });

  it('projects native facts without upgrading unknown request or native completion into adoption', () => {
    const event = {kind: 'quote_native_terminal', fact: {attemptKey: t0H('attempt'), logicalCallKey: t0H('logical'),
      response: {status: 'observed', hash: t0H('response')}, actualModel: {status: 'unknown'}, nativeStatus: 'unknown', finish: 'unknown',
      rawMaterial: {status: 'unknown'}, nativeContract: 'openai_native_completion_observer@1', sdkStreamCompleted: false},
      drainStatus: 'unavailable', actualNativeSource: {status: 'unknown'}, producingRequest: {status: 'unknown'}, rawSourceIdentity: {status: 'unknown'}};
    const receipt = t0QuoteEnvelope(event);
    expect(projectRuntimeFinalTransportObservation(receipt)).toEqual(receipt);
    expect(receipt.events[0]).not.toHaveProperty('adoption');
  });

  it('keeps private core commitment independent of observer-specific fields and leaves sealed evidence unchanged', () => {
    const event = t0QuoteAdoption(), core = t0PrivateCore(event.adoption), committed = t0ContentHash(core);
    Object.assign(event.adoption, {nativeTerminalEventKey: t0H('different-observer-parent'), httpRequestKey: t0H('different-observer-ticket'),
      actualModel: {status: 'observed', hash: t0H('different-observer-model')}});
    expect(t0PrivateCore(event.adoption)).toEqual(core); expect(event.adoption.issuerLineageHash).toBe(committed);
    const recorder = createRuntimePerformanceRecorder(); expect(t0RecordQuote(recorder, event)).toBeDefined();
    const before = JSON.stringify(recorder.seal());
    expect(t0RecordQuote(recorder, event)).toBeUndefined(); expect(JSON.stringify(recorder.seal())).toBe(before);
    expect(event.adoption.status).toBe('issued');
  });

  it('counts dropped observer evidence without changing the frozen source fixture to not-issued', () => {
    const original = t0QuoteAdoption(), snapshot = JSON.stringify(original);
    const recorder = createRuntimePerformanceRecorder({maxFinalTransportEvents: 1});
    expect(t0RecordQuote(recorder, original)).toBeDefined(); expect(t0RecordQuote(recorder, original)).toBeUndefined();
    expect(recorder.seal().finalTransportObservation).toMatchObject({schemaVersion: 'final_transport_observation@2', truncated: 1});
    expect(JSON.stringify(original)).toBe(snapshot); expect(original.adoption.status).toBe('issued');
  });

  it('does not execute accessor or proxy traps while observing quote payloads', () => {
    const getter = jest.fn(() => 'PRIVATE'), trap = jest.fn(() => [] as string[]);
    const event = t0QuoteAdoption(), envelope = t0QuoteEnvelope(event);
    Object.defineProperty(event.adoption, 'rawSourceUtf16Hash', {enumerable: true, get: getter});
    expect(projectRuntimeFinalTransportObservation(envelope)).toBeUndefined();
    const proxy = new Proxy({}, {ownKeys: trap});
    expect(projectRuntimeFinalTransportObservation({schemaVersion: 'final_transport_observation@2', events: proxy, truncated: 0})).toBeUndefined();
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });

  it('strictly retains quote review necessity while preserving the no-quote branch', () => {
    const project = (t0Runtime as unknown as {projectRuntimeFinalReviewReceipt?: (input: unknown) => unknown}).projectRuntimeFinalReviewReceipt;
    expect(typeof project).toBe('function');
    expect(project!({necessity: 'required', triggers: ['quote_context'], declaredClaimCount: 0}))
      .toEqual({necessity: 'required', triggers: ['quote_context'], declaredClaimCount: 0});
    expect(project!({necessity: 'not_required', triggers: [], declaredClaimCount: 0}))
      .toEqual({necessity: 'not_required', triggers: [], declaredClaimCount: 0});
    for (const value of [{necessity: 'not_required', triggers: ['quote_context'], declaredClaimCount: 0},
      {necessity: 'required', triggers: ['quote_context', 'quote_context'], declaredClaimCount: 0},
      {necessity: 'required', triggers: ['quote_context']}, {necessity: 'required', triggers: ['quote_context'], declaredClaimCount: -1},
      {necessity: 'required', triggers: ['unregistered'], declaredClaimCount: 1}]) expect(project!(value)).toBeUndefined();
  });

  it.each([{necessity: 'required', triggers: ['quote_context'], declaredClaimCount: -1},
    {necessity: 'required', triggers: ['quote_context']}, {necessity: 'not_required', triggers: ['quote_context'], declaredClaimCount: 0}])(
    'drops malformed quote review recording instead of turning unknown counts into zero: %j', input => {
      const recorder = createRuntimePerformanceRecorder();
      recordRuntimeFinalReview(recorder, input as unknown as Parameters<typeof recordRuntimeFinalReview>[1]);
      expect(recorder.seal().finalReview).toBeUndefined();
    });
  it('records a truthful zero-claim positive quote review without requiring a model claim', () => {
    const recorder = createRuntimePerformanceRecorder();
    recordRuntimeFinalReview(recorder, {necessity: 'required', triggers: ['quote_context'], declaredClaimCount: 0} as
      unknown as Parameters<typeof recordRuntimeFinalReview>[1]);
    expect(recorder.seal().finalReview).toEqual({necessity: 'required', triggers: ['quote_context'], declaredClaimCount: 0});
  });
});
