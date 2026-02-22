/**
 * SmartPerfetto Additional Domain Agents
 *
 * Phase 2.6: Additional AI Agents for specific analysis domains
 *
 * This file contains:
 * - StartupAgent: App launch and startup analysis
 * - InteractionAgent: Click response and user interaction analysis
 * - ANRAgent: ANR detection and analysis
 * - SystemAgent: System-level analysis (thermal, IO, suspend/wakeup)
 *
 * All agents use lazy tool initialization via BaseAgent.ensureToolsLoaded()
 */

import { BaseAgent, TaskUnderstanding, ExecutionResult } from '../base/baseAgent';
import {
  AgentTask,
  AgentTaskContext,
  Hypothesis,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import { getAdbAgentTools } from '../tools/adbTools';
import { ANR_SKILLS, INTERACTION_SKILLS, STARTUP_SKILLS, SYSTEM_SKILLS } from './skillCatalog';

// =============================================================================
// Startup Agent
// =============================================================================

export class StartupAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'startup_agent',
        name: 'Startup Analysis Agent',
        domain: 'startup',
        description: 'AI agent specialized in app startup and launch performance analysis',
        tools: [...getAdbAgentTools()],
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
      },
      modelRouter,
      STARTUP_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个启动性能分析专家 Agent，负责分析 Android 应用的启动性能问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["startup"],"recommendedTools":["analyze_startup"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划启动分析：目标 ${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"steps":[{"toolName":"analyze_startup","params":{},"purpose":"分析启动性能"}],"expectedOutcomes":["启动时间分析"],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思启动分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const startupFindings = findings.filter(f => f.title.includes('启动') || f.title.includes('launch'));

    if (startupFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '启动过程存在性能瓶颈',
        0.6,
        startupFindings.map(f => ({ id: f.id, description: f.title, source: 'startup_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    return ['analyze_startup', 'get_startup_detail'];
  }
}

// =============================================================================
// Interaction Agent
// =============================================================================

export class InteractionAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'interaction_agent',
        name: 'Interaction Analysis Agent',
        domain: 'interaction',
        description: 'AI agent specialized in click response and user interaction analysis',
        tools: [...getAdbAgentTools()],
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['frame_agent', 'cpu_agent', 'binder_agent'],
      },
      modelRouter,
      INTERACTION_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个交互响应分析专家 Agent，负责分析用户点击响应延迟问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["interaction"],"recommendedTools":["analyze_click_response"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划交互分析：目标 ${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"steps":[{"toolName":"analyze_click_response","params":{},"purpose":"分析点击响应"}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思交互分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const interactionFindings = findings.filter(f => f.title.includes('点击') || f.title.includes('响应'));

    if (interactionFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '点击响应存在延迟问题',
        0.6,
        interactionFindings.map(f => ({ id: f.id, description: f.title, source: 'interaction_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = [];

    if (query.includes('点击') || query.includes('click') || query.includes('响应') || query.includes('response')) {
      tools.push('analyze_click_response');
    }
    if (query.includes('导航') || query.includes('navigation') || query.includes('页面') || query.includes('activity') || query.includes('跳转')) {
      tools.push('analyze_navigation');
    }

    if (tools.length === 0) tools.push('analyze_click_response');

    return [...new Set(tools)];
  }
}

// =============================================================================
// ANR Agent
// =============================================================================

export class ANRAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'anr_agent',
        name: 'ANR Analysis Agent',
        domain: 'anr',
        description: 'AI agent specialized in ANR detection and root cause analysis',
        tools: [...getAdbAgentTools()],
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['cpu_agent', 'binder_agent', 'memory_agent'],
      },
      modelRouter,
      ANR_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个 ANR 分析专家 Agent，负责分析 Android 应用的 ANR 问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["anr"],"recommendedTools":["analyze_anr"],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划 ANR 分析：目标 ${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"steps":[{"toolName":"analyze_anr","params":{},"purpose":"分析 ANR"}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思 ANR 分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const anrFindings = findings.filter(f => f.title.includes('ANR') || f.title.includes('无响应'));

    if (anrFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '主线程阻塞导致 ANR',
        0.8,
        anrFindings.map(f => ({ id: f.id, description: f.title, source: 'anr_agent', type: 'finding' as const, strength: 0.9 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    return ['analyze_anr', 'get_anr_detail'];
  }
}

// =============================================================================
// System Agent
// =============================================================================

export class SystemAgent extends BaseAgent {
  constructor(modelRouter: ModelRouter) {
    super(
      {
        id: 'system_agent',
        name: 'System Analysis Agent',
        domain: 'system',
        description: 'AI agent specialized in system-level analysis: thermal, IO, suspend/wakeup',
        tools: [...getAdbAgentTools({ includeRecorder: true })],
        maxIterations: 3,
        confidenceThreshold: 0.7,
        canDelegate: true,
        delegateTo: ['cpu_agent', 'memory_agent'],
      },
      modelRouter,
      SYSTEM_SKILLS
    );
  }

  protected buildUnderstandingPrompt(task: AgentTask): string {
    return `你是一个系统级分析专家 Agent，负责分析热节流、IO 压力等系统问题。

## 任务
${task.description}

## 上下文
- 用户查询: ${task.context.query}
${task.context.hypothesis ? `- 当前假设: ${task.context.hypothesis.description}` : ''}
${this.formatTaskContext(task)}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"objective":"","questions":[],"relevantAreas":["system"],"recommendedTools":[],"constraints":[],"confidence":0.7}`;
  }

  protected buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string {
    return `规划系统分析：目标 ${understanding.objective}

${this.getToolSectionForPrompt()}

请以 JSON 返回：{"steps":[{"toolName":"","params":{},"purpose":""}],"expectedOutcomes":[],"estimatedTimeMs":30000,"confidence":0.7}`;
  }

  protected buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string {
    return `反思系统分析：发现 ${result.findings.map(f => f.title).join(', ') || '无'}
请以 JSON 返回：{"insights":[],"objectivesMet":${result.success},"findingsConfidence":0.7,"gaps":[],"nextSteps":[],"hypothesisUpdates":[],"questionsForOthers":[]}`;
  }

  protected async generateHypotheses(findings: Finding[]): Promise<Hypothesis[]> {
    const hypotheses: Hypothesis[] = [];
    const systemFindings = findings.filter(f =>
      f.title.includes('热') || f.title.includes('IO') || f.title.includes('thermal')
    );

    if (systemFindings.length > 0) {
      hypotheses.push(this.createHypothesis(
        '系统级问题影响性能',
        0.6,
        systemFindings.map(f => ({ id: f.id, description: f.title, source: 'system_agent', type: 'finding' as const, strength: 0.7 }))
      ));
    }

    return hypotheses;
  }

  protected getRecommendedTools(context: AgentTaskContext): string[] {
    const query = context.query?.toLowerCase() || '';
    const tools: string[] = [];

    if (query.includes('热') || query.includes('thermal') || query.includes('温度') || query.includes('降频')) tools.push('analyze_thermal');
    if (query.includes('io') || query.includes('磁盘') || query.includes('存储') || query.includes('iowait')) tools.push('analyze_io_pressure');
    if (query.includes('休眠') || query.includes('唤醒') || query.includes('suspend') || query.includes('wakelock')) tools.push('analyze_suspend_wakeup');
    if (query.includes('块io') || query.includes('block') || query.includes('读写') || query.includes('数据库')) tools.push('analyze_block_io');
    if (query.includes('irq') || query.includes('中断') || query.includes('interrupt')) tools.push('analyze_irq');
    if (query.includes('网络') || query.includes('network') || query.includes('dns') || query.includes('http')) tools.push('analyze_network');

    if (tools.length === 0) tools.push('analyze_thermal');

    return tools;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createStartupAgent(modelRouter: ModelRouter): StartupAgent {
  return new StartupAgent(modelRouter);
}

export function createInteractionAgent(modelRouter: ModelRouter): InteractionAgent {
  return new InteractionAgent(modelRouter);
}

export function createANRAgent(modelRouter: ModelRouter): ANRAgent {
  return new ANRAgent(modelRouter);
}

export function createSystemAgent(modelRouter: ModelRouter): SystemAgent {
  return new SystemAgent(modelRouter);
}
