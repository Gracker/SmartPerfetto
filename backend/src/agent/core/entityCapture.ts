// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Entity Capture Module
 *
 * Extracts Frame and Session entities from AgentResponse outputs.
 * The runtime applies the captured entities to the session EntityStore.
 *
 * Parsing targets:
 * - scroll_sessions (from scroll_session_analysis/scrolling_analysis): SessionEntity[]
 * - get_app_jank_frames (from scrolling_analysis): FrameEntity[]
 * - jank_frames (from jank_frame_detail): FrameEntity[]
 *
 * Payloads can be either:
 * - Array of objects: [{ frame_id: 1, ... }, ...]
 * - Columnar format: { columns: [...], rows: [[...], ...] }
 */

import type { AgentResponse, AgentToolResult } from '../types/agentProtocol';
import type {
  EntityStore,
  FrameEntity,
  SessionEntity,
  CpuSliceEntity,
  BinderEntity,
  GcEntity,
  MemoryEntity,
  GenericEntity,
  EntityId,
} from '../context/entityStore';
import { EntityCaptureKind, resolveCaptureEntityKindByStepId } from './entityRegistry';
import {rowObject} from '../../utils/traceProcessorRowUtils';

// =============================================================================
// Types
// =============================================================================

export interface CapturedEntities {
  frames: FrameEntity[];
  sessions: SessionEntity[];
  // Phase 3: New entity types
  cpuSlices: CpuSliceEntity[];
  binders: BinderEntity[];
  gcs: GcEntity[];
  memories: MemoryEntity[];
  generics: GenericEntity[];
  // Candidate lists for extend support
  candidateFrameIds: EntityId[];
  candidateSessionIds: EntityId[];
}

// =============================================================================
// Main Capture Function
// =============================================================================

/**
 * Create an empty CapturedEntities object.
 */
export function createEmptyCapturedEntities(): CapturedEntities {
  return {
    frames: [],
    sessions: [],
    cpuSlices: [],
    binders: [],
    gcs: [],
    memories: [],
    generics: [],
    candidateFrameIds: [],
    candidateSessionIds: [],
  };
}

/**
 * Extract entities from a batch of AgentResponse objects.
 * Typically called after a strategy stage completes.
 */
export function captureEntitiesFromResponses(responses: AgentResponse[]): CapturedEntities {
  const result = createEmptyCapturedEntities();

  for (const response of responses) {
    if (!response.toolResults) continue;

    for (const toolResult of response.toolResults) {
      captureFromToolResult(toolResult, result);
    }
  }

  // Deduplicate by ID
  result.frames = deduplicateById(result.frames, 'frame_id');
  result.sessions = deduplicateById(result.sessions, 'session_id');
  result.cpuSlices = deduplicateById(result.cpuSlices, 'slice_id');
  result.binders = deduplicateById(result.binders, 'transaction_id');
  result.gcs = deduplicateById(result.gcs, 'gc_id');
  result.memories = deduplicateById(result.memories, 'memory_id');
  result.generics = deduplicateById(result.generics, 'entity_id');
  result.candidateFrameIds = [...new Set(result.candidateFrameIds)];
  result.candidateSessionIds = [...new Set(result.candidateSessionIds)];

  return result;
}

/**
 * Apply captured entities to the store.
 * This is the single write-back point into the EntityStore.
 */
export function applyCapturedEntities(store: EntityStore, captured: CapturedEntities): void {
  // Upsert core entities
  store.upsertFrames(captured.frames);
  store.upsertSessions(captured.sessions);

  // Upsert Phase 3 entities
  if (captured.cpuSlices?.length > 0) {
    store.upsertCpuSlices(captured.cpuSlices);
  }
  if (captured.binders?.length > 0) {
    store.upsertBinders(captured.binders);
  }
  if (captured.gcs?.length > 0) {
    store.upsertGcs(captured.gcs);
  }
  if (captured.memories?.length > 0) {
    store.upsertMemories(captured.memories);
  }
  if (captured.generics?.length > 0) {
    store.upsertGenerics(captured.generics);
  }

  // Update candidate lists (only if non-empty to avoid clearing previous)
  if (captured.candidateFrameIds.length > 0) {
    store.setLastCandidateFrames(captured.candidateFrameIds);
  }
  if (captured.candidateSessionIds.length > 0) {
    store.setLastCandidateSessions(captured.candidateSessionIds);
  }
}

// =============================================================================
// Internal Parsing
// =============================================================================

function captureFromToolResult(toolResult: AgentToolResult, result: CapturedEntities): void {
  if (!toolResult.data) return;

  if (typeof toolResult.data !== 'object' || Array.isArray(toolResult.data)) {
    return;
  }
  const data = toolResult.data as Record<string, any>;

  // Exact step id matching for direct tool result payloads
  for (const [stepId, payload] of Object.entries(data)) {
    const kind = resolveCaptureEntityKindByStepId(stepId, 'exact');
    if (!kind) continue;
    applyCaptureByKind(kind, payload, result);
  }

  // Also check dataEnvelopes if present
  if (toolResult.dataEnvelopes) {
    for (const envelope of toolResult.dataEnvelopes) {
      const stepId = envelope.meta?.stepId || '';
      const envelopeData = envelope.data;
      const kind = resolveCaptureEntityKindByStepId(stepId, 'contains');
      if (!kind) continue;
      applyCaptureByKind(kind, envelopeData, result);
    }
  }
}

function applyCaptureByKind(kind: EntityCaptureKind, payload: any, result: CapturedEntities): void {
  switch (kind) {
    case 'frame': {
      const frames = parseFrames(payload);
      result.frames.push(...frames);
      result.candidateFrameIds.push(...frames.map(f => f.frame_id));
      break;
    }
    case 'session': {
      const sessions = parseSessions(payload);
      result.sessions.push(...sessions);
      result.candidateSessionIds.push(...sessions.map(s => s.session_id));
      break;
    }
    case 'cpu_slice': {
      const slices = parseCpuSlices(payload);
      result.cpuSlices.push(...slices);
      break;
    }
    case 'binder': {
      const binders = parseBinders(payload);
      result.binders.push(...binders);
      break;
    }
    case 'gc': {
      const gcs = parseGcs(payload);
      result.gcs.push(...gcs);
      break;
    }
    case 'memory': {
      const memories = parseMemories(payload);
      result.memories.push(...memories);
      break;
    }
  }
}

/**
 * Parse frame entities from various data formats.
 */
function parseFrames(payload: any): FrameEntity[] {
  const rows = normalizeToRows(payload);
  const frames: FrameEntity[] = [];

  for (const row of rows) {
    const frameId = getFieldValue(row, 'frame_id', 'frameId', 'id');
    if (frameId === undefined || frameId === null) continue;

    frames.push({
      frame_id: String(frameId),
      start_ts: stringifyTs(getFieldValue(row, 'start_ts', 'startTs', 'ts')),
      end_ts: stringifyTs(getFieldValue(row, 'end_ts', 'endTs')),
      process_name: getFieldValue(row, 'process_name', 'processName', 'package'),
      session_id: stringifyId(getFieldValue(row, 'session_id', 'sessionId')),
      jank_type: getFieldValue(row, 'jank_type', 'jankType'),
      dur_ms: getFieldValue(row, 'dur_ms', 'durMs', 'dur'),
      main_start_ts: stringifyTs(getFieldValue(row, 'main_start_ts', 'mainStartTs')),
      main_end_ts: stringifyTs(getFieldValue(row, 'main_end_ts', 'mainEndTs')),
      render_start_ts: stringifyTs(getFieldValue(row, 'render_start_ts', 'renderStartTs')),
      render_end_ts: stringifyTs(getFieldValue(row, 'render_end_ts', 'renderEndTs')),
      pid: getFieldValue(row, 'pid'),
      layer_name: getFieldValue(row, 'layer_name', 'layerName'),
      vsync_missed: getFieldValue(row, 'vsync_missed', 'vsyncMissed'),
      token_gap: getFieldValue(row, 'token_gap', 'tokenGap'),
      jank_responsibility: getFieldValue(row, 'jank_responsibility', 'jankResponsibility'),
      frame_index: getFieldValue(row, 'frame_index', 'frameIndex'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return frames;
}

/**
 * Parse session entities from various data formats.
 */
function parseSessions(payload: any): SessionEntity[] {
  const rows = normalizeToRows(payload);
  const sessions: SessionEntity[] = [];

  for (const row of rows) {
    const sessionId = getFieldValue(row, 'session_id', 'sessionId', 'id');
    if (sessionId === undefined || sessionId === null) continue;

    sessions.push({
      session_id: String(sessionId),
      start_ts: stringifyTs(getFieldValue(row, 'start_ts', 'startTs', 'ts')),
      end_ts: stringifyTs(getFieldValue(row, 'end_ts', 'endTs')),
      process_name: getFieldValue(row, 'process_name', 'processName', 'package'),
      frame_count: getFieldValue(row, 'frame_count', 'frameCount', 'total_frames'),
      jank_count: getFieldValue(row, 'jank_count', 'jankCount', 'jank_frames'),
      max_vsync_missed: getFieldValue(row, 'max_vsync_missed', 'maxVsyncMissed'),
      jank_types: getFieldValue(row, 'jank_types', 'jankTypes'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return sessions;
}

/**
 * Parse CPU slice entities from various data formats.
 */
function parseCpuSlices(payload: any): CpuSliceEntity[] {
  const rows = normalizeToRows(payload);
  const slices: CpuSliceEntity[] = [];

  for (const row of rows) {
    const sliceId = getFieldValue(row, 'slice_id', 'sliceId', 'id', 'utid');
    if (sliceId === undefined || sliceId === null) continue;

    slices.push({
      slice_id: String(sliceId),
      start_ts: stringifyTs(getFieldValue(row, 'start_ts', 'startTs', 'ts')),
      end_ts: stringifyTs(getFieldValue(row, 'end_ts', 'endTs')),
      dur_ns: getFieldValue(row, 'dur_ns', 'durNs', 'dur'),
      cpu: getFieldValue(row, 'cpu'),
      tid: getFieldValue(row, 'tid'),
      pid: getFieldValue(row, 'pid'),
      process_name: getFieldValue(row, 'process_name', 'processName'),
      thread_name: getFieldValue(row, 'thread_name', 'threadName'),
      state: getFieldValue(row, 'state'),
      priority: getFieldValue(row, 'priority', 'prio'),
      utid: getFieldValue(row, 'utid'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return slices;
}

/**
 * Parse Binder transaction entities from various data formats.
 */
function parseBinders(payload: any): BinderEntity[] {
  const rows = normalizeToRows(payload);
  const binders: BinderEntity[] = [];

  for (const row of rows) {
    const transactionId = getFieldValue(row, 'transaction_id', 'transactionId', 'id', 'binder_id');
    if (transactionId === undefined || transactionId === null) continue;

    binders.push({
      transaction_id: String(transactionId),
      start_ts: stringifyTs(getFieldValue(row, 'start_ts', 'startTs', 'ts')),
      end_ts: stringifyTs(getFieldValue(row, 'end_ts', 'endTs')),
      dur_ns: getFieldValue(row, 'dur_ns', 'durNs', 'dur'),
      client_pid: getFieldValue(row, 'client_pid', 'clientPid'),
      client_tid: getFieldValue(row, 'client_tid', 'clientTid'),
      client_process: getFieldValue(row, 'client_process', 'clientProcess'),
      client_thread: getFieldValue(row, 'client_thread', 'clientThread'),
      server_pid: getFieldValue(row, 'server_pid', 'serverPid'),
      server_tid: getFieldValue(row, 'server_tid', 'serverTid'),
      server_process: getFieldValue(row, 'server_process', 'serverProcess'),
      server_thread: getFieldValue(row, 'server_thread', 'serverThread'),
      reply_ts: stringifyTs(getFieldValue(row, 'reply_ts', 'replyTs')),
      code: getFieldValue(row, 'code'),
      flags: getFieldValue(row, 'flags'),
      is_oneway: getFieldValue(row, 'is_oneway', 'isOneway'),
      is_reply: getFieldValue(row, 'is_reply', 'isReply'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return binders;
}

/**
 * Parse GC event entities from various data formats.
 */
function parseGcs(payload: any): GcEntity[] {
  const rows = normalizeToRows(payload);
  const gcs: GcEntity[] = [];

  for (const row of rows) {
    const gcId = getFieldValue(row, 'gc_id', 'gcId', 'id');
    if (gcId === undefined || gcId === null) continue;

    gcs.push({
      gc_id: String(gcId),
      start_ts: stringifyTs(getFieldValue(row, 'start_ts', 'startTs', 'ts')),
      end_ts: stringifyTs(getFieldValue(row, 'end_ts', 'endTs')),
      dur_ns: getFieldValue(row, 'dur_ns', 'durNs', 'dur'),
      pid: getFieldValue(row, 'pid'),
      process_name: getFieldValue(row, 'process_name', 'processName'),
      gc_type: getFieldValue(row, 'gc_type', 'gcType', 'type'),
      gc_reason: getFieldValue(row, 'gc_reason', 'gcReason', 'reason'),
      freed_bytes: getFieldValue(row, 'freed_bytes', 'freedBytes'),
      freed_objects: getFieldValue(row, 'freed_objects', 'freedObjects'),
      pause_time_ns: getFieldValue(row, 'pause_time_ns', 'pauseTimeNs'),
      is_blocking: getFieldValue(row, 'is_blocking', 'isBlocking'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return gcs;
}

/**
 * Parse memory event entities from various data formats.
 */
function parseMemories(payload: any): MemoryEntity[] {
  const rows = normalizeToRows(payload);
  const memories: MemoryEntity[] = [];

  for (const row of rows) {
    const memoryId = getFieldValue(row, 'memory_id', 'memoryId', 'id');
    if (memoryId === undefined || memoryId === null) continue;

    memories.push({
      memory_id: String(memoryId),
      ts: stringifyTs(getFieldValue(row, 'ts', 'timestamp')),
      pid: getFieldValue(row, 'pid'),
      process_name: getFieldValue(row, 'process_name', 'processName'),
      event_type: getFieldValue(row, 'event_type', 'eventType', 'type'),
      size_bytes: getFieldValue(row, 'size_bytes', 'sizeBytes', 'size'),
      address: getFieldValue(row, 'address', 'addr'),
      heap_name: getFieldValue(row, 'heap_name', 'heapName'),
      oom_score: getFieldValue(row, 'oom_score', 'oomScore'),
      rss_bytes: getFieldValue(row, 'rss_bytes', 'rssBytes', 'rss'),
      anon_bytes: getFieldValue(row, 'anon_bytes', 'anonBytes'),
      swap_bytes: getFieldValue(row, 'swap_bytes', 'swapBytes'),
      source: 'table',
      updated_at: Date.now(),
    });
  }

  return memories;
}

/**
 * Normalize columnar or array payload to array of row objects.
 */
function normalizeToRows(payload: any): Array<Record<string, any>> {
  if (!payload) return [];

  // Already an array of objects
  if (Array.isArray(payload)) {
    return payload.filter(item => item && typeof item === 'object');
  }

  // Columnar format: { columns: [...], rows: [[...], ...] }
  if (payload.columns && Array.isArray(payload.rows)) {
    const columns: string[] = payload.columns;
    return payload.rows.map((row: any[]) => rowObject(columns, row));
  }

  // rows property is array of objects
  if (payload.rows && Array.isArray(payload.rows) && payload.rows[0] && typeof payload.rows[0] === 'object') {
    return payload.rows;
  }

  return [];
}

/**
 * Get a field value trying multiple key variations.
 */
function getFieldValue(obj: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

/**
 * Stringify timestamp values, handling BigInt.
 */
function stringifyTs(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/**
 * Stringify ID values.
 */
function stringifyId(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/**
 * Deduplicate entities by ID field.
 */
function deduplicateById<T>(items: T[], idField: keyof T): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const id = String((item as any)[idField]);
    if (id && !seen.has(id)) {
      seen.set(id, item);
    }
  }
  return Array.from(seen.values());
}