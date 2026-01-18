/**
 * SmartPerfetto Multi-Model Router
 *
 * 多模型路由组件，负责：
 * 1. 按任务类型选择最适合的模型
 * 2. 故障转移和自动切换
 * 3. 多模型投票 (ensemble)
 * 4. 成本和延迟跟踪
 */

import { EventEmitter } from 'events';
import {
  ModelProvider,
  ModelStrength,
  TaskType,
  ModelProfile,
  ModelRouterConfig,
  ModelCallResult,
  EnsembleResult,
} from '../types';

// 默认模型配置
const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    model: 'deepseek-chat',
    strengths: ['reasoning', 'coding', 'cost'],
    costPerInputToken: 0.00014,
    costPerOutputToken: 0.00028,
    avgLatencyMs: 1500,
    maxTokens: 8192,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: true,
  },
  {
    id: 'deepseek-coder',
    provider: 'deepseek',
    model: 'deepseek-coder',
    strengths: ['coding', 'cost'],
    costPerInputToken: 0.00014,
    costPerOutputToken: 0.00028,
    avgLatencyMs: 1200,
    maxTokens: 8192,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: true,
  },
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    strengths: ['reasoning', 'coding'],
    costPerInputToken: 0.003,
    costPerOutputToken: 0.015,
    avgLatencyMs: 2000,
    maxTokens: 8192,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: false, // 默认禁用，需要配置 API key
  },
  {
    id: 'claude-haiku',
    provider: 'anthropic',
    model: 'claude-haiku-4-20250514',
    strengths: ['speed', 'cost'],
    costPerInputToken: 0.00025,
    costPerOutputToken: 0.00125,
    avgLatencyMs: 500,
    maxTokens: 8192,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: false,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    strengths: ['reasoning', 'vision'],
    costPerInputToken: 0.0025,
    costPerOutputToken: 0.01,
    avgLatencyMs: 1800,
    maxTokens: 4096,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: false,
  },
  {
    id: 'glm-4',
    provider: 'glm',
    model: 'glm-4',
    strengths: ['reasoning', 'coding', 'cost'],
    costPerInputToken: 0.0001,  // 约 0.1 元/千 tokens
    costPerOutputToken: 0.0001,
    avgLatencyMs: 1500,
    maxTokens: 8192,
    supportsJSON: true,
    supportsStreaming: true,
    enabled: true,  // 已配置 API key，默认启用
  },
];

// 任务类型到模型强项的映射
const TASK_STRENGTH_MAPPING: Record<TaskType, ModelStrength[]> = {
  intent_understanding: ['reasoning'],
  planning: ['reasoning'],
  synthesis: ['reasoning'],
  evaluation: ['reasoning'],
  sql_generation: ['coding'],
  code_analysis: ['coding'],
  simple_extraction: ['speed', 'cost'],
  formatting: ['speed', 'cost'],
  general: ['reasoning'],
};

// 默认配置
const DEFAULT_CONFIG: Partial<ModelRouterConfig> = {
  defaultModel: 'glm-4',  // 使用 GLM 作为默认模型
  fallbackChain: ['glm-4', 'deepseek-chat', 'deepseek-coder'],
  enableEnsemble: false,
  ensembleThreshold: 0.8,
  taskModelMapping: {},
};

/**
 * 模型路由器实现
 */
export class ModelRouter extends EventEmitter {
  private config: ModelRouterConfig;
  private models: Map<string, ModelProfile>;
  private callStats: Map<string, { calls: number; tokens: number; cost: number; failures: number }>;
  private llmClients: Map<string, LLMClientInterface>;

  constructor(config: Partial<ModelRouterConfig> = {}) {
    super();

    // 初始化模型列表
    const models = config.models || DEFAULT_MODELS;

    this.config = {
      models,
      defaultModel: config.defaultModel || DEFAULT_CONFIG.defaultModel!,
      taskModelMapping: config.taskModelMapping || {},
      fallbackChain: config.fallbackChain || DEFAULT_CONFIG.fallbackChain!,
      enableEnsemble: config.enableEnsemble ?? false,
      ensembleThreshold: config.ensembleThreshold ?? 0.8,
    };

    // 构建模型索引
    this.models = new Map();
    for (const model of models) {
      this.models.set(model.id, model);
    }

    // 初始化统计
    this.callStats = new Map();

    // LLM 客户端存储
    this.llmClients = new Map();
  }

  // ==========================================================================
  // 模型选择
  // ==========================================================================

  /**
   * 按任务类型选择模型
   */
  routeByTask(taskType: TaskType): ModelProfile {
    // 1. 检查是否有显式映射
    const mappedModelId = this.config.taskModelMapping[taskType];
    if (mappedModelId) {
      const model = this.models.get(mappedModelId);
      if (model && model.enabled) {
        return model;
      }
    }

    // 2. 根据任务所需强项查找最佳模型
    const requiredStrengths = TASK_STRENGTH_MAPPING[taskType] || ['reasoning'];
    const bestModel = this.findByStrengths(requiredStrengths);

    if (bestModel) {
      return bestModel;
    }

    // 3. 回退到默认模型
    const defaultModel = this.models.get(this.config.defaultModel);
    if (defaultModel && defaultModel.enabled) {
      return defaultModel;
    }

    // 4. 返回第一个可用模型
    for (const model of this.models.values()) {
      if (model.enabled) {
        return model;
      }
    }

    throw new Error('No available models');
  }

  /**
   * 根据强项查找最佳模型
   */
  findByStrengths(requiredStrengths: ModelStrength[]): ModelProfile | undefined {
    let bestModel: ModelProfile | undefined;
    let bestScore = -1;

    for (const model of this.models.values()) {
      if (!model.enabled) continue;

      // 计算匹配分数
      let score = 0;
      for (const strength of requiredStrengths) {
        if (model.strengths.includes(strength)) {
          score += 1;
        }
      }

      // 成本因素（越低越好）
      const costFactor = 1 / (model.costPerInputToken + model.costPerOutputToken + 0.001);
      score += costFactor * 0.1;

      if (score > bestScore) {
        bestScore = score;
        bestModel = model;
      }
    }

    return bestModel;
  }

  /**
   * 获取指定模型
   */
  getModel(modelId: string): ModelProfile | undefined {
    return this.models.get(modelId);
  }

  /**
   * 获取所有已启用的模型
   */
  getEnabledModels(): ModelProfile[] {
    return Array.from(this.models.values()).filter(m => m.enabled);
  }

  // ==========================================================================
  // 模型调用
  // ==========================================================================

  /**
   * 带故障转移的模型调用
   */
  async callWithFallback(
    prompt: string,
    taskType: TaskType,
    options: CallOptions = {}
  ): Promise<ModelCallResult> {
    const primary = this.routeByTask(taskType);
    const fallbacks = this.getFallbackChain(primary.id);

    const modelsToTry = [primary, ...fallbacks.map(id => this.models.get(id)!).filter(Boolean)];
    console.log(`[ModelRouter.callWithFallback] Task: ${taskType}, Models to try: ${modelsToTry.map(m => m.id).join(', ')}`);

    for (const model of modelsToTry) {
      try {
        console.log(`[ModelRouter.callWithFallback] Trying model: ${model.id} (${model.provider})`);
        const result = await this.callModel(model, prompt, options);
        if (result.success) {
          console.log(`[ModelRouter.callWithFallback] Model ${model.id} succeeded`);
          return result;
        }
        console.log(`[ModelRouter.callWithFallback] Model ${model.id} returned unsuccessfully: ${result.error}`);
      } catch (error: any) {
        console.log(`[ModelRouter.callWithFallback] Model ${model.id} threw error: ${error.message}`);
        this.recordFailure(model.id, error.message);
        this.emit('modelError', { modelId: model.id, error: error.message });
        continue;
      }
    }

    console.log(`[ModelRouter.callWithFallback] All models failed for task: ${taskType}`);
    throw new AllModelsFailedError(
      `All models failed for task type: ${taskType}`,
      modelsToTry.map(m => m.id)
    );
  }

  /**
   * 调用单个模型
   */
  async callModel(
    model: ModelProfile,
    prompt: string,
    options: CallOptions = {}
  ): Promise<ModelCallResult> {
    const startTime = Date.now();

    try {
      // 获取或创建 LLM 客户端
      const client = this.getOrCreateClient(model);

      // 调用模型
      const response = await client.complete(prompt, {
        maxTokens: options.maxTokens || model.maxTokens,
        temperature: options.temperature ?? 0.3,
        jsonMode: options.jsonMode,
      });

      const latencyMs = Date.now() - startTime;

      // 估算 token 使用（简化实现）
      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = Math.ceil(response.length / 4);
      const totalCost =
        inputTokens * model.costPerInputToken + outputTokens * model.costPerOutputToken;

      // 更新统计
      this.updateStats(model.id, inputTokens + outputTokens, totalCost);

      const result: ModelCallResult = {
        modelId: model.id,
        response,
        usage: {
          inputTokens,
          outputTokens,
          totalCost,
        },
        latencyMs,
        success: true,
      };

      this.emit('modelCall', result);
      return result;
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;

      const result: ModelCallResult = {
        modelId: model.id,
        response: '',
        usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
        latencyMs,
        success: false,
        error: error.message,
      };

      this.recordFailure(model.id, error.message);
      return result;
    }
  }

  // ==========================================================================
  // 多模型投票 (Ensemble)
  // ==========================================================================

  /**
   * 多模型投票
   */
  async ensemble(
    prompt: string,
    modelIds?: string[],
    options: CallOptions = {}
  ): Promise<EnsembleResult> {
    const models = modelIds
      ? modelIds.map(id => this.models.get(id)!).filter(Boolean)
      : this.getEnabledModels().slice(0, 3); // 默认使用前 3 个启用的模型

    if (models.length < 2) {
      throw new Error('Ensemble requires at least 2 models');
    }

    const startTime = Date.now();

    // 并行调用所有模型
    const results = await Promise.all(
      models.map(model => this.callModel(model, prompt, options))
    );

    const successfulResults = results.filter(r => r.success);

    if (successfulResults.length === 0) {
      throw new Error('All models failed in ensemble');
    }

    // 聚合响应
    const aggregatedResponse = this.aggregateResponses(successfulResults);
    const agreementScore = this.calculateAgreement(successfulResults);

    const totalCost = results.reduce((sum, r) => sum + r.usage.totalCost, 0);
    const totalLatencyMs = Date.now() - startTime;

    const ensembleResult: EnsembleResult = {
      responses: results,
      aggregatedResponse,
      confidence: agreementScore,
      agreementScore,
      totalCost,
      totalLatencyMs,
    };

    this.emit('ensemble', ensembleResult);
    return ensembleResult;
  }

  /**
   * 聚合多个响应
   */
  private aggregateResponses(results: ModelCallResult[]): string {
    if (results.length === 1) {
      return results[0].response;
    }

    // 简化实现：返回最长的响应（假设更详细）
    // 生产环境可以使用更复杂的聚合策略
    return results.reduce((longest, r) =>
      r.response.length > longest.length ? r.response : longest
    , results[0].response);
  }

  /**
   * 计算响应一致性分数
   */
  private calculateAgreement(results: ModelCallResult[]): number {
    if (results.length <= 1) return 1.0;

    // 简化实现：基于响应长度相似度
    const lengths = results.map(r => r.response.length);
    const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / lengths.length;
    const stdDev = Math.sqrt(variance);

    // 转换为 0-1 分数
    const coefficient = avgLength > 0 ? stdDev / avgLength : 0;
    return Math.max(0, 1 - coefficient);
  }

  // ==========================================================================
  // 故障转移链
  // ==========================================================================

  /**
   * 获取故障转移链
   */
  getFallbackChain(excludeModelId?: string): string[] {
    return this.config.fallbackChain.filter(
      id => id !== excludeModelId && this.models.get(id)?.enabled
    );
  }

  /**
   * 设置故障转移链
   */
  setFallbackChain(chain: string[]): void {
    this.config.fallbackChain = chain;
    this.emit('configUpdated', { fallbackChain: chain });
  }

  // ==========================================================================
  // LLM 客户端管理
  // ==========================================================================

  /**
   * 获取或创建 LLM 客户端
   */
  private getOrCreateClient(model: ModelProfile): LLMClientInterface {
    const clientKey = `${model.provider}:${model.model}`;

    if (this.llmClients.has(clientKey)) {
      return this.llmClients.get(clientKey)!;
    }

    // 创建新客户端
    const client = this.createClient(model);
    this.llmClients.set(clientKey, client);
    return client;
  }

  /**
   * 创建 LLM 客户端
   */
  private createClient(model: ModelProfile): LLMClientInterface {
    switch (model.provider) {
      case 'deepseek':
        return new DeepSeekClient(model);
      case 'anthropic':
        return new AnthropicClient(model);
      case 'openai':
        return new OpenAIClient(model);
      case 'glm':
        return new GLMClient(model);
      case 'mock':
        return new MockClient(model);
      default:
        throw new Error(`Unknown provider: ${model.provider}`);
    }
  }

  /**
   * 注册自定义 LLM 客户端
   */
  registerClient(modelId: string, client: LLMClientInterface): void {
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    const clientKey = `${model.provider}:${model.model}`;
    this.llmClients.set(clientKey, client);
  }

  // ==========================================================================
  // 统计和监控
  // ==========================================================================

  /**
   * 更新调用统计
   */
  private updateStats(modelId: string, tokens: number, cost: number): void {
    const stats = this.callStats.get(modelId) || { calls: 0, tokens: 0, cost: 0, failures: 0 };
    stats.calls += 1;
    stats.tokens += tokens;
    stats.cost += cost;
    this.callStats.set(modelId, stats);
  }

  /**
   * 记录失败
   */
  private recordFailure(modelId: string, _error: string): void {
    const stats = this.callStats.get(modelId) || { calls: 0, tokens: 0, cost: 0, failures: 0 };
    stats.failures += 1;
    this.callStats.set(modelId, stats);
  }

  /**
   * 获取模型使用统计
   */
  getStats(): Record<string, { calls: number; tokens: number; cost: number; failures: number }> {
    return Object.fromEntries(this.callStats);
  }

  /**
   * 获取总成本
   */
  getTotalCost(): number {
    let total = 0;
    for (const stats of this.callStats.values()) {
      total += stats.cost;
    }
    return total;
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.callStats.clear();
    this.emit('statsReset');
  }

  // ==========================================================================
  // 模型管理
  // ==========================================================================

  /**
   * 启用模型
   */
  enableModel(modelId: string): void {
    const model = this.models.get(modelId);
    if (model) {
      model.enabled = true;
      this.emit('modelEnabled', { modelId });
    }
  }

  /**
   * 禁用模型
   */
  disableModel(modelId: string): void {
    const model = this.models.get(modelId);
    if (model) {
      model.enabled = false;
      this.emit('modelDisabled', { modelId });
    }
  }

  /**
   * 添加自定义模型
   */
  addModel(model: ModelProfile): void {
    this.models.set(model.id, model);
    this.emit('modelAdded', { modelId: model.id });
  }

  /**
   * 移除模型
   */
  removeModel(modelId: string): void {
    this.models.delete(modelId);
    this.emit('modelRemoved', { modelId });
  }

  /**
   * 更新模型配置
   */
  updateModel(modelId: string, updates: Partial<ModelProfile>): void {
    const model = this.models.get(modelId);
    if (model) {
      Object.assign(model, updates);
      this.emit('modelUpdated', { modelId, updates });
    }
  }

  /**
   * 列出所有模型
   */
  listModels(): ModelProfile[] {
    return Array.from(this.models.values());
  }
}

// =============================================================================
// LLM 客户端接口和实现
// =============================================================================

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

interface LLMClientInterface {
  complete(prompt: string, options?: CallOptions): Promise<string>;
}

/**
 * DeepSeek 客户端
 */
class DeepSeekClient implements LLMClientInterface {
  private model: ModelProfile;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: ModelProfile) {
    this.model = model;
    this.apiKey = process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens || this.model.maxTokens,
        temperature: options.temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
    return data.choices[0]?.message?.content || '';
  }
}

/**
 * Anthropic 客户端
 */
class AnthropicClient implements LLMClientInterface {
  private model: ModelProfile;
  private apiKey: string;

  constructor(model: ModelProfile) {
    this.model = model;
    this.apiKey = process.env.ANTHROPIC_API_KEY || '';
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens || this.model.maxTokens,
        temperature: options.temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { content: Array<{ text?: string }> };
    return data.content[0]?.text || '';
  }
}

/**
 * OpenAI 客户端
 */
class OpenAIClient implements LLMClientInterface {
  private model: ModelProfile;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: ModelProfile) {
    this.model = model;
    this.apiKey = process.env.OPENAI_API_KEY || '';
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    const body: any = {
      model: this.model.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || this.model.maxTokens,
      temperature: options.temperature ?? 0.3,
    };

    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
    return data.choices[0]?.message?.content || '';
  }
}

/**
 * GLM (智谱 AI) 客户端
 */
class GLMClient implements LLMClientInterface {
  private model: ModelProfile;
  private apiKey: string;
  private baseUrl: string;

  constructor(model: ModelProfile) {
    this.model = model;
    this.apiKey = process.env.GLM_API_KEY || '';
    this.baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GLM_API_KEY not configured');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens || this.model.maxTokens,
        temperature: options.temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GLM API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
    return data.choices[0]?.message?.content || '';
  }
}

/**
 * Mock 客户端（测试用）
 */
class MockClient implements LLMClientInterface {
  private model: ModelProfile;

  constructor(model: ModelProfile) {
    this.model = model;
  }

  async complete(prompt: string, _options: CallOptions = {}): Promise<string> {
    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, 100));

    // 返回模拟响应
    return JSON.stringify({
      mock: true,
      model: this.model.id,
      promptLength: prompt.length,
      response: 'This is a mock response for testing purposes.',
    });
  }
}

/**
 * 所有模型失败错误
 */
class AllModelsFailedError extends Error {
  public triedModels: string[];

  constructor(message: string, triedModels: string[]) {
    super(message);
    this.name = 'AllModelsFailedError';
    this.triedModels = triedModels;
  }
}

export { AllModelsFailedError };
export default ModelRouter;
