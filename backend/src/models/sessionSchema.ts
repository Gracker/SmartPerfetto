/**
 * Session Persistence Schema
 * Stores chat sessions and analysis results for long-term persistence
 */

export interface StoredSession {
  id: string;
  traceId: string;
  traceName: string;
  question: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  metadata?: SessionMetadata;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sqlResult?: SqlQueryResult;
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
}

export interface SessionMetadata {
  totalIterations?: number;
  sqlQueriesCount?: number;
  totalDuration?: number;
  traceSize?: number;
}

export interface SessionFilter {
  traceId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}

export interface SessionListResponse {
  sessions: StoredSession[];
  totalCount: number;
  hasMore: boolean;
}
