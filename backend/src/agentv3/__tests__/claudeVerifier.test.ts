// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Runtime-state checks; content truth is covered by the shared finalizer suites. */

import {jest, describe, it, expect, beforeEach} from '@jest/globals';
import type {Finding, StreamingUpdate} from '../../agent/types';
import type {AnalysisPlanV3, Hypothesis, VerificationIssue} from '../types';
import {summarizeToolCallInput} from '../toolCallSummary';
import {
  analysisDeliveryFingerprint, reportRequirementsFingerprint,
  type AnalysisCompletion, type AnalysisDeliveryContext,
} from '../../types/analysisDelivery';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({query: jest.fn(() => {
  throw new Error('Runtime diagnostics must not dispatch a provider request');
})}));
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  writeFileSync: jest.fn(), renameSync: jest.fn(), mkdirSync: jest.fn(),
}));

import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import {
  verifyPlanAdherence, verifyHypotheses, verifyConclusion, generateCorrectionPrompt, isConclusionIncomplete,
} from '../claudeVerifier';

beforeEach(() => {jest.clearAllMocks();});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {id: 'finding-1', title: 'Finding', description: 'Description', severity: 'warning', ...overrides};
}

function makePlan(overrides: Partial<AnalysisPlanV3> = {}): AnalysisPlanV3 {
  return {phases: [{id: 'phase-1', name: 'Data Collection', goal: 'Collect evidence',
    expectedTools: ['execute_sql', 'invoke_skill'], status: 'completed'}],
    successCriteria: 'Answer the question', submittedAt: 1,
    toolCallLog: [
      {toolName: 'execute_sql', timestamp: 1, matchedPhaseId: 'phase-1', success: true},
      {toolName: 'invoke_skill', timestamp: 2, matchedPhaseId: 'phase-1', success: true},
    ], ...overrides};
}

describe('verifyPlanAdherence', () => {
  it('accepts no plan and a completed plan backed by actual successful receipts', () => {
    expect(verifyPlanAdherence(null)).toEqual([]);
    expect(verifyPlanAdherence(makePlan())).toEqual([]);
  });

  it.each(['Final conclusion', 'comparison synthesis', '综合结论', 'root cause', '任意阶段'])(
    'does not waive declared work when the phase is named %s', name => {
      const plan = makePlan({phases: [
        {id: 'p1', name: 'Evidence', goal: 'Read', expectedTools: ['execute_sql'], status: 'completed'},
        {id: 'p2', name, goal: name, expectedTools: ['fetch_artifact'], status: 'completed'},
      ], toolCallLog: [{toolName: 'execute_sql', toolCallId: 'actual', success: true, timestamp: 1, matchedPhaseId: 'p1'}]});
      const issues = verifyPlanAdherence(plan);
      expect(issues).toEqual([expect.objectContaining({type: 'plan_deviation', severity: 'error'})]);
      expect(issues[0].message).toContain('p2');
    },
  );

  it.each([false, undefined])('does not accept success=%s or use summaries as proof', success => {
    const plan = makePlan({phases: [{id: 'p1', name: 'Complete', goal: 'Collect', expectedTools: ['execute_sql'], status: 'completed',
      summary: 'All required evidence was fully verified. '.repeat(100)}],
      toolCallLog: [{toolName: 'execute_sql', success, timestamp: 1, matchedPhaseId: 'p1'}]});
    expect(verifyPlanAdherence(plan)).toContainEqual(expect.objectContaining({severity: 'error'}));
  });

  it('requires every generic and structured declaration on the correct phase', () => {
    const plan = makePlan({phases: [{id: 'p1', name: 'Inspect', goal: 'Collect', expectedTools: ['execute_sql', 'invoke_skill'],
      expectedCalls: [{tool: 'invoke_skill', skillId: 'required'}], status: 'completed'}], toolCallLog: [
      {toolName: 'execute_sql', success: true, timestamp: 1, matchedPhaseId: 'p1'},
      {toolName: 'invoke_skill', skillId: 'required', success: true, timestamp: 2, matchedPhaseId: 'wrong'},
      {toolName: 'invoke_skill', skillId: 'process_identity_resolver', success: true, timestamp: 3, matchedPhaseId: 'p1'},
    ]});
    expect(verifyPlanAdherence(plan)).toContainEqual(expect.objectContaining({severity: 'error'}));
    plan.toolCallLog.push({toolName: 'invoke_skill', skillId: 'required', success: true, timestamp: 4, matchedPhaseId: 'p1'});
    expect(verifyPlanAdherence(plan)).toEqual([]);
  });

  it('does not require artificial SQL or a minimum summary for a pure reasoning phase', () => {
    expect(verifyPlanAdherence(makePlan({phases: [{id: 'p1', name: 'Analyze', goal: 'Reason over existing evidence',
      expectedTools: [], status: 'completed'}], toolCallLog: []}))).toEqual([]);
  });

  it('keeps skipped expectations visible and never turns a disposition into success', () => {
    const plan = makePlan({phases: [{id: 'p1', name: 'Final report', goal: 'Collect', expectedTools: ['execute_sql'],
      status: 'skipped', skipDisposition: {kind: 'deferred'}}], toolCallLog: []});
    expect(verifyPlanAdherence(plan)).toEqual([expect.objectContaining({severity: 'warning'})]);
    expect(plan.toolCallLog).toEqual([]);
    delete plan.phases[0].skipDisposition;
    expect(verifyPlanAdherence(plan)).toEqual([expect.objectContaining({severity: 'error'})]);
  });

  it('does not downgrade missing evidence because unrelated tools ran', () => {
    const plan = makePlan({phases: [{id: 'p1', name: 'Collect', goal: 'Read', expectedTools: ['execute_sql'], status: 'pending'}],
      toolCallLog: [{toolName: 'fetch_artifact', success: true, timestamp: 1}]});
    expect(verifyPlanAdherence(plan)).toEqual([expect.objectContaining({severity: 'error'})]);
  });

  it('ignores retired lexical aspects while retaining real declared obligations', () => {
    expect(verifyPlanAdherence(makePlan({unresolvedAspects: ['old_lexical_scene_aspect']}))).toEqual([]);
  });
});

describe('submitted runtime state boundaries', () => {
  it.each([
    false, 0, {}, {phases: []}, {phases: [null], toolCallLog: []},
    {phases: [{id: 'p1', name: 'Phase', goal: 'Goal', expectedTools: [null], status: 'completed'}], toolCallLog: []},
    {...makePlan(), toolCallLog: null}, {...makePlan(), toolCallLog: {}}, {...makePlan(), toolCallLog: [null]},
    {...makePlan(), toolCallLog: [{toolName: 42, timestamp: 1}]},
    {...makePlan(), toolCallLog: [{toolName: 'execute_sql', timestamp: 1, success: 'true'}]},
  ])('rejects malformed plan/log state without substituting an empty log: %j', input => {
    expect(verifyPlanAdherence(input as unknown as AnalysisPlanV3)).toEqual([
      expect.objectContaining({type: 'plan_deviation', severity: 'error'}),
    ]);
  });

  it('retains a failed empty-skill request while allowing actual successful recovery to satisfy the plan', () => {
    const plan = makePlan();
    const failed = {toolName: 'invoke_skill', timestamp: 0, success: false, matchedPhaseId: 'phase-1',
      ...summarizeToolCallInput('invoke_skill', {skillId: ''})};
    plan.toolCallLog.unshift(failed);
    expect(verifyPlanAdherence(plan)).toEqual([]);
    expect(plan.toolCallLog[0]).toBe(failed);
    plan.toolCallLog = plan.toolCallLog.filter(call => call === failed || call.toolName === 'execute_sql');
    expect(verifyPlanAdherence(plan)).toContainEqual(expect.objectContaining({type: 'plan_deviation', severity: 'error'}));
  });

  it.each(['Frame took 50ms', 'Because CPU blocked the frame', '该假设已经证伪', 'No conclusion yet'])(
    'uses explicit hypothesis state independently of its statement: %s', statement => {
      const formed: Hypothesis = {id: 'h1', statement, status: 'formed', formedAt: 1};
      expect(verifyHypotheses([formed])).toEqual([
        {type: 'unresolved_hypothesis', severity: 'error', message: 'Unresolved hypothesis state: h1.'},
      ]);
      expect(verifyHypotheses([{...formed, status: 'confirmed'}])).toEqual([]);
      expect(verifyHypotheses([{...formed, status: 'rejected'}])).toEqual([]);
      expect(formed.status).toBe('formed');
    },
  );

  it('rejects ambiguous or malformed hypothesis state rather than guessing from its text', () => {
    const hypothesis: Hypothesis = {id: 'h1', statement: 'Confirmed', status: 'confirmed', formedAt: 1};
    for (const input of [null, [{}], [hypothesis, hypothesis], [{...hypothesis, status: 'success'}]]) {
      expect(verifyHypotheses(input as unknown as Hypothesis[])).toEqual([
        expect.objectContaining({type: 'unresolved_hypothesis', severity: 'error'}),
      ]);
    }
    expect(verifyHypotheses([])).toEqual([]);
  });
});

describe('generateCorrectionPrompt', () => {
  function correctionContext(prompt: string): {
    recoveryKinds: string[];
    missingSections: Array<{id: string; label: string; description?: string}>;
    issues: unknown[];
  } {
    return JSON.parse(prompt.split('```json\n')[1].split('\n```')[0]);
  }

  it.each(['zh-CN', 'en'] as const)('preserves the body and passes structured defects in %s', language => {
    const body = 'A short answer without terminal punctuation';
    const issues: VerificationIssue[] = [{type: 'missing_evidence', severity: 'error',
      message: 'Diagnostic text', recoveryKind: 'correct_evidence'}];
    const prompt = generateCorrectionPrompt(issues, body, language);
    expect(correctionContext(prompt)).toEqual({recoveryKinds: ['correct_evidence'], missingSections: [], issues});
    expect(prompt).toContain(body);
  });

  it('does not infer a full report from body style, scene, or diagnostic language', () => {
    for (const body of ['短回答', 'Unheaded text'.repeat(200), '# Report\nLonger body']) {
      for (const message of ['Final Report Contract required structure missing: representative frames', '结论文本被截断', '其他']) {
        const prompt = generateCorrectionPrompt([{type: 'missing_reasoning', severity: 'error', message}], body, 'en', 'scrolling');
        expect(correctionContext(prompt).recoveryKinds).toEqual([]);
        expect(correctionContext(prompt).missingSections).toEqual([]);
      }
    }
  });

  it('keeps requested missing content independent of localized issue messages', () => {
    const missingSections = [{id: 'scope', label: 'Scope', description: 'State the measured population'}];
    for (const message of ['缺少内容', 'Falta contenido', 'arbitrary diagnostic']) {
      const prompt = generateCorrectionPrompt([{type: 'missing_reasoning', severity: 'error', message,
        recoveryKind: 'complete_report_content', missingSections}], 'Original', 'en', 'startup');
      expect(correctionContext(prompt).missingSections).toEqual(missingSections);
      expect(correctionContext(prompt).recoveryKinds).toEqual(['complete_report_content']);
    }
  });

  it('keeps warning-only diagnostics from authorizing recovery and preserves long bodies', () => {
    const body = 'Body ending without punctuation '.repeat(600);
    const prompt = generateCorrectionPrompt([{type: 'missing_reasoning', severity: 'warning', message: 'note',
      recoveryKind: 'complete_report_content', missingSections: [{id: 'a', label: 'A'}]}], body);
    expect(correctionContext(prompt).recoveryKinds).toEqual([]);
    expect(correctionContext(prompt).missingSections).toEqual([]);
    expect(prompt).toContain(body);
  });
});

describe('isConclusionIncomplete', () => {
  it.each(['短回答', '分析发现 CPU 频率问题。'.repeat(100), '# Report\nText without punctuation'])(
    'does not infer completion from prose: %s', body => {
      expect(isConclusionIncomplete(body)).toBe(false);
      expect(isConclusionIncomplete(body, makeDeliveryContext(body, 'completed'))).toBe(false);
      expect(isConclusionIncomplete(body, makeDeliveryContext(body, 'incomplete'))).toBe(true);
    },
  );

  it('rejects an empty body while ignoring stale completion receipts', () => {
    expect(isConclusionIncomplete('')).toBe(true);
    const context = makeDeliveryContext('original', 'incomplete');
    expect(isConclusionIncomplete('changed body', context)).toBe(false);
    context.completion!.attemptId = 'different-attempt';
    expect(isConclusionIncomplete('original', context)).toBe(false);
    expect(isConclusionIncomplete('original', {entry: 'historical_restore'})).toBe(false);
  });
});

describe('verifyConclusion runtime-only diagnostics', () => {
  it.each([
    '42', '# Arbitrary heading\n42', 'VSync 对齐异常严重', '[CRITICAL] 50ms 80% 200MB',
    '因为 CPU 导致阻塞，所以需要因果链', 'No source reference', 'Foo.kt:L10-L20',
    'The provider returned an error while tracing the application',
  ])('does not infer content quality or authorship from words: %s', body => {
    return expect(verifyConclusion(Array.from({length: 8}, (_, index) => makeFinding({
      id: `finding-${index}`, severity: 'critical', description: body, evidence: [],
    })), body, {plan: makePlan(), sceneType: 'startup', query: 'Analyze everything',
      deliveryContext: makeDeliveryContext(body, 'completed')})).resolves.toMatchObject({
      passed: true, heuristicIssues: [],
    });
  });

  it('does not impose a source-reference prose format after source evidence was collected', async () => {
    const plan = makePlan();
    plan.toolCallLog.push({toolName: 'lookup_app_source', timestamp: 3, success: true,
      matchedPhaseId: 'phase-1', returnedCodeReferences: true});
    for (const body of ['Answer without CodeRef wording', 'Foo.kt:L10-L20', 'No source files exist']) {
      const result = await verifyConclusion([], body, {plan, deliveryContext: makeDeliveryContext(body, 'completed')});
      expect(result.heuristicIssues).toEqual([]);
    }
  });

  it('cannot replace a missing successful phase-bound receipt with a reassuring answer', async () => {
    const plan = makePlan();
    plan.toolCallLog[0].success = false;
    const body = 'All phases completed and all evidence verified';
    const result = await verifyConclusion([], body, {plan, deliveryContext: makeDeliveryContext(body, 'completed')});
    expect(result.passed).toBe(false);
    expect(result.heuristicIssues).toContainEqual(expect.objectContaining({type: 'plan_deviation', severity: 'error'}));
  });

  it('collects submitted-state failures alongside the native interruption', async () => {
    const body = 'Partial answer';
    const plan = makePlan();
    plan.toolCallLog = [];
    const result = await verifyConclusion([], body, {plan, deliveryContext: makeDeliveryContext(body, 'incomplete'),
      hypotheses: [{id: 'h1', statement: 'Already confirmed in prose', status: 'formed', formedAt: 1}]});
    expect(result.heuristicIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'plan_deviation'}),
      expect.objectContaining({type: 'unresolved_hypothesis'}),
      expect.objectContaining({type: 'truncation', recoveryKind: 'continue_output'}),
    ]));
  });

  it.each(['completed', 'incomplete', 'failed', 'cancelled'] as const)(
    'uses a current native terminal status: %s', async status => {
      const body = 'The exact same answer without punctuation';
      const result = await verifyConclusion([], body, {deliveryContext: makeDeliveryContext(body, status)});
      expect(result.passed).toBe(status === 'completed');
      expect(result.heuristicIssues.some(issue => issue.recoveryKind === 'continue_output')).toBe(status === 'incomplete');
    },
  );

  it('keeps missing, stale, unknown or unattributed completion unconfirmed without automatic recovery', async () => {
    const body = 'Complete report';
    const base = makeDeliveryContext(body, 'completed');
    const contexts: Array<AnalysisDeliveryContext | undefined> = [
      undefined, {entry: 'runtime_draft'}, {entry: 'historical_restore'},
      {...base, completion: undefined}, {...base, entry: 'runtime_draft', acceptedCandidate: undefined},
      {...base, outputOrigin: undefined}, {...base, outputOrigin: 'unsupported' as never},
      {...base, completion: {...base.completion!, status: 'unknown'}},
      {...base, completion: {...base.completion!, runId: 'old-run'}},
      {...base, completion: {...base.completion!, attemptId: 'old-attempt'}},
      {...base, completion: {...base.completion!, candidateRef: 'old-candidate'}},
      {...base, completion: {...base.completion!, conclusionFingerprint: analysisDeliveryFingerprint('another body')}},
    ];
    for (const deliveryContext of contexts) {
      const result = await verifyConclusion([], body, {deliveryContext});
      expect(result.passed).toBe(false);
      expect(result.heuristicIssues).toEqual([expect.objectContaining({type: 'missing_check', severity: 'error'})]);
      expect(result.heuristicIssues.every(issue => issue.recoveryKind === undefined)).toBe(true);
    }
  });

  it('rejects empty model output while requiring actual terminal authority for continuation', async () => {
    const completed = await verifyConclusion([], '  ', {deliveryContext: makeDeliveryContext('  ', 'completed')});
    expect(completed.heuristicIssues).toEqual([expect.objectContaining({type: 'missing_reasoning', recoveryKind: 'continue_output'})]);
    const absent = await verifyConclusion([], '  ');
    expect(absent.passed).toBe(false);
    expect(absent.heuristicIssues.every(issue => issue.recoveryKind === undefined)).toBe(true);
  });

  it('cannot treat a runtime fallback as a completed model answer', async () => {
    const body = 'A convincing report';
    const context = makeDeliveryContext(body, 'completed');
    context.outputOrigin = 'runtime_fallback';
    const result = await verifyConclusion([], body, {deliveryContext: context});
    expect(result.passed).toBe(false);
    expect(result.heuristicIssues.every(issue => issue.recoveryKind === undefined)).toBe(true);
  });

  it('only consumes current bound report coverage from the shared assessment', async () => {
    const body = 'Measured startup latency';
    const context = makeDeliveryContext(body, 'completed');
    addReportAssessment(context, 'missing');
    const missing = await verifyConclusion([], body, {deliveryContext: context});
    expect(missing.heuristicIssues).toEqual([expect.objectContaining({
      type: 'missing_reasoning', recoveryKind: 'complete_report_content',
      missingSections: [{id: 'measurement', label: 'Measurement semantics', description: 'State units and scope'}],
    })]);
    context.reportAssessment!.binding.attemptId = 'previous-attempt';
    expect((await verifyConclusion([], body, {deliveryContext: context})).heuristicIssues).toEqual([]);
    addReportAssessment(context, 'missing');
    context.completion = undefined;
    const unconfirmed = await verifyConclusion([], body, {deliveryContext: context});
    expect(unconfirmed.heuristicIssues.every(issue => issue.recoveryKind === undefined)).toBe(true);
  });

  it('never calls an auxiliary model or writes learned keywords even when legacy options request it', async () => {
    const body = 'VSync [CRITICAL] because blocked; source_lookup';
    const plan = makePlan();
    plan.toolCallLog = [];
    const result = await verifyConclusion([makeFinding({severity: 'critical', evidence: []})], body, {
      enableLLM: true, lightModel: 'fixture-model',
      verifierTimeoutMs: 1, providerId: 'fixture-provider', plan,
      deliveryContext: makeDeliveryContext(body, 'incomplete'),
    });
    expect(result.passed).toBe(false);
    expect(result.llmIssues).toBeUndefined();
    expect(sdkQuery).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('does not reclassify historical content through an auxiliary provider', async () => {
    await verifyConclusion([], 'Historical text', {deliveryContext: {entry: 'historical_restore'},
      enableLLM: true});
    expect(sdkQuery).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('emits only generic runtime progress and honors suppression', async () => {
    const emitted: StreamingUpdate[] = [];
    const options = {emitUpdate: (update: StreamingUpdate) => emitted.push(update)};
    await verifyConclusion([], '', options);
    expect(emitted).toEqual([expect.objectContaining({type: 'progress', content: expect.objectContaining({phase: 'concluding'})})]);
    emitted.length = 0;
    await verifyConclusion([], '', {...options, emitIssueProgress: false});
    expect(emitted).toEqual([]);
  });
});

type CurrentDeliveryContext = Exclude<AnalysisDeliveryContext, {entry: 'historical_restore'}>;

function makeDeliveryContext(body: string, status: AnalysisCompletion['status']): CurrentDeliveryContext {
  const candidate = {candidateRef: 'candidate-1', runId: 'run-1', attemptId: 'attempt-1',
    conclusionFingerprint: analysisDeliveryFingerprint(body)};
  return {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'claude-agent-sdk', status,
      ...(status === 'incomplete' ? {reason: 'output_limit'} : {})},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry',
      taskKind: 'investigation', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
      deliverable: 'report', evidenceAccess: 'existing_only'}, evidenceFingerprint: 'evidence-v1',
  };
}

function addReportAssessment(context: CurrentDeliveryContext, coverage: 'covered' | 'missing'): void {
  context.reportRequirements = {sceneId: 'general', registryFingerprint: 'registry', requirements: [
    {id: 'measurement', label: 'Measurement semantics', description: 'State units and scope', required: true},
  ]};
  context.reportAssessment = {schemaVersion: 1, status: 'checked', binding: {
    ...context.acceptedCandidate!, registryFingerprint: 'registry',
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    conclusionContractFingerprint: analysisDeliveryFingerprint(undefined), evidenceFingerprint: 'evidence-v1',
    requirementsFingerprint: reportRequirementsFingerprint(context.reportRequirements),
  }, requirements: [{requirementId: 'measurement', applicability: 'applicable', coverage,
    ...(coverage === 'covered' ? {contentLocations: [{start: 0, end: 1}]} : {})}]};
}
