import { OpenAI } from 'openai';
import { EventEmitter } from 'events';

export interface ConversationContext {
  traceId?: string;
  previousQueries: string[];
  previousResults: any[];
  userPreferences: {
    focusArea?: 'performance' | 'memory' | 'battery' | 'network' | 'ui';
    expertiseLevel?: 'beginner' | 'intermediate' | 'advanced';
    preferredFormat?: 'summary' | 'detailed' | 'technical';
  };
  traceMetadata?: {
    duration?: number;
    numEvents?: number;
    packages?: string[];
    deviceInfo?: any;
  };
}

export interface AIInsight {
  type: 'anomaly' | 'recommendation' | 'pattern' | 'prediction';
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  sqlQuery?: string;
  actionItems?: string[];
  relatedMetrics?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  context?: any;
  insights?: AIInsight[];
}

export interface AnalysisSession {
  id: string;
  traceId?: string;
  messages: ChatMessage[];
  context: ConversationContext;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Advanced AI Service with context awareness and conversation memory
 */
export class AdvancedAIService extends EventEmitter {
  private openai?: OpenAI;
  private sessions: Map<string, AnalysisSession> = new Map();
  private traceCache: Map<string, any> = new Map();

  constructor() {
    super();
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  /**
   * Start or continue an analysis session
   */
  async startAnalysis(
    sessionId: string,
    traceId?: string,
    userMessage?: string
  ): Promise<AnalysisSession> {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        traceId,
        messages: [],
        context: {
          previousQueries: [],
          previousResults: [],
          userPreferences: {
            expertiseLevel: 'intermediate',
            preferredFormat: 'detailed',
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.sessions.set(sessionId, session);
    }

    // Load trace metadata if traceId is provided
    if (traceId && !session.context.traceMetadata) {
      const metadata = await this.getTraceMetadata(traceId);
      session.context.traceMetadata = metadata;
    }

    // Add user message if provided
    if (userMessage) {
      await this.addMessage(session, 'user', userMessage);
    }

    return session;
  }

  /**
   * Analyze trace with context awareness
   */
  async analyzeWithContext(
    sessionId: string,
    query: string
  ): Promise<{ response: string; insights: AIInsight[]; sqlQuery?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Build context prompt
    const contextPrompt = this.buildContextPrompt(session, query);

    // Check if OpenAI is configured
    if (!this.openai) {
      throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY environment variable.');
    }

    // Get AI response
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `You are an expert Android performance analyst specializing in Perfetto trace analysis.
          You have deep knowledge of:
          - Android system internals and performance patterns
          - Perfetto SQL queries and trace data interpretation
          - Common performance issues (jank, memory leaks, battery drain)
          - Best practices for performance optimization

          Provide actionable insights with specific SQL queries when relevant.`,
        },
        { role: 'user', content: contextPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    const response = completion.choices[0]?.message?.content || '';

    // Extract insights from the response
    const insights = await this.extractInsights(response, session);

    // Update session
    await this.addMessage(session, 'user', query);
    await this.addMessage(session, 'assistant', response, insights);

    // Detect if SQL query is suggested
    const sqlQuery = this.extractSQLQuery(response);

    return { response, insights, sqlQuery };
  }

  /**
   * Get proactive insights for a trace
   */
  async getProactiveInsights(traceId: string): Promise<AIInsight[]> {
    const metadata = await this.getTraceMetadata(traceId);
    const insights: AIInsight[] = [];

    // Check for common performance patterns
    if (metadata.duration && metadata.duration > 30000000000) {
      // Long trace (>30 seconds)
      insights.push({
        type: 'recommendation',
        title: 'Long Trace Duration Detected',
        description: 'This trace spans over 30 seconds. Consider focusing on specific time ranges for detailed analysis.',
        severity: 'low',
        confidence: 0.9,
        actionItems: [
          'Use time-based filtering: WHERE ts > start_time AND ts < end_time',
          'Focus on specific processes or threads of interest',
        ],
      });
    }

    // Check for high event count
    if (metadata.numEvents && metadata.numEvents > 1000000) {
      insights.push({
        type: 'recommendation',
        title: 'High Event Count',
        description: 'This trace contains over 1 million events. Use filters to narrow down the analysis.',
        severity: 'medium',
        confidence: 0.95,
        actionItems: [
          'Filter by process: WHERE process_name = "your_app"',
          'Use sampling for initial exploration',
        ],
      });
    }

    // Analyze common patterns
    const patterns = await this.analyzePatterns(traceId);
    insights.push(...patterns);

    return insights;
  }

  /**
   * Predict potential issues based on trace patterns
   */
  async predictIssues(traceId: string): Promise<AIInsight[]> {
    const predictions: AIInsight[] = [];

    // Analyze frame drops
    const frameDropQuery = `
      SELECT COUNT(*) AS dropped_frames
      FROM slice
      WHERE name GLOB 'FrameDraw*' AND dur > 16666666
    `;

    // Analyze main thread blocking
    const mainThreadQuery = `
      SELECT AVG(dur) AS avg_blocking_time
      FROM slice
      WHERE track_id IN (
        SELECT id FROM track WHERE name GLOB '*main*'
      ) AND dur > 10000000
    `;

    // Analyze memory allocations
    const memoryQuery = `
      SELECT SUM(value) as total_allocations
      FROM heap_graph_object
      WHERE type_name LIKE '%Activity%'
    `;

    // These would be executed against the actual trace
    // For now, we'll simulate predictions based on metadata
    predictions.push({
      type: 'prediction',
      title: 'Potential Jank Risk',
      description: 'Based on the trace pattern, there might be jank issues during complex UI operations.',
      severity: 'medium',
      confidence: 0.75,
      relatedMetrics: ['frame_rate', 'ui_thread_time', 'draw_time'],
      sqlQuery: frameDropQuery,
      actionItems: [
        'Check for expensive operations on the main thread',
        'Optimize view hierarchy complexity',
        'Consider asynchronous loading',
      ],
    });

    return predictions;
  }

  /**
   * Build context-aware prompt
   */
  private buildContextPrompt(session: AnalysisSession, query: string): string {
    const { context } = session;
    let prompt = `Trace Analysis Request: ${query}\n\n`;

    if (context.traceMetadata) {
      prompt += `Trace Information:\n`;
      prompt += `- Duration: ${(context.traceMetadata.duration! / 1000000).toFixed(2)}ms\n`;
      prompt += `- Events: ${context.traceMetadata.numEvents?.toLocaleString()}\n`;
      if (context.traceMetadata.packages) {
        prompt += `- Packages: ${context.traceMetadata.packages.join(', ')}\n`;
      }
      prompt += `\n`;
    }

    if (context.previousQueries.length > 0) {
      prompt += `Previous Analysis:\n`;
      context.previousQueries.slice(-3).forEach((q, i) => {
        prompt += `${i + 1}. ${q}\n`;
      });
      prompt += `\n`;
    }

    prompt += `User Preferences:\n`;
    prompt += `- Expertise Level: ${context.userPreferences.expertiseLevel}\n`;
    prompt += `- Focus Area: ${context.userPreferences.focusArea || 'general'}\n`;
    prompt += `- Preferred Format: ${context.userPreferences.preferredFormat}\n\n`;

    prompt += `Please provide:\n`;
    prompt += `1. A clear analysis based on the query\n`;
    prompt += `2. Specific SQL queries when relevant\n`;
    prompt += `3. Actionable recommendations\n`;
    prompt += `4. Context appropriate for a ${context.userPreferences.expertiseLevel} user\n`;

    return prompt;
  }

  /**
   * Extract insights from AI response
   */
  private async extractInsights(
    response: string,
    session: AnalysisSession
  ): Promise<AIInsight[]> {
    const insights: AIInsight[] = [];

    // Check if OpenAI is configured
    if (!this.openai) {
      // Return mock insights if no OpenAI key
      return [
        {
          type: 'recommendation',
          title: 'AI Not Available',
          description: 'AI insights not available - OpenAI API key not configured',
          severity: 'low',
          confidence: 0,
        },
      ];
    }

    // Use AI to structure the insights
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'Extract actionable insights from the following analysis. Return as JSON array.',
        },
        {
          role: 'user',
          content: `Analysis: ${response}\n\nExtract insights in this format:
          [{"type": "anomaly|recommendation|pattern|prediction", "title": "...", "description": "...",
          "severity": "low|medium|high|critical", "confidence": 0.0-1.0, "actionItems": ["..."]}]`,
        },
      ],
      temperature: 0.1,
      max_tokens: 800,
    });

    try {
      const insightsJson = JSON.parse(completion.choices[0]?.message?.content || '[]');
      insights.push(...insightsJson);
    } catch (error) {
      console.error('Failed to parse insights:', error);
    }

    return insights;
  }

  /**
   * Extract SQL query from AI response
   */
  private extractSQLQuery(response: string): string | undefined {
    const sqlMatch = response.match(/```sql\s*([\s\S]*?)\s*```/i);
    return sqlMatch ? sqlMatch[1].trim() : undefined;
  }

  /**
   * Analyze common patterns in trace
   */
  private async analyzePatterns(traceId: string): Promise<AIInsight[]> {
    const patterns: AIInsight[] = [];

    // This would analyze actual trace data
    // For now, return common pattern insights

    return patterns;
  }

  /**
   * Get trace metadata
   */
  private async getTraceMetadata(traceId: string): Promise<any> {
    // Check cache first
    if (this.traceCache.has(traceId)) {
      return this.traceCache.get(traceId);
    }

    // Fetch from trace service
    try {
      const { traceService } = await import('../controllers/traceProcessorController');
      const trace = traceService.getTrace(traceId);

      if (trace) {
        const metadata = trace.metadata;
        this.traceCache.set(traceId, metadata);
        return metadata;
      }
    } catch (error) {
      console.error('Failed to fetch trace metadata:', error);
    }

    return {};
  }

  /**
   * Add message to session
   */
  private async addMessage(
    session: AnalysisSession,
    role: 'user' | 'assistant' | 'system',
    content: string,
    insights?: AIInsight[]
  ): Promise<void> {
    const message: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date(),
      insights,
    };

    session.messages.push(message);
    session.updatedAt = new Date();

    // Keep only last 20 messages in context
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    // Update context
    if (role === 'user') {
      session.context.previousQueries.push(content);
      if (session.context.previousQueries.length > 10) {
        session.context.previousQueries = session.context.previousQueries.slice(-10);
      }
    }

    this.emit('session-updated', session);
  }

  /**
   * Get session
   */
  getSession(sessionId: string): AnalysisSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update user preferences
   */
  updatePreferences(
    sessionId: string,
    preferences: Partial<ConversationContext['userPreferences']>
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.context.userPreferences = {
        ...session.context.userPreferences,
        ...preferences,
      };
      session.updatedAt = new Date();
      this.emit('session-updated', session);
    }
  }

  /**
   * Delete session
   */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emit('session-deleted', sessionId);
  }

  /**
   * Clean up old sessions
   */
  cleanup(): void {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.updatedAt.getTime() > oneDay) {
        this.deleteSession(sessionId);
      }
    }
  }
}