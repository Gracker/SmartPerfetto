/**
 * Skill Executor Adapter
 *
 * Bridges the Decision Tree's SkillExecutorInterface with the actual
 * Skill system (SkillAnalysisAdapter). This allows decision trees to
 * invoke YAML-defined skills transparently.
 */

import { SkillExecutorInterface } from './decisionTreeExecutor';
import { DecisionContext } from './types';

/**
 * Adapter that implements SkillExecutorInterface for decision trees
 */
export class SkillExecutorAdapter implements SkillExecutorInterface {
  private cache: Map<string, any> = new Map();
  private enableCache: boolean;

  constructor(options: { enableCache?: boolean } = {}) {
    this.enableCache = options.enableCache ?? true;
  }

  /**
   * Execute a skill and return its result
   */
  async execute(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): Promise<any> {
    const cacheKey = this.buildCacheKey(skillId, params, context);

    // Check cache first
    if (this.enableCache && this.cache.has(cacheKey)) {
      console.log(`[SkillExecutorAdapter] Cache hit for skill: ${skillId}`);
      return this.cache.get(cacheKey);
    }

    console.log(`[SkillExecutorAdapter] Executing skill: ${skillId}`);
    console.log(`[SkillExecutorAdapter] Params: ${JSON.stringify(params)}`);

    try {
      // Dynamically import to avoid circular dependencies
      const { SkillAnalysisAdapter } = await import(
        '../../services/skillEngine/skillAnalysisAdapter'
      );

      // Create adapter instance
      const adapter = new SkillAnalysisAdapter(context.traceProcessorService);

      // Build request
      const request = {
        traceId: context.traceId,
        skillId,
        packageName: params.packageName || context.packageName,
        // Pass additional params if the skill supports them
        ...params,
      };

      // Execute skill
      const response = await adapter.analyze(request);

      // Transform result to a more usable format for decision trees
      const result = this.transformResult(skillId, response);

      // Cache the result
      if (this.enableCache) {
        this.cache.set(cacheKey, result);
      }

      return result;
    } catch (error: any) {
      console.error(`[SkillExecutorAdapter] Error executing skill ${skillId}:`, error);
      throw error;
    }
  }

  /**
   * Transform skill response to a flattened format for decision tree evaluation
   */
  private transformResult(skillId: string, response: any): any {
    // Base result with common fields
    const result: Record<string, any> = {
      skillId: response.skillId,
      success: response.success,
      summary: response.summary,
      diagnostics: response.diagnostics || [],
    };

    // Extract layered data
    if (response.layeredResult?.layers) {
      const layers = response.layeredResult.layers;

      // Merge overview data into result
      if (layers.overview) {
        for (const [key, value] of Object.entries(layers.overview)) {
          if (typeof value === 'object' && value !== null && 'data' in (value as any)) {
            result[key] = (value as any).data;
          } else {
            result[key] = value;
          }
        }
      }

      // Merge list data into result
      if (layers.list) {
        result.sessions = layers.list;
        for (const [key, value] of Object.entries(layers.list)) {
          if (typeof value === 'object' && value !== null && 'data' in (value as any)) {
            result[`list_${key}`] = (value as any).data;
          }
        }
      }

      // Include deep data
      if (layers.deep) {
        result.frameDetails = layers.deep;
      }
    }

    // Skill-specific transformations
    result.transformed = this.applySkillSpecificTransform(skillId, result, response);

    return result;
  }

  /**
   * Apply skill-specific transformations to make data easier to query
   */
  private applySkillSpecificTransform(
    skillId: string,
    result: Record<string, any>,
    response: any
  ): Record<string, any> {
    switch (skillId) {
      case 'scrolling_analysis':
        return this.transformScrollingResult(result);

      case 'startup_analysis':
        return this.transformStartupResult(result);

      case 'janky_frame_analysis':
      case 'jank_frame_detail':
        return this.transformJankResult(result);

      case 'cpu_analysis':
        return this.transformCpuResult(result);

      case 'binder_analysis':
        return this.transformBinderResult(result);

      default:
        return result;
    }
  }

  /**
   * Transform scrolling analysis result
   */
  private transformScrollingResult(result: Record<string, any>): Record<string, any> {
    // Extract key metrics for easy decision tree access
    const summary = result.scrolling_summary?.data || result.scrolling_summary || {};

    return {
      avg_fps: this.extractNumber(summary, ['avg_fps', 'averageFps']),
      min_fps: this.extractNumber(summary, ['min_fps', 'minFps']),
      janky_frame_count: this.extractNumber(summary, ['janky_frame_count', 'jankyFrameCount', 'janky_count']),
      total_frame_count: this.extractNumber(summary, ['total_frame_count', 'totalFrameCount', 'total_count']),
      janky_rate: this.extractNumber(summary, ['janky_rate', 'jankyRate']),
      avg_frame_time_ms: this.extractNumber(summary, ['avg_frame_time_ms', 'avgFrameTimeMs']),
      session_count: result.sessions?.length || 0,
    };
  }

  /**
   * Transform startup analysis result
   */
  private transformStartupResult(result: Record<string, any>): Record<string, any> {
    const summary = result.startup_summary?.data || result.startup_summary || {};

    return {
      launch_type: summary.launch_type || 'cold',
      ttid: this.extractNumber(summary, ['ttid', 'time_to_initial_display']),
      ttfd: this.extractNumber(summary, ['ttfd', 'time_to_full_display']),
      process_start_time: this.extractNumber(summary, ['process_start_time', 'processStartTime']),
      application_init_time: this.extractNumber(summary, ['application_init_time', 'applicationInitTime']),
      activity_create_time: this.extractNumber(summary, ['activity_create_time', 'activityCreateTime']),
      first_frame_time: this.extractNumber(summary, ['first_frame_time', 'firstFrameTime']),
      zygote_fork_time: this.extractNumber(summary, ['zygote_fork_time', 'zygoteForkTime', 'fork_time']),
      layout_inflate_time: this.extractNumber(summary, ['layout_inflate_time', 'layoutInflateTime', 'inflate_time']),
    };
  }

  /**
   * Transform jank analysis result
   */
  private transformJankResult(result: Record<string, any>): Record<string, any> {
    const summary = result.jank_summary?.data || result.jank_summary || {};

    return {
      janky_frame_count: this.extractNumber(summary, ['janky_frame_count', 'jankyFrameCount']),
      total_frame_count: this.extractNumber(summary, ['total_frame_count', 'totalFrameCount']),
      avg_jank_duration_ms: this.extractNumber(summary, ['avg_jank_duration_ms', 'avgJankDurationMs']),
      max_jank_duration_ms: this.extractNumber(summary, ['max_jank_duration_ms', 'maxJankDurationMs']),
      // Frame breakdown by cause
      main_thread_jank_count: this.extractNumber(summary, ['main_thread_jank_count', 'mainThreadJankCount']),
      render_thread_jank_count: this.extractNumber(summary, ['render_thread_jank_count', 'renderThreadJankCount']),
      gpu_jank_count: this.extractNumber(summary, ['gpu_jank_count', 'gpuJankCount']),
      sf_jank_count: this.extractNumber(summary, ['sf_jank_count', 'sfJankCount']),
    };
  }

  /**
   * Transform CPU analysis result
   */
  private transformCpuResult(result: Record<string, any>): Record<string, any> {
    const summary = result.cpu_summary?.data || result.cpu_summary || {};

    return {
      avg_cpu_usage: this.extractNumber(summary, ['avg_cpu_usage', 'avgCpuUsage']),
      max_cpu_usage: this.extractNumber(summary, ['max_cpu_usage', 'maxCpuUsage']),
      main_thread_cpu_usage: this.extractNumber(summary, ['main_thread_cpu_usage', 'mainThreadCpuUsage']),
      render_thread_cpu_usage: this.extractNumber(summary, ['render_thread_cpu_usage', 'renderThreadCpuUsage']),
    };
  }

  /**
   * Transform Binder analysis result
   */
  private transformBinderResult(result: Record<string, any>): Record<string, any> {
    const summary = result.binder_summary?.data || result.binder_summary || {};

    return {
      total_binder_calls: this.extractNumber(summary, ['total_binder_calls', 'totalBinderCalls']),
      avg_binder_duration_ms: this.extractNumber(summary, ['avg_binder_duration_ms', 'avgBinderDurationMs']),
      max_binder_duration_ms: this.extractNumber(summary, ['max_binder_duration_ms', 'maxBinderDurationMs']),
      blocking_binder_count: this.extractNumber(summary, ['blocking_binder_count', 'blockingBinderCount']),
    };
  }

  /**
   * Extract a number from an object with multiple possible key names
   */
  private extractNumber(obj: any, keys: string[]): number {
    if (!obj) return 0;

    for (const key of keys) {
      if (key in obj) {
        const value = obj[key];
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) return parsed;
        }
      }
    }

    return 0;
  }

  /**
   * Build a cache key for skill results
   */
  private buildCacheKey(
    skillId: string,
    params: Record<string, any>,
    context: DecisionContext
  ): string {
    return `${context.traceId}:${skillId}:${JSON.stringify(params)}`;
  }

  /**
   * Clear the result cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Create a skill executor adapter instance
 */
export function createSkillExecutorAdapter(
  options?: { enableCache?: boolean }
): SkillExecutorAdapter {
  return new SkillExecutorAdapter(options);
}

export default SkillExecutorAdapter;
