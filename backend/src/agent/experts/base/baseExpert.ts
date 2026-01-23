/**
 * Base Expert Class
 *
 * Abstract base class for domain expert agents.
 * Experts encapsulate domain-specific knowledge and use decision trees
 * for intelligent, hypothesis-driven analysis.
 *
 * Key capabilities:
 * - Decision tree execution with conditional branching
 * - Skill invocation for data gathering
 * - Session forking for deep exploration
 * - Architecture-aware analysis strategy selection
 */

import { EventEmitter } from 'events';
import {
  ExpertConfig,
  ExpertInput,
  ExpertOutput,
  ExpertConclusion,
  ExpertState,
  ExpertForkRequest,
  ExpertForkResult,
  BaseExpertInterface,
  AnalysisIntent,
} from './types';
import {
  DecisionTree,
  DecisionContext,
  DecisionTreeExecutionResult,
} from '../../decision/types';
import {
  DecisionTreeExecutor,
  SkillExecutorAdapter,
  getDecisionTree,
} from '../../decision';
import { ArchitectureInfo } from '../../detectors';
import { AgentPhase, Finding, StageResult } from '../../types';
import { CheckpointManager } from '../../state';
import {
  createForkManager,
  getForkManager,
  setForkManager,
} from '../../fork';

/**
 * Abstract base class for domain experts
 */
export abstract class BaseExpert extends EventEmitter implements BaseExpertInterface {
  readonly config: ExpertConfig;

  protected state: ExpertState | null = null;
  protected treeExecutor: DecisionTreeExecutor;
  protected skillAdapter: SkillExecutorAdapter;

  constructor(config: ExpertConfig) {
    super();
    this.config = config;

    // Initialize skill adapter and tree executor
    this.skillAdapter = new SkillExecutorAdapter({ enableCache: true });
    this.treeExecutor = new DecisionTreeExecutor(this.skillAdapter, {
      maxNodes: 50,
      nodeTimeoutMs: 30000,
      verbose: true,
    });

    // Forward tree executor events
    this.treeExecutor.on('node:start', (data) => this.emit('node:start', data));
    this.treeExecutor.on('node:complete', (data) => this.emit('node:complete', data));
  }

  /**
   * Main analysis entry point
   */
  async analyze(input: ExpertInput): Promise<ExpertOutput> {
    const startTime = Date.now();

    // Initialize state
    this.state = {
      phase: 'initializing',
      executionPath: [],
      collectedData: new Map(),
      startTime,
      lastUpdateTime: startTime,
    };

    this.emit('analysis:start', { expertId: this.config.id, input });

    try {
      // Phase 1: Architecture detection (if not already done)
      this.updateState('detecting');
      const architecture = input.architecture || await this.detectArchitecture(input);

      // Phase 2: Select analysis strategy based on architecture and intent
      const strategy = this.selectStrategy(input.intent, architecture);
      this.log(`Selected strategy: ${strategy.name} for ${architecture?.type || 'STANDARD'}`);

      // Phase 3: Execute decision tree or custom analysis
      this.updateState('analyzing');
      let treeResult: DecisionTreeExecutionResult | null = null;

      if (strategy.decisionTree) {
        treeResult = await this.executeDecisionTree(strategy.decisionTree, input, architecture);
      } else {
        // Fallback to custom analysis
        treeResult = await this.performCustomAnalysis(input, architecture);
      }

      // Phase 4: Build conclusion
      this.updateState('concluding');
      const output = this.buildOutput(treeResult, input, startTime);

      // Phase 5: Complete
      this.updateState('completed');
      this.emit('analysis:complete', { expertId: this.config.id, output });

      return output;

    } catch (error: any) {
      this.updateState('failed');
      this.emit('analysis:error', { expertId: this.config.id, error });

      return {
        expertId: this.config.id,
        domain: this.config.domain,
        success: false,
        findings: [],
        suggestions: ['请检查 trace 数据是否完整', '尝试重新分析'],
        error: error.message,
        confidence: 0,
      };
    }
  }

  /**
   * Check if this expert can handle the given intent
   */
  canHandle(intent: AnalysisIntent): boolean {
    return this.config.handlesIntents.includes(intent.category);
  }

  /**
   * Get decision tree by analysis type
   */
  getDecisionTree(analysisType?: string): DecisionTree | undefined {
    // First check if we have this tree in our config
    const treeId = analysisType || this.config.decisionTrees[0];
    if (!treeId) return undefined;

    // Get from registry
    return getDecisionTree(treeId);
  }

  /**
   * Get current state
   */
  getState(): ExpertState | null {
    return this.state;
  }

  // ===========================================================================
  // Protected methods for subclasses to override
  // ===========================================================================

  /**
   * Detect architecture (can be overridden by subclasses)
   */
  protected async detectArchitecture(input: ExpertInput): Promise<ArchitectureInfo | undefined> {
    // Use the architecture from input if available
    return input.architecture;
  }

  /**
   * Select analysis strategy based on intent and architecture
   * Subclasses should override this for domain-specific strategies
   */
  protected abstract selectStrategy(
    intent: AnalysisIntent,
    architecture?: ArchitectureInfo
  ): AnalysisStrategy;

  /**
   * Perform custom analysis when no decision tree is available
   * Subclasses should override this for domain-specific logic
   */
  protected abstract performCustomAnalysis(
    input: ExpertInput,
    architecture?: ArchitectureInfo
  ): Promise<DecisionTreeExecutionResult>;

  /**
   * Transform conclusion from decision tree to expert conclusion
   * Subclasses can override for domain-specific transformations
   */
  protected transformConclusion(
    treeConclusion: any,
    collectedData: Map<string, any>
  ): ExpertConclusion {
    return {
      category: treeConclusion?.category || 'UNKNOWN',
      component: treeConclusion?.component || 'UNKNOWN',
      summary: treeConclusion?.summaryTemplate || '分析完成但未能确定具体原因',
      evidence: [],
      optimizationSuggestions: treeConclusion?.suggestedNextSteps || [],
      confidence: treeConclusion?.confidence || 0.5,
    };
  }

  /**
   * Extract findings from collected data
   * Subclasses can override for domain-specific extraction
   */
  protected extractFindings(collectedData: Map<string, any>): Finding[] {
    const findings: Finding[] = [];

    // Default implementation - subclasses should override
    for (const [key, value] of collectedData) {
      if (value?.findings) {
        findings.push(...value.findings);
      }
    }

    return findings;
  }

  // ===========================================================================
  // Protected helper methods
  // ===========================================================================

  /**
   * Execute a skill
   */
  protected async executeSkill(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): Promise<any> {
    return this.skillAdapter.execute(skillId, params, context);
  }

  /**
   * Fork a session for deeper analysis
   */
  protected async forkSession(
    request: ExpertForkRequest,
    input: ExpertInput
  ): Promise<ExpertForkResult> {
    // Check if forking is enabled
    if (!this.config.canForkSession) {
      return {
        forkSessionId: '',
        success: false,
        findings: [],
        error: 'Session forking is not enabled for this expert',
      };
    }

    this.log(`Forking session for: ${request.reason}`);
    this.emit('fork:start', { request, input });

    try {
      let forkManager = getForkManager();
      const checkpointManager = new CheckpointManager();

      if (!forkManager) {
        forkManager = createForkManager(checkpointManager);
        setForkManager(forkManager);
      }

      forkManager.initializeSession(input.sessionId, 'main');
      forkManager.registerContext(input.sessionId, {
        sessionId: input.sessionId,
        traceId: input.traceId,
        query: input.query,
        intent: input.intent as any,
        previousResults: [],
        traceProcessorService: input.traceProcessorService,
        package: input.packageName,
        timeRange: input.timeRange,
      });

      let checkpointId: string | undefined;
      if (request.context && typeof request.context.checkpointId === 'string') {
        checkpointId = request.context.checkpointId;
      } else {
        const latest = await checkpointManager.getLatestCheckpoint(input.sessionId);
        if (latest) {
          checkpointId = latest.id;
        }
      }

      if (!checkpointId) {
        const checkpoint = await checkpointManager.createCheckpoint(
          input.sessionId,
          'expert_fork',
          AgentPhase.EXECUTING,
          [] as StageResult[],
          input.previousFindings || [],
          {
            query: input.query,
            traceId: input.traceId,
            metadata: {
              forkReason: request.reason,
              forkFocus: request.focus,
              forkHypothesis: request.hypothesis,
            },
          }
        );
        checkpointId = checkpoint.id;
      }

      const forkResult = await forkManager.fork(input.sessionId, {
        checkpointId,
        branchName: request.focus || request.reason || 'fork',
        description: request.reason,
        hypothesis: request.hypothesis,
        inheritConfig: true,
      });

      if (!forkResult.success) {
        return {
          forkSessionId: '',
          success: false,
          findings: [],
          error: forkResult.error || 'Fork failed',
        };
      }

      return {
        forkSessionId: forkResult.forkedSessionId,
        success: true,
        findings: [],
      };
    } catch (error: any) {
      return {
        forkSessionId: '',
        success: false,
        findings: [],
        error: error.message || 'Fork failed',
      };
    }
  }

  /**
   * Execute decision tree
   */
  protected async executeDecisionTree(
    tree: DecisionTree,
    input: ExpertInput,
    architecture?: ArchitectureInfo
  ): Promise<DecisionTreeExecutionResult> {
    // Build decision context
    const context: DecisionContext = {
      sessionId: input.sessionId,
      traceId: input.traceId,
      architecture,
      traceProcessorService: input.traceProcessorService,
      previousResults: new Map(),
      timeRange: input.timeRange,
      packageName: input.packageName,
    };

    // Add previous findings to context
    if (input.previousFindings) {
      context.previousResults.set('previousFindings', input.previousFindings);
    }

    // Execute tree
    this.log(`Executing decision tree: ${tree.name} (${tree.id})`);
    const result = await this.treeExecutor.execute(tree, context);

    // Update state with execution path
    if (this.state) {
      this.state.executionPath = result.executionPath;
      this.state.collectedData = result.collectedData;
    }

    return result;
  }

  /**
   * Build output from decision tree result
   */
  protected buildOutput(
    treeResult: DecisionTreeExecutionResult | null,
    input: ExpertInput,
    startTime: number
  ): ExpertOutput {
    if (!treeResult) {
      return {
        expertId: this.config.id,
        domain: this.config.domain,
        success: false,
        findings: [],
        suggestions: ['分析未能完成'],
        error: 'No decision tree result',
        confidence: 0,
      };
    }

    // Transform conclusion
    const conclusion = treeResult.conclusion
      ? this.transformConclusion(treeResult.conclusion, treeResult.collectedData)
      : undefined;

    // Extract findings
    const findings = this.extractFindings(treeResult.collectedData);

    // Add conclusion as a finding if available
    if (conclusion) {
      findings.unshift({
        id: `conclusion_${Date.now()}`,
        type: 'root_cause',
        severity: conclusion.category === 'APP' ? 'high' : 'medium',
        title: `根因: ${conclusion.component}`,
        description: conclusion.summary,
        source: 'expert',
        confidence: conclusion.confidence,
        details: {
          category: conclusion.category,
          component: conclusion.component,
        },
        recommendations: conclusion.optimizationSuggestions.map((s, i) => ({
          id: `rec_${i}`,
          text: s,
          priority: i + 1,
        })),
      });
    }

    return {
      expertId: this.config.id,
      domain: this.config.domain,
      success: treeResult.success,
      conclusion,
      findings,
      suggestions: conclusion?.optimizationSuggestions || [],
      data: Object.fromEntries(treeResult.collectedData),
      executionDetails: {
        treeId: treeResult.treeId,
        executionPath: treeResult.executionPath,
        totalDurationMs: treeResult.totalDurationMs,
      },
      confidence: conclusion?.confidence || 0.5,
    };
  }

  /**
   * Update state phase
   */
  protected updateState(phase: ExpertState['phase']): void {
    if (this.state) {
      this.state.phase = phase;
      this.state.lastUpdateTime = Date.now();
      this.emit('state:update', { phase, state: this.state });
    }
  }

  /**
   * Log message with expert context
   */
  protected log(message: string): void {
    console.log(`[${this.config.name}] ${message}`);
  }
}

/**
 * Analysis strategy selected by expert
 */
export interface AnalysisStrategy {
  /** Strategy name */
  name: string;
  /** Decision tree to use (if any) */
  decisionTree?: DecisionTree;
  /** Skills to execute in order (if no decision tree) */
  skillSequence?: string[];
  /** Architecture-specific adjustments */
  architectureAdjustments?: Record<string, any>;
}

export default BaseExpert;
