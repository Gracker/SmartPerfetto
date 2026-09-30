// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session Persistence and Export Service Tests
 *
 * Integration tests for SessionPersistenceService and ResultExportService
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { ResultExportService } from '../services/resultExportService';
import {
  StoredSession,
  SqlQueryResult,
} from '../models/sessionSchema';

describe('SessionPersistenceService', () => {
  const TEST_DB_DIR = path.join(process.cwd(), 'data', 'sessions');
  const TEST_DB_PATH = path.join(TEST_DB_DIR, 'sessions.db');

  beforeAll(() => {
    // Clean up any existing test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  afterAll(() => {
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  beforeEach(() => {
    // Clear all data before each test
    const service = SessionPersistenceService.getInstance();
    const sessions = service.listSessions({ limit: 1000 }).sessions;
    sessions.forEach(session => {
      service.deleteSession(session.id);
    });
  });

  describe('saveSession', () => {
    it('should save a complete session with messages', () => {
      const service = SessionPersistenceService.getInstance();

      const session: StoredSession = {
        id: 'test-session-1',
        traceId: 'trace-123',
        traceName: 'example.perfetto-trace',
        question: 'Analyze ANR issues',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          totalIterations: 3,
          sqlQueriesCount: 5,
          totalDuration: 15000,
        },
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Analyze ANR issues',
            timestamp: Date.now(),
          },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'Found 2 ANR events',
            timestamp: Date.now() + 1000,
            sqlResult: {
              columns: ['id', 'name', 'duration'],
              rows: [[1, 'ANR_1', 5000], [2, 'ANR_2', 3000]],
              rowCount: 2,
              query: 'SELECT * FROM anr',
            },
          },
        ],
      };

      const result = service.saveSession(session);
      expect(result).toBe(true);
    });

    it('should update an existing session', () => {
      const service = SessionPersistenceService.getInstance();

      const session: StoredSession = {
        id: 'test-session-2',
        traceId: 'trace-123',
        traceName: 'example.perfetto-trace',
        question: 'Initial question',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Initial question',
            timestamp: Date.now(),
          },
        ],
      };

      service.saveSession(session);

      // Update with additional messages
      session.messages.push({
        id: 'msg-2',
        role: 'assistant',
        content: 'Answer',
        timestamp: Date.now() + 1000,
      });
      session.updatedAt = Date.now();

      const result = service.saveSession(session);
      expect(result).toBe(true);

      const retrieved = service.getSession('test-session-2');
      expect(retrieved?.messages).toHaveLength(2);
    });
  });

  describe('getSession', () => {
    it('should retrieve a saved session', () => {
      const service = SessionPersistenceService.getInstance();

      const session: StoredSession = {
        id: 'test-session-3',
        traceId: 'trace-456',
        traceName: 'test.perfetto-trace',
        question: 'Test question',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Test',
            timestamp: Date.now(),
          },
        ],
      };

      service.saveSession(session);
      const retrieved = service.getSession('test-session-3');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('test-session-3');
      expect(retrieved?.traceId).toBe('trace-456');
      expect(retrieved?.question).toBe('Test question');
    });

    it('should return null for non-existent session', () => {
      const service = SessionPersistenceService.getInstance();
      const retrieved = service.getSession('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should parse SQL results correctly', () => {
      const service = SessionPersistenceService.getInstance();

      const sqlResult: SqlQueryResult = {
        columns: ['timestamp', 'name', 'value'],
        rows: [[1000, 'test', 42], [2000, 'test2', 43]],
        rowCount: 2,
        query: 'SELECT * FROM test',
      };

      const session: StoredSession = {
        id: 'test-session-4',
        traceId: 'trace-789',
        traceName: 'sql-test.perfetto-trace',
        question: 'SQL test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Result',
            timestamp: Date.now(),
            sqlResult,
          },
        ],
      };

      service.saveSession(session);
      const retrieved = service.getSession('test-session-4');

      expect(retrieved?.messages[0].sqlResult).toEqual(sqlResult);
    });
  });

  describe('listSessions', () => {
    beforeEach(() => {
      const service = SessionPersistenceService.getInstance();

      // Create multiple sessions
      for (let i = 1; i <= 5; i++) {
        const session: StoredSession = {
          id: `session-${i}`,
          traceId: i <= 3 ? 'trace-abc' : `trace-${i}`,
          traceName: `test-${i}.perfetto-trace`,
          question: `Question ${i}`,
          createdAt: Date.now() - (5 - i) * 1000 * 60 * 60, // Spread over hours
          updatedAt: Date.now(),
          messages: [],
        };
        service.saveSession(session);
      }
    });

    it('should list all sessions', () => {
      const service = SessionPersistenceService.getInstance();
      const result = service.listSessions();

      expect(result.sessions).toHaveLength(5);
      expect(result.totalCount).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('should filter by traceId', () => {
      const service = SessionPersistenceService.getInstance();
      const result = service.listSessions({ traceId: 'trace-abc' });

      expect(result.sessions).toHaveLength(3);
      expect(result.totalCount).toBe(3);
    });

    it('should support pagination', () => {
      const service = SessionPersistenceService.getInstance();
      const page1 = service.listSessions({ limit: 2, offset: 0 });
      const page2 = service.listSessions({ limit: 2, offset: 2 });

      expect(page1.sessions).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page2.sessions).toHaveLength(2);
      expect(page2.hasMore).toBe(true);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const service = SessionPersistenceService.getInstance();

      const session: StoredSession = {
        id: 'test-session-delete',
        traceId: 'trace-delete',
        traceName: 'delete.perfetto-trace',
        question: 'Delete me',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      service.saveSession(session);
      expect(service.getSession('test-session-delete')).not.toBeNull();

      const deleted = service.deleteSession('test-session-delete');
      expect(deleted).toBe(true);
      expect(service.getSession('test-session-delete')).toBeNull();
    });
  });

  describe('getSessionsByTrace', () => {
    it('should retrieve all sessions for a trace', () => {
      const service = SessionPersistenceService.getInstance();

      for (let i = 1; i <= 3; i++) {
        const session: StoredSession = {
          id: `trace-session-${i}`,
          traceId: 'shared-trace',
          traceName: 'shared.perfetto-trace',
          question: `Question ${i}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        service.saveSession(session);
      }

      const sessions = service.getSessionsByTrace('shared-trace');
      expect(sessions).toHaveLength(3);
      expect(sessions.every(s => s.traceId === 'shared-trace')).toBe(true);
    });
  });

  describe('cleanupOldSessions', () => {
    it('should delete sessions older than specified days', () => {
      const service = SessionPersistenceService.getInstance();

      const oldDate = Date.now() - 35 * 24 * 60 * 60 * 1000; // 35 days ago
      const newDate = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago

      const oldSession: StoredSession = {
        id: 'old-session',
        traceId: 'trace-old',
        traceName: 'old.perfetto-trace',
        question: 'Old question',
        createdAt: oldDate,
        updatedAt: oldDate,
        messages: [],
      };

      const newSession: StoredSession = {
        id: 'new-session',
        traceId: 'trace-new',
        traceName: 'new.perfetto-trace',
        question: 'New question',
        createdAt: newDate,
        updatedAt: newDate,
        messages: [],
      };

      service.saveSession(oldSession);
      service.saveSession(newSession);

      const deleted = service.cleanupOldSessions(30);
      expect(deleted).toBe(1);
      expect(service.getSession('old-session')).toBeNull();
      expect(service.getSession('new-session')).not.toBeNull();
    });
  });
});

describe('ResultExportService', () => {
  describe('exportToCSV', () => {
    it('should export result to CSV format', () => {
      const service = ResultExportService.getInstance();

      const result: SqlQueryResult = {
        columns: ['id', 'name', 'duration'],
        rows: [
          [1, 'ANR_1', 5000],
          [2, 'ANR_2', 3000],
        ],
        rowCount: 2,
        query: 'SELECT * FROM anr',
      };

      const exported = service.exportResult(result, { format: 'csv' });

      expect(exported.mimeType).toBe('text/csv');
      expect(exported.rowCount).toBe(2);
      expect(exported.data).toContain('id,name,duration');
      expect(exported.data).toContain('1,ANR_1,5000');
      expect(exported.filename).toMatch(/\.csv$/);
    });

    it('should handle special CSV characters', () => {
      const service = ResultExportService.getInstance();

      const result: SqlQueryResult = {
        columns: ['name', 'description'],
        rows: [
          ['Test, with comma', 'Normal'],
          ['Test "with" quotes', 'Contains "quotes"'],
        ],
        rowCount: 2,
      };

      const exported = service.exportResult(result, { format: 'csv' });

      expect(exported.data).toContain('"Test, with comma"');
      expect(exported.data).toContain('"Test ""with"" quotes"');
    });

    it('should handle null values', () => {
      const service = ResultExportService.getInstance();

      const result: SqlQueryResult = {
        columns: ['id', 'value'],
        rows: [
          [1, null],
          [2, 'test'],
        ],
        rowCount: 2,
      };

      const exported = service.exportResult(result, {
        format: 'csv',
        nullValue: 'NULL',
      });

      expect(exported.data).toContain('1,NULL');
      expect(exported.data).toContain('2,test');
    });
  });

  describe('exportToJSON', () => {
    it('should export result to JSON format', () => {
      const service = ResultExportService.getInstance();

      const result: SqlQueryResult = {
        columns: ['timestamp', 'name', 'value'],
        rows: [
          [1000, 'test1', 42],
          [2000, 'test2', 43],
        ],
        rowCount: 2,
        query: 'SELECT * FROM test',
      };

      const exported = service.exportResult(result, { format: 'json' });

      expect(exported.mimeType).toBe('application/json');
      expect(exported.rowCount).toBe(2);
      expect(exported.filename).toMatch(/\.json$/);

      const parsed = JSON.parse(exported.data);
      expect(parsed).toHaveProperty('exportedAt');
      expect(parsed).toHaveProperty('rowCount', 2);
      expect(parsed).toHaveProperty('columns');
      expect(parsed).toHaveProperty('rows');
      expect(parsed.query).toBe('SELECT * FROM test');
    });

    it('should support compact JSON output', () => {
      const service = ResultExportService.getInstance();

      const result: SqlQueryResult = {
        columns: ['id'],
        rows: [[1], [2]],
        rowCount: 2,
      };

      const pretty = service.exportResult(result, {
        format: 'json',
        prettyPrint: true,
      });

      const compact = service.exportResult(result, {
        format: 'json',
        prettyPrint: false,
      });

      expect(compact.data.length).toBeLessThan(pretty.data.length);
    });
  });

  describe('exportSession', () => {
    it('should export multiple results to JSON', () => {
      const service = ResultExportService.getInstance();

      const results = [
        {
          name: 'ANR Analysis',
          result: {
            columns: ['id', 'duration'],
            rows: [[1, 5000]],
            rowCount: 1,
          },
        },
        {
          name: 'Jank Analysis',
          result: {
            columns: ['frame', 'jank'],
            rows: [[100, true]],
            rowCount: 1,
          },
        },
      ];

      const exported = service.exportSession(results, { format: 'json' });

      expect(exported.mimeType).toBe('application/json');
      expect(exported.filename).toMatch(/session-export/);

      const parsed = JSON.parse(exported.data);
      expect(parsed.totalResults).toBe(2);
      expect(parsed.totalRows).toBe(2);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0].name).toBe('ANR Analysis');
    });

    it('should export multiple results to CSV', () => {
      const service = ResultExportService.getInstance();

      const results = [
        {
          name: 'ANR Analysis',
          result: {
            columns: ['id', 'duration'],
            rows: [[1, 5000]],
            rowCount: 1,
          },
        },
      ];

      const exported = service.exportSession(results, { format: 'csv' });

      expect(exported.mimeType).toBe('text/csv');
      expect(exported.data).toContain('=== ANR Analysis ===');
      expect(exported.data).toContain('id,duration');
    });
  });
});
