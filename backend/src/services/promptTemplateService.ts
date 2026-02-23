/**
 * Prompt Template Service
 *
 * Centralized management of AI prompt templates for trace analysis.
 * Provides unified interface for retrieving and formatting prompts.
 */

import { PROMPTS } from '../config/prompts';

// ============================================================================
// Types
// ============================================================================

/**
 * Interface defining a prompt template
 */
export interface PromptTemplate {
  name: string;
  system: string;
  user: string;
  temperature?: number;
}

/**
 * Template variables for formatting prompts
 */
export interface TemplateVariables {
  schema?: string;
  question?: string;
  sql?: string;
  error?: string;
  explanation?: string;
  examples?: string;
  [key: string]: string | number | boolean | undefined;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Singleton service for managing prompt templates
 */
class PromptTemplateService {
  private static instance: PromptTemplateService;
  private templates: Map<string, PromptTemplate>;

  private constructor() {
    this.templates = new Map();
    this.initializeDefaultTemplates();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): PromptTemplateService {
    if (!PromptTemplateService.instance) {
      PromptTemplateService.instance = new PromptTemplateService();
    }
    return PromptTemplateService.instance;
  }

  /**
   * Initialize default prompt templates
   */
  private initializeDefaultTemplates(): void {
    // SQL Generation Template (using centralized prompts)
    this.addTemplate({
      name: 'sql-generation',
      system: `You are a Perfetto SQL expert. Generate accurate SQL queries to analyze trace data.

IMPORTANT RULES:
1. ONLY use tables listed in the schema below
2. All timestamps are in NANOSECONDS - convert to ms with /1e6 or seconds with /1e9
3. Use proper JOIN conditions with foreign keys (track_id, utid, upid)
4. Use thread_track for thread tracks, not track directly

${PROMPTS.SQL_GENERATION.withSchema}

{schema}

Example queries:
{examples}

Respond with ONLY one SQL query wrapped in \`\`\`sql ... \`\`\` code blocks. Do not include any explanation or additional text.`,
      user: '{question}',
      temperature: 0.3,
    });

    // SQL Fix Template (using centralized prompts)
    this.addTemplate({
      name: 'sql-fix',
      system: `You are a Perfetto SQL expert. Your task is to fix SQL queries that failed to execute.

[SQL EXECUTION ERROR]

${PROMPTS.ERROR_FIX.syntax}

Please FIX the SQL query and try again. Common issues:
- Wrong column names (check schema)
- Wrong table names (check schema)
- Syntax errors
- Type mismatches

Generate ONE corrected SQL query wrapped in \`\`\`sql ... \`\`\` code blocks. Do not include any explanation or additional text.`,
      user: '',
      temperature: 0.2,
    });

    // SQL Adjust Template (using centralized prompts)
    this.addTemplate({
      name: 'sql-adjust',
      system: `You are a Perfetto SQL expert. Your task is to adjust SQL queries that returned no results.

[QUERY RESULT - 0 ROWS]

${PROMPTS.ERROR_FIX.noResults}

This means:
- Your WHERE conditions are too restrictive
- The data doesn't exist in this trace
- You're looking in the wrong place

Please ADJUST your approach and try a different query.

Respond with ONLY one SQL query wrapped in \`\`\`sql ... \`\`\` code blocks. Do not include any explanation or additional text.`,
      user: '',
      temperature: 0.4,
    });

    // Analysis Summary Template (using centralized prompts)
    this.addTemplate({
      name: 'analysis-summary',
      system: `You are a Perfetto trace analysis expert. Provide a clear, comprehensive answer to the user based on the query results.

${PROMPTS.ANALYSIS_SUMMARY.detailed}

{schema}

Required output structure:
1) Executive Summary
2) Findings (each item: symptom, evidence, impact)
3) Action Items (owner, priority: P0/P1/P2, concrete action, verification steps)
4) Missing Data (what is missing + how to collect it)
5) Uncertainty (assumptions and confidence)

Rules:
- Do not make claims without evidence.
- For every finding, cite evidence as table[field]=value.
- If evidence is missing, say "unable_to_determine" and add it to Missing Data.`,
      user: `User Question: "{question}"

{context}

Provide a final answer that directly addresses the user's question. Include specific numbers and data points when relevant.`,
      temperature: 0.2,
    });

    // Trace Analysis System Prompt (for traceAnalysisSkill)
    this.addTemplate({
      name: 'trace-analysis-system',
      system: `You are an expert Perfetto trace analyst. Your job is to answer user questions by querying the trace database.

**CRITICAL RULES - READ CAREFULLY:**

1. SQL Execution Flow:
   - Generate ONLY ONE SQL query at a time
   - When you need to run SQL, respond with ONLY one \`\`\`sql ... \`\`\` code block (no explanation)
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
   - Every key claim must include evidence in the form table[field]=value
   - If evidence is insufficient, explicitly output "unable_to_determine"

{schema}

**Important Schema Notes:**
- thread table uses "upid" (not "pid") to reference process
- Timestamps are in NANOSECONDS (divide by 1_000_000_000 for seconds)
- Durations are also in NANOSECONDS

**Common Analysis Patterns:**
- Startup: Look for process.start_ts, then slice table for activity
- CPU: Check sched table for thread states, counter table for frequency
- GPU/Render: Check gpu_counter_track, frame timeline, and RenderThread slices
- Frame/Jank: Check actual_frame_timeline_slice and expected frame pacing
- Binder contention: Check android_binder_txns and blocking thread states
- GC/Memory pressure: Check heap counters, LMK/low-memory signals, GC events
- Thermal/Power: Check frequency drops, thermal counters, throttling indicators
- Memory: Check counter table for memory stats
- ANR: Check instant table for "android_anr" events

Final response format:
1) Summary
2) Findings with evidence
3) Action items (owner/priority/verification)
4) Missing data
5) Uncertainty`,
      user: '{question}',
      temperature: 0.2,
    });
  }

  /**
   * Get a template by name
   */
  public getTemplate(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Get all template names
   */
  public getTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * Add a new template or update existing one
   */
  public addTemplate(template: PromptTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Format a template with variables
   */
  public formatTemplate(name: string, variables: TemplateVariables): string {
    const template = this.getTemplate(name);

    if (!template) {
      throw new Error(`Template "${name}" not found`);
    }

    // Combine system and user templates
    let formatted = template.system;

    // Replace variables in both system and user parts
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      formatted = formatted.replace(new RegExp(placeholder, 'g'), String(value));
    }

    // Add user message if it exists and isn't empty
    if (template.user && template.user.trim() !== '') {
      let userPart = template.user;
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = `{${key}}`;
        userPart = userPart.replace(new RegExp(placeholder, 'g'), String(value));
      }
      formatted += '\n\n' + userPart;
    }

    return formatted;
  }

  /**
   * Get temperature for a template
   */
  public getTemperature(name: string): number {
    const template = this.getTemplate(name);
    return template?.temperature ?? 0.3;
  }

  /**
   * Check if a template exists
   */
  public hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * Remove a template
   */
  public removeTemplate(name: string): boolean {
    return this.templates.delete(name);
  }
}

// ============================================================================
// Exports
// ============================================================================

export default PromptTemplateService;
export { PromptTemplateService };
