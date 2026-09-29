// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Focus Store - User Focus Tracking for Multi-Turn Context
 *
 * Tracks what the user is interested in across conversation turns.
 * This enables incremental analysis that builds on previous interactions.
 *
 * Focus types:
 * 1. Entity focus - specific frame, process, thread, session
 * 2. Time range focus - specific time interval
 * 3. Metric focus - particular metric (FPS, latency, etc.)
 * 4. Question focus - conceptual question being explored
 *
 * Design principles:
 * - Decay-based weighting (recent interactions matter more)
 * - Interaction history for context
 * - Serializable for session persistence
 * - Integrates with EntityStore for entity resolution
 */

import type { EntityId, EntityStore } from './entityStore';

// =============================================================================
// Types
// =============================================================================

/**
 * Types of focus targets
 */
export type FocusType = 'entity' | 'timeRange' | 'metric' | 'question';

/**
 * Entity types for entity focus
 */
export type FocusEntityType =
  | 'frame'
  | 'process'
  | 'thread'
  | 'session'
  | 'cpu_slice'
  | 'binder'
  | 'gc'
  | 'memory';

/**
 * Focus target specification
 */
export interface FocusTarget {
  // Entity focus
  entityType?: FocusEntityType;
  entityId?: EntityId;
  entityName?: string; // e.g., process name, thread name

  // Time range focus
  timeRange?: { start: bigint | string; end: bigint | string };

  // Metric focus
  metricName?: string;
  metricThreshold?: number;

  // Question focus
  question?: string;
  questionCategory?: string;
}

/**
 * Interaction event that updates focus
 */
export interface FocusInteraction {
  type: 'click' | 'query' | 'drill_down' | 'compare' | 'extend' | 'explicit';
  target: FocusTarget;
  source: 'ui' | 'query' | 'agent' | 'system';
  timestamp: number;
  context?: Record<string, any>;
}

/**
 * User focus with weight and history
 */
export interface UserFocus {
  id: string;
  type: FocusType;
  target: FocusTarget;
  /** Weight 0-1, based on interaction frequency and recency */
  weight: number;
  /** Timestamp of last interaction */
  lastInteractionTime: number;
  /** History of interactions that built this focus */
  interactionHistory: FocusInteraction[];
  /** Creation time */
  createdAt: number;
}

/**
 * Serializable snapshot for persistence
 */
export interface FocusStoreSnapshot {
  version: number;
  focuses: UserFocus[];
}

const CURRENT_SNAPSHOT_VERSION = 1;

// =============================================================================
// Configuration
// =============================================================================

export interface FocusStoreConfig {
  /** Maximum focuses to track */
  maxFocuses: number;
  /** Decay rate per minute (0-1) */
  decayRatePerMinute: number;
  /** Boost multiplier for new interactions */
  boostMultiplier: number;
  /** Minimum weight before focus is removed */
  minWeight: number;
  /** Maximum interaction history per focus */
  maxHistoryPerFocus: number;
}

const DEFAULT_CONFIG: FocusStoreConfig = {
  maxFocuses: 20,
  decayRatePerMinute: 0.05, // 5% decay per minute
  boostMultiplier: 1.5,
  minWeight: 0.1,
  maxHistoryPerFocus: 10,
};

// =============================================================================
// Focus Store
// =============================================================================

/**
 * Tracks user focus across conversation turns.
 *
 * Usage pattern:
 * 1. Record interactions from UI (clicks) and queries
 * 2. Get top focuses for LLM context
 * 3. Use focuses to determine incremental analysis scope
 * 4. Serialize for session persistence
 */
export class FocusStore {
  private config: FocusStoreConfig;
  private focuses: Map<string, UserFocus>;
  private lastDecayTime: number;

  constructor(config?: Partial<FocusStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.focuses = new Map();
    this.lastDecayTime = Date.now();
  }

  // ==========================================================================
  // Interaction Recording
  // ==========================================================================

  /**
   * Record a user interaction that updates focus.
   */
  recordInteraction(interaction: FocusInteraction): void {
    const normalizedInteraction = this.normalizeInteractionForStorage(interaction);
    const focusType = this.inferFocusType(normalizedInteraction);
    const focusId = this.computeFocusId(normalizedInteraction.target, focusType);

    // Apply decay to all focuses before updating
    this.applyDecay();

    const existing = this.focuses.get(focusId);

    if (existing) {
      // Update existing focus
      existing.weight = this.decayAndBoost(existing.weight);
      existing.lastInteractionTime = normalizedInteraction.timestamp || Date.now();
      existing.interactionHistory.push(normalizedInteraction);

      // Trim history
      if (existing.interactionHistory.length > this.config.maxHistoryPerFocus) {
        existing.interactionHistory = existing.interactionHistory.slice(-this.config.maxHistoryPerFocus);
      }
    } else {
      // Create new focus
      const newFocus: UserFocus = {
        id: focusId,
        type: focusType,
        target: normalizedInteraction.target,
        weight: 0.5, // Initial weight
        lastInteractionTime: normalizedInteraction.timestamp || Date.now(),
        interactionHistory: [normalizedInteraction],
        createdAt: Date.now(),
      };

      this.focuses.set(focusId, newFocus);
    }

    // Prune if exceeding max
    this.pruneIfNeeded();
  }

  /**
   * Record entity click from UI.
   */
  recordEntityClick(
    entityType: FocusEntityType,
    entityId: EntityId,
    context?: Record<string, any>
  ): void {
    this.recordInteraction({
      type: 'click',
      target: { entityType, entityId },
      source: 'ui',
      timestamp: Date.now(),
      context,
    });
  }

  /**
   * Record time range selection from UI.
   */
  recordTimeRangeClick(
    start: bigint | string,
    end: bigint | string,
    context?: Record<string, any>
  ): void {
    this.recordInteraction({
      type: 'click',
      target: { timeRange: { start, end } },
      source: 'ui',
      timestamp: Date.now(),
      context,
    });
  }

  /**
   * Record question from user query.
   */
  recordQuestion(
    question: string,
    category?: string
  ): void {
    this.recordInteraction({
      type: 'query',
      target: { question, questionCategory: category },
      source: 'query',
      timestamp: Date.now(),
    });
  }

  /**
   * Record drill-down action.
   */
  recordDrillDown(target: FocusTarget): void {
    this.recordInteraction({
      type: 'drill_down',
      target,
      source: 'ui',
      timestamp: Date.now(),
    });
  }

  // ==========================================================================
  // Focus Queries
  // ==========================================================================

  /**
   * Get the top N focuses by weight.
   */
  getTopFocuses(limit: number = 3): UserFocus[] {
    this.applyDecay();

    return Array.from(this.focuses.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /**
   * Get focuses of a specific type.
   */
  getFocusesByType(type: FocusType): UserFocus[] {
    this.applyDecay();

    return Array.from(this.focuses.values())
      .filter(f => f.type === type)
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get focus for a specific entity.
   */
  getEntityFocus(entityType: FocusEntityType, entityId: EntityId): UserFocus | undefined {
    const focusId = this.computeFocusId({ entityType, entityId }, 'entity');
    return this.focuses.get(focusId);
  }

  /**
   * Check if an entity is currently focused.
   */
  isEntityFocused(entityType: FocusEntityType, entityId: EntityId): boolean {
    const focus = this.getEntityFocus(entityType, entityId);
    return focus !== undefined && focus.weight >= this.config.minWeight;
  }

  /**
   * Get current primary focus (highest weight).
   */
  getPrimaryFocus(): UserFocus | undefined {
    const top = this.getTopFocuses(1);
    return top.length > 0 ? top[0] : undefined;
  }

  /**
   * Get all focuses.
   */
  getAllFocuses(): UserFocus[] {
    this.applyDecay();
    return Array.from(this.focuses.values());
  }

  // ==========================================================================
  // Context Building
  // ==========================================================================

  /**
   * Build focus context string for LLM prompts.
   */
  buildFocusContext(maxFocuses: number = 5): string {
    const topFocuses = this.getTopFocuses(maxFocuses);

    if (topFocuses.length === 0) {
      return '当前没有特定的用户关注点。';
    }

    const lines = topFocuses.map(f => {
      const weightPct = (f.weight * 100).toFixed(0);
      return `- ${this.describeFocus(f)} (关注度: ${weightPct}%)`;
    });

    return `用户当前关注点：\n${lines.join('\n')}`;
  }

  /**
   * Build focus context for incremental analysis.
   */
  buildIncrementalContext(): {
    focusedEntities: Array<{ type: FocusEntityType; id: EntityId }>;
    focusedTimeRanges: Array<{ start: string; end: string }>;
    focusedQuestions: string[];
    primaryFocusType: FocusType | null;
  } {
    this.applyDecay();

    const allFocuses = Array.from(this.focuses.values());
    if (allFocuses.length === 0) {
      return {
        focusedEntities: [],
        focusedTimeRanges: [],
        focusedQuestions: [],
        primaryFocusType: null,
      };
    }

    // Primary focus should reflect "what the user just interacted with",
    // not only the highest weight (which can be dominated by previous turns).
    const primaryFocus = allFocuses.reduce((best, cur) =>
      cur.lastInteractionTime >= best.lastInteractionTime ? cur : best
    );

    // Select up to 5 focuses, ensuring primary focus is included.
    const byWeight = [...allFocuses].sort((a, b) => b.weight - a.weight);
    const selected: UserFocus[] = [primaryFocus];
    for (const f of byWeight) {
      if (selected.length >= 5) break;
      if (f.id === primaryFocus.id) continue;
      selected.push(f);
    }

    const focusedEntities: Array<{ type: FocusEntityType; id: EntityId }> = [];
    const focusedTimeRanges: Array<{ start: string; end: string }> = [];
    const focusedQuestions: string[] = [];

    for (const focus of selected) {
      if (focus.type === 'entity' && focus.target.entityType && focus.target.entityId) {
        focusedEntities.push({
          type: focus.target.entityType,
          id: focus.target.entityId,
        });
      } else if (focus.type === 'timeRange' && focus.target.timeRange) {
        focusedTimeRanges.push({
          start: String(focus.target.timeRange.start),
          end: String(focus.target.timeRange.end),
        });
      } else if (focus.type === 'question' && focus.target.question) {
        focusedQuestions.push(focus.target.question);
      }
    }

    return {
      focusedEntities,
      focusedTimeRanges,
      focusedQuestions,
      primaryFocusType: primaryFocus.type,
    };
  }

  /**
   * Describe a focus in human-readable form.
   */
  private describeFocus(focus: UserFocus): string {
    switch (focus.type) {
      case 'entity':
        const entityType = focus.target.entityType || 'unknown';
        const entityId = focus.target.entityId || 'unknown';
        const entityName = focus.target.entityName;
        return entityName
          ? `${entityType} "${entityName}" (ID: ${entityId})`
          : `${entityType} ${entityId}`;

      case 'timeRange':
        if (focus.target.timeRange) {
          const start = String(focus.target.timeRange.start);
          const end = String(focus.target.timeRange.end);
          return `时间范围 ${formatNsForDisplay(start)} - ${formatNsForDisplay(end)}`;
        }
        return '时间范围 (未指定)';

      case 'metric':
        return `指标 "${focus.target.metricName || 'unknown'}"`;

      case 'question':
        const q = focus.target.question || '';
        return `问题: "${q.slice(0, 50)}${q.length > 50 ? '...' : ''}"`;

      default:
        return '未知关注点';
    }
  }

  // ==========================================================================
  // Decay and Boost
  // ==========================================================================

  /**
   * Apply time-based decay to all focuses.
   */
  private applyDecay(): void {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastDecayTime) / 60000;

    if (elapsedMinutes < 1) {
      return; // Don't decay more than once per minute
    }

    const decayFactor = Math.pow(1 - this.config.decayRatePerMinute, elapsedMinutes);

    for (const focus of this.focuses.values()) {
      focus.weight *= decayFactor;
    }

    this.lastDecayTime = now;

    // Remove focuses below minimum weight
    for (const [id, focus] of this.focuses) {
      if (focus.weight < this.config.minWeight) {
        this.focuses.delete(id);
      }
    }
  }

  /**
   * Apply decay and then boost for a new interaction.
   */
  private decayAndBoost(currentWeight: number): number {
    // Boost, capped at 1.0
    const boosted = Math.min(1.0, currentWeight * this.config.boostMultiplier);
    return Math.max(boosted, 0.5); // At least 0.5 after interaction
  }

  /**
   * Prune focuses if exceeding max.
   */
  private pruneIfNeeded(): void {
    if (this.focuses.size <= this.config.maxFocuses) {
      return;
    }

    // Remove lowest weight focuses
    const sorted = Array.from(this.focuses.entries())
      .sort((a, b) => a[1].weight - b[1].weight);

    const toRemove = sorted.slice(0, this.focuses.size - this.config.maxFocuses);
    for (const [id] of toRemove) {
      this.focuses.delete(id);
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Compute unique focus ID from target.
   */
  private computeFocusId(target: FocusTarget, type: FocusType): string {
    switch (type) {
      case 'entity':
        return `entity_${target.entityType}_${target.entityId}`;
      case 'timeRange':
        return `time_${target.timeRange?.start}_${target.timeRange?.end}`;
      case 'metric':
        return `metric_${target.metricName}`;
      case 'question':
        // Use first 50 chars of question for ID
        const qHash = (target.question || '').slice(0, 50).replace(/\s+/g, '_');
        return `question_${qHash}`;
      default:
        return `unknown_${Date.now()}`;
    }
  }

  /**
   * Infer focus type from interaction.
   */
  private inferFocusType(interaction: FocusInteraction): FocusType {
    const target = interaction.target;

    if (target.entityType && target.entityId) {
      return 'entity';
    }
    if (target.timeRange) {
      return 'timeRange';
    }
    if (target.metricName) {
      return 'metric';
    }
    if (target.question) {
      return 'question';
    }

    // Default based on interaction type
    switch (interaction.type) {
      case 'click':
        return 'entity';
      case 'query':
        return 'question';
      default:
        return 'question';
    }
  }

  // ==========================================================================
  // Integration with EntityStore
  // ==========================================================================

  /**
   * Sync focused entities from EntityStore.
   * Call this after EntityStore updates to ensure focuses are valid.
   */
  syncWithEntityStore(entityStore: EntityStore): void {
    // Check if focused entities still exist
    for (const [id, focus] of this.focuses) {
      if (focus.type !== 'entity') continue;

      const { entityType, entityId } = focus.target;
      if (!entityType || !entityId) continue;

      // Check if entity exists
      let exists = false;
      switch (entityType) {
        case 'frame':
          exists = entityStore.getFrame(entityId) !== undefined;
          break;
        case 'session':
          exists = entityStore.getSession(entityId) !== undefined;
          break;
        // Add more entity types as needed
      }

      if (!exists) {
        // Entity no longer exists, remove focus
        this.focuses.delete(id);
      }
    }
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  /**
   * Serialize to JSON-safe snapshot.
   */
  serialize(): FocusStoreSnapshot {
    return {
      version: CURRENT_SNAPSHOT_VERSION,
      focuses: Array.from(this.focuses.values()).map(focus => this.normalizeFocusForSerialization(focus)),
    };
  }

  /**
   * Deserialize from snapshot.
   */
  static deserialize(snapshot: FocusStoreSnapshot, config?: Partial<FocusStoreConfig>): FocusStore {
    const store = new FocusStore(config);
    store.loadSnapshot(snapshot);

    return store;
  }

  /**
   * Load a snapshot into this FocusStore instance (in-place).
   * Converts any BigInt-like fields to JSON-safe representations (string).
   */
  loadSnapshot(snapshot: FocusStoreSnapshot): void {
    this.focuses.clear();

    if (snapshot.focuses) {
      for (const focus of snapshot.focuses) {
        const normalized = this.normalizeFocusForSerialization(focus);
        this.focuses.set(normalized.id, normalized);
      }
    }

    // Reset decay baseline so restored focuses don't instantly decay on load.
    this.lastDecayTime = Date.now();
  }

  /**
   * Clear all focuses.
   */
  clear(): void {
    this.focuses.clear();
    this.lastDecayTime = Date.now();
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalFocuses: number;
    byType: Record<FocusType, number>;
    averageWeight: number;
  } {
    const byType: Record<FocusType, number> = {
      entity: 0,
      timeRange: 0,
      metric: 0,
      question: 0,
    };

    let totalWeight = 0;

    for (const focus of this.focuses.values()) {
      byType[focus.type]++;
      totalWeight += focus.weight;
    }

    return {
      totalFocuses: this.focuses.size,
      byType,
      averageWeight: this.focuses.size > 0 ? totalWeight / this.focuses.size : 0,
    };
  }

  // ==========================================================================
  // Normalization (BigInt-safe serialization)
  // ==========================================================================

  private normalizeInteractionForStorage(interaction: FocusInteraction): FocusInteraction {
    return {
      ...interaction,
      // Ensure targets are JSON-safe (avoid BigInt in timeRange)
      target: this.normalizeTargetForSerialization(interaction.target),
      timestamp: interaction.timestamp || Date.now(),
    };
  }

  private normalizeTargetForSerialization(target: FocusTarget): FocusTarget {
    if (!target.timeRange) return target;

    return {
      ...target,
      timeRange: {
        start: String(target.timeRange.start),
        end: String(target.timeRange.end),
      },
    };
  }

  private normalizeFocusForSerialization(focus: UserFocus): UserFocus {
    return {
      ...focus,
      target: this.normalizeTargetForSerialization(focus.target),
      interactionHistory: Array.isArray(focus.interactionHistory)
        ? focus.interactionHistory.map(h => ({
            ...h,
            target: this.normalizeTargetForSerialization(h.target),
            timestamp: h.timestamp || Date.now(),
          }))
        : [],
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format nanoseconds for display.
 */
function formatNsForDisplay(ns: string): string {
  try {
    const nsValue = BigInt(ns);
    const ms = Number(nsValue / BigInt(1000000));
    if (ms < 1000) {
      return `${ms.toFixed(1)}ms`;
    }
    const s = ms / 1000;
    if (s < 60) {
      return `${s.toFixed(2)}s`;
    }
    return `${(s / 60).toFixed(1)}m`;
  } catch {
    return ns;
  }
}
