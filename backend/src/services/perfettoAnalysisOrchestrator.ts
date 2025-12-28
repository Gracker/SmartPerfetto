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
import { SessionPersistenceService } from './sessionPersistenceService';
import { StoredSession, StoredMessage } from '../models/sessionSchema';
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

    // Default configuration
    this.config = {
      maxIterations: config?.maxIterations ?? 10,
      sqlTimeout: config?.sqlTimeout ?? 30000,
      aiService: config?.aiService ?? (process.env.AI_SERVICE as any) ?? 'deepseek',
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
   * Start analysis for a session
   */
  public async startAnalysis(sessionId: string): Promise<void> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Verify trace exists
    const trace = this.traceProcessor.getTrace(session.traceId);
    if (!trace) {
      this.sessionService.failSession(sessionId, `Trace ${session.traceId} not found`);
      return;
    }

    // Update state to generating SQL
    this.sessionService.updateState(sessionId, AnalysisState.GENERATING_SQL);

    try {
      await this.runAnalysisLoop(sessionId);
    } catch (error: any) {
      console.error(`[Orchestrator] Analysis failed for session ${sessionId}:`, error);
      this.emitError(sessionId, error.message, false);
      this.sessionService.failSession(sessionId, error.message);
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

      if (!sqlResult.sql) {
        // AI couldn't generate SQL, try to answer directly
        const directAnswer = await this.generateDirectAnswer(sessionId, currentQuestion);
        this.sessionService.completeSession(sessionId, directAnswer);
        this.emitCompleted(sessionId, directAnswer, startTime);
        return;
      }

      // Emit SQL generated event
      this.emitSQLGenerated(sessionId, iteration, sqlResult.sql, sqlResult.explanation);

      // Step 2: Execute SQL
      this.sessionService.updateState(sessionId, AnalysisState.EXECUTING_SQL);
      this.emitProgress(sessionId, 'executing_sql', '⏳ 正在执行查询...');
      const queryResult = await this.executeSQL(sessionId, sqlResult.sql);

      // Emit SQL executed event
      this.emitSQLExecuted(sessionId, iteration, sqlResult.sql, queryResult);

      // Step 3: Check for errors
      if (queryResult.error) {
        if (!this.config.enableRetry) {
          this.sessionService.failSession(sessionId, queryResult.error);
          return;
        }

        // Generate fixed SQL
        this.sessionService.updateState(sessionId, AnalysisState.RETRYING);
        const fixPrompt = this.buildFixPrompt(sqlResult.sql, queryResult.error);
        currentQuestion = fixPrompt;
        continue;
      }

      // Step 4: Check for empty results
      if (queryResult.rowCount === 0) {
        if (!this.config.enableRetry) {
          // Complete with empty result message
          const answer = this.buildEmptyResultAnswer(sqlResult.sql, sqlResult.explanation);
          this.sessionService.completeSession(sessionId, answer);
          this.emitCompleted(sessionId, answer, startTime);
          return;
        }

        // Ask AI to adjust approach
        this.sessionService.updateState(sessionId, AnalysisState.RETRYING);
        const adjustPrompt = this.buildAdjustPrompt(sqlResult.sql, sqlResult.explanation);
        currentQuestion = adjustPrompt;
        continue;
      }

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

    // Try Perfetto SQL Skill first if available
    if (this.perfettoSqlSkill) {
      try {
        console.log('[Orchestrator] Using Perfetto SQL Skill for:', question);
        const perfettoResult = await this.perfettoSqlSkill.analyze({
          traceId: session.traceId,
          question,
        });

        if (perfettoResult.sql && perfettoResult.rowCount >= 0) {
          console.log('[Orchestrator] Perfetto SQL Skill generated SQL successfully');
          return {
            sql: perfettoResult.sql,
            explanation: perfettoResult.summary,
          };
        }
      } catch (error: any) {
        console.log('[Orchestrator] Perfetto SQL Skill failed, falling back to AI:', error.message);
      }
    }

    // Get trace schema for context
    const schemaContext = await this.getTraceSchema(session.traceId);

    // Build messages with conversation history
    const messages = this.buildSQLGenerationMessages(question, schemaContext, session);

    if (!this.isConfigured || !this.openai) {
      // Use mock SQL based on keywords
      return this.generateMockSQL(question);
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      });

      const response = completion.choices[0]?.message?.content || '';
      return this.parseSQLResponse(response);
    } catch (error: any) {
      console.error('[Orchestrator] AI call failed:', error.message);
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
    } catch (error: any) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 0,
        error: error.message,
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
    } catch (error: any) {
      console.error(`[Orchestrator] DeepSeek API error:`, error.message);
      return `Query returned ${result.rowCount} rows.`;
    }
  }

  /**
   * Evaluate if result is complete
   */
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

    const messages = [
      {
        role: 'system' as const,
        content: `Evaluate if the query result sufficiently answers the user's question.
Respond with a JSON object:
{
  "isSufficient": true/false,
  "confidence": "high/medium/low",
  "reasoning": "brief explanation",
  "needsMoreData": true/false,
  "suggestedNextSteps": ["optional next query to run"]
}`,
      },
      {
        role: 'user' as const,
        content: `User Question: "${question}"
SQL: ${result.sql}
Results: ${result.result.rowCount} rows found
Insight: ${result.insight}

Is this sufficient to answer the question?`,
      },
    ];

    try {
      const completion = await Promise.race([
        this.openai.chat.completions.create({
          model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          messages,
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI API timeout after 20s')), 20000)
        )
      ]);

      const response = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(response);

      return {
        completeness: parsed.isSufficient ? CompletenessLevel.COMPLETE : CompletenessLevel.PARTIAL,
        confidence: parsed.confidence === 'high' ? 1 : parsed.confidence === 'medium' ? 0.7 : 0.4,
        needsMoreData: parsed.needsMoreData ?? !parsed.isSufficient,
        suggestedNextSteps: parsed.suggestedNextSteps || [],
      };
    } catch (error: any) {
      console.error(`[Orchestrator] Evaluation error:`, error.message);
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
    } catch (error: any) {
      console.error(`[Orchestrator] Final answer generation error:`, error.message);
      return session.collectedResults.map((cr) => cr.insight).join('\n\n');
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
    session: any
  ): ChatCompletionMessageParam[] {
    // Use PromptTemplateService for unified template management
    const templateService = PromptTemplateService.getInstance();
    const schemaWithTables = `${schemaContext}\n\n${PERFETTO_TABLES_SCHEMA}`;

    const basePrompt = templateService.formatTemplate('sql-generation', {
      schema: schemaWithTables,
      examples: JSON.stringify(PERFETTO_SQL_EXAMPLES, null, 2),
    });

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
    const session = this.sessionService.getSession(sessionId);
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
      },
    };
    this.sessionService.emitSSE(sessionId, event);
  }

  private emitError(sessionId: string, error: string, recoverable: boolean): void {
    const event: ErrorEvent = {
      type: 'error',
      timestamp: Date.now(),
      data: { error, recoverable },
    };
    this.sessionService.emitSSE(sessionId, event);
  }
}

export default PerfettoAnalysisOrchestrator;
