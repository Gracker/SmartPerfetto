/**
 * SmartPerfetto Base Agent
 *
 * Phase 2.1: Abstract base class for all AI domain agents
 *
 * This class provides the foundation for AI-driven domain agents that:
 * 1. Use Skills as tools through AI reasoning
 * 2. Can request information from other agents
 * 3. Build and verify hypotheses
 * 4. Generate evidence-backed findings
 *
 * The Think-Act-Reflect loop:
 * 1. Understand: Parse task and build understanding
 * 2. Plan: Decide which tools to use
 * 3. Execute: Run tools and collect results
 * 4. Reflect: Evaluate results and decide next steps
 * 5. Respond: Generate response with findings
 */

import { EventEmitter } from 'events';
import {
  AgentConfig,
  AgentTask,
  AgentTaskContext,
  AgentResponse,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  Hypothesis,
  HypothesisUpdate,
  Evidence,
  InterAgentQuestion,
  ReasoningStep,
  SharedAgentContext,
  createHypothesisId,
} from '../../types/agentProtocol';
import { Finding } from '../../types';
import { ModelRouter } from '../../core/modelRouter';
import { isPlainObject, isStringArray, LlmJsonSchema, parseLlmJson } from '../../../utils/llmJson';
import {
  SkillExecutor,
  createSkillExecutor,
  skillRegistry,
  ensureSkillRegistryInitialized,
  SkillExecutionResult,
} from '../../../services/skillEngine';

// =============================================================================
// Types
// =============================================================================

/**
 * Skill definition for lazy tool initialization in agents.
 * Agents declare which skills they use at construction time, but actual
 * tool creation is deferred to executeTask() when the async skill registry
 * is guaranteed to be initialized.
 */
export interface SkillDefinitionForAgent {
  skillId: string;
  toolName: string;
  description?: string;
  descriptionHint?: string;
  required?: boolean;
  category: AgentTool['category'];
}

/**
 * Configuration for the dynamic SQL upgrade path.
 * When predefined Skills return insufficient results, agents can
 * "upgrade" to dynamic SQL generation for more flexible analysis.
 */
export interface UpgradeConfig {
  /** Enable the upgrade path (default: true) */
  enabled: boolean;
  /** Minimum number of failed/empty steps before considering upgrade */
  minFailedSteps: number;
  /** Maximum retries for dynamic SQL (default: 2) */
  maxRetries: number;
  /** Required: explicit objective must be derivable from task */
  requireExplicitObjective: boolean;
}

/**
 * Result of checking if upgrade to dynamic SQL is eligible.
 */
export interface UpgradeEligibility {
  /** Whether upgrade should be attempted */
  eligible: boolean;
  /** Reason for the decision */
  reason: string;
  /** Suggested objective for SQL generation */
  suggestedObjective?: string;
  /** Failed step information for context */
  failedSteps?: string[];
}

const DEFAULT_UPGRADE_CONFIG: UpgradeConfig = {
  enabled: true,
  minFailedSteps: 1,
  maxRetries: 2,
  requireExplicitObjective: true,
};

/**
 * Understanding of a task
 */
export interface TaskUnderstanding {
  /** Main objective */
  objective: string;
  /** Key questions to answer */
  questions: string[];
  /** Relevant domain areas */
  relevantAreas: string[];
  /** Recommended tools to use */
  recommendedTools: string[];
  /** Constraints or requirements */
  constraints: string[];
  /** Confidence in understanding */
  confidence: number;
}

/**
 * Execution plan
 */
export interface ExecutionPlan {
  /** Sequence of tool calls */
  steps: ExecutionStep[];
  /** Expected outcomes */
  expectedOutcomes: string[];
  /** Estimated execution time */
  estimatedTimeMs: number;
  /** Plan confidence */
  confidence: number;
}

/**
 * Single execution step
 */
export interface ExecutionStep {
  stepNumber: number;
  toolName: string;
  params: Record<string, any>;
  purpose: string;
  dependsOn?: number[];
}

/**
 * Result of executing the plan
 */
export interface ExecutionResult {
  steps: ExecutionStepResult[];
  findings: Finding[];
  success: boolean;
  totalTimeMs: number;
}

/**
 * Result of a single execution step
 */
export interface ExecutionStepResult {
  stepNumber: number;
  toolName: string;
  result: AgentToolResult;
  observations: string[];
}

/**
 * Reflection on execution results
 */
export interface Reflection {
  /** What was learned */
  insights: string[];
  /** Whether objectives were met */
  objectivesMet: boolean;
  /** Confidence in findings */
  findingsConfidence: number;
  /** Gaps in analysis */
  gaps: string[];
  /** Suggested next steps */
  nextSteps: string[];
  /** Hypothesis updates */
  hypothesisUpdates: HypothesisUpdate[];
  /** Questions for other agents */
  questionsForOthers: InterAgentQuestion[];
}

// =============================================================================
// LLM JSON Schemas (Deterministic parsing)
// =============================================================================

type TaskUnderstandingPayload = Partial<TaskUnderstanding>;
const TASK_UNDERSTANDING_JSON_SCHEMA: LlmJsonSchema<TaskUnderstandingPayload> = {
  name: 'agent_task_understanding_json@1.0.0',
  validate: (value: unknown): value is TaskUnderstandingPayload => {
    if (!isPlainObject(value)) return false;
    if ((value as any).objective !== undefined && typeof (value as any).objective !== 'string') return false;
    if ((value as any).questions !== undefined && !isStringArray((value as any).questions)) return false;
    if ((value as any).relevantAreas !== undefined && !isStringArray((value as any).relevantAreas)) return false;
    if ((value as any).recommendedTools !== undefined && !isStringArray((value as any).recommendedTools)) return false;
    if ((value as any).constraints !== undefined && !isStringArray((value as any).constraints)) return false;
    const confidence = (value as any).confidence;
    if (confidence !== undefined && confidence !== null && typeof confidence !== 'number') return false;
    return true;
  },
};

type ExecutionPlanPayload = Partial<ExecutionPlan> & { steps?: Array<Record<string, any>> };
const EXECUTION_PLAN_JSON_SCHEMA: LlmJsonSchema<ExecutionPlanPayload> = {
  name: 'agent_execution_plan_json@1.0.0',
  validate: (value: unknown): value is ExecutionPlanPayload => {
    if (!isPlainObject(value)) return false;
    const steps = (value as any).steps;
    if (steps !== undefined && steps !== null && !Array.isArray(steps)) return false;
    const expectedOutcomes = (value as any).expectedOutcomes;
    if (expectedOutcomes !== undefined && expectedOutcomes !== null && !isStringArray(expectedOutcomes)) return false;
    const estimatedTimeMs = (value as any).estimatedTimeMs;
    if (estimatedTimeMs !== undefined && estimatedTimeMs !== null && typeof estimatedTimeMs !== 'number') return false;
    const confidence = (value as any).confidence;
    if (confidence !== undefined && confidence !== null && typeof confidence !== 'number') return false;
    return true;
  },
};

type ReflectionPayload = Partial<Reflection>;
const REFLECTION_JSON_SCHEMA: LlmJsonSchema<ReflectionPayload> = {
  name: 'agent_reflection_json@1.0.0',
  validate: (value: unknown): value is ReflectionPayload => {
    if (!isPlainObject(value)) return false;
    if ((value as any).insights !== undefined && !isStringArray((value as any).insights)) return false;
    const objectivesMet = (value as any).objectivesMet;
    if (objectivesMet !== undefined && objectivesMet !== null && typeof objectivesMet !== 'boolean') return false;
    const findingsConfidence = (value as any).findingsConfidence;
    if (findingsConfidence !== undefined && findingsConfidence !== null && typeof findingsConfidence !== 'number') return false;
    if ((value as any).gaps !== undefined && !isStringArray((value as any).gaps)) return false;
    if ((value as any).nextSteps !== undefined && !isStringArray((value as any).nextSteps)) return false;
    const hypothesisUpdates = (value as any).hypothesisUpdates;
    if (hypothesisUpdates !== undefined && hypothesisUpdates !== null && !Array.isArray(hypothesisUpdates)) return false;
    const questionsForOthers = (value as any).questionsForOthers;
    if (questionsForOthers !== undefined && questionsForOthers !== null && !Array.isArray(questionsForOthers)) return false;
    return true;
  },
};

// =============================================================================
// Base Agent Abstract Class
// =============================================================================

/**
 * Abstract base class for domain-specific AI agents
 *
 * Each domain agent (Frame, CPU, Memory, Binder, etc.) extends this class
 * and provides:
 * 1. Domain-specific tools (wrapped Skills)
 * 2. Domain-specific reasoning prompts
 * 3. Domain-specific hypothesis generation
 */
export abstract class BaseAgent extends EventEmitter {
  /** Agent configuration */
  readonly config: AgentConfig;
  /** Model router for LLM calls */
  protected modelRouter: ModelRouter;
  /** Available tools */
  protected tools: Map<string, AgentTool>;
  /** Skill definitions for lazy tool initialization */
  protected skillDefinitions: SkillDefinitionForAgent[] = [];
  /** Whether tools have been lazily loaded from skill definitions */
  private toolsLoaded: boolean = false;
  /** Cached SkillExecutor with registered skills */
  private skillExecutorCache:
    | {
        traceProcessorService: any;
        aiService: any;
        executor: SkillExecutor;
      }
    | null = null;
  /** Current shared context */
  protected sharedContext: SharedAgentContext | null = null;
  /** Reasoning trace */
  protected reasoningTrace: ReasoningStep[] = [];
  /** Current iteration */
  protected currentIteration: number = 0;
  /** Upgrade path configuration */
  protected upgradeConfig: UpgradeConfig = { ...DEFAULT_UPGRADE_CONFIG };
  /** Track upgrade attempts per task */
  private upgradeAttempts: number = 0;

  constructor(config: AgentConfig, modelRouter: ModelRouter, skillDefs?: SkillDefinitionForAgent[]) {
    super();
    this.config = config;
    this.modelRouter = modelRouter;
    this.tools = new Map();

    // Register any tools already in config (non-skill tools)
    for (const tool of config.tools) {
      this.tools.set(tool.name, tool);
    }

    // Store skill definitions for lazy loading
    if (skillDefs) {
      this.skillDefinitions = skillDefs;
    }
  }

  // ==========================================================================
  // Abstract Methods - Must be implemented by domain agents
  // ==========================================================================

  /**
   * Build domain-specific system prompt for understanding
   */
  protected abstract buildUnderstandingPrompt(task: AgentTask): string;

  /**
   * Build domain-specific system prompt for planning
   */
  protected abstract buildPlanningPrompt(understanding: TaskUnderstanding, task: AgentTask): string;

  /**
   * Build domain-specific system prompt for reflection
   */
  protected abstract buildReflectionPrompt(result: ExecutionResult, task: AgentTask): string;

  /**
   * Generate domain-specific hypotheses based on findings
   */
  protected abstract generateHypotheses(findings: Finding[], task: AgentTask): Promise<Hypothesis[]>;

  /**
   * Get domain-specific tool recommendations (subclass override)
   */
  protected abstract getRecommendedTools(context: AgentTaskContext): string[];

  /**
   * Resolve tools for a task context.
   * Generic: if orchestrator specifies `additionalData.focusTools`, restricts to those tools.
   * Otherwise falls back to subclass's getRecommendedTools().
   * This allows any orchestrator to control agent tool selection without scenario-specific flags.
   */
  private resolveToolsForTask(context: AgentTaskContext): string[] {
    const focusTools = (context.additionalData as any)?.focusTools;
    if (Array.isArray(focusTools) && focusTools.length > 0) {
      // Only return focusTools that this agent actually has registered
      const validTools = focusTools.filter((t: string) => this.tools.has(t));
      if (validTools.length > 0) return validTools;
    }
    return this.getRecommendedTools(context);
  }

  // ==========================================================================
  // Core Agent Loop
  // ==========================================================================

  /**
   * Execute a task through the Think-Act-Reflect loop
   */
  async executeTask(task: AgentTask, sharedContext: SharedAgentContext): Promise<AgentResponse> {
    const startTime = Date.now();
    this.sharedContext = sharedContext;
    this.reasoningTrace = [];
    this.currentIteration = 0;
    this.resetUpgradeState(); // Reset upgrade attempts for new task

    // Ensure skill-based tools are loaded (lazy initialization)
    await this.ensureToolsLoaded();

    this.emit('task_started', { agentId: this.config.id, taskId: task.id });

    try {
      // 1. Understand the task
      this.addReasoningStep('observation', 'Analyzing task requirements');
      const understanding = await this.understand(task);
      this.emit('understanding_complete', { agentId: this.config.id, understanding });

      // 2. Plan execution
      this.addReasoningStep('analysis', 'Creating execution plan');
      const plan = await this.plan(understanding, task);
      this.emit('plan_created', { agentId: this.config.id, plan });

      // 3. Execute plan
      this.addReasoningStep('action', `Executing ${plan.steps.length} steps`);
      const result = await this.execute(plan, task);
      this.emit('execution_complete', { agentId: this.config.id, result });

      // 4. Reflect on results
      this.addReasoningStep('analysis', 'Reflecting on results');
      const reflection = await this.reflect(result, task);
      this.emit('reflection_complete', { agentId: this.config.id, reflection });

      // 5. Generate response
      const response = await this.respond(reflection, result, task, startTime);
      this.emit('task_completed', { agentId: this.config.id, response });

      return response;

    } catch (error: any) {
      this.emit('task_failed', { agentId: this.config.id, taskId: task.id, error: error.message });

      return {
        agentId: this.config.id,
        taskId: task.id,
        success: false,
        findings: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        reasoning: this.reasoningTrace,
      };
    }
  }

  // ==========================================================================
  // Think-Act-Reflect Steps
  // ==========================================================================

  /**
   * Step 1: Understand the task
   */
  protected async understand(task: AgentTask): Promise<TaskUnderstanding> {
    const prompt = this.buildUnderstandingPrompt(task);

    const response = await this.modelRouter.callWithFallback(prompt, 'intent_understanding', {
      sessionId: this.sharedContext?.sessionId,
      traceId: this.sharedContext?.traceId,
      jsonMode: true,
      promptId: `agent.${this.config.id}.understand`,
      promptVersion: '1.0.0',
      contractVersion: TASK_UNDERSTANDING_JSON_SCHEMA.name,
    });

    try {
      const parsed = parseLlmJson<TaskUnderstandingPayload>(response.response, TASK_UNDERSTANDING_JSON_SCHEMA);
      return {
        objective: parsed.objective || task.description,
        questions: parsed.questions || [],
        relevantAreas: parsed.relevantAreas || [],
        recommendedTools: parsed.recommendedTools || this.resolveToolsForTask(task.context),
        constraints: parsed.constraints || [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
      };
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse understanding response`);
    }

    // Fallback to basic understanding
    return {
      objective: task.description,
      questions: [],
      relevantAreas: [this.config.domain],
      recommendedTools: this.resolveToolsForTask(task.context),
      constraints: [],
      confidence: 0.5,
    };
  }

  /**
   * Step 2: Plan execution
   */
  protected async plan(understanding: TaskUnderstanding, task: AgentTask): Promise<ExecutionPlan> {
    const prompt = this.buildPlanningPrompt(understanding, task);
    const focusedTools = this.resolveToolsForTask(task.context);
    const hasToolFocus = Array.isArray((task.context.additionalData as any)?.focusTools)
      && (task.context.additionalData as any).focusTools.length > 0;
    const focusedToolSet = new Set(focusedTools);

    const response = await this.modelRouter.callWithFallback(prompt, 'planning', {
      sessionId: this.sharedContext?.sessionId,
      traceId: this.sharedContext?.traceId,
      jsonMode: true,
      promptId: `agent.${this.config.id}.plan`,
      promptVersion: '1.0.0',
      contractVersion: EXECUTION_PLAN_JSON_SCHEMA.name,
    });

    try {
      const parsed = parseLlmJson<ExecutionPlanPayload>(response.response, EXECUTION_PLAN_JSON_SCHEMA);
      const plannedSteps = (parsed.steps || [])
        .map((s: any, i: number) => ({
          stepNumber: i + 1,
          toolName: s.toolName || s.tool,
          params: s.params || {},
          purpose: s.purpose || `Execute ${s.toolName || s.tool}`,
          // Note: dependsOn is intentionally stripped — domain agent tools are
          // independent analysis units. The LLM-generated dependencies cause
          // cascade failures when tool names are filtered out, as step numbers
          // get re-assigned but dependsOn values aren't updated.
        }))
        .filter((step: any) => step.toolName && this.tools.has(step.toolName))
        .filter((step: any) => !hasToolFocus || focusedToolSet.has(step.toolName))
        // Deduplicate tools: LLM may return duplicate tool calls which cause redundant execution.
        // Keep the first occurrence of each tool (preserves LLM's priority order).
        .filter((step: any, index: number, self: any[]) =>
          self.findIndex((s: any) => s.toolName === step.toolName) === index
        );

      if (plannedSteps.length === 0) {
        const recommendedTools = understanding.recommendedTools.length > 0
          ? understanding.recommendedTools
          : focusedTools;
        const fallbackTools = hasToolFocus
          ? recommendedTools.filter((toolName: string) => focusedToolSet.has(toolName))
          : recommendedTools;
        const finalFallbackTools = fallbackTools.length > 0 ? fallbackTools : focusedTools;
        return {
          steps: finalFallbackTools.map((toolName, i) => ({
            stepNumber: i + 1,
            toolName,
            params: {},
            purpose: `Execute ${toolName}`,
          })),
          expectedOutcomes: parsed.expectedOutcomes || [],
          estimatedTimeMs: typeof parsed.estimatedTimeMs === 'number' ? parsed.estimatedTimeMs : 30000,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        };
      }

      return {
        steps: plannedSteps.map((step: any, i: number) => ({
          ...step,
          stepNumber: i + 1,
        })),
        expectedOutcomes: parsed.expectedOutcomes || [],
        estimatedTimeMs: typeof parsed.estimatedTimeMs === 'number' ? parsed.estimatedTimeMs : 30000,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
      };
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse planning response`);
    }

    // Fallback to using recommended tools
    return {
      steps: focusedTools.map((toolName, i) => ({
        stepNumber: i + 1,
        toolName,
        params: {},
        purpose: `Execute ${toolName}`,
      })),
      expectedOutcomes: [`Analyze ${this.config.domain}`],
      estimatedTimeMs: 30000,
      confidence: 0.5,
    };
  }

  /**
   * Step 3: Execute the plan
   */
  protected async execute(plan: ExecutionPlan, task: AgentTask): Promise<ExecutionResult> {
    const stepResults: ExecutionStepResult[] = [];
    const allFindings: Finding[] = [];
    let anyStepSucceeded = false;

    // Build tool context
    const toolContext: AgentToolContext = {
      sessionId: this.sharedContext?.sessionId || '',
      traceId: this.sharedContext?.traceId || '',
      traceProcessorService: task.context.additionalData?.traceProcessorService,
      packageName: task.context.additionalData?.packageName,
      timeRange: task.context.timeRange,
      aiService: task.context.additionalData?.aiService,
      additionalContext: {
        ...(task.context.additionalData || {}),
        taskId: task.id,
        agentId: this.config.id,
      },
    };

    // Log plan steps for debugging duplicate execution issues
    console.log(`[${this.config.id}] Executing plan with ${plan.steps.length} step(s): [${plan.steps.map(s => s.toolName).join(', ')}]`);

    // Execute each step
    for (const step of plan.steps) {
      // Check dependencies
      if (step.dependsOn) {
        const pendingDeps = step.dependsOn.filter(dep =>
          !stepResults.find(r => r.stepNumber === dep && r.result.success)
        );
        if (pendingDeps.length > 0) {
          console.warn(`[${this.config.id}] Skipping step ${step.stepNumber} - dependencies not met`);
          continue;
        }
      }

      // Get tool
      const tool = this.tools.get(step.toolName);
      if (!tool) {
        console.warn(`[${this.config.id}] Tool not found: ${step.toolName}`);
        stepResults.push({
          stepNumber: step.stepNumber,
          toolName: step.toolName,
          result: { success: false, error: `Tool not found: ${step.toolName}`, executionTimeMs: 0 },
          observations: [`Tool ${step.toolName} not available`],
        });
        continue;
      }

      // Execute tool
      this.emit('tool_executing', { agentId: this.config.id, toolName: step.toolName, step: step.stepNumber });

      const result = await tool.execute(step.params, toolContext);

      this.emit('tool_completed', { agentId: this.config.id, toolName: step.toolName, success: result.success });

      // Collect findings
      if (result.findings) {
        allFindings.push(...result.findings);
      }

      // Generate observations
      const observations = this.generateObservations(result);

      stepResults.push({
        stepNumber: step.stepNumber,
        toolName: step.toolName,
        result,
        observations,
      });

      if (result.success) {
        anyStepSucceeded = true;
      }
    }

    // Agent execution succeeds if at least one tool returned data successfully.
    // Individual tool failures (e.g., missing tables) don't invalidate the whole analysis.
    let success = anyStepSucceeded || stepResults.length === 0;

    // ==========================================================================
    // Upgrade Path: Try dynamic SQL when predefined Skills return insufficient results
    // ==========================================================================
    if (this.upgradeConfig.enabled && !anyStepSucceeded && allFindings.length === 0) {
      const upgradeCheck = this.checkUpgradeEligibility(task, stepResults, toolContext);

      if (upgradeCheck.eligible && upgradeCheck.suggestedObjective) {
        this.emit('upgrade_attempting', {
          agentId: this.config.id,
          reason: upgradeCheck.reason,
          objective: upgradeCheck.suggestedObjective,
          attempt: this.upgradeAttempts + 1,
        });

        const upgradeResult = await this.tryDynamicSQLUpgrade(
          upgradeCheck.suggestedObjective,
          toolContext,
          task
        );

        if (upgradeResult.success) {
          // Merge upgrade results
          if (upgradeResult.findings) {
            allFindings.push(...upgradeResult.findings);
          }
          stepResults.push({
            stepNumber: stepResults.length + 1,
            toolName: '_dynamic_sql_upgrade',
            result: upgradeResult,
            observations: [`Dynamic SQL upgrade succeeded: ${upgradeResult.data?.rows?.length || 0} rows returned`],
          });
          anyStepSucceeded = true;
          success = true;

          this.emit('upgrade_succeeded', {
            agentId: this.config.id,
            findingsCount: upgradeResult.findings?.length || 0,
            rowCount: upgradeResult.data?.rows?.length || 0,
          });
        } else {
          this.emit('upgrade_failed', {
            agentId: this.config.id,
            error: upgradeResult.error,
          });
        }
      }
    }

    return {
      steps: stepResults,
      findings: allFindings,
      success,
      totalTimeMs: stepResults.reduce((sum, r) => sum + r.result.executionTimeMs, 0),
    };
  }

  // ==========================================================================
  // Upgrade Path Methods (v2.0)
  // ==========================================================================

  /**
   * Check if the agent should attempt a dynamic SQL upgrade.
   *
   * Upgrade is eligible when:
   * 1. Upgrade path is enabled
   * 2. Predefined skills returned no useful results
   * 3. We haven't exceeded retry limits
   * 4. Task has a clear objective we can convert to SQL
   */
  protected checkUpgradeEligibility(
    task: AgentTask,
    stepResults: ExecutionStepResult[],
    toolContext: AgentToolContext
  ): UpgradeEligibility {
    // Check if upgrade is enabled
    if (!this.upgradeConfig.enabled) {
      return { eligible: false, reason: 'Upgrade path disabled' };
    }

    // Check retry limit
    if (this.upgradeAttempts >= this.upgradeConfig.maxRetries) {
      return { eligible: false, reason: `Max upgrade retries (${this.upgradeConfig.maxRetries}) exceeded` };
    }

    // Check if trace processor is available
    if (!toolContext.traceProcessorService) {
      return { eligible: false, reason: 'TraceProcessorService not available' };
    }

    // Count failed steps
    const failedSteps = stepResults.filter(s => !s.result.success);
    const failedStepNames = failedSteps.map(s => s.toolName);

    if (failedSteps.length < this.upgradeConfig.minFailedSteps) {
      return { eligible: false, reason: `Not enough failed steps (${failedSteps.length} < ${this.upgradeConfig.minFailedSteps})` };
    }

    // Build suggested objective from task description
    const suggestedObjective = this.buildUpgradeObjective(task, failedStepNames);

    if (!suggestedObjective && this.upgradeConfig.requireExplicitObjective) {
      return { eligible: false, reason: 'Could not derive clear objective from task' };
    }

    return {
      eligible: true,
      reason: `${failedSteps.length} steps failed, attempting dynamic SQL upgrade`,
      suggestedObjective: suggestedObjective || task.description,
      failedSteps: failedStepNames,
    };
  }

  /**
   * Build an objective for dynamic SQL based on the failed task.
   * Subclasses can override for domain-specific objective building.
   */
  protected buildUpgradeObjective(task: AgentTask, failedTools: string[]): string | undefined {
    // Extract key information from task
    const { description, context } = task;
    const timeRange = context.timeRange;
    const packageName = context.additionalData?.packageName;

    // Build a focused objective
    const parts: string[] = [];

    // Add main objective
    parts.push(description);

    // Add time constraints if available
    if (timeRange?.start && timeRange?.end) {
      parts.push(`时间范围: ${timeRange.start} - ${timeRange.end}`);
    }

    // Add package/process filter if available
    if (packageName) {
      parts.push(`目标进程: ${packageName}`);
    }

    // Add context about what failed
    if (failedTools.length > 0) {
      parts.push(`注意: 以下预定义分析失败 [${failedTools.join(', ')}]，请尝试其他方式获取数据`);
    }

    return parts.join('\n');
  }

  /**
   * Attempt to execute dynamic SQL for the given objective.
   *
   * This is the "escape hatch" when predefined Skills can't satisfy the analysis need.
   */
  protected async tryDynamicSQLUpgrade(
    objective: string,
    toolContext: AgentToolContext,
    task: AgentTask
  ): Promise<AgentToolResult> {
    this.upgradeAttempts++;
    const startTime = Date.now();

    console.log(`[${this.config.id}] Attempting dynamic SQL upgrade (attempt ${this.upgradeAttempts})`);

    try {
      const result = await this.generateAndExecuteSQL(objective, toolContext);

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Dynamic SQL execution failed',
          executionTimeMs: Date.now() - startTime,
          metadata: {
            kind: 'sql',
            toolName: '_dynamic_sql_upgrade',
            type: 'dynamic_sql_upgrade',
            objective,
            upgradeAttempt: this.upgradeAttempts,
            ...(toolContext.packageName && { packageName: toolContext.packageName }),
            ...(toolContext.timeRange && { timeRange: toolContext.timeRange }),
            ...(typeof result.repairAttempts === 'number' && { repairAttempts: result.repairAttempts }),
            ...(Array.isArray(result.repairErrors) && result.repairErrors.length > 0 && { repairErrorsCount: result.repairErrors.length }),
            sql: result.generatedSQL?.sql,
            explanation: result.generatedSQL?.explanation,
          },
        };
      }

      // Convert query result to findings if we got data
      const findings: Finding[] = [];

      if (result.queryResult?.rows && result.queryResult.rows.length > 0) {
        // Generate a finding summarizing the dynamic query results
        findings.push({
          id: `dynamic_sql_${this.config.id}_${Date.now()}`,
          category: 'dynamic_analysis',
          type: 'dynamic_sql_result',
          severity: 'info',
          title: `动态查询结果 (${result.queryResult.rows.length} 行)`,
          description: result.generatedSQL?.explanation || '通过动态 SQL 获取的分析数据',
          source: this.config.id,
          confidence: 0.7, // Lower confidence for dynamic results
          details: {
            sql: result.generatedSQL?.sql,
            rowCount: result.queryResult.rows.length,
            columns: result.queryResult.columns,
            // Include first few rows as preview
            sampleData: result.queryResult.rows.slice(0, 5),
            objective,
            upgradeAttempt: this.upgradeAttempts,
          },
        });
      }

      return {
        success: true,
        data: result.queryResult,
        findings,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          kind: 'sql',
          toolName: '_dynamic_sql_upgrade',
          type: 'dynamic_sql_upgrade',
          objective,
          upgradeAttempt: this.upgradeAttempts,
          ...(toolContext.packageName && { packageName: toolContext.packageName }),
          ...(toolContext.timeRange && { timeRange: toolContext.timeRange }),
          ...(typeof result.repairAttempts === 'number' && { repairAttempts: result.repairAttempts }),
          ...(Array.isArray(result.repairErrors) && result.repairErrors.length > 0 && { repairErrorsCount: result.repairErrors.length }),
          sql: result.generatedSQL?.sql,
          explanation: result.generatedSQL?.explanation,
        },
      };
    } catch (error: any) {
      console.error(`[${this.config.id}] Dynamic SQL upgrade failed:`, error.message);
      return {
        success: false,
        error: `Dynamic SQL upgrade failed: ${error.message}`,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          kind: 'sql',
          toolName: '_dynamic_sql_upgrade',
          type: 'dynamic_sql_upgrade',
          objective,
          upgradeAttempt: this.upgradeAttempts,
          ...(toolContext.packageName && { packageName: toolContext.packageName }),
          ...(toolContext.timeRange && { timeRange: toolContext.timeRange }),
          error: String(error?.message || error),
        },
      };
    }
  }

  /**
   * Reset upgrade attempts counter. Called at the start of each task.
   */
  protected resetUpgradeState(): void {
    this.upgradeAttempts = 0;
  }

  /**
   * Configure the upgrade path behavior.
   * Subclasses can call this to customize upgrade behavior.
   */
  protected configureUpgrade(config: Partial<UpgradeConfig>): void {
    this.upgradeConfig = { ...this.upgradeConfig, ...config };
  }

  /**
   * Step 4: Reflect on results
   */
  protected async reflect(result: ExecutionResult, task: AgentTask): Promise<Reflection> {
    const prompt = this.buildReflectionPrompt(result, task);

    const response = await this.modelRouter.callWithFallback(prompt, 'evaluation', {
      sessionId: this.sharedContext?.sessionId,
      traceId: this.sharedContext?.traceId,
      jsonMode: true,
      promptId: `agent.${this.config.id}.reflect`,
      promptVersion: '1.0.0',
      contractVersion: REFLECTION_JSON_SCHEMA.name,
    });

    try {
      const parsed = parseLlmJson<ReflectionPayload>(response.response, REFLECTION_JSON_SCHEMA);
      return {
        insights: parsed.insights || [],
        objectivesMet: parsed.objectivesMet ?? result.success,
        findingsConfidence: typeof parsed.findingsConfidence === 'number' ? parsed.findingsConfidence : 0.5,
        gaps: parsed.gaps || [],
        nextSteps: parsed.nextSteps || [],
        hypothesisUpdates: parsed.hypothesisUpdates || [],
        questionsForOthers: parsed.questionsForOthers || [],
      };
    } catch (error) {
      console.warn(`[${this.config.id}] Failed to parse reflection response`);
    }

    // Fallback reflection
    return {
      insights: result.steps.flatMap(s => s.observations),
      objectivesMet: result.success,
      findingsConfidence: result.success ? 0.6 : 0.3,
      gaps: [],
      nextSteps: [],
      hypothesisUpdates: [],
      questionsForOthers: [],
    };
  }

  /**
   * Step 5: Generate final response
   */
  protected async respond(
    reflection: Reflection,
    result: ExecutionResult,
    task: AgentTask,
    startTime: number
  ): Promise<AgentResponse> {
    // Generate hypotheses based on findings
    const hypotheses = await this.generateHypotheses(result.findings, task);

    // Convert hypotheses to updates
    const hypothesisUpdates: HypothesisUpdate[] = hypotheses.map(h => ({
      hypothesisId: h.id,
      action: 'support',
      newConfidence: h.confidence,
      reason: `Generated from ${this.config.id} analysis`,
    }));

    // Add reflection hypothesis updates
    hypothesisUpdates.push(...reflection.hypothesisUpdates);

    const questionsForAgents: InterAgentQuestion[] = (reflection.questionsForOthers || [])
      .map((q: any) => {
        // LLMs sometimes return strings or partial objects; normalize to InterAgentQuestion
        if (typeof q === 'string') {
          return {
            fromAgent: this.config.id,
            toAgent: 'system_admin',
            question: q,
            priority: 5,
          } as InterAgentQuestion;
        }

        if (!q || typeof q !== 'object') return null;

        const question = typeof q.question === 'string' ? q.question : undefined;
        if (!question) return null;

        const toAgent = typeof q.toAgent === 'string' ? q.toAgent : 'system_admin';
        const priority = typeof q.priority === 'number' ? q.priority : 5;
        const context = q.context && typeof q.context === 'object' ? q.context : undefined;

        return {
          fromAgent: this.config.id,
          toAgent,
          question,
          context,
          priority,
        } as InterAgentQuestion;
      })
      .filter(Boolean) as InterAgentQuestion[];

    return {
      agentId: this.config.id,
      taskId: task.id,
      success: result.success,
      findings: result.findings,
      hypothesisUpdates,
      questionsForAgents,
      suggestions: reflection.nextSteps,
      confidence: reflection.findingsConfidence,
      executionTimeMs: Date.now() - startTime,
      toolResults: result.steps.map(s => s.result),
      reasoning: this.reasoningTrace,
    };
  }

  // ==========================================================================
  // Lazy Tool Loading
  // ==========================================================================

  /**
   * Ensure skill-based tools are loaded.
   * Called at the start of executeTask() — by this time the skill registry
   * is guaranteed to be initialized (the orchestrator awaits it before dispatching).
   */
  protected async ensureToolsLoaded(): Promise<void> {
    if (this.toolsLoaded) return;
    if (this.skillDefinitions.length === 0) {
      this.toolsLoaded = true;
      return;
    }

    await ensureSkillRegistryInitialized();
    const missingRequiredSkills: string[] = [];

    for (const skillDef of this.skillDefinitions) {
      const toolName = skillDef.toolName || skillDef.skillId;
      if (this.tools.has(toolName)) continue;

      const skill = skillRegistry.getSkill(skillDef.skillId);
      if (!skill) {
        if (skillDef.required === false) {
          console.warn(`[${this.config.id}] Optional skill not found: ${skillDef.skillId}`);
          continue;
        }
        missingRequiredSkills.push(skillDef.skillId);
        continue;
      }

      const tool: AgentTool = {
        name: toolName,
        description: this.resolveSkillToolDescription(skillDef, skill),
        skillId: skillDef.skillId,
        category: skillDef.category,
        parameters: skill.inputs?.map((input: any) => ({
          name: input.name,
          type: input.type as any,
          required: input.required,
          description: input.description || input.name,
          default: input.default,
        })),
        execute: this.createSkillToolExecutor(toolName, skillDef.skillId, skillDef.category),
      };

      this.tools.set(tool.name, tool);
    }

    if (missingRequiredSkills.length > 0) {
      throw new Error(
        `[${this.config.id}] Required skills missing: ${missingRequiredSkills.join(', ')}`
      );
    }

    this.toolsLoaded = true;
    if (this.tools.size > 0) {
      console.log(`[${this.config.id}] Loaded ${this.tools.size} tools from skills`);
    }
  }

  private resolveSkillToolDescription(skillDef: SkillDefinitionForAgent, skill: any): string {
    const base = (skillDef.description && skillDef.description.trim())
      || (skill?.meta?.description && String(skill.meta.description).trim())
      || (skill?.meta?.display_name && String(skill.meta.display_name).trim())
      || skillDef.skillId;
    const hint = skillDef.descriptionHint && skillDef.descriptionHint.trim();
    return hint ? `${base}。${hint}` : base;
  }

  /**
   * Create a tool executor function for a given skill ID.
   * Shared across all domain agents — eliminates code duplication.
   */
  protected createSkillToolExecutor(
    toolName: string,
    skillId: string,
    category: string
  ): (params: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult> {
    return async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
      const startTime = Date.now();
      const additional = (context.additionalContext || {}) as Record<string, any>;
      const scopeLabel = typeof additional.scopeLabel === 'string' ? additional.scopeLabel.trim() : '';

      const baseMetadata: Record<string, any> = {
        kind: 'skill',
        toolName,
        skillId,
        category,
        executionMode: 'agent',
        ...(context.packageName && { packageName: context.packageName }),
        ...(context.timeRange && { timeRange: context.timeRange }),
        ...(scopeLabel && { scopeLabel }),
      };

      try {
        if (!context.traceProcessorService) {
          return {
            success: false,
            error: 'TraceProcessorService not available',
            executionTimeMs: Date.now() - startTime,
            metadata: baseMetadata,
          };
        }

        // SkillExecutor instances have their own registry; ensure skills are registered
        // before executing (otherwise every tool call will fail with "Skill not found").
        const executor = await this.getOrCreateSkillExecutor(
          context.traceProcessorService,
          context.aiService
        );

        const execParams: Record<string, any> = { ...params };

        // Normalize package/process parameters:
        // - Prefer explicit context.packageName when present
        // - Avoid overwriting user-provided params with undefined
        if (typeof context.packageName === 'string' && context.packageName.trim()) {
          execParams.package = context.packageName.trim();
        }

        // Backwards-compatible aliases used by some legacy skills.
        const pkg = typeof execParams.package === 'string' ? execParams.package.trim() : '';
        if (pkg) {
          if (execParams.package_name === undefined) execParams.package_name = pkg;
          if (execParams.process_name === undefined) execParams.process_name = pkg;
        }

        if (context.timeRange) {
          // Pass timestamps as strings to preserve precision for values > Number.MAX_SAFE_INTEGER.
          // SQL template substitution (${start_ts}) handles string values correctly.
          execParams.start_ts = String(context.timeRange.start);
          execParams.end_ts = String(context.timeRange.end);

          // Legacy GPU/other skills use seconds-based range fields.
          // Provide them as integer seconds (string) to keep SQL template substitution simple.
          try {
            const startNs = BigInt(execParams.start_ts);
            const endNs = BigInt(execParams.end_ts);
            const startSec = (startNs / 1000000000n).toString();
            const endSec = (endNs / 1000000000n).toString();
            if (execParams.time_range_start === undefined) execParams.time_range_start = startSec;
            if (execParams.time_range_end === undefined) execParams.time_range_end = endSec;
          } catch {
            // Best-effort only; keep start_ts/end_ts as the source of truth.
          }
        }

        // Generic skill params: orchestrators pass extra skill parameters via additionalContext.skillParams.
        // This allows controlling skill behavior without the baseAgent needing to know specific skill IDs.
        if (additional.skillParams && typeof additional.skillParams === 'object') {
          for (const [key, val] of Object.entries(additional.skillParams)) {
            if (val !== undefined && val !== null) {
              execParams[key] = val;
            }
          }
        }

        const result = await executor.execute(skillId, context.traceId, execParams, {});

        const findings = this.extractFindingsFromResult(result, skillId, category);
        const data = this.extractDataFromResult(result);

        // Derive group: if a task has both a timeRange and a scopeLabel, it's part of a
        // multi-interval analysis and should be grouped by its interval.
        // This is generic — works for scrolling intervals, startup phases, ANR windows, etc.
        const derivedGroup =
          (typeof additional.group === 'string' && additional.group)  // explicit override
            ? additional.group
            : (context.timeRange && scopeLabel)  // auto-derive from timeRange
              ? `interval_${String(context.timeRange.start)}`
              : undefined;

        const dataEnvelopes = SkillExecutor.toDataEnvelopes(result).map((env) => {
          const executionId =
            typeof additional.executionId === 'string' ? additional.executionId :
            typeof additional.taskId === 'string' ? additional.taskId :
            `${skillId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          // Make envelope source unique per execution so frontend can render repeated analyses
          // (e.g., per-interval deep dives) without deduping them away.
          env.meta.source = `${env.meta.source}#${executionId}`;

          if (scopeLabel) {
            env.display.title = `${scopeLabel} · ${env.display.title}`;
          }

          // Assign group for frontend interval grouping
          if (derivedGroup) {
            env.display.group = derivedGroup;
          }

          // Grouped results are collapsible; collapse empty tables by default
          if (env.display.group) {
            env.display.collapsible = true;
            const payload = env.data as any;
            const rows = payload?.rows;
            if (!rows || !Array.isArray(rows) || rows.length === 0) {
              env.display.defaultCollapsed = true;
            }
          }

          return env;
        });

        console.log(`[${this.config.id}] Skill ${skillId} executed: success=${result.success}, displayResults=${result.displayResults?.length || 0}, dataEnvelopes=${dataEnvelopes.length}`);

        return {
          success: result.success,
          data,
          findings,
          dataEnvelopes: dataEnvelopes.length > 0 ? dataEnvelopes : undefined,
          error: result.error,
          executionTimeMs: Date.now() - startTime,
          metadata: {
            ...baseMetadata,
            // Keep params compact; this is for provenance/debugging, not full replay.
            paramsKeys: Object.keys(execParams).slice(0, 40),
            ...(derivedGroup && { group: derivedGroup }),
          },
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          executionTimeMs: Date.now() - startTime,
          metadata: baseMetadata,
        };
      }
    };
  }

  private async getOrCreateSkillExecutor(traceProcessorService: any, aiService: any): Promise<SkillExecutor> {
    await ensureSkillRegistryInitialized();

    if (
      this.skillExecutorCache &&
      this.skillExecutorCache.traceProcessorService === traceProcessorService &&
      this.skillExecutorCache.aiService === aiService
    ) {
      return this.skillExecutorCache.executor;
    }

    const executor = createSkillExecutor(traceProcessorService, aiService);
    executor.registerSkills(skillRegistry.getAllSkills());

    this.skillExecutorCache = {
      traceProcessorService,
      aiService,
      executor,
    };

    return executor;
  }

  /**
   * Extract findings from skill execution result.
   * Subclasses can override for domain-specific extraction logic.
   */
  protected extractFindingsFromResult(result: SkillExecutionResult, skillId: string, category: string): Finding[] {
    const findings: Finding[] = [];
    if (result.diagnostics && result.diagnostics.length > 0) {
      for (const diag of result.diagnostics) {
        findings.push({
          id: `${skillId}_${Date.now()}_${findings.length}`,
          category,
          severity: diag.severity,
          title: diag.diagnosis,
          description: diag.suggestions?.join('; ') || diag.diagnosis,
          source: skillId,
          confidence: typeof diag.confidence === 'number' ? diag.confidence : 0.8,
          details: diag.evidence,
        });
      }
    }

    // Deterministic insight finding from synthesize summary (洞见摘要) if available.
    // This improves "agent-ness" by turning structured skill outputs into citeable findings,
    // reducing reliance on ai_summary.
    const synthFinding = this.extractSynthesizeSummaryFinding(result, skillId, category);
    if (synthFinding) {
      findings.push(synthFinding);
    }
    return findings;
  }

  private extractSynthesizeSummaryFinding(
    result: SkillExecutionResult,
    skillId: string,
    category: string
  ): Finding | null {
    const displayResults = Array.isArray(result.displayResults) ? result.displayResults : [];
    if (displayResults.length === 0) return null;

    const dr = displayResults.find(d =>
      d &&
      typeof d === 'object' &&
      (d as any).format === 'summary' &&
      (d as any)?.data &&
      (d as any).data.summary &&
      typeof (d as any).data.summary.content === 'string'
    );
    if (!dr) return null;

    const summary = (dr as any).data.summary;
    const content = String(summary.content || '').trim();
    if (!content) return null;

    const metrics = Array.isArray(summary.metrics) ? summary.metrics : [];
    const severities = new Set(metrics.map((m: any) => m?.severity).filter(Boolean));
    const severity: Finding['severity'] =
      severities.has('critical') ? 'critical'
      : severities.has('warning') ? 'warning'
      : 'info';

    const title = `洞见摘要 · ${result.skillName || skillId}`;
    const MAX_DESC = 600;
    const description = content.length > MAX_DESC ? content.slice(0, MAX_DESC - 1) + '…' : content;

    return {
      id: `${skillId}_synth_${Date.now()}`,
      category,
      severity,
      title,
      description,
      source: skillId,
      confidence: 0.75,
      details: metrics.length > 0 ? { metrics: metrics.slice(0, 12) } : undefined,
    };
  }

  /**
   * Extract data from skill execution result
   */
  protected extractDataFromResult(result: SkillExecutionResult): any {
    if (result.displayResults && result.displayResults.length > 0) {
      const data: Record<string, any> = {};
      for (const dr of result.displayResults) {
        data[dr.stepId] = dr.data;
      }
      return data;
    }
    if (result.rawResults) {
      const data: Record<string, any> = {};
      for (const [stepId, stepResult] of Object.entries(result.rawResults)) {
        data[stepId] = stepResult.data;
      }
      return data;
    }
    return null;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Add a step to the reasoning trace
   */
  protected addReasoningStep(type: ReasoningStep['type'], content: string, confidence: number = 0.8): void {
    this.reasoningTrace.push({
      step: this.reasoningTrace.length + 1,
      type,
      content,
      confidence,
      timestamp: Date.now(),
    });
  }

  /**
   * Generate observations from a tool result
   */
  protected generateObservations(result: AgentToolResult): string[] {
    const observations: string[] = [];

    if (!result.success) {
      observations.push(`Tool execution failed: ${result.error}`);
      return observations;
    }

    if (result.findings && result.findings.length > 0) {
      observations.push(`Found ${result.findings.length} issues`);
      const critical = result.findings.filter(f => f.severity === 'critical').length;
      if (critical > 0) {
        observations.push(`${critical} critical issues identified`);
      }
    }

    if (result.data) {
      if (typeof result.data === 'object') {
        const keys = Object.keys(result.data);
        if (keys.length > 0) {
          observations.push(`Returned data with ${keys.length} fields`);
        }
      }
    }

    return observations;
  }

  /**
   * Create a hypothesis
   */
  protected createHypothesis(
    description: string,
    confidence: number,
    supportingEvidence: Evidence[] = []
  ): Hypothesis {
    return {
      id: createHypothesisId(),
      description,
      confidence,
      status: 'proposed',
      supportingEvidence,
      contradictingEvidence: [],
      proposedBy: this.config.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Get tool by name
   */
  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAllTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool descriptions for LLM, including parameter info.
   * This helps the LLM understand that tools are self-contained (with built-in SQL)
   * and only need simple parameters to execute.
   */
  getToolDescriptionsForLLM(): string {
    if (this.tools.size > 0) {
      return this.getAllTools()
        .map(t => {
          let desc = `- ${t.name}: ${t.description}`;
          if (t.parameters && t.parameters.length > 0) {
            const paramList = t.parameters
              .map(p => `${p.name}(${p.type}${p.required ? ',必填' : ''})`)
              .join(', ');
            desc += `\n  参数: [${paramList}]`;
          } else {
            desc += `\n  参数: 无（自动从上下文获取 package/start_ts/end_ts）`;
          }
          return desc;
        })
        .join('\n');
    }
    // Fallback: use skill definitions even before tools are loaded
    if (this.skillDefinitions.length > 0) {
      return this.skillDefinitions
        .map(s => `- ${s.toolName}: ${s.description || s.descriptionHint || s.skillId}`)
        .join('\n');
    }
    return '（无可用工具）';
  }

  /**
   * Get the full "available tools" section for LLM prompts.
   * Includes tool list, parameter info, usage clarification, and negative examples.
   * Use this in buildUnderstandingPrompt / buildPlanningPrompt instead of raw getToolDescriptionsForLLM().
   */
  protected getToolSectionForPrompt(): string {
    return `## 可用工具（只能使用以下工具）
${this.getToolDescriptionsForLLM()}

## 工具使用规则

### ✅ 正确做法
- 只使用上方列表中的工具名称
- params 留空 {} 使用默认行为（package/start_ts/end_ts 自动注入）
- 如需指定可选参数，只填写工具文档中列出的参数

### ❌ 禁止行为（会导致执行失败）
- 使用未列出的工具名（如 analyze_gpu、check_memory 等不存在的工具）
- 在 params 中写 SQL 查询（工具已内置 SQL）
- 在 params 中填写 package/start_ts/end_ts（这些会自动注入）
- 猜测工具名称或参数名称
- 使用自然语言描述代替工具调用

### ADB 工具特殊说明
- adb_* 工具用于通过 ADB 获取设备信息/执行操作
- 默认只读模式，除非 mode=full 否则不要尝试改变设备状态
- 使用前先调用 adb_status 确认 enabled/selectedSerial`;
  }

  /**
   * Format common task context fields for prompts
   */
  protected formatTaskContext(task: AgentTask): string {
    const lines: string[] = [];
    if (task.context.domain) {
      lines.push(`- 任务领域: ${task.context.domain}`);
    }
    const adbContext = (task.context.additionalData as any)?.adbContext;
    if (adbContext && typeof adbContext === 'object') {
      const mode = adbContext.mode ?? 'auto';
      const enabled = adbContext.enabled ? 'true' : 'false';
      const selected = adbContext?.availability?.selectedSerial || 'none';
      const matchStatus = adbContext?.traceMatch?.status || 'unknown';
      const matchConfidence = typeof adbContext?.traceMatch?.confidence === 'number'
        ? adbContext.traceMatch.confidence.toFixed(2)
        : 'n/a';
      lines.push(`- ADB 协同: mode=${mode}, enabled=${enabled}, serial=${selected}, match=${matchStatus}(${matchConfidence})`);
    }
    if (task.context.timeRange) {
      lines.push(`- 时间范围: ${task.context.timeRange.start} ~ ${task.context.timeRange.end}`);
    }
    if (task.context.evidenceNeeded && task.context.evidenceNeeded.length > 0) {
      lines.push(`- 需输出证据: ${task.context.evidenceNeeded.join(', ')}`);
    }

    const historyContext = (task.context.additionalData as any)?.historyContext;
    if (typeof historyContext === 'string' && historyContext.trim()) {
      const trimmed = historyContext.trim();
      const MAX_CHARS = 2200; // prompt budget protection
      lines.push('');
      lines.push('对话上下文摘要（同一 trace，避免重复与遗忘）:');
      lines.push(trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) + '…' : trimmed);
    }
    return lines.length > 0 ? lines.join('\n') : '';
  }

  /**
   * Set shared context
   */
  setSharedContext(context: SharedAgentContext): void {
    this.sharedContext = context;
  }

  // ==========================================================================
  // Dynamic SQL Generation (v2.0 - Agent Autonomy)
  // ==========================================================================

  /**
   * SQL generator instance (lazy initialized).
   * Provides agents with the ability to generate dynamic SQL queries.
   */
  private sqlGenerator: import('../../tools/sqlGenerator').SQLGenerator | null = null;
  private sqlValidator: import('../../tools/sqlValidator').SQLValidator | null = null;

  /**
   * Get or create SQL generator instance.
   */
  protected async getSQLGenerator(): Promise<import('../../tools/sqlGenerator').SQLGenerator> {
    if (!this.sqlGenerator) {
      const { SQLGenerator } = await import('../../tools/sqlGenerator');
      this.sqlGenerator = new SQLGenerator(this.modelRouter);
    }
    return this.sqlGenerator;
  }

  /**
   * Get or create SQL validator instance.
   */
  protected async getSQLValidator(): Promise<import('../../tools/sqlValidator').SQLValidator> {
    if (!this.sqlValidator) {
      const { SQLValidator } = await import('../../tools/sqlValidator');
      this.sqlValidator = new SQLValidator();
    }
    return this.sqlValidator;
  }

  /**
   * Generate and execute a dynamic SQL query.
   *
   * This gives agents true autonomy to explore data beyond predefined Skills.
   * The method:
   * 1. Generates SQL using LLM based on the objective
   * 2. Validates the SQL for safety
   * 3. Executes the query
   * 4. Returns results with metadata
   *
   * @param objective - What the agent wants to analyze
   * @param context - Tool context with trace processor service
   * @param schemaContext - Optional schema context (auto-detected if not provided)
   * @returns Query result with data and metadata
   */
  protected async generateAndExecuteSQL(
    objective: string,
    context: import('../../types/agentProtocol').AgentToolContext,
    schemaContext?: import('../../tools/sqlGenerator').SchemaContext
  ): Promise<DynamicSQLResult> {
    const startTime = Date.now();

    if (!context.traceProcessorService) {
      return {
        success: false,
        error: 'TraceProcessorService not available',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      const generator = await this.getSQLGenerator();
      const validator = await this.getSQLValidator();

      // Get schema context if not provided
      let schema = schemaContext;
      if (!schema) {
        const { detectSchema } = await import('../../tools/sqlGenerator');
        schema = await detectSchema(context.traceProcessorService, context.traceId);
      }

      // Generate SQL
      const genResult = await generator.generateSQL(objective, schema);

      if (!genResult.success || !genResult.sql) {
        return {
          success: false,
          error: genResult.error || 'SQL generation failed',
          validationErrors: genResult.validationErrors,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const MAX_REPAIR_ATTEMPTS = 2;
      let repairAttempts = 0;
      const repairErrors: string[] = [];
      const attemptedSql = new Set<string>();

      let currentGeneratedSQL = genResult.sql;
      let sqlToExecute = validator.ensureLimit(currentGeneratedSQL.sql, 1000);
      attemptedSql.add(sqlToExecute);

      while (true) {
        // Validate SQL (safety gate)
        const validation = validator.validate(sqlToExecute);
        if (!validation.valid) {
          this.emit('sql_validation_failed', {
            agentId: this.config.id,
            sql: sqlToExecute,
            errors: validation.errors.map(e => e.message),
          });

          const errMsg = `SQL validation failed: ${validation.errors.map(e => e.message).join(', ')}`;
          repairErrors.push(errMsg);

          if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
            return {
              success: false,
              error: errMsg,
              validationErrors: validation.errors.map(e => e.message),
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }

          repairAttempts++;
          const repaired = await generator.repairSQL({
            objective,
            schemaContext: schema,
            previousSQL: sqlToExecute,
            error: errMsg,
          });

          if (!repaired.success || !repaired.sql) {
            return {
              success: false,
              error: repaired.error || errMsg,
              validationErrors: repaired.validationErrors || validation.errors.map(e => e.message),
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }

          currentGeneratedSQL = repaired.sql;
          sqlToExecute = validator.ensureLimit(currentGeneratedSQL.sql, 1000);
          if (attemptedSql.has(sqlToExecute)) {
            return {
              success: false,
              error: `SQL repair loop produced duplicate SQL (stopping)`,
              validationErrors: [errMsg],
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }
          attemptedSql.add(sqlToExecute);
          continue;
        }

        // Log for debugging
        console.log(`[${this.config.id}] Executing dynamic SQL for: ${objective}`);
        console.log(`[${this.config.id}] SQL: ${sqlToExecute.slice(0, 200)}...`);

        // Emit event for tracking
        this.emit('sql_generated', {
          agentId: this.config.id,
          objective,
          sql: sqlToExecute,
          riskLevel: currentGeneratedSQL.riskLevel,
          repairAttempts,
        });

        try {
          // Execute SQL
          const queryResult = await context.traceProcessorService.query(
            context.traceId,
            sqlToExecute
          );

          const executionTimeMs = Date.now() - startTime;

          // Process results
          const data = this.processSQLResult(queryResult);

          return {
            success: true,
            data,
            generatedSQL: currentGeneratedSQL,
            queryResult,
            validation,
            repairAttempts,
            repairErrors: repairErrors.length > 0 ? repairErrors : undefined,
            executionTimeMs,
          };
        } catch (error: any) {
          const errMsg = String(error?.message || error);
          repairErrors.push(errMsg);

          if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
            return {
              success: false,
              error: errMsg,
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }

          repairAttempts++;
          const repaired = await generator.repairSQL({
            objective,
            schemaContext: schema,
            previousSQL: sqlToExecute,
            error: errMsg,
          });

          if (!repaired.success || !repaired.sql) {
            return {
              success: false,
              error: repaired.error || errMsg,
              validationErrors: repaired.validationErrors,
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }

          currentGeneratedSQL = repaired.sql;
          sqlToExecute = validator.ensureLimit(currentGeneratedSQL.sql, 1000);
          if (attemptedSql.has(sqlToExecute)) {
            return {
              success: false,
              error: `SQL repair loop produced duplicate SQL (stopping)`,
              generatedSQL: currentGeneratedSQL,
              repairAttempts,
              repairErrors,
              executionTimeMs: Date.now() - startTime,
            };
          }
          attemptedSql.add(sqlToExecute);
        }
      }

    } catch (error: any) {
      console.warn(`[${this.config.id}] Dynamic SQL execution failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Process raw SQL query result into structured data.
   */
  private processSQLResult(queryResult: any): any {
    if (!queryResult) return null;

    // Handle columnar format { columns, rows }
    if (queryResult.columns && queryResult.rows) {
      const columns = queryResult.columns as string[];
      const rows = queryResult.rows as any[][];

      return rows.map(row => {
        const obj: Record<string, any> = {};
        for (let i = 0; i < columns.length; i++) {
          obj[columns[i]] = row[i];
        }
        return obj;
      });
    }

    // Return as-is if already in object format
    return queryResult;
  }

  /**
   * Check if dynamic SQL generation is enabled for this agent.
   * Subclasses can override to control when SQL generation is allowed.
   */
  protected isDynamicSQLEnabled(): boolean {
    // By default, enabled for all agents
    // Can be controlled via config or environment variable
    return process.env.AGENT_DYNAMIC_SQL !== 'false';
  }
}

// =============================================================================
// Dynamic SQL Result Type
// =============================================================================

/**
 * Result of dynamic SQL generation and execution.
 */
export interface DynamicSQLResult {
  success: boolean;
  data?: any;
  error?: string;
  validationErrors?: string[];
  generatedSQL?: import('../../tools/sqlGenerator').GeneratedSQL;
  queryResult?: any;
  validation?: import('../../tools/sqlValidator').ValidationResult;
  /** Number of repair attempts performed (0 means no repair) */
  repairAttempts?: number;
  /** Error trail from validation/execution/repair attempts (best-effort) */
  repairErrors?: string[];
  executionTimeMs: number;
}

export default BaseAgent;
