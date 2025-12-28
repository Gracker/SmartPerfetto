/**
 * Session Persistence Service
 * Handles long-term storage of analysis sessions using SQLite
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  StoredSession,
  StoredMessage,
  SessionFilter,
  SessionListResponse,
} from '../models/sessionSchema';

const DB_DIR = path.join(process.cwd(), 'data', 'sessions');
const DB_PATH = path.join(DB_DIR, 'sessions.db');

export class SessionPersistenceService {
  private db: Database.Database;
  private static instance: SessionPersistenceService;

  private constructor() {
    // Ensure data directory exists
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  static getInstance(): SessionPersistenceService {
    if (!SessionPersistenceService.instance) {
      SessionPersistenceService.instance = new SessionPersistenceService();
    }
    return SessionPersistenceService.instance;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        trace_name TEXT,
        question TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trace_id ON sessions(trace_id);
      CREATE INDEX IF NOT EXISTS idx_created_at ON sessions(created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        sql_result TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
    `);
  }

  /**
   * Save a complete session to the database
   */
  saveSession(session: StoredSession): boolean {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (id, trace_id, trace_name, question, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const metadataJson = session.metadata ? JSON.stringify(session.metadata) : null;

    const insertSession = this.db.transaction(() => {
      stmt.run(
        session.id,
        session.traceId,
        session.traceName,
        session.question,
        session.createdAt,
        session.updatedAt,
        metadataJson
      );

      // Delete existing messages for this session
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(session.id);

      // Insert messages
      const msgStmt = this.db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp, sql_result)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const msg of session.messages) {
        const sqlResultJson = msg.sqlResult ? JSON.stringify(msg.sqlResult) : null;
        msgStmt.run(msg.id, session.id, msg.role, msg.content, msg.timestamp, sqlResultJson);
      }
    });

    try {
      insertSession();
      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save session:', error);
      return false;
    }
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): StoredSession | null {
    const sessionRow = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId) as any;

    if (!sessionRow) return null;

    const messages = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId) as any[];

    return {
      id: sessionRow.id,
      traceId: sessionRow.trace_id,
      traceName: sessionRow.trace_name,
      question: sessionRow.question,
      createdAt: sessionRow.created_at,
      updatedAt: sessionRow.updated_at,
      metadata: sessionRow.metadata ? JSON.parse(sessionRow.metadata) : undefined,
      messages: messages.map((msg: any) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        sqlResult: msg.sql_result ? JSON.parse(msg.sql_result) : undefined,
      })),
    };
  }

  /**
   * List sessions with optional filtering
   */
  listSessions(filter: SessionFilter = {}): SessionListResponse {
    let query = 'SELECT * FROM sessions WHERE 1=1';
    const params: any[] = [];

    if (filter.traceId) {
      query += ' AND trace_id = ?';
      params.push(filter.traceId);
    }
    if (filter.startDate) {
      query += ' AND created_at >= ?';
      params.push(filter.startDate);
    }
    if (filter.endDate) {
      query += ' AND created_at <= ?';
      params.push(filter.endDate);
    }

    // Get total count
    const countQuery = query.replace('*', 'COUNT(*) as count');
    const countResult = this.db.prepare(countQuery).get(...params) as { count: number };
    const totalCount = countResult.count;

    // Add pagination
    query += ' ORDER BY created_at DESC';
    if (filter.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter.offset) {
      query += ' OFFSET ?';
      params.push(filter.offset);
    }

    const sessions = this.db.prepare(query).all(...params) as any[];

    return {
      sessions: sessions.map(row => ({
        id: row.id,
        traceId: row.trace_id,
        traceName: row.trace_name,
        question: row.question,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        messages: [], // Exclude messages from list view
      })),
      totalCount,
      hasMore: (filter.offset || 0) + sessions.length < totalCount,
    };
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    try {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to delete session:', error);
      return false;
    }
  }

  /**
   * Get all sessions for a specific trace
   */
  getSessionsByTrace(traceId: string): StoredSession[] {
    const rows = this.db.prepare(`
      SELECT id FROM sessions WHERE trace_id = ? ORDER BY created_at DESC
    `).all(traceId) as any[];

    return rows
      .map(row => this.getSession(row.id))
      .filter((s): s is StoredSession => s !== null);
  }

  /**
   * Export sessions as JSON for backup
   */
  exportSessions(traceId?: string): string {
    const sessions = traceId
      ? this.getSessionsByTrace(traceId)
      : this.listSessions({ limit: 1000 }).sessions;

    return JSON.stringify({
      exportedAt: Date.now(),
      count: sessions.length,
      sessions: sessions.map(s => ({
        ...s,
        messages: this.getSession(s.id)?.messages || [],
      })),
    }, null, 2);
  }

  /**
   * Clean up old sessions (older than specified days)
   */
  cleanupOldSessions(daysToKeep: number = 30): number {
    const cutoffDate = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const result = this.db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoffDate);
    return result.changes;
  }
}

export default SessionPersistenceService;
