/**
 * SmartPerfetto Base SubAgent
 *
 * SubAgent 基类，提供：
 * 1. 通用的 Think-Act 循环框架
 * 2. 工具注册和调用
 * 3. 与 ModelRouter 的集成
 * 4. 结果提取和格式化
 * 5. 生命周期钩子支持
 */

import { EventEmitter } from 'events';
import {
  SubAgentConfig,
  SubAgentContext,
  SubAgentResult,
  Finding,
  ToolResult,
  TaskType,
  AgentThought,
  PipelineStage,
} from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import { StageExecutor } from '../../core/pipelineExecutor';
import {
  HookRegistry,
  getHookRegistry,
  HookContext,
  createHookContext,
  ToolUseEventData,
  IterationEventData,
} from '../../hooks';

/**
 * 工具接口
 */
export interface AgentTool {
  name: string;
  description: string;
  execute(params: Record<string, any>, context: SubAgentContext): Promise<ToolResult>;
}

/**
 * 思考结果
 */
export interface ThinkResult {
  observation: string;
  reasoning: string;
  decision: 'continue' | 'conclude' | 'delegate';
  nextActions: string[];
  confidence: number;
}

/**
 * SubAgent 基类
 */
export abstract class BaseSubAgent extends EventEmitter implements StageExecutor {
  protected config: SubAgentConfig;
  protected modelRouter: ModelRouter;
  protected tools: Map<string, AgentTool>;
  protected currentIteration: number = 0;
  protected hookRegistry: HookRegistry;
  protected hookContext: HookContext | null = null;

  constructor(config: SubAgentConfig, modelRouter: ModelRouter, hookRegistry?: HookRegistry) {
    super();
    this.config = config;
    this.modelRouter = modelRouter;
    this.tools = new Map();
    this.hookRegistry = hookRegistry || getHookRegistry();
  }

  // ==========================================================================
  // 抽象方法（子类必须实现）
  // ==========================================================================

  /**
   * 构建系统提示词
   */
  protected abstract buildSystemPrompt(context: SubAgentContext): string;

  /**
   * 构建任务提示词
   */
  protected abstract buildTaskPrompt(context: SubAgentContext): string;

  /**
   * 解析 LLM 响应
   */
  protected abstract parseResponse(response: string, context: SubAgentContext): SubAgentResult;

  // ==========================================================================
  // 核心执行逻辑
  // ==========================================================================

  /**
   * 执行分析（实现 StageExecutor 接口）
   */
  async execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult> {
    const startTime = Date.now();
    this.currentIteration = 0;

    // 初始化 hook context
    this.hookContext = createHookContext(
      context.sessionId,
      context.traceId || '',
      stage.id  // phase 使用 stageId
    );
    // 存储 agent 信息到 metadata
    this.hookContext.set('agentId', this.config.id);
    this.hookContext.set('stageId', stage.id);

    try {
      // 发射开始事件
      this.emit('start', { agentId: this.config.id, stage: stage.id });

      // 执行 Think-Act 循环
      const result = await this.runThinkActLoop(context);

      // 计算执行时间
      result.executionTimeMs = Date.now() - startTime;

      // 发射完成事件
      this.emit('complete', { agentId: this.config.id, result });

      return result;
    } catch (error: any) {
      this.emit('error', { agentId: this.config.id, error: error.message });

      return {
        agentId: this.config.id,
        success: false,
        findings: [],
        suggestions: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    } finally {
      // 清理 hook context
      this.hookContext = null;
    }
  }

  /**
   * Think-Act 循环
   */
  protected async runThinkActLoop(context: SubAgentContext): Promise<SubAgentResult> {
    const findings: Finding[] = [];
    const suggestions: string[] = [];
    let confidence = 0;

    while (this.currentIteration < this.config.maxIterations) {
      this.currentIteration++;

      // === Iteration Pre-Hook ===
      const iterationData: IterationEventData = {
        iterationNumber: this.currentIteration,
        maxIterations: this.config.maxIterations,
        currentFindings: findings,
      };
      const iterPreResult = await this.hookRegistry.executePre(
        'iteration:start',
        context.sessionId,
        iterationData,
        this.hookContext || undefined
      );
      if (!iterPreResult.continue) {
        // Hook 要求中止迭代
        break;
      }

      // Think: 思考下一步
      const thought = await this.think(context, findings);
      this.emit('thought', { agentId: this.config.id, thought });

      // 检查是否应该结束
      if (thought.decision === 'conclude' || thought.confidence >= this.config.confidenceThreshold) {
        confidence = thought.confidence;
        // === Iteration Post-Hook (结束) ===
        await this.hookRegistry.executePost(
          'iteration:end',
          context.sessionId,
          { ...iterationData, thought, decision: 'conclude' },
          this.hookContext || undefined
        );
        break;
      }

      // Act: 执行动作
      for (const action of thought.nextActions) {
        const result = await this.act(action, context);
        if (result) {
          // 提取发现
          const newFindings = this.extractFindings(result);
          findings.push(...newFindings);
          this.emit('finding', { agentId: this.config.id, findings: newFindings });
        }
      }

      // === Iteration Post-Hook ===
      await this.hookRegistry.executePost(
        'iteration:end',
        context.sessionId,
        { ...iterationData, thought, decision: 'continue' },
        this.hookContext || undefined
      );

      // 检查是否有足够的发现
      if (findings.length >= 3) {
        confidence = Math.min(thought.confidence + 0.1, 1.0);
        break;
      }
    }

    // 生成建议
    const generatedSuggestions = await this.generateSuggestions(findings, context);
    suggestions.push(...generatedSuggestions);

    return {
      agentId: this.config.id,
      success: true,
      findings,
      suggestions,
      confidence,
      executionTimeMs: 0, // 由调用者填充
    };
  }

  /**
   * 思考步骤
   */
  protected async think(context: SubAgentContext, currentFindings: Finding[]): Promise<ThinkResult> {
    const prompt = this.buildThinkPrompt(context, currentFindings);
    const taskType = this.config.preferredModel || 'general';

    const response = await this.modelRouter.callWithFallback(prompt, taskType);

    return this.parseThinkResponse(response.response);
  }

  /**
   * 执行动作
   */
  protected async act(action: string, context: SubAgentContext): Promise<ToolResult | null> {
    // 解析动作（格式：toolName:params）
    const [toolName, paramsStr] = action.split(':');
    const tool = this.tools.get(toolName);

    if (!tool) {
      this.emit('warning', { message: `Unknown tool: ${toolName}` });
      return null;
    }

    let params: Record<string, any>;
    try {
      params = paramsStr ? JSON.parse(paramsStr) : {};
    } catch {
      params = {};
    }

    // === Tool Use Pre-Hook ===
    const toolUseData: ToolUseEventData = {
      toolName,
      params,
      agentId: this.config.id,
    };
    const preResult = await this.hookRegistry.executePre(
      'tool:use',
      context.sessionId,
      toolUseData,
      this.hookContext || undefined
    );

    if (!preResult.continue) {
      // Hook 要求中止此工具调用
      this.emit('toolSkipped', { toolName, reason: 'Hook prevented execution' });
      return preResult.substituteResult as ToolResult | null ?? null;
    }

    // 应用可能被 hook 修改的参数
    const finalParams = preResult.modifiedData
      ? (preResult.modifiedData as ToolUseEventData).params ?? params
      : params;

    try {
      const result = await tool.execute(finalParams, context);

      // === Tool Use Post-Hook ===
      await this.hookRegistry.executePost(
        'tool:use',
        context.sessionId,
        { ...toolUseData, params: finalParams, result },
        this.hookContext || undefined
      );

      this.emit('toolCall', { toolName, params: finalParams, result });
      return result;
    } catch (error: any) {
      // === Tool Use Error - 也触发 post hook ===
      await this.hookRegistry.executePost(
        'tool:use',
        context.sessionId,
        { ...toolUseData, params: finalParams, error: error.message },
        this.hookContext || undefined
      );

      this.emit('error', { message: `Tool ${toolName} failed: ${error.message}` });
      return null;
    }
  }

  // ==========================================================================
  // 提示词构建
  // ==========================================================================

  /**
   * 构建思考提示词
   */
  protected buildThinkPrompt(context: SubAgentContext, currentFindings: Finding[]): string {
    const systemPrompt = this.buildSystemPrompt(context);
    const taskPrompt = this.buildTaskPrompt(context);

    const findingsSummary = currentFindings.length > 0
      ? `\n\n已有发现:\n${currentFindings.map(f => `- ${f.title}: ${f.description}`).join('\n')}`
      : '';

    const toolsDescription = this.getToolsDescription();

    return `${systemPrompt}

## 可用工具
${toolsDescription}

## 当前任务
${taskPrompt}
${findingsSummary}

## 指令
基于当前状态，决定下一步行动。
如果已经有足够的信息，可以选择结束分析。
如果需要更多数据，选择合适的工具并指定参数。

请以 JSON 格式回复：
{
  "observation": "观察到的情况",
  "reasoning": "推理过程",
  "decision": "continue | conclude",
  "nextActions": ["tool1:{params}", "tool2:{params}"],
  "confidence": 0.0-1.0
}`;
  }

  /**
   * 获取工具描述
   */
  protected getToolsDescription(): string {
    const descriptions: string[] = [];
    for (const tool of this.tools.values()) {
      descriptions.push(`- ${tool.name}: ${tool.description}`);
    }
    return descriptions.join('\n');
  }

  // ==========================================================================
  // 响应解析
  // ==========================================================================

  /**
   * 解析思考响应
   */
  protected parseThinkResponse(response: string): ThinkResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          observation: parsed.observation || '',
          reasoning: parsed.reasoning || '',
          decision: parsed.decision || 'continue',
          nextActions: parsed.nextActions || [],
          confidence: parsed.confidence || 0,
        };
      }
    } catch (error) {
      // 解析失败
    }

    // 默认返回继续
    return {
      observation: response,
      reasoning: 'Unable to parse structured response',
      decision: 'continue',
      nextActions: [],
      confidence: 0.3,
    };
  }

  // ==========================================================================
  // 发现提取
  // ==========================================================================

  /**
   * 从工具结果中提取发现
   */
  protected extractFindings(result: ToolResult): Finding[] {
    if (!result.success || !result.data) {
      return [];
    }

    // 如果结果已经包含发现
    if (result.data.findings && Array.isArray(result.data.findings)) {
      return result.data.findings;
    }

    // 默认实现：子类可以覆盖
    return [];
  }

  /**
   * 生成建议
   */
  protected async generateSuggestions(findings: Finding[], context: SubAgentContext): Promise<string[]> {
    if (findings.length === 0) {
      return ['未发现明显问题'];
    }

    const prompt = `基于以下分析发现，生成 2-3 条改进建议：

发现：
${findings.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n')}

请直接列出建议，每条一行：`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      return response.response
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .slice(0, 3);
    } catch (error) {
      return findings
        .filter(f => f.severity === 'critical' || f.severity === 'warning')
        .map(f => `关注: ${f.title}`);
    }
  }

  // ==========================================================================
  // 工具管理
  // ==========================================================================

  /**
   * 注册工具
   */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 注册多个工具
   */
  registerTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * 获取工具
   */
  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 列出工具
   */
  listTools(): string[] {
    return Array.from(this.tools.keys());
  }

  // ==========================================================================
  // 配置和状态
  // ==========================================================================

  /**
   * 获取配置
   */
  getConfig(): SubAgentConfig {
    return { ...this.config };
  }

  /**
   * 获取 ID
   */
  get id(): string {
    return this.config.id;
  }

  /**
   * 获取类型
   */
  get type(): string {
    return this.config.type;
  }

  /**
   * 获取名称
   */
  get name(): string {
    return this.config.name;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.currentIteration = 0;
  }
}

export default BaseSubAgent;
