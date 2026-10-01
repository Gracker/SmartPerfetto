// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SessionPersistenceService Unit Tests - Phase 3 Features
 *
 * Tests for EntityStore and SessionContext persistence across restarts.
 */

import { SessionPersistenceService } from '../sessionPersistenceService';
import { createEntityStore } from '../../agent/context/entityStore';
import { EnhancedSessionContext } from '../../agent/context/enhancedSessionContext';
import { FocusStore } from '../../agent/context/focusStore';
import { createInitialTraceAgentState } from '../../agent/state/traceAgentState';
import { StoredSession } from '../../models/sessionSchema';
import { inspect } from 'util';
import { consoleCallsDuring, warningsDuring } from '../../../tests/helpers/consoleWarnings';

describe('SessionPersistenceService - Phase 3 Features', () => {
  let service: SessionPersistenceService;

  beforeEach(() => {
    // Get singleton instance
    service = SessionPersistenceService.getInstance();
  });

  // Helper to create a test session
  function createTestSession(id: string): StoredSession {
    return {
      id,
      traceId: `trace_${id}`,
      traceName: `test_trace_${id}.perfetto-trace`,
      question: 'Test analysis question',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          id: `msg_${id}_1`,
          role: 'user',
          content: 'Test user message',
          timestamp: Date.now(),
        },
        {
          id: `msg_${id}_2`,
          role: 'assistant',
          content: 'Test assistant response',
          timestamp: Date.now() + 1000,
        },
      ],
    };
  }

  describe('EntityStore Persistence', () => {
    const testSessionId = `test_entitystore_${Date.now()}`;

    afterEach(() => {
      // Cleanup test session
      service.deleteSession(testSessionId);
    });

    test('saveEntityStore and loadEntityStore round-trip', () => {
      // Create and save a session first
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create an EntityStore with various entities
      const store = createEntityStore();
      store.upsertFrame({
        frame_id: '1436069',
        start_ts: '123456789000000',
        end_ts: '123456889000000',
        process_name: 'com.example.app',
        jank_type: 'App Deadline Missed',
      });
      store.upsertSession({
        session_id: '1',
        start_ts: '100000000000000',
        end_ts: '200000000000000',
        frame_count: 120,
        jank_count: 5,
      });
      store.upsertCpuSlice({
        slice_id: 'cpu_1',
        thread_name: 'RenderThread',
        cpu: 4,
      });
      store.markFrameAnalyzed('1436069');
      store.setLastCandidateFrames(['1436069', '1436070']);

      // Save EntityStore
      const saved = service.saveEntityStore(testSessionId, store);
      expect(saved).toBe(true);

      // Load EntityStore
      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).not.toBeNull();

      // Verify frames
      const frame = loaded!.getFrame('1436069');
      expect(frame).toBeDefined();
      expect(frame?.jank_type).toBe('App Deadline Missed');
      expect(loaded!.wasFrameAnalyzed('1436069')).toBe(true);

      // Verify sessions
      const scrollSession = loaded!.getSession('1');
      expect(scrollSession).toBeDefined();
      expect(scrollSession?.frame_count).toBe(120);

      // Verify CPU slices (Phase 3)
      const cpuSlice = loaded!.getCpuSlice('cpu_1');
      expect(cpuSlice).toBeDefined();
      expect(cpuSlice?.thread_name).toBe('RenderThread');

      // Verify candidate lists
      expect(loaded!.getLastCandidateFrames()).toEqual(['1436069', '1436070']);
    });

    test('hasEntityStore returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Initially no EntityStore
      expect(service.hasEntityStore(testSessionId)).toBe(false);

      // Save EntityStore
      const store = createEntityStore();
      store.upsertFrame({ frame_id: '1' });
      service.saveEntityStore(testSessionId, store);

      // Now has EntityStore
      expect(service.hasEntityStore(testSessionId)).toBe(true);
    });

    test('getEntityStoreStats returns entity counts', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create EntityStore with multiple entities
      const store = createEntityStore();
      store.upsertFrame({ frame_id: '1' });
      store.upsertFrame({ frame_id: '2' });
      store.upsertSession({ session_id: '1' });
      store.markFrameAnalyzed('1');
      service.saveEntityStore(testSessionId, store);

      // Get stats
      const stats = service.getEntityStoreStats(testSessionId);
      expect(stats).not.toBeNull();
      expect(stats?.frameCount).toBe(2);
      expect(stats?.sessionCount).toBe(1);
      expect(stats?.analyzedFrameCount).toBe(1);
    });

    test('loadEntityStore returns null for session without EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).toBeNull();
    });

    test('saveEntityStore fails for non-existent session', () => {
      const store = createEntityStore();
      const saved = service.saveEntityStore('non_existent_session', store);
      expect(saved).toBe(false);
    });
  });

  describe('SessionContext Persistence', () => {
    const testSessionId = `test_context_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('saveSessionContext and loadSessionContext round-trip', () => {
      // Create and save a session first
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Create an EnhancedSessionContext
      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      context.addTurn('What are the janky frames?', {
        primaryGoal: 'jank_analysis',
        aspects: ['frame_timing'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
      });

      // Add some entities to the context's EntityStore
      const entityStore = context.getEntityStore();
      entityStore.upsertFrame({
        frame_id: '1',
        start_ts: '100',
        jank_type: 'Buffer Stuffing',
      });

      // Save context
      const saved = service.saveSessionContext(testSessionId, context);
      expect(saved).toBe(true);

      // Load context
      const loaded = service.loadSessionContext(testSessionId);
      expect(loaded).not.toBeNull();

      // Verify conversation history
      const turns = loaded!.getAllTurns();
      expect(turns.length).toBeGreaterThan(0);

      // Verify EntityStore was restored
      const loadedStore = loaded!.getEntityStore();
      const frame = loadedStore.getFrame('1');
      expect(frame).toBeDefined();
      expect(frame?.jank_type).toBe('Buffer Stuffing');
    });

    test('hasSessionContext returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      expect(service.hasSessionContext(testSessionId)).toBe(false);

      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      service.saveSessionContext(testSessionId, context);

      expect(service.hasSessionContext(testSessionId)).toBe(true);
    });

    test('saveSessionContext also saves EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const context = new EnhancedSessionContext(testSessionId, 'trace_1');
      const entityStore = context.getEntityStore();
      entityStore.upsertFrame({ frame_id: '999', start_ts: '999' });

      service.saveSessionContext(testSessionId, context);

      // Should be able to load EntityStore independently
      const loadedStore = service.loadEntityStore(testSessionId);
      expect(loadedStore).not.toBeNull();
      expect(loadedStore?.getFrame('999')).toBeDefined();
    });
  });

  describe('FocusStore Persistence', () => {
    const testSessionId = `test_focus_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('saveFocusStore and loadFocusStore round-trip (BigInt-safe)', () => {
      // Create and save a session first
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const focusStore = new FocusStore();

      // Entity focus
      focusStore.recordEntityClick('frame', '1436069');

      // Time range focus (use BigInt to validate JSON-safe normalization)
      focusStore.recordTimeRangeClick(BigInt(1000), BigInt(2000));

      // Question focus
      focusStore.recordQuestion('为什么会卡顿？', 'performance');

      // Persist
      const saved = service.saveFocusStore(testSessionId, focusStore);
      expect(saved).toBe(true);

      // Load snapshot
      const snapshot = service.loadFocusStore(testSessionId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.focuses?.length).toBeGreaterThan(0);

      // Ensure BigInt-like fields are JSON-safe strings
      const timeFocus = snapshot!.focuses.find(f => f.type === 'timeRange');
      expect(timeFocus).toBeDefined();
      expect(typeof timeFocus?.target?.timeRange?.start).toBe('string');
      expect(typeof timeFocus?.target?.timeRange?.end).toBe('string');

      // Rehydrate and validate behavior
      const restored = FocusStore.deserialize(snapshot!);
      const top = restored.getTopFocuses(3);
      expect(top.length).toBeGreaterThan(0);
    });

    test('hasFocusStore returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      expect(service.hasFocusStore(testSessionId)).toBe(false);

      const focusStore = new FocusStore();
      focusStore.recordQuestion('Test', 'performance');
      service.saveFocusStore(testSessionId, focusStore);

      expect(service.hasFocusStore(testSessionId)).toBe(true);
    });
  });

  describe('TraceAgentState Persistence', () => {
    const testSessionId = `test_trace_state_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('saveTraceAgentState and loadTraceAgentState round-trip', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const state = createInitialTraceAgentState({
        sessionId: testSessionId,
        traceId: `trace_${testSessionId}`,
        userGoal: '分析卡顿根因',
        now: Date.now(),
      });
      state.goal.normalizedGoal = 'scrolling_jank_root_cause';
      state.turnLog.push({
        id: 'turn-1',
        turnIndex: 0,
        timestamp: Date.now(),
        query: '为什么会卡顿？',
        conclusionSummary: '主线程长 runnable',
        confidence: 0.7,
      });

      const saved = service.saveTraceAgentState(testSessionId, state);
      expect(saved).toBe(true);

      const loaded = service.loadTraceAgentState(testSessionId);
      expect(loaded).not.toBeNull();
      expect(loaded?.goal?.userGoal).toBe('分析卡顿根因');
      expect(loaded?.goal?.normalizedGoal).toBe('scrolling_jank_root_cause');
      expect(Array.isArray(loaded?.turnLog)).toBe(true);
      expect(loaded?.turnLog?.length).toBeGreaterThan(0);
    });

    test('hasTraceAgentState returns correct status', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      expect(service.hasTraceAgentState(testSessionId)).toBe(false);

      const state = createInitialTraceAgentState({
        sessionId: testSessionId,
        traceId: `trace_${testSessionId}`,
        userGoal: 'Test',
      });
      service.saveTraceAgentState(testSessionId, state);

      expect(service.hasTraceAgentState(testSessionId)).toBe(true);
    });
  });

  describe('Cross-Restart Simulation', () => {
    const testSessionId = `test_restart_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('EntityStore survives simulated process restart', () => {
      // Phase 1: Initial session
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store1 = createEntityStore();
      store1.upsertFrame({ frame_id: '1', jank_type: 'App Deadline Missed' });
      store1.upsertFrame({ frame_id: '2', jank_type: 'Buffer Stuffing' });
      store1.markFrameAnalyzed('1');
      service.saveEntityStore(testSessionId, store1);

      // Phase 2: Simulate restart by creating new store from persistence
      const store2 = service.loadEntityStore(testSessionId);
      expect(store2).not.toBeNull();

      // Verify state was preserved
      expect(store2!.getAllFrames()).toHaveLength(2);
      expect(store2!.wasFrameAnalyzed('1')).toBe(true);
      expect(store2!.wasFrameAnalyzed('2')).toBe(false);

      // Phase 3: Continue working with restored store
      store2!.markFrameAnalyzed('2');
      store2!.upsertFrame({ frame_id: '3', jank_type: 'SurfaceFlinger Scheduling' });
      service.saveEntityStore(testSessionId, store2!);

      // Phase 4: Another restart
      const store3 = service.loadEntityStore(testSessionId);
      expect(store3!.getAllFrames()).toHaveLength(3);
      expect(store3!.wasFrameAnalyzed('1')).toBe(true);
      expect(store3!.wasFrameAnalyzed('2')).toBe(true);
      expect(store3!.wasFrameAnalyzed('3')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    const testSessionId = `test_edge_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('handles empty EntityStore', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store = createEntityStore();
      service.saveEntityStore(testSessionId, store);

      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.getAllFrames()).toHaveLength(0);
      expect(loaded!.getAllSessions()).toHaveLength(0);
    });

    test('handles large entity IDs (BigInt range)', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      const store = createEntityStore();
      const bigId = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
      store.upsertFrame({ frame_id: bigId, start_ts: '100' });
      service.saveEntityStore(testSessionId, store);

      const loaded = service.loadEntityStore(testSessionId);
      const frame = loaded!.getFrame(bigId);
      expect(frame).toBeDefined();
      expect(frame?.frame_id).toBe(bigId);
    });

    test('overwrites previous EntityStore on save', () => {
      const session = createTestSession(testSessionId);
      service.saveSession(session);

      // Save first version
      const store1 = createEntityStore();
      store1.upsertFrame({ frame_id: '1', jank_type: 'Type A' });
      service.saveEntityStore(testSessionId, store1);

      // Save second version (different data)
      const store2 = createEntityStore();
      store2.upsertFrame({ frame_id: '2', jank_type: 'Type B' });
      service.saveEntityStore(testSessionId, store2);

      // Load should return second version
      const loaded = service.loadEntityStore(testSessionId);
      expect(loaded!.getFrame('1')).toBeUndefined(); // First version data gone
      expect(loaded!.getFrame('2')?.jank_type).toBe('Type B');
    });
  });

  describe('SQL result message persistence', () => {
    const testSessionId = `test_sql_result_message_${Date.now()}`;

    afterEach(() => {
      service.deleteSession(testSessionId);
    });

    test('appendMessages stores and getSession restores sqlResult payloads', () => {
      service.saveSession(createTestSession(testSessionId));
      const sqlResult = {
        schemaVersion: 'sql_result_message_v1',
        resultCount: 1,
        results: [{
          title: 'SQL Query (1 rows)',
          data: {columns: ['dur_ms'], rows: [[42]]},
          sql: 'SELECT 42 AS dur_ms',
        }],
      };

      service.appendMessages(testSessionId, [{
        id: `${testSessionId}-assistant-sql`,
        role: 'assistant',
        content: 'SQL done',
        timestamp: Date.now(),
        sqlResult,
      }]);

      const restored = service.getSession(testSessionId);
      const assistant = restored?.messages.find(message => message.id === `${testSessionId}-assistant-sql`);
      expect(assistant?.sqlResult).toEqual(sqlResult);
    });

    test('loadSessionContext hydrates recent SQL results into resumed prompt context', () => {
      service.saveSession(createTestSession(testSessionId));
      const context = new EnhancedSessionContext(testSessionId, `trace_${testSessionId}`);
      expect(service.saveSessionContext(testSessionId, context)).toBe(true);

      service.appendMessages(testSessionId, [{
        id: `${testSessionId}-assistant-sql-context`,
        role: 'assistant',
        content: 'SQL done',
        timestamp: Date.now(),
        sqlResult: {
          schemaVersion: 'sql_result_message_v1',
          resultCount: 1,
          results: [{
            title: 'Recent raw SQL',
            sql: 'SELECT 42 AS dur_ms',
            data: {columns: ['dur_ms'], rows: [[42]]},
          }],
        },
      }]);

      const restored = service.loadSessionContext(testSessionId);
      const promptContext = restored?.generatePromptContext(2000);

      expect(promptContext).toContain('Recent raw SQL');
      expect(promptContext).toContain('SELECT 42 AS dur_ms');
      expect(promptContext).toContain('dur_ms');
      expect(promptContext).toContain('42');
    });

    test('saveSessionStateSnapshot mirrors lineage into list-session metadata', () => {
      const sessionId = `${testSessionId}_lineage`;
      const lineage = {
        previousBackendSessionId: 'backend-before-level3',
        reason: 'cli-level3-degraded' as const,
        at: 1_780_000_000_000,
      };

      service.saveSessionStateSnapshot(sessionId, {
        version: 1,
        snapshotTimestamp: 1_780_000_000_100,
        sessionId,
        traceId: `trace_${sessionId}`,
        lineage,
        conversationSteps: [],
        queryHistory: [{turn: 1, query: '继续分析', timestamp: 1_780_000_000_000}],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        analysisNotes: [],
        analysisPlan: null,
        planHistory: [],
        uncertaintyFlags: [],
        runSequence: 1,
        conversationOrdinal: 0,
      });

      const listed = service.listSessions({traceId: `trace_${sessionId}`}).sessions[0];
      expect(listed.metadata?.lineage).toEqual(lineage);

      service.deleteSession(sessionId);
    });

    test('clearPrivateContext overwrites legacy model-authored SQLite metadata', () => {
      const sessionId = `${testSessionId}_private_clear`;
      const canary = 'PRIVATE_SQLITE_METADATA_CANARY';
      service.saveSession({
        ...createTestSession(sessionId),
        metadata: {
          sessionStateSnapshot: {conversationSteps: [{content: canary}]},
          runtimeArraysSnapshot: {analysisNotes: [{content: canary}]},
          sessionContextSnapshot: {summary: canary},
          entityStoreSnapshot: {entities: [{value: canary}]},
          focusStoreSnapshot: {items: [{description: canary}]},
          traceAgentStateSnapshot: {notes: canary},
          architectureSnapshot: {framework: canary},
          lineage: {reason: canary},
        } as any,
      });

      service.saveSessionStateSnapshot(sessionId, {
        version: 1,
        snapshotTimestamp: Date.now(),
        sessionId,
        traceId: `trace_${sessionId}`,
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        analysisNotes: [],
        analysisPlan: null,
        planHistory: [],
        uncertaintyFlags: [],
        runSequence: 1,
        conversationOrdinal: 0,
      }, {clearPrivateContext: true});

      const metadata = service.getSession(sessionId)?.metadata;
      expect(JSON.stringify(metadata)).not.toContain(canary);
      expect(metadata?.runtimeArraysSnapshot).toEqual(expect.objectContaining({
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        analysisNotes: [],
      }));
      service.deleteSession(sessionId);
    });
  });
});

describe('SessionPersistenceService - unreadable stored JSON', () => {
  // Unquoted, so V8 quotes the text around it in its own message.
  const CANARY = 'SESSION-CANARY-5c1e';
  const service = SessionPersistenceService.getInstance();
  const db = (service as unknown as {db: {prepare(sql: string): {run(...values: unknown[]): unknown}}}).db;
  const id = `test_unreadable_${Date.now()}`;
  const session = (): StoredSession => ({id, traceId: `trace_${id}`, traceName: 'trace', question: 'question',
    createdAt: Date.now(), updatedAt: Date.now(), metadata: {ownerUserId: 'owner-1'}, messages: [
      {id: `msg_${id}_1`, role: 'assistant', content: 'answer', timestamp: Date.now(),
        sqlResult: {columns: ['a'], rows: [[1]], rowCount: 1} as never}]});
  afterEach(() => { service.deleteSession(id); });

  test('reads a session whose owner metadata cannot be parsed as missing, and quotes none of it', () => {
    expect(service.saveSession(session())).toBe(true);
    db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(`{"ownerUserId":[${CANARY} x]}`, id);
    const warnings = warningsDuring(() => {
      expect(service.getSession(id)).toBeNull();
      // Skipped, yet still counted: the page math stays that of the stored rows.
      expect(service.listSessions({traceId: `trace_${id}`})).toMatchObject({sessions: [], totalCount: 1, hasMore: false});
    });
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain(CANARY);
  });

  test('loads no context from an unparsable nested snapshot, and logs none of its text', () => {
    // The metadata is valid JSON; the snapshot inside it is a JSON string of its own.
    expect(service.saveSession({...session(), metadata: {ownerUserId: 'owner-1',
      sessionContextSnapshot: `[${CANARY} x]`} as never})).toBe(true);
    let context: unknown = 'not loaded';
    const errors = consoleCallsDuring('error', () => { context = service.loadSessionContext(id); });
    expect(context).toBeNull();
    expect(errors).toHaveLength(1);
    // V8 quotes the ten or so characters at the failure.
    expect(inspect(errors, {depth: 5})).not.toContain('SESSION-CA');
  });

  test('drops only the SQL result it cannot parse', () => {
    expect(service.saveSession(session())).toBe(true);
    db.prepare('UPDATE messages SET sql_result = ? WHERE id = ?').run(`[${CANARY}]`, `msg_${id}_1`);
    let read: StoredSession | null = null;
    const warnings = warningsDuring(() => { read = service.getSession(id); });
    expect(read!.metadata?.ownerUserId).toBe('owner-1');
    expect(read!.messages).toHaveLength(1);
    expect(read!.messages[0].sqlResult).toBeUndefined();
    expect(JSON.stringify(warnings)).not.toContain(CANARY);
  });
});
