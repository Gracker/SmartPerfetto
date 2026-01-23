/**
 * Base Cross-Domain Expert
 *
 * Abstract base class for cross-domain experts that orchestrate
 * multi-turn dialogues with module experts to find root causes.
 *
 * Key capabilities:
 * 1. Dialogue Loop - Multi-turn questioning of module experts
 * 2. Hypothesis Management - Track and verify root cause hypotheses
 * 3. Early Termination - Stop when confident or request user input
 * 4. Event Emission - Real-time updates for UI
 *
 * Subclasses must implement:
 * - generateInitialQueries(): First questions based on user query
 * - analyzeAndDecide(): Analyze responses and decide next action
 * - synthesizeConclusion(): Build final conclusion from evidence
 */

import { EventEmitter } from 'events';
import {
  CrossDomainExpertConfig,
  CrossDomainInput,
  CrossDomainOutput,
  CrossDomainType,
  ModuleQuery,
  ModuleResponse,
  ModuleFinding,
  ModuleSuggestion,
  Hypothesis,
  HypothesisEvidence,
  AnalysisDecision,
  ExpertConclusion,
  DialogueContext,
  CrossDomainEvent,
  AIService,
} from './types';
import { ModuleExpertInvoker, createModuleExpertInvoker } from './moduleExpertInvoker';
import {
  DialogueSession,
  DialogueConfig,
  DEFAULT_DIALOGUE_CONFIG,
  buildModuleQuery,
  createHypothesisId,
} from './dialogueProtocol';
import { HypothesisManager } from './hypothesisManager';
import { ModuleCatalog } from './moduleCatalog';

/**
 * Abstract base class for cross-domain experts
 */
export abstract class BaseCrossDomainExpert extends EventEmitter {
  readonly config: CrossDomainExpertConfig;
  protected invoker: ModuleExpertInvoker | null = null;
  protected catalog: ModuleCatalog;
  protected hypothesisManager: HypothesisManager;
  /** AI service for analysis and synthesis - set during analyze() */
  protected aiService: AIService | null = null;

  constructor(config: CrossDomainExpertConfig) {
    super();
    this.config = config;
    this.catalog = new ModuleCatalog();
    this.hypothesisManager = new HypothesisManager({
      maxHypotheses: 5,
      confidenceThreshold: config.confidenceThreshold,
    });
  }

  // ===========================================================================
  // Abstract Methods - Subclasses must implement
  // ===========================================================================

  /**
   * Generate initial queries based on user input
   * Called at the start of analysis to determine entry points
   */
  protected abstract generateInitialQueries(
    input: CrossDomainInput,
    context: DialogueContext
  ): Promise<ModuleQuery[]>;

  /**
   * Analyze responses and decide next action
   * Called after each round of module responses
   */
  protected abstract analyzeAndDecide(
    session: DialogueSession,
    responses: ModuleResponse[]
  ): Promise<AnalysisDecision>;

  /**
   * Synthesize final conclusion from all collected evidence
   * Called when analysis is complete
   */
  protected abstract synthesizeConclusion(
    session: DialogueSession
  ): Promise<ExpertConclusion>;

  // ===========================================================================
  // Main Analysis Entry Point
  // ===========================================================================

  /**
   * Main analysis method - orchestrates the dialogue loop
   */
  async analyze(input: CrossDomainInput): Promise<CrossDomainOutput> {
    const startTime = Date.now();

    // Store AI service for use in subclasses (analyzeAndDecide, synthesizeConclusion)
    this.aiService = input.aiService || null;
    if (this.aiService) {
      this.log('AI service available for analysis and synthesis');
    } else {
      this.log('No AI service - will use rule-based analysis only');
    }

    // Initialize invoker with trace processor
    // NOTE: createModuleExpertInvoker is now async to ensure skill registry is initialized
    this.invoker = await createModuleExpertInvoker(
      input.traceProcessorService,
      this.aiService ? { chat: async (prompt: string) => {
        const result = await this.aiService!.callWithFallback(prompt, 'general');
        return result.response;
      }} : undefined,
      { emitEvents: true, useDataEnvelopeFormat: true }
    );

    // Forward invoker events - also emit as 'event' for masterOrchestrator compatibility
    this.invoker.on('skill_event', (event) => {
      this.emit('skill_event', event);
      // Forward skill data events for SSE streaming
      // Handle both v2.0 'data' events and legacy 'skill_data' events
      if (event.type === 'data') {
        // v2.0 DataEnvelope format - forward directly
        this.emit('event', {
          type: 'data',
          id: event.id,
          timestamp: Date.now(),
          expertId: this.config.id,
          turnNumber: 0,
          data: event.data || event,
        });
      } else if (event.type === 'skill_data' || event.type === 'skill_layered_result') {
        // Legacy format - forward as skill_data
        this.emit('event', {
          type: 'skill_data',
          timestamp: Date.now(),
          expertId: this.config.id,
          turnNumber: 0,
          data: event.data || event,
        });
      }
    });

    // Create dialogue session
    const dialogueConfig: Partial<DialogueConfig> = {
      maxTurns: this.config.maxDialogueTurns,
      confidenceThreshold: this.config.confidenceThreshold,
    };

    const session = new DialogueSession(
      this.config.id,
      input.traceId,
      input.query,
      dialogueConfig,
      {
        architecture: input.architecture,
        packageName: input.packageName,
        traceProcessorService: input.traceProcessorService,
      }
    );

    // Forward session events - also emit as 'event' for masterOrchestrator
    session.onEvent((event) => {
      this.emit('dialogue_event', event);
      // Forward as CrossDomainEvent format
      this.emit('event', {
        type: event.type,
        timestamp: event.timestamp || Date.now(),
        expertId: this.config.id,
        turnNumber: event.turnNumber || 0,
        data: event.data || event,
      });
    });

    this.emitEvent('dialogue_started', {
      expertId: this.config.id,
      domain: this.config.domain,
      query: input.query,
      maxTurns: this.config.maxDialogueTurns,
    });

    try {
      // Generate initial queries
      const initialQueries = await this.generateInitialQueries(input, session.getContext());

      if (initialQueries.length === 0) {
        return this.createFailureOutput(
          'No initial queries generated - unable to start analysis',
          session,
          startTime
        );
      }

      // Execute dialogue loop
      let currentQueries = initialQueries;
      let lastDecision: AnalysisDecision | null = null;

      while (session.canContinue() && currentQueries.length > 0) {
        // Start new turn
        session.startTurn();

        // Record and execute queries
        for (const query of currentQueries) {
          session.recordQuery(query);
        }

        const responses = await this.invoker.invokeParallel(currentQueries);

        // Record responses
        for (const response of responses) {
          session.recordResponse(response);
        }

        // Update hypotheses based on findings
        this.updateHypotheses(session, responses);

        // Analyze and decide next action
        lastDecision = await this.analyzeAndDecide(session, responses);
        session.recordDecision(lastDecision);

        // Handle decision
        switch (lastDecision.action) {
          case 'conclude':
            session.conclude();
            break;

          case 'continue':
            currentQueries = lastDecision.nextQueries || [];
            break;

          case 'ask_user':
            // In a real implementation, this would wait for user input
            // For now, we'll continue with any follow-up queries
            this.emitEvent('user_intervention_needed', {
              question: lastDecision.userQuestion?.question,
              reason: lastDecision.userQuestion?.reason,
            });
            currentQueries = lastDecision.nextQueries || [];
            if (currentQueries.length === 0) {
              session.conclude();
            }
            break;

          case 'fork':
            // Fork is complex - for now, treat as continue
            this.log(`Fork requested for hypothesis: ${lastDecision.forkRequest?.hypothesis.title}`);
            currentQueries = lastDecision.nextQueries || [];
            break;
        }

        // Check for early termination conditions
        if (session.hasConfidentHypothesis()) {
          this.log(`High confidence hypothesis found, concluding early`);
          session.conclude();
          break;
        }
      }

      // Handle max turns reached
      if (session.isMaxTurnsReached() && session.getState() !== 'concluded') {
        this.log(`Max turns (${this.config.maxDialogueTurns}) reached`);
        session.conclude();
      }

      // Synthesize conclusion
      const conclusion = await this.synthesizeConclusion(session);

      // Build output
      const output = this.buildOutput(session, conclusion, startTime);

      this.emitEvent('conclusion_reached', {
        category: conclusion.category,
        component: conclusion.component,
        confidence: conclusion.confidence,
        findingsCount: output.findings.length,
      });

      return output;

    } catch (error: any) {
      this.log(`Analysis error: ${error.message}`);
      session.error(error.message);

      return this.createFailureOutput(error.message, session, startTime);
    }
  }

  // ===========================================================================
  // Protected Helper Methods
  // ===========================================================================

  /**
   * Create a module query
   */
  protected createQuery(
    targetModule: string,
    questionId: string,
    params: Record<string, any>,
    context: DialogueContext
  ): ModuleQuery {
    return buildModuleQuery(targetModule, questionId, params, context);
  }

  /**
   * Create queries from module suggestions
   */
  protected createQueriesFromSuggestions(
    suggestions: ModuleSuggestion[],
    context: DialogueContext,
    maxQueries: number = 3
  ): ModuleQuery[] {
    // Sort by priority and take top N
    const topSuggestions = suggestions
      .sort((a, b) => a.priority - b.priority)
      .slice(0, maxQueries);

    return topSuggestions.map(s =>
      buildModuleQuery(
        s.targetModule,
        s.id, // Use suggestion ID as question ID
        s.params,
        context
      )
    );
  }

  /**
   * Create a new hypothesis
   */
  protected createHypothesis(
    title: string,
    description: string,
    category: Hypothesis['category'],
    component: string,
    initialConfidence: number = 0.3
  ): Hypothesis {
    return {
      id: createHypothesisId(category, component),
      title,
      description,
      category,
      component,
      confidence: initialConfidence,
      supportingEvidence: [],
      contradictingEvidence: [],
      status: 'exploring',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * Add evidence to a hypothesis
   */
  protected addEvidenceToHypothesis(
    hypothesis: Hypothesis,
    finding: ModuleFinding,
    weight: number
  ): void {
    const evidence: HypothesisEvidence = {
      sourceModule: finding.sourceModule,
      findingId: finding.id,
      weight,
      summary: finding.title,
      data: finding.evidence,
    };

    if (weight >= 0) {
      hypothesis.supportingEvidence.push(evidence);
    } else {
      hypothesis.contradictingEvidence.push(evidence);
    }

    // Recalculate confidence
    hypothesis.confidence = this.hypothesisManager.calculateConfidence(hypothesis);
    hypothesis.updatedAt = Date.now();

    // Update status based on confidence
    if (hypothesis.confidence >= this.config.confidenceThreshold) {
      hypothesis.status = 'confirmed';
    } else if (hypothesis.confidence < 0.2 && hypothesis.contradictingEvidence.length > 2) {
      hypothesis.status = 'rejected';
    }
  }

  /**
   * Get all findings from responses
   */
  protected collectFindings(responses: ModuleResponse[]): ModuleFinding[] {
    const findings: ModuleFinding[] = [];
    for (const response of responses) {
      findings.push(...response.findings);
    }
    return findings;
  }

  /**
   * Get all suggestions from responses
   */
  protected collectSuggestions(responses: ModuleResponse[]): ModuleSuggestion[] {
    const suggestions: ModuleSuggestion[] = [];
    for (const response of responses) {
      suggestions.push(...response.suggestions);
    }
    // Sort by priority
    return suggestions.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Check if a module is available
   */
  protected isModuleAvailable(moduleName: string): boolean {
    return this.catalog.hasModule(moduleName);
  }

  /**
   * Get related modules for a given module
   */
  protected getRelatedModules(moduleName: string): string[] {
    return this.catalog.getRelatedModules(moduleName);
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Update hypotheses based on new responses
   */
  private updateHypotheses(
    session: DialogueSession,
    responses: ModuleResponse[]
  ): void {
    const findings = this.collectFindings(responses);

    for (const finding of findings) {
      // Check if finding relates to any existing hypothesis
      const context = session.getContext();
      for (const hypothesis of context.activeHypotheses) {
        const relevance = this.calculateFindingRelevance(finding, hypothesis);
        if (Math.abs(relevance) > 0.1) {
          this.addEvidenceToHypothesis(hypothesis, finding, relevance);
          session.updateHypothesis(hypothesis.id, hypothesis);
        }
      }
    }
  }

  /**
   * Calculate how relevant a finding is to a hypothesis
   * Returns -1 to 1 (negative = contradicts, positive = supports)
   */
  private calculateFindingRelevance(
    finding: ModuleFinding,
    hypothesis: Hypothesis
  ): number {
    // Simple heuristic based on component matching
    // Subclasses can override for more sophisticated logic

    const findingComponent = finding.sourceModule.toLowerCase();
    const hypothesisComponent = hypothesis.component.toLowerCase();

    // Direct match
    if (findingComponent.includes(hypothesisComponent) ||
        hypothesisComponent.includes(findingComponent)) {
      // Severity affects weight
      const baseWeight = finding.severity === 'critical' ? 0.8 :
                         finding.severity === 'warning' ? 0.5 : 0.3;
      return baseWeight * finding.confidence;
    }

    // Related component
    const relatedModules = this.getRelatedModules(finding.sourceModule);
    if (relatedModules.some(m => m.toLowerCase().includes(hypothesisComponent))) {
      return 0.3 * finding.confidence;
    }

    return 0;
  }

  /**
   * Build final output
   */
  private buildOutput(
    session: DialogueSession,
    conclusion: ExpertConclusion,
    startTime: number
  ): CrossDomainOutput {
    const stats = session.getStats();
    const context = session.getContext();

    return {
      expertId: this.config.id,
      domain: this.config.domain,
      success: true,
      conclusion,
      findings: context.collectedFindings,
      suggestions: conclusion.suggestions,
      dialogueStats: {
        totalTurns: stats.totalTurns,
        modulesQueried: Array.from(stats.modulesQueried),
        hypothesesExplored: stats.hypothesesExplored,
        totalExecutionTimeMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Create failure output
   */
  private createFailureOutput(
    error: string,
    session: DialogueSession,
    startTime: number
  ): CrossDomainOutput {
    const stats = session.getStats();

    return {
      expertId: this.config.id,
      domain: this.config.domain,
      success: false,
      findings: session.getContext().collectedFindings,
      suggestions: [],
      dialogueStats: {
        totalTurns: stats.totalTurns,
        modulesQueried: Array.from(stats.modulesQueried),
        hypothesesExplored: stats.hypothesesExplored,
        totalExecutionTimeMs: Date.now() - startTime,
      },
      error,
    };
  }

  /**
   * Emit event - sends to both 'expert_event' and 'event' channels
   * The 'event' channel is used by masterOrchestrator for SSE streaming
   */
  private emitEvent(type: string, data: Record<string, any>): void {
    const eventPayload = {
      type,
      timestamp: Date.now(),
      expertId: this.config.id,
      turnNumber: 0,
      data,
      ...data,
    };
    this.emit('expert_event', eventPayload);
    this.emit('event', eventPayload);
  }

  /**
   * Log message
   */
  protected log(message: string): void {
    console.log(`[${this.config.name}] ${message}`);
  }
}
