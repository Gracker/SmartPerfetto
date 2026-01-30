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
  detection_sql: string;
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

export interface TeachingContent {
  title: string;
  summary: string;
  mermaid?: string;
  thread_roles: PipelineThreadRole[];
  key_slices: PipelineKeySlice[];
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
  teaching: TeachingContent;
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
  private initialized = false;
  private pipelinesDir: string;

  constructor() {
    this.pipelinesDir = path.resolve(__dirname, '../../skills/pipelines');
  }

  private validateDetection(pipeline: PipelineDefinition, file: string): void {
    const pipelineId = pipeline?.meta?.pipeline_id || 'UNKNOWN';
    const detection = pipeline.detection;
    if (!detection) return;

    const selectorKeys = ['thread', 'thread_pattern', 'slice', 'slice_pattern'] as const;
    const countSelectors = (obj: Record<string, unknown>): string[] =>
      selectorKeys.filter((k) => obj[k] !== undefined && obj[k] !== null);

    const validateMinCount = (v: unknown): boolean => {
      if (v === undefined || v === null) return true;
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      return Number.isFinite(n) && n > 0;
    };

    const warn = (msg: string) => {
      console.warn(`[PipelineSkillLoader] Validation warning in ${file} (${pipelineId}): ${msg}`);
    };

    for (const [kind, items] of [
      ['required_signals', detection.required_signals || []],
      ['exclude_if', detection.exclude_if || []],
    ] as const) {
      for (const item of items) {
        const keys = countSelectors(item as any);
        if (keys.length !== 1) warn(`${kind} entry must have exactly one selector, got [${keys.join(', ')}]`);
        if (!validateMinCount((item as any).min_count)) warn(`${kind} entry has invalid min_count: ${(item as any).min_count}`);
      }
    }

    for (const item of detection.scoring_signals || []) {
      const keys = countSelectors(item as any);
      if (keys.length !== 1) warn(`scoring_signals '${(item as any).signal}' must have exactly one selector, got [${keys.join(', ')}]`);

      const signal = (item as any).signal;
      if (!signal || typeof signal !== 'string') warn(`scoring_signals entry missing 'signal' name`);

      const weight = (item as any).weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
        warn(`scoring_signals '${signal || 'UNKNOWN'}' has invalid weight: ${weight}`);
      }

      if (!validateMinCount((item as any).min_count)) warn(`scoring_signals '${signal || 'UNKNOWN'}' has invalid min_count: ${(item as any).min_count}`);
    }

    if (!Array.isArray(detection.scoring_signals) || detection.scoring_signals.length === 0) {
      warn('detection.scoring_signals is empty; pipeline will never be selected by scoring');
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

    const files = fs.readdirSync(this.pipelinesDir);

    for (const file of files) {
      // Skip non-skill files (index.yaml, _base.skill.yaml)
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;
      if (file.startsWith('_')) continue;

      const filePath = path.join(this.pipelinesDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const pipeline = yaml.load(content) as PipelineDefinition;

        if (pipeline && pipeline.meta?.pipeline_id) {
          this.validateDetection(pipeline, file);
          this.pipelineCache.set(pipeline.meta.pipeline_id, pipeline);
          console.log(`[PipelineSkillLoader] Loaded pipeline: ${pipeline.meta.pipeline_id} (${pipeline.meta.display_name})`);
        }
      } catch (error: any) {
        console.error(`[PipelineSkillLoader] Failed to load ${file}:`, error.message);
      }
    }

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
  getTeachingContent(pipelineId: string): TeachingContent | null {
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
export async function getTeachingContent(pipelineId: string): Promise<TeachingContent | null> {
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
