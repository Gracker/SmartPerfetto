/**
 * Performance Expert
 *
 * Cross-domain expert for analyzing performance issues:
 * - Jank/scroll performance
 * - App startup latency
 * - Click response time
 * - Frame drops
 *
 * Analysis strategy:
 * 1. Classify intent (jank/scroll/startup/latency)
 * 2. Query relevant entry modules
 * 3. Follow suggestions to drill down
 * 4. Build and verify hypotheses
 * 5. Synthesize conclusion with root cause
 */

import { BaseCrossDomainExpert } from '../baseCrossDomainExpert';
import {
  CrossDomainExpertConfig,
  CrossDomainInput,
  ModuleQuery,
  ModuleResponse,
  ModuleFinding,
  ModuleSuggestion,
  Hypothesis,
  AnalysisDecision,
  ExpertConclusion,
  DialogueContext,
} from '../types';
import { DialogueSession, buildModuleQuery } from '../dialogueProtocol';

/**
 * Performance intent categories
 */
type PerformanceIntent =
  | 'jank'       // 卡顿
  | 'scroll'     // 滑动
  | 'startup'    // 启动
  | 'click'      // 点击响应
  | 'general';   // 通用性能

/**
 * Entry modules for each performance intent
 *
 * Each intent maps to relevant module experts that can provide analysis.
 * The order determines the priority of initial queries.
 */
const INTENT_ENTRY_MODULES: Record<PerformanceIntent, string[]> = {
  jank: [
    'framework_surfaceflinger',
    'framework_choreographer',  // doFrame timing, VSYNC
    'kernel_scheduler',
    'app_third_party',
  ],
  scroll: [
    'framework_surfaceflinger',
    'framework_choreographer',  // Frame timing breakdown
    'app_third_party',
    'hardware_gpu',
  ],
  startup: [
    'framework_ams',
    'kernel_binder',
    'kernel_filesystem',  // I/O during startup
    'app_third_party',
  ],
  click: [
    'framework_wms',
    'framework_input',
    'kernel_binder',
    'framework_choreographer',  // Frame delivery after click
  ],
  general: [
    'framework_surfaceflinger',
    'framework_choreographer',
    'kernel_scheduler',
    'framework_ams',
  ],
};

/**
 * Keywords for intent classification
 */
const INTENT_KEYWORDS: Record<PerformanceIntent, string[]> = {
  jank: ['卡顿', 'jank', '掉帧', 'fps', 'frame', '帧'],
  scroll: ['滑动', 'scroll', '列表', 'recycler', '流畅'],
  startup: ['启动', 'launch', 'startup', 'start', 'cold', 'warm', 'ttid', 'ttfd'],
  click: ['点击', 'click', 'tap', '响应', 'touch', '反应慢'],
  general: [],
};

/**
 * Default configuration for PerformanceExpert
 */
const DEFAULT_CONFIG: CrossDomainExpertConfig = {
  id: 'performance_expert',
  name: '性能专家',
  domain: 'performance',
  description: '分析卡顿、启动、滑动、点击响应等性能问题，支持多轮对话和假设验证',
  entryModules: ['framework_surfaceflinger', 'kernel_scheduler', 'framework_ams'],
  maxDialogueTurns: 8,
  confidenceThreshold: 0.85,
  handlesIntents: ['SCROLLING', 'CLICK', 'LAUNCH', 'CPU', 'GENERAL'],
};

/**
 * PerformanceExpert - Analyzes performance issues
 */
export class PerformanceExpert extends BaseCrossDomainExpert {
  private currentIntent: PerformanceIntent = 'general';

  constructor(config: Partial<CrossDomainExpertConfig> = {}) {
    super({ ...DEFAULT_CONFIG, ...config });
  }

  // ===========================================================================
  // Abstract Method Implementations
  // ===========================================================================

  /**
   * Generate initial queries based on user input
   */
  protected async generateInitialQueries(
    input: CrossDomainInput,
    context: DialogueContext
  ): Promise<ModuleQuery[]> {
    // Classify intent
    this.currentIntent = this.classifyIntent(input.query);
    this.log(`Classified intent: ${this.currentIntent}`);

    // Get entry modules for this intent
    const entryModules = INTENT_ENTRY_MODULES[this.currentIntent];

    // Build initial queries
    const queries: ModuleQuery[] = [];

    for (const moduleId of entryModules) {
      // Get the primary skill for this module
      const skillName = this.getSkillForModule(moduleId, this.currentIntent);
      if (!skillName) continue;

      const params: Record<string, any> = {};

      // Add package name if available
      if (input.packageName) {
        params.package = input.packageName;
      }

      // Add time range if available
      if (input.timeRange) {
        params.start_ts = input.timeRange.start;
        params.end_ts = input.timeRange.end;
      }

      queries.push(buildModuleQuery(
        skillName,
        `initial_${this.currentIntent}`,
        params,
        context
      ));
    }

    // Limit initial queries to avoid overwhelming the system
    return queries.slice(0, 3);
  }

  /**
   * Analyze responses and decide next action
   */
  protected async analyzeAndDecide(
    session: DialogueSession,
    responses: ModuleResponse[]
  ): Promise<AnalysisDecision> {
    const context = session.getContext();
    const findings = this.collectFindings(responses);
    const suggestions = this.collectSuggestions(responses);

    // Log progress
    this.log(`Turn ${context.turnNumber}: ${findings.length} findings, ${suggestions.length} suggestions`);

    // Create hypotheses from critical findings
    for (const finding of findings.filter(f => f.severity === 'critical')) {
      const hypothesis = this.createHypothesisFromFinding(finding);
      if (hypothesis && !this.hasExistingHypothesis(session, hypothesis)) {
        session.addHypothesis(hypothesis);
      }
    }

    // Check for confident hypothesis
    const topHypothesis = session.getTopHypothesis();
    if (topHypothesis && topHypothesis.confidence >= this.config.confidenceThreshold) {
      this.log(`Confident hypothesis found: ${topHypothesis.title} (${topHypothesis.confidence.toFixed(2)})`);
      return {
        action: 'conclude',
        reasoning: `High confidence hypothesis: ${topHypothesis.title}`,
      };
    }

    // Check for max turns warning
    if (context.turnNumber >= this.config.maxDialogueTurns - 1) {
      return {
        action: 'conclude',
        reasoning: 'Approaching max turns, synthesizing available evidence',
      };
    }

    // Decide next action based on findings and suggestions
    if (suggestions.length > 0) {
      // Follow suggestions to drill down
      const nextQueries = this.createQueriesFromSuggestions(
        suggestions.slice(0, 2), // Limit to 2 follow-up queries
        context
      );

      if (nextQueries.length > 0) {
        return {
          action: 'continue',
          nextQueries,
          reasoning: `Following ${nextQueries.length} suggestions for deeper analysis`,
        };
      }
    }

    // If no suggestions but have hypotheses, try to verify them
    if (context.activeHypotheses.length > 0) {
      const verificationQueries = this.generateVerificationQueries(session);
      if (verificationQueries.length > 0) {
        return {
          action: 'continue',
          nextQueries: verificationQueries,
          reasoning: 'Verifying active hypotheses',
        };
      }
    }

    // NEW: If no suggestions but have findings and AI service, ask AI for deeper analysis decision
    if (suggestions.length === 0 && findings.length > 0 && this.aiService && context.turnNumber < 3) {
      const aiDecision = await this.getAIAnalysisDecision(context, findings);
      if (aiDecision) {
        this.log(`AI suggests: ${aiDecision.reasoning}`);
        return aiDecision;
      }
    }

    // No more leads - conclude with what we have
    return {
      action: 'conclude',
      reasoning: 'No more suggestions to follow, concluding with available evidence',
    };
  }

  /**
   * Ask AI to analyze findings and decide if deeper analysis is needed
   */
  private async getAIAnalysisDecision(
    context: DialogueContext,
    findings: ModuleFinding[]
  ): Promise<AnalysisDecision | null> {
    if (!this.aiService) return null;

    const findingsSummary = findings.slice(0, 10).map(f => ({
      title: f.title,
      severity: f.severity,
      source: f.sourceModule,
      evidence: Object.entries(f.evidence).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', '),
    }));

    const availableModules = [
      { id: 'binder_analysis', desc: '分析 Binder IPC 调用阻塞' },
      { id: 'cpu_analysis', desc: '分析 CPU 调度和抢占' },
      { id: 'lock_contention_analysis', desc: '分析锁竞争' },
      { id: 'gc_analysis', desc: '分析 GC 暂停' },
      { id: 'io_pressure', desc: '分析 IO 阻塞' },
    ];

    const prompt = `你是 Android 性能分析专家。根据当前分析结果，决定是否需要继续深入分析。

## 当前分析意图
${this.currentIntent}

## 已收集的发现 (${findings.length} 个)
${JSON.stringify(findingsSummary, null, 2)}

## 可用的深入分析模块
${availableModules.map(m => `- ${m.id}: ${m.desc}`).join('\n')}

## 决策要求
分析上述发现，判断：
1. 根因是否已经清晰？如果是，返回 {"action": "conclude", "reason": "原因"}
2. 是否需要进一步分析？如果是，指定需要调用的模块

请以 JSON 格式返回你的决策：
{
  "action": "conclude" | "continue",
  "reason": "决策原因",
  "modules": ["module_id"] // 仅当 action=continue 时需要
}`;

    try {
      const result = await this.aiService.callWithFallback(prompt, 'reasoning', { jsonMode: true });
      if (!result.success) {
        this.log(`AI decision failed: ${result.error}`);
        return null;
      }

      const decision = JSON.parse(result.response);

      if (decision.action === 'conclude') {
        return {
          action: 'conclude',
          reasoning: `AI 判断: ${decision.reason}`,
        };
      }

      if (decision.action === 'continue' && decision.modules?.length > 0) {
        // Build queries for suggested modules
        const nextQueries = decision.modules.slice(0, 2).map((moduleId: string) =>
          buildModuleQuery(
            moduleId,
            `ai_suggested_${moduleId}`,
            { package: context.packageName },
            context
          )
        );

        return {
          action: 'continue',
          nextQueries,
          reasoning: `AI 建议深入分析: ${decision.reason}`,
        };
      }

      return null;
    } catch (error: any) {
      this.log(`AI decision error: ${error.message}`);
      return null;
    }
  }

  /**
   * Synthesize final conclusion from all collected evidence
   */
  protected async synthesizeConclusion(
    session: DialogueSession
  ): Promise<ExpertConclusion> {
    const context = session.getContext();
    const topHypothesis = session.getTopHypothesis();
    const allFindings = context.collectedFindings;

    // If we have a confident hypothesis, use it as base
    if (topHypothesis && topHypothesis.confidence >= 0.5) {
      const baseConclusion = {
        category: topHypothesis.category,
        component: topHypothesis.component,
        summary: topHypothesis.title,
        explanation: this.buildExplanation(topHypothesis, context),
        evidence: topHypothesis.supportingEvidence,
        suggestions: this.generateOptimizationSuggestions(topHypothesis),
        confidence: topHypothesis.confidence,
        confirmedHypothesis: topHypothesis,
      };

      // Enhance with AI synthesis if available
      if (this.aiService) {
        const aiEnhanced = await this.getAISynthesis(context, allFindings, baseConclusion);
        if (aiEnhanced) {
          return { ...baseConclusion, ...aiEnhanced };
        }
      }

      return baseConclusion;
    }

    // Otherwise, synthesize from findings
    const criticalFindings = allFindings.filter(f => f.severity === 'critical');
    const warningFindings = allFindings.filter(f => f.severity === 'warning');

    // Determine category based on findings
    const category = this.determineCategory(allFindings);
    const component = this.determineComponent(allFindings);

    const baseConclusion = {
      category,
      component,
      summary: this.buildSummary(criticalFindings, warningFindings),
      explanation: this.buildFindingsExplanation(allFindings),
      evidence: this.convertFindingsToEvidence(allFindings),
      suggestions: this.generateSuggestionsFromFindings(allFindings),
      confidence: this.calculateOverallConfidence(allFindings),
    };

    // Use AI to generate better synthesis if available
    if (this.aiService && allFindings.length > 0) {
      const aiEnhanced = await this.getAISynthesis(context, allFindings, baseConclusion);
      if (aiEnhanced) {
        return { ...baseConclusion, ...aiEnhanced };
      }
    }

    return baseConclusion;
  }

  /**
   * Use AI to synthesize findings into a coherent conclusion
   */
  private async getAISynthesis(
    context: DialogueContext,
    findings: ModuleFinding[],
    baseConclusion: Partial<ExpertConclusion>
  ): Promise<Partial<ExpertConclusion> | null> {
    if (!this.aiService) return null;

    const findingsSummary = findings.slice(0, 15).map(f => ({
      title: f.title,
      severity: f.severity,
      source: f.sourceModule,
      confidence: f.confidence,
      evidence: Object.entries(f.evidence).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', '),
    }));

    const prompt = `你是 Android 性能分析专家。请综合分析以下发现，生成诊断结论。

## 分析意图
${this.currentIntent} 性能分析

## 当前判断
- 问题类别: ${baseConclusion.category || 'UNKNOWN'}
- 问题组件: ${baseConclusion.component || 'Unknown'}
- 置信度: ${((baseConclusion.confidence || 0) * 100).toFixed(0)}%

## 发现列表 (${findings.length} 个)
${JSON.stringify(findingsSummary, null, 2)}

## 任务
请基于以上发现，生成：
1. **summary**: 一句话总结根本原因（不超过 50 字）
2. **explanation**: 详细解释问题原因和影响（100-200 字）
3. **suggestions**: 3-5 条具体可操作的优化建议

请以 JSON 格式返回：
{
  "summary": "根因总结",
  "explanation": "详细解释",
  "suggestions": ["建议1", "建议2", "建议3"]
}`;

    try {
      const result = await this.aiService.callWithFallback(prompt, 'synthesis', { jsonMode: true });
      if (!result.success) {
        this.log(`AI synthesis failed: ${result.error}`);
        return null;
      }

      const synthesis = JSON.parse(result.response);
      this.log(`AI synthesis generated: ${synthesis.summary}`);

      return {
        summary: synthesis.summary || baseConclusion.summary,
        explanation: synthesis.explanation || baseConclusion.explanation,
        suggestions: synthesis.suggestions || baseConclusion.suggestions,
      };
    } catch (error: any) {
      this.log(`AI synthesis error: ${error.message}`);
      return null;
    }
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Classify user query into performance intent
   */
  private classifyIntent(query: string): PerformanceIntent {
    const lowerQuery = query.toLowerCase();

    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      if (intent === 'general') continue;
      for (const keyword of keywords) {
        if (lowerQuery.includes(keyword)) {
          return intent as PerformanceIntent;
        }
      }
    }

    return 'general';
  }

  /**
   * Get the appropriate skill for a module and intent
   */
  private getSkillForModule(
    moduleId: string,
    intent: PerformanceIntent
  ): string | null {
    const moduleSkillMap: Record<string, Record<PerformanceIntent, string>> = {
      'framework_surfaceflinger': {
        jank: 'janky_frame_analysis',
        scroll: 'scrolling_analysis',
        startup: 'scrolling_analysis',
        click: 'scrolling_analysis',
        general: 'scrolling_analysis',
      },
      'kernel_scheduler': {
        jank: 'cpu_analysis',
        scroll: 'cpu_analysis',
        startup: 'cpu_analysis',
        click: 'cpu_analysis',
        general: 'cpu_analysis',
      },
      'framework_ams': {
        jank: 'anr_analysis',
        scroll: 'startup_analysis',
        startup: 'startup_analysis',
        click: 'startup_analysis',
        general: 'startup_analysis',
      },
      'framework_wms': {
        jank: 'click_response_analysis',
        scroll: 'click_response_analysis',
        startup: 'click_response_analysis',
        click: 'click_response_analysis',
        general: 'click_response_analysis',
      },
      'framework_input': {
        jank: 'click_response_analysis',
        scroll: 'click_response_analysis',
        startup: 'click_response_analysis',
        click: 'click_response_analysis',
        general: 'click_response_analysis',
      },
      'kernel_binder': {
        jank: 'binder_analysis',
        scroll: 'binder_analysis',
        startup: 'binder_analysis',
        click: 'binder_analysis',
        general: 'binder_analysis',
      },
      'app_third_party': {
        jank: 'janky_frame_analysis',
        scroll: 'scrolling_analysis',
        startup: 'startup_analysis',
        click: 'click_response_analysis',
        general: 'scrolling_analysis',
      },
      'hardware_gpu': {
        jank: 'scrolling_analysis',
        scroll: 'scrolling_analysis',
        startup: 'scrolling_analysis',
        click: 'scrolling_analysis',
        general: 'scrolling_analysis',
      },
    };

    return moduleSkillMap[moduleId]?.[intent] || null;
  }

  /**
   * Create hypothesis from a finding
   */
  private createHypothesisFromFinding(finding: ModuleFinding): Hypothesis | null {
    // Map finding source to hypothesis category
    const category = this.mapSourceToCategory(finding.sourceModule);
    const component = this.extractComponent(finding);

    return this.createHypothesis(
      finding.title,
      finding.description || finding.title,
      category,
      component,
      finding.confidence * 0.7 // Initial confidence based on finding
    );
  }

  /**
   * Check if a similar hypothesis already exists
   */
  private hasExistingHypothesis(session: DialogueSession, hypothesis: Hypothesis): boolean {
    const context = session.getContext();
    return context.activeHypotheses.some(h =>
      h.component.toLowerCase() === hypothesis.component.toLowerCase() &&
      h.category === hypothesis.category
    );
  }

  /**
   * Generate queries to verify hypotheses
   */
  private generateVerificationQueries(session: DialogueSession): ModuleQuery[] {
    const context = session.getContext();
    const queries: ModuleQuery[] = [];

    for (const hypothesis of context.activeHypotheses.filter(h => h.status === 'exploring')) {
      // Find modules that can verify this hypothesis
      const verificationModules = this.getVerificationModules(hypothesis);

      for (const moduleId of verificationModules) {
        // Skip if already queried
        const alreadyQueried = context.queryHistory.some(q =>
          q.targetModule === moduleId
        );
        if (alreadyQueried) continue;

        const skillName = this.getSkillForModule(moduleId, this.currentIntent);
        if (!skillName) continue;

        queries.push(buildModuleQuery(
          skillName,
          `verify_${hypothesis.component}`,
          {
            package: context.packageName,
            hypothesis_component: hypothesis.component,
          },
          context
        ));

        // Limit verification queries
        if (queries.length >= 2) break;
      }

      if (queries.length >= 2) break;
    }

    return queries;
  }

  /**
   * Get modules that can verify a hypothesis
   */
  private getVerificationModules(hypothesis: Hypothesis): string[] {
    const componentToModules: Record<string, string[]> = {
      'binder': ['kernel_binder', 'framework_ams'],
      'scheduler': ['kernel_scheduler', 'hardware_cpu'],
      'gc': ['framework_art', 'hardware_memory'],
      'surfaceflinger': ['framework_surfaceflinger', 'hardware_gpu'],
      'input': ['framework_input', 'framework_wms'],
    };

    const component = hypothesis.component.toLowerCase();
    for (const [key, modules] of Object.entries(componentToModules)) {
      if (component.includes(key)) {
        return modules;
      }
    }

    return this.catalog.getRelatedModules(hypothesis.component) || [];
  }

  /**
   * Map source module to hypothesis category
   */
  private mapSourceToCategory(sourceModule: string): Hypothesis['category'] {
    const source = sourceModule.toLowerCase();

    if (source.includes('app') || source.includes('third_party')) {
      return 'APP';
    }
    if (source.includes('kernel') || source.includes('hardware')) {
      return 'SYSTEM';
    }
    if (source.includes('framework')) {
      return 'MIXED';
    }

    return 'UNKNOWN';
  }

  /**
   * Extract component name from finding
   */
  private extractComponent(finding: ModuleFinding): string {
    // Try to extract from evidence
    if (finding.evidence.component) {
      return String(finding.evidence.component);
    }

    // Extract from source module
    const parts = finding.sourceModule.split('_');
    if (parts.length > 1) {
      return parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    }

    return finding.sourceModule;
  }

  /**
   * Determine category from all findings
   */
  private determineCategory(findings: ModuleFinding[]): Hypothesis['category'] {
    const categories = findings.map(f => this.mapSourceToCategory(f.sourceModule));

    const appCount = categories.filter(c => c === 'APP').length;
    const systemCount = categories.filter(c => c === 'SYSTEM').length;

    if (appCount > systemCount * 2) return 'APP';
    if (systemCount > appCount * 2) return 'SYSTEM';
    if (appCount > 0 && systemCount > 0) return 'MIXED';

    return 'UNKNOWN';
  }

  /**
   * Determine main component from findings
   */
  private determineComponent(findings: ModuleFinding[]): string {
    if (findings.length === 0) return 'Unknown';

    // Find most common component
    const componentCounts = new Map<string, number>();
    for (const finding of findings) {
      const component = this.extractComponent(finding);
      componentCounts.set(component, (componentCounts.get(component) || 0) + 1);
    }

    let maxCount = 0;
    let mainComponent = 'Unknown';
    for (const [component, count] of componentCounts) {
      if (count > maxCount) {
        maxCount = count;
        mainComponent = component;
      }
    }

    return mainComponent;
  }

  /**
   * Build summary from findings
   */
  private buildSummary(
    criticalFindings: ModuleFinding[],
    warningFindings: ModuleFinding[]
  ): string {
    if (criticalFindings.length > 0) {
      return `发现 ${criticalFindings.length} 个严重问题: ${criticalFindings[0].title}`;
    }
    if (warningFindings.length > 0) {
      return `发现 ${warningFindings.length} 个潜在问题: ${warningFindings[0].title}`;
    }
    return '未发现明显性能问题';
  }

  /**
   * Build explanation from hypothesis
   */
  private buildExplanation(hypothesis: Hypothesis, context: DialogueContext): string {
    const lines: string[] = [];

    lines.push(`**根因分析**: ${hypothesis.description}`);
    lines.push('');
    lines.push('**支持证据**:');
    for (const evidence of hypothesis.supportingEvidence) {
      lines.push(`- [${evidence.sourceModule}] ${evidence.summary}`);
    }

    if (hypothesis.contradictingEvidence.length > 0) {
      lines.push('');
      lines.push('**需注意**:');
      for (const evidence of hypothesis.contradictingEvidence) {
        lines.push(`- ${evidence.summary}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build explanation from findings
   */
  private buildFindingsExplanation(findings: ModuleFinding[]): string {
    if (findings.length === 0) {
      return '分析未发现明显问题。';
    }

    const lines: string[] = [];
    lines.push('**发现的问题**:');
    for (const finding of findings.slice(0, 5)) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      if (finding.description) {
        lines.push(`  ${finding.description}`);
      }
    }

    if (findings.length > 5) {
      lines.push(`... 还有 ${findings.length - 5} 个发现`);
    }

    return lines.join('\n');
  }

  /**
   * Generate optimization suggestions based on hypothesis
   */
  private generateOptimizationSuggestions(hypothesis: Hypothesis): string[] {
    const suggestions: string[] = [];
    const component = hypothesis.component.toLowerCase();

    if (component.includes('binder')) {
      suggestions.push('减少同步 Binder 调用，考虑使用异步方式');
      suggestions.push('检查是否有跨进程调用阻塞主线程');
    }
    if (component.includes('gc') || component.includes('memory')) {
      suggestions.push('减少对象分配，避免在渲染路径上创建临时对象');
      suggestions.push('考虑使用对象池或缓存');
    }
    if (component.includes('cpu') || component.includes('scheduler')) {
      suggestions.push('优化计算密集型操作，考虑异步处理');
      suggestions.push('检查是否有不必要的主线程工作');
    }
    if (component.includes('surfaceflinger') || component.includes('render')) {
      suggestions.push('减少过度绘制，优化布局层级');
      suggestions.push('使用硬件加速的绘制操作');
    }

    if (suggestions.length === 0) {
      suggestions.push('根据具体发现优化相关代码路径');
    }

    return suggestions;
  }

  /**
   * Generate suggestions from findings
   */
  private generateSuggestionsFromFindings(findings: ModuleFinding[]): string[] {
    const suggestions: string[] = [];

    for (const finding of findings.filter(f => f.severity !== 'info').slice(0, 3)) {
      suggestions.push(`解决: ${finding.title}`);
    }

    return suggestions.length > 0 ? suggestions : ['继续监控性能指标'];
  }

  /**
   * Convert findings to evidence format
   */
  private convertFindingsToEvidence(findings: ModuleFinding[]): import('../types').HypothesisEvidence[] {
    return findings.map(f => ({
      sourceModule: f.sourceModule,
      findingId: f.id,
      weight: f.severity === 'critical' ? 0.8 : f.severity === 'warning' ? 0.5 : 0.3,
      summary: f.title,
      data: f.evidence,
    }));
  }

  /**
   * Calculate overall confidence from findings
   */
  private calculateOverallConfidence(findings: ModuleFinding[]): number {
    if (findings.length === 0) return 0.3;

    const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
    const hasCritical = findings.some(f => f.severity === 'critical');

    let confidence = avgConfidence;
    if (hasCritical) confidence = Math.min(1, confidence * 1.2);
    if (findings.length >= 3) confidence = Math.min(1, confidence * 1.1);

    return confidence;
  }
}

/**
 * Factory function to create a PerformanceExpert
 */
export function createPerformanceExpert(
  config?: Partial<CrossDomainExpertConfig>
): PerformanceExpert {
  return new PerformanceExpert(config);
}
