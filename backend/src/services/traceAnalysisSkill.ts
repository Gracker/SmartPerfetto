/**
 * Trace Analysis Skill
 *
 * Implements an AI-driven SQL query loop for analyzing Perfetto traces.
 *
 * Features:
 * - Auto-generates SQL queries based on user questions
 * - Handles SQL syntax errors with automatic retry
 * - Handles empty results by informing AI
 * - Evaluates answer completeness
 * - Returns full analysis with step-by-step breakdown
 */

import OpenAI from 'openai';
import { TraceProcessorService } from './traceProcessorService';

// ============================================================================
// Types
// ============================================================================

export interface AnalysisRequest {
  question: string;
  traceId: string;
  model?: string;
  maxIterations?: number;
}

export interface AnalysisStep {
  stepNumber: number;
  type: 'thinking' | 'sql_query' | 'sql_success' | 'sql_empty' | 'sql_error' | 'analysis' | 'final';
  content: string;
  sql?: string;
  result?: {
    columns: string[];
    rows: any[][];
    rowCount: number;
  };
  error?: string;
  timestamp: number;
}

export interface AnalysisResult {
  id: string;
  question: string;
  traceId: string;
  status: 'running' | 'completed' | 'failed';
  steps: AnalysisStep[];
  finalAnswer?: string;
  isComplete: boolean;
  error?: string;
  startTime: number;
  endTime?: number;
}

// ============================================================================
// Service
// ============================================================================

export class TraceAnalysisSkill {
  private traceProcessor: TraceProcessorService;
  private openai?: OpenAI;
  private analyses: Map<string, AnalysisResult> = new Map();
  private isConfigured: boolean;

  constructor(traceProcessor: TraceProcessorService) {
    this.traceProcessor = traceProcessor;

    // Initialize OpenAI client (optional)
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

    if (apiKey) {
      this.openai = new OpenAI({
        apiKey,
        baseURL,
      });
      this.isConfigured = true;
    } else {
      console.warn('TraceAnalysisSkill: DEEPSEEK_API_KEY not configured, analysis features will be disabled');
      this.isConfigured = false;
    }
  }

  private ensureConfigured(): void {
    if (!this.isConfigured || !this.openai) {
      throw new Error('AI analysis is not configured. Please set DEEPSEEK_API_KEY environment variable.');
    }
  }

  /**
   * Start a new trace analysis
   */
  public async analyze(request: AnalysisRequest): Promise<string> {
    this.ensureConfigured();

    const { question, traceId, maxIterations = 12 } = request;

    // Verify trace exists
    const trace = this.traceProcessor.getTrace(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    // Generate unique analysis ID
    const analysisId = `analysis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Initialize analysis
    const analysis: AnalysisResult = {
      id: analysisId,
      question,
      traceId,
      status: 'running',
      steps: [],
      isComplete: false,
      startTime: Date.now(),
    };

    this.analyses.set(analysisId, analysis);

    // Start analysis in background
    this.runAnalysis(analysisId, question, traceId, maxIterations).catch((error) => {
      console.error(`Analysis ${analysisId} failed:`, error);
      const current = this.analyses.get(analysisId);
      if (current) {
        current.status = 'failed';
        current.error = error.message;
        current.endTime = Date.now();
      }
    });

    return analysisId;
  }

  /**
   * Get analysis status
   */
  public getStatus(analysisId: string): AnalysisResult | undefined {
    return this.analyses.get(analysisId);
  }

  /**
   * Get all active analyses
   */
  public getAllAnalyses(): AnalysisResult[] {
    return Array.from(this.analyses.values());
  }

  /**
   * Main analysis loop
   */
  private async runAnalysis(
    analysisId: string,
    question: string,
    traceId: string,
    maxIterations: number
  ): Promise<void> {
    const analysis = this.analyses.get(analysisId);
    if (!analysis) throw new Error('Analysis not found');

    // Get trace schema for context
    const schemaInfo = await this.getTraceSchema(traceId);
    const systemPrompt = this.buildSystemPrompt(schemaInfo);

    // Initial messages
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ];

    // Add initial thinking step
    this.addStep(analysisId, {
      stepNumber: analysis.steps.length + 1,
      type: 'thinking',
      content: `Starting analysis for question: "${question}"`,
      timestamp: Date.now(),
    });

    // Main loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await this.callAI(messages);

      // Check if AI wants to run SQL
      const sqlMatch = this.extractSQL(response);

      if (sqlMatch) {
        // AI wants to run SQL
        const step: AnalysisStep = {
          stepNumber: analysis.steps.length + 1,
          type: 'sql_query',
          content: 'Executing SQL query...',
          sql: sqlMatch,
          timestamp: Date.now(),
        };
        this.addStep(analysisId, step);

        // Execute SQL
        const result = await this.executeSQL(traceId, sqlMatch);

        if (result.error) {
          // SQL Error - tell AI to fix it
          this.addStep(analysisId, {
            stepNumber: analysis.steps.length + 1,
            type: 'sql_error',
            content: `SQL Error: ${result.error}`,
            error: result.error,
            timestamp: Date.now(),
          });

          messages.push({ role: 'assistant', content: response });
          messages.push({
            role: 'user',
            content: this.formatSQLError(sqlMatch, result.error || 'Unknown error'),
          });

          // Continue to let AI fix the error
          continue;
        } else if (result.rows.length === 0) {
          // Empty result - tell AI
          this.addStep(analysisId, {
            stepNumber: analysis.steps.length + 1,
            type: 'sql_empty',
            content: `Query returned 0 rows. No data found.`,
            result: {
              columns: result.columns,
              rows: [],
              rowCount: 0,
            },
            timestamp: Date.now(),
          });

          messages.push({ role: 'assistant', content: response });
          messages.push({
            role: 'user',
            content: this.formatEmptyResult(result.columns),
          });

          // Continue to let AI adjust approach
          continue;
        } else {
          // Success with data
          this.addStep(analysisId, {
            stepNumber: analysis.steps.length + 1,
            type: 'sql_success',
            content: `Query returned ${result.rows.length} rows`,
            result: {
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rows.length,
            },
            timestamp: Date.now(),
          });

          messages.push({ role: 'assistant', content: response });
          messages.push({
            role: 'user',
            content: this.formatQueryResult(result),
          });

          // Continue to let AI analyze
          continue;
        }
      } else {
        // No SQL in response - check if this is final answer
        const isFinal = await this.evaluateCompleteness(question, response, messages);

        if (isFinal) {
          // Analysis complete
          this.addStep(analysisId, {
            stepNumber: analysis.steps.length + 1,
            type: 'final',
            content: response,
            timestamp: Date.now(),
          });

          analysis.status = 'completed';
          analysis.finalAnswer = response;
          analysis.isComplete = true;
          analysis.endTime = Date.now();
          return;
        } else {
          // Needs more data
          this.addStep(analysisId, {
            stepNumber: analysis.steps.length + 1,
            type: 'thinking',
            content: 'Continuing analysis...',
            timestamp: Date.now(),
          });

          messages.push({ role: 'assistant', content: response });
          messages.push({
            role: 'user',
            content: 'Your analysis is incomplete. Please run ONE more SQL query to get the missing information needed to answer the user\'s question.',
          });

          continue;
        }
      }
    }

    // Max iterations reached - mark as completed anyway
    analysis.status = 'completed';
    analysis.finalAnswer = analysis.steps[analysis.steps.length - 1]?.content || 'Analysis reached maximum iterations.';
    analysis.isComplete = true;
    analysis.endTime = Date.now();
  }

  // ============================================================================
  // AI Interactions
  // ============================================================================

  private async callAI(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  ): Promise<string> {
    this.ensureConfigured();

    const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    const completion = await this.openai!.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    });

    return completion.choices[0]?.message?.content || '';
  }

  /**
   * Evaluate if the AI's response completely answers the question
   */
  private async evaluateCompleteness(
    question: string,
    response: string,
    conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  ): Promise<boolean> {
    // Use AI to evaluate completeness
    const evalMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are an evaluator. Your task is to determine if an analysis COMPLETELY answers the user's question.

Respond with ONLY "YES" or "NO" - nothing else.

YES = The answer is complete and addresses the user's question
NO = The answer is incomplete, needs more data, or is missing key information`
      },
      {
        role: 'user',
        content: `User Question: ${question}\n\nAI Response: ${response}\n\nIs this response complete?`,
      },
    ];

    try {
      this.ensureConfigured();
      const completion = await this.openai!.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: evalMessages,
        temperature: 0,
        max_tokens: 10,
      });

      const result = completion.choices[0]?.message?.content?.toUpperCase().trim() || '';
      return result.includes('YES');
    } catch {
      // If evaluation fails, assume complete to avoid infinite loop
      return true;
    }
  }

  // ============================================================================
  // SQL Execution
  // ============================================================================

  private async executeSQL(traceId: string, sql: string): Promise<
    | { columns: string[]; rows: any[][]; rowCount: number; error?: string }
    | { error: string; columns: string[]; rows: any[][]; rowCount: number }
  > {
    try {
      const result = await this.traceProcessor.query(traceId, sql);
      return {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rows.length,
      };
    } catch (error: any) {
      return {
        error: error.message || 'Unknown SQL error',
        columns: [],
        rows: [],
        rowCount: 0,
      };
    }
  }

  // ============================================================================
  // Formatters
  // ============================================================================

  private extractSQL(text: string): string | null {
    // Match ```sql ... ``` code blocks
    const match = text.match(/```sql\n([\s\S]*?)\n```/);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  private formatSQLError(sql: string, error: string): string {
    return `[SQL EXECUTION ERROR]

Your SQL query failed:
\`\`\`sql
${sql}
\`\`\`

Error: ${error}

Please FIX the SQL query and try again. Common issues:
- Wrong column names (check schema)
- Wrong table names (check schema)
- Syntax errors
- Type mismatches

Generate ONE corrected SQL query.
`;
  }

  private formatEmptyResult(columns: string[]): string {
    return `[QUERY RESULT - 0 ROWS]

Columns: ${columns.join(', ')}

The query executed successfully but returned NO DATA.

This means:
- Your WHERE conditions are too restrictive
- The data doesn't exist in this trace
- You're looking in the wrong place

Please ADJUST your approach and try a different query.
`;
  }

  private formatQueryResult(result: {
    columns: string[];
    rows: any[][];
    rowCount: number;
  }): string {
    const maxRows = 50;
    const displayRows = result.rows.slice(0, maxRows);
    const hasMore = result.rows.length > maxRows;

    let output = `[QUERY RESULT - ${result.rowCount} rows]\n\n`;
    output += `| ${result.columns.join(' | ')} |\n`;
    output += `| ${result.columns.map(() => '---').join(' | ')} |\n`;

    displayRows.forEach((row) => {
      output += `| ${row.map((v) => (v === null ? 'NULL' : String(v))).join(' | ')} |\n`;
    });

    if (hasMore) {
      output += `\n(... ${result.rows.length - maxRows} more rows not shown)\n`;
    }

    output += `\n[END OF RESULT]\n\n`;
    output += `Based on these results, continue your analysis. If you need more data, run ONE more SQL query. If you have enough information to answer the user's question, provide your final answer.`;

    return output;
  }

  // ============================================================================
  // Schema & Prompts
  // ============================================================================

  private async getTraceSchema(traceId: string): Promise<string> {
    // Get basic schema information
    const tables = await this.getAvailableTables(traceId);
    return `Available tables:\n${tables.map((t) => `- ${t}`).join('\n')}\n`;
  }

  private async getAvailableTables(traceId: string): Promise<string[]> {
    // Query to get table names
    try {
      const result = await this.traceProcessor.query(
        traceId,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      );
      return result.rows.map((row) => row[0]);
    } catch {
      // Fallback to common tables
      return [
        'process',
        'thread',
        'slice',
        'sched',
        'counter',
        'instant',
        'track',
        'metadata',
      ];
    }
  }

  private buildSystemPrompt(schemaInfo: string): string {
    return `You are an expert Perfetto trace analyst. Your job is to answer user questions by querying the trace database.

**CRITICAL RULES - READ CAREFULLY:**

1. SQL Execution Flow:
   - Generate ONLY ONE SQL query at a time
   - Wrap SQL in \`\`\`sql ... \`\`\` code blocks
   - Wait for results before generating another query
   - Each query will be executed and results sent back to you

2. When you get SQL results:
   - Analyze the data
   - If you need MORE information, run ONE more SQL query
   - If you have ENOUGH information, provide your final answer

3. Error Handling:
   - If SQL has syntax error, FIX IT and try again
   - If query returns 0 rows, ADJUST your approach

4. Final Answer:
   - When you have enough data, provide a COMPLETE answer
   - Include specific numbers, timestamps, percentages
   - Be thorough but concise

${schemaInfo}

**Important Schema Notes:**
- thread table uses "upid" (not "pid") to reference process
- Timestamps are in NANOSECONDS (divide by 1_000_000_000 for seconds)
- Durations are also in NANOSECONDS

**Common Analysis Patterns:**
- Startup: Look for process.start_ts, then slice table for activity
- CPU: Check sched table for thread states, counter table for frequency
- Memory: Check counter table for memory stats
- ANR: Check instant table for "android_anr" events
`;
  }

  // ============================================================================
  // Step Management
  // ============================================================================

  private addStep(analysisId: string, step: AnalysisStep): void {
    const analysis = this.analyses.get(analysisId);
    if (analysis) {
      analysis.steps.push(step);
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clean up old analyses
   */
  public cleanup(maxAge = 60 * 60 * 1000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, analysis] of this.analyses) {
      if (
        analysis.status === 'completed' &&
        analysis.endTime &&
        now - analysis.endTime > maxAge
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.analyses.delete(id);
    }
  }
}
