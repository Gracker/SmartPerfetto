// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import type { AnalysisOptions } from '../../agent/core/orchestratorTypes';
import type { RunManifestAttributionSink } from '../../types/selfEvolution';
import { buildComplexityClassifierInput } from '../../agentv3/queryComplexityContext';
import type { RuntimeSelection } from '../runtimeSelection';
import {
  formatTraceContext,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
} from '../runtimeCommon';
import { createAnalysisRunSpec, validateAnalysisRunSelection } from '../analysisRunSpec';
import {listProductionRuntimeKinds} from '../runtimeKinds';
import {CONCLUSION_AUTHORING_ENV} from '../../agent/core/conclusionAuthoring';
import {captureAnalysisOutputConfig, assertFinalSubmissionPreDispatch, assertFinalSubmissionRuntime,
  FinalSubmissionConfigurationError, SMARTPERFETTO_FINAL_SUBMISSION_ENV} from '../finalSubmissionConfig';
import {resolveModelExecutionProfile} from '../../services/providerManager/modelExecutionProfile';

const claudeSelection: RuntimeSelection = {
  kind: 'claude-agent-sdk',
  source: 'provider',
  providerId: 'provider-claude',
  providerName: 'Claude',
  providerType: 'anthropic',
};

const openAiSelection: RuntimeSelection = {
  kind: 'openai-agents-sdk',
  source: 'snapshot',
};

describe('captured final submission configuration', () => {
  const outputConfig = captureAnalysisOutputConfig({[SMARTPERFETTO_FINAL_SUBMISSION_ENV]: 'authored_claim_document_v1'});
  const sdk = {agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', contractVersion: 'openai_typed_final_admission@1'};
  const profile = (modelId = 'deepseek-flash', baseUrl = 'https://api.deepseek.com/v1') => resolveModelExecutionProfile({
    runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', modelId, baseUrl,
    sdk: {packageName: '@openai/agents-openai', version: '0.13.0', adapterContractVersion: sdk.contractVersion},
    sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', reasoningRoundtrip: 'supported', source: 'contract_test'},
    effective: outputConfig,
  });
  const admission = () => ({outputConfig, runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions' as const, sdk,
    modelSelection: {primaryModel: 'deepseek-flash', lightModel: 'deepseek-flash', requestedMode: 'auto' as const},
    modelProfiles: [profile()]});

  it('defaults off, freezes both captured choices and accepts legacy without experimental capabilities', () => {
    const env: Record<string, string | undefined> = {[CONCLUSION_AUTHORING_ENV]: 'authoring_v2'};
    const captured = captureAnalysisOutputConfig(env);
    env[CONCLUSION_AUTHORING_ENV] = 'canonical_v1';
    env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'authored_claim_document_v1';
    expect(captured).toEqual({finalSubmission: 'assistant_text', declarationSyntax: 'authoring_v2'});
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => assertFinalSubmissionPreDispatch({outputConfig: captured, runtimeKind: 'qoder-agent-sdk'})).not.toThrow();
  });

  it('reads each environment setting once and does not reflect an invalid syntax', () => {
    const reads = {mode: 0, syntax: 0};
    const env = {
      get [SMARTPERFETTO_FINAL_SUBMISSION_ENV]() {reads.mode++; return 'assistant_text';},
      get [CONCLUSION_AUTHORING_ENV]() {reads.syntax++; return 'canonical_v1';},
    };
    captureAnalysisOutputConfig(env);
    expect(reads).toEqual({mode: 1, syntax: 1});
    expect(() => captureAnalysisOutputConfig({[CONCLUSION_AUTHORING_ENV]: 'PRIVATE_SYNTAX_CANARY'}))
      .toThrow('invalid_configuration:final_submission:declaration_syntax');
  });

  it.each(['', ' authored_claim_document_v1', 'AUTHORED_CLAIM_DOCUMENT_V1', 'PRIVATE_CONFIG_CANARY'])(
    'rejects an invalid mode without echoing it: %s', value => {
      expect(() => captureAnalysisOutputConfig({[SMARTPERFETTO_FINAL_SUBMISSION_ENV]: value}))
        .toThrow('invalid_configuration:final_submission:mode');
    });

  it.each(['authoring_v1', 'authoring_v2'])('rejects conflicting %s before any dispatch', declarationSyntax => {
    expect(() => captureAnalysisOutputConfig({[SMARTPERFETTO_FINAL_SUBMISSION_ENV]: 'authored_claim_document_v1',
      [CONCLUSION_AUTHORING_ENV]: declarationSyntax})).toThrow('declaration_syntax_conflict');
  });

  it.each(['claude-agent-sdk', 'pi-agent-core', 'opencode', 'qoder-agent-sdk'])(
    'rejects typed submission on %s without consulting model configuration', runtimeKind => {
      expect(() => assertFinalSubmissionRuntime(outputConfig, runtimeKind))
        .toThrow('unsupported_final_submission:final_submission:runtime');
    });

  it('admits observed primitives only as experiment eligibility, without issuing adoption or completion', () => {
    expect(assertFinalSubmissionPreDispatch(admission())).toBeUndefined();
    expect(outputConfig).not.toHaveProperty('actualFinalSubmission');
    expect(outputConfig).not.toHaveProperty('completion');
  });

  it('rejects unknown protocols, SDKs and missing/mixed/duplicate model sets before a caller dispatches', () => {
    const valid = admission();
    const variants = [
      {...valid, protocol: 'responses' as const}, {...valid, sdk: undefined},
      {...valid, sdk: {...sdk, agentsCoreVersion: '0.14.0'}},
      {...valid, sdk: {...sdk, agentsOpenAiVersion: 'unknown'}},
      {...valid, sdk: {...sdk, contractVersion: 'unknown'}},
      {...valid, modelProfiles: []}, {...valid, modelProfiles: [profile(), profile()]},
      {...valid, modelSelection: {...valid.modelSelection, lightModel: 'glm-5.3-flash'},
        modelProfiles: [profile(), profile('glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4')]},
    ];
    const dispatch = jest.fn();
    for (const input of variants) {
      expect(() => {assertFinalSubmissionPreDispatch(input); dispatch();}).toThrow(FinalSubmissionConfigurationError);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('checks quick primary fallback and both auto choices, while explicit full needs only primary', () => {
    const valid = admission();
    const unknown = profile('unobserved-model');
    for (const requestedMode of ['auto', 'fast'] as const) {
      expect(() => assertFinalSubmissionPreDispatch({...valid,
        modelSelection: {...valid.modelSelection, requestedMode, primaryModel: 'unobserved-model'},
        modelProfiles: [unknown, profile()]})).toThrow('function_tool_primitive');
      expect(() => assertFinalSubmissionPreDispatch({...valid,
        modelSelection: {...valid.modelSelection, requestedMode, lightModel: 'unobserved-model'},
        modelProfiles: [profile(), unknown]})).toThrow('function_tool_primitive');
    }
    expect(() => assertFinalSubmissionPreDispatch({...valid,
      modelSelection: {...valid.modelSelection, requestedMode: 'full', lightModel: 'unobserved-model'}})).not.toThrow();
  });

  it('requires profiles to fingerprint the captured output choices', () => {
    const valid = admission();
    const wrong = {...profile(), effective: {finalSubmission: 'assistant_text' as const, declarationSyntax: 'canonical_v1' as const}};
    expect(() => assertFinalSubmissionPreDispatch({...valid, modelProfiles: [wrong]})).toThrow('model_set');
  });
});

describe('AnalysisRunSpec shadow mode', () => {
  it('uses only the captured output choices, not client fields, and records configuration rather than adoption', () => {
    const outputConfig = captureAnalysisOutputConfig({[SMARTPERFETTO_FINAL_SUBMISSION_ENV]: 'authored_claim_document_v1'});
    const recordRuntime = jest.fn();
    const sink = {identity: {runId: 'output-run', sessionId: 'output-session', scope: {tenantId: 't', workspaceId: 'w'}},
      recordScene: jest.fn(), recordMode: jest.fn(), recordRuntime} as unknown as RunManifestAttributionSink;
    const spec = createAnalysisRunSpec({outputConfig, query: 'Analyze', sessionId: 'output-session', traceId: 'trace',
      runtimeSelection: openAiSelection, sceneType: 'general', outputLanguage: 'en',
      options: {runManifestAttributionSink: sink, finalSubmission: 'assistant_text', declarationSyntax: 'authoring_v2'} as AnalysisOptions});
    expect(spec.finalSubmission).toBe('authored_claim_document_v1');
    expect(spec.declarationSyntax).toBe('canonical_v1');
    expect(recordRuntime).toHaveBeenCalledWith(expect.objectContaining({
      finalSubmission: 'authored_claim_document_v1', conclusionDeclarationSyntax: 'canonical_v1'}));
    expect(spec).not.toHaveProperty('actualFinalSubmission');
  });

  it.each(['authoring_v1', 'authoring_v2'] as const)('captures %s once and records that value without accepting client fields', syntax => {
    const previous = process.env[CONCLUSION_AUTHORING_ENV];
    const recordRuntime = jest.fn();
    const sink = {identity: {runId: 'syntax-run', sessionId: 'syntax-session', scope: {tenantId: 't', workspaceId: 'w'}},
      recordScene: jest.fn(), recordMode: jest.fn(), recordRuntime} as unknown as RunManifestAttributionSink;
    try {
      process.env[CONCLUSION_AUTHORING_ENV] = syntax;
      const outputConfig = captureAnalysisOutputConfig({[CONCLUSION_AUTHORING_ENV]: syntax});
      process.env[CONCLUSION_AUTHORING_ENV] = 'PRIVATE_INVALID_VALUE';
      const spec = createAnalysisRunSpec({outputConfig, query: 'Analyze', sessionId: 'syntax-session', traceId: 'trace',
        runtimeSelection: openAiSelection, sceneType: 'general', outputLanguage: 'en',
        options: {runManifestAttributionSink: sink, declarationSyntax: 'canonical_v1'} as AnalysisOptions});
      process.env[CONCLUSION_AUTHORING_ENV] = 'canonical_v1';
      expect(spec.declarationSyntax).toBe(syntax);
      expect(recordRuntime).toHaveBeenCalledWith(expect.objectContaining({conclusionDeclarationSyntax: syntax}));
      process.env[CONCLUSION_AUTHORING_ENV] = 'PRIVATE_INVALID_VALUE';
      expect(() => captureAnalysisOutputConfig(process.env))
        .toThrow('invalid_configuration:final_submission:declaration_syntax');
    } finally {
      if (previous === undefined) delete process.env[CONCLUSION_AUTHORING_ENV];
      else process.env[CONCLUSION_AUTHORING_ENV] = previous;
    }
  });
  it('captures shared identity, scope, trace, selection, and tool inputs without owning execution', () => {
    const options: AnalysisOptions = {
      providerId: 'provider-claude',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      runId: 'run-1',
      referenceTraceId: 'trace-ref',
      analysisMode: 'auto',
      selectionContext: {
        kind: 'area',
        startNs: 10,
        endNs: 20,
      },
      traceContext: [{
        label: 'Frame stats',
        columns: ['name', 'dur_ms'],
        rows: [['doFrame', 16.7]],
      }],
      codeAwareMode: 'provider_send',
      codebaseIds: ['app', 'app', 'lib'],
      knowledgeSourceIds: ['wiki-a', 'wiki-a', 'wiki-b'],
    };

    const spec = createAnalysisRunSpec({
      outputConfig: captureAnalysisOutputConfig({}),
      query: 'Compare this selected frame range',
      sessionId: 'session-1',
      traceId: 'trace-current',
      options,
      runtimeSelection: claudeSelection,
      sceneType: 'scrolling',
      outputLanguage: 'en',
      resolvedMode: 'full',
      budget: {
        model: 'claude-sonnet-4-6',
        lightModel: 'claude-haiku-4-5',
        maxTurns: 60,
        fullPathPerTurnMs: 60_000,
      },
    });

    expect(spec.identity).toEqual({
      sessionId: 'session-1',
      traceId: 'trace-current',
      referenceTraceId: 'trace-ref',
    });
    expect(spec.scopes.provider).toEqual(providerScopeFromAnalysisOptions(options));
    expect(spec.scopes.knowledge).toEqual(knowledgeScopeFromAnalysisOptions(options));
    expect(spec.traceContext).toEqual({
      datasetCount: 1,
      promptSection: formatTraceContext(options.traceContext, 'en'),
    });
    expect(spec.selection).toMatchObject({
      present: true,
      kind: 'area',
      sideResolution: {status: 'unknown'},
    });
    expect(spec.tools).toEqual({
      requestScope: {
        sessionId: 'session-1',
        hasCodebaseAccess: true,
      },
      codeAwareMode: 'provider_send',
      codebaseIds: ['app', 'lib'],
      knowledgeSourceIds: ['wiki-a', 'wiki-b'],
    });
    expect(spec.budget).toMatchObject({
      model: 'claude-sonnet-4-6',
      maxTurns: 60,
    });
  });

  it('freezes an exact single-trace selection and resolves only its current trace', () => {
    const selectionContext = {kind: 'track_event' as const, source: 'track_event_selection' as const,
      eventId: 7, ts: 42, dur: 9, trackUri: ' track://main '};
    const spec = createAnalysisRunSpec({outputConfig: captureAnalysisOutputConfig({}), query: 'selected event', sessionId: 'session', traceId: 'trace-current',
      options: {selectionContext}, runtimeSelection: openAiSelection, sceneType: 'general', outputLanguage: 'en'});
    expect(spec.selection).toEqual({present: true, kind: 'track_event', context: {
      kind: 'track_event', source: 'track_event_selection', eventId: 7, ts: 42, dur: 9, trackUri: 'track://main'},
    sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace-current'}});
    selectionContext.eventId = 99;
    expect(spec.selection.present && spec.selection.context.kind === 'track_event' && spec.selection.context.eventId).toBe(7);
    expect(Object.isFrozen(spec.selection)).toBe(true);
    expect(Object.isFrozen(spec.selection.present && spec.selection.context)).toBe(true);
  });

  it('keeps every paired or contradictory selection side unknown', () => {
    const pair = {schemaVersion: 1 as const, layout: 'horizontal' as const, primarySide: 'left' as const,
      referenceSide: 'right' as const, activeSide: 'right' as const, panes: [
        {side: 'left' as const, traceSide: 'current' as const, traceId: 'trace-current'},
        {side: 'right' as const, traceSide: 'reference' as const, traceId: 'trace-reference', active: true},
      ]};
    const selectionContext = {kind: 'track_event' as const, eventId: 7, ts: 42};
    const create = (referenceTraceId?: string, tracePairContext?: typeof pair) => createAnalysisRunSpec({
      outputConfig: captureAnalysisOutputConfig({}),
      query: 'selected event', sessionId: 'session', traceId: 'trace-current',
      options: {selectionContext, referenceTraceId, tracePairContext}, runtimeSelection: openAiSelection,
      sceneType: 'general', outputLanguage: 'en'}).selection;
    expect(create('trace-reference', pair)).toMatchObject({present: true, sideResolution: {status: 'unknown'}});
    expect(create(undefined, pair)).toMatchObject({present: true, sideResolution: {status: 'unknown'}});
    expect(create('trace-reference')).toMatchObject({present: true, sideResolution: {status: 'unknown'}});
  });

  it('retains only the optional slice locator hint without granting paired trace authority', () => {
    const create = (nativeTable?: unknown, referenceTraceId?: string) => createAnalysisRunSpec({
      outputConfig: captureAnalysisOutputConfig({}),
      query: 'selected event', sessionId: 'session', traceId: 'trace-current',
      options: {selectionContext: {kind: 'track_event', eventId: 7, ts: 42,
        ...(nativeTable === undefined ? {} : {nativeTable})} as any, referenceTraceId},
      runtimeSelection: openAiSelection, sceneType: 'general', outputLanguage: 'en'}).selection;
    const selected = create('slice');
    expect(selected).toMatchObject({present: true, context: {nativeTable: 'slice'}});
    expect(validateAnalysisRunSelection(selected)).toEqual(selected);
    expect(Object.isFrozen(selected.present && selected.context)).toBe(true);
    expect(create('slice', 'reference')).toMatchObject({sideResolution: {status: 'unknown'}});
    const legacy = create();
    expect(legacy).toMatchObject({present: true});
    expect(legacy.present && legacy.context).not.toHaveProperty('nativeTable');
    for (const value of ['thread_state', 'Slice', '', null, true, {}]) {
      expect(() => create(value)).toThrow('analysis_run_selection_invalid');
    }
  });

  it('rejects invalid bypass inputs and noncanonical attached selections instead of erasing them', () => {
    const create = (selectionContext: unknown) => createAnalysisRunSpec({outputConfig: captureAnalysisOutputConfig({}), query: 'selected event', sessionId: 'session', traceId: 'trace',
      options: {selectionContext} as AnalysisOptions, runtimeSelection: openAiSelection, sceneType: 'general', outputLanguage: 'en'});
    for (const selectionContext of [null, false,
      {kind: 'track_event', eventId: 1, ts: 2, dur: Number.MAX_SAFE_INTEGER + 1},
      {kind: 'track_event', eventId: 1, ts: Number.MAX_SAFE_INTEGER, dur: 1},
      {kind: 'track_event', eventId: 1, ts: 2, extra: true},
      {kind: 'area', startNs: 2, endNs: 2},
      {kind: 'area', startNs: 1, endNs: 4, durationNs: 5},
      {kind: 'area', startNs: 1, endNs: 4, tracks: Array.from({length: 257}, () => ({uri: 'track'}))},
      {kind: 'area', startNs: 1, endNs: 4, tracks: [{uri: 'x'.repeat(513)}]},
    ]) expect(() => create(selectionContext)).toThrow('analysis_run_selection_invalid');
    const sparseTracks = Array(1);
    expect(() => create({kind: 'area', startNs: 1, endNs: 4, tracks: sparseTracks})).toThrow('analysis_run_selection_invalid');
    const getter = jest.fn(() => 2);
    const accessor = Object.defineProperty({kind: 'track_event', eventId: 1}, 'ts', {enumerable: true, get: getter});
    expect(() => create(accessor)).toThrow('analysis_run_selection_invalid');
    expect(getter).not.toHaveBeenCalled();
    expect(() => validateAnalysisRunSelection({present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 1, ts: 2, trackUri: ' track '},
      sideResolution: {status: 'unknown'}})).toThrow('analysis_run_selection_invalid');
    expect(() => validateAnalysisRunSelection({present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 1, ts: 2, trackUri: undefined} as any,
      sideResolution: {status: 'unknown'}})).toThrow('analysis_run_selection_invalid');
    expect(() => validateAnalysisRunSelection({present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 1, ts: 2},
      sideResolution: {status: 'unknown', traceId: 'trace'} as any})).toThrow('analysis_run_selection_invalid');
    expect(validateAnalysisRunSelection({sideResolution: {status: 'unknown'}, context: {ts: 2, eventId: 1,
      kind: 'track_event'}, kind: 'track_event', present: true})).toMatchObject({present: true,
      context: {kind: 'track_event', eventId: 1, ts: 2}});
    const signed = create({kind: 'track_event', eventId: 1, ts: -2, dur: 1}).selection;
    expect(signed.present && signed.context).toMatchObject({kind: 'track_event', ts: -2, dur: 1});
  });

  it('reuses existing classifier input construction without storing runtime policy descriptors', () => {
    const previousTurns = [
      {
        query: 'first',
        intent: { complexity: 'simple' },
        findings: [],
      },
      {
        query: 'analyze the scroll',
        intent: { complexity: 'complex' },
        findings: [{ title: 'Long doFrame', severity: 'high', category: 'frame' }],
      },
    ] as any;
    const options: AnalysisOptions = {
      referenceTraceId: 'trace-ref',
      selectionContext: {
        kind: 'track_event',
        eventId: 7,
        ts: 42,
      },
    };

    const spec = createAnalysisRunSpec({
      outputConfig: captureAnalysisOutputConfig({}),
      query: 'continue from the selected slice',
      sessionId: 'session-1',
      traceId: 'trace-current',
      options,
      runtimeSelection: claudeSelection,
      sceneType: 'scrolling',
      outputLanguage: 'zh-CN',
      previousTurns,
    });

    expect(spec.mode.classifierInput).toEqual(buildComplexityClassifierInput({
      query: 'continue from the selected slice',
      sceneType: 'scrolling',
      selectionContext: options.selectionContext,
      hasReferenceTrace: true,
      previousTurns,
      requestedMode: 'auto',
    }));
    expect(spec.mode).not.toHaveProperty('classifierPolicy');
    expect(spec).not.toHaveProperty('continuationPolicy');
  });

  it('preserves OpenAI runtime identity and shared classifier input', () => {
    const spec = createAnalysisRunSpec({
      outputConfig: captureAnalysisOutputConfig({}),
      query: 'quick status?',
      sessionId: 'session-openai',
      traceId: 'trace-openai',
      options: {
        analysisMode: 'fast',
        codeAwareMode: 'off',
        codebaseIds: ['ignored-when-off'],
      },
      runtimeSelection: openAiSelection,
      sceneType: 'general',
      outputLanguage: 'en',
      resolvedMode: 'quick',
      budget: {
        model: 'gpt-5.5',
        lightModel: 'gpt-5.4-mini',
        maxTurns: 60,
        quickMaxTurns: 50,
        quickTargetTurns: 5,
        maxOutputTokens: 2048,
        fullPathPerTurnMs: 60_000,
        quickPathPerTurnMs: 40_000,
      },
    });

    expect(spec.runtime.kind).toBe('openai-agents-sdk');
    expect(spec.mode).toMatchObject({
      requested: 'fast',
      resolved: 'quick',
    });
    expect(spec.tools.requestScope).toEqual({
      sessionId: 'session-openai',
      hasCodebaseAccess: false,
    });
    expect(spec.runtime.capabilities).toEqual({
      kind: 'openai-agents-sdk',
      displayName: 'OpenAI Agents SDK',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
      draftAnswerStreaming: true,
    });
  });

  it.each(listProductionRuntimeKinds())(
    'records the final model and canonical runtime for %s',
    runtimeKind => {
      const recordRuntime = jest.fn();
      const sink = {
        identity: {
          runId: `run-${runtimeKind}`,
          sessionId: `session-${runtimeKind}`,
          scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
        },
        recordScene: jest.fn(),
        recordRuntime,
        recordMode: jest.fn(),
      } as unknown as RunManifestAttributionSink;
      const runtimeSelection = {
        kind: runtimeKind,
        source: 'snapshot',
      } as RuntimeSelection;

      const spec = createAnalysisRunSpec({
        outputConfig: captureAnalysisOutputConfig({}),
        query: 'analyze',
        sessionId: `session-${runtimeKind}`,
        traceId: 'trace-runtime',
        options: {
          providerId: `provider-${runtimeKind}`,
          runManifestAttributionSink: sink,
        },
        runtimeSelection,
        sceneType: 'general',
        outputLanguage: 'en',
        budget: {model: `model-${runtimeKind}`},
      });

      expect(spec.runtime.kind).toBe(runtimeKind);
      expect(recordRuntime).toHaveBeenCalledWith({
        runtime: runtimeKind,
        providerId: `provider-${runtimeKind}`,
        model: `model-${runtimeKind}`,
        outputLanguage: 'en',
        conclusionDeclarationSyntax: spec.declarationSyntax,
        finalSubmission: spec.finalSubmission,
      });
    },
  );
});
