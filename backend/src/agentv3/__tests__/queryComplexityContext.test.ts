// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { buildComplexityClassifierInput } from '../queryComplexityContext';
import {AnalysisHistoryContextBudgetError, toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {buildAnalysisTurnIntentPrompt} from '../queryComplexityPrompt';

describe('buildComplexityClassifierInput', () => {
  it('fails closed instead of classifying with silently missing nonempty history', () => {
    const history = [toAnalysisHistoryTurn({id: 'PRIVATE_HISTORY_ID'.repeat(1000), turnIndex: 0, timestamp: 1,
      traceId: 'trace', query: 'PRIVATE_QUESTION', result: {message: 'PRIVATE_ANSWER'}})];
    expect(() => buildComplexityClassifierInput({query: 'Continue', sceneType: 'general',
      hasReferenceTrace: false, history})).toThrow(AnalysisHistoryContextBudgetError);
    expect(buildComplexityClassifierInput({query: 'First question', sceneType: 'general',
      hasReferenceTrace: false, history: []}).historyContext).toBe('');
  });
  it('only uses bounded scoped typed history and carries unfinished state into the actual intent prompt', () => {
    const history = [toAnalysisHistoryTurn({id: 'run-1', turnIndex: 0, timestamp: 1, traceId: 'trace', query: 'prior',
      result: {message: 'Partial answer', completion: {status: 'incomplete', reason: 'turn_limit'},
        conclusionContract: {uncertainties: ['GPU unavailable'], nextSteps: ['Inspect fence']}}})];
    const input = buildComplexityClassifierInput({query: 'continue', sceneType: 'general', hasReferenceTrace: false,
      history, previousTurns: [{query: 'PRIVATE_OLD_QUERY', findings: [{title: 'PRIVATE_OLD_FINDING'} as any]}]});
    expect(input.historyContext).toContain('turn_limit');
    expect(input.historyContext).toContain('GPU unavailable');
    expect(input.previousFindings).toEqual([]);
    const prompt = buildAnalysisTurnIntentPrompt({context: {...input, previousQueries: ['PRIVATE_OLD_QUERY'],
      previousFindingDetails: [{turnIndex: 0, title: 'PRIVATE_OLD_FINDING'}]},
      strategyRegistry: {getAllStrategies: () => []} as any, template: '{{requestContext}}', decisionSchema: {}});
    expect(prompt).toContain('turn_limit');
    expect(prompt).not.toContain('PRIVATE_OLD');
    expect(Buffer.byteLength(input.historyContext!)).toBeLessThanOrEqual(6000);
    expect(buildComplexityClassifierInput({query: 'new', sceneType: 'general', hasReferenceTrace: false, history: [],
      previousTurns: [{query: 'PRIVATE_OLD'}]})).toMatchObject({historyContext: '', previousQueries: [], previousFindings: []});
  });
  it('bounds prior full/finding signals to the recent turn window', () => {
    const input = buildComplexityClassifierInput({
      query: 'trace 时长多少',
      sceneType: 'general',
      hasReferenceTrace: false,
      previousTurns: [
        {
          query: '很久以前分析滑动性能',
          intent: { complexity: 'complex' },
          findings: [{ id: 'old', title: 'old jank', description: 'old', severity: 'high', confidence: 0.9 }],
        },
        { query: '谢谢', intent: { complexity: 'simple' }, findings: [] },
        { query: '包名是什么', intent: { complexity: 'simple' }, findings: [] },
        { query: 'trace 时长多少', intent: { complexity: 'simple' }, findings: [] },
      ],
    });

    expect(input.hasPriorFullAnalysis).toBe(false);
    expect(input.hasExistingFindings).toBe(false);
    expect(input.previousQueries).toEqual(['谢谢', '包名是什么', 'trace 时长多少']);
    expect(input.previousFindings).toEqual([]);
  });

  it('includes compact recent finding summaries from recent full turns', () => {
    const input = buildComplexityClassifierInput({
      query: '上面第 2 个发现继续看根因',
      sceneType: 'scrolling',
      hasReferenceTrace: false,
      previousTurns: [
        { query: 'trace 时长多少', intent: { complexity: 'simple' }, findings: [] },
        {
          query: '分析滑动性能',
          intent: { complexity: 'complex' },
          findings: [
            {
              id: 'f1',
              title: 'RenderThread heavy frame',
              description: 'render thread work overlaps a jank frame',
              category: 'render',
              severity: 'medium',
              confidence: 0.8,
            },
            {
              id: 'f2',
              title: 'Binder wait overlaps jank',
              description: 'binder wait overlaps a jank frame',
              category: 'binder',
              severity: 'high',
              confidence: 0.9,
            },
          ],
        },
      ],
    });

    expect(input.hasPriorFullAnalysis).toBe(true);
    expect(input.hasExistingFindings).toBe(true);
    expect(input.previousFindings).toEqual([
      'RenderThread heavy frame | category=render | severity=medium',
      'Binder wait overlaps jank | category=binder | severity=high',
    ]);
  });
});
