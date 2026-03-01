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
import { LLM_REDACTION_VERSION, hashSha256, redactTextForLLM } from '../../utils/llmPrivacy';
import {
  ModelProvider,
  ModelStrength,
  TaskType,
  ModelProfile,
  ModelRouterConfig,
  ModelCallResult,
  EnsembleResult,
} from '../types';

const DEFAULT_DEEPSEEK_CHAT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEFAULT_DEEPSEEK_REASONING_MODEL = process.env.DEEPSEEK_REASONING_MODEL || 'deepseek-reasoner';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_GLM_MODEL = process.env.GLM_MODEL || 'glm-5';
const DEFAULT_GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_GLM_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

function normalizeDeepSeekBaseUrl(baseUrl: string): string {
  // DeepSeek supports both:
  // - https://api.deepseek.com
  // - https://api.deepseek.com/v1
  // We normalize to root URL and append /v1/chat/completions ourselves.
  return String(baseUrl || DEFAULT_DEEPSEEK_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

// 默认模型配置
const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    model: DEFAULT_DEEPSEEK_CHAT_MODEL,
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
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    model: DEFAULT_DEEPSEEK_REASONING_MODEL,
    strengths: ['reasoning', 'coding'],
    costPerInputToken: 0.00014,
    costPerOutputToken: 0.00028,
    avgLatencyMs: 1800,
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
    id: 'glm-5',
    provider: 'glm',
    model: DEFAULT_GLM_MODEL,
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

const DEFAULT_TASK_MODEL_MAPPING: Partial<Record<TaskType, string>> = {
  intent_understanding: 'glm-5',
  planning: 'glm-5',
  synthesis: 'glm-5',
  evaluation: 'glm-5',
  sql_generation: 'glm-5',
  code_analysis: 'glm-5',
  simple_extraction: 'glm-5',
  formatting: 'glm-5',
  general: 'glm-5',
};

// 默认配置
const DEFAULT_CONFIG: Partial<ModelRouterConfig> = {
  defaultModel: 'glm-5',
  fallbackChain: ['deepseek-reasoner', 'deepseek-chat'],
  enableEnsemble: false,
  ensembleThreshold: 0.8,
  taskModelMapping: DEFAULT_TASK_MODEL_MAPPING,
};

/**
 * 模型路由器实现
 */
export class ModelRouter extends EventEmitter {
  private config: ModelRouterConfig;
  private models: Map<string, ModelProfile>;
  private callStats: Map<string, { calls: number; tokens: number; cost: number; failures: number }>;
  private llmClients: Map<string, LLMClientInterface>;
  private static readonly CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
    /maximum context length/i,
    /context[_\s-]?length[_\s-]?exceeded/i,
    /context window/i,
    /too many tokens/i,
    /prompt is too long/i,
    /messages resulted in\s*\d+\s*tokens/i,
    /input.*too long/i,
    /超出.*上下文/i,
    /上下文.*超出/i,
    /上下文长度/i,
    /超过.*token/i,
    /令牌.*超出/i,
  ];
  private static readonly PROMPT_COMPACTION_RATIOS = [0.72, 0.55];
  private static readonly MIN_PROMPT_FOR_COMPACTION = 2200;
  private static readonly MIN_COMPACTED_PROMPT = 1600;
  /** Buffer for downstream transformations (ensureJsonOnlyInstruction + redaction overhead) */
  private static readonly TRANSFORMATION_OVERHEAD_CHARS = 250;

  constructor(config: Partial<ModelRouterConfig> = {}) {
    super();

    // 初始化模型列表
    const models = config.models || DEFAULT_MODELS;

    this.config = {
      models,
      defaultModel: config.defaultModel || DEFAULT_CONFIG.defaultModel!,
      taskModelMapping: config.taskModelMapping || DEFAULT_CONFIG.taskModelMapping!,
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
    const taskAwareOptions = resolveTaskAwareCallOptions(taskType, options);
    const primary = this.routeByTask(taskType);
    const fallbacks = this.getFallbackChain(primary.id);

    const modelsToTry = [primary, ...fallbacks.map(id => this.models.get(id)!).filter(Boolean)];
    console.log(`[ModelRouter.callWithFallback] Task: ${taskType}, Models to try: ${modelsToTry.map(m => m.id).join(', ')}`);

    for (const model of modelsToTry) {
      try {
        const promptCandidates = [prompt, ...this.buildPromptCompactionCandidates(prompt)];
        for (let attempt = 0; attempt < promptCandidates.length; attempt += 1) {
          const promptCandidate = promptCandidates[attempt];
          const isCompactedAttempt = attempt > 0;
          if (isCompactedAttempt) {
            console.log(
              `[ModelRouter.callWithFallback] Retrying model ${model.id} with compacted prompt ` +
              `(${promptCandidate.length}/${prompt.length} chars)`
            );
          } else {
            console.log(`[ModelRouter.callWithFallback] Trying model: ${model.id} (${model.provider})`);
          }

          const canStreamThisAttempt =
            model.id === primary.id &&
            attempt === 0 &&
            typeof taskAwareOptions.onToken === 'function';

          const result = await this.callModel(model, promptCandidate, {
            ...taskAwareOptions,
            taskType,
            onToken: canStreamThisAttempt ? taskAwareOptions.onToken : undefined,
          });
          if (result.success) {
            console.log(`[ModelRouter.callWithFallback] Model ${model.id} succeeded`);
            return result;
          }

          console.log(`[ModelRouter.callWithFallback] Model ${model.id} returned unsuccessfully: ${result.error}`);

          const isContextOverflow = this.isContextOverflowError(result.error);
          const hasMoreCompactedCandidates = attempt < promptCandidates.length - 1;

          if (!isContextOverflow || !hasMoreCompactedCandidates) {
            // Final failure for this model — record it in stats
            this.recordFailure(model.id, result.error || 'unknown');
            break;
          }

          console.log(
            `[ModelRouter.callWithFallback] Context overflow detected for ${model.id}, ` +
            `trying a shorter prompt`);
        }
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

  private isContextOverflowError(errorMessage?: string): boolean {
    if (!errorMessage) return false;
    return ModelRouter.CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(errorMessage));
  }

  private buildPromptCompactionCandidates(prompt: string): string[] {
    const source = String(prompt || '');
    if (source.length < ModelRouter.MIN_PROMPT_FOR_COMPACTION) {
      return [];
    }

    const candidates: string[] = [];
    const seen = new Set<string>([source]);

    for (const ratio of ModelRouter.PROMPT_COMPACTION_RATIOS) {
      // Subtract transformation overhead: callModel appends JSON instructions and
      // runs redaction AFTER compaction, so the effective prompt will be longer.
      const targetChars = Math.max(
        ModelRouter.MIN_COMPACTED_PROMPT,
        Math.floor(source.length * ratio) - ModelRouter.TRANSFORMATION_OVERHEAD_CHARS
      );
      const compacted = this.compactPromptMiddle(source, targetChars);
      if (compacted.length < source.length && !seen.has(compacted)) {
        candidates.push(compacted);
        seen.add(compacted);
      }
    }

    return candidates;
  }

  private compactPromptMiddle(prompt: string, targetChars: number): string {
    if (prompt.length <= targetChars) return prompt;

    const sanitized = prompt.replace(/\n{3,}/g, '\n\n');
    if (sanitized.length <= targetChars) {
      return sanitized;
    }

    const marker = '\n\n[...context compacted for model limit...]\n\n';
    const available = targetChars - marker.length;
    if (available <= 0) {
      return sanitized.slice(0, targetChars);
    }

    const headChars = Math.max(600, Math.floor(available * 0.45));
    const tailChars = Math.max(600, available - headChars);

    const head = sanitized.slice(0, Math.min(headChars, sanitized.length)).trimEnd();
    const tail = sanitized.slice(Math.max(0, sanitized.length - tailChars)).trimStart();

    return `${head}${marker}${tail}`;
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
    const jsonMode = options.jsonMode ?? detectJsonModeFromPrompt(prompt);
    const temperature = options.temperature ?? (jsonMode ? 0 : 0.3);
    const maxTokens = options.maxTokens || model.maxTokens;
    const finalPrompt = jsonMode ? ensureJsonOnlyInstruction(prompt) : prompt;
    const redactedPrompt = redactTextForLLM(finalPrompt);
    const promptHash = hashSha256(redactedPrompt.text);

    const contractVersion =
      options.contractVersion ??
      (jsonMode ? 'llm_contract_json_only@1.0.0' : 'llm_contract_text@1.0.0');

    try {
      // 获取或创建 LLM 客户端
      const client = this.getOrCreateClient(model);

      // 调用模型
      const onToken = model.supportsStreaming ? options.onToken : undefined;
      const nativeDefaults = resolveDefaultNativeInvocationOptions();
      const tools = options.tools ?? nativeDefaults.tools;
      const hasNativeTools = Array.isArray(tools) ? tools.length > 0 : tools !== undefined;
      const toolChoice = resolveToolChoice(options) ?? (hasNativeTools ? nativeDefaults.toolChoice : undefined);
      const reasoning = options.reasoning ?? nativeDefaults.reasoning;
      const response = await client.complete(redactedPrompt.text, {
        maxTokens,
        temperature,
        jsonMode,
        onToken,
        tools,
        toolChoice,
        reasoning,
      });

      const latencyMs = Date.now() - startTime;

      // 估算 token 使用（简化实现）
      const inputTokens = Math.ceil(redactedPrompt.text.length / 4);
      const outputTokens = Math.ceil(response.length / 4);
      const totalCost =
        inputTokens * model.costPerInputToken + outputTokens * model.costPerOutputToken;
      const responseHash = hashSha256(response);

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
      this.emit('llmTelemetry', {
        schemaVersion: '1.0.0',
        sessionId: options.sessionId,
        traceId: options.traceId,
        taskType: options.taskType,
        promptId: options.promptId,
        promptVersion: options.promptVersion,
        contractVersion,
        redaction: {
          version: LLM_REDACTION_VERSION,
          ...redactedPrompt.stats,
        },
        promptHash,
        promptChars: redactedPrompt.text.length,
        responseHash,
        responseChars: response.length,
        modelId: model.id,
        provider: model.provider,
        temperature,
        maxTokens,
        jsonMode,
        latencyMs,
        usage: {
          inputTokens,
          outputTokens,
          totalCost,
        },
        success: true,
      });
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

      // Note: recordFailure is NOT called here — callers (callWithFallback, ensemble)
      // decide when a failure is final vs retriable (e.g. context overflow with compaction).
      this.emit('llmTelemetry', {
        schemaVersion: '1.0.0',
        sessionId: options.sessionId,
        traceId: options.traceId,
        taskType: options.taskType,
        promptId: options.promptId,
        promptVersion: options.promptVersion,
        contractVersion,
        redaction: {
          version: LLM_REDACTION_VERSION,
          ...redactedPrompt.stats,
        },
        promptHash,
        promptChars: redactedPrompt.text.length,
        modelId: model.id,
        provider: model.provider,
        temperature,
        maxTokens,
        jsonMode,
        latencyMs,
        success: false,
        error: error.message,
      });
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
  onToken?: (token: string) => void;
  // OpenAI-compatible native tool calling passthrough.
  tools?: Array<Record<string, unknown>>;
  // Support both camelCase and snake_case naming.
  toolChoice?: string | Record<string, unknown>;
  tool_choice?: string | Record<string, unknown>;
  // Provider-native reasoning config passthrough.
  reasoning?: Record<string, unknown>;
  // Telemetry (optional)
  sessionId?: string;
  traceId?: string;
  taskType?: TaskType;
  promptId?: string;
  promptVersion?: string;
  contractVersion?: string;
}

interface LLMClientInterface {
  complete(prompt: string, options?: CallOptions): Promise<string>;
}

interface NativeInvocationDefaults {
  tools?: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown>;
  reasoning?: Record<string, unknown>;
}

type TaskReasoningOverrides = Partial<Record<TaskType, Record<string, unknown>>>;

const DEFAULT_TASK_REASONING_PROFILES: Record<TaskType, Record<string, unknown>> = {
  intent_understanding: { effort: 'high' },
  planning: { effort: 'high' },
  synthesis: { effort: 'high' },
  evaluation: { effort: 'high' },
  sql_generation: { effort: 'medium' },
  code_analysis: { effort: 'medium' },
  simple_extraction: { effort: 'low' },
  formatting: { effort: 'low' },
  general: { effort: 'medium' },
};

const TASKS_DISABLE_DEFAULT_NATIVE_TOOLS = new Set<TaskType>([
  'simple_extraction',
  'formatting',
]);

function areNativeInvocationDefaultsEnabled(): boolean {
  return parseEnvBoolean(process.env.MODEL_NATIVE_OPTIONS_ENABLED, true);
}

function hasExplicitGlobalReasoningEnv(): boolean {
  const envReasoning = String(process.env.MODEL_NATIVE_REASONING || '').trim();
  if (envReasoning) return true;

  const envEffort = String(process.env.MODEL_NATIVE_REASONING_EFFORT || '').trim();
  return Boolean(envEffort);
}

function parseEnvBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore invalid JSON payloads and fall back to safe defaults.
  }
  return undefined;
}

function parseJsonArrayOfObjects(raw: string): Array<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const normalized = parsed.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
    );
    return normalized.length > 0 ? normalized : [];
  } catch {
    // Ignore invalid JSON payloads and fall back to safe defaults.
  }
  return undefined;
}

function resolveDefaultNativeInvocationOptions(): NativeInvocationDefaults {
  const enabled = areNativeInvocationDefaultsEnabled();
  if (!enabled) return {};

  const defaults: NativeInvocationDefaults = {};

  const envTools = String(process.env.MODEL_NATIVE_TOOLS || '').trim();
  if (envTools) {
    const parsedTools = parseJsonArrayOfObjects(envTools);
    if (parsedTools !== undefined) {
      defaults.tools = parsedTools;
    }
  }

  const envToolChoice = String(process.env.MODEL_NATIVE_TOOL_CHOICE || '').trim();
  if (envToolChoice) {
    defaults.toolChoice = envToolChoice.startsWith('{')
      ? (parseJsonObject(envToolChoice) || envToolChoice)
      : envToolChoice;
  }

  const envReasoning = String(process.env.MODEL_NATIVE_REASONING || '').trim();
  if (envReasoning) {
    const parsedReasoning = parseJsonObject(envReasoning);
    if (parsedReasoning) {
      defaults.reasoning = parsedReasoning;
    }
  } else {
    const effort = String(process.env.MODEL_NATIVE_REASONING_EFFORT || 'medium').trim();
    if (effort) {
      defaults.reasoning = { effort };
    }
  }

  if (!defaults.toolChoice && Array.isArray(defaults.tools)) {
    defaults.toolChoice = 'auto';
  }

  return defaults;
}

function resolveToolChoice(options: CallOptions): string | Record<string, unknown> | undefined {
  if (options.toolChoice !== undefined) return options.toolChoice;
  return options.tool_choice;
}

function normalizeReasoningOverride(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const effort = value.trim();
    if (!effort) return undefined;
    return { effort };
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function resolveTaskReasoningOverrides(): TaskReasoningOverrides {
  const raw = String(process.env.MODEL_NATIVE_REASONING_BY_TASK || '').trim();
  if (!raw) return {};

  const parsed = parseJsonObject(raw);
  if (!parsed) return {};

  const overrides: TaskReasoningOverrides = {};
  for (const [taskType, rawReasoning] of Object.entries(parsed)) {
    if (!(taskType in DEFAULT_TASK_REASONING_PROFILES)) continue;
    const normalized = normalizeReasoningOverride(rawReasoning);
    if (!normalized) continue;
    overrides[taskType as TaskType] = normalized;
  }

  return overrides;
}

function resolveTaskAwareCallOptions(taskType: TaskType, options: CallOptions): CallOptions {
  const normalized: CallOptions = { ...options };
  const nativeDefaultsEnabled = areNativeInvocationDefaultsEnabled();

  if (nativeDefaultsEnabled && normalized.reasoning === undefined) {
    const taskOverrides = resolveTaskReasoningOverrides();
    const explicitTaskReasoning = taskOverrides[taskType];
    if (explicitTaskReasoning) {
      normalized.reasoning = explicitTaskReasoning;
    } else if (!hasExplicitGlobalReasoningEnv()) {
      normalized.reasoning = DEFAULT_TASK_REASONING_PROFILES[taskType] || undefined;
    }
  }

  if (
    nativeDefaultsEnabled &&
    normalized.tools === undefined &&
    TASKS_DISABLE_DEFAULT_NATIVE_TOOLS.has(taskType)
  ) {
    // Explicitly disable env default tools for low-complexity extraction/formatting tasks.
    normalized.tools = [];
  }

  return normalized;
}

function detectJsonModeFromPrompt(prompt: string): boolean {
  if (!prompt) return false;

  // Heuristics: only enable JSON mode when the prompt clearly asks for structured JSON output.
  // Keep this conservative to avoid breaking free-form narrative prompts that mention JSON incidentally.
  const p = prompt.toLowerCase();

  // English signals
  const en =
    p.includes('respond in json') ||
    p.includes('respond with json') ||
    p.includes('return json') ||
    p.includes('output json') ||
    p.includes('json format') ||
    p.includes('only json');

  // Chinese signals
  const zh =
    prompt.includes('请以 JSON') ||
    prompt.includes('以 JSON') ||
    prompt.includes('输出格式要求：JSON') ||
    prompt.includes('输出格式要求: JSON') ||
    prompt.includes('只输出 JSON') ||
    prompt.includes('只返回 JSON') ||
    prompt.includes('只输出JSON') ||
    prompt.includes('只返回JSON') ||
    prompt.includes('JSON 格式返回');

  // Template-style JSON object snippet is also a strong signal:
  // e.g. "请以 JSON 格式返回：{ ... }"
  const hasJsonObjectTemplate = /\{\s*\"[^\"]+\"\s*:\s*/.test(prompt);

  return en || zh || hasJsonObjectTemplate;
}

function ensureJsonOnlyInstruction(prompt: string): string {
  // Avoid stacking the same instruction repeatedly.
  if (/respond\s+only\s+with\s+valid\s+json/i.test(prompt)) return prompt;
  if (/只输出\s*json/i.test(prompt)) return prompt;

  return `${prompt}

IMPORTANT:
- Respond ONLY with valid JSON.
- Do NOT include markdown, code fences, or extra commentary.
- 只输出合法 JSON，不要输出 Markdown/代码块/解释。`;
}

function normalizeStreamText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }

  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }

  return '';
}

function extractOpenAICompatibleToken(payload: any): string {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  if (choices.length > 0) {
    const deltaToken = normalizeStreamText(choices[0]?.delta?.content);
    if (deltaToken) return deltaToken;

    const messageToken = normalizeStreamText(choices[0]?.message?.content);
    if (messageToken) return messageToken;
  }

  return '';
}

async function readOpenAICompatibleStreamResponse(
  response: Response,
  onToken: (token: string) => void
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body is unavailable');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;

    try {
      const payload = JSON.parse(data);
      const token = extractOpenAICompatibleToken(payload);
      if (!token) return;

      fullText += token;
      onToken(token);
    } catch {
      // Ignore malformed or non-JSON SSE packets.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      processLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const trailingLines = buffer.split('\n');
    for (const line of trailingLines) {
      processLine(line);
    }
  }

  return fullText;
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
    this.baseUrl = normalizeDeepSeekBaseUrl(
      process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL
    );
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }

    const useStreaming = typeof options.onToken === 'function';
    const toolChoice = resolveToolChoice(options);
    const body: Record<string, unknown> = {
      model: this.model.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || this.model.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: useStreaming,
    };
    if (Array.isArray(options.tools)) {
      body.tools = options.tools;
    }
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
    if (options.reasoning !== undefined) {
      body.reasoning = options.reasoning;
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
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    if (useStreaming) {
      return readOpenAICompatibleStreamResponse(response, options.onToken!);
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

    const useStreaming = typeof options.onToken === 'function';
    const toolChoice = resolveToolChoice(options);
    const body: any = {
      model: this.model.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || this.model.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: useStreaming,
    };

    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    if (Array.isArray(options.tools)) {
      body.tools = options.tools;
    }
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
    if (options.reasoning !== undefined) {
      body.reasoning = options.reasoning;
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

    if (useStreaming) {
      return readOpenAICompatibleStreamResponse(response, options.onToken!);
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
  private codingBaseUrl: string;

  constructor(model: ModelProfile) {
    this.model = model;
    this.apiKey = process.env.GLM_API_KEY || '';
    this.baseUrl = process.env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL;
    this.codingBaseUrl = process.env.GLM_CODING_BASE_URL || DEFAULT_GLM_CODING_BASE_URL;
  }

  private isCodingPlanModel(): boolean {
    const modelName = String(this.model.model || '').toLowerCase();
    return modelName.includes('coding') && modelName.includes('plan');
  }

  private resolveEndpoint(options: CallOptions): string {
    // GLM Coding Plan must use the dedicated coding endpoint.
    if (this.isCodingPlanModel()) {
      return this.codingBaseUrl;
    }

    // Allow explicit override for environments that want all GLM traffic on coding endpoint.
    const forceCodingEndpoint = String(process.env.GLM_USE_CODING_ENDPOINT || '').toLowerCase();
    if (forceCodingEndpoint === '1' || forceCodingEndpoint === 'true') {
      return this.codingBaseUrl;
    }

    return this.baseUrl;
  }

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GLM_API_KEY not configured');
    }

    const useStreaming = typeof options.onToken === 'function';
    const endpoint = this.resolveEndpoint(options);
    const toolChoice = resolveToolChoice(options);
    const body: Record<string, unknown> = {
      model: this.model.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || this.model.maxTokens,
      temperature: options.temperature ?? 0.3,
      stream: useStreaming,
    };
    if (Array.isArray(options.tools)) {
      body.tools = options.tools;
    }
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
    if (options.reasoning !== undefined) {
      body.reasoning = options.reasoning;
    }
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GLM API error: ${response.status} - ${error}`);
    }

    if (useStreaming) {
      return readOpenAICompatibleStreamResponse(response, options.onToken!);
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

  async complete(prompt: string, options: CallOptions = {}): Promise<string> {
    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, 100));

    // 返回模拟响应
    const mockResponse = JSON.stringify({
      mock: true,
      model: this.model.id,
      promptLength: prompt.length,
      response: 'This is a mock response for testing purposes.',
    });

    if (typeof options.onToken === 'function') {
      const chunkSize = 16;
      for (let i = 0; i < mockResponse.length; i += chunkSize) {
        options.onToken(mockResponse.slice(i, i + chunkSize));
      }
    }

    return mockResponse;
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
