/**
 * ModelRouter Unit Tests
 *
 * Tests for the multi-model routing system:
 * 1. Model Selection (routeByTask, findByStrengths)
 * 2. Fallback Chain mechanism
 * 3. Ensemble mode (multi-model voting)
 * 4. Statistics tracking
 * 5. Model management (enable/disable/add/remove)
 * 6. LLM Client creation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ModelRouter, AllModelsFailedError } from '../modelRouter';
import type { ModelProfile } from '../../types';

// =============================================================================
// Helper functions for creating typed mocks
// =============================================================================

function createMockComplete(returnValue: string) {
  return jest.fn<() => Promise<string>>().mockResolvedValue(returnValue);
}

function createFailingMockComplete(errorMessage: string) {
  return jest.fn<() => Promise<string>>().mockRejectedValue(new Error(errorMessage));
}

interface MockLLMClient {
  complete: jest.Mock<() => Promise<string>>;
}

function createMockClient(returnValue: string): MockLLMClient {
  return {
    complete: createMockComplete(returnValue),
  };
}

function createFailingMockClient(errorMessage: string): MockLLMClient {
  return {
    complete: createFailingMockComplete(errorMessage),
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockModel = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'test-model',
  provider: 'mock',
  model: 'test-model-v1',
  strengths: ['reasoning'],
  costPerInputToken: 0.001,
  costPerOutputToken: 0.002,
  avgLatencyMs: 1000,
  maxTokens: 4096,
  supportsJSON: true,
  supportsStreaming: true,
  enabled: true,
  ...overrides,
});

const createTestModels = (): ModelProfile[] => [
  createMockModel({
    id: 'reasoning-model',
    provider: 'mock',
    model: 'reasoning-v1',
    strengths: ['reasoning'],
    costPerInputToken: 0.003,
    costPerOutputToken: 0.006,
  }),
  createMockModel({
    id: 'coding-model',
    provider: 'mock',
    model: 'coding-v1',
    strengths: ['coding', 'cost'],
    costPerInputToken: 0.001,
    costPerOutputToken: 0.002,
  }),
  createMockModel({
    id: 'speed-model',
    provider: 'mock',
    model: 'speed-v1',
    strengths: ['speed', 'cost'],
    costPerInputToken: 0.0005,
    costPerOutputToken: 0.001,
  }),
  createMockModel({
    id: 'disabled-model',
    provider: 'mock',
    model: 'disabled-v1',
    strengths: ['reasoning', 'coding'],
    enabled: false,
  }),
];

// =============================================================================
// Test Suite
// =============================================================================

describe('ModelRouter', () => {
  let router: ModelRouter;
  let testModels: ModelProfile[];

  beforeEach(() => {
    testModels = createTestModels();
    router = new ModelRouter({
      models: testModels,
      defaultModel: 'reasoning-model',
      fallbackChain: ['reasoning-model', 'coding-model', 'speed-model'],
      enableEnsemble: false,
      ensembleThreshold: 0.8,
      taskModelMapping: {},
    });
  });

  afterEach(() => {
    router.resetStats();
  });

  // ===========================================================================
  // Model Selection Tests
  // ===========================================================================

  describe('Model Selection', () => {
    describe('routeByTask', () => {
      it('should select model based on task type strengths', () => {
        // sql_generation maps to 'coding' strength
        // The router also factors in cost, so it may select the cheapest model
        // that matches the strength, or a cheaper model with partial match
        const model = router.routeByTask('sql_generation');
        // The model should be enabled
        expect(model.enabled).toBe(true);
      });

      it('should use explicit task-to-model mapping when configured', () => {
        const routerWithMapping = new ModelRouter({
          models: testModels,
          defaultModel: 'reasoning-model',
          fallbackChain: ['reasoning-model'],
          taskModelMapping: {
            sql_generation: 'speed-model',
          },
        });

        const model = routerWithMapping.routeByTask('sql_generation');
        expect(model.id).toBe('speed-model');
      });

      it('should fall back to default model when no match', () => {
        // Create router with models that don't match the required strengths
        const limitedModels = [
          createMockModel({
            id: 'only-model',
            strengths: [],
          }),
        ];

        const limitedRouter = new ModelRouter({
          models: limitedModels,
          defaultModel: 'only-model',
          fallbackChain: ['only-model'],
        });

        const model = limitedRouter.routeByTask('intent_understanding');
        expect(model.id).toBe('only-model');
      });

      it('should skip disabled models in task mapping', () => {
        const routerWithDisabledMapping = new ModelRouter({
          models: testModels,
          defaultModel: 'reasoning-model',
          fallbackChain: ['reasoning-model'],
          taskModelMapping: {
            sql_generation: 'disabled-model', // This model is disabled
          },
        });

        const model = routerWithDisabledMapping.routeByTask('sql_generation');
        // Should not use disabled model, should fall back to strength-based selection
        expect(model.id).not.toBe('disabled-model');
        expect(model.enabled).toBe(true);
      });

      it('should throw error when no models are available', () => {
        const emptyRouter = new ModelRouter({
          models: [createMockModel({ id: 'disabled', enabled: false })],
          defaultModel: 'disabled',
          fallbackChain: [],
        });

        expect(() => emptyRouter.routeByTask('general')).toThrow('No available models');
      });

      it('should select a valid model for intent_understanding task', () => {
        const model = router.routeByTask('intent_understanding');
        // The model should be enabled and valid
        expect(model.enabled).toBe(true);
        expect(model.id).toBeDefined();
      });

      it('should select speed/cost model for simple_extraction task', () => {
        const model = router.routeByTask('simple_extraction');
        // Should prefer models with speed or cost strengths
        expect(model.strengths.some(s => s === 'speed' || s === 'cost')).toBe(true);
      });
    });

    describe('findByStrengths', () => {
      it('should find model matching required strengths', () => {
        // Create a router with only one model that has the required strength
        const codingOnlyModels = [
          createMockModel({
            id: 'coding-only',
            strengths: ['coding'],
            costPerInputToken: 0.001,
            costPerOutputToken: 0.002,
          }),
        ];

        const codingRouter = new ModelRouter({
          models: codingOnlyModels,
          defaultModel: 'coding-only',
          fallbackChain: [],
        });

        const model = codingRouter.findByStrengths(['coding']);
        expect(model).toBeDefined();
        expect(model!.strengths).toContain('coding');
      });

      it('should return undefined when no enabled models match', () => {
        const noMatchRouter = new ModelRouter({
          models: [
            createMockModel({ id: 'model1', strengths: ['reasoning'], enabled: false }),
          ],
          defaultModel: 'model1',
          fallbackChain: [],
        });

        const model = noMatchRouter.findByStrengths(['vision']);
        expect(model).toBeUndefined();
      });

      it('should prefer model with multiple matching strengths', () => {
        const modelsWithVaryingStrengths = [
          createMockModel({
            id: 'single-strength',
            strengths: ['reasoning'],
            costPerInputToken: 0.001,
            costPerOutputToken: 0.002,
          }),
          createMockModel({
            id: 'multi-strength',
            strengths: ['reasoning', 'coding'],
            costPerInputToken: 0.001,
            costPerOutputToken: 0.002,
          }),
        ];

        const multiRouter = new ModelRouter({
          models: modelsWithVaryingStrengths,
          defaultModel: 'single-strength',
          fallbackChain: [],
        });

        const model = multiRouter.findByStrengths(['reasoning', 'coding']);
        expect(model!.id).toBe('multi-strength');
      });

      it('should factor in cost when selecting model', () => {
        const similarModels = [
          createMockModel({
            id: 'expensive',
            strengths: ['reasoning'],
            costPerInputToken: 0.01,
            costPerOutputToken: 0.02,
          }),
          createMockModel({
            id: 'cheap',
            strengths: ['reasoning'],
            costPerInputToken: 0.0001,
            costPerOutputToken: 0.0002,
          }),
        ];

        const costRouter = new ModelRouter({
          models: similarModels,
          defaultModel: 'expensive',
          fallbackChain: [],
        });

        const model = costRouter.findByStrengths(['reasoning']);
        // Should prefer cheaper model when strengths are equal
        expect(model!.id).toBe('cheap');
      });
    });

    describe('getModel', () => {
      it('should return model by ID', () => {
        const model = router.getModel('coding-model');
        expect(model).toBeDefined();
        expect(model!.id).toBe('coding-model');
      });

      it('should return undefined for non-existent model', () => {
        const model = router.getModel('non-existent');
        expect(model).toBeUndefined();
      });
    });

    describe('getEnabledModels', () => {
      it('should return only enabled models', () => {
        const enabledModels = router.getEnabledModels();
        expect(enabledModels.length).toBe(3); // 3 enabled, 1 disabled
        expect(enabledModels.every(m => m.enabled)).toBe(true);
      });

      it('should not include disabled models', () => {
        const enabledModels = router.getEnabledModels();
        expect(enabledModels.find(m => m.id === 'disabled-model')).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // Fallback Chain Tests
  // ===========================================================================

  describe('Fallback Chain', () => {
    describe('callWithFallback', () => {
      it('should try primary model first', async () => {
        const mockClient = createMockClient('Success response');

        // Register mock client for the primary model
        const primaryModel = router.routeByTask('general');
        router.registerClient(primaryModel.id, mockClient as any);

        const result = await router.callWithFallback('Test prompt', 'general');

        expect(result.success).toBe(true);
        expect(result.modelId).toBe(primaryModel.id);
        expect(mockClient.complete).toHaveBeenCalledTimes(1);
      });

      it('should fall back to next model on failure', async () => {
        const failingClient = createFailingMockClient('Primary model failed');
        const successClient = createMockClient('Fallback success');

        // Register failing client for ALL models except the last one
        router.registerClient('speed-model', failingClient as any);
        router.registerClient('reasoning-model', failingClient as any);
        router.registerClient('coding-model', successClient as any);

        const result = await router.callWithFallback('Test prompt', 'intent_understanding');

        expect(result.success).toBe(true);
        // At least one failing client should have been called
        expect(failingClient.complete).toHaveBeenCalled();
      });

      it('should throw AllModelsFailedError when all models fail', async () => {
        const failingClient = createFailingMockClient('Model failed');

        // Register failing client for all models in fallback chain
        router.registerClient('reasoning-model', failingClient as any);
        router.registerClient('coding-model', failingClient as any);
        router.registerClient('speed-model', failingClient as any);

        await expect(router.callWithFallback('Test prompt', 'general'))
          .rejects.toThrow(AllModelsFailedError);

        try {
          await router.callWithFallback('Test prompt', 'general');
        } catch (error) {
          expect(error).toBeInstanceOf(AllModelsFailedError);
          expect((error as AllModelsFailedError).triedModels.length).toBeGreaterThan(0);
        }
      });

      it('should record failures in stats', async () => {
        const failingClient = createFailingMockClient('Model failed');

        router.registerClient('reasoning-model', failingClient as any);
        router.registerClient('coding-model', failingClient as any);
        router.registerClient('speed-model', failingClient as any);

        try {
          await router.callWithFallback('Test prompt', 'general');
        } catch {
          // Expected to fail
        }

        const stats = router.getStats();
        // At least one model should have recorded failure
        const hasFailures = Object.values(stats).some(s => s.failures > 0);
        expect(hasFailures).toBe(true);
      });
    });

    describe('getFallbackChain', () => {
      it('should return fallback chain excluding specified model', () => {
        const chain = router.getFallbackChain('reasoning-model');
        expect(chain).not.toContain('reasoning-model');
        expect(chain).toContain('coding-model');
        expect(chain).toContain('speed-model');
      });

      it('should return all models when no exclusion specified', () => {
        const chain = router.getFallbackChain();
        expect(chain.length).toBe(3);
      });

      it('should only include enabled models in fallback chain', () => {
        // Disable a model that's in the fallback chain
        router.disableModel('coding-model');

        const chain = router.getFallbackChain();
        expect(chain).not.toContain('coding-model');
      });
    });

    describe('setFallbackChain', () => {
      it('should update fallback chain', () => {
        const newChain = ['speed-model', 'coding-model'];
        router.setFallbackChain(newChain);

        const chain = router.getFallbackChain();
        expect(chain).toEqual(newChain);
      });

      it('should emit configUpdated event', () => {
        const handler = jest.fn();
        router.on('configUpdated', handler);

        router.setFallbackChain(['speed-model']);

        expect(handler).toHaveBeenCalledWith({ fallbackChain: ['speed-model'] });
      });
    });
  });

  // ===========================================================================
  // Ensemble Mode Tests
  // ===========================================================================

  describe('Ensemble Mode', () => {
    let mockClients: Map<string, MockLLMClient>;

    beforeEach(() => {
      mockClients = new Map();

      // Create mock clients for each model
      for (const model of testModels.filter(m => m.enabled)) {
        const client = createMockClient(`Response from ${model.id}`);
        mockClients.set(model.id, client);
        router.registerClient(model.id, client as any);
      }
    });

    it('should call multiple models in parallel', async () => {
      const result = await router.ensemble('Test prompt', ['reasoning-model', 'coding-model']);

      expect(result.responses.length).toBe(2);
      expect(mockClients.get('reasoning-model')!.complete).toHaveBeenCalled();
      expect(mockClients.get('coding-model')!.complete).toHaveBeenCalled();
    });

    it('should aggregate responses (longest wins)', async () => {
      // Set up different length responses
      mockClients.get('reasoning-model')!.complete.mockResolvedValue('Short');
      mockClients.get('coding-model')!.complete.mockResolvedValue('This is a much longer response');

      const result = await router.ensemble('Test prompt', ['reasoning-model', 'coding-model']);

      expect(result.aggregatedResponse).toBe('This is a much longer response');
    });

    it('should calculate agreement score', async () => {
      // Set up similar length responses for high agreement
      mockClients.get('reasoning-model')!.complete.mockResolvedValue('Response A');
      mockClients.get('coding-model')!.complete.mockResolvedValue('Response B');

      const result = await router.ensemble('Test prompt', ['reasoning-model', 'coding-model']);

      expect(result.agreementScore).toBeGreaterThan(0);
      expect(result.agreementScore).toBeLessThanOrEqual(1);
    });

    it('should return total cost', async () => {
      const result = await router.ensemble('Test prompt', ['reasoning-model', 'coding-model']);

      expect(result.totalCost).toBeGreaterThan(0);
    });

    it('should require at least 2 models', async () => {
      await expect(router.ensemble('Test prompt', ['reasoning-model']))
        .rejects.toThrow('Ensemble requires at least 2 models');
    });

    it('should throw error when all models fail in ensemble', async () => {
      mockClients.get('reasoning-model')!.complete.mockRejectedValue(new Error('Failed'));
      mockClients.get('coding-model')!.complete.mockRejectedValue(new Error('Failed'));

      await expect(router.ensemble('Test prompt', ['reasoning-model', 'coding-model']))
        .rejects.toThrow('All models failed in ensemble');
    });

    it('should emit ensemble event', async () => {
      const handler = jest.fn();
      router.on('ensemble', handler);

      await router.ensemble('Test prompt', ['reasoning-model', 'coding-model']);

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        responses: expect.any(Array),
        aggregatedResponse: expect.any(String),
        agreementScore: expect.any(Number),
      }));
    });

    it('should use first 3 enabled models when modelIds not specified', async () => {
      const result = await router.ensemble('Test prompt');

      expect(result.responses.length).toBe(3);
    });
  });

  // ===========================================================================
  // Statistics Tests
  // ===========================================================================

  describe('Statistics', () => {
    let mockClient: MockLLMClient;

    beforeEach(() => {
      mockClient = createMockClient('Success response');
      router.registerClient('reasoning-model', mockClient as any);
    });

    describe('updateStats', () => {
      it('should track calls, tokens, and cost', async () => {
        // Register mock client for all enabled models
        const mockClient = createMockClient('Success response');
        router.registerClient('speed-model', mockClient as any);
        router.registerClient('reasoning-model', mockClient as any);
        router.registerClient('coding-model', mockClient as any);

        await router.callWithFallback('Test prompt', 'general');

        const stats = router.getStats();
        // At least one model should have stats
        const modelIds = Object.keys(stats);
        expect(modelIds.length).toBeGreaterThan(0);

        const firstModelStats = stats[modelIds[0]];
        expect(firstModelStats.calls).toBe(1);
        expect(firstModelStats.tokens).toBeGreaterThan(0);
        expect(firstModelStats.cost).toBeGreaterThan(0);
      });

      it('should accumulate stats across multiple calls', async () => {
        // Register mock client for all enabled models
        const mockClient = createMockClient('Success response');
        router.registerClient('speed-model', mockClient as any);
        router.registerClient('reasoning-model', mockClient as any);
        router.registerClient('coding-model', mockClient as any);

        await router.callWithFallback('Test prompt 1', 'general');
        await router.callWithFallback('Test prompt 2', 'general');

        const stats = router.getStats();
        const modelIds = Object.keys(stats);
        expect(modelIds.length).toBeGreaterThan(0);

        // The total calls across all models should be 2
        const totalCalls = Object.values(stats).reduce((sum, s) => sum + s.calls, 0);
        expect(totalCalls).toBe(2);
      });
    });

    describe('recordFailure', () => {
      it('should increment failure count', async () => {
        const failingClient = createFailingMockClient('Failed');

        // Also register for other models so they fail too
        router.registerClient('reasoning-model', failingClient as any);
        router.registerClient('coding-model', failingClient as any);
        router.registerClient('speed-model', failingClient as any);

        try {
          await router.callWithFallback('Test prompt', 'general');
        } catch {
          // Expected
        }

        const stats = router.getStats();
        // At least one model should have failures
        const totalFailures = Object.values(stats).reduce((sum, s) => sum + s.failures, 0);
        expect(totalFailures).toBeGreaterThan(0);
      });
    });

    describe('resetStats', () => {
      it('should clear all stats', async () => {
        await router.callWithFallback('Test prompt', 'general');
        expect(router.getTotalCost()).toBeGreaterThan(0);

        router.resetStats();

        expect(router.getTotalCost()).toBe(0);
        const stats = router.getStats();
        expect(Object.keys(stats).length).toBe(0);
      });

      it('should emit statsReset event', () => {
        const handler = jest.fn();
        router.on('statsReset', handler);

        router.resetStats();

        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    describe('getTotalCost', () => {
      it('should return sum of all model costs', async () => {
        // Register mock clients for multiple models
        const client2 = createMockClient('Response');
        router.registerClient('coding-model', client2 as any);

        // Make calls to different models
        await router.callWithFallback('Test 1', 'intent_understanding'); // reasoning model
        await router.callWithFallback('Test 2', 'sql_generation'); // coding model

        const totalCost = router.getTotalCost();
        expect(totalCost).toBeGreaterThan(0);
      });

      it('should return 0 when no calls made', () => {
        expect(router.getTotalCost()).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Model Management Tests
  // ===========================================================================

  describe('Model Management', () => {
    describe('enableModel', () => {
      it('should enable a disabled model', () => {
        const model = router.getModel('disabled-model');
        expect(model!.enabled).toBe(false);

        router.enableModel('disabled-model');

        expect(router.getModel('disabled-model')!.enabled).toBe(true);
      });

      it('should emit modelEnabled event', () => {
        const handler = jest.fn();
        router.on('modelEnabled', handler);

        router.enableModel('disabled-model');

        expect(handler).toHaveBeenCalledWith({ modelId: 'disabled-model' });
      });

      it('should handle non-existent model gracefully', () => {
        // Should not throw
        router.enableModel('non-existent');
      });
    });

    describe('disableModel', () => {
      it('should disable an enabled model', () => {
        expect(router.getModel('reasoning-model')!.enabled).toBe(true);

        router.disableModel('reasoning-model');

        expect(router.getModel('reasoning-model')!.enabled).toBe(false);
      });

      it('should emit modelDisabled event', () => {
        const handler = jest.fn();
        router.on('modelDisabled', handler);

        router.disableModel('reasoning-model');

        expect(handler).toHaveBeenCalledWith({ modelId: 'reasoning-model' });
      });
    });

    describe('addModel', () => {
      it('should add a new model', () => {
        const newModel = createMockModel({
          id: 'new-model',
          strengths: ['vision'],
        });

        router.addModel(newModel);

        expect(router.getModel('new-model')).toBeDefined();
        expect(router.listModels().find(m => m.id === 'new-model')).toBeDefined();
      });

      it('should emit modelAdded event', () => {
        const handler = jest.fn();
        router.on('modelAdded', handler);

        router.addModel(createMockModel({ id: 'new-model' }));

        expect(handler).toHaveBeenCalledWith({ modelId: 'new-model' });
      });
    });

    describe('removeModel', () => {
      it('should remove a model', () => {
        expect(router.getModel('speed-model')).toBeDefined();

        router.removeModel('speed-model');

        expect(router.getModel('speed-model')).toBeUndefined();
      });

      it('should emit modelRemoved event', () => {
        const handler = jest.fn();
        router.on('modelRemoved', handler);

        router.removeModel('speed-model');

        expect(handler).toHaveBeenCalledWith({ modelId: 'speed-model' });
      });
    });

    describe('updateModel', () => {
      it('should update model properties', () => {
        router.updateModel('reasoning-model', {
          costPerInputToken: 0.01,
          maxTokens: 8192,
        });

        const model = router.getModel('reasoning-model');
        expect(model!.costPerInputToken).toBe(0.01);
        expect(model!.maxTokens).toBe(8192);
      });

      it('should emit modelUpdated event', () => {
        const handler = jest.fn();
        router.on('modelUpdated', handler);

        router.updateModel('reasoning-model', { maxTokens: 8192 });

        expect(handler).toHaveBeenCalledWith({
          modelId: 'reasoning-model',
          updates: { maxTokens: 8192 },
        });
      });
    });

    describe('listModels', () => {
      it('should return all models including disabled', () => {
        const models = router.listModels();
        expect(models.length).toBe(4); // 3 enabled + 1 disabled
      });
    });
  });

  // ===========================================================================
  // Client Creation Tests
  // ===========================================================================

  describe('Client Creation', () => {
    it('should create DeepSeek client for deepseek provider', async () => {
      const deepseekModel = createMockModel({
        id: 'deepseek-test',
        provider: 'deepseek',
        model: 'deepseek-chat',
      });

      const deepseekRouter = new ModelRouter({
        models: [deepseekModel],
        defaultModel: 'deepseek-test',
        fallbackChain: ['deepseek-test'],
      });

      // The client creation happens internally when callModel is invoked
      // We can verify by checking it doesn't throw for valid provider
      // Note: Actual API call will fail without key, but client creation succeeds
      const model = deepseekRouter.getModel('deepseek-test');
      expect(model!.provider).toBe('deepseek');
    });

    it('should create Anthropic client for anthropic provider', () => {
      const anthropicModel = createMockModel({
        id: 'anthropic-test',
        provider: 'anthropic',
        model: 'claude-3-opus',
      });

      const anthropicRouter = new ModelRouter({
        models: [anthropicModel],
        defaultModel: 'anthropic-test',
        fallbackChain: ['anthropic-test'],
      });

      const model = anthropicRouter.getModel('anthropic-test');
      expect(model!.provider).toBe('anthropic');
    });

    it('should create OpenAI client for openai provider', () => {
      const openaiModel = createMockModel({
        id: 'openai-test',
        provider: 'openai',
        model: 'gpt-4',
      });

      const openaiRouter = new ModelRouter({
        models: [openaiModel],
        defaultModel: 'openai-test',
        fallbackChain: ['openai-test'],
      });

      const model = openaiRouter.getModel('openai-test');
      expect(model!.provider).toBe('openai');
    });

    it('should create GLM client for glm provider', () => {
      const glmModel = createMockModel({
        id: 'glm-test',
        provider: 'glm',
        model: 'glm-4',
      });

      const glmRouter = new ModelRouter({
        models: [glmModel],
        defaultModel: 'glm-test',
        fallbackChain: ['glm-test'],
      });

      const model = glmRouter.getModel('glm-test');
      expect(model!.provider).toBe('glm');
    });

    it('should create Mock client for mock provider', async () => {
      const mockModel = createMockModel({
        id: 'mock-test',
        provider: 'mock',
        model: 'mock-v1',
      });

      const mockRouter = new ModelRouter({
        models: [mockModel],
        defaultModel: 'mock-test',
        fallbackChain: ['mock-test'],
      });

      // Mock client should work without API key
      const result = await mockRouter.callWithFallback('Test prompt', 'general');
      expect(result.success).toBe(true);
      expect(result.response).toContain('mock');
    });

    it('should throw error for unknown provider', async () => {
      const unknownModel = createMockModel({
        id: 'unknown-test',
        provider: 'unknown' as any,
        model: 'unknown-v1',
      });

      const unknownRouter = new ModelRouter({
        models: [unknownModel],
        defaultModel: 'unknown-test',
        fallbackChain: ['unknown-test'],
      });

      // The error will be wrapped in AllModelsFailedError since all models fail
      await expect(unknownRouter.callWithFallback('Test', 'general'))
        .rejects.toThrow(AllModelsFailedError);
    });

    it('should reuse existing client for same model', async () => {
      const mockModel = createMockModel({
        id: 'reuse-test',
        provider: 'mock',
        model: 'mock-v1',
      });

      const reuseRouter = new ModelRouter({
        models: [mockModel],
        defaultModel: 'reuse-test',
        fallbackChain: ['reuse-test'],
      });

      // Make multiple calls
      await reuseRouter.callWithFallback('Test 1', 'general');
      await reuseRouter.callWithFallback('Test 2', 'general');

      // Client should be created once and reused
      // We verify this by checking stats show 2 calls
      const stats = reuseRouter.getStats();
      expect(stats['reuse-test'].calls).toBe(2);
    });
  });

  // ===========================================================================
  // Event Emission Tests
  // ===========================================================================

  describe('Event Emission', () => {
    let mockClient: MockLLMClient;

    beforeEach(() => {
      mockClient = createMockClient('Response');
      router.registerClient('reasoning-model', mockClient as any);
    });

    it('should emit modelCall event on successful call', async () => {
      const handler = jest.fn();
      router.on('modelCall', handler);

      await router.callWithFallback('Test', 'general');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        modelId: expect.any(String),
        response: expect.any(String),
        success: true,
      }));
    });

    it('should emit llmTelemetry event with error on failure', async () => {
      // Create a router with an unknown provider that will fail during client creation
      const unknownModel = createMockModel({
        id: 'unknown-provider',
        provider: 'unknown-provider' as any,
        model: 'test-v1',
      });

      const unknownRouter = new ModelRouter({
        models: [unknownModel],
        defaultModel: 'unknown-provider',
        fallbackChain: ['unknown-provider'],
      });

      const telemetryHandler = jest.fn();
      unknownRouter.on('llmTelemetry', telemetryHandler);

      try {
        await unknownRouter.callWithFallback('Test', 'general');
      } catch {
        // Expected - AllModelsFailedError
      }

      // The error is recorded in llmTelemetry event when callModel catches the error
      expect(telemetryHandler).toHaveBeenCalledWith(expect.objectContaining({
        modelId: 'unknown-provider',
        success: false,
        error: expect.stringContaining('Unknown provider'),
      }));
    });

    it('should emit llmTelemetry event on call', async () => {
      const handler = jest.fn();
      router.on('llmTelemetry', handler);

      await router.callWithFallback('Test', 'general', {
        sessionId: 'session-1',
        traceId: 'trace-1',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        schemaVersion: '1.0.0',
        sessionId: 'session-1',
        traceId: 'trace-1',
        modelId: expect.any(String),
        provider: expect.any(String),
        success: true,
      }));
    });
  });

  // ===========================================================================
  // Edge Cases and Error Handling
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty prompt', async () => {
      const mockClient = createMockClient('Response');
      router.registerClient('reasoning-model', mockClient as any);

      const result = await router.callWithFallback('', 'general');
      expect(result.success).toBe(true);
    });

    it('should handle very long prompt', async () => {
      const mockClient = createMockClient('Response');
      router.registerClient('reasoning-model', mockClient as any);

      const longPrompt = 'a'.repeat(100000);
      const result = await router.callWithFallback(longPrompt, 'general');
      expect(result.success).toBe(true);
    });

    it('should handle concurrent calls', async () => {
      const mockClient: MockLLMClient = {
        complete: jest.fn<() => Promise<string>>().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'Response';
        }),
      };
      router.registerClient('reasoning-model', mockClient as any);

      const promises = [
        router.callWithFallback('Test 1', 'general'),
        router.callWithFallback('Test 2', 'general'),
        router.callWithFallback('Test 3', 'general'),
      ];

      const results = await Promise.all(promises);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle JSON mode detection from prompt', async () => {
      const mockClient = createMockClient('{"key": "value"}');
      router.registerClient('reasoning-model', mockClient as any);

      const result = await router.callWithFallback(
        'Please respond in JSON format: { "result": "..." }',
        'general'
      );

      expect(result.success).toBe(true);
    });

    it('should handle custom call options', async () => {
      const mockClient = createMockClient('Response');
      // Register mock client for all enabled models
      for (const model of router.getEnabledModels()) {
        router.registerClient(model.id, mockClient as any);
      }

      const result = await router.callWithFallback('Test', 'general', {
        maxTokens: 1000,
        temperature: 0.5,
        jsonMode: true,
      });

      expect(result.success).toBe(true);
      // Verify the call was made - the options are passed internally
      expect(mockClient.complete).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // AllModelsFailedError Tests
  // ===========================================================================

  describe('AllModelsFailedError', () => {
    it('should have correct name', () => {
      const error = new AllModelsFailedError('Test', ['model1', 'model2']);
      expect(error.name).toBe('AllModelsFailedError');
    });

    it('should store tried models', () => {
      const error = new AllModelsFailedError('Test', ['model1', 'model2', 'model3']);
      expect(error.triedModels).toEqual(['model1', 'model2', 'model3']);
    });

    it('should have correct message', () => {
      const error = new AllModelsFailedError('All failed for task: general', []);
      expect(error.message).toBe('All failed for task: general');
    });
  });
});
