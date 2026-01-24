/**
 * Task Graph Planner
 *
 * Plans and builds task graphs for domain agent dispatch.
 * Uses LLM to generate task dependencies, with fallback heuristics.
 * Handles domain normalization, agent resolution, and mandatory domain injection.
 */

import { Intent, Finding } from '../types';
import {
  AgentTask,
  Hypothesis,
  SharedAgentContext,
  createTaskId,
} from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { DomainAgentRegistry } from '../agents/domain';
import {
  TaskGraphNode,
  TaskGraphPlan,
  DOMAIN_ALIASES,
  DEFAULT_EVIDENCE,
  AnalysisOptions,
  ProgressEmitter,
  normalizeDomain,
} from './orchestratorTypes';

// =============================================================================
// Time Range Parsing
// =============================================================================

export function parseTimeRange(
  input: any,
  options: AnalysisOptions,
  sharedContext: SharedAgentContext
): { start: number | string; end: number | string } | undefined {
  if (input && typeof input === 'object') {
    const start = input.start;
    const end = input.end;
    if ((typeof start === 'number' || typeof start === 'string') &&
        (typeof end === 'number' || typeof end === 'string') &&
        start && end) {
      return { start, end };
    }
  }
  if (Array.isArray(input) && input.length >= 2) {
    const start = input[0];
    const end = input[1];
    if ((typeof start === 'number' || typeof start === 'string') &&
        (typeof end === 'number' || typeof end === 'string')) {
      return { start, end };
    }
  }
  if (sharedContext.focusedTimeRange) {
    return sharedContext.focusedTimeRange;
  }
  if (options?.timeRange) {
    return options.timeRange;
  }
  return undefined;
}

// =============================================================================
// Agent Resolution
// =============================================================================

export function resolveAgentIdForDomain(
  domain: string,
  query: string,
  agentRegistry: DomainAgentRegistry
): string | null {
  const agent = agentRegistry.getForDomain(domain);
  if (agent) return agent.config.id;

  // Direct match for agent IDs
  if (agentRegistry.get(domain)) {
    return domain;
  }

  const fallbackAgents = agentRegistry.getAgentsForTopic(query);
  return fallbackAgents.length > 0 ? fallbackAgents[0].config.id : null;
}

// =============================================================================
// Task Graph Planning (LLM-based)
// =============================================================================

/**
 * Plan a task graph using LLM.
 * Falls back to heuristic-based graph if LLM fails.
 */
export async function planTaskGraph(
  query: string,
  intent: Intent,
  sharedContext: SharedAgentContext,
  informationGaps: string[],
  options: AnalysisOptions,
  modelRouter: ModelRouter,
  agentRegistry: DomainAgentRegistry,
  emitter: ProgressEmitter
): Promise<TaskGraphPlan> {
  const hypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'proposed' || h.status === 'investigating');
  const allowedDomains = ['frame', 'cpu', 'binder', 'memory', 'startup', 'interaction', 'anr', 'system', 'gpu', 'surfaceflinger', 'input', 'art'];

  const prompt = `你是主编排 Agent，需要输出任务图（Task Graph）。任务图要求：
- 每个任务只包含"证据与指标产出"，不要输出最终结论。
- 每个节点必须包含 domain、time_range、evidence_needed。
- domain 必须来自允许列表。

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
当前假设:
${hypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

已确认发现:
${sharedContext.confirmedFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

信息缺口:
${informationGaps.join('\n') || '无'}

可用 domain:
${allowedDomains.join(', ')}

请以 JSON 格式返回：
{
  "tasks": [
    {
      "id": "t1",
      "domain": "cpu",
      "description": "要收集的证据或指标",
      "evidence_needed": ["指标1", "指标2"],
      "time_range": { "start": 0, "end": 0 } | null,
      "depends_on": ["t0"]
    }
  ]
}

注意：
- time_range 无法确定时请返回 null。
- 只输出 JSON。`;

  try {
    const response = await modelRouter.callWithFallback(prompt, 'planning');
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const nodes = tasks.map((task: any, index: number): TaskGraphNode => {
        const id = String(task.id || `task_${index + 1}`);
        const domain = String(task.domain || '').toLowerCase();
        const evidenceNeeded = Array.isArray(task.evidence_needed)
          ? task.evidence_needed.map((e: any) => String(e))
          : Array.isArray(task.evidenceNeeded)
            ? task.evidenceNeeded.map((e: any) => String(e))
            : [];
        const timeRange = parseTimeRange(task.time_range ?? task.timeRange, options, sharedContext);
        const dependsOn = Array.isArray(task.depends_on)
          ? task.depends_on.map((d: any) => String(d))
          : Array.isArray(task.dependsOn)
            ? task.dependsOn.map((d: any) => String(d))
            : [];

        return {
          id,
          domain: domain || 'frame',
          description: String(task.description || task.task || '收集证据'),
          evidenceNeeded,
          timeRange,
          dependsOn,
        };
      });

      addMandatoryDomainsIfMissing(nodes, query, options, sharedContext);
      return { nodes };
    }
  } catch (error) {
    emitter.log(`Failed to plan task graph: ${error}`);
    emitter.emitUpdate('degraded', { module: 'taskGraphPlanner', fallback: 'heuristic task graph' });
  }

  const fallbackNodes = buildFallbackTaskGraph(query, options, sharedContext, agentRegistry);
  addMandatoryDomainsIfMissing(fallbackNodes, query, options, sharedContext);
  return { nodes: fallbackNodes };
}

// =============================================================================
// Building Concrete Tasks from Graph
// =============================================================================

/**
 * Convert TaskGraphPlan nodes into concrete AgentTasks for dispatch.
 */
export function buildTasksFromGraph(
  taskGraph: TaskGraphPlan,
  query: string,
  intent: Intent,
  sharedContext: SharedAgentContext,
  options: AnalysisOptions,
  agentRegistry: DomainAgentRegistry,
  emitter: ProgressEmitter
): AgentTask[] {
  const tasks: AgentTask[] = [];
  const hypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'proposed' || h.status === 'investigating');

  for (const node of taskGraph.nodes) {
    const resolvedDomain = normalizeDomain(node.domain);
    const agentId = resolveAgentIdForDomain(resolvedDomain, query, agentRegistry);
    if (!agentId) {
      emitter.log(`No agent for domain: ${node.domain}`);
      continue;
    }
    const evidenceNeeded = node.evidenceNeeded.length > 0
      ? node.evidenceNeeded
      : (DEFAULT_EVIDENCE[resolvedDomain] || ['关键指标', '异常点']);

    tasks.push({
      id: node.id || createTaskId(),
      description: node.description,
      targetAgentId: agentId,
      priority: 5,
      context: {
        query,
        intent: {
          primaryGoal: intent.primaryGoal,
          aspects: intent.aspects,
        },
        hypothesis: hypotheses[0],
        domain: resolvedDomain,
        timeRange: node.timeRange,
        evidenceNeeded,
        relevantFindings: sharedContext.confirmedFindings.slice(-5),
        additionalData: {
          traceProcessorService: options.traceProcessorService,
          packageName: options.packageName,
        },
      },
      dependencies: node.dependsOn || [],
      createdAt: Date.now(),
    });
  }

  return tasks;
}

// =============================================================================
// Helpers
// =============================================================================

function addMandatoryDomainsIfMissing(
  nodes: TaskGraphNode[],
  query: string,
  options: AnalysisOptions,
  sharedContext: SharedAgentContext
): void {
  const queryLower = query.toLowerCase();
  const requiredDomains: string[] = [];

  const scrollOrJank =
    queryLower.includes('滑动') ||
    queryLower.includes('scroll') ||
    queryLower.includes('jank') ||
    queryLower.includes('掉帧') ||
    queryLower.includes('卡顿');

  if (scrollOrJank) {
    requiredDomains.push('frame');
  }

  if (requiredDomains.length === 0) return;

  const existingDomains = new Set(nodes.map(n => normalizeDomain(n.domain)));

  for (const domain of requiredDomains) {
    if (existingDomains.has(domain)) continue;
    nodes.push({
      id: `mandatory_${domain}_${Date.now()}`,
      domain,
      description: `补充 ${domain} 关键证据与指标`,
      evidenceNeeded: DEFAULT_EVIDENCE[domain] || ['关键指标', '异常点'],
      timeRange: parseTimeRange(null, options, sharedContext),
      dependsOn: [],
    });
  }
}

function buildFallbackTaskGraph(
  query: string,
  options: AnalysisOptions,
  sharedContext: SharedAgentContext,
  agentRegistry: DomainAgentRegistry
): TaskGraphNode[] {
  const nodes: TaskGraphNode[] = [];
  const relevantAgents = agentRegistry.getAgentsForTopic(query);
  const fallbackAgents = relevantAgents.length > 0
    ? relevantAgents
    : agentRegistry.getAll().slice(0, 3);

  fallbackAgents.slice(0, 3).forEach((agent, index) => {
    const domain = agent.config.domain || 'frame';
    nodes.push({
      id: `fallback_${domain}_${index + 1}`,
      domain,
      description: `收集 ${domain} 相关证据与指标`,
      evidenceNeeded: DEFAULT_EVIDENCE[domain] || ['关键指标', '异常点'],
      timeRange: parseTimeRange(null, options, sharedContext),
      dependsOn: [],
    });
  });

  return nodes;
}
