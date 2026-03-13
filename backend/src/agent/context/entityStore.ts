/**
 * EntityStore - Session-scoped Entity Cache
 *
 * Provides a deterministic cache for Frame and Session entities discovered
 * during analysis. This enables:
 * - Cache-first resolution for drill-down queries (no re-running discovery)
 * - Incremental analysis (track analyzed vs candidate entities)
 * - Stable entity data across turns (not dependent on findings.details)
 *
 * Design principles:
 * - Use string IDs to avoid >2^53 precision loss (frame tokens can be 64-bit)
 * - Snake_case canonical field names for consistency
 * - Track provenance (source: table/interval/finding/enrichment)
 * - Support serialization for session persistence
 */

// =============================================================================
// Types
// =============================================================================

/** String ID to avoid BigInt precision loss */
export type EntityId = string;

/** Supported entity types */
export type EntityType = 'frame' | 'session' | 'cpu_slice' | 'binder' | 'gc' | 'memory' | 'generic';

/**
 * Base entity interface - all entities share these fields
 */
export interface BaseEntity {
  /** Provenance tracking */
  source?: 'table' | 'interval' | 'finding' | 'enrichment';
  updated_at?: number;
}

/**
 * Frame entity - represents a single frame from scrolling/rendering analysis
 */
export interface FrameEntity extends BaseEntity {
  frame_id: EntityId;
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  process_name?: string;
  session_id?: EntityId;

  // Optional extras for jank_frame_detail (snake_case canonical)
  jank_type?: string;
  dur_ms?: number | string;
  main_start_ts?: string;
  main_end_ts?: string;
  render_start_ts?: string;
  render_end_ts?: string;
  pid?: number | string;
  layer_name?: string;
  vsync_missed?: number | string;
  token_gap?: number | string;
  jank_responsibility?: string;
  frame_index?: number | string;
}

/**
 * Session entity - represents a scroll session
 */
export interface SessionEntity extends BaseEntity {
  session_id: EntityId;
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  process_name?: string;
  frame_count?: number | string;
  jank_count?: number | string;
  max_vsync_missed?: number | string;
  jank_types?: string;
}

/**
 * CPU slice entity - represents a CPU scheduling slice
 */
export interface CpuSliceEntity extends BaseEntity {
  slice_id: EntityId;
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  dur_ns?: number | string;
  cpu?: number | string;
  tid?: number | string;
  pid?: number | string;
  process_name?: string;
  thread_name?: string;
  state?: string;         // 'Running', 'Sleeping', etc.
  priority?: number | string;
  utid?: number | string;
}

/**
 * Binder entity - represents a Binder/IPC transaction
 */
export interface BinderEntity extends BaseEntity {
  transaction_id: EntityId;
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  dur_ns?: number | string;
  client_pid?: number | string;
  client_tid?: number | string;
  client_process?: string;
  client_thread?: string;
  server_pid?: number | string;
  server_tid?: number | string;
  server_process?: string;
  server_thread?: string;
  reply_ts?: string;
  code?: number | string;
  flags?: number | string;
  is_oneway?: boolean;
  is_reply?: boolean;
}

/**
 * GC entity - represents a garbage collection event
 */
export interface GcEntity extends BaseEntity {
  gc_id: EntityId;
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  dur_ns?: number | string;
  pid?: number | string;
  process_name?: string;
  gc_type?: string;       // 'young', 'full', 'concurrent', etc.
  gc_reason?: string;
  freed_bytes?: number | string;
  freed_objects?: number | string;
  pause_time_ns?: number | string;
  is_blocking?: boolean;
}

/**
 * Memory entity - represents a memory allocation or event
 */
export interface MemoryEntity extends BaseEntity {
  memory_id: EntityId;
  ts?: string;            // ns
  pid?: number | string;
  process_name?: string;
  event_type?: string;    // 'alloc', 'free', 'oom', 'lmk', etc.
  size_bytes?: number | string;
  address?: string;
  heap_name?: string;
  oom_score?: number | string;
  rss_bytes?: number | string;
  anon_bytes?: number | string;
  swap_bytes?: number | string;
}

/**
 * Generic entity - extensible type for any other entity kind
 */
export interface GenericEntity extends BaseEntity {
  entity_id: EntityId;
  entity_type: string;    // Custom type identifier
  start_ts?: string;      // ns
  end_ts?: string;        // ns
  process_name?: string;
  pid?: number | string;
  tid?: number | string;
  /** Arbitrary additional data */
  data?: Record<string, any>;
}

/**
 * Union type for all entity types
 */
export type AnyEntity = FrameEntity | SessionEntity | CpuSliceEntity | BinderEntity | GcEntity | MemoryEntity | GenericEntity;

/**
 * Serializable snapshot for persistence
 */
export interface EntityStoreSnapshot {
  version: number;
  framesById: Array<[EntityId, FrameEntity]>;
  sessionsById: Array<[EntityId, SessionEntity]>;
  // New entity types (Phase 3)
  cpuSlicesById?: Array<[EntityId, CpuSliceEntity]>;
  bindersById?: Array<[EntityId, BinderEntity]>;
  gcsById?: Array<[EntityId, GcEntity]>;
  memoriesById?: Array<[EntityId, MemoryEntity]>;
  genericsById?: Array<[EntityId, GenericEntity]>;
  // Incremental execution support
  analyzedFrameIds: EntityId[];
  analyzedSessionIds: EntityId[];
  lastCandidateFrameIds: EntityId[];
  lastCandidateSessionIds: EntityId[];
  // Generalized analyzed tracking
  analyzedEntityIds?: Record<string, EntityId[]>;
}

const CURRENT_SNAPSHOT_VERSION = 1;

// =============================================================================
// EntityStore Class
// =============================================================================

/**
 * Session-scoped entity cache for frames, sessions, and other performance entities.
 *
 * Usage pattern:
 * 1. After strategy executor runs, capture entities from responses
 * 2. Upsert captured entities into store
 * 3. On drill-down follow-up, resolve from store (cache hit = no enrichment SQL)
 * 4. Mark analyzed entities to support "extend" (analyze more) scenarios
 *
 * Supported entity types (Phase 3):
 * - frame: Rendering frames (jank analysis)
 * - session: Scroll sessions
 * - cpu_slice: CPU scheduling slices
 * - binder: IPC/Binder transactions
 * - gc: Garbage collection events
 * - memory: Memory allocations and events
 * - generic: Extensible for any other entity type
 */
// P2-B4: Per-type entity caps to prevent unbounded growth in long sessions
const ENTITY_CAPS: Record<string, number> = {
  frame: 200,
  session: 50,
  cpu_slice: 100,
  binder: 100,
  gc: 50,
  memory: 50,
  generic: 100,
};

export class EntityStore {
  private framesById = new Map<EntityId, FrameEntity>();
  private sessionsById = new Map<EntityId, SessionEntity>();

  // New entity type storage (Phase 3)
  private cpuSlicesById = new Map<EntityId, CpuSliceEntity>();
  private bindersById = new Map<EntityId, BinderEntity>();
  private gcsById = new Map<EntityId, GcEntity>();
  private memoriesById = new Map<EntityId, MemoryEntity>();
  private genericsById = new Map<EntityId, GenericEntity>();

  // Incremental analysis tracking (P2-5: capped to prevent unbounded growth)
  private static readonly ANALYZED_SET_CAP = 500;
  private analyzedFrameIds = new Set<EntityId>();
  private analyzedSessionIds = new Set<EntityId>();
  private lastCandidateFrameIds: EntityId[] = [];
  private lastCandidateSessionIds: EntityId[] = [];

  // Generalized analyzed tracking (Phase 3)
  private analyzedEntityIds = new Map<string, Set<EntityId>>();

  // P2-B4: Evict oldest entries when a map exceeds its cap
  private enforceCapLRU<T extends BaseEntity>(map: Map<EntityId, T>, cap: number): void {
    if (map.size <= cap) return;
    // Sort by updated_at ascending, evict oldest
    const entries = Array.from(map.entries())
      .sort((a, b) => (a[1].updated_at || 0) - (b[1].updated_at || 0));
    const toRemove = entries.slice(0, map.size - cap);
    for (const [key] of toRemove) {
      map.delete(key);
    }
  }

  // ==========================================================================
  // Frame Operations
  // ==========================================================================

  /**
   * Upsert a frame entity. Merges with existing if present.
   * Newer data (by updated_at) wins for non-null fields.
   */
  upsertFrame(entity: FrameEntity): void {
    const id = normalizeId(entity.frame_id);
    if (!id) return;

    const existing = this.framesById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, frame_id: id });
      this.framesById.set(id, merged);
    } else {
      this.framesById.set(id, { ...entity, frame_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.framesById, ENTITY_CAPS.frame);
    }
  }

  /**
   * Get a frame entity by ID.
   * Tries both original ID and normalized string version.
   */
  getFrame(id: EntityId | number): FrameEntity | undefined {
    const normalized = normalizeId(id);
    return this.framesById.get(normalized);
  }

  /**
   * Get all frame entities.
   */
  getAllFrames(): FrameEntity[] {
    return Array.from(this.framesById.values());
  }

  /**
   * Mark a frame as analyzed (for extend support).
   */
  markFrameAnalyzed(id: EntityId | number): void {
    this.analyzedFrameIds.add(normalizeId(id));
    // P2-5: Cap analyzed sets to prevent unbounded growth in long sessions
    if (this.analyzedFrameIds.size > EntityStore.ANALYZED_SET_CAP) {
      const iter = this.analyzedFrameIds.values();
      this.analyzedFrameIds.delete(iter.next().value!);
    }
  }

  /**
   * Check if a frame was already analyzed in a previous drill-down.
   */
  wasFrameAnalyzed(id: EntityId | number): boolean {
    return this.analyzedFrameIds.has(normalizeId(id));
  }

  /**
   * Get all analyzed frame IDs.
   * Used by IncrementalAnalyzer to build PreviousAnalysisState.
   */
  getAnalyzedFrameIds(): EntityId[] {
    return Array.from(this.analyzedFrameIds);
  }

  /**
   * Set the candidate frame list from last discovery stage.
   * Used by extend to know which frames can be analyzed next.
   */
  setLastCandidateFrames(ids: Array<EntityId | number>): void {
    this.lastCandidateFrameIds = ids.map(normalizeId);
  }

  /**
   * Get candidate frames that haven't been analyzed yet.
   */
  getUnanalyzedCandidateFrames(): EntityId[] {
    return this.lastCandidateFrameIds.filter(id => !this.analyzedFrameIds.has(id));
  }

  /**
   * Get all candidate frame IDs from last discovery.
   */
  getLastCandidateFrames(): EntityId[] {
    return [...this.lastCandidateFrameIds];
  }

  // ==========================================================================
  // Session Operations
  // ==========================================================================

  /**
   * Upsert a session entity. Merges with existing if present.
   */
  upsertSession(entity: SessionEntity): void {
    const id = normalizeId(entity.session_id);
    if (!id) return;

    const existing = this.sessionsById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, session_id: id });
      this.sessionsById.set(id, merged);
    } else {
      this.sessionsById.set(id, { ...entity, session_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.sessionsById, ENTITY_CAPS.session);
    }
  }

  /**
   * Get a session entity by ID.
   */
  getSession(id: EntityId | number): SessionEntity | undefined {
    const normalized = normalizeId(id);
    return this.sessionsById.get(normalized);
  }

  /**
   * Get all session entities.
   */
  getAllSessions(): SessionEntity[] {
    return Array.from(this.sessionsById.values());
  }

  /**
   * Mark a session as analyzed.
   */
  markSessionAnalyzed(id: EntityId | number): void {
    this.analyzedSessionIds.add(normalizeId(id));
    if (this.analyzedSessionIds.size > EntityStore.ANALYZED_SET_CAP) {
      const iter = this.analyzedSessionIds.values();
      this.analyzedSessionIds.delete(iter.next().value!);
    }
  }

  /**
   * Check if a session was already analyzed.
   */
  wasSessionAnalyzed(id: EntityId | number): boolean {
    return this.analyzedSessionIds.has(normalizeId(id));
  }

  /**
   * Get all analyzed session IDs.
   * Used by IncrementalAnalyzer to build PreviousAnalysisState.
   */
  getAnalyzedSessionIds(): EntityId[] {
    return Array.from(this.analyzedSessionIds);
  }

  /**
   * Set the candidate session list from last discovery stage.
   */
  setLastCandidateSessions(ids: Array<EntityId | number>): void {
    this.lastCandidateSessionIds = ids.map(normalizeId);
  }

  /**
   * Get candidate sessions that haven't been analyzed yet.
   */
  getUnanalyzedCandidateSessions(): EntityId[] {
    return this.lastCandidateSessionIds.filter(id => !this.analyzedSessionIds.has(id));
  }

  /**
   * Get all candidate session IDs from last discovery.
   */
  getLastCandidateSessions(): EntityId[] {
    return [...this.lastCandidateSessionIds];
  }

  // ==========================================================================
  // CPU Slice Operations (Phase 3)
  // ==========================================================================

  /**
   * Upsert a CPU slice entity.
   */
  upsertCpuSlice(entity: CpuSliceEntity): void {
    const id = normalizeId(entity.slice_id);
    if (!id) return;

    const existing = this.cpuSlicesById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, slice_id: id });
      this.cpuSlicesById.set(id, merged);
    } else {
      this.cpuSlicesById.set(id, { ...entity, slice_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.cpuSlicesById, ENTITY_CAPS.cpu_slice);
    }
  }

  getCpuSlice(id: EntityId | number): CpuSliceEntity | undefined {
    return this.cpuSlicesById.get(normalizeId(id));
  }

  getAllCpuSlices(): CpuSliceEntity[] {
    return Array.from(this.cpuSlicesById.values());
  }

  // ==========================================================================
  // Binder Operations (Phase 3)
  // ==========================================================================

  /**
   * Upsert a Binder transaction entity.
   */
  upsertBinder(entity: BinderEntity): void {
    const id = normalizeId(entity.transaction_id);
    if (!id) return;

    const existing = this.bindersById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, transaction_id: id });
      this.bindersById.set(id, merged);
    } else {
      this.bindersById.set(id, { ...entity, transaction_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.bindersById, ENTITY_CAPS.binder);
    }
  }

  getBinder(id: EntityId | number): BinderEntity | undefined {
    return this.bindersById.get(normalizeId(id));
  }

  getAllBinders(): BinderEntity[] {
    return Array.from(this.bindersById.values());
  }

  // ==========================================================================
  // GC Operations (Phase 3)
  // ==========================================================================

  /**
   * Upsert a GC event entity.
   */
  upsertGc(entity: GcEntity): void {
    const id = normalizeId(entity.gc_id);
    if (!id) return;

    const existing = this.gcsById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, gc_id: id });
      this.gcsById.set(id, merged);
    } else {
      this.gcsById.set(id, { ...entity, gc_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.gcsById, ENTITY_CAPS.gc);
    }
  }

  getGc(id: EntityId | number): GcEntity | undefined {
    return this.gcsById.get(normalizeId(id));
  }

  getAllGcs(): GcEntity[] {
    return Array.from(this.gcsById.values());
  }

  // ==========================================================================
  // Memory Operations (Phase 3)
  // ==========================================================================

  /**
   * Upsert a memory event entity.
   */
  upsertMemory(entity: MemoryEntity): void {
    const id = normalizeId(entity.memory_id);
    if (!id) return;

    const existing = this.memoriesById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, memory_id: id });
      this.memoriesById.set(id, merged);
    } else {
      this.memoriesById.set(id, { ...entity, memory_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.memoriesById, ENTITY_CAPS.memory);
    }
  }

  getMemory(id: EntityId | number): MemoryEntity | undefined {
    return this.memoriesById.get(normalizeId(id));
  }

  getAllMemories(): MemoryEntity[] {
    return Array.from(this.memoriesById.values());
  }

  // ==========================================================================
  // Generic Entity Operations (Phase 3)
  // ==========================================================================

  /**
   * Upsert a generic entity (extensible for any entity type).
   */
  upsertGeneric(entity: GenericEntity): void {
    const id = normalizeId(entity.entity_id);
    if (!id) return;

    const existing = this.genericsById.get(id);
    if (existing) {
      const merged = mergeEntity(existing, { ...entity, entity_id: id });
      this.genericsById.set(id, merged);
    } else {
      this.genericsById.set(id, { ...entity, entity_id: id, updated_at: Date.now() });
      this.enforceCapLRU(this.genericsById, ENTITY_CAPS.generic);
    }
  }

  getGeneric(id: EntityId | number): GenericEntity | undefined {
    return this.genericsById.get(normalizeId(id));
  }

  getAllGenerics(): GenericEntity[] {
    return Array.from(this.genericsById.values());
  }

  /**
   * Get all generic entities of a specific type.
   */
  getGenericsByType(entityType: string): GenericEntity[] {
    return this.getAllGenerics().filter(e => e.entity_type === entityType);
  }

  // ==========================================================================
  // Generalized Analysis Tracking (Phase 3)
  // ==========================================================================

  /**
   * Mark any entity type as analyzed.
   * @param entityType - The type of entity (e.g., 'cpu_slice', 'binder')
   * @param id - The entity ID
   */
  markEntityAnalyzed(entityType: string, id: EntityId | number): void {
    if (!this.analyzedEntityIds.has(entityType)) {
      this.analyzedEntityIds.set(entityType, new Set());
    }
    const set = this.analyzedEntityIds.get(entityType)!;
    set.add(normalizeId(id));
    if (set.size > EntityStore.ANALYZED_SET_CAP) {
      const iter = set.values();
      set.delete(iter.next().value!);
    }
  }

  /**
   * Check if any entity type was analyzed.
   */
  wasEntityAnalyzed(entityType: string, id: EntityId | number): boolean {
    const set = this.analyzedEntityIds.get(entityType);
    return set ? set.has(normalizeId(id)) : false;
  }

  /**
   * Get all analyzed entity IDs for a type.
   */
  getAnalyzedEntityIds(entityType: string): EntityId[] {
    const set = this.analyzedEntityIds.get(entityType);
    return set ? Array.from(set) : [];
  }

  // ==========================================================================
  // Bulk Operations
  // ==========================================================================

  /**
   * Upsert multiple frames at once.
   */
  upsertFrames(entities: FrameEntity[]): void {
    for (const entity of entities) {
      this.upsertFrame(entity);
    }
  }

  /**
   * Upsert multiple sessions at once.
   */
  upsertSessions(entities: SessionEntity[]): void {
    for (const entity of entities) {
      this.upsertSession(entity);
    }
  }

  /**
   * Upsert multiple CPU slices at once.
   */
  upsertCpuSlices(entities: CpuSliceEntity[]): void {
    for (const entity of entities) {
      this.upsertCpuSlice(entity);
    }
  }

  /**
   * Upsert multiple Binder transactions at once.
   */
  upsertBinders(entities: BinderEntity[]): void {
    for (const entity of entities) {
      this.upsertBinder(entity);
    }
  }

  /**
   * Upsert multiple GC events at once.
   */
  upsertGcs(entities: GcEntity[]): void {
    for (const entity of entities) {
      this.upsertGc(entity);
    }
  }

  /**
   * Upsert multiple memory events at once.
   */
  upsertMemories(entities: MemoryEntity[]): void {
    for (const entity of entities) {
      this.upsertMemory(entity);
    }
  }

  /**
   * Upsert multiple generic entities at once.
   */
  upsertGenerics(entities: GenericEntity[]): void {
    for (const entity of entities) {
      this.upsertGeneric(entity);
    }
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get store statistics for debugging/logging.
   */
  getStats(): {
    frameCount: number;
    sessionCount: number;
    cpuSliceCount: number;
    binderCount: number;
    gcCount: number;
    memoryCount: number;
    genericCount: number;
    analyzedFrameCount: number;
    analyzedSessionCount: number;
    candidateFrameCount: number;
    candidateSessionCount: number;
    totalEntityCount: number;
  } {
    const totalEntityCount =
      this.framesById.size +
      this.sessionsById.size +
      this.cpuSlicesById.size +
      this.bindersById.size +
      this.gcsById.size +
      this.memoriesById.size +
      this.genericsById.size;

    return {
      frameCount: this.framesById.size,
      sessionCount: this.sessionsById.size,
      cpuSliceCount: this.cpuSlicesById.size,
      binderCount: this.bindersById.size,
      gcCount: this.gcsById.size,
      memoryCount: this.memoriesById.size,
      genericCount: this.genericsById.size,
      analyzedFrameCount: this.analyzedFrameIds.size,
      analyzedSessionCount: this.analyzedSessionIds.size,
      candidateFrameCount: this.lastCandidateFrameIds.length,
      candidateSessionCount: this.lastCandidateSessionIds.length,
      totalEntityCount,
    };
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  /**
   * Serialize to a JSON-safe snapshot for persistence.
   */
  serialize(): EntityStoreSnapshot {
    // Convert analyzedEntityIds Map to Record
    const analyzedEntityIdsRecord: Record<string, EntityId[]> = {};
    for (const [type, ids] of this.analyzedEntityIds.entries()) {
      analyzedEntityIdsRecord[type] = Array.from(ids);
    }

    return {
      version: CURRENT_SNAPSHOT_VERSION,
      framesById: Array.from(this.framesById.entries()),
      sessionsById: Array.from(this.sessionsById.entries()),
      // New entity types (Phase 3)
      cpuSlicesById: Array.from(this.cpuSlicesById.entries()),
      bindersById: Array.from(this.bindersById.entries()),
      gcsById: Array.from(this.gcsById.entries()),
      memoriesById: Array.from(this.memoriesById.entries()),
      genericsById: Array.from(this.genericsById.entries()),
      // Incremental execution support
      analyzedFrameIds: Array.from(this.analyzedFrameIds),
      analyzedSessionIds: Array.from(this.analyzedSessionIds),
      lastCandidateFrameIds: this.lastCandidateFrameIds,
      lastCandidateSessionIds: this.lastCandidateSessionIds,
      // Generalized analyzed tracking
      analyzedEntityIds: analyzedEntityIdsRecord,
    };
  }

  /**
   * Deserialize from a snapshot.
   */
  static deserialize(snapshot: EntityStoreSnapshot): EntityStore {
    const store = new EntityStore();

    // Version migration (for future compatibility)
    if (!snapshot.version || snapshot.version < CURRENT_SNAPSHOT_VERSION) {
      // Handle older versions - v1 snapshots are compatible
    }

    // Restore frame and session maps (always present)
    if (snapshot.framesById) {
      store.framesById = new Map(snapshot.framesById);
    }
    if (snapshot.sessionsById) {
      store.sessionsById = new Map(snapshot.sessionsById);
    }

    // Restore new entity type maps (Phase 3 - may be absent in older snapshots)
    if (snapshot.cpuSlicesById) {
      store.cpuSlicesById = new Map(snapshot.cpuSlicesById);
    }
    if (snapshot.bindersById) {
      store.bindersById = new Map(snapshot.bindersById);
    }
    if (snapshot.gcsById) {
      store.gcsById = new Map(snapshot.gcsById);
    }
    if (snapshot.memoriesById) {
      store.memoriesById = new Map(snapshot.memoriesById);
    }
    if (snapshot.genericsById) {
      store.genericsById = new Map(snapshot.genericsById);
    }

    // Restore tracking sets
    if (snapshot.analyzedFrameIds) {
      store.analyzedFrameIds = new Set(snapshot.analyzedFrameIds);
    }
    if (snapshot.analyzedSessionIds) {
      store.analyzedSessionIds = new Set(snapshot.analyzedSessionIds);
    }

    // Restore candidate lists
    if (snapshot.lastCandidateFrameIds) {
      store.lastCandidateFrameIds = snapshot.lastCandidateFrameIds;
    }
    if (snapshot.lastCandidateSessionIds) {
      store.lastCandidateSessionIds = snapshot.lastCandidateSessionIds;
    }

    // Restore generalized analyzed tracking (Phase 3)
    if (snapshot.analyzedEntityIds) {
      for (const [type, ids] of Object.entries(snapshot.analyzedEntityIds)) {
        store.analyzedEntityIds.set(type, new Set(ids));
      }
    }

    return store;
  }

  /**
   * Clear all data (for testing or reset).
   */
  clear(): void {
    this.framesById.clear();
    this.sessionsById.clear();
    this.cpuSlicesById.clear();
    this.bindersById.clear();
    this.gcsById.clear();
    this.memoriesById.clear();
    this.genericsById.clear();
    this.analyzedFrameIds.clear();
    this.analyzedSessionIds.clear();
    this.analyzedEntityIds.clear();
    this.lastCandidateFrameIds = [];
    this.lastCandidateSessionIds = [];
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Normalize any ID to string for consistent Map keys.
 * Handles number, string, BigInt, undefined/null.
 */
function normalizeId(id: any): EntityId {
  if (id === null || id === undefined) return '';
  if (typeof id === 'bigint') return id.toString();
  return String(id);
}

/**
 * Merge two entities, preferring newer non-null values.
 */
function mergeEntity<T extends { updated_at?: number }>(existing: T, incoming: T): T {
  const result = { ...existing };
  const now = Date.now();

  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) {
      (result as any)[key] = value;
    }
  }

  result.updated_at = now;
  return result;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a new EntityStore instance.
 */
export function createEntityStore(): EntityStore {
  return new EntityStore();
}
