// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Perfetto SQL stdlib index lookup.
 *
 * Loads the generated light index (data/perfettoSqlIndex.light.json) and
 * matches user queries against it to give the agent runtimes reference
 * templates for SQL generation.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PerfettoSqlTemplate {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  type: 'table' | 'view' | 'function' | 'macro' | 'metric';
  description: string;
  sql?: string;
  filePath?: string;
  dependencies?: string[];
  params?: string[];
  returnType?: string;
  columns?: Array<{ name: string; type: string; description: string }>;
}

export interface AnalysisScenario {
  id: string;
  name: string;
  description: string;
  category: string;
  templates: string[];
  order: number;
}

export interface SqlIndex {
  version: string;
  generatedAt: string;
  stats?: {
    totalTemplates: number;
    byCategory: Record<string, { count: number; types: Record<string, number> }>;
  };
  templates: PerfettoSqlTemplate[];
  scenarios: AnalysisScenario[];
}

export interface SearchResult {
  template: PerfettoSqlTemplate;
  score: number;
  matchedFields: string[];
}

/**
 * Official Perfetto SQL index with query matching.
 */
export class ExtendedSqlKnowledgeBase {
  private templateMap: Map<string, PerfettoSqlTemplate> = new Map();
  private initialized = false;

  private readonly indexPath = path.join(__dirname, '../../data/perfettoSqlIndex.light.json');

  /**
   * Initialize the extended knowledge base
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const index: SqlIndex | null = fs.existsSync(this.indexPath)
        ? JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
        : null;
      for (const template of index?.templates ?? []) {
        this.templateMap.set(template.id, template);
      }

      this.initialized = true;
      console.log(`ExtendedSqlKnowledgeBase: Loaded ${this.templateMap.size} templates`);
    } catch (error) {
      console.error('ExtendedSqlKnowledgeBase: Initialization failed', error);
      throw error;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ExtendedSqlKnowledgeBase not initialized. Call initialize() first.');
    }
  }

  /**
   * Search templates in the index
   */
  searchIndex(query: string, options?: { category?: string; type?: string; limit?: number; includePrivate?: boolean }): SearchResult[] {
    this.ensureInitialized();

    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];

    for (const template of Array.from(this.templateMap.values())) {
      // Skip private templates
      if (!options?.includePrivate && template.name.startsWith('_')) continue;
      // Filter by category
      if (options?.category && template.category !== options.category) continue;
      // Filter by type
      if (options?.type && template.type !== options.type) continue;

      let score = 0;
      const matchedFields: string[] = [];

      // Name matching (highest weight)
      const nameLower = template.name.toLowerCase();
      if (nameLower === queryLower) {
        score += 100;
        matchedFields.push('name:exact');
      } else if (nameLower.includes(queryLower)) {
        score += 50;
        matchedFields.push('name:partial');
      } else {
        for (const kw of keywords) {
          if (nameLower.includes(kw)) {
            score += 20;
            matchedFields.push(`name:keyword:${kw}`);
          }
        }
      }

      // Description matching
      const descLower = template.description.toLowerCase();
      for (const kw of keywords) {
        if (descLower.includes(kw)) {
          score += 10;
          matchedFields.push(`description:keyword:${kw}`);
        }
      }

      // Category matching
      if (template.category.toLowerCase().includes(queryLower)) {
        score += 15;
        matchedFields.push('category');
      }

      if (score > 0) {
        results.push({ template, score, matchedFields });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return options?.limit ? results.slice(0, options.limit) : results;
  }

  /**
   * Smart match - match templates based on user intent
   */
  smartMatch(userQuery: string): SearchResult[] {
    const intentMap: Record<string, string[]> = {
      'startup': ['android_startups', 'startup', 'launch', 'time_to_display'],
      '启动': ['android_startups', 'startup', 'launch', 'time_to_display'],
      'launch': ['android_startups', 'startup', 'launch'],
      'ttid': ['time_to_display', 'initial_display'],
      'ttfd': ['time_to_display', 'full_display'],
      'frame': ['android_frames', 'choreographer', 'draw_frame', 'jank'],
      '帧': ['android_frames', 'choreographer', 'draw_frame', 'jank'],
      'jank': ['jank', 'frame', 'dropped'],
      '卡顿': ['jank', 'frame', 'dropped'],
      'memory': ['memory', 'heap', 'dmabuf', 'ion'],
      '内存': ['memory', 'heap', 'dmabuf', 'ion'],
      'cpu': ['cpu', 'sched', 'frequency', 'utilization'],
      '调度': ['sched', 'scheduling', 'cpu'],
      'binder': ['binder', 'sync_binder', 'async_binder'],
      'battery': ['battery', 'charging', 'power'],
      '电池': ['battery', 'charging', 'power'],
      'power': ['power', 'power_rails', 'wattson'],
      '功耗': ['power', 'power_rails', 'wattson'],
      'gpu': ['gpu', 'graphics', 'gpu_frequency'],
      'io': ['io', 'file', 'disk'],
      'gc': ['garbage_collection', 'gc_type', 'heap'],
      'utilization': ['cpu_utilization', 'utilization', 'cpu_cycles'],
      'oom': ['oom_adj', 'lmk', 'memory'],
      'screen': ['screen_state', 'suspend', 'power_state'],
      'self_dur': ['self_dur', 'slice_self_dur', 'exclusive'],
      'dvfs': ['dvfs', 'frequency', 'residency'],
      'workload': ['surfaceflinger_workloads', 'surfaceflinger'],
      'latency': ['sched_latency', 'scheduling', 'runnable'],
      '利用率': ['cpu_utilization', 'utilization', 'cpu_cycles'],
      '屏幕': ['screen_state', 'suspend'],
      '排他': ['self_dur', 'slice_self_dur'],
    };

    const queryLower = userQuery.toLowerCase();
    let searchTerms: string[] = [];

    for (const [intent, terms] of Object.entries(intentMap)) {
      if (queryLower.includes(intent)) {
        searchTerms.push(...terms);
      }
    }

    if (searchTerms.length === 0) {
      return this.searchIndex(userQuery, { limit: 20 });
    }

    const allResults: Map<string, SearchResult> = new Map();
    for (const term of searchTerms) {
      const results = this.searchIndex(term, { limit: 10 });
      for (const result of results) {
        const existing = allResults.get(result.template.id);
        if (existing) {
          existing.score += result.score;
          existing.matchedFields.push(...result.matchedFields);
        } else {
          allResults.set(result.template.id, result);
        }
      }
    }

    return Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  /**
   * Generate context for AI SQL generation
   */
  getContextForAI(query: string, maxTemplates = 5): string {
    const matches = this.smartMatch(query);
    const topMatches = matches.slice(0, maxTemplates);

    if (topMatches.length === 0) return '';

    let context = '以下是 Perfetto 官方提供的相关 SQL 模板，可以参考其写法：\n\n';

    for (const { template } of topMatches) {
      context += `### ${template.name} (${template.type})\n`;
      context += `分类: ${template.category}\n`;
      context += `描述: ${template.description.substring(0, 200)}\n`;
      if (template.columns && template.columns.length > 0) {
        context += `列: ${template.columns.map(c => c.name).join(', ')}\n`;
      }
      context += '\n';
    }

    return context;
  }
}

// Singleton instance
let extendedInstance: ExtendedSqlKnowledgeBase | null = null;
let extendedInstanceInit: Promise<ExtendedSqlKnowledgeBase> | null = null;

export async function getExtendedKnowledgeBase(): Promise<ExtendedSqlKnowledgeBase> {
  if (extendedInstance) return extendedInstance;

  if (!extendedInstanceInit) {
    const instance = new ExtendedSqlKnowledgeBase();
    extendedInstanceInit = (async () => {
      try {
        await instance.initialize();
        extendedInstance = instance;
        return instance;
      } catch (error) {
        extendedInstanceInit = null;
        throw error;
      }
    })();
  }

  return extendedInstanceInit;
}
