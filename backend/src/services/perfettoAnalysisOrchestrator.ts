/**
 * Perfetto Analysis Orchestrator
 *
 * Orchestrates the AI-powered trace analysis loop:
 * 1. Generate SQL based on user question
 * 2. Execute SQL against trace
 * 3. Validate and evaluate results
 * 4. Retry or adjust as needed
 * 5. Generate final answer
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { PERFETTO_TABLES_SCHEMA, PERFETTO_SQL_EXAMPLES } from '../data/perfettoSchema';
import { TraceProcessorService } from './traceProcessorService';
import { AnalysisSessionService } from './analysisSessionService';
import SQLValidator from './sqlValidator';
import { PerfettoSqlSkill } from './perfettoSqlSkill';
import { SkillAnalysisAdapterV2, getSkillAnalysisAdapterV2 } from './skillEngine/skillAnalysisAdapterV2';
import { SkillEventCollector, createEventCollector } from './skillEngine/eventCollector';
import { SkillEvent } from './skillEngine/types_v2';
import { SessionPersistenceService } from './sessionPersistenceService';
import { StoredSession, StoredMessage } from '../models/sessionSchema';
import { getHTMLReportGenerator } from './htmlReportGenerator';
import PromptTemplateService from './promptTemplateService';
import {
  AnalysisState,
  OrchestratorConfig,
  QueryResult,
  AISQLResponse,
  ResultEvaluation,
  SQLGeneratedEvent,
  SQLExecutedEvent,
  StepCompletedEvent,
  AnalysisCompletedEvent,
  ErrorEvent,
  SQLResultStatus,
  CompletenessLevel,
  CollectedResult,
} from '../types/analysis';
import type { PerfettoSqlRequest } from '../types/perfettoSql';

/**
 * Main orchestrator for trace analysis
 */
export class PerfettoAnalysisOrchestrator {
  private traceProcessor: TraceProcessorService;
  private sessionService: AnalysisSessionService;
  private sqlValidator: SQLValidator;
  private config: OrchestratorConfig;
  private openai?: OpenAI;
  private isConfigured: boolean;
  private perfettoSqlSkill?: PerfettoSqlSkill;
  private skillAdapter: SkillAnalysisAdapterV2;
  private skillEngineInitialized: boolean = false;

  constructor(
    traceProcessor: TraceProcessorService,
    sessionService: AnalysisSessionService,
    config?: Partial<OrchestratorConfig>,
    perfettoSqlSkill?: PerfettoSqlSkill
  ) {
    this.traceProcessor = traceProcessor;
    this.sessionService = sessionService;
    this.sqlValidator = new SQLValidator();
    this.perfettoSqlSkill = perfettoSqlSkill;
    this.skillAdapter = getSkillAnalysisAdapterV2(traceProcessor);

    // Default configuration
    this.config = {
      maxIterations: config?.maxIterations ?? 10,
      sqlTimeout: config?.sqlTimeout ?? 30000,
      aiService: config?.aiService ?? (process.env.AI_SERVICE as 'deepseek' | 'openai' | undefined) ?? 'deepseek',
      enableRetry: config?.enableRetry ?? true,
      enableAutoEvaluation: config?.enableAutoEvaluation ?? true,
    };

    console.log('[Orchestrator] Config:', {
      aiService: this.config.aiService,
      hasDeepSeekKey: !!process.env.DEEPSEEK_API_KEY,
      deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL,
    });

    // Initialize AI client
    this.isConfigured = this.initializeAI();
    console.log('[Orchestrator] AI configured:', this.isConfigured);
  }

  /**
   * Initialize AI service
   */
  private initializeAI(): boolean {
    const aiService = this.config.aiService;

    if (aiService === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
      console.log('[Orchestrator] Initializing DeepSeek with API key:', process.env.DEEPSEEK_API_KEY?.substring(0, 10) + '...');
      this.openai = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      });
      console.log('[Orchestrator] DeepSeek initialized successfully');
      return true;
    } else if (aiService === 'openai' && process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return true;
    }

    console.warn('[Orchestrator] AI service not configured, will use mock responses');
    return false;
  }

  /**
   * Assess question complexity to determine which model to use
   * Complex questions benefit from deepseek-reasoner (with thinking)
   * Simple questions can use faster deepseek-chat
   */
  private assessQuestionComplexity(question: string): 'simple' | 'complex' {
    const complexPatterns = [
      // Chinese patterns
      /为什么|原因|分析|诊断|优化|建议|瓶颈|问题|调优/i,
      /启动|卡顿|ANR|内存泄漏|性能瓶颈|帧率|掉帧|卡死/i,
      /多个|对比|比较|关联|综合|完整|详细|深入/i,
      // English patterns
      /why|reason|analyze|diagnose|optimize|suggest|bottleneck/i,
      /startup|jank|ANR|memory leak|performance|frame drop/i,
      /multiple|compare|correlation|comprehensive|detailed|deep/i,
      /root cause|how to improve|what causes/i,
    ];

    const isComplex = complexPatterns.some(pattern => pattern.test(question));
    console.log(`[Orchestrator] Question complexity: ${isComplex ? 'complex' : 'simple'} for: "${question.substring(0, 50)}..."`);
    return isComplex ? 'complex' : 'simple';
  }

  /**
   * Get the appropriate model based on question complexity
   */
  private getModelForQuestion(question: string): { model: string; temperature: number; maxTokens: number } {
    const complexity = this.assessQuestionComplexity(question);
    const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    if (complexity === 'complex') {
      // Use deepseek-reasoner for complex questions if configured
      const reasonerModel = process.env.DEEPSEEK_REASONER_MODEL || 'deepseek-reasoner';
      return {
        model: reasonerModel,
        temperature: 0.5,
        maxTokens: 4000,
      };
    }

    // Use faster chat model for simple questions
    return {
      model: defaultModel,
      temperature: 0.3,
      maxTokens: 2000,
    };
  }

  /**
   * Start analysis for a session
   */
  public async startAnalysis(sessionId: string): Promise<void> {
    console.log('[Orchestrator] ========================================');
    console.log('[Orchestrator] startAnalysis called for session:', sessionId);
    const session = this.sessionService.getSession(sessionId);
    if (!session) {
      console.error('[Orchestrator] ERROR: Session not found:', sessionId);
      throw new Error(`Session ${sessionId} not found`);
    }

    console.log('[Orchestrator] Session found:', {
      id: session.id,
      traceId: session.traceId,
      question: session.question,
      status: session.status
    });

    // Verify trace exists
    console.log('[Orchestrator] Checking if trace exists...');
    const trace = this.traceProcessor.getTrace(session.traceId);
    console.log('[Orchestrator] Trace found:', !!trace, trace ? `status: ${trace.status}` : 'not found');
    if (!trace) {
      console.error('[Orchestrator] ERROR: Trace not found:', session.traceId);
      this.sessionService.failSession(sessionId, `Trace ${session.traceId} not found`);
      return;
    }

    // Update state to generating SQL
    console.log('[Orchestrator] Updating session state to GENERATING_SQL');
    this.sessionService.updateState(sessionId, AnalysisState.GENERATING_SQL);

    try {
      console.log('[Orchestrator] Starting analysis loop...');
      await this.runAnalysisLoop(sessionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Analysis failed for session ${sessionId}:`, error);
      this.emitError(sessionId, errorMessage, false);
      this.sessionService.failSession(sessionId, errorMessage);
    }
  }

  /**
   * Main analysis loop
   */
  private async runAnalysisLoop(sessionId: string): Promise<void> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return;

    let currentQuestion = session.question;
    const maxIterations = session.maxIterations;
    const startTime = Date.now();

    // 重复检测：用于检测相同SQL或相同结果的重复
    let lastSql = '';
    let lastRowCount = -1;
    let repeatCount = 0;
    const MAX_REPEATS = 2;  // 连续重复2次就停止

    // Main loop
    while (session.currentIteration < maxIterations) {
      this.sessionService.incrementIteration(sessionId);
      const iteration = session.currentIteration;

      console.log(`[Orchestrator] Session ${sessionId}, iteration ${iteration}/${maxIterations}`);

      // Emit progress - starting new iteration
      this.sessionService.emitProgress(
        sessionId,
        iteration,
        maxIterations,
        `正在执行第 ${iteration}/${maxIterations} 轮分析...`
      );

      // Step 1: Generate SQL
      this.sessionService.updateState(sessionId, AnalysisState.GENERATING_SQL);
      this.emitProgress(sessionId, 'generating_sql', '🤔 正在生成查询...');
      const sqlResult = await this.generateSQL(sessionId, currentQuestion);

      console.log(`[Orchestrator] Iteration ${iteration} - SQL generated:`, sqlResult.sql ? 'YES' : 'NO');
      if (sqlResult.sql) {
        console.log(`[Orchestrator] SQL (first 200 chars):`, sqlResult.sql.substring(0, 200));
        console.log(`[Orchestrator] Explanation:`, sqlResult.explanation);
      }

      // =========================================================================
      // Handle Skill Engine results directly (skip SQL execution)
      // =========================================================================
      if (sqlResult.skillEngineResult) {
        console.log(`[Orchestrator] Skill Engine result available, using directly`);
        const skillResult = sqlResult.skillEngineResult;

        // Emit skill_started event
        this.emitProgress(sessionId, 'skill_started', `🚀 正在执行 ${skillResult.skillName} 分析...`);

        // Emit each section as a separate event with data for frontend display
        let sectionIndex = 0;
        for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
          sectionIndex++;
          if (!sectionData) continue;

          // Handle for_each steps: array of {itemIndex, item, data, rowCount}
          let tableData: { columns: string[]; rows: any[][]; rowCount: number } | null = null;
          let sectionTitle = sectionId;
          // 提取 expandableData 和 summary（来自 skillExecutorV2 的输出）
          const expandableData = (sectionData as any).expandableData;
          const summary = (sectionData as any).summary;

          if (Array.isArray(sectionData)) {
            // Collect all data from for_each iterations
            const allRows: any[][] = [];
            let columns: string[] = [];

            for (const itemResult of sectionData) {
              if (itemResult && itemResult.data && Array.isArray(itemResult.data)) {
                // Get columns from first row with data
                if (columns.length === 0 && itemResult.data.length > 0) {
                  columns = Object.keys(itemResult.data[0]);
                }
                // Add rows
                for (const row of itemResult.data) {
                  allRows.push(columns.map(col => row[col]));
                }
              }
            }

            if (allRows.length > 0) {
              tableData = { columns, rows: allRows, rowCount: allRows.length };
            }
          }
          // Handle regular steps: {title, data, rowCount, sql}
          else if (sectionData.data && Array.isArray(sectionData.data) && sectionData.data.length > 0) {
            sectionTitle = sectionData.title || sectionId;
            const columns = Object.keys(sectionData.data[0]);
            const rows = sectionData.data.map((row: any) => columns.map(col => row[col]));
            tableData = { columns, rows, rowCount: rows.length };
          }

          // Emit section data event
          if (tableData) {
            this.emitSkillSection(sessionId, {
              sectionId,
              sectionTitle,
              sectionIndex,
              totalSections: Object.keys(skillResult.sections).length,
              columns: tableData.columns,
              rows: tableData.rows,
              rowCount: tableData.rowCount,
              sql: (sectionData as any).sql || undefined,
              expandableData,
              summary,
            });
          }
        }

        // Emit diagnostics if any
        if (skillResult.diagnostics && skillResult.diagnostics.length > 0) {
          this.emitSkillDiagnostics(sessionId, skillResult.diagnostics);
        }

        // Collect results for final answer - 为每个有 SQL 的 section 创建单独的 CollectedResult
        let sectionCount = 0;
        for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
          if (!sectionData) continue;
          sectionCount++;

          const sectionSql = (sectionData as any).sql;
          const sectionTitle = (sectionData as any).title || sectionId;

          // 如果有 SQL，创建单独的 CollectedResult
          if (sectionSql) {
            // 获取表格数据
            let queryResult: QueryResult;
            if (sectionData.data && Array.isArray(sectionData.data) && sectionData.data.length > 0) {
              const columns = Object.keys(sectionData.data[0]);
              const rows = sectionData.data.map((row: any) => columns.map(col => row[col]));
              queryResult = {
                columns,
                rows,
                rowCount: rows.length,
                durationMs: Math.round(skillResult.executionTimeMs / sectionCount),  // 平均估算
              };
            } else {
              queryResult = {
                columns: [],
                rows: [],
                rowCount: 0,
                durationMs: 0,
              };
            }

            const collectedResult: CollectedResult = {
              sql: sectionSql,
              result: queryResult,
              insight: sectionTitle,
              timestamp: Date.now(),
              stepNumber: iteration,
            };
            this.sessionService.addCollectedResult(sessionId, collectedResult);
          }
        }

        // 创建一个汇总的 CollectedResult（用于显示概览）
        const summaryResult: CollectedResult = {
          sql: `-- Skill: ${skillResult.skillId} (Summary)`,
          result: {
            columns: ['section', 'data'],
            rows: Object.entries(skillResult.sections).map(([k, v]) => [k, JSON.stringify(v)]),
            rowCount: Object.keys(skillResult.sections).length,
            durationMs: skillResult.executionTimeMs,
          },
          insight: sqlResult.explanation,
          timestamp: Date.now(),
          stepNumber: iteration,
        };
        this.sessionService.addCollectedResult(sessionId, summaryResult);

        // Store skillEngineResult to session for HTML report generation
        console.log('[Orchestrator] Storing Skill Engine result to session...');
        this.sessionService.updateState(sessionId, AnalysisState.GENERATING_SQL, {
          skillEngineResult: {
            skillId: skillResult.skillId,
            skillName: skillResult.skillName,
            sections: skillResult.sections,
            diagnostics: skillResult.diagnostics || [],
            vendor: skillResult.vendor,
            executionTimeMs: skillResult.executionTimeMs,
            directAnswer: skillResult.directAnswer,
            summary: skillResult.summary,
            questionType: skillResult.questionType,
            answerConfidence: skillResult.answerConfidence,
          },
        });

        // Generate final answer from skill results
        console.log('[Orchestrator] Generating final answer from Skill Engine results...');
        this.emitProgress(sessionId, 'generating_answer', '✍️ 正在生成分析报告...');
        const skillAnswer = await this.generateFinalAnswerFromSkill(sessionId, skillResult, sqlResult.explanation);
        this.sessionService.completeSession(sessionId, skillAnswer);
        this.emitCompleted(sessionId, skillAnswer, startTime);
        return;
      }

      if (!sqlResult.sql) {
        // AI couldn't generate SQL, try to answer directly
        console.log('[Orchestrator] No SQL generated, calling generateDirectAnswer...');
        const directAnswer = await this.generateDirectAnswer(sessionId, currentQuestion);
        console.log('[Orchestrator] Direct answer:', directAnswer.substring(0, 100) + '...');
        this.sessionService.completeSession(sessionId, directAnswer);
        this.emitCompleted(sessionId, directAnswer, startTime);
        return;
      }

      // 重复检测：检查是否生成了相同的SQL
      const sqlNormalized = sqlResult.sql.replace(/\s+/g, ' ').trim();
      const lastSqlNormalized = lastSql.replace(/\s+/g, ' ').trim();
      if (sqlNormalized === lastSqlNormalized) {
        repeatCount++;
        console.log(`[Orchestrator] Detected repeated SQL (count: ${repeatCount})`);
        if (repeatCount >= MAX_REPEATS) {
          console.log('[Orchestrator] Breaking due to repeated SQL');
          break;
        }
      } else {
        repeatCount = 0;
      }
      lastSql = sqlResult.sql;

      // Emit SQL generated event
      this.emitSQLGenerated(sessionId, iteration, sqlResult.sql, sqlResult.explanation);

      // Step 2: Execute SQL
      this.sessionService.updateState(sessionId, AnalysisState.EXECUTING_SQL);
      this.emitProgress(sessionId, 'executing_sql', '⏳ 正在执行查询...');
      const queryResult = await this.executeSQL(sessionId, sqlResult.sql);

      console.log(`[Orchestrator] Iteration ${iteration} - SQL executed:`, {
        error: queryResult.error || 'none',
        rowCount: queryResult.rowCount,
        columnCount: queryResult.columns?.length || 0,
        durationMs: queryResult.durationMs,
      });

      // Emit SQL executed event
      this.emitSQLExecuted(sessionId, iteration, sqlResult.sql, queryResult);

      // Step 3: Check for errors
      if (queryResult.error) {
        console.log(`[Orchestrator] Iteration ${iteration} - SQL ERROR:`, queryResult.error);
        if (!this.config.enableRetry) {
          this.sessionService.failSession(sessionId, queryResult.error);
          return;
        }

        // Generate fixed SQL
        console.log('[Orchestrator] Retrying with fix prompt...');
        this.sessionService.updateState(sessionId, AnalysisState.RETRYING);
        const fixPrompt = this.buildFixPrompt(sqlResult.sql, queryResult.error);
        currentQuestion = fixPrompt;
        continue;
      }

      // Step 4: Check for empty results
      if (queryResult.rowCount === 0) {
        console.log(`[Orchestrator] Iteration ${iteration} - Empty result (0 rows)`);
        if (!this.config.enableRetry) {
          // Complete with empty result message
          const answer = this.buildEmptyResultAnswer(sqlResult.sql, sqlResult.explanation);
          this.sessionService.completeSession(sessionId, answer);
          this.emitCompleted(sessionId, answer, startTime);
          return;
        }

        // Ask AI to adjust approach with diagnosis of trace contents
        console.log('[Orchestrator] Retrying with adjusted prompt and trace diagnosis...');
        this.sessionService.updateState(sessionId, AnalysisState.RETRYING);
        this.emitProgress(sessionId, 'diagnosing', '🔍 正在诊断 trace 内容...');
        const adjustPrompt = await this.buildAdjustPromptWithDiagnosis(
          session.traceId,
          sqlResult.sql,
          sqlResult.explanation
        );
        console.log('[Orchestrator] Adjusted prompt with diagnosis:', adjustPrompt.substring(0, 300) + '...');
        currentQuestion = adjustPrompt;
        continue;
      }

      console.log(`[Orchestrator] Iteration ${iteration} - SUCCESS! Got ${queryResult.rowCount} rows`);

      // 重复检测：检查是否获得相同行数的结果（可能是相同数据）
      if (queryResult.rowCount === lastRowCount && queryResult.rowCount > 0) {
        repeatCount++;
        console.log(`[Orchestrator] Detected repeated row count (count: ${repeatCount})`);
        if (repeatCount >= MAX_REPEATS) {
          console.log('[Orchestrator] Breaking due to repeated results');
          // 先收集当前结果，再退出
          const insight = await this.analyzeQueryResult(sessionId, sqlResult.sql, queryResult);
          const collectedResult: CollectedResult = {
            sql: sqlResult.sql,
            result: queryResult,
            insight,
            timestamp: Date.now(),
            stepNumber: iteration,
          };
          this.sessionService.addCollectedResult(sessionId, collectedResult);
          break;
        }
      }
      lastRowCount = queryResult.rowCount;

      // Step 5: Collect successful result
      this.emitProgress(sessionId, 'analyzing', '📊 正在分析结果...');
      const insight = await this.analyzeQueryResult(sessionId, sqlResult.sql, queryResult);
      const collectedResult: CollectedResult = {
        sql: sqlResult.sql,
        result: queryResult,
        insight,
        timestamp: Date.now(),
        stepNumber: iteration,
      };
      this.sessionService.addCollectedResult(sessionId, collectedResult);

      // Emit step completed
      this.emitStepCompleted(sessionId, iteration, 'sql_success', insight);

      // Step 6: Evaluate if we have enough data
      this.sessionService.updateState(sessionId, AnalysisState.VALIDATING_RESULT);

      if (!this.config.enableAutoEvaluation || iteration >= maxIterations) {
        // Max iterations reached, generate final answer
        break;
      }

      const evaluation = await this.evaluateResultCompleteness(sessionId, currentQuestion, collectedResult);

      if (evaluation.completeness === CompletenessLevel.COMPLETE) {
        // Have enough data, generate final answer
        break;
      } else if (evaluation.completeness === CompletenessLevel.INSUFFICIENT) {
        // Need more data, continue loop with refined question
        if (evaluation.suggestedNextSteps && evaluation.suggestedNextSteps.length > 0) {
          currentQuestion = evaluation.suggestedNextSteps[0];
        } else {
          currentQuestion = `Please continue analyzing to answer: "${session.question}"`;
        }
      }
      // PARTIAL: Continue with another query
    }

    // Generate final answer
    this.emitProgress(sessionId, 'generating_answer', '✍️ 正在生成最终答案...');
    const finalAnswer = await this.generateFinalAnswer(sessionId);
    this.sessionService.completeSession(sessionId, finalAnswer);
    this.emitCompleted(sessionId, finalAnswer, startTime);

    // Persist session to database
    this.persistSession(sessionId);
  }

  /**
   * Generate SQL for a question
   *
   * Strategy:
   * 1. Try Perfetto SQL Skill first (for known patterns)
   * 2. Fall back to AI generation
   * 3. Final fallback to mock SQL
   */
  private async generateSQL(sessionId: string, question: string): Promise<AISQLResponse> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return { sql: '', explanation: '' };

    // Get enriched AI context from the skill (with official Perfetto SQL patterns)
    let enrichedAIContext = '';

    // =========================================================================
    // Step 1: Try Skill Engine first (YAML-based skills)
    // Only on first iteration - retries should use AI for fixing SQL errors
    // =========================================================================
    const isFirstIteration = session.currentIteration <= 1;

    if (isFirstIteration) {
      // =========================================================================
      // Try Skill Engine (YAML-based skills)
      // =========================================================================
      try {
        if (!this.skillEngineInitialized) {
          await this.skillAdapter.ensureInitialized();

          // 注入 AI 服务到 skill engine
          if (this.openai && this.isConfigured) {
            const aiModel = this.config.aiService === 'deepseek'
              ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat')
              : (process.env.OPENAI_MODEL || 'gpt-4');

            this.skillAdapter.setAIService({
              chat: async (prompt: string) => {
                try {
                  const completion = await this.openai!.chat.completions.create({
                    model: aiModel,
                    messages: [
                      {
                        role: 'system',
                        content: 'You are a performance analysis expert. Analyze the data provided and give concise, actionable insights in Chinese. Focus on root causes and specific recommendations.',
                      },
                      { role: 'user', content: prompt },
                    ],
                    temperature: 0.3,
                    max_tokens: 1024,
                  });
                  return completion.choices[0]?.message?.content || '';
                } catch (error: any) {
                  console.error('[Orchestrator] AI service call failed:', error.message);
                  return '';
                }
              },
            });
            console.log('[Orchestrator] AI service injected to Skill Engine');
          }

          this.skillEngineInitialized = true;
          console.log('[Orchestrator] Skill Engine initialized');
        }

        // Detect intent from question
        const skillId = this.skillAdapter.detectIntent(question);

        if (skillId) {
          console.log(`[Orchestrator] Skill Engine matched: ${skillId} for question: "${question}"`);

          // Extract package name from question if present
          const packageMatch = question.match(/([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)/);
          const packageName = packageMatch ? packageMatch[1] : undefined;
          if (packageName) {
            console.log(`[Orchestrator] Extracted package name: ${packageName}`);
          }

          const skillResult = await this.skillAdapter.analyze({
            traceId: session.traceId,
            skillId,
            question,
            packageName,
          });

          if (skillResult.success && Object.keys(skillResult.sections).length > 0) {
            console.log(`[Orchestrator] Skill Engine executed successfully: ${skillId}`);

            // Generate summary SQL from skill sections for display
            const sectionKeys = Object.keys(skillResult.sections);
            const firstSection = skillResult.sections[sectionKeys[0]];
            const displaySql = firstSection?.sql || `-- Skill: ${skillId}\n-- Executed ${sectionKeys.length} analysis steps`;

            // 优先使用 directAnswer（直接回答用户问题），否则使用 summary
            const explanation = skillResult.directAnswer || skillResult.summary;

            return {
              sql: displaySql,
              explanation,
              skillEngineResult: {
                skillId: skillResult.skillId,
                skillName: skillResult.skillName,
                sections: skillResult.sections,
                diagnostics: skillResult.diagnostics,
                vendor: skillResult.vendor,
                executionTimeMs: skillResult.executionTimeMs,
                directAnswer: skillResult.directAnswer,
                summary: skillResult.summary,
                questionType: skillResult.questionType,
                answerConfidence: skillResult.answerConfidence,
              },
            };
          } else {
            console.log(`[Orchestrator] Skill Engine returned no data for: ${skillId}, falling back`);
          }
        } else {
          console.log(`[Orchestrator] Skill Engine no match for: "${question}", trying legacy skill`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log('[Orchestrator] Skill Engine failed:', errorMessage, '- falling back to legacy');
      }
    } else {
      console.log(`[Orchestrator] Skipping Skill Engine (iteration ${session.currentIteration}), using AI for retry`);
    }

    // =========================================================================
    // Step 2: Try legacy Perfetto SQL Skill
    // =========================================================================
    if (this.perfettoSqlSkill) {
      try {
        console.log('[Orchestrator] Using legacy Perfetto SQL Skill for:', question);
        const perfettoResult = await this.perfettoSqlSkill.analyze({
          traceId: session.traceId,
          question,
        });

        if (perfettoResult.sql && perfettoResult.rowCount >= 0) {
          console.log('[Orchestrator] Legacy Perfetto SQL Skill generated SQL successfully');
          return {
            sql: perfettoResult.sql,
            explanation: perfettoResult.summary,
          };
        }

        // Even if no direct SQL match, capture the AI context for enhanced prompting
        if (perfettoResult.aiContext) {
          enrichedAIContext = perfettoResult.aiContext;
          console.log('[Orchestrator] Got enriched AI context with official Perfetto SQL patterns');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log('[Orchestrator] Legacy Perfetto SQL Skill failed, falling back to AI:', errorMessage);
      }

      // Try to get enriched context even if skill didn't return SQL
      if (!enrichedAIContext) {
        try {
          enrichedAIContext = await this.perfettoSqlSkill.getEnrichedAIContext(question);
        } catch (error) {
          // Ignore - enriched context is optional
        }
      }
    }

    // Get trace schema for context
    const schemaContext = await this.getTraceSchema(session.traceId);

    // Build messages with conversation history and enriched AI context
    const messages = this.buildSQLGenerationMessages(question, schemaContext, session, enrichedAIContext);

    if (!this.isConfigured || !this.openai) {
      // Use mock SQL based on keywords
      return this.generateMockSQL(question);
    }

    try {
      // Use dynamic model based on question complexity
      const modelConfig = this.getModelForQuestion(question);
      console.log(`[Orchestrator] Using model: ${modelConfig.model} for SQL generation`);

      const completion = await this.openai.chat.completions.create({
        model: modelConfig.model,
        messages,
        temperature: modelConfig.temperature,
        max_tokens: modelConfig.maxTokens,
      });

      const response = completion.choices[0]?.message?.content || '';
      return this.parseSQLResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] AI call failed:', errorMessage);
      // Fallback to mock SQL
      return this.generateMockSQL(question);
    }
  }

  /**
   * Execute SQL query
   */
  private async executeSQL(sessionId: string, sql: string): Promise<QueryResult> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
        error: 'Session not found',
        status: SQLResultStatus.RUNTIME_ERROR,
      };
    }

    try {
      const startTime = Date.now();
      const result = await this.traceProcessor.query(session.traceId, sql);
      const duration = Date.now() - startTime;

      return {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rows.length,
        durationMs: duration,
        error: result.error,
        status: result.error ? SQLResultStatus.RUNTIME_ERROR : SQLResultStatus.SUCCESS,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
        error: errorMessage,
        status: SQLResultStatus.RUNTIME_ERROR,
      };
    }
  }

  /**
   * Analyze query result with AI
   */
  private async analyzeQueryResult(
    sessionId: string,
    sql: string,
    result: QueryResult
  ): Promise<string> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return 'Unable to analyze result';

    if (!this.isConfigured || !this.openai) {
      // Simple summary
      return `Query returned ${result.rowCount} rows.`;
    }

    // Format result for AI
    const resultSummary = this.formatResultForAI(result);

    const messages = [
      {
        role: 'system' as const,
        content: 'You are a Perfetto trace analysis expert. Analyze the query results and provide insights.',
      },
      {
        role: 'user' as const,
        content: `SQL Query:\n${sql}\n\nResult:\n${resultSummary}\n\nProvide a brief analysis of this result in the context of: "${session.question}"`,
      },
    ];

    try {
      console.log(`[Orchestrator] Calling DeepSeek API for analysis...`);
      const completion = await Promise.race([
        this.openai.chat.completions.create({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          messages,
          temperature: 0.3,
          max_tokens: 500,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI API timeout after 30s')), 30000)
        )
      ]);

      console.log(`[Orchestrator] DeepSeek API response received`);
      return completion.choices[0]?.message?.content || `Query returned ${result.rowCount} rows.`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] DeepSeek API error:`, errorMessage);
      return `Query returned ${result.rowCount} rows.`;
    }
  }

  /**
   * Evaluate if result is complete
   */
  /**
   * Format a sample of query results for AI evaluation
   */
  private formatDataSample(result: QueryResult): string {
    if (result.rowCount === 0) return '(无数据)';

    // Show column names and first 5 rows
    const header = result.columns.join(' | ');
    const rows = result.rows.slice(0, 5)
      .map((row: any[]) => row.map(v => String(v ?? 'NULL').substring(0, 50)).join(' | '))
      .join('\n');

    const moreRows = result.rowCount > 5 ? `\n... (还有 ${result.rowCount - 5} 行)` : '';
    return `| ${header} |\n${rows}${moreRows}`;
  }

  private async evaluateResultCompleteness(
    sessionId: string,
    question: string,
    result: CollectedResult
  ): Promise<ResultEvaluation> {
    if (!this.config.enableAutoEvaluation) {
      return {
        completeness: CompletenessLevel.PARTIAL,
        confidence: 0.5,
        needsMoreData: false,
      };
    }

    if (!this.isConfigured || !this.openai) {
      // Simple heuristic: if we have data, consider it partial
      return {
        completeness: result.result.rowCount > 0 ? CompletenessLevel.PARTIAL : CompletenessLevel.INSUFFICIENT,
        confidence: 0.5,
        needsMoreData: result.result.rowCount === 0,
      };
    }

    // Format data sample for AI evaluation
    const dataSample = this.formatDataSample(result.result);

    const messages = [
      {
        role: 'system' as const,
        content: `你是 Perfetto trace 分析专家。评估当前查询结果是否足够回答用户问题。

返回 JSON:
{
  "isSufficient": true/false,
  "confidence": "high/medium/low",
  "reasoning": "为什么足够/不足够",
  "missingInfo": ["缺失的信息列表"],
  "suggestedNextSteps": ["建议的下一步查询"]
}

评估标准:
- 如果数据直接回答了用户问题的核心部分，则认为足够
- 如果只有部分信息但不完整，则需要更多数据
- 考虑数据是否有时间顺序、是否覆盖完整场景`,
      },
      {
        role: 'user' as const,
        content: `用户问题: "${question}"

执行的查询:
\`\`\`sql
${result.sql}
\`\`\`

返回数据 (${result.result.rowCount} 行):
${dataSample}

当前分析: ${result.insight}

请评估:
1. 这些数据是否足够回答用户问题？
2. 如果不够，还缺少什么信息？
3. 建议下一步应该查询什么？`,
      },
    ];

    try {
      const completion = await Promise.race([
        this.openai.chat.completions.create({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          messages,
          temperature: 0.5,  // Increased from 0 for more nuanced evaluation
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI API timeout after 20s')), 20000)
        )
      ]);

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);

      console.log('[Orchestrator] Evaluation result:', {
        isSufficient: parsed.isSufficient,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning?.substring(0, 100),
      });

      return {
        completeness: parsed.isSufficient ? CompletenessLevel.COMPLETE : CompletenessLevel.PARTIAL,
        confidence: parsed.confidence === 'high' ? 1 : parsed.confidence === 'medium' ? 0.7 : 0.4,
        needsMoreData: parsed.needsMoreData ?? !parsed.isSufficient,
        suggestedNextSteps: parsed.suggestedNextSteps || [],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Evaluation error:`, errorMessage);
      return {
        completeness: CompletenessLevel.UNCERTAIN,
        confidence: 0.5,
        needsMoreData: true,
      };
    }
  }

  /**
   * Generate final answer from collected results
   */
  private async generateFinalAnswer(sessionId: string): Promise<string> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return 'Session not found';

    if (session.collectedResults.length === 0) {
      return "I couldn't find relevant data to answer your question. The trace may not contain the information you're looking for.";
    }

    if (!this.isConfigured || !this.openai) {
      // Simple concatenation of insights
      return session.collectedResults
        .map((cr, i) => `**Query ${i + 1}:**\n${cr.insight}\n`)
        .join('\n') + `\n\nBased on ${session.collectedResults.length} queries executed.`;
    }

    // Build context for final answer
    const resultsContext = session.collectedResults
      .map((cr, i) => {
        return `
Query ${i + 1}:
SQL: ${cr.sql}
Results: ${cr.result.rowCount} rows
Insight: ${cr.insight}
`;
      })
      .join('\n');

    const messages = [
      {
        role: 'system' as const,
        content: 'You are a Perfetto trace analysis expert. Provide a clear, comprehensive answer to the user based on the query results.',
      },
      {
        role: 'user' as const,
        content: `User Question: "${session.question}"

${resultsContext}

Provide a final answer that directly addresses the user's question. Include specific numbers and data points when relevant.`,
      },
    ];

    try {
      console.log(`[Orchestrator] Calling DeepSeek API for final answer...`);
      const completion = await Promise.race([
        this.openai.chat.completions.create({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          messages,
          temperature: 0.5,
          max_tokens: 2000,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI API timeout after 60s')), 60000)
        )
      ]);

      console.log(`[Orchestrator] Final answer generated successfully`);
      return completion.choices[0]?.message?.content || 'Unable to generate final answer.';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Orchestrator] Final answer generation error:`, errorMessage);
      return session.collectedResults.map((cr) => cr.insight).join('\n\n');
    }
  }

  /**
   * Generate final answer from Skill Engine results
   */
  private async generateFinalAnswerFromSkill(
    sessionId: string,
    skillResult: {
      skillId: string;
      skillName: string;
      sections: Record<string, any>;
      diagnostics: Array<{ id: string; severity: string; message: string; suggestions?: string[] }>;
      vendor?: string;
      executionTimeMs: number;
    },
    summary: string
  ): Promise<string> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return 'Session not found';

    // Build detailed data summary from sections
    const sectionDetails: string[] = [];
    for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
      if (!sectionData) continue;

      // Handle for_each steps: array of {itemIndex, item, data, rowCount}
      if (Array.isArray(sectionData)) {
        const allData: any[] = [];
        for (const itemResult of sectionData) {
          if (itemResult && itemResult.data && Array.isArray(itemResult.data)) {
            allData.push(...itemResult.data);
          }
        }
        if (allData.length > 0) {
          const dataPreview = allData.slice(0, 10).map((row: any) => JSON.stringify(row)).join('\n');
          sectionDetails.push(`### ${sectionId} (${allData.length} 条记录)\n${dataPreview}`);
        }
      }
      // Handle regular steps: {title, data, rowCount, sql}
      else if (sectionData.data && Array.isArray(sectionData.data)) {
        const dataPreview = sectionData.data.slice(0, 10).map((row: any) => JSON.stringify(row)).join('\n');
        sectionDetails.push(`### ${sectionId} (${sectionData.data.length} 条记录)\n${dataPreview}`);
      }
    }

    // Build diagnostics summary
    const diagnosticDetails = skillResult.diagnostics
      .map(d => `- [${d.severity.toUpperCase()}] ${d.message}${d.suggestions ? '\n  建议: ' + d.suggestions.join(', ') : ''}`)
      .join('\n');

    if (!this.isConfigured || !this.openai) {
      // Return raw skill summary if AI not configured
      return `## ${skillResult.skillName} 分析结果\n\n${summary}\n\n### 诊断结果\n${diagnosticDetails || '无诊断问题'}\n\n### 详细数据\n${sectionDetails.join('\n\n')}`;
    }

    // Use AI to generate a natural language answer
    // Note: Keep the summary concise - detailed data is already shown in tables
    const messages = [
      {
        role: 'system' as const,
        content: `你是一个 Android 性能分析专家。基于 Skill Engine 的分析结果，生成一份**简洁**的性能评估总结。

要求：
- 简洁明了，不超过 300 字
- 只输出核心结论和性能评估
- **不要**输出具体的优化建议（前端会单独显示诊断结果）
- **不要**重复列出详细数据（前端已经用表格显示了）
- 使用表情符号增加可读性

格式示例：
📊 **性能评估：良好**
该应用冷启动耗时 301.84ms，处于优秀水平。主线程 CPU 利用率 68.5%，系统调度良好。
主要耗时点：布局加载(42ms)、Activity创建(86ms)。`,
      },
      {
        role: 'user' as const,
        content: `用户问题: "${session.question}"

分析类型: ${skillResult.skillName}
执行耗时: ${skillResult.executionTimeMs}ms
${skillResult.vendor ? `厂商: ${skillResult.vendor}` : ''}

### 分析摘要
${summary}

### 诊断结果
${diagnosticDetails || '无诊断问题'}

### 详细数据预览
${sectionDetails.slice(0, 3).join('\n\n')}

请生成一份简洁的性能评估总结（不超过300字，不需要优化建议，不需要重复列出数据）。`,
      },
    ];

    try {
      const completion = await this.openai.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      });

      return completion.choices[0]?.message?.content || summary;
    } catch (error) {
      console.error('[Orchestrator] Failed to generate answer from skill results:', error);
      // Fallback to raw summary
      return `## ${skillResult.skillName} 分析结果\n\n${summary}\n\n### 诊断结果\n${diagnosticDetails || '无诊断问题'}`;
    }
  }

  /**
   * Generate direct answer without SQL
   */
  private async generateDirectAnswer(sessionId: string, question: string): Promise<string> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return 'Session not found';

    if (!this.isConfigured || !this.openai) {
      return "I need to run SQL queries to answer your question, but the AI service is not configured. Please configure DEEPSEEK_API_KEY or OPENAI_API_KEY.";
    }

    const messages = [
      {
        role: 'system' as const,
        content: 'You are a Perfetto trace analysis expert. Answer the user question about their trace.',
      },
      {
        role: 'user' as const,
        content: `Question: "${question}"

Note: SQL queries couldn't be generated for this question. Please provide general guidance about what the user should look for in their trace.`,
      },
    ];

    try {
      const completion = await this.openai.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        temperature: 0.5,
        max_tokens: 1000,
      });

      return completion.choices[0]?.message?.content || 'Unable to generate answer.';
    } catch (error) {
      return 'I was unable to analyze the trace. Please try rephrasing your question.';
    }
  }

  /**
   * Persist session to long-term storage
   */
  private persistSession(sessionId: string): void {
    try {
      const session = this.sessionService.getSession(sessionId);
      if (!session) return;

      const persistenceService = SessionPersistenceService.getInstance();

      const storedSession: StoredSession = {
        id: sessionId,
        traceId: session.traceId,
        traceName: session.traceId, // Can be enhanced with actual trace name
        question: session.question,
        createdAt: session.createdAt.getTime(),
        updatedAt: Date.now(),
        metadata: {
          totalIterations: session.currentIteration,
          sqlQueriesCount: session.collectedResults.length,
          totalDuration: Date.now() - session.createdAt.getTime(),
        },
        messages: session.messages.map(m => ({
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.getTime(),
          sqlResult: m.queryResult ? {
            columns: m.queryResult.columns,
            rows: m.queryResult.rows,
            rowCount: m.queryResult.rowCount,
            query: m.sql,
          } : undefined,
        })),
      };

      persistenceService.saveSession(storedSession);
      console.log(`[Orchestrator] Session ${sessionId} persisted to database`);
    } catch (error) {
      console.error('[Orchestrator] Failed to persist session:', error);
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private buildSQLGenerationMessages(
    question: string,
    schemaContext: string,
    session: any,
    enrichedAIContext?: string
  ): ChatCompletionMessageParam[] {
    // Use PromptTemplateService for unified template management
    const templateService = PromptTemplateService.getInstance();
    const schemaWithTables = `${schemaContext}\n\n${PERFETTO_TABLES_SCHEMA}`;

    // Build base prompt with optional enriched context from official Perfetto SQL library
    let basePrompt = templateService.formatTemplate('sql-generation', {
      schema: schemaWithTables,
      examples: JSON.stringify(PERFETTO_SQL_EXAMPLES, null, 2),
    });

    // Append enriched AI context if available (contains official Perfetto SQL patterns)
    if (enrichedAIContext) {
      basePrompt += `\n\n## Official Perfetto SQL Reference\n${enrichedAIContext}`;
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: basePrompt },
    ];

    // Add conversation history
    for (const msg of session.messages) {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    // Add current question if not already in messages
    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg || lastMsg.content !== question) {
      messages.push({ role: 'user', content: question });
    }

    return messages;
  }

  private parseSQLResponse(response: string): AISQLResponse {
    const sqlMatch = response.match(/```sql\n([\s\S]*?)\n```/);
    const sql = sqlMatch ? sqlMatch[1].trim() : '';

    // Extract explanation (everything after the SQL block)
    const explanationMatch = response.match(/```sql\n[\s\S]*?\n```([\s\S]*)/);
    const explanation = explanationMatch
      ? explanationMatch[1].trim()
      : 'SQL query generated';

    return { sql, explanation };
  }

  private async getTraceSchema(traceId: string): Promise<string> {
    try {
      const result = await this.traceProcessor.query(
        traceId,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 50"
      );

      const tables = result.rows.map((row) => row[0]);
      return `Available tables in this trace:\n${tables.map((t) => `- ${t}`).join('\n')}\n\n${PERFETTO_TABLES_SCHEMA}`;
    } catch (error) {
      return PERFETTO_TABLES_SCHEMA;
    }
  }

  private formatResultForAI(result: QueryResult): string {
    const maxRows = 20;
    const displayRows = result.rows.slice(0, maxRows);

    let output = `| ${result.columns.join(' | ')} |\n`;
    output += `| ${result.columns.map(() => '---').join(' | ')} |\n`;

    for (const row of displayRows) {
      output += `| ${row.map((v) => (v === null ? 'NULL' : String(v))).join(' | ')} |\n`;
    }

    if (result.rows.length > maxRows) {
      output += `\n(... ${result.rows.length - maxRows} more rows)\n`;
    }

    return output;
  }

  private buildFixPrompt(sql: string, error: string): string {
    // Use PromptTemplateService for unified template management
    const templateService = PromptTemplateService.getInstance();
    return templateService.formatTemplate('sql-fix', {
      sql,
      error,
    });
  }

  /**
   * Diagnose why a query returned empty results by exploring trace contents
   */
  private async diagnoseEmptyResult(traceId: string, failedSql: string): Promise<string> {
    const diagnosisLines: string[] = [];

    try {
      // 1. Query what tables are available
      const tablesResult = await this.traceProcessor.query(traceId,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      if (tablesResult.rows && tablesResult.rows.length > 0) {
        const tableNames = tablesResult.rows.map((r: any[]) => r[0]).slice(0, 30);
        diagnosisLines.push(`可用表: ${tableNames.join(', ')}`);
      }

      // 2. Query common slice names in the trace
      const sliceNamesResult = await this.traceProcessor.query(traceId,
        "SELECT name, COUNT(*) as cnt FROM slice WHERE name IS NOT NULL GROUP BY name ORDER BY cnt DESC LIMIT 20"
      );
      if (sliceNamesResult.rows && sliceNamesResult.rows.length > 0) {
        const sliceNames = sliceNamesResult.rows.map((r: any[]) => `${r[0]}(${r[1]})`).slice(0, 15);
        diagnosisLines.push(`常见 slice 事件: ${sliceNames.join(', ')}`);
      }

      // 3. Query process names
      const processesResult = await this.traceProcessor.query(traceId,
        "SELECT name FROM process WHERE name IS NOT NULL AND name != '' GROUP BY name ORDER BY name LIMIT 20"
      );
      if (processesResult.rows && processesResult.rows.length > 0) {
        const processNames = processesResult.rows.map((r: any[]) => r[0]);
        diagnosisLines.push(`进程列表: ${processNames.join(', ')}`);
      }

      // 4. Check if android_startup table exists and has data
      const startupCheck = await this.traceProcessor.query(traceId,
        "SELECT COUNT(*) FROM android_startup_processes"
      );
      if (startupCheck.rows && startupCheck.rows.length > 0) {
        const count = startupCheck.rows[0][0] as number;
        diagnosisLines.push(`android_startup_processes: ${count} 条记录`);
      }

      // 5. Check FrameTimeline data
      const ftCheck = await this.traceProcessor.query(traceId,
        "SELECT COUNT(*) FROM actual_frame_timeline_slice"
      );
      if (ftCheck.rows && ftCheck.rows.length > 0) {
        const count = ftCheck.rows[0][0] as number;
        diagnosisLines.push(`FrameTimeline frames: ${count} 帧`);
      }
    } catch (error) {
      // Some queries may fail if tables don't exist, that's ok
      console.log('[Orchestrator] Diagnosis query failed (expected for some traces):', error);
    }

    if (diagnosisLines.length === 0) {
      return 'Trace 诊断: 无法获取 trace 元数据';
    }

    return `Trace 内容诊断:\n${diagnosisLines.map(l => `- ${l}`).join('\n')}`;
  }

  private async buildAdjustPromptWithDiagnosis(
    traceId: string,
    sql: string,
    explanation: string
  ): Promise<string> {
    // Get diagnosis of trace contents
    const diagnosis = await this.diagnoseEmptyResult(traceId, sql);

    return `查询返回空结果，需要调整策略。

原始查询:
\`\`\`sql
${sql}
\`\`\`

查询意图: ${explanation}

${diagnosis}

请分析:
1. 为什么原查询返回空？WHERE 条件是否过于严格？
2. 根据 trace 中实际存在的数据，应该如何调整查询？
3. 是否需要换一种方式来回答用户的问题？

请生成一个更合适的 SQL 查询。`;
  }

  private buildAdjustPrompt(sql: string, explanation: string): string {
    // Use PromptTemplateService for unified template management
    const templateService = PromptTemplateService.getInstance();
    return templateService.formatTemplate('sql-adjust', {
      sql,
      explanation,
    });
  }

  private buildEmptyResultAnswer(sql: string, explanation: string): string {
    return `I attempted to analyze your trace but the query returned no results.

**Query Attempted:**
\`\`\`sql
${sql}
\`\`\`

**Explanation:**
${explanation}

This could mean:
- The trace doesn't contain the specific data you're looking for
- The query conditions need to be adjusted
- The trace was recorded during a different scenario

Please try rephrasing your question or providing more context about what you're looking for.`;
  }

  private generateMockSQL(question: string): AISQLResponse {
    const lowerQ = question.toLowerCase();

    // Simple pattern matching
    if (lowerQ.includes('jank') || lowerQ.includes('frame')) {
      return {
        sql: `SELECT
  process.name,
  slice.name,
  COUNT(*) AS count,
  AVG(slice.dur) / 1e6 AS avg_duration_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 16666000
GROUP BY process.name, slice.name
ORDER BY avg_duration_ms DESC
LIMIT 100;`,
        explanation: 'Finding jank frames with duration > 16.67ms (60fps threshold)',
      };
    }

    if (lowerQ.includes('anr')) {
      return {
        sql: `SELECT
  process.name,
  slice.name,
  slice.dur / 1e9 AS duration_s
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 5e9
ORDER BY slice.dur DESC
LIMIT 50;`,
        explanation: 'Finding potential ANRs with duration > 5 seconds',
      };
    }

    if (lowerQ.includes('startup') || lowerQ.includes('启动')) {
      return {
        sql: `SELECT
  process.name,
  slice.name,
  slice.ts / 1e6 AS start_time_ms,
  slice.dur / 1e6 AS duration_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.name LIKE '%start%'
  AND process.name NOT LIKE 'com.android%'
ORDER BY slice.ts ASC
LIMIT 100;`,
        explanation: 'Analyzing app startup events',
      };
    }

    // Default generic query
    return {
      sql: `SELECT
  slice.name,
  COUNT(*) AS count,
  AVG(slice.dur) / 1e6 AS avg_duration_ms
FROM slice
GROUP BY slice.name
HAVING COUNT(*) > 10
ORDER BY avg_duration_ms DESC
LIMIT 50;`,
      explanation: 'General query showing most frequent slices',
    };
  }

  // ============================================================================
  // Event Emitters
  // ============================================================================

  private emitProgress(sessionId: string, step: string, message: string): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'progress',
      timestamp: Date.now(),
      data: { step, message },
    });
  }

  private emitSQLGenerated(sessionId: string, stepNumber: number, sql: string, explanation?: string): void {
    const event: SQLGeneratedEvent = {
      type: 'sql_generated',
      timestamp: Date.now(),
      data: { stepNumber, sql, explanation },
    };
    this.sessionService.emitSSE(sessionId, event);
  }

  private emitSQLExecuted(sessionId: string, stepNumber: number, sql: string, result: QueryResult): void {
    const event: SQLExecutedEvent = {
      type: 'sql_executed',
      timestamp: Date.now(),
      data: { stepNumber, sql, result },
    };
    this.sessionService.emitSSE(sessionId, event);
  }

  private emitStepCompleted(sessionId: string, stepNumber: number, stepType: string, content: string): void {
    const event: StepCompletedEvent = {
      type: 'step_completed',
      timestamp: Date.now(),
      data: { stepNumber, stepType, content },
    };
    this.sessionService.emitSSE(sessionId, event);
  }

  private emitCompleted(sessionId: string, answer: string, startTime: number): void {
    console.log(`[Orchestrator] emitCompleted called for session ${sessionId}`);
    console.log(`[Orchestrator] Answer length: ${answer?.length || 0}`);
    const session = this.sessionService.getSession(sessionId);

    // Generate HTML report URL (direct view endpoint)
    const reportUrl = `/api/reports/view/${sessionId}`;

    const event: AnalysisCompletedEvent = {
      type: 'analysis_completed',
      timestamp: Date.now(),
      data: {
        sessionId,
        answer,
        metrics: {
          totalDuration: Date.now() - startTime,
          iterationsCount: session?.currentIteration || 0,
          sqlQueriesCount: session?.collectedResults.length || 0,
        },
        reportUrl,
      },
    };
    console.log(`[Orchestrator] Emitting analysis_completed event with reportUrl: ${reportUrl}`);
    this.sessionService.emitSSE(sessionId, event);
    console.log(`[Orchestrator] analysis_completed event emitted`);
  }

  private emitError(sessionId: string, error: string, recoverable: boolean): void {
    const event: ErrorEvent = {
      type: 'error',
      timestamp: Date.now(),
      data: { error, recoverable },
    };
    this.sessionService.emitSSE(sessionId, event);
  }

  private emitSkillSection(
    sessionId: string,
    sectionData: {
      sectionId: string;
      sectionTitle: string;
      sectionIndex: number;
      totalSections: number;
      columns: string[];
      rows: any[][];
      rowCount: number;
      sql?: string;
      expandableData?: Array<{
        item: Record<string, any>;
        result: {
          success: boolean;
          sections?: Record<string, any>;
          error?: string;
        };
      }>;
      summary?: {
        title: string;
        content: string;
      };
    }
  ): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'skill_section',
      timestamp: Date.now(),
      data: sectionData,
    });
  }

  private emitSkillDiagnostics(
    sessionId: string,
    diagnostics: Array<{ id: string; severity: string; message: string; suggestions?: string[] }>
  ): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'skill_diagnostics',
      timestamp: Date.now(),
      data: { diagnostics },
    });
  }
}

export default PerfettoAnalysisOrchestrator;
