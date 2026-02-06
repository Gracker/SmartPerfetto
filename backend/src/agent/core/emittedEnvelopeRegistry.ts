/**
 * Emitted Envelope Registry
 *
 * Session-scoped registry to track which DataEnvelopes have already been emitted.
 * Prevents duplicate data from being sent to frontend across multiple executors.
 *
 * Key insight: Multiple executors (Strategy, Hypothesis, DirectSkill) can run
 * in the same session and emit overlapping data. Without coordination, the same
 * frame/session analysis results get sent multiple times.
 *
 * This registry provides a single source of truth for "has this data been sent?"
 */

import { DataEnvelope } from '../../types/dataContract';
import crypto from 'crypto';

/**
 * Generate a deduplication key for a DataEnvelope.
 *
 * Key composition (in order of preference):
 * 1. skillId:stepId:contentHash (stable across different execution ids)
 * 2. normalized meta.source (strip volatile execution suffix)
 * 3. skillId:stepId:title (last resort)
 *
 * Content hash is computed from rows (including row count) to catch
 * identical data emitted in different stages/rounds.
 */
export function generateDeduplicationKey(envelope: DataEnvelope): string {
  const meta = envelope.meta || {};
  const display = envelope.display || {};
  const skillId = meta.skillId || 'unknown';
  const stepId = meta.stepId || 'unknown';

  // Priority 1: Stable content key (preferred over source because source usually carries
  // execution id suffixes like "#mandatory_frame_..." or "#t1").
  const contentHash = computeContentHash(envelope.data);
  if (contentHash) {
    return `${skillId}:${stepId}:${contentHash}`;
  }

  // Priority 2: normalized source (strip execution suffix after '#')
  if (meta.source && typeof meta.source === 'string' && meta.source.length > 0) {
    const normalized = normalizeSource(meta.source);
    if (normalized) return normalized;
  }

  // Priority 3: Fallback to skillId:stepId:title
  const title = display.title || '';
  return `${skillId}:${stepId}:${title}`;
}

function normalizeSource(source: string): string {
  const normalized = source.split('#')[0]?.trim();
  return normalized || source.trim();
}

/**
 * Compute a short hash of the envelope's data content.
 * Returns null if data is empty or not suitable for hashing.
 */
function computeContentHash(data: any): string | null {
  if (!data) return null;

  try {
    // For table data, hash the rows
    if (data.rows && Array.isArray(data.rows)) {
      if (data.rows.length === 0) return 'empty';

      // Hash row count + first/last rows to balance accuracy vs performance.
      // Including rowCount avoids collisions when samples look similar but sizes differ.
      const sample = [
        ...data.rows.slice(0, 3),
        ...(data.rows.length > 6 ? data.rows.slice(-3) : []),
      ];
      const content = JSON.stringify({
        rowCount: data.rows.length,
        columns: Array.isArray(data.columns) ? data.columns : undefined,
        sample,
      });
      return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    }

    // For other data types, stringify and hash
    const content = JSON.stringify(data);
    if (content.length < 10) return null; // Too small to be meaningful
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * Session-scoped registry for tracking emitted envelopes.
 */
export class EmittedEnvelopeRegistry {
  private emittedKeys = new Set<string>();
  private emitLog: Array<{ key: string; timestamp: number; skillId?: string }> = [];

  /**
   * Check if an envelope has already been emitted.
   */
  hasBeenEmitted(envelope: DataEnvelope): boolean {
    const key = generateDeduplicationKey(envelope);
    return this.emittedKeys.has(key);
  }

  /**
   * Mark an envelope as emitted.
   * Returns the deduplication key used.
   */
  markAsEmitted(envelope: DataEnvelope): string {
    const key = generateDeduplicationKey(envelope);
    this.emittedKeys.add(key);
    this.emitLog.push({
      key,
      timestamp: Date.now(),
      skillId: envelope.meta?.skillId,
    });
    return key;
  }

  /**
   * Filter out envelopes that have already been emitted.
   * Returns only the new (non-duplicate) envelopes.
   */
  filterNewEnvelopes(envelopes: DataEnvelope[]): DataEnvelope[] {
    const newEnvelopes: DataEnvelope[] = [];

    for (const envelope of envelopes) {
      if (!this.hasBeenEmitted(envelope)) {
        this.markAsEmitted(envelope);
        newEnvelopes.push(envelope);
      }
    }

    return newEnvelopes;
  }

  /**
   * Get count of unique envelopes emitted.
   */
  get emittedCount(): number {
    return this.emittedKeys.size;
  }

  /**
   * Get the emission log for debugging.
   */
  getEmitLog(): Array<{ key: string; timestamp: number; skillId?: string }> {
    return [...this.emitLog];
  }

  /**
   * Clear the registry (for new analysis session).
   */
  clear(): void {
    this.emittedKeys.clear();
    this.emitLog = [];
  }

  /**
   * Get statistics for debugging.
   */
  getStats(): { totalEmitted: number; duplicatesBlocked: number } {
    return {
      totalEmitted: this.emittedKeys.size,
      duplicatesBlocked: this.emitLog.length - this.emittedKeys.size,
    };
  }
}

/**
 * Factory function to create a registry.
 * Typically one per analysis session.
 */
export function createEmittedEnvelopeRegistry(): EmittedEnvelopeRegistry {
  return new EmittedEnvelopeRegistry();
}
