/**
 * Test Fixtures Unit Tests
 *
 * Verifies that all mock factories produce valid mock objects.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  createMockModelRouter,
  createMockSessionContext,
  createMockMessageBus,
  createMockProgressEmitter,
  createMockCircuitBreaker,
  createMockAgentRegistry,
  createMockIntent,
  createMockFinding,
  createMockHypothesis,
  createMockSharedContext,
  createMockAgentResponse,
  createMockAgentTask,
  mockLLMResponses,
} from '../index';

describe('Test Fixtures', () => {
  describe('createMockModelRouter', () => {
    it('creates a mock with default options', async () => {
      const router = createMockModelRouter();

      expect(router.callWithFallback).toBeDefined();

      const result = await router.callWithFallback!('test prompt', 'general' as any);

      expect(result.success).toBe(true);
      expect(result.response).toBe('Mock LLM response');
      expect(result.modelId).toBe('test-model');
    });

    it('supports custom response', async () => {
      const router = createMockModelRouter({
        defaultResponse: 'Custom response',
      });

      const result = await router.callWithFallback!('test', 'general' as any);

      expect(result.response).toBe('Custom response');
    });

    it('supports function response', async () => {
      const router = createMockModelRouter({
        defaultResponse: (prompt) => `Echo: ${prompt.substring(0, 10)}`,
      });

      const result = await router.callWithFallback!('Hello World', 'general' as any);

      expect(result.response).toBe('Echo: Hello Worl');
    });

    it('supports JSON object response', async () => {
      const router = createMockModelRouter({
        defaultResponse: { key: 'value' },
      });

      const result = await router.callWithFallback!('test', 'general' as any);

      expect(JSON.parse(result.response)).toEqual({ key: 'value' });
    });

    it('can simulate failure', async () => {
      const router = createMockModelRouter({
        shouldSucceed: false,
      });

      await expect(router.callWithFallback!('test', 'general' as any)).rejects.toThrow(
        'Mock LLM error'
      );
    });
  });

  describe('createMockSessionContext', () => {
    it('creates a mock with default options', () => {
      const context = createMockSessionContext();

      expect(context.getAllTurns).toBeDefined();
      expect(context.getAllTurns!()).toHaveLength(0);
      expect(context.getAllFindings!()).toEqual([]);
    });

    it('supports custom turn count', () => {
      const context = createMockSessionContext({ turnCount: 5 });

      expect(context.getAllTurns!()).toHaveLength(5);
    });

    it('supports pre-populated findings', () => {
      const findings = [
        createMockFinding({ id: 'f1', title: 'Finding 1' }),
        createMockFinding({ id: 'f2', title: 'Finding 2' }),
      ];

      const context = createMockSessionContext({ findings });

      expect(context.getAllFindings!()).toHaveLength(2);
      expect(context.getFinding!('f1')?.title).toBe('Finding 1');
    });

    it('provides entity store', () => {
      const context = createMockSessionContext();
      const store = context.getEntityStore!();

      expect(store).toBeDefined();
      expect(store.getAllFrames()).toEqual([]);
    });
  });

  describe('createMockMessageBus', () => {
    it('creates a mock with default options', () => {
      const bus = createMockMessageBus();

      expect(bus.registerAgent).toBeDefined();
      expect(bus.dispatchTask).toBeDefined();
      expect(bus._getRegisteredAgentIds()).toEqual([]);
    });

    it('supports pre-registered agents', () => {
      const bus = createMockMessageBus({
        registeredAgents: ['agent1', 'agent2'],
      });

      expect(bus._getRegisteredAgentIds().sort()).toEqual(['agent1', 'agent2']);
      expect(bus._isAgentIdRegistered('agent1')).toBe(true);
      expect(bus._isAgentIdRegistered('agent3')).toBe(false);
    });

    it('supports dynamic agent registration', () => {
      const bus = createMockMessageBus();

      // Mock registration with an object that has config.id
      bus.registerAgent!({ config: { id: 'new_agent' } } as any);

      expect(bus._isAgentIdRegistered('new_agent')).toBe(true);
    });
  });

  describe('createMockProgressEmitter', () => {
    it('captures emitted updates', () => {
      const { emitter, emittedUpdates } = createMockProgressEmitter();

      emitter.emitUpdate('progress', { message: 'test' } as any);
      emitter.emitUpdate('finding', { round: 1, findings: [] });

      expect(emittedUpdates).toHaveLength(2);
      expect(emittedUpdates[0].type).toBe('progress');
      expect(emittedUpdates[1].type).toBe('finding');
    });

    it('captures log messages', () => {
      const { emitter, logs } = createMockProgressEmitter();

      emitter.log('Log message 1');
      emitter.log('Log message 2');

      expect(logs).toHaveLength(2);
      expect(logs[0]).toBe('Log message 1');
    });

    it('can disable capture', () => {
      const { emitter, emittedUpdates, logs } = createMockProgressEmitter({
        captureUpdates: false,
        captureLogs: false,
      });

      emitter.emitUpdate('progress', {});
      emitter.log('test');

      expect(emittedUpdates).toHaveLength(0);
      expect(logs).toHaveLength(0);
    });
  });

  describe('createMockCircuitBreaker', () => {
    it('creates a mock in closed state by default', () => {
      const breaker = createMockCircuitBreaker();

      expect(breaker.circuitState).toBe('closed');
      expect(breaker.isClosed).toBe(true);
      expect(breaker.isTripped).toBe(false);
    });

    it('can simulate open state', () => {
      const breaker = createMockCircuitBreaker({
        state: 'open',
        canExecute: false,
      });

      expect(breaker.circuitState).toBe('open');
      expect(breaker.isTripped).toBe(true);
      expect(breaker.canExecute!().action).toBe('ask_user');
    });

    it('can execute returns continue when closed', () => {
      const breaker = createMockCircuitBreaker();
      const decision = breaker.canExecute!();

      expect(decision.action).toBe('continue');
    });
  });

  describe('createMockAgentRegistry', () => {
    it('creates registry with default agents', () => {
      const registry = createMockAgentRegistry();

      expect(registry.getAgentIds()).toContain('frame_agent');
      expect(registry.getAgentIds()).toContain('cpu_agent');
      expect(registry.hasAgent('frame_agent')).toBe(true);
    });

    it('supports custom agent IDs', () => {
      const registry = createMockAgentRegistry({
        agentIds: ['custom_agent'],
      });

      expect(registry.getAgentIds()).toEqual(['custom_agent']);
      expect(registry.hasAgent('custom_agent')).toBe(true);
      expect(registry.hasAgent('frame_agent')).toBe(false);
    });

    it('provides executable agents', async () => {
      const registry = createMockAgentRegistry();
      const agent = registry.getAgent('frame_agent');

      expect(agent).toBeDefined();

      const result = await agent.execute({});

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('frame_agent');
    });
  });

  describe('createMockIntent', () => {
    it('creates intent with defaults', () => {
      const intent = createMockIntent();

      expect(intent.primaryGoal).toBe('分析滑动卡顿的根因');
      expect(intent.expectedOutputType).toBe('diagnosis');
      expect(intent.complexity).toBe('moderate');
      expect(intent.followUpType).toBe('initial');
    });

    it('supports custom values', () => {
      const intent = createMockIntent({
        primaryGoal: 'Analyze startup',
        complexity: 'complex',
        followUpType: 'drill_down',
      });

      expect(intent.primaryGoal).toBe('Analyze startup');
      expect(intent.complexity).toBe('complex');
      expect(intent.followUpType).toBe('drill_down');
    });
  });

  describe('createMockFinding', () => {
    it('creates finding with defaults', () => {
      const finding = createMockFinding();

      expect(finding.id).toBeDefined();
      expect(finding.severity).toBe('warning');
      expect(finding.title).toBe('Mock Finding');
    });

    it('supports custom values', () => {
      const finding = createMockFinding({
        id: 'custom-id',
        severity: 'critical',
        title: 'Custom Finding',
      });

      expect(finding.id).toBe('custom-id');
      expect(finding.severity).toBe('critical');
      expect(finding.title).toBe('Custom Finding');
    });
  });

  describe('createMockHypothesis', () => {
    it('creates hypothesis with defaults', () => {
      const hypothesis = createMockHypothesis();

      expect(hypothesis.id).toBeDefined();
      expect(hypothesis.status).toBe('proposed');
      expect(hypothesis.confidence).toBe(0.6);
      expect(hypothesis.supportingEvidence).toEqual([]);
    });

    it('supports custom values', () => {
      const hypothesis = createMockHypothesis({
        status: 'confirmed',
        confidence: 0.95,
      });

      expect(hypothesis.status).toBe('confirmed');
      expect(hypothesis.confidence).toBe(0.95);
    });
  });

  describe('createMockSharedContext', () => {
    it('creates shared context with defaults', () => {
      const context = createMockSharedContext();

      expect(context.sessionId).toBe('test-session-001');
      expect(context.traceId).toBe('test-trace-001');
      expect(context.confirmedFindings).toEqual([]);
    });

    it('supports pre-populated hypotheses', () => {
      const hypotheses = [createMockHypothesis({ id: 'h1' })];
      const context = createMockSharedContext({ hypotheses });

      expect(context.hypotheses.has('h1')).toBe(true);
    });
  });

  describe('createMockAgentResponse', () => {
    it('creates response with defaults', () => {
      const response = createMockAgentResponse();

      expect(response.agentId).toBe('frame_agent');
      expect(response.success).toBe(true);
      expect(response.confidence).toBe(0.8);
    });

    it('supports custom values', () => {
      const response = createMockAgentResponse({
        agentId: 'cpu_agent',
        success: false,
        confidence: 0.3,
      });

      expect(response.agentId).toBe('cpu_agent');
      expect(response.success).toBe(false);
      expect(response.confidence).toBe(0.3);
    });
  });

  describe('createMockAgentTask', () => {
    it('creates task with defaults', () => {
      const task = createMockAgentTask();

      expect(task.id).toBeDefined();
      expect(task.targetAgentId).toBe('frame_agent');
      expect(task.priority).toBe(1);
    });
  });

  describe('mockLLMResponses', () => {
    it('provides common response fixtures', () => {
      expect(mockLLMResponses.simpleConclusion).toBeDefined();
      expect(mockLLMResponses.structuredConclusion).toContain('## 结论');
      expect(mockLLMResponses.intentUnderstanding).toBeDefined();

      const intent = JSON.parse(mockLLMResponses.intentUnderstanding);
      expect(intent.primaryGoal).toBeDefined();
    });
  });
});
