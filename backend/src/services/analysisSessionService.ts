/**
 * Analysis Session Service
 *
 * Manages user sessions for trace analysis with conversation history
 * and state tracking for the AI analysis loop.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  AnalysisSession,
  AnalysisState,
  AnalysisMessage,
  CollectedResult,
  CreateAnalysisRequest,
  SessionStatusResponse,
  AnalysisResult,
  AnalysisSSEEvent,
  ProgressEvent,
} from '../types/analysis';

/**
 * Service for managing analysis sessions
 */
export class AnalysisSessionService extends EventEmitter {
  private sessions: Map<string, AnalysisSession> = new Map();
  private sessionTimeout: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(sessionTimeout = 60 * 60 * 1000) { // Default 1 hour
    super();
    this.sessionTimeout = sessionTimeout;
    this.startCleanup();
  }

  /**
   * Create a new analysis session
   */
  public createSession(request: CreateAnalysisRequest): string {
    const sessionId = `session-${Date.now()}-${uuidv4().substr(0, 8)}`;

    const session: AnalysisSession = {
      id: sessionId,
      traceId: request.traceId,
      userId: request.userId,
      status: AnalysisState.IDLE,
      question: request.question,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [
        {
          role: 'user',
          content: request.question,
          timestamp: new Date(),
        },
      ],
      currentIteration: 0,
      maxIterations: request.maxIterations || 10,
      collectedResults: [],
      stepsCompleted: 0,
    };

    this.sessions.set(sessionId, session);

    // Emit creation event
    this.emit('session-created', session);

    return sessionId;
  }

  /**
   * Get a session by ID
   */
  public getSession(sessionId: string): AnalysisSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update session state
   */
  public updateState(
    sessionId: string,
    status: AnalysisState,
    data?: Partial<AnalysisSession>
  ): AnalysisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.status = status;
    session.updatedAt = new Date();

    if (data) {
      Object.assign(session, data);
    }

    // Emit state change
    this.emit('session-state-changed', session);

    return session;
  }

  /**
   * Add a message to the conversation history
   */
  public addMessage(
    sessionId: string,
    message: Omit<AnalysisMessage, 'timestamp'>
  ): AnalysisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const fullMessage: AnalysisMessage = {
      ...message,
      timestamp: new Date(),
    };

    session.messages.push(fullMessage);
    session.updatedAt = new Date();

    this.emit('message-added', { sessionId, message: fullMessage });

    return session;
  }

  /**
   * Add a collected SQL result
   */
  public addCollectedResult(
    sessionId: string,
    result: CollectedResult
  ): AnalysisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.collectedResults.push(result);
    session.updatedAt = new Date();

    return session;
  }

  /**
   * Increment iteration counter
   */
  public incrementIteration(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    session.currentIteration++;
    session.updatedAt = new Date();

    return session.currentIteration;
  }

  /**
   * Increment steps completed counter
   */
  public incrementSteps(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    session.stepsCompleted++;
    session.updatedAt = new Date();

    return session.stepsCompleted;
  }

  /**
   * Complete a session with final answer
   */
  public completeSession(
    sessionId: string,
    finalAnswer: string
  ): AnalysisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.status = AnalysisState.COMPLETED;
    session.finalAnswer = finalAnswer;
    session.updatedAt = new Date();

    // Add final answer as assistant message
    session.messages.push({
      role: 'assistant',
      content: finalAnswer,
      timestamp: new Date(),
    });

    this.emit('session-completed', session);

    return session;
  }

  /**
   * Mark a session as failed
   */
  public failSession(
    sessionId: string,
    error: string
  ): AnalysisSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.status = AnalysisState.FAILED;
    session.error = error;
    session.updatedAt = new Date();

    this.emit('session-failed', session);

    return session;
  }

  /**
   * Delete a session
   */
  public deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    this.emit('session-deleted', { sessionId, session });

    return true;
  }

  /**
   * Get session status for API response
   */
  public getSessionStatus(sessionId: string): SessionStatusResponse | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      sessionId: session.id,
      traceId: session.traceId,
      status: session.status,
      currentIteration: session.currentIteration,
      maxIterations: session.maxIterations,
      currentStep: this.getCurrentStepLabel(session.status),
      progress: {
        current: session.stepsCompleted,
        total: session.totalSteps,
      },
      messages: session.messages,
      finalAnswer: session.finalAnswer,
      error: session.error,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  /**
   * Get conversation history formatted for AI
   */
  public getConversationHistory(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';

    return session.messages
      .map((msg) => {
        let text = `[${msg.role.toUpperCase()}] ${msg.content}`;
        if (msg.sql) {
          text += `\nSQL: ${msg.sql}`;
        }
        if (msg.queryResult) {
          text += `\nResult: ${msg.queryResult.rowCount} rows`;
        }
        return text;
      })
      .join('\n\n');
  }

  /**
   * Get conversation history as message array for AI API
   */
  public getMessagesForAI(sessionId: string): Array<{ role: string; content: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return session.messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
  }

  /**
   * Get analysis result for completed sessions
   */
  public getAnalysisResult(sessionId: string): AnalysisResult | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== AnalysisState.COMPLETED) {
      return undefined;
    }

    const startTime = session.createdAt.getTime();
    const endTime = session.updatedAt.getTime();

    return {
      sessionId: session.id,
      answer: session.finalAnswer || '',
      sqlQueries: session.collectedResults.map((cr) => ({
        sql: cr.sql,
        result: cr.result,
        insight: cr.insight,
      })),
      steps: session.messages
        .filter((m) => m.stepNumber)
        .map((m) => ({
          stepNumber: m.stepNumber!,
          type: m.role === 'user' ? 'input' : 'processing',
          content: m.content,
          timestamp: m.timestamp.getTime(),
        })),
      metrics: {
        totalDuration: endTime - startTime,
        iterationsCount: session.currentIteration,
        sqlQueriesCount: session.collectedResults.length,
      },
    };
  }

  /**
   * Emit SSE event to listeners
   */
  public emitSSE(sessionId: string, event: AnalysisSSEEvent): void {
    this.emit(`sse-${sessionId}`, event);
  }

  /**
   * Subscribe to SSE events for a session
   */
  public subscribeToSSE(
    sessionId: string,
    callback: (event: AnalysisSSEEvent) => void
  ): () => void {
    const eventName = `sse-${sessionId}`;
    this.on(eventName, callback);

    // Return unsubscribe function
    return () => {
      this.off(eventName, callback);
    };
  }

  /**
   * Emit progress update
   */
  public emitProgress(
    sessionId: string,
    current: number,
    total: number | undefined,
    message: string
  ): void {
    const event: ProgressEvent = {
      type: 'progress',
      timestamp: Date.now(),
      data: { current, total, message },
    };
    this.emitSSE(sessionId, event);
  }

  /**
   * Get all sessions for a user
   */
  public getUserSessions(userId: string): AnalysisSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId
    );
  }

  /**
   * Get all sessions for a trace
   */
  public getTraceSessions(traceId: string): AnalysisSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.traceId === traceId
    );
  }

  /**
   * Get all active (non-completed/failed) sessions
   */
  public getActiveSessions(): AnalysisSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status !== AnalysisState.COMPLETED && s.status !== AnalysisState.FAILED
    );
  }

  /**
   * Get all sessions (internal access)
   */
  public getAllSessions(): AnalysisSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions map (for internal access)
   */
  public getSessionsMap(): Map<string, AnalysisSession> {
    return this.sessions;
  }

  /**
   * Clean up expired sessions
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      for (const [id, session] of this.sessions) {
        // Clean up completed/failed sessions older than timeout
        // Or idle sessions older than timeout
        const sessionAge = now - session.updatedAt.getTime();
        if (
          (session.status === AnalysisState.COMPLETED ||
            session.status === AnalysisState.FAILED) &&
          sessionAge > this.sessionTimeout
        ) {
          toDelete.push(id);
        }
      }

      for (const id of toDelete) {
        this.deleteSession(id);
      }

      if (toDelete.length > 0) {
        console.log(`[AnalysisSessionService] Cleaned up ${toDelete.length} expired sessions`);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Get human-readable step label
   */
  private getCurrentStepLabel(state: AnalysisState): string {
    switch (state) {
      case AnalysisState.IDLE:
        return 'Waiting to start';
      case AnalysisState.GENERATING_SQL:
        return 'Generating SQL query...';
      case AnalysisState.EXECUTING_SQL:
        return 'Executing SQL query...';
      case AnalysisState.VALIDATING_RESULT:
        return 'Analyzing results...';
      case AnalysisState.RETRYING:
        return 'Adjusting approach...';
      case AnalysisState.COMPLETED:
        return 'Analysis complete';
      case AnalysisState.FAILED:
        return 'Analysis failed';
      default:
        return 'Unknown state';
    }
  }

  /**
   * Destroy the service and cleanup resources
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
    this.removeAllListeners();
  }
}

// Singleton instance
let sessionServiceInstance: AnalysisSessionService | null = null;

export function getSessionService(): AnalysisSessionService {
  if (!sessionServiceInstance) {
    sessionServiceInstance = new AnalysisSessionService();
  }
  return sessionServiceInstance;
}

export default AnalysisSessionService;
