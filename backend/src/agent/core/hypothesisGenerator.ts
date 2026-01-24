/**
 * Hypothesis Generator
 *
 * Generates initial hypotheses about performance issues based on user query and intent.
 * Uses LLM for intelligent hypothesis generation, with keyword-based fallback.
 */

import { Intent } from '../types';
import {
  Hypothesis,
  createHypothesisId,
} from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { DomainAgentRegistry } from '../agents/domain';
import { ProgressEmitter } from './orchestratorTypes';

/**
 * Create a hypothesis with standard fields.
 */
export function createHypothesis(
  description: string,
  confidence: number,
  relevantAgents?: string[]
): Hypothesis {
  const now = Date.now();
  return {
    id: createHypothesisId(),
    description,
    confidence,
    status: 'proposed',
    supportingEvidence: [],
    contradictingEvidence: [],
    proposedBy: 'master_orchestrator',
    createdAt: now,
    updatedAt: now,
    ...(relevantAgents && { relevantAgents }),
  };
}

/**
 * Generate initial hypotheses using LLM reasoning.
 * Falls back to keyword-based defaults if LLM fails.
 */
export async function generateInitialHypotheses(
  query: string,
  intent: Intent,
  modelRouter: ModelRouter,
  agentRegistry: DomainAgentRegistry,
  emitter: ProgressEmitter
): Promise<Hypothesis[]> {
  const prompt = `基于以下用户查询，生成可能的性能问题假设：

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
分析方面: ${intent.aspects.join(', ')}

请以 JSON 格式返回假设列表：
{
  "hypotheses": [
    {
      "description": "假设描述",
      "confidence": 0.5,
      "relevantAgents": ["frame_agent", "cpu_agent"]
    }
  ]
}

注意：对于滑动/卡顿类问题，请务必包含以下关键假设方向：
- App 自身运行时间过长（主线程/RenderThread 耗时操作，如布局计算、绘制、业务逻辑）
- 帧率不稳定或掉帧
- CPU 调度不合理（被调度到小核、等待调度时间过长）
- 系统级问题（SurfaceFlinger、GPU、Binder IPC）

可用的 Agent:
${agentRegistry.getAgentDescriptionsForLLM()}`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'planning');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return (parsed.hypotheses || []).map((h: any) => createHypothesis(
        h.description,
        h.confidence || 0.5,
        h.relevantAgents
      ));
    }
  } catch (error) {
    emitter.log(`Failed to generate hypotheses: ${error}`);
    emitter.emitUpdate('degraded', { module: 'hypothesisGenerator', fallback: 'keyword-based defaults' });
  }

  return generateDefaultHypotheses(query);
}

/**
 * Generate keyword-based default hypotheses when LLM is unavailable.
 */
export function generateDefaultHypotheses(query: string): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];
  const queryLower = query.toLowerCase();

  if (queryLower.includes('卡顿') || queryLower.includes('jank')) {
    hypotheses.push(createHypothesis('帧渲染超时导致卡顿', 0.6));
  }

  if (queryLower.includes('滑动') || queryLower.includes('scroll')) {
    hypotheses.push(
      createHypothesis('滑动过程中存在帧率不稳定或掉帧现象', 0.7, ['frame_agent']),
      createHypothesis('App 自身运行时间过长（主线程或 RenderThread 耗时操作导致帧超时）', 0.75, ['frame_agent', 'cpu_agent']),
    );
  }

  if (hypotheses.length === 0) {
    hypotheses.push(createHypothesis('存在性能问题需要诊断', 0.5));
  }

  return hypotheses;
}
