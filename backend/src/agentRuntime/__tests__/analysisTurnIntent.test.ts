// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import Ajv from 'ajv';
import {
  createAnalysisTurnIntentResolver,
  parseAnalysisTurnIntentDecision,
  resolveTurnIntentComplexity,
  type AnalysisTurnIntentDecision,
} from '../analysisTurnIntent';
import {buildComplexityClassifierInput} from '../../agentv3/queryComplexityContext';
import {buildAnalysisTurnIntentPrompt} from '../../agentv3/queryComplexityPrompt';
import {buildStrategyRegistrySnapshotFromDefinitions, fingerprintStrategyDefinition, getRegisteredScenes, loadPromptTemplate} from '../../agentv3/strategyLoader';
import type {IntentTransportInput, IntentTransportResult} from '../intentTransport';
import {createAnalysisRunSpec} from '../analysisRunSpec';

const registry = buildStrategyRegistrySnapshotFromDefinitions({
  definitions: getRegisteredScenes(), overlayGeneration: 'intent-test',
});
const decision: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'existing_only',
};
const context = buildComplexityClassifierInput({
  query: 'Why did this row change?', sceneType: 'general', hasReferenceTrace: true, previousTurns: [],
});
const response = (value: unknown): IntentTransportResult => ({status: 'ok', text: JSON.stringify(value)});
const createResolver = (dispatch: (input: IntentTransportInput) => Promise<IntentTransportResult>) =>
  createAnalysisTurnIntentResolver({context, strategyRegistry: registry, deadlineMs: Date.now() + 10_000, dispatch});
const arrayValuedResponse = {
  schemaVersion: 1, taskKind: ['investigation'], sceneId: ['general'], scope: ['bounded_question'],
  recommendedComplexity: ['quick'], deliverable: ['answer'], evidenceAccess: ['read_new'], reason: 'A bounded investigation',
};

describe('analysis turn intent protocol', () => {
  it('accepts a complete decision as JSON or one whole JSON fence', () => {
    for (const text of [JSON.stringify(decision), '```json\n' + JSON.stringify(decision) + '\n```']) {
      expect(parseAnalysisTurnIntentDecision(text, registry)).toEqual(decision);
    }
  });

  it.each([
    null, [], {complexity: 'quick'}, {...decision, schemaVersion: 2}, {...decision, sceneId: 'invented'},
    {...decision, taskKind: 'explain'}, {...decision, scope: 'whatever'}, {...decision, recommendedComplexity: 'auto'},
    {...decision, evidenceAccess: 'all'}, {...decision, deliverable: 'long'}, {...decision, source: 'semantic'},
    {...decision, status: 'resolved'}, {...decision, permissions: ['read_anything']},
    {...decision, upid: 42}, {...decision, reason: {text: 'full'}},
    {...decision, taskKind: 'acknowledgement'},
  ])('rejects malformed or authority-bearing input %#', value => {
    expect(parseAnalysisTurnIntentDecision(JSON.stringify(value), registry)).toBeUndefined();
  });

  describe('source need', () => {
    const sourceRun = {options: {codeAwareMode: 'provider_send' as const, codebaseIds: ['app']}, runId: 'run',
      sessionId: 'session', traceId: 'trace'};
    const withSchema = async (productRun: typeof sourceRun | undefined, answer: unknown) => {
      let schema!: Record<string, any>;
      const run = createAnalysisTurnIntentResolver({context, strategyRegistry: registry, productRun,
        deadlineMs: Date.now() + 10_000, template: '{{decisionSchema}}', dispatch: async input => {
          schema = JSON.parse(input.prompt);
          return response(answer);
        }});
      return {intent: await run.resolve(), schema};
    };

    it('is asked, and parsed, only when the run selects source', async () => {
      const selected = await withSchema(sourceRun, {...decision, sourceNeed: 'mechanism'});
      expect(selected.intent).toMatchObject({status: 'resolved', sourceNeed: 'mechanism'});
      expect(selected.schema.required).toContain('sourceNeed');
      expect(selected.schema.properties.sourceNeed).toEqual({type: 'string', enum: ['none', 'locate', 'mechanism']});
      const unselected = await withSchema(undefined, {...decision, sourceNeed: 'mechanism'});
      expect(unselected.schema.properties).not.toHaveProperty('sourceNeed');
      expect(unselected.intent).toMatchObject({status: 'unavailable', unavailableReason: 'invalid_response'});
      const off = await withSchema({...sourceRun, options: {codeAwareMode: 'off' as never, codebaseIds: ['app']}}, decision);
      expect(off.schema.properties).not.toHaveProperty('sourceNeed');
    });

    it('keeps the rest of the decision when the source need is omitted, and rejects an unknown one', () => {
      expect(parseAnalysisTurnIntentDecision(JSON.stringify(decision), registry, {sourceSelected: true})).toEqual(decision);
      expect(parseAnalysisTurnIntentDecision(JSON.stringify({...decision, sourceNeed: 'deep'}), registry,
        {sourceSelected: true})).toBeUndefined();
      const acknowledgement = {...decision, taskKind: 'acknowledgement', scope: 'bounded_question',
        recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only'};
      expect(parseAnalysisTurnIntentDecision(JSON.stringify({...acknowledgement, sourceNeed: 'none'}), registry,
        {sourceSelected: true})).toMatchObject({sourceNeed: 'none'});
      expect(parseAnalysisTurnIntentDecision(JSON.stringify({...acknowledgement, sourceNeed: 'locate'}), registry,
        {sourceSelected: true})).toBeUndefined();
    });

    it('explains the dimension in the prompt only when source is selected', () => {
      const template = loadPromptTemplate('prompt-analysis-turn-intent')!;
      const guidance = loadPromptTemplate('prompt-analysis-turn-intent-source-need')!;
      expect(guidance).toContain('sourceNeed');
      const withSource = buildAnalysisTurnIntentPrompt({context, strategyRegistry: registry, template,
        decisionSchema: {}, sourceNeedGuidance: guidance});
      expect(withSource).toContain('sourceNeed');
      expect(buildAnalysisTurnIntentPrompt({context, strategyRegistry: registry, template, decisionSchema: {}}))
        .not.toContain('sourceNeed');
    });
  });

  it('rejects prose that quotes a decision, concatenated objects, and oversized content', () => {
    const json = JSON.stringify(decision);
    for (const text of ['The response is ' + json, json + json, json + '\nExplanation', 'x'.repeat(8193)]) {
      expect(parseAnalysisTurnIntentDecision(text, registry)).toBeUndefined();
    }
  });

  it('sends a closed JSON Schema whose enum fields require scalar strings', async () => {
    let schema!: Record<string, any>;
    const dispatch = jest.fn(async (input: IntentTransportInput) => {
      schema = JSON.parse(input.prompt);
      return response(decision);
    });
    const run = createAnalysisTurnIntentResolver({context, strategyRegistry: registry,
      deadlineMs: Date.now() + 10_000, template: '{{decisionSchema}}', dispatch});
    expect(await run.resolve()).toMatchObject({status: 'resolved'});
    expect(dispatch).toHaveBeenCalledTimes(1);
    const validate = new Ajv().compile(schema);
    expect(schema).toMatchObject({type: 'object', additionalProperties: false,
      properties: {schemaVersion: {type: 'integer', const: 1}, reason: {type: 'string', maxLength: 800}}});
    expect(schema.required).toEqual(Object.keys(decision));
    expect(validate(decision)).toBe(true);
    expect(validate({...decision, reason: 'A short explanation'})).toBe(true);
    expect(validate(arrayValuedResponse)).toBe(false);
    for (const key of ['taskKind', 'sceneId', 'scope', 'recommendedComplexity', 'deliverable', 'evidenceAccess'] as const) {
      expect(schema.properties[key]).toMatchObject({type: 'string', enum: expect.arrayContaining([decision[key]])});
      expect(validate({...decision, [key]: [decision[key]]})).toBe(false);
      const incomplete: Partial<AnalysisTurnIntentDecision> = {...decision};
      delete incomplete[key];
      expect(validate(incomplete)).toBe(false);
    }
    for (const value of [{...decision, schemaVersion: 2}, {...decision, status: 'resolved'},
      {...decision, reason: 'x'.repeat(801)}, {...decision, taskKind: 'acknowledgement'}]) {
      expect(validate(value)).toBe(false);
      expect(parseAnalysisTurnIntentDecision(JSON.stringify(value), registry)).toBeUndefined();
    }
    const acknowledgement = {...decision, taskKind: 'acknowledgement', recommendedComplexity: 'quick'};
    expect(validate(acknowledgement)).toBe(true);
    expect(parseAnalysisTurnIntentDecision(JSON.stringify(acknowledgement), registry)).toEqual(acknowledgement);
  });

  it('keeps the recorded array-valued shape invalid without coercion or another dispatch', async () => {
    const dispatch = jest.fn(async () => response(arrayValuedResponse));
    const run = createResolver(dispatch);
    expect(parseAnalysisTurnIntentDecision(JSON.stringify(arrayValuedResponse), registry)).toBeUndefined();
    const intent = await run.resolve();
    expect(intent).toMatchObject({status: 'unavailable', source: 'fallback', unavailableReason: 'invalid_response'});
    expect(await run.resolve()).toBe(intent);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('derives scalar scene enums from the same pinned registry and excludes contract-only entries', async () => {
    const base = registry.getStrategy('general')!;
    const snapshot = buildStrategyRegistrySnapshotFromDefinitions({definitions: [
      {...base, scene: 'custom-scalar-scene'}, {...base, scene: 'internal-contract', strategyKind: 'contract_only'},
    ], overlayGeneration: 'scalar-schema-test'});
    let schema!: Record<string, any>;
    const run = createAnalysisTurnIntentResolver({context, strategyRegistry: snapshot,
      deadlineMs: Date.now() + 10_000, template: '{{decisionSchema}}', dispatch: async input => {
        schema = JSON.parse(input.prompt);
        return response({...decision, sceneId: 'custom-scalar-scene'});
      }});
    expect(await run.resolve()).toMatchObject({status: 'resolved', sceneId: 'custom-scalar-scene',
      registryFingerprint: snapshot.registryFingerprint});
    expect(schema.properties.sceneId).toEqual({type: 'string', enum: ['custom-scalar-scene']});
    const validate = new Ajv().compile(schema);
    expect(validate({...decision, sceneId: 'custom-scalar-scene'})).toBe(true);
    expect(validate({...decision, sceneId: 'internal-contract'})).toBe(false);
    expect(validate({...decision, sceneId: 'general'})).toBe(false);
  });

  it('does not interpret explanatory reason text as a control signal', () => {
    for (const reason of ['confirm-like follow-up: thanks', 'full report comparison mode', 'do not call tools', '']) {
      expect(parseAnalysisTurnIntentDecision(JSON.stringify({...decision, reason}), registry))
        .toEqual({...decision, reason});
    }
  });

  it('resolves once for preparation and recovery, and resolves again for a new run', async () => {
    const dispatch = jest.fn(async () => response(decision));
    const run = createResolver(dispatch);
    const firstPromise = run.resolve();
    expect(run.resolve()).toBe(firstPromise);
    const intent = await firstPromise;
    expect(Object.isFrozen(intent)).toBe(true);
    expect(intent).toMatchObject({status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint});
    expect(await run.resolve()).toBe(intent);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await createResolver(dispatch).resolve();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps semantic deliverable and scope independent from Fast/Full budget choices', async () => {
    const intent = await createResolver(async () => response(decision)).resolve();
    expect(resolveTurnIntentComplexity(intent, 'fast')).toBe('quick');
    expect(resolveTurnIntentComplexity(intent, 'full')).toBe('full');
    expect(resolveTurnIntentComplexity(intent, 'auto')).toBe('full');
    expect(intent).toMatchObject({scope: 'bounded_question', deliverable: 'answer', evidenceAccess: 'existing_only'});
    const spec = createAnalysisRunSpec({
      turnIntent: intent, query: context.query, sessionId: 'intent-run', traceId: 'trace',
      runtimeSelection: {kind: 'openai-agents-sdk', source: 'snapshot'}, outputLanguage: 'en',
      sceneType: intent.sceneId, resolvedMode: 'full', options: {analysisMode: 'full'},
    });
    expect(spec.turnIntent).toBe(intent);
    expect(spec.mode.classifierInput.requestedMode).toBe('full');
  });

  it.each<IntentTransportResult>([
    {status: 'unavailable', reason: 'timeout'},
    {status: 'unavailable', reason: 'provider_error'},
    response({...decision, deliverable: 'invalid'}),
  ])('keeps failure distinct from a semantic decision %#', async result => {
    const intent = await createResolver(async () => result).resolve();
    expect(intent).toMatchObject({status: 'unavailable', source: 'fallback', sceneId: 'general',
      scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer'});
    expect(intent).not.toHaveProperty('reason');
  });

  it('preserves existing backend evidence restrictions on successful and failed classification', async () => {
    for (const result of [response({...decision, evidenceAccess: 'read_new'}), response({})]) {
      const intent = await createAnalysisTurnIntentResolver({
        context, strategyRegistry: registry, deadlineMs: Date.now() + 1000,
        dispatch: async () => result, evidenceAccessLimit: 'existing_only',
      }).resolve();
      expect(intent.evidenceAccess).toBe('existing_only');
    }
  });

  it('does not leak raw provider errors, but propagates parent cancellation', async () => {
    const secret = 'secret-provider-request';
    const failed = await createResolver(async () => {throw new Error(secret);}).resolve();
    expect(JSON.stringify(failed)).not.toContain(secret);
    const controller = new AbortController();
    const cancel = new Error('user cancelled');
    const run = createAnalysisTurnIntentResolver({
      context, strategyRegistry: registry, signal: controller.signal, deadlineMs: Date.now() + 1000,
      dispatch: async () => {controller.abort(cancel); return response(decision);},
    });
    await expect(run.resolve()).rejects.toBe(cancel);
  });

  it('does not dispatch after the one run deadline has expired', async () => {
    const dispatch = jest.fn(async () => response(decision));
    const intent = await createAnalysisTurnIntentResolver({
      context, strategyRegistry: registry, deadlineMs: 1, dispatch,
    }).resolve();
    expect(intent).toMatchObject({status: 'unavailable', unavailableReason: 'timeout'});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('discards a response that arrives after the deadline', async () => {
    jest.useFakeTimers({now: 1000});
    try {
      const intent = await createAnalysisTurnIntentResolver({
        context, strategyRegistry: registry, deadlineMs: 1100,
        dispatch: async () => {jest.setSystemTime(1200); return response(decision);},
      }).resolve();
      expect(intent).toMatchObject({status: 'unavailable', unavailableReason: 'timeout'});
    } finally {jest.useRealTimers();}
  });

  it('does not send a partial request when its complete context exceeds the bound', async () => {
    const dispatch = jest.fn(async () => response(decision));
    const intent = await createAnalysisTurnIntentResolver({
      context: {...context, query: 'q'.repeat(65_536)}, strategyRegistry: registry,
      deadlineMs: Date.now() + 1000, dispatch,
    }).resolve();
    expect(intent).toMatchObject({status: 'unavailable', unavailableReason: 'context_limit'});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('pins the catalog used by the prompt and parser, and captures context before dispatch', async () => {
    const mutableContext = {...context, query: 'Original request'};
    let receivedPrompt = '';
    const run = createAnalysisTurnIntentResolver({
      context: mutableContext, strategyRegistry: registry, deadlineMs: Date.now() + 1000,
      dispatch: async input => {receivedPrompt = input.prompt; return response(decision);},
    });
    mutableContext.query = 'A different request';
    const intent = await run.resolve();
    expect(run.strategyRegistry).toBe(registry);
    expect(intent.registryFingerprint).toBe(registry.registryFingerprint);
    expect(receivedPrompt).toContain('Original request');
    expect(receivedPrompt).not.toContain('A different request');
    for (const scene of registry.getAllStrategies().filter(scene => scene.strategyKind !== 'contract_only')) {
      expect(receivedPrompt).toContain(JSON.stringify(scene.scene));
      if (scene.classificationDescription) expect(receivedPrompt).toContain(scene.classificationDescription);
    }
  });
});

describe('semantic intent context assembly', () => {
  it('uses declarative scene descriptions and never copies execution instructions into classification', () => {
    const base = registry.getStrategy('general')!;
    const source = {...base, classificationDescription: 'An unfamiliar trace topic', content: 'EXECUTION_ONLY_CANARY'};
    const snapshot = buildStrategyRegistrySnapshotFromDefinitions({definitions: [source], overlayGeneration: 'test'});
    const prompt = buildAnalysisTurnIntentPrompt({context, strategyRegistry: snapshot,
      template: loadPromptTemplate('prompt-analysis-turn-intent')!, decisionSchema: {schemaVersion: 1}});
    expect(prompt).toContain(source.classificationDescription);
    expect(prompt).not.toContain(source.content);
    expect(snapshot.getStrategy('general')?.classificationDescription).toBe(source.classificationDescription);
    expect(fingerprintStrategyDefinition(source)).not.toBe(fingerprintStrategyDefinition({...source, classificationDescription: 'Another meaning'}));
    const {classificationDescription: _description, ...definitionWithoutDescription} = source;
    const withoutDescription = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: [definitionWithoutDescription], overlayGeneration: 'test',
    });
    expect(buildAnalysisTurnIntentPrompt({context, strategyRegistry: withoutDescription,
      template: loadPromptTemplate('prompt-analysis-turn-intent')!, decisionSchema: {}})).not.toContain(source.content);
  });

  // A description says what a scene means; keywords say what it is called,
  // which is what a first-turn question actually contains. Eight per scene is
  // the bound the catalog carries — the rest exist for authoring, not for the
  // classifier — and the scene dimension is the only one they may anchor.
  it('anchors the scene catalog with each scene\'s leading keywords only', () => {
    const prompt = buildAnalysisTurnIntentPrompt({context, strategyRegistry: registry,
      template: loadPromptTemplate('prompt-analysis-turn-intent')!, decisionSchema: {schemaVersion: 1}});
    const network = registry.getStrategy('network')!;
    expect(network.keywords.slice(0, 8)).toEqual(['network', 'okhttp', 'cronet', 'dns', 'tls', 'tcp', '网络', '请求']);
    expect(prompt).toContain(JSON.stringify(network.keywords.slice(0, 8)));

    const ninth = network.keywords[8];
    const anchors = new Set(registry.getAllStrategies().flatMap(scene => scene.keywords.slice(0, 8)));
    expect(anchors.has(ninth)).toBe(false);
    expect(prompt).not.toContain(JSON.stringify(ninth));

    expect(registry.getStrategy('general')!.keywords).toEqual([]);
    expect(prompt).toContain('"id":"general","description"');
  });

  it('includes actual selection and facts from a quick turn in the real prompt without raw payloads', () => {
    const selection = {kind: 'area' as const, startNs: 12, endNs: 42};
    const input = buildComplexityClassifierInput({
      query: 'Why that value?', sceneType: 'general', hasReferenceTrace: false,
      selectionContext: selection, requestedMode: 'full', previousTurns: [{
        id: 'turn-3', query: 'The process?', intent: {complexity: 'simple', referencedEntities: [{type: 'process', id: 73}]},
        findings: [{id: 'fact-1', title: 'Target', description: 'UPID 73 has 42 ms running time.', severity: 'info',
          evidence: [{secretRaw: 'NOT_FOR_CLASSIFIER'}]}],
      }],
    });
    expect(input.hasExistingFindings).toBe(true);
    expect(input.hasPriorFullAnalysis).toBe(false);
    expect(input.previousFindingDetails).toEqual([expect.objectContaining({id: 'fact-1', turnId: 'turn-3', turnIndex: 0})]);
    const prompt = buildAnalysisTurnIntentPrompt({context: input, strategyRegistry: registry,
      template: loadPromptTemplate('prompt-analysis-turn-intent')!, decisionSchema: {schemaVersion: 1}});
    expect(prompt).toContain('UPID 73 has 42 ms running time.');
    expect(prompt).toContain(JSON.stringify(selection));
    expect(prompt).toContain('"requestedMode":"full"');
    expect(prompt).toContain('"type":"process","id":73');
    expect(prompt).not.toContain('NOT_FOR_CLASSIFIER');
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
