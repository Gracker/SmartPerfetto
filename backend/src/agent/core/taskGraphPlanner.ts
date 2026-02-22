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
import { isPlainObject, LlmJsonSchema, parseLlmJson } from '../../utils/llmJson';

type TaskGraphJsonPayload = {
  tasks: any[];
};

const TASK_GRAPH_JSON_SCHEMA: LlmJsonSchema<TaskGraphJsonPayload> = {
  name: 'task_graph_json@1.0.0',
  validate: (value: unknown): value is TaskGraphJsonPayload => {
    if (!isPlainObject(value)) return false;
    if (!Array.isArray((value as any).tasks)) return false;
    return true;
  },
};

// =============================================================================
// Time Range Parsing
// =============================================================================

export function parseTimeRange(
  input: any,
  options: AnalysisOptions,
  sharedContext: SharedAgentContext
): { start: number | string; end: number | string } | undefined {
  const isValidBound = (v: any): v is number | string => {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.trim() !== '';
    return false;
  };

  if (input && typeof input === 'object') {
    const start = input.start;
    const end = input.end;
    if (isValidBound(start) && isValidBound(end)) {
      return { start, end };
    }
  }
  if (Array.isArray(input) && input.length >= 2) {
    const start = input[0];
    const end = input[1];
    if (isValidBound(start) && isValidBound(end)) {
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
  emitter: ProgressEmitter,
  hints?: { maxTasks?: number; historyContext?: string }
): Promise<TaskGraphPlan> {
  const hypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'proposed' || h.status === 'investigating');
  const allowedDomains = ['frame', 'cpu', 'binder', 'memory', 'startup', 'interaction', 'anr', 'system', 'gpu', 'surfaceflinger', 'input', 'art'];

  const maxTasks = typeof hints?.maxTasks === 'number'
    ? Math.max(1, Math.floor(hints.maxTasks))
    : undefined;
  const historyContext = typeof hints?.historyContext === 'string' ? hints.historyContext : '';

  const cxGaps = (Array.isArray(informationGaps) ? informationGaps : [])
    .map(g => String(g || '').trim())
    .filter(Boolean)
    .filter(g => /^\s*矛盾[:：]/.test(g));
  const otherGaps = (Array.isArray(informationGaps) ? informationGaps : [])
    .map(g => String(g || '').trim())
    .filter(Boolean)
    .filter(g => !/^\s*矛盾[:：]/.test(g));

  const prompt = `你是主编排 Agent，需要输出任务图（Task Graph）。任务图要求：
- 每个任务只包含"证据与指标产出"，不要输出最终结论。
- 每个节点必须包含 domain、time_range、evidence_needed。
- domain 必须来自允许列表。
- 任务应最大化信息增益：优先选择能验证/排除当前假设、填补信息缺口的最少步骤。
- 若存在“矛盾”，必须优先设计最小实验来消解矛盾（而不是继续堆叠更多指标却不解释冲突）。
${typeof maxTasks === 'number' ? `- 本轮最多输出 ${maxTasks} 个 task（代表最多 ${maxTasks} 个实验）。` : ''}

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
${historyContext ? `\n对话上下文摘要（用于避免重复、承接已做过的事）:\n${historyContext}\n` : ''}
${options.suggestedStrategy ? `建议策略（仅供参考，可复用其结构但不强制执行）:\n- ${options.suggestedStrategy.name} (id=${options.suggestedStrategy.id}, confidence=${typeof options.suggestedStrategy.confidence === 'number' ? options.suggestedStrategy.confidence.toFixed(2) : 'n/a'}, method=${options.suggestedStrategy.matchMethod || 'n/a'})\n${options.suggestedStrategy.reasoning ? `- reasoning: ${options.suggestedStrategy.reasoning}` : ''}\n` : ''}
当前假设:
${hypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

已确认发现:
${sharedContext.confirmedFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

高优先级矛盾（必须优先消解）:
${cxGaps.join('\n') || '无'}

信息缺口（用于下一步实验选择）:
${otherGaps.join('\n') || '无'}

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
    const response = await modelRouter.callWithFallback(prompt, 'planning', {
      sessionId: sharedContext.sessionId,
      traceId: sharedContext.traceId,
      jsonMode: true,
      promptId: 'agent.taskGraphPlanner',
      promptVersion: '1.0.0',
      contractVersion: 'task_graph_json@1.0.0',
    });
    const parsed = parseLlmJson<TaskGraphJsonPayload>(response.response, TASK_GRAPH_JSON_SCHEMA);
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
      const trimmedNodes = typeof maxTasks === 'number'
        ? trimNodesByBudget(nodes, maxTasks, query)
        : nodes;
      return { nodes: trimmedNodes };
  } catch (error) {
    emitter.log(`Failed to plan task graph: ${error}`);
    emitter.emitUpdate('degraded', { module: 'taskGraphPlanner', fallback: 'heuristic task graph' });
  }

  const fallbackNodes = buildFallbackTaskGraph(query, options, sharedContext, agentRegistry);
  addMandatoryDomainsIfMissing(fallbackNodes, query, options, sharedContext);
  const trimmedFallbackNodes = typeof maxTasks === 'number'
    ? trimNodesByBudget(fallbackNodes, maxTasks, query)
    : fallbackNodes;
  return { nodes: trimmedFallbackNodes };
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
  emitter: ProgressEmitter,
  hints?: { historyContext?: string }
): AgentTask[] {
  const tasks: AgentTask[] = [];
  const hypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'proposed' || h.status === 'investigating');
  const historyContext = typeof hints?.historyContext === 'string' ? hints.historyContext.trim() : '';

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
      timeout: options.taskTimeoutMs,
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
          adb: options.adb,
          adbContext: options.adbContext,
          ...(historyContext ? { historyContext } : {}),
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

function trimNodesByBudget(nodes: TaskGraphNode[], maxTasks: number, query: string): TaskGraphNode[] {
  if (nodes.length <= maxTasks) return nodes;

  const queryLower = query.toLowerCase();
  const requiredDomains: string[] = [];

  const scrollOrJank =
    queryLower.includes('滑动') ||
    queryLower.includes('scroll') ||
    queryLower.includes('jank') ||
    queryLower.includes('掉帧') ||
    queryLower.includes('卡顿');

  if (scrollOrJank) requiredDomains.push('frame');

  const required = new Set(requiredDomains.map(d => normalizeDomain(d)));

  // Stable prioritization: keep required domains first, then preserve original order.
  const scored = nodes.map((n, index) => {
    const domain = normalizeDomain(n.domain);
    const score = required.has(domain) ? 10 : 0;
    return { n, index, score };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, maxTasks).map(s => s.n);
}
