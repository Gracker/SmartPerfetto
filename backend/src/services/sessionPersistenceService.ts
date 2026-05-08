// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
  SessionMetadata,
} from '../models/sessionSchema';
import {
  EntityStore,
  EntityStoreSnapshot,
} from '../agent/context/entityStore';
import { EnhancedSessionContext } from '../agent/context/enhancedSessionContext';
import { FocusStore, FocusStoreSnapshot } from '../agent/context/focusStore';
import { TraceAgentState } from '../agent/state/traceAgentState';
import type { SessionStateSnapshot } from '../agentv3/sessionStateSnapshot';

// DB path is resolved lazily (in the constructor) rather than at module load.
// Module-load resolution would capture `process.cwd()` at the time of the first
// `import`, which breaks the CLI path: the CLI's bootstrap pins cwd to the
// backend root so all services share one data dir, but that chdir happens
// *after* imports have already resolved. Lazy resolution lets both HTTP (cwd
// already == backend) and CLI (cwd set by bootstrap) land on the same path.
function resolveDbDir(): string {
  return path.join(process.cwd(), 'data', 'sessions');
}

export class SessionPersistenceService {
  private db: Database.Database;
  private static instance: SessionPersistenceService;

  private constructor() {
    const dbDir = resolveDbDir();
    const dbPath = path.join(dbDir, 'sessions.db');

    // Ensure data directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
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
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (filter.traceId) {
      conditions.push('trace_id = ?');
      params.push(filter.traceId);
    }
    if (filter.startDate) {
      conditions.push('created_at >= ?');
      params.push(filter.startDate);
    }
    if (filter.endDate) {
      conditions.push('created_at <= ?');
      params.push(filter.endDate);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM sessions WHERE ${whereClause}`;
    const countResult = this.db.prepare(countQuery).get(...params) as { count: number };
    const totalCount = countResult.count;

    // Build main query with pagination
    let query = `SELECT * FROM sessions WHERE ${whereClause} ORDER BY created_at DESC`;
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

  // ==========================================================================
  // EntityStore Persistence (Phase 3)
  // ==========================================================================

  /**
   * Save EntityStore snapshot for a session.
   * This enables entity cache restoration across process restarts.
   *
   * @param sessionId - The session ID
   * @param entityStore - The EntityStore to save
   * @returns true if save succeeded
   */
  saveEntityStore(sessionId: string, entityStore: EntityStore): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        console.warn(`[SessionPersistence] Cannot save EntityStore: session ${sessionId} not found`);
        return false;
      }

      const metadata: SessionMetadata = session.metadata || {};
      metadata.entityStoreSnapshot = entityStore.serialize();

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save EntityStore:', error);
      return false;
    }
  }

  /**
   * Load EntityStore for a session.
   * Returns null if session doesn't exist or has no EntityStore.
   *
   * @param sessionId - The session ID
   * @returns Deserialized EntityStore or null
   */
  loadEntityStore(sessionId: string): EntityStore | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata?.entityStoreSnapshot) {
        return null;
      }

      return EntityStore.deserialize(session.metadata.entityStoreSnapshot);
    } catch (error) {
      console.error('[SessionPersistence] Failed to load EntityStore:', error);
      return null;
    }
  }

  /**
   * Save full EnhancedSessionContext for a session.
   * This enables complete multi-turn state restoration.
   *
   * @param sessionId - The session ID
   * @param sessionContext - The EnhancedSessionContext to save
   * @returns true if save succeeded
   */
  saveSessionContext(sessionId: string, sessionContext: EnhancedSessionContext): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        console.warn(`[SessionPersistence] Cannot save SessionContext: session ${sessionId} not found`);
        return false;
      }

      const metadata: SessionMetadata = session.metadata || {};
      metadata.sessionContextSnapshot = sessionContext.serialize();
      // Also save EntityStore separately for quick access
      metadata.entityStoreSnapshot = sessionContext.getEntityStore().serialize();

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save SessionContext:', error);
      return false;
    }
  }

  /**
   * Load EnhancedSessionContext for a session.
   * Returns null if session doesn't exist or has no context snapshot.
   *
   * @param sessionId - The session ID
   * @returns Deserialized EnhancedSessionContext or null
   */
  loadSessionContext(sessionId: string): EnhancedSessionContext | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata?.sessionContextSnapshot) {
        return null;
      }

      return EnhancedSessionContext.deserialize(session.metadata.sessionContextSnapshot);
    } catch (error) {
      console.error('[SessionPersistence] Failed to load SessionContext:', error);
      return null;
    }
  }

  /**
   * Check if a session has persisted EntityStore data.
   *
   * @param sessionId - The session ID
   * @returns true if EntityStore exists for this session
   */
  hasEntityStore(sessionId: string): boolean {
    try {
      const session = this.getSession(sessionId);
      return !!(session?.metadata?.entityStoreSnapshot);
    } catch {
      return false;
    }
  }

  /**
   * Check if a session has persisted SessionContext data.
   *
   * @param sessionId - The session ID
   * @returns true if SessionContext exists for this session
   */
  hasSessionContext(sessionId: string): boolean {
    try {
      const session = this.getSession(sessionId);
      return !!(session?.metadata?.sessionContextSnapshot);
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // FocusStore Persistence (Phase 3.1)
  // ==========================================================================

  /**
   * Save FocusStore snapshot for a session.
   * This restores focus-aware incremental analysis across restarts.
   */
  saveFocusStore(sessionId: string, focusStore: FocusStore): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        console.warn(`[SessionPersistence] Cannot save FocusStore: session ${sessionId} not found`);
        return false;
      }

      const metadata: SessionMetadata = session.metadata || {};
      metadata.focusStoreSnapshot = focusStore.serialize();

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save FocusStore:', error);
      return false;
    }
  }

  /**
   * Load FocusStore snapshot for a session.
   * Returns null if session doesn't exist or has no FocusStore snapshot.
   */
  loadFocusStore(sessionId: string): FocusStoreSnapshot | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata?.focusStoreSnapshot) {
        return null;
      }
      return session.metadata.focusStoreSnapshot;
    } catch (error) {
      console.error('[SessionPersistence] Failed to load FocusStore:', error);
      return null;
    }
  }

  /**
   * Check if a session has persisted FocusStore data.
   */
  hasFocusStore(sessionId: string): boolean {
    try {
      const session = this.getSession(sessionId);
      return !!(session?.metadata?.focusStoreSnapshot);
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // TraceAgentState Persistence (v1)
  // ==========================================================================

  /**
   * Save TraceAgentState snapshot for a session.
   * This is the durable single-source-of-truth state for goal-driven analysis.
   */
  saveTraceAgentState(sessionId: string, state: TraceAgentState): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        console.warn(`[SessionPersistence] Cannot save TraceAgentState: session ${sessionId} not found`);
        return false;
      }

      const metadata: SessionMetadata = session.metadata || {};
      metadata.traceAgentStateSnapshot = state;

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save TraceAgentState:', error);
      return false;
    }
  }

  /**
   * Load TraceAgentState snapshot for a session.
   * Returns null if session doesn't exist or has no snapshot.
   */
  loadTraceAgentState(sessionId: string): TraceAgentState | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata?.traceAgentStateSnapshot) {
        return null;
      }
      return session.metadata.traceAgentStateSnapshot;
    } catch (error) {
      console.error('[SessionPersistence] Failed to load TraceAgentState:', error);
      return null;
    }
  }

  /**
   * Check if a session has persisted TraceAgentState data.
   */
  hasTraceAgentState(sessionId: string): boolean {
    try {
      const session = this.getSession(sessionId);
      return !!(session?.metadata?.traceAgentStateSnapshot);
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Turn Messages Persistence (P0-4)
  // ==========================================================================

  /**
   * Append messages to an existing session without deleting prior messages.
   * Used by agentv3 to populate the messages table after each turn.
   */
  appendMessages(sessionId: string, messages: Array<{ id: string; role: string; content: string; timestamp: number; sqlResult?: any }>): void {
    const msgStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp, sql_result)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction(() => {
      for (const msg of messages) {
        const sqlResultJson = msg.sqlResult ? JSON.stringify(msg.sqlResult) : null;
        msgStmt.run(msg.id, sessionId, msg.role, msg.content, msg.timestamp, sqlResultJson);
      }
      // Update session timestamp
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
    });

    insertAll();
  }

  // ==========================================================================
  // Architecture Snapshot Persistence (P0-2)
  // ==========================================================================

  /**
   * Save architecture detection result for a session.
   * Prevents re-detection failures when trace_processor has unloaded the trace after idle.
   */
  saveArchitectureSnapshot(sessionId: string, architecture: any): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) return false;

      const metadata: SessionMetadata = session.metadata || {};
      metadata.architectureSnapshot = architecture;

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);
      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save architecture snapshot:', error);
      return false;
    }
  }

  /**
   * Load architecture detection result for a session.
   */
  loadArchitectureSnapshot(sessionId: string): any | null {
    try {
      const session = this.getSession(sessionId);
      return session?.metadata?.architectureSnapshot ?? null;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Unified Session State Snapshot (replaces 7-phase cascade)
  // ==========================================================================

  /**
   * Atomically save a unified session state snapshot.
   *
   * Performs a single UPDATE metadata call that writes:
   * - sessionStateSnapshot (new format)
   * - runtimeArraysSnapshot (backward compat dual-write)
   * - architectureSnapshot (if present in snapshot)
   * - sessionContextSnapshot + entityStoreSnapshot (if sessionContext provided)
   * - focusStoreSnapshot (if provided)
   * - traceAgentStateSnapshot (if provided)
   *
   * Auto-creates the session record if it doesn't exist.
   * Replaces the 7 individual save*() calls that each did read-modify-write.
   */
  saveSessionStateSnapshot(
    sessionId: string,
    snapshot: SessionStateSnapshot,
    extras?: {
      sessionContext?: EnhancedSessionContext;
      focusStoreSnapshot?: FocusStoreSnapshot;
      traceAgentState?: TraceAgentState;
      owner?: {
        tenantId?: string;
        workspaceId?: string;
        userId?: string;
      };
    },
  ): boolean {
    try {
      const now = Date.now();

      // Auto-create session if not exists
      const existing = this.getSession(sessionId);
      if (!existing) {
        const latestQuery = snapshot.queryHistory.length > 0
          ? snapshot.queryHistory[snapshot.queryHistory.length - 1].query
          : '';
        this.db.prepare(`
          INSERT INTO sessions (id, trace_id, trace_name, question, created_at, updated_at, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          snapshot.traceId,
          snapshot.traceId,
          latestQuery,
          snapshot.snapshotTimestamp,
          now,
          JSON.stringify({}),
        );
      }

      // Preserve non-snapshot fields from existing metadata (new sessions start with {})
      const metadata: SessionMetadata = existing?.metadata || {};
      if (extras?.owner) {
        metadata.tenantId = extras.owner.tenantId;
        metadata.workspaceId = extras.owner.workspaceId;
        metadata.userId = extras.owner.userId;
      }

      // Write new snapshot
      metadata.sessionStateSnapshot = snapshot;

      // Backward-compat dual-write: also populate runtimeArraysSnapshot
      metadata.runtimeArraysSnapshot = {
        conversationSteps: snapshot.conversationSteps,
        dataEnvelopes: snapshot.dataEnvelopes,
        hypotheses: snapshot.hypotheses,
        queryHistory: snapshot.queryHistory,
        conclusionHistory: snapshot.conclusionHistory,
        analysisNotes: snapshot.analysisNotes,
        analysisPlan: snapshot.analysisPlan,
        planHistory: snapshot.planHistory,
        uncertaintyFlags: snapshot.uncertaintyFlags,
      };

      // Write architecture (from snapshot)
      if (snapshot.architecture) {
        metadata.architectureSnapshot = snapshot.architecture;
      }

      // Write session context if provided
      if (extras?.sessionContext) {
        metadata.sessionContextSnapshot = extras.sessionContext.serialize();
        metadata.entityStoreSnapshot = extras.sessionContext.getEntityStore().serialize();
      }

      // Write FocusStore if provided
      if (extras?.focusStoreSnapshot) {
        metadata.focusStoreSnapshot = extras.focusStoreSnapshot;
      }

      // Write TraceAgentState if provided
      if (extras?.traceAgentState) {
        metadata.traceAgentStateSnapshot = extras.traceAgentState;
      }

      // Single atomic UPDATE — replaces 6+ sequential read-modify-write cycles
      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, now, sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save session state snapshot:', error);
      return false;
    }
  }

  /**
   * Load a unified session state snapshot.
   *
   * V2 path: returns `metadata.sessionStateSnapshot` directly.
   * V1 fallback: reconstructs from `metadata.runtimeArraysSnapshot` for old sessions
   * (no DB migration needed).
   */
  loadSessionStateSnapshot(sessionId: string): SessionStateSnapshot | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata) return null;

      // V2 path: return new snapshot directly
      if (session.metadata.sessionStateSnapshot) {
        return session.metadata.sessionStateSnapshot;
      }

      // V1 fallback: reconstruct from runtimeArraysSnapshot
      const legacy = session.metadata.runtimeArraysSnapshot;
      if (!legacy) return null;

      return {
        version: 1,
        snapshotTimestamp: session.updatedAt,
        sessionId: session.id,
        traceId: session.traceId,
        conversationSteps: legacy.conversationSteps || [],
        queryHistory: legacy.queryHistory || [],
        conclusionHistory: legacy.conclusionHistory || [],
        agentDialogue: [],  // Not stored in legacy format
        agentResponses: [], // Not stored in legacy format
        dataEnvelopes: legacy.dataEnvelopes || [],
        hypotheses: legacy.hypotheses || [],
        analysisNotes: legacy.analysisNotes || [],
        analysisPlan: legacy.analysisPlan || null,
        planHistory: legacy.planHistory || [],
        uncertaintyFlags: legacy.uncertaintyFlags || [],
        architecture: session.metadata.architectureSnapshot,
        runSequence: 0,       // Not stored in legacy format
        conversationOrdinal: 0, // Not stored in legacy format
      };
    } catch (error) {
      console.error('[SessionPersistence] Failed to load session state snapshot:', error);
      return null;
    }
  }

  // ==========================================================================
  // Runtime Arrays Persistence (R4)
  // @deprecated Use saveSessionStateSnapshot / loadSessionStateSnapshot instead.
  // Kept only for older persisted sessions and non-snapshot runtime recovery.
  // ==========================================================================

  /**
   * Save runtime arrays snapshot for cross-restart report continuity.
   * Stores conversationSteps, dataEnvelopes, hypotheses, queryHistory,
   * and conclusionHistory that would otherwise be lost on backend restart.
   */
  saveRuntimeArrays(sessionId: string, snapshot: NonNullable<SessionMetadata['runtimeArraysSnapshot']>): boolean {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        console.warn(`[SessionPersistence] Cannot save runtime arrays: session ${sessionId} not found`);
        return false;
      }

      const metadata: SessionMetadata = session.metadata || {};
      metadata.runtimeArraysSnapshot = snapshot;

      const metadataJson = JSON.stringify(metadata);
      this.db.prepare('UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(metadataJson, Date.now(), sessionId);

      return true;
    } catch (error) {
      console.error('[SessionPersistence] Failed to save runtime arrays:', error);
      return false;
    }
  }

  /**
   * Load runtime arrays snapshot for a session.
   * Returns null if session doesn't exist or has no snapshot.
   */
  loadRuntimeArrays(sessionId: string): SessionMetadata['runtimeArraysSnapshot'] | null {
    try {
      const session = this.getSession(sessionId);
      if (!session?.metadata?.runtimeArraysSnapshot) {
        return null;
      }
      return session.metadata.runtimeArraysSnapshot;
    } catch (error) {
      console.error('[SessionPersistence] Failed to load runtime arrays:', error);
      return null;
    }
  }

  getEntityStoreStats(sessionId: string): {
    frameCount: number;
    sessionCount: number;
    analyzedFrameCount: number;
    analyzedSessionCount: number;
  } | null {
    try {
      const session = this.getSession(sessionId);
      const snapshot = session?.metadata?.entityStoreSnapshot;
      if (!snapshot) return null;

      return {
        frameCount: snapshot.framesById?.length || 0,
        sessionCount: snapshot.sessionsById?.length || 0,
        analyzedFrameCount: snapshot.analyzedFrameIds?.length || 0,
        analyzedSessionCount: snapshot.analyzedSessionIds?.length || 0,
      };
    } catch {
      return null;
    }
  }
}

export default SessionPersistenceService;
