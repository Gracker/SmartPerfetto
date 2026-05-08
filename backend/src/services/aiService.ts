// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs/promises';
import { PERFETTO_TABLES_SCHEMA, PERFETTO_SQL_EXAMPLES } from '../data/perfettoSchema';
import SQLValidator from './sqlValidator';
import { redactTextForLLM } from '../utils/llmPrivacy';

interface GenerateSqlRequest {
  query: string;
  context?: string;
}

interface GenerateSqlResponse {
  sql: string;
  explanation: string;
  examples: string[];
}

interface TraceAnalysisRequest {
  file: Express.Multer.File;
  query?: string;
  analysisType?: 'performance' | 'memory' | 'cpu' | 'gpu' | 'custom';
}

interface TraceAnalysisResponse {
  insights: string[];
  sqlQueries: string[];
  recommendations: string[];
  metrics: {
    duration: number;
    memoryPeak: number;
    cpuUsage: number;
    frameDrops: number;
  };
}

interface ErrorResponse {
  error: string;
  details?: string;
}

type AIServiceProvider = 'openai' | 'claude' | 'deepseek';

function resolveAIServiceProvider(): AIServiceProvider | undefined {
  const configured = process.env.SMARTPERFETTO_LLM_PROVIDER;
  if (configured === 'openai' || configured === 'claude' || configured === 'deepseek') {
    return configured;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  return undefined;
}

class AIService {
  private openai?: OpenAI;
  private claudeUrl?: string;
  private deepseek?: OpenAI;
  private provider?: AIServiceProvider;
  private sqlValidator: SQLValidator;

  constructor() {
    this.provider = resolveAIServiceProvider();
    this.sqlValidator = new SQLValidator();

    if (this.provider === 'openai' && process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    } else if (this.provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
      this.claudeUrl = 'https://api.anthropic.com/v1/messages';
    } else if (this.provider === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
      const deepseekBaseURL = String(
        process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
      ).replace(/\/+$/, '');
      this.deepseek = new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: deepseekBaseURL,
      });
    }
  }

  private buildSqlSystemPrompt(): string {
    return `You are a Perfetto SQL expert. Generate accurate Perfetto SQL queries based on user requirements.

IMPORTANT RULES:
1. ONLY use tables listed in the schema below
2. All timestamps are in NANOSECONDS - convert to ms with /1e6 or seconds with /1e9
3. Use proper JOIN conditions with foreign keys (track_id, utid, upid)
4. Use thread_track for thread tracks, not track directly
5. For filtering, consider using TABLE_WITH_FILTER() for better performance

${PERFETTO_TABLES_SCHEMA}

Example queries:
${JSON.stringify(PERFETTO_SQL_EXAMPLES, null, 2)}

Remember: Use only the tables and columns listed in the schema. Never invent tables or columns.`;
  }

  private buildDefaultChatSystemPrompt(): string {
    return `You are an Android performance analyst.
Provide concise, evidence-driven explanations and practical next steps.
If data is missing, say what is needed.`;
  }

  private async callOpenAI(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI not configured');
    }

    const safeSystem = redactTextForLLM(systemPrompt || this.buildSqlSystemPrompt()).text;
    const safePrompt = redactTextForLLM(prompt).text;
    const completion = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4',
      messages: [
        {
          role: 'system',
          content: safeSystem,
        },
        {
          role: 'user',
          content: safePrompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    return completion.choices[0].message.content || '';
  }

  private async callClaude(
    prompt: string,
    systemPrompt?: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Claude not configured');
    }
    if (!this.claudeUrl) {
      throw new Error('Claude not configured');
    }

    const systemContent = redactTextForLLM(systemPrompt || this.buildSqlSystemPrompt()).text;
    const safePrompt = redactTextForLLM(prompt).text;
    const response = await axios.post(
      this.claudeUrl,
      {
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? 0.3,
        system: systemContent,
        messages: [
          {
            role: 'user',
            content: safePrompt,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    return response.data.content[0].text;
  }

  private async callDeepseek(
    prompt: string,
    systemPrompt?: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    if (!this.deepseek) {
      throw new Error('Deepseek not configured');
    }

    const safeSystem = redactTextForLLM(systemPrompt || this.buildSqlSystemPrompt()).text;
    const safePrompt = redactTextForLLM(prompt).text;
    const completion = await this.deepseek.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-reasoner',
      messages: [
        {
          role: 'system',
          content: safeSystem,
        },
        {
          role: 'user',
          content: safePrompt,
        },
      ],
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 2000,
    });

    return completion.choices[0].message.content || '';
  }

  async chat(prompt: string, options?: { systemPrompt?: string }): Promise<string> {
    if (!this.openai && !process.env.ANTHROPIC_API_KEY && !this.deepseek) {
      return '';
    }

    const systemPrompt = options?.systemPrompt || this.buildDefaultChatSystemPrompt();

    if (this.provider === 'claude') {
      return await this.callClaude(prompt, systemPrompt);
    }
    if (this.provider === 'deepseek') {
      return await this.callDeepseek(prompt, systemPrompt);
    }
    return await this.callOpenAI(prompt, systemPrompt);
  }

  async generatePerfettoSQL(request: GenerateSqlRequest): Promise<GenerateSqlResponse> {
    // Check if AI service is configured
    if (!this.openai && !process.env.ANTHROPIC_API_KEY && !this.deepseek) {
      // Return mock response when no AI service is configured
      return this.generateMockSQL(request.query);
    }

    const systemPrompt = this.buildSqlSystemPrompt();
    const safeSystemPrompt = redactTextForLLM(systemPrompt).text;

    let prompt = `User request: "${request.query}"`;
    if (request.context) {
      prompt += `\n\nAdditional context:\n${request.context}`;
    }

    // Deterministic contract: structured JSON only (machine-parseable).
    prompt += `

Return ONLY a valid JSON object (no markdown, no code fences) with this schema:
{
  "sql": "ONE Perfetto SQL query string",
  "explanation": "What the query does (concise)",
  "notes": ["Important notes (0-3 items)"]
}

Rules:
- "sql" must be executable as-is (no placeholders like <...>).
- Use ONLY tables/columns in the provided schema; never invent names.
- Timestamps are in nanoseconds (ns). Convert to ms with /1e6 when presenting time.
- If the request cannot be answered with the available schema/data, still return JSON and explain the missing data in "notes".`;

    let response: string;

    if (this.provider === 'claude') {
      response = await this.callClaude(prompt, safeSystemPrompt, { temperature: 0 });
    } else if (this.provider === 'deepseek') {
      response = await this.callDeepseek(prompt, safeSystemPrompt, { temperature: 0 });
    } else {
      const safePrompt = redactTextForLLM(prompt).text;
      // OpenAI: enable JSON mode if supported by the target model.
      const completion = await this.openai!.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        messages: [
          { role: 'system', content: safeSystemPrompt },
          { role: 'user', content: safePrompt },
        ],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      });
      response = completion.choices[0]?.message?.content || '';
    }

    // Parse JSON response (with one repair retry for robustness)
    const parsed = await this.parseOrRepairSqlJson(response, (repairPrompt) => {
      if (this.provider === 'claude') {
        return this.callClaude(repairPrompt, safeSystemPrompt, { temperature: 0 });
      }
      if (this.provider === 'deepseek') {
        return this.callDeepseek(repairPrompt, safeSystemPrompt, { temperature: 0 });
      }
      const safeRepairPrompt = redactTextForLLM(repairPrompt).text;
      // OpenAI JSON mode again
      return this.openai!.chat.completions
        .create({
          model: process.env.OPENAI_MODEL || 'gpt-4',
          messages: [
            { role: 'system', content: safeSystemPrompt },
            { role: 'user', content: safeRepairPrompt },
          ],
          temperature: 0,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        })
        .then((c) => c.choices[0]?.message?.content || '');
    });

    let sql = (parsed.sql || '').trim();
    sql = this.stripMarkdownCodeBlock(sql);
    const explanation = (parsed.explanation || 'Query generated successfully').trim();
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(Boolean).map(String) : [];

    // Validate the generated SQL
    const validation = this.sqlValidator.validateSQL(sql);

    if (!validation.isValid) {
      // If SQL is invalid, try to fix it
      sql = this.sqlValidator.suggestCorrection(sql);

      // Re-validate after correction
      const revalidation = this.sqlValidator.validateSQL(sql);
      if (!revalidation.isValid) {
        // Fall back to mock SQL
        console.warn('Generated SQL was invalid and could not be fixed:', validation.errors);
        return this.generateMockSQL(request.query);
      }
    }

    // Include validation warnings in the examples
    const examples = notes.length > 0 ? notes : [];
    if (validation.warnings.length > 0) {
      examples.push('⚠️ ' + validation.warnings.join('. '));
    }
    if (validation.suggestions.length > 0) {
      examples.push('💡 ' + validation.suggestions.join('. '));
    }

    return {
      sql,
      explanation,
      examples,
    };
  }

  private stripMarkdownCodeBlock(content: string): string {
    const trimmed = (content || '').trim();
    if (!trimmed.startsWith('```')) return trimmed;
    const match = trimmed.match(/```(?:sql|json)?\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : trimmed;
  }

  private extractJsonObjectFromText(content: string): string {
    const text = (content || '').trim();
    if (!text) return text;
    if (text.startsWith('{') && text.endsWith('}')) return text;

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return text.slice(first, last + 1);
    }
    return text;
  }

  private parseJsonObject<T>(content: string): T {
    let clean = (content || '').trim();
    clean = this.stripMarkdownCodeBlock(clean);
    clean = this.extractJsonObjectFromText(clean);
    return JSON.parse(clean) as T;
  }

  private async parseOrRepairSqlJson(
    raw: string,
    repairFn: (repairPrompt: string) => Promise<string>
  ): Promise<{ sql: string; explanation?: string; notes?: string[] }> {
    const tryParse = (text: string) => this.parseJsonObject<any>(text);

    try {
      const parsed = tryParse(raw);
      if (parsed && typeof parsed.sql === 'string') return parsed;
    } catch {
      // fallthrough to repair
    }

    const truncated = (raw || '').slice(0, 4000);
    const repairPrompt = `Your previous response was not a valid JSON object matching the required schema.

Convert it into STRICT JSON ONLY with this schema:
{
  "sql": "ONE Perfetto SQL query string",
  "explanation": "concise",
  "notes": ["0-3 items"]
}

Previous response (truncated):
${truncated}`;

    const repaired = await repairFn(repairPrompt);
    const parsed = tryParse(repaired);
    if (parsed && typeof parsed.sql === 'string') return parsed;

    // Last resort: return empty SQL to trigger validator fallback logic upstream.
    return { sql: '' };
  }

  async analyzeTrace(request: TraceAnalysisRequest): Promise<TraceAnalysisResponse> {
    // For now, return a mock response
    // In production, this would analyze the actual trace file
    return {
      insights: [
        'Main thread blocked for 234ms at timestamp 15.3s',
        'Memory usage peaked at 856MB during app startup',
        'Detected 12 GC events with average duration of 45ms',
        'Frame drops detected during list scrolling',
      ],
      sqlQueries: [
        `SELECT name, dur, ts
         FROM slice
         JOIN thread_track USING(track_id)
         JOIN thread USING(utid)
         WHERE thread.name = 'main'
           AND dur > 100000000  -- > 100ms
         ORDER BY dur DESC
         LIMIT 10;`,
        `SELECT *
         FROM heap_graph_object
         WHERE type_name LIKE 'Bitmap%'
         GROUP BY type_name
         HAVING COUNT(*) > 100;`,
      ],
      recommendations: [
        'Optimize main thread operations by moving heavy work to background threads',
        'Implement object pooling for frequently created objects',
        'Consider using image loading libraries with memory caching',
        'Implement view recycling for better scrolling performance',
      ],
      metrics: {
        duration: 1234567890,
        memoryPeak: 856 * 1024 * 1024,
        cpuUsage: 75,
        frameDrops: 23,
      },
    };
  }

  private generateMockSQL(query: string): GenerateSqlResponse {
    const lowerQuery = query.toLowerCase();

    // Simple pattern matching for common queries
    if (lowerQuery.includes('jank') || lowerQuery.includes('frame')) {
      return {
        sql: `SELECT
  process.name,
  thread.name,
  slice.name,
  COUNT(*) AS count,
  AVG(slice.dur) / 1e6 AS avg_duration_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 16666000  -- > 16.67ms (60fps threshold)
  AND slice.category LIKE '%gfx%'
GROUP BY process.name, thread.name, slice.name
ORDER BY avg_duration_ms DESC
LIMIT 100;`,
        explanation: 'This query finds jank frames by looking for slices longer than 16.67ms (60 FPS threshold) in graphics-related categories.',
        examples: ['You can adjust the threshold to 8.33ms for 120 FPS displays']
      };
    }

    if (lowerQuery.includes('anr') || lowerQuery.includes('application not responding')) {
      return {
        sql: `SELECT
  process.name AS process_name,
  thread.name AS thread_name,
  slice.ts / 1e9 AS start_time_s,
  slice.dur / 1e9 AS duration_s,
  slice.name AS slice_name
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 5e9  -- > 5 seconds
  AND process.name NOT LIKE 'com.android%'
ORDER BY slice.dur DESC
LIMIT 50;`,
        explanation: 'This query detects potential ANRs by finding long-running slices over 5 seconds, excluding system processes.',
        examples: ['Consider filtering by specific process names you want to investigate']
      };
    }

    if (lowerQuery.includes('memory') || lowerQuery.includes('heap')) {
      return {
        sql: `SELECT
  graph_sample.ts,
  heap_profile.size,
  heap_profile.object_type
FROM heap_profile
JOIN heap_graph_object ON heap_profile.graph_object_id = heap_graph_object.id
WHERE heap_profile.object_type LIKE 'Bitmap%'
  OR heap_profile.object_type LIKE 'Array%'
ORDER BY heap_profile.size DESC
LIMIT 100;`,
        explanation: 'This query shows memory allocations by object type, focusing on large objects like bitmaps and arrays.',
        examples: ['You can group by object_type to see total memory per type']
      };
    }

    if (lowerQuery.includes('启动') || lowerQuery.includes('startup') || lowerQuery.includes('launch')) {
      return {
        sql: `SELECT
  process.name AS app_name,
  slice.name AS startup_phase,
  slice.ts / 1e6 AS start_time_ms,
  slice.dur / 1e6 AS duration_ms,
  thread.name AS thread_name
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE (slice.name LIKE '%start%'
   OR slice.name LIKE '%launch%'
   OR slice.name LIKE '%init%'
   OR slice.name LIKE '%Application%'
   OR slice.name LIKE '%ActivityThread%')
   AND process.name NOT LIKE 'com.android%'
   AND slice.dur > 0
ORDER BY slice.ts ASC
LIMIT 100;`,
        explanation: 'This query analyzes the cold startup process by identifying startup-related events and their durations, showing the sequence of operations during app initialization.',
        examples: ['Filter by specific app name using WHERE process.name = "your.app.package"', 'Add time filters to focus on specific startup phases']
      };
    }

    // Default generic query
    return {
      sql: `SELECT
  slice.name,
  COUNT(*) AS count,
  AVG(slice.dur) / 1e6 AS avg_duration_ms,
  MAX(slice.dur) / 1e6 AS max_duration_ms
FROM slice
GROUP BY slice.name
HAVING COUNT(*) > 10
ORDER BY avg_duration_ms DESC
LIMIT 100;`,
      explanation: 'This is a general query showing the most frequently occurring slices with their average and maximum durations.',
      examples: ['Add WHERE clause to filter by specific time ranges or processes']
    };
  }
}

export default AIService;
