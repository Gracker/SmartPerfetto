// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Pipeline Skill Loader
 *
 * Loads and manages pipeline skill definitions from YAML files.
 * Pipeline skills contain detection rules, teaching content, auto-pin
 * instructions, and analysis recommendations for each rendering pipeline type.
 *
 * This replaces the hardcoded configurations in trackPinService.ts with
 * a data-driven approach using YAML skill files.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { RenderingArchitectureType } from '../agent/detectors/types';
import type {
  PipelineCandidate,
  RelatedRenderingTypeCandidate,
} from '../types/teaching.types';

const RENDERING_ARCHITECTURE_TYPES = new Set<RenderingArchitectureType>([
  'STANDARD',
  'FLUTTER',
  'WEBVIEW',
  'COMPOSE',
  'SURFACEVIEW',
  'GLSURFACEVIEW',
  'SOFTWARE',
  'MIXED',
  'GAME_ENGINE',
  'CAMERA',
  'VIDEO_OVERLAY',
  'REACT_NATIVE',
  'UNKNOWN',
]);

// =============================================================================
// Types
// =============================================================================

export interface PipelineThreadRole {
  thread: string;
  role: string;
  description: string;
  trace_tags?: string;
}

export interface PipelineKeySlice {
  name: string;
  thread: string;
  description: string;
}

export interface SmartFilterConfig {
  enabled: boolean;
  description?: string;
  // NOTE: Currently SmartPerfetto uses a centralized active-process query for smart pinning.
  // This field is kept optional for forward compatibility with per-instruction SQL filtering.
  detection_sql?: string;
  fallback_sql?: string;
}

export interface PinInstruction {
  pattern: string;
  match_by: 'name' | 'uri';
  priority: number;
  reason: string;
  expand?: boolean;            // Whether to expand the track after pinning (show callstack/Running)
  main_thread_only?: boolean;  // Only pin main thread (track.chips includes 'main thread')
  smart_filter?: SmartFilterConfig;
  // Runtime fields (set after smart filter evaluation)
  smartPin?: boolean;
  skipPin?: boolean;
  activeProcessNames?: string[];
}

export interface TeachingReference {
  source: string;
}

export interface PipelineCatalogDocument {
  id: string;
  file: string;
  sha256: string;
}

export interface RenderingTypeDefinition {
  kind: 'overview' | 'concrete';
  document: string;
}

export interface PipelineCatalogEntry {
  file: string;
  family: string;
  classification_role: 'variant' | 'feature';
  teaching_type_id: string;
  rendering_type_id?: string;
  related_rendering_type_ids?: string[];
  architecture_type: RenderingArchitectureType;
  signal_scope: 'app' | 'global';
  primary_eligible: boolean;
  feature_visible: boolean;
}

export interface PipelineCatalog {
  version: string;
  description: string;
  source: {
    repository: string;
    commit: string;
    android_tag: string;
    kernel_tag: string;
  };
  documents: PipelineCatalogDocument[];
  rendering_types: Record<string, RenderingTypeDefinition>;
  default: {
    pipeline_id: string;
    rendering_type_id: string;
  };
  pipelines: Record<string, PipelineCatalogEntry>;
}

export interface PipelineMeta {
  pipeline_id: string;
  display_name: string;
  description: string;
  icon: string;
  family: string;
  doc_path?: string;
}

export interface CommonIssue {
  id: string;
  name: string;
  description?: string;
  detection_skill?: string;
}

export interface PipelineAnalysis {
  common_issues?: CommonIssue[];
  recommended_skills?: string[];
}

export interface PipelineDefinition {
  name: string;
  version: string;
  type: 'pipeline_definition';
  category: string;
  meta: PipelineMeta;
  detection?: {
    required_signals?: Array<{
      thread?: string;
      thread_pattern?: string;
      slice?: string;
      slice_pattern?: string;
      min_count?: number;
    }>;
    scoring_signals?: Array<{
      signal: string;
      slice_pattern?: string;
      thread_pattern?: string;
      weight: number;
      min_count?: number;
      condition?: string;
    }>;
    exclude_if?: Array<{
      thread?: string;
      thread_pattern?: string;
      slice?: string;
      slice_pattern?: string;
    }>;
  };
  teaching: TeachingReference;
  auto_pin: {
    instructions: PinInstruction[];
  };
  analysis?: PipelineAnalysis;
}

// =============================================================================
// Pipeline Skill Loader
// =============================================================================

class PipelineSkillLoaderClass {
  private pipelineCache: Map<string, PipelineDefinition> = new Map();
  private catalog: PipelineCatalog | null = null;
  private initialized = false;
  private pipelinesDir: string;
  private catalogPath: string;

  constructor(pipelinesDir?: string) {
    this.pipelinesDir = pipelinesDir || path.resolve(__dirname, '../../skills/pipelines');
    this.catalogPath = path.join(this.pipelinesDir, 'index.yaml');
  }

  private validateCatalog(catalog: PipelineCatalog): void {
    if (!catalog || !Array.isArray(catalog.documents) || catalog.documents.length !== 14) {
      throw new Error('[PipelineSkillLoader] Catalog must define the S01-S14 document set');
    }
    const documentFiles = new Set(catalog.documents.map((document) => document.file));
    if (documentFiles.size !== catalog.documents.length) {
      throw new Error('[PipelineSkillLoader] Catalog contains duplicate documents');
    }
    for (let index = 0; index < 14; index += 1) {
      const prefix = `S${String(index + 1).padStart(2, '0')}_`;
      if (!catalog.documents[index]?.file.startsWith(prefix)) {
        throw new Error(`[PipelineSkillLoader] Catalog document order mismatch at ${prefix}`);
      }
    }
    for (const [typeId, renderingType] of Object.entries(catalog.rendering_types || {})) {
      if (!['overview', 'concrete'].includes(renderingType.kind)) {
        throw new Error(`[PipelineSkillLoader] Rendering type ${typeId} has invalid kind`);
      }
      if (!documentFiles.has(renderingType.document)) {
        throw new Error(`[PipelineSkillLoader] Rendering type ${typeId} references missing document`);
      }
      if (path.basename(renderingType.document) !== renderingType.document) {
        throw new Error(`[PipelineSkillLoader] Rendering type ${typeId} has unsafe document path`);
      }
    }

    const pipelineFiles = new Set<string>();
    for (const [pipelineId, entry] of Object.entries(catalog.pipelines || {})) {
      if (!entry.file || pipelineFiles.has(entry.file) || path.basename(entry.file) !== entry.file) {
        throw new Error(`[PipelineSkillLoader] Pipeline ${pipelineId} has invalid or duplicate file`);
      }
      pipelineFiles.add(entry.file);
      const teachingType = catalog.rendering_types[entry.teaching_type_id];
      if (!teachingType) {
        throw new Error(`[PipelineSkillLoader] Pipeline ${pipelineId} has unknown teaching type`);
      }
      if (!['app', 'global'].includes(entry.signal_scope)) {
        throw new Error(`[PipelineSkillLoader] Pipeline ${pipelineId} has invalid signal scope`);
      }
      if (!RENDERING_ARCHITECTURE_TYPES.has(entry.architecture_type)) {
        throw new Error(`[PipelineSkillLoader] Pipeline ${pipelineId} has invalid architecture type`);
      }
      if (entry.classification_role === 'variant') {
        if (
          !entry.primary_eligible ||
          entry.feature_visible ||
          entry.rendering_type_id !== entry.teaching_type_id ||
          teachingType.kind !== 'concrete' ||
          entry.related_rendering_type_ids !== undefined
        ) {
          throw new Error(`[PipelineSkillLoader] Variant ${pipelineId} has contradictory metadata`);
        }
      } else if (entry.classification_role === 'feature') {
        if (
          entry.primary_eligible ||
          !entry.feature_visible ||
          entry.rendering_type_id !== undefined ||
          !Array.isArray(entry.related_rendering_type_ids)
        ) {
          throw new Error(`[PipelineSkillLoader] Feature ${pipelineId} has contradictory metadata`);
        }
        for (const relatedTypeId of entry.related_rendering_type_ids) {
          if (catalog.rendering_types[relatedTypeId]?.kind !== 'concrete') {
            throw new Error(`[PipelineSkillLoader] Feature ${pipelineId} has invalid related type`);
          }
        }
      } else {
        throw new Error(`[PipelineSkillLoader] Pipeline ${pipelineId} has invalid classification role`);
      }
    }

    const defaultEntry = catalog.pipelines[catalog.default?.pipeline_id];
    if (
      !defaultEntry ||
      defaultEntry.classification_role !== 'variant' ||
      defaultEntry.rendering_type_id !== catalog.default?.rendering_type_id
    ) {
      throw new Error('[PipelineSkillLoader] Catalog default is invalid');
    }

    const actualFiles = fs.readdirSync(this.pipelinesDir)
      .filter((file) => !file.startsWith('_') && file.endsWith('.skill.yaml'));
    const unexpected = actualFiles.filter((file) => !pipelineFiles.has(file));
    const missing = [...pipelineFiles].filter((file) => !actualFiles.includes(file));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        `[PipelineSkillLoader] Catalog/YAML inventory mismatch; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`
      );
    }
  }

  private validateDetection(pipeline: PipelineDefinition, file: string): void {
    const pipelineId = pipeline?.meta?.pipeline_id || 'UNKNOWN';
    const detection = pipeline.detection;
    if (!detection) {
      throw new Error(`invalid detection config: ${file} (${pipelineId}): detection is missing`);
    }

    const selectorKeys = ['thread', 'thread_pattern', 'slice', 'slice_pattern'] as const;
    const countSelectors = (obj: Record<string, unknown>): string[] =>
      selectorKeys.filter((k) => obj[k] !== undefined && obj[k] !== null);
    const isPositiveInteger = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'number' && Number.isInteger(value) && value > 0);
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0;
    const isDetectionEntry = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const errors: string[] = [];
    const requiredSignals = Array.isArray(detection.required_signals)
      ? detection.required_signals
      : [];
    const excludedSignals = Array.isArray(detection.exclude_if)
      ? detection.exclude_if
      : [];
    const scoringSignals = Array.isArray(detection.scoring_signals)
      ? detection.scoring_signals
      : [];

    const validateSelectors = (kind: string, item: Record<string, unknown>) => {
      const keys = countSelectors(item);
      if (keys.length !== 1) {
        errors.push(`${kind} entry must have exactly one selector, got [${keys.join(', ')}]`);
      }
      for (const key of keys) {
        if (!isNonEmptyString(item[key])) {
          errors.push(`${kind} entry selector '${key}' must be a non-empty string`);
        }
      }
    };

    if (detection.required_signals !== undefined && !Array.isArray(detection.required_signals)) {
      errors.push('detection.required_signals must be an array');
    }
    for (const item of requiredSignals) {
      if (!isDetectionEntry(item)) {
        errors.push('required_signals entry must be an object');
        continue;
      }
      const entry = item as Record<string, unknown>;
      validateSelectors('required_signals', entry);
      if (!isPositiveInteger(entry.min_count)) {
        errors.push(`required_signals entry has invalid min_count: ${entry.min_count}`);
      }
    }

    if (detection.exclude_if !== undefined && !Array.isArray(detection.exclude_if)) {
      errors.push('detection.exclude_if must be an array');
    }
    for (const item of excludedSignals) {
      if (!isDetectionEntry(item)) {
        errors.push('exclude_if entry must be an object');
        continue;
      }
      const entry = item as Record<string, unknown>;
      validateSelectors('exclude_if', entry);
      if (Object.prototype.hasOwnProperty.call(entry, 'min_count')) {
        errors.push('exclude_if entry must not define min_count');
      }
    }

    if (detection.scoring_signals === undefined) {
      errors.push('detection.scoring_signals is missing');
    } else if (!Array.isArray(detection.scoring_signals)) {
      errors.push('detection.scoring_signals must be an array');
    } else if (detection.scoring_signals.length === 0) {
      errors.push('detection.scoring_signals is empty; pipeline will never be selected by scoring');
    }

    let hasPositiveWeight = false;
    for (const item of scoringSignals) {
      if (!isDetectionEntry(item)) {
        errors.push('scoring_signals entry must be an object');
        continue;
      }
      const entry = item as Record<string, unknown>;
      const signal = entry.signal;
      const signalName = isNonEmptyString(signal) ? signal : 'UNKNOWN';
      const keys = countSelectors(entry);
      if (keys.length !== 1) {
        errors.push(`scoring_signals '${signalName}' must have exactly one selector, got [${keys.join(', ')}]`);
      }
      for (const key of keys) {
        if (!isNonEmptyString(entry[key])) {
          errors.push(`scoring_signals '${signalName}' selector '${key}' must be a non-empty string`);
        }
      }
      if (!isNonEmptyString(signal)) {
        errors.push("scoring_signals entry missing 'signal' name");
      }

      const weight = entry.weight;
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0) {
        errors.push(`scoring_signals '${signalName}' has invalid weight: ${weight}`);
      } else if (weight > 0) {
        hasPositiveWeight = true;
      }

      if (!isPositiveInteger(entry.min_count)) {
        errors.push(`scoring_signals '${signalName}' has invalid min_count: ${entry.min_count}`);
      }
    }

    if (scoringSignals.length > 0 && !hasPositiveWeight) {
      errors.push('detection.scoring_signals must include a positive integer weight');
    }

    if (errors.length > 0) {
      throw new Error(`invalid detection config: ${file} (${pipelineId}): ${errors.join('; ')}`);
    }
  }

  /**
   * Load all pipeline skills from the pipelines directory
   */
  async loadPipelines(): Promise<void> {
    if (this.initialized) return;

    console.log(`[PipelineSkillLoader] Loading pipelines from: ${this.pipelinesDir}`);

    if (!fs.existsSync(this.pipelinesDir)) {
      console.warn(`[PipelineSkillLoader] Pipelines directory not found: ${this.pipelinesDir}`);
      this.initialized = true;
      return;
    }

    const parsedCatalog = yaml.load(fs.readFileSync(this.catalogPath, 'utf-8')) as PipelineCatalog;
    this.validateCatalog(parsedCatalog);
    const loadedPipelines = new Map<string, PipelineDefinition>();

    for (const [pipelineId, entry] of Object.entries(parsedCatalog.pipelines)) {
      const file = entry.file;
      const filePath = path.join(this.pipelinesDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const pipeline = yaml.load(content) as PipelineDefinition;

        if (!pipeline?.meta?.pipeline_id || pipeline.meta.pipeline_id !== pipelineId) {
          throw new Error(`expected pipeline_id ${pipelineId}, got ${pipeline?.meta?.pipeline_id}`);
        }
        const document = parsedCatalog.rendering_types[entry.teaching_type_id].document;
        const expectedSource = `rendering_pipelines/${document}`;
        if (pipeline.meta.doc_path !== expectedSource || pipeline.teaching?.source !== expectedSource) {
          throw new Error(`teaching reference must be ${expectedSource}`);
        }
        this.validateDetection(pipeline, file);
        loadedPipelines.set(pipelineId, pipeline);
        console.log(`[PipelineSkillLoader] Loaded pipeline: ${pipelineId} (${pipeline.meta.display_name})`);
      } catch (error: any) {
        throw new Error(`[PipelineSkillLoader] Failed to load ${file}: ${error.message}`);
      }
    }

    this.pipelineCache = loadedPipelines;
    this.catalog = parsedCatalog;
    this.initialized = true;
    console.log(`[PipelineSkillLoader] Loaded ${this.pipelineCache.size} pipeline definitions`);
  }

  /**
   * Get a pipeline definition by ID
   */
  getPipeline(pipelineId: string): PipelineDefinition | null {
    return this.pipelineCache.get(pipelineId) || null;
  }

  /**
   * Get all loaded pipelines
   */
  getAllPipelines(): PipelineDefinition[] {
    return Array.from(this.pipelineCache.values());
  }

  /**
   * Get all pipeline IDs
   */
  getAllPipelineIds(): string[] {
    return Array.from(this.pipelineCache.keys());
  }

  getCatalog(): PipelineCatalog {
    if (!this.catalog) throw new Error('[PipelineSkillLoader] Catalog is not initialized');
    return this.catalog;
  }

  getPipelineCatalogEntry(pipelineId: string): PipelineCatalogEntry | null {
    return this.catalog?.pipelines[pipelineId] || null;
  }

  getRenderingType(renderingTypeId: string): RenderingTypeDefinition | null {
    return this.catalog?.rendering_types[renderingTypeId] || null;
  }

  resolveRelatedRenderingTypes(
    candidates: PipelineCandidate[],
  ): RelatedRenderingTypeCandidate[] {
    return candidates.flatMap((candidate) => {
      const renderingType = this.getRenderingType(candidate.id);
      return renderingType
        ? [{
            ...candidate,
            docPath: `rendering_pipelines/${renderingType.document}`,
          }]
        : [];
    });
  }

  getDefaultSelection(): { pipelineId: string; renderingTypeId: string; docPath: string } {
    const catalog = this.getCatalog();
    const renderingType = catalog.rendering_types[catalog.default.rendering_type_id];
    return {
      pipelineId: catalog.default.pipeline_id,
      renderingTypeId: catalog.default.rendering_type_id,
      docPath: `rendering_pipelines/${renderingType.document}`,
    };
  }

  /**
   * Get auto-pin instructions for a pipeline
   */
  getAutoPinInstructions(pipelineId: string): PinInstruction[] {
    const pipeline = this.getPipeline(pipelineId);
    if (!pipeline) {
      console.warn(`[PipelineSkillLoader] Pipeline not found: ${pipelineId}, using default`);
      return this.getDefaultPinInstructions();
    }
    return pipeline.auto_pin?.instructions || this.getDefaultPinInstructions();
  }

  /**
   * Get smart filter configurations for a pipeline
   * Returns a map of pattern -> SmartFilterConfig
   */
  getSmartFilterConfigs(pipelineId: string): Map<string, SmartFilterConfig> {
    const configs = new Map<string, SmartFilterConfig>();
    const pipeline = this.getPipeline(pipelineId);

    if (!pipeline) return configs;

    for (const inst of pipeline.auto_pin?.instructions || []) {
      if (inst.smart_filter?.enabled) {
        configs.set(inst.pattern, inst.smart_filter);
      }
    }

    return configs;
  }

  /**
   * Get teaching content for a pipeline
   */
  getTeachingContent(pipelineId: string): TeachingReference | null {
    const pipeline = this.getPipeline(pipelineId);
    return pipeline?.teaching || null;
  }

  /**
   * Get pipeline meta information
   */
  getPipelineMeta(pipelineId: string): PipelineMeta | null {
    const pipeline = this.getPipeline(pipelineId);
    return pipeline?.meta || null;
  }

  /**
   * Get recommended skills for a pipeline
   */
  getRecommendedSkills(pipelineId: string): string[] {
    const pipeline = this.getPipeline(pipelineId);
    return pipeline?.analysis?.recommended_skills || [];
  }

  /**
   * Get common issues for a pipeline
   */
  getCommonIssues(pipelineId: string): CommonIssue[] {
    const pipeline = this.getPipeline(pipelineId);
    return pipeline?.analysis?.common_issues || [];
  }

  /**
   * Check if loader is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reload all pipeline skills
   */
  async reload(): Promise<void> {
    this.pipelineCache.clear();
    this.catalog = null;
    this.initialized = false;
    await this.loadPipelines();
  }

  /**
   * Default pin instructions for fallback
   */
  private getDefaultPinInstructions(): PinInstruction[] {
    return [
      {
        pattern: '^VSYNC-app$',
        match_by: 'name',
        priority: 1,
        reason: 'VSync (App 开始生产帧)',
      },
      {
        pattern: '^main(\\s+\\d+)?$',
        match_by: 'name',
        priority: 2,
        reason: 'App 主线程',
      },
      {
        pattern: '^RenderThread(\\s+\\d+)?$',
        match_by: 'name',
        priority: 3,
        reason: 'App 渲染线程 (RenderThread)',
      },
      {
        pattern: '^VSYNC-sf$',
        match_by: 'name',
        priority: 5.5,
        reason: 'VSync (SurfaceFlinger 消费/合成)',
      },
      {
        pattern: '^SurfaceFlinger$',
        match_by: 'name',
        priority: 7,
        reason: 'SurfaceFlinger (最终合成/显示)',
      },
    ];
  }
}

// =============================================================================
// Singleton and Helper Functions
// =============================================================================

export const pipelineSkillLoader = new PipelineSkillLoaderClass();

// Promise-based lock to prevent concurrent initialization
let initializationPromise: Promise<void> | null = null;

/**
 * Ensure pipeline skill loader is initialized
 * Safe to call concurrently - will only initialize once
 */
export async function ensurePipelineSkillsInitialized(): Promise<void> {
  // Fast path: already initialized
  if (pipelineSkillLoader.isInitialized()) return;

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization
  initializationPromise = pipelineSkillLoader.loadPipelines();

  try {
    await initializationPromise;
  } finally {
    if (!pipelineSkillLoader.isInitialized()) {
      initializationPromise = null;
    }
  }
}

/**
 * Get pipeline skill loader instance
 */
export function getPipelineSkillLoader(): PipelineSkillLoaderClass {
  return pipelineSkillLoader;
}

/**
 * Convenience function to get auto-pin instructions
 */
export async function getAutoPinInstructions(pipelineId: string): Promise<PinInstruction[]> {
  await ensurePipelineSkillsInitialized();
  return pipelineSkillLoader.getAutoPinInstructions(pipelineId);
}

/**
 * Convenience function to get teaching content
 */
export async function getTeachingContent(pipelineId: string): Promise<TeachingReference | null> {
  await ensurePipelineSkillsInitialized();
  return pipelineSkillLoader.getTeachingContent(pipelineId);
}

/**
 * Convenience function to get smart filter configs
 */
export async function getSmartFilterConfigs(pipelineId: string): Promise<Map<string, SmartFilterConfig>> {
  await ensurePipelineSkillsInitialized();
  return pipelineSkillLoader.getSmartFilterConfigs(pipelineId);
}
