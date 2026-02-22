import {
  applyBlockedStrategyIds,
  buildDecisionContextFromIntent,
  buildNativeClarifyFallback,
  buildNativeClarifyPrompt,
  buildRuntimeExecutionOptions,
  deriveRequestedDomainsFromIntent,
  mapFollowUpTypeToMode,
} from '../runtime/agentRuntime';
import { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import type { StrategyMatchResult } from '../../agent/strategies';

describe('AgentRuntime parity helpers', () => {
  it('maps follow-up types to operation modes', () => {
    expect(mapFollowUpTypeToMode('initial')).toBe('initial');
    expect(mapFollowUpTypeToMode('clarify')).toBe('clarify');
    expect(mapFollowUpTypeToMode('compare')).toBe('compare');
    expect(mapFollowUpTypeToMode('extend')).toBe('extend');
    expect(mapFollowUpTypeToMode('drill_down')).toBe('drill_down');
    expect(mapFollowUpTypeToMode(undefined)).toBe('initial');
  });

  it('derives domains from intent aspects and query text', () => {
    const domains = deriveRequestedDomainsFromIntent(
      {
        primaryGoal: 'analyze render bottleneck',
        aspects: ['frame pacing', 'cpu scheduling'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
        followUpType: 'initial',
      },
      'please check frame jank and cpu scheduling in this trace'
    );

    expect(domains).toContain('frame');
    expect(domains).toContain('cpu');
  });

  it('builds runtime execution options with resolved follow-up params and intervals', () => {
    const options = buildRuntimeExecutionOptions(
      { packageName: 'com.example.app', blockedStrategyIds: ['scene_reconstruction'] },
      {
        resolvedParams: { frame_id: 123, start_ts: '100', end_ts: '200' },
        confidence: 0.88,
      },
      [
        {
          id: 1,
          processName: 'com.example.app',
          startTs: '100',
          endTs: '200',
          priority: 1,
          label: 'frame 123',
        },
      ],
      {
        primaryGoal: 'drill down frame 123',
        aspects: ['frame'],
        expectedOutputType: 'diagnosis',
        complexity: 'simple',
        followUpType: 'drill_down',
      }
    );

    expect(options.resolvedFollowUpParams).toEqual({ frame_id: 123, start_ts: '100', end_ts: '200' });
    expect(options.prebuiltIntervals?.length).toBe(1);
    expect(options.suggestedStrategy?.id).toBe('drill_down');
    expect(options.blockedStrategyIds).toEqual(['scene_reconstruction']);
  });

  it('filters blocked strategy matches to fallback mode', () => {
    const match: StrategyMatchResult = {
      strategy: {
        id: 'scene_reconstruction',
        name: 'Scene Reconstruction',
        trigger: () => true,
        stages: [],
      },
      matchMethod: 'keyword',
      confidence: 1,
      shouldFallback: false,
    };

    const blocked = applyBlockedStrategyIds(match, ['scene_reconstruction']);
    expect(blocked?.strategy).toBeNull();
    expect(blocked?.shouldFallback).toBe(true);
    expect(blocked?.fallbackReason).toContain('blockedStrategyIds');

    const allowed = applyBlockedStrategyIds(match, ['scrolling']);
    expect(allowed?.strategy?.id).toBe('scene_reconstruction');
  });

  it('builds native clarify prompt and fallback text', () => {
    const prompt = buildNativeClarifyPrompt('why frame 123 janks?', 'session context', [
      {
        id: 'f1',
        severity: 'warning',
        title: 'Frame missed deadline',
        description: 'RenderThread blocked by binder wait',
      },
    ]);
    expect(prompt).toContain('why frame 123 janks?');
    expect(prompt).toContain('Frame missed deadline');

    const fallbackWithFinding = buildNativeClarifyFallback('why frame 123 janks?', [
      {
        id: 'f2',
        severity: 'critical',
        title: 'CPU starvation',
        description: 'Main thread runnable latency spikes',
      },
    ]);
    expect(fallbackWithFinding).toContain('CPU starvation');

    const fallbackWithoutFinding = buildNativeClarifyFallback('why frame 123 janks?', []);
    expect(fallbackWithoutFinding).toContain('缺少足够上下文');
  });

  it('builds decision context using session state and intent follow-up semantics', () => {
    const sessionContext = new EnhancedSessionContext('session-dc', 'trace-dc');
    sessionContext.setTraceAgentState({
      version: 1,
      sessionId: 'session-dc',
      traceId: 'trace-dc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      goal: { userGoal: 'analyze jank' },
      preferences: {
        maxExperimentsPerTurn: 3,
        defaultLoopMode: 'hypothesis_experiment',
        defaultResponseView: 'conclusion_evidence',
        language: 'zh',
        qualityFirst: true,
      },
      coverage: {
        entities: { frames: ['1'], sessions: ['2'] },
        timeRanges: [],
        domains: ['frame', 'cpu'],
        packages: [],
      },
      turnLog: [],
      hypotheses: [],
      evidence: [{ id: 'ev1', kind: 'tool', title: 'sample', digest: 'x', source: { stage: 's' }, createdAt: Date.now() }],
      experiments: [],
      contradictions: [{ id: 'cx1', description: 'conflict', severity: 'major', createdAt: Date.now(), evidenceIds: [], hypothesisIds: [], resolutionExperimentIds: [] }],
    });

    const context = buildDecisionContextFromIntent(
      'compare frame 1 and frame 2',
      sessionContext,
      {
        primaryGoal: 'compare two frames',
        aspects: ['frame', 'cpu scheduling'],
        expectedOutputType: 'comparison',
        complexity: 'moderate',
        followUpType: 'compare',
        referencedEntities: [
          { type: 'frame', id: 1 },
          { type: 'frame', id: 2 },
        ],
      },
      { isFollowUp: true, confidence: 0.8, resolvedParams: { frame_id: 1 } },
      [{ startTs: '100', endTs: '200' }]
    );

    expect(context.mode).toBe('compare');
    expect(context.coverageDomains).toEqual(['frame', 'cpu']);
    expect(context.evidenceCount).toBe(1);
    expect(context.contradictionCount).toBe(1);
    expect(context.requestedActions).toContain('compare_entities');
    expect(context.requestedActions).toContain('follow_up');
    expect(context.requestedActions).toContain('has_focus_intervals');
  });
});
