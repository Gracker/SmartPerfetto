import { EventEmitter } from 'events';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { TraceProcessorService } from '../services/traceProcessorService';
import { createSkillExecutor } from '../services/skillEngine/skillExecutor';
import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../agent/types';
import type { AnalysisResult, AnalysisOptions } from '../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../agent/detectors/types';

import { createClaudeMcpServer } from './claudeMcpServer';
import { buildSystemPrompt } from './claudeSystemPrompt';
import { createSseBridge } from './claudeSseBridge';
import { extractFindingsFromText, extractFindingsFromSkillResult, mergeFindings } from './claudeFindingExtractor';
import { loadClaudeConfig, type ClaudeAgentConfig } from './claudeConfig';
import type { ClaudeAnalysisContext } from './types';

const ALLOWED_TOOLS = [
  'mcp__smartperfetto__execute_sql',
  'mcp__smartperfetto__invoke_skill',
  'mcp__smartperfetto__list_skills',
  'mcp__smartperfetto__detect_architecture',
  'mcp__smartperfetto__lookup_sql_schema',
];

/**
 * Claude Agent SDK runtime for SmartPerfetto.
 * Replaces the agentv2 governance pipeline with Claude-as-orchestrator.
 * Implements the same EventEmitter + analyze() interface as AgentRuntime.
 */
export class ClaudeRuntime extends EventEmitter {
  private traceProcessorService: TraceProcessorService;
  private config: ClaudeAgentConfig;
  private sessionMap = new Map<string, string>();

  constructor(traceProcessorService: TraceProcessorService, config?: Partial<ClaudeAgentConfig>) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.config = loadClaudeConfig(config);
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    const allFindings: Finding[][] = [];
    let conclusionText = '';
    let sdkSessionId: string | undefined;
    let rounds = 0;

    try {
      const skillExecutor = createSkillExecutor(this.traceProcessorService);
      const mcpServer = createClaudeMcpServer({
        traceId,
        traceProcessorService: this.traceProcessorService,
        skillExecutor,
        packageName: options.packageName,
      });

      let architecture: ArchitectureInfo | undefined;
      try {
        const detector = createArchitectureDetector();
        architecture = await detector.detect({
          traceId,
          traceProcessorService: this.traceProcessorService,
          packageName: options.packageName,
        });
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      } catch (err) {
        console.warn('[ClaudeRuntime] Architecture detection failed:', (err as Error).message);
      }

      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousFindings = this.collectPreviousFindings(sessionContext);
      const conversationSummary = sessionContext.generatePromptContext(2000);

      let skillCatalog: ClaudeAnalysisContext['skillCatalog'];
      try {
        const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
        const skills = await adapter.listSkills();
        skillCatalog = skills.map(s => ({ id: s.id, displayName: s.displayName, description: s.description, type: s.type }));
      } catch {
        // Non-fatal: Claude can still use the list_skills tool
      }

      const systemPrompt = buildSystemPrompt({
        query,
        architecture,
        packageName: options.packageName,
        previousFindings,
        conversationSummary: previousFindings.length > 0 ? conversationSummary : undefined,
        skillCatalog,
      });

      const bridge = createSseBridge((update: StreamingUpdate) => {
        this.emitUpdate(update);
        if (update.type === 'agent_response' && update.content?.result) {
          try {
            const parsed = typeof update.content.result === 'string'
              ? JSON.parse(update.content.result)
              : update.content.result;
            if (parsed?.success && parsed?.skillId) {
              allFindings.push(extractFindingsFromSkillResult(parsed));
            }
          } catch {
            // Not a skill result — ignore
          }
        }
      });

      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: `使用 ${this.config.model} 开始分析...` },
        timestamp: Date.now(),
      });

      const existingSdkSessionId = this.sessionMap.get(sessionId);
      const stream = sdkQuery({
        prompt: query,
        options: {
          model: this.config.model,
          maxTurns: this.config.maxTurns,
          systemPrompt,
          mcpServers: { smartperfetto: mcpServer },
          includePartialMessages: true,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          cwd: this.config.cwd,
          effort: this.config.effort,
          allowedTools: ALLOWED_TOOLS,
          ...(this.config.maxBudgetUsd ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
          ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
        },
      });

      let finalResult: string | undefined;

      for await (const msg of stream) {
        if (msg.session_id && !sdkSessionId) {
          sdkSessionId = msg.session_id;
          this.sessionMap.set(sessionId, sdkSessionId);
        }
        if (msg.type === 'assistant') rounds++;
        bridge(msg);
        if (msg.type === 'result' && (msg as any).subtype === 'success') {
          finalResult = (msg as any).result;
        }
      }

      conclusionText = finalResult || '';
      allFindings.push(extractFindingsFromText(conclusionText));
      const mergedFindings = mergeFindings(allFindings);

      sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'complex',
          followUpType: previousFindings.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: true,
          findings: mergedFindings,
          confidence: this.estimateConfidence(mergedFindings),
          message: conclusionText,
        },
        mergedFindings,
      );

      return {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: [],
        conclusion: conclusionText,
        confidence: this.estimateConfidence(mergedFindings),
        rounds,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errMsg = (error as Error).message || 'Unknown error';
      console.error('[ClaudeRuntime] Analysis failed:', errMsg);
      this.emitUpdate({ type: 'error', content: { message: `分析失败: ${errMsg}` }, timestamp: Date.now() });

      return {
        sessionId,
        success: false,
        findings: mergeFindings(allFindings),
        hypotheses: [],
        conclusion: `分析过程中出错: ${errMsg}`,
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  reset(): void {
    this.sessionMap.clear();
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }

  private collectPreviousFindings(sessionContext: any): Finding[] {
    try {
      const turns = sessionContext.getAllTurns?.() || [];
      return turns.flatMap((turn: any) => turn.findings || []);
    } catch {
      return [];
    }
  }

  private estimateConfidence(findings: Finding[]): number {
    if (findings.length === 0) return 0.3;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }
}
