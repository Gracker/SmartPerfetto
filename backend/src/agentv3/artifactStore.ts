/**
 * Session-scoped artifact store for token-efficient skill result references.
 * Instead of returning full displayResults to Claude (~3000 tokens/skill),
 * stores them as artifacts and returns compact references (~440 tokens).
 *
 * The full data still flows to the frontend via DataEnvelope — artifacts
 * only compress what Claude sees in its context window.
 *
 * Supports 3 detail levels via fetch_artifact:
 * - summary: row count + column names + first row sample + diagnostics count
 * - rows: paginated rows (offset/limit) with totalRows + hasMore metadata
 * - full: complete original data structure
 */

export interface StoredArtifact {
  id: string;
  skillId: string;
  stepId?: string;
  layer?: string;
  title?: string;
  data: any;
  diagnostics?: any;
  storedAt: number;
  lastAccessedAt: number;
}

export interface ArtifactSummary {
  id: string;
  skillId: string;
  stepId?: string;
  layer?: string;
  title?: string;
  rowCount: number;
  columns: string[];
  sampleRow?: any[];
  diagnosticCount: number;
}

export class ArtifactStore {
  private artifacts: Map<string, StoredArtifact> = new Map();
  private counter = 0;
  /** Maximum number of artifacts before LRU eviction. */
  private readonly maxArtifacts: number;

  constructor(maxArtifacts = 50) {
    this.maxArtifacts = maxArtifacts;
  }

  /**
   * Store a skill result artifact and return its reference ID.
   * Evicts least-recently-accessed artifacts when exceeding capacity.
   */
  store(entry: {
    skillId: string;
    stepId?: string;
    layer?: string;
    title?: string;
    data: any;
    diagnostics?: any;
  }): string {
    const id = `art-${++this.counter}`;
    const now = Date.now();
    this.artifacts.set(id, {
      id,
      ...entry,
      storedAt: now,
      lastAccessedAt: now,
    });

    // LRU eviction: remove least-recently-accessed artifacts
    while (this.artifacts.size > this.maxArtifacts) {
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [aid, art] of this.artifacts) {
        if (art.lastAccessedAt < oldestTime) {
          oldestTime = art.lastAccessedAt;
          oldestId = aid;
        }
      }
      if (oldestId) this.artifacts.delete(oldestId);
      else break;
    }

    return id;
  }

  /**
   * Get a stored artifact by ID. Updates access time for LRU tracking.
   */
  get(id: string): StoredArtifact | undefined {
    const artifact = this.artifacts.get(id);
    if (artifact) artifact.lastAccessedAt = Date.now();
    return artifact;
  }

  /**
   * Generate a compact summary for an artifact (for Claude's context).
   */
  generateSummary(id: string): ArtifactSummary | undefined {
    const artifact = this.artifacts.get(id);
    if (!artifact) return undefined;

    const data = artifact.data;
    const columns: string[] = data?.columns || [];
    const rows: any[][] = data?.rows || [];

    return {
      id: artifact.id,
      skillId: artifact.skillId,
      stepId: artifact.stepId,
      layer: artifact.layer,
      title: artifact.title,
      rowCount: rows.length,
      columns,
      sampleRow: rows.length > 0 ? rows[0] : undefined,
      diagnosticCount: Array.isArray(artifact.diagnostics) ? artifact.diagnostics.length : 0,
    };
  }

  /**
   * Fetch artifact data at the requested detail level.
   * For 'rows' detail, supports pagination via offset/limit to prevent token overflow.
   * Returns totalRows and hasMore so the caller knows whether to fetch more.
   */
  fetch(id: string, detail: 'summary' | 'rows' | 'full', offset?: number, limit?: number): any | undefined {
    const artifact = this.artifacts.get(id);
    if (!artifact) return undefined;
    artifact.lastAccessedAt = Date.now();

    switch (detail) {
      case 'summary':
        return this.generateSummary(id);
      case 'rows': {
        const allRows: any[][] = artifact.data?.rows || [];
        const totalRows = allRows.length;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? ArtifactStore.DEFAULT_PAGE_SIZE;
        const pagedRows = allRows.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        const hasMore = effectiveOffset + effectiveLimit < totalRows;
        return {
          id: artifact.id,
          columns: artifact.data?.columns || [],
          rows: pagedRows,
          totalRows,
          offset: effectiveOffset,
          limit: effectiveLimit,
          hasMore,
          diagnostics: artifact.diagnostics,
        };
      }
      case 'full': {
        // Cap rows at MAX_FULL_ROWS to prevent context window overflow.
        // Larger datasets should use detail="rows" with pagination.
        const fullRows: any[][] = artifact.data?.rows || [];
        const truncatedFull = fullRows.length > ArtifactStore.MAX_FULL_ROWS;
        const cappedData = truncatedFull
          ? { ...artifact.data, rows: fullRows.slice(0, ArtifactStore.MAX_FULL_ROWS) }
          : artifact.data;
        return {
          id: artifact.id,
          skillId: artifact.skillId,
          stepId: artifact.stepId,
          layer: artifact.layer,
          title: artifact.title,
          data: cappedData,
          diagnostics: artifact.diagnostics,
          ...(truncatedFull ? { truncated: true, totalRows: fullRows.length, hint: 'Use detail="rows" with offset/limit for complete data' } : {}),
        };
      }
      default:
        return this.generateSummary(id);
    }
  }

  /** Default page size for 'rows' fetch — balances completeness vs token budget. */
  static readonly DEFAULT_PAGE_SIZE = 50;
  /** Hard cap for 'full' fetch — prevents context overflow on large artifacts. */
  static readonly MAX_FULL_ROWS = 500;

  /** Get total artifact count. */
  get size(): number {
    return this.artifacts.size;
  }

  /**
   * Serialize all artifacts for snapshot persistence.
   * Returns a shallow copy of all stored artifacts.
   */
  serialize(): StoredArtifact[] {
    return Array.from(this.artifacts.values());
  }

  /**
   * Restore an ArtifactStore from a persisted snapshot.
   * Reconstructs the internal counter from the highest artifact ID
   * so new artifacts get IDs that don't collide with restored ones.
   */
  static fromSnapshot(artifacts: StoredArtifact[]): ArtifactStore {
    const store = new ArtifactStore();
    for (const art of artifacts) {
      store.artifacts.set(art.id, art);
      const num = parseInt(art.id.replace('art-', ''), 10) || 0;
      if (num > store.counter) store.counter = num;
    }
    return store;
  }

  /** Clear all artifacts (e.g., on session reset). */
  clear(): void {
    this.artifacts.clear();
    this.counter = 0;
  }
}
