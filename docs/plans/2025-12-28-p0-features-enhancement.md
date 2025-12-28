# P0 Features Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement high-priority features for SmartPerfetto including session persistence, result export, and enhanced predefined analysis commands.

**Architecture:**
- **Backend**: Extend existing Node.js/Express API with new endpoints for session management and export functionality
- **Frontend**: Enhance Perfetto UI plugin with export UI and improved session handling
- **Data Model**: Add session persistence using SQLite for long-term storage
- **Export Format**: Support CSV/JSON exports with proper formatting and encoding

**Tech Stack:**
- Backend: Node.js + Express + TypeScript + SQLite
- Frontend: TypeScript + Mithril.js (existing Perfetto UI framework)
- Export: papaparse for CSV generation, native JSON APIs

---

## Task 1: Backend - Session Persistence Service

**Files:**
- Create: `backend/src/services/sessionPersistenceService.ts`
- Create: `backend/src/models/sessionSchema.ts`
- Modify: `backend/src/routes/traceAnalysisRoutes.ts`
- Modify: `backend/src/index.ts`

**Step 1: Create database schema and models**

Create `backend/src/models/sessionSchema.ts`:

```typescript
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
```

**Step 2: Create session persistence service**

Create `backend/src/services/sessionPersistenceService.ts`:

```typescript
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
        metadata TEXT,
        INDEX idx_trace_id (trace_id),
        INDEX idx_created_at (created_at)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        sql_result TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        INDEX idx_session_id (session_id)
      );
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

    const metadataJson = JSON.stringify(session.metadata);

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
```

**Step 3: Add better-sqlite3 dependency**

Run: `cd backend && npm install better-sqlite3 @types/better-sqlite3 --save`

Expected: Package added to package.json

**Step 4: Add session routes**

Modify `backend/src/routes/traceAnalysisRoutes.ts` - add new routes at the end:

```typescript
/**
 * Session persistence routes
 * GET /api/sessions - List all sessions
 * GET /api/sessions/:id - Get specific session
 * DELETE /api/sessions/:id - Delete session
 * GET /api/sessions/export/:traceId - Export sessions as JSON
 */

router.get('/sessions', async (req, res) => {
  try {
    const { traceId, limit, offset } = req.query;
    const sessionService = SessionPersistenceService.getInstance();

    const result = sessionService.listSessions({
      traceId: traceId as string,
      limit: limit ? parseInt(limit as string) : 20,
      offset: offset ? parseInt(offset as string) : 0,
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sessionService = SessionPersistenceService.getInstance();

    const session = sessionService.getSession(id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    res.json({ success: true, session });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sessionService = SessionPersistenceService.getInstance();

    const deleted = sessionService.deleteSession(id);
    res.json({ success: true, deleted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions/export/:traceId?', async (req, res) => {
  try {
    const { traceId } = req.params;
    const sessionService = SessionPersistenceService.getInstance();

    const jsonData = sessionService.exportSessions(traceId);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sessions-${Date.now()}.json"`);
    res.send(jsonData);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

**Step 5: Update orchestrator to persist sessions**

Modify `backend/src/services/perfettoAnalysisOrchestrator.ts` - add persistence call in `runAnalysisLoop` after completion:

```typescript
// Add import at top
import { SessionPersistenceService } from './sessionPersistenceService';
import { StoredSession, StoredMessage } from '../models/sessionSchema';

// Update runAnalysisLoop method - add after emitCompleted call:
private async runAnalysisLoop(sessionId: string): Promise<void> {
  // ... existing code ...

  // Generate final answer
  this.emitProgress(sessionId, 'generating_answer', '✍️ 正在生成最终答案...');
  const finalAnswer = await this.generateFinalAnswer(sessionId);
  this.sessionService.completeSession(sessionId, finalAnswer);
  this.emitCompleted(sessionId, finalAnswer, startTime);

  // Persist session to database
  this.persistSession(sessionId);
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
      createdAt: session.createdAt || Date.now(),
      updatedAt: Date.now(),
      metadata: {
        totalIterations: session.currentIteration,
        sqlQueriesCount: session.collectedResults.length,
        totalDuration: Date.now() - (session.createdAt || Date.now()),
      },
      messages: session.messages.map(m => ({
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        role: m.role,
        content: m.content,
        timestamp: Date.now(),
      })),
    };

    persistenceService.saveSession(storedSession);
  } catch (error) {
    console.error('[Orchestrator] Failed to persist session:', error);
  }
}
```

**Step 6: Run TypeScript check**

Run: `cd backend && npx tsc --noEmit`

Expected: No type errors

**Step 7: Test session persistence**

Run: `curl http://localhost:3000/api/sessions`

Expected: `{"success":true,"sessions":[],"totalCount":0,"hasMore":false}`

**Step 8: Commit**

```bash
git add backend/src/
git commit -m "feat: add session persistence service with SQLite storage

- Add SessionPersistenceService for long-term session storage
- Add session listing, retrieval, and deletion endpoints
- Integrate session persistence into orchestrator
- Support filtering and pagination for session lists"
```

---

## Task 2: Backend - Result Export Service (CSV/JSON)

**Files:**
- Create: `backend/src/services/resultExportService.ts`
- Create: `backend/src/routes/exportRoutes.ts`
- Modify: `backend/src/index.ts`

**Step 1: Create export service**

Create `backend/src/services/resultExportService.ts`:

```typescript
/**
 * Result Export Service
 * Handles exporting SQL query results to CSV and JSON formats
 */

import { SqlQueryResult } from '../models/sessionSchema';

export interface ExportOptions {
  format: 'csv' | 'json';
  includeHeaders?: boolean;
  delimiter?: string;
  nullValue?: string;
  prettyPrint?: boolean;
}

export interface ExportResult {
  data: string;
  mimeType: string;
  filename: string;
  rowCount: number;
}

export class ResultExportService {
  private static instance: ResultExportService;

  private constructor() {}

  static getInstance(): ResultExportService {
    if (!ResultExportService.instance) {
      ResultExportService.instance = new ResultExportService();
    }
    return ResultExportService.instance;
  }

  /**
   * Export SQL result to CSV or JSON
   */
  exportResult(result: SqlQueryResult, options: ExportOptions = { format: 'json' }): ExportResult {
    const { format } = options;

    switch (format) {
      case 'csv':
        return this.exportToCSV(result, options);
      case 'json':
        return this.exportToJSON(result, options);
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Export to CSV format
   */
  private exportToCSV(result: SqlQueryResult, options: ExportOptions): ExportResult {
    const {
      includeHeaders = true,
      delimiter = ',',
      nullValue = 'NULL',
    } = options;

    const lines: string[] = [];

    // Add header row
    if (includeHeaders) {
      const header = this.escapeCSVFields(result.columns, delimiter);
      lines.push(header.join(delimiter));
    }

    // Add data rows
    for (const row of result.rows) {
      const values = row.map(v =>
        v === null || v === undefined ? nullValue : String(v)
      );
      const escaped = this.escapeCSVFields(values, delimiter);
      lines.push(escaped.join(delimiter));
    }

    const data = lines.join('\n');

    return {
      data,
      mimeType: 'text/csv',
      filename: `query-result-${Date.now()}.csv`,
      rowCount: result.rowCount,
    };
  }

  /**
   * Escape CSV fields according to RFC 4180
   */
  private escapeCSVFields(fields: string[], delimiter: string): string[] {
    return fields.map(field => {
      const str = String(field);
      // If field contains delimiter, quotes, or newlines, wrap in quotes and escape quotes
      if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
  }

  /**
   * Export to JSON format
   */
  private exportToJSON(result: SqlQueryResult, options: ExportOptions): ExportResult {
    const { prettyPrint = true } = options;

    const jsonData = {
      exportedAt: new Date().toISOString(),
      rowCount: result.rowCount,
      columns: result.columns,
      rows: result.rows,
      query: result.query || null,
    };

    const data = JSON.stringify(jsonData, null, prettyPrint ? 2 : 0);

    return {
      data,
      mimeType: 'application/json',
      filename: `query-result-${Date.now()}.json`,
      rowCount: result.rowCount,
    };
  }

  /**
   * Export multiple results (for session export)
   */
  exportSession(results: Array<{ name: string; result: SqlQueryResult }>, options: ExportOptions = { format: 'json' }): ExportResult {
    if (options.format === 'csv') {
      // For CSV, combine all results into one file with sheet separators
      const lines: string[] = [];

      for (const { name, result } of results) {
        lines.push(`=== ${name} ===`);
        const csvResult = this.exportToCSV(result, options);
        lines.push(csvResult.data);
        lines.push(''); // Empty line between results
      }

      return {
        data: lines.join('\n'),
        mimeType: 'text/csv',
        filename: `session-export-${Date.now()}.csv`,
        rowCount: results.reduce((sum, r) => sum + r.result.rowCount, 0),
      };
    }

    // JSON format - structured export
    const jsonData = {
      exportedAt: new Date().toISOString(),
      totalResults: results.length,
      totalRows: results.reduce((sum, r) => sum + r.result.rowCount, 0),
      results: results.map(({ name, result }) => ({
        name,
        columns: result.columns,
        rowCount: result.rowCount,
        query: result.query,
        rows: result.rows,
      })),
    };

    const data = JSON.stringify(jsonData, null, options.prettyPrint ? 2 : 0);

    return {
      data,
      mimeType: 'application/json',
      filename: `session-export-${Date.now()}.json`,
      rowCount: results.reduce((sum, r) => sum + r.result.rowCount, 0),
    };
  }
}

export default ResultExportService;
```

**Step 2: Create export routes**

Create `backend/src/routes/exportRoutes.ts`:

```typescript
/**
 * Export Routes
 * Handle result export requests
 */

import { Router } from 'express';
import { ResultExportService } from '../services/resultExportService';

const router = Router();

/**
 * POST /api/export/result
 * Export a single SQL query result
 */
router.post('/result', async (req, res) => {
  try {
    const { result, format = 'json', options = {} } = req.body;

    if (!result || !result.columns || !result.rows) {
      return res.status(400).json({
        success: false,
        error: 'Invalid result data. Must include columns and rows.',
      });
    }

    const exportService = ResultExportService.getInstance();
    const exportResult = exportService.exportResult(result, { format, ...options });

    res.setHeader('Content-Type', exportResult.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.send(exportResult.data);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/export/session
 * Export all results from a session
 */
router.post('/session', async (req, res) => {
  try {
    const { results, format = 'json', options = {} } = req.body;

    if (!Array.isArray(results)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid results data. Must be an array.',
      });
    }

    const exportService = ResultExportService.getInstance();
    const exportResult = exportService.exportSession(results, { format, ...options });

    res.setHeader('Content-Type', exportResult.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.send(exportResult.data);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/export/formats
 * Get available export formats
 */
router.get('/formats', (req, res) => {
  res.json({
    success: true,
    formats: [
      { name: 'json', mimeType: 'application/json', description: 'JSON format with metadata' },
      { name: 'csv', mimeType: 'text/csv', description: 'CSV format (RFC 4180)' },
    ],
    options: {
      json: {
        prettyPrint: { type: 'boolean', default: true, description: 'Pretty print JSON output' },
      },
      csv: {
        includeHeaders: { type: 'boolean', default: true, description: 'Include column headers' },
        delimiter: { type: 'string', default: ',', description: 'Field delimiter' },
        nullValue: { type: 'string', default: 'NULL', description: 'Representation of null values' },
      },
    },
  });
});

export default router;
```

**Step 3: Register export routes in index.ts**

Modify `backend/src/index.ts`:

```typescript
// Add import
import exportRoutes from './routes/exportRoutes';

// Register routes (add with other route registrations)
app.use('/api/export', exportRoutes);
```

**Step 4: Test export endpoints**

Run: `curl http://localhost:3000/api/export/formats`

Expected: JSON with available formats and options

**Step 5: Commit**

```bash
git add backend/src/
git commit -m "feat: add result export service with CSV/JSON support

- Add ResultExportService for exporting SQL query results
- Support CSV (RFC 4180) and JSON export formats
- Add /api/export/result and /api/export/session endpoints
- Configurable export options (delimiter, headers, pretty print)"
```

---

## Task 3: Frontend - Enhanced SQL Result Table with Export

**Files:**
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sql_result_table.ts`
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`

**Step 1: Add export functionality to SQL result table**

Modify `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/sql_result_table.ts` - add export button:

```typescript
// Add to SqlResultTable interface
export interface SqlResultTableAttrs {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  onPin?: (data: {query: string, columns: string[], rows: any[][], timestamp: number}) => void;
  onExport?: (format: 'csv' | 'json') => void;  // NEW
}

// Update view() method to add export buttons
view() {
  const {columns, rows, rowCount, query, onExport} = this.attrs;

  return m('div', {style: {...STYLES.tableContainer}}, [
    // Export buttons (add after header or before table)
    onExport ? m('div', {style: STYLES.exportActions}, [
      m('button', {
        style: STYLES.exportBtn,
        onclick: () => onExport('csv'),
        title: 'Export as CSV',
      }, '📄 CSV'),
      m('button', {
        style: STYLES.exportBtn,
        onclick: () => onExport('json'),
        title: 'Export as JSON',
      }, '📋 JSON'),
    ]) : null,

    // ... existing table code ...
  ]);
}

// Add export styles
const STYLES = {
  // ... existing styles ...
  exportActions: {
    display: 'flex',
    gap: '8px',
    padding: '12px 18px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--background2)',
  },
  exportBtn: {
    padding: '6px 14px',
    borderRadius: '6px',
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    transition: 'all 0.2s ease',
  },
};
```

**Step 2: Add export handler in ai_panel.ts**

Modify `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts` - add export methods:

```typescript
/**
 * Export SQL result to CSV or JSON
 */
private async exportResult(result: SqlQueryResult, format: 'csv' | 'json'): Promise<void> {
  try {
    const response = await fetch(`${this.state.settings.backendUrl}/api/export/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          query: result.query,
        },
        format,
        options: format === 'json' ? { prettyPrint: true } : { includeHeaders: true },
      }),
    });

    if (!response.ok) {
      throw new Error(`Export failed: ${response.statusText}`);
    }

    // Get filename from Content-Disposition header or generate one
    const contentDisp = response.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisp.match(/filename="(.+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `result-${Date.now()}.${format}`;

    // Download file
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: `✅ Exported **${result.rowCount}** rows as ${format.toUpperCase()}`,
      timestamp: Date.now(),
    });
  } catch (e: any) {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Export failed:** ${e.message}`,
      timestamp: Date.now(),
    });
  }
}

/**
 * Export current session
 */
private async exportCurrentSession(format: 'csv' | 'json' = 'json'): Promise<void> {
  // Collect all SQL results from messages
  const results = this.state.messages
    .filter(msg => msg.sqlResult)
    .map(msg => ({
      name: `Query at ${new Date(msg.timestamp).toLocaleTimeString()}`,
      result: msg.sqlResult!,
    }));

  if (results.length === 0) {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: '**No SQL results to export.** Run some queries first.',
      timestamp: Date.now(),
    });
    return;
  }

  try {
    const response = await fetch(`${this.state.settings.backendUrl}/api/export/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results,
        format,
        options: format === 'json' ? { prettyPrint: true } : { includeHeaders: true },
      }),
    });

    if (!response.ok) {
      throw new Error(`Export failed: ${response.statusText}`);
    }

    const contentDisp = response.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisp.match(/filename="(.+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `session-${Date.now()}.${format}`;

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: `✅ Exported session with **${results.length}** query results as ${format.toUpperCase()}`,
      timestamp: Date.now(),
    });
  } catch (e: any) {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Export failed:** ${e.message}`,
      timestamp: Date.now(),
    });
  }
}
```

**Step 3: Update SQL result display to include export callback**

Modify the SqlResultTable component call in ai_panel.ts:

```typescript
// Find the SqlResultTable component call and add onExport prop
m(SqlResultTable, {
  columns: sqlResult.columns,
  rows: sqlResult.rows,
  rowCount: sqlResult.rowCount,
  query,
  onPin: (data) => this.handlePin(data),
  onExport: (format) => this.exportResult(sqlResult, format),  // NEW
}),
```

**Step 4: Add /export command**

Modify `handleCommand` switch statement in ai_panel.ts:

```typescript
case '/export':
  await this.handleExportCommand(args[0]);
  break;
```

Add handler method:

```typescript
private async handleExportCommand(formatArg?: string) {
  const format = formatArg === 'csv' ? 'csv' : 'json';
  await this.exportCurrentSession(format);
}
```

**Step 5: Update help message**

Modify `getHelpMessage` method to include export command:

```typescript
private getHelpMessage(): string {
  return `**AI Assistant Commands:**

| Command | Description |
|---------|-------------|
| \`/sql <query>\` | Execute SQL query |
| \`/goto <ts>\` | Jump to timestamp |
| \`/analyze\` | Analyze current selection |
| \`/anr\` | Find ANRs |
| \`/jank\` | Find janky frames |
| \`/export [csv|json]\` | Export session results |
| \`/pins\` | View pinned query results |
| \`/clear\` | Clear chat history |
| \`/help\` | Show this help |
| \`/settings\` | Open settings |

**Tips:**
- Use arrow keys to navigate command history
- Shift+Enter for new line, Enter to send
- Click 📄 CSV or 📋 JSON buttons to export query results
- Click 📌 Pin to save query results for later`;
}
```

**Step 6: Build and test frontend**

Run: `cd perfetto/ui && npm run build`

Expected: Build succeeds without errors

**Step 7: Commit**

```bash
git add perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
git commit -m "feat: add export functionality to SQL result tables

- Add CSV/JSON export buttons to SQL result tables
- Add /export command for session export
- Implement client-side export handling with file download
- Update help message with export documentation"
```

---

## Task 4: Backend - Enhanced Predefined Analysis Commands

**Files:**
- Modify: `backend/src/services/perfettoSqlSkill.ts`
- Modify: `backend/src/routes/traceAnalysisRoutes.ts`

**Step 1: Add /slow command handler to backend**

Modify `backend/src/services/perfettoSqlSkill.ts` - add slow function detection:

```typescript
/**
 * Add to PerfettoSkillType enum (in types/perfettoSql.ts or top of file)
 */
export enum PerfettoSkillType {
  STARTUP = 'startup',
  SCROLLING = 'scrolling',
  NAVIGATION = 'navigation',
  CLICK_RESPONSE = 'click_response',
  MEMORY = 'memory',
  CPU = 'cpu',
  SURFACE_FLINGER = 'surfaceflinger',
  SYSTEM_SERVER = 'systemserver',
  INPUT = 'input',
  BINDER = 'binder',
  BUFFER_FLOW = 'bufferflow',
  SLOW_FUNCTIONS = 'slow_functions',  // NEW
}

/**
 * Add to SKILL_PATTERNS array
 */
{
  skillType: PerfettoSkillType.SLOW_FUNCTIONS,
  keywords: ['slow', 'function', 'method', '耗时', '慢函数', '性能'],
  patterns: [
    /slow.*function|slow.*method/i,
    /耗时|慢函数|性能分析/i,
  ],
}

/**
 * Add analyzeSlowFunctions method
 */
async analyzeSlowFunctions(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
  let processFilter = '';
  if (packageName) {
    processFilter = `AND p.name GLOB '${packageName}*'`;
  }

  // Find long-running slices (potential slow functions)
  const sql = `
    WITH long_running_slices AS (
      SELECT
        s.id,
        s.name,
        s.ts / 1e6 as ts_ms,
        s.dur / 1e6 as dur_ms,
        s.depth,
        t.name as thread_name,
        p.name as process_name,
        s.category
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.dur > 16000000  -- > 16ms (missed frame threshold)
        ${processFilter}
      ORDER BY s.dur DESC
      LIMIT 100
    )
    SELECT
      name,
      thread_name,
      process_name,
      category,
      COUNT(*) as count,
      AVG(dur_ms) as avg_dur_ms,
      MIN(dur_ms) as min_dur_ms,
      MAX(dur_ms) as max_dur_ms,
      SUM(dur_ms) as total_dur_ms
    FROM long_running_slices
    GROUP BY name, thread_name, process_name, category
    ORDER BY total_dur_ms DESC
    LIMIT 50
  `;

  const queryResult = await this.traceProcessor.query(traceId, sql);

  if (queryResult.error) {
    return {
      analysisType: 'slow_functions',
      sql,
      rows: [],
      rowCount: 0,
      summary: `Error analyzing slow functions: ${queryResult.error}`,
    };
  }

  const rows = queryResult.rows as any[];
  const summary = this.formatSlowFunctionsSummary(rows);

  // Also get top individual slowest slices
  const topSlowSql = `
    SELECT
      s.name,
      s.ts / 1e6 as ts_ms,
      s.dur / 1e6 as dur_ms,
      t.name as thread_name,
      p.name as process_name
    FROM slice s
    JOIN thread_track tt ON s.track_id = tt.id
    JOIN thread t ON tt.utid = t.utid
    JOIN process p ON t.upid = p.upid
    WHERE s.dur > 50000000  -- > 50ms
      ${processFilter}
    ORDER BY s.dur DESC
    LIMIT 20
  `;

  const topSlowResult = await this.traceProcessor.query(traceId, topSlowSql);

  return {
    analysisType: 'slow_functions',
    sql,
    rows,
    rowCount: rows.length,
    summary,
    metrics: {
      totalSlowFunctions: rows.length,
      avgDuration: rows.length > 0 ? rows.reduce((sum, r) => sum + (r.avg_dur_ms || 0), 0) / rows.length : 0,
    },
    details: {
      topSlowest: topSlowResult.rows || [],
    },
  };
}

/**
 * Add summary formatter
 */
private formatSlowFunctionsSummary(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return 'No slow functions detected (>16ms). Good performance!';
  }

  const topSlow = rows[0] as any;
  const totalSlowTime = rows.reduce((sum, r: any) => sum + (r.total_dur_ms || 0), 0);

  let summary = `Found **${rows.length}** types of slow functions (>16ms). `;
  summary += `Total slow time: ${totalSlowTime.toFixed(2)}ms.\n\n`;
  summary += `**Slowest function type:** ${topSlow.name} `;
  summary += `(avg: ${topSlow.avg_dur_ms?.toFixed(2)}ms, `;
  summary += `max: ${topSlow.max_dur_ms?.toFixed(2)}ms, `;
  summary += `count: ${topSlow.count})\n\n`;

  // Get top 5 by total time
  const top5 = rows.slice(0, 5);
  summary += '**Top 5 by total time:**\n';
  for (const r of top5 as any[]) {
    summary += `- ${r.name}: ${r.total_dur_ms?.toFixed(2)}ms `;
    summary += `(${r.count} calls, avg ${r.avg_dur_ms?.toFixed(2)}ms)\n`;
  }

  return summary;
}
```

**Step 2: Add /slow command API route**

Modify `backend/src/routes/traceAnalysisRoutes.ts`:

```typescript
/**
 * POST /api/analyze/slow
 * Quick slow function analysis
 */
router.post('/slow', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }

    const skill = new PerfettoSqlSkill(traceProcessorService);
    const result = await skill.analyzeSlowFunctions(traceId, packageName);

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

**Step 3: Add /memory command API route**

Modify `backend/src/routes/traceAnalysisRoutes.ts`:

```typescript
/**
 * POST /api/analyze/memory
 * Quick memory analysis
 */
router.post('/memory', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }

    const skill = new PerfettoSqlSkill(traceProcessorService);
    const result = await skill.analyzeMemory(traceId, packageName);

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

**Step 4: Test new endpoints**

Run: `curl -X POST http://localhost:3000/api/analyze/slow -H "Content-Type: application/json" -d '{"traceId":"test-id"}'`

Expected: Either result or "traceId not found" error (if trace doesn't exist)

**Step 5: Commit**

```bash
git add backend/src/
git commit -m "feat: add slow function detection and quick analysis endpoints

- Add /slow command for detecting slow functions (>16ms)
- Add /memory command endpoint for quick memory analysis
- Add PerfettoSkillType.SLOW_FUNCTIONS to skill patterns
- Include aggregated statistics and top slowest function details"
```

---

## Task 5: Frontend - Enhanced Predefined Commands with Backend Integration

**Files:**
- Modify: `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/ai_panel.ts`

**Step 1: Add /slow command handler**

Modify `handleCommand` method in ai_panel.ts:

```typescript
case '/slow':
  await this.handleSlowCommand();
  break;
case '/memory':
  await this.handleMemoryCommand();
  break;
```

**Step 2: Implement command handlers**

Add these methods to ai_panel.ts:

```typescript
private async handleSlowCommand() {
  if (!this.state.backendTraceId) {
    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: '⚠️ **Trace not uploaded to backend.** Upload with 📤 button first.',
      timestamp: Date.now(),
    });
    return;
  }

  this.state.isLoading = true;
  m.redraw();

  try {
    const response = await fetch(`${this.state.settings.backendUrl}/api/analyze/slow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traceId: this.state.backendTraceId,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.success) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: data.summary || `Analyzed ${data.rowCount} slow function types.`,
        timestamp: Date.now(),
        sqlResult: {
          columns: data.details?.topSlowest?.length > 0
            ? ['name', 'ts_ms', 'dur_ms', 'thread_name', 'process_name']
            : [],
          rows: data.details?.topSlowest || [],
          rowCount: data.details?.topSlowest?.length || 0,
          query: data.sql,
        },
      });
    }
  } catch (e: any) {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Error:** ${e.message}`,
      timestamp: Date.now(),
    });
  }

  this.state.isLoading = false;
  m.redraw();
}

private async handleMemoryCommand() {
  if (!this.state.backendTraceId) {
    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: '⚠️ **Trace not uploaded to backend.** Upload with 📤 button first.',
      timestamp: Date.now(),
    });
    return;
  }

  this.state.isLoading = true;
  m.redraw();

  try {
    const response = await fetch(`${this.state.settings.backendUrl}/api/analyze/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traceId: this.state.backendTraceId,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.success) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: data.summary || `Memory analysis complete.`,
        timestamp: Date.now(),
        sqlResult: {
          columns: data.columns || [],
          rows: data.rows || [],
          rowCount: data.rowCount || 0,
          query: data.sql,
        },
      });
    }
  } catch (e: any) {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Error:** ${e.message}`,
      timestamp: Date.now(),
    });
  }

  this.state.isLoading = false;
  m.redraw();
}
```

**Step 3: Update welcome and help messages**

Modify `getWelcomeMessage` method:

```typescript
private getWelcomeMessage(): string {
  return `**Welcome to AI Assistant!** 🤖

I can help you analyze Perfetto traces. Here are some things you can ask:

* "What are the main threads in this trace?"
* "Find all ANRs (Application Not Responding)"
* "Show me the janky frames"
* "Why is my app slow?"

**Quick Commands:**
* \`/anr\` - Find ANRs
* \`/jank\` - Find janky frames
* \`/slow\` - Detect slow functions
* \`/memory\` - Analyze memory usage
* \`/sql <query>\` - Execute SQL
* \`/export [csv|json]\` - Export results
* \`/clear\` - Clear chat
* \`/help\` - Show all commands

**Current AI Provider:** ${this.state.settings.provider.toUpperCase()}

Click ⚙️ to change settings.`;
}
```

**Step 4: Build and test**

Run: `cd perfetto/ui && npm run build`

Expected: Build succeeds

**Step 5: Commit**

```bash
git add perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/
git commit -m "feat: add /slow and /memory quick commands with backend integration

- Add /slow command to detect functions >16ms
- Add /memory command for memory analysis
- Integrate with backend quick analysis endpoints
- Update welcome message with new commands"
```

---

## Task 6: Documentation and Testing

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`

**Step 1: Update README.md**

Add new features to README.md "可用命令" section:

```markdown
### 可用命令

| 命令 | 说明 |
|------|------|
| `/sql <query>` | 执行 SQL 查询 |
| `/goto <timestamp>` | 跳转到指定时间戳 |
| `/analyze` | 分析当前选中区域 |
| `/anr` | 快速检测 ANR |
| `/jank` | 快速检测掉帧 |
| `/slow` | 检测慢函数 (>16ms) |
| `/memory` | 分析内存使用 |
| `/export [csv|json]` | 导出查询结果 |
| `/pins` | 查看固定的结果 |
| `/clear` | 清除对话历史 |
| `/settings` | 打开设置 |
| `/help` | 显示帮助 |

### 导出功能

分析结果支持导出为 CSV 或 JSON 格式：
- 点击结果表格上的 📄 CSV 或 📋 JSON 按钮
- 使用 `/export csv` 或 `/export json` 导出整个会话
- 导出的文件包含完整的查询结果和元数据
```

**Step 2: Update TODO.md**

Mark completed items:

```markdown
## ✅ 已完成

### P0 - 核心功能增强

#### 预定义分析命令
- [x] `/anr` - 快速检测 ANR 问题
- [x] `/jank` - 快速检测掉帧
- [x] `/memory` - 内存分配分析
- [x] `/slow` - 慢函数检测

#### 分析结果展示
- [x] SQL 查询结果表格展示
- [x] 结果导出 (CSV/JSON)
- [x] 查询结果与时间线关联

#### 会话管理
- [x] 会话历史持久化 (SQLite)
- [x] 会话导出功能
```

**Step 3: Create integration tests**

Create `backend/src/tests/sessionExport.test.ts`:

```typescript
/**
 * Session and Export Integration Tests
 */

import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { ResultExportService } from '../services/resultExportService';
import { StoredSession, SqlQueryResult } from '../models/sessionSchema';

describe('SessionPersistence', () => {
  let service: SessionPersistenceService;

  beforeEach(() => {
    service = SessionPersistenceService.getInstance();
  });

  test('should save and retrieve session', () => {
    const session: StoredSession = {
      id: 'test-session-1',
      traceId: 'trace-123',
      traceName: 'test.pftrace',
      question: 'Analyze this trace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Test message',
          timestamp: Date.now(),
        },
      ],
    };

    const saved = service.saveSession(session);
    expect(saved).toBe(true);

    const retrieved = service.getSession('test-session-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.question).toBe('Analyze this trace');
  });

  test('should list sessions with pagination', () => {
    const result = service.listSessions({ limit: 10, offset: 0 });
    expect(result).toHaveProperty('sessions');
    expect(result).toHaveProperty('totalCount');
    expect(result).toHaveProperty('hasMore');
  });
});

describe('ResultExport', () => {
  let service: ResultExportService;

  beforeEach(() => {
    service = ResultExportService.getInstance();
  });

  test('should export to CSV', () => {
    const result: SqlQueryResult = {
      columns: ['name', 'value'],
      rows: [['test1', 100], ['test2', 200]],
      rowCount: 2,
    };

    const exported = service.exportResult(result, { format: 'csv' });
    expect(exported.mimeType).toBe('text/csv');
    expect(exported.data).toContain('name,value');
    expect(exported.rowCount).toBe(2);
  });

  test('should export to JSON', () => {
    const result: SqlQueryResult = {
      columns: ['name', 'value'],
      rows: [['test1', 100], ['test2', 200]],
      rowCount: 2,
    };

    const exported = service.exportResult(result, { format: 'json' });
    expect(exported.mimeType).toBe('application/json');
    expect(exported.data).toContain('"columns"');
    expect(exported.rowCount).toBe(2);
  });
});
```

**Step 4: Run tests**

Run: `cd backend && npm test`

Expected: Tests pass

**Step 5: Final commit**

```bash
git add README.md TODO.md backend/src/tests/
git commit -m "docs: update documentation with P0 features

- Document new /slow and /memory commands
- Document export functionality (CSV/JSON)
- Update TODO.md with completed P0 items
- Add integration tests for session and export services"
```

---

## Summary

This plan implements all P0 features from the TODO:

1. **Session Persistence** - SQLite-based storage for long-term session management
2. **Result Export** - CSV/JSON export for query results and sessions
3. **Enhanced Commands** - `/slow` and `/memory` quick analysis commands

**Files Modified/Created:**
- Backend: 6 new files, 4 modified
- Frontend: 2 modified
- Tests: 1 new file
- Docs: 2 modified

**Estimated Effort:** Each task is designed to be completed in 30-45 minutes.

**Testing Strategy:**
1. Unit tests for core services
2. Integration tests for API endpoints
3. Manual testing in Perfetto UI
4. Export validation with sample traces
