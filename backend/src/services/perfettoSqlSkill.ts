/**
 * Perfetto SQL Skill
 *
 * Main service for Perfetto trace analysis using official SQL patterns.
 * Provides specialized analysis functions for common Android performance scenarios.
 *
 * All SQL patterns are based on official Perfetto metrics and stdlib modules.
 */

import { TraceProcessorService } from './traceProcessorService';
import { SqlKnowledgeBase, createKnowledgeBase, getExtendedKnowledgeBase, ExtendedSqlKnowledgeBase } from './sqlKnowledgeBase';
import { EnhancedSQLTemplateEngine, getEnhancedSQLTemplateEngine } from './sqlTemplateEngine';
import {
  PerfettoSkillType,
  type DetectedIntent,
  type PerfettoSqlRequest,
  type PerfettoSqlResponse,
  type StartupResult,
  type ScrollingResult,
  type MemoryResult,
  type CpuResult,
  type SurfaceFlingerResult,
  type InputResult,
  type BinderResult,
  type BufferFlowResult,
  type SystemServerResult,
  type NavigationResult,
  type ClickResponseResult,
} from '../types/perfettoSql';

// ============================================================================
// Skill Classifier
// ============================================================================

interface SkillPattern {
  skillType: PerfettoSkillType;
  keywords: string[];
  patterns: RegExp[];
}

const SKILL_PATTERNS: SkillPattern[] = [
  {
    skillType: PerfettoSkillType.STARTUP,
    keywords: ['startup', 'launch', '启动', '启动时间', '冷启动', '热启动', '温启动'],
    patterns: [
      /startup|launch/i,
      /启动|启动速度|启动时间/i,
      /cold.*start|warm.*start|hot.*start/i,
    ],
  },
  {
    skillType: PerfettoSkillType.SCROLLING,
    keywords: ['scroll', 'jank', 'fps', 'frame', '滑动', '卡顿', '帧率'],
    patterns: [
      /scroll|jank|fps/i,
      /滑动|卡顿|帧率|掉帧/i,
      /frame.*miss/i,
    ],
  },
  {
    skillType: PerfettoSkillType.NAVIGATION,
    keywords: ['navigation', 'activity', 'switch', '切换', '界面切换', '页面跳转'],
    patterns: [
      /navigation|activity.*switch/i,
      /界面切换|页面跳转|activity.*切换/i,
    ],
  },
  {
    skillType: PerfettoSkillType.CLICK_RESPONSE,
    keywords: ['click', 'tap', 'response', 'latency', '点击', '响应', '点击响应'],
    patterns: [
      /click.*response|input.*latency/i,
      /点击响应|点击延迟|输入响应/i,
    ],
  },
  {
    skillType: PerfettoSkillType.MEMORY,
    keywords: ['memory', 'heap', 'oom', 'leak', 'gc', '内存', '内存泄漏', 'OOM'],
    patterns: [
      /memory|heap|oom|leak|gc/i,
      /内存|内存泄漏|OOM|GC/i,
    ],
  },
  {
    skillType: PerfettoSkillType.CPU,
    keywords: ['cpu', 'utilization', 'core', 'frequency', 'CPU利用率', 'CPU频率'],
    patterns: [
      /cpu.*util|cpu.*freq|core/i,
      /CPU利用率|CPU频率|核心/i,
    ],
  },
  {
    skillType: PerfettoSkillType.SURFACE_FLINGER,
    keywords: ['surfaceflinger', 'sf', 'composition', 'gpu', 'fence'],
    patterns: [
      /surfaceflinger|composition|gpu.*fence/i,
    ],
  },
  {
    skillType: PerfettoSkillType.SYSTEM_SERVER,
    keywords: ['systemserver', 'system.*service', 'anr'],
    patterns: [
      /system.*server|system.*service|anr/i,
    ],
  },
  {
    skillType: PerfettoSkillType.INPUT,
    keywords: ['input', 'touch', 'gesture', '输入', '触摸', '手势'],
    patterns: [
      /input.*latency|touch.*event/i,
      /输入延迟|触摸事件|手势/i,
    ],
  },
  {
    skillType: PerfettoSkillType.BINDER,
    keywords: ['binder', 'ipc', 'transaction', 'binder调用'],
    patterns: [
      /binder|ipc|transaction/i,
    ],
  },
  {
    skillType: PerfettoSkillType.BUFFER_FLOW,
    keywords: ['buffer', 'queue', 'fence', 'bufferqueue', '流转'],
    patterns: [
      /buffer.*queue|buffer.*flow/i,
    ],
  },
  {
    skillType: PerfettoSkillType.SLOW_FUNCTIONS,
    keywords: ['slow', 'function', 'method', 'latency', '耗时', '慢函数', '函数耗时'],
    patterns: [
      /slow.*function|method.*latency/i,
      /慢函数|函数耗时|耗时.*函数/i,
    ],
  },
  {
    skillType: PerfettoSkillType.NETWORK,
    keywords: ['network', 'http', 'request', 'socket', '网络', '请求', 'HTTP'],
    patterns: [
      /network|http.*request|socket/i,
      /网络|网络请求|HTTP/i,
    ],
  },
  {
    skillType: PerfettoSkillType.DATABASE,
    keywords: ['database', 'sqlite', 'room', 'db', '数据库', 'SQL'],
    patterns: [
      /database|sqlite|room.*query|db.*query/i,
      /数据库|sqlite|room/i,
    ],
  },
  {
    skillType: PerfettoSkillType.FILE_IO,
    keywords: ['file', 'io', 'read', 'write', '文件', '读写'],
    patterns: [
      /file.*io|file.*read|file.*write|storage/i,
      /文件|读写|文件读写|磁盘/i,
    ],
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert row arrays to row objects for easier access
 * TraceProcessor returns rows as arrays, this converts them to keyed objects
 */
function rowsToObjects(columns: string[], rows: any[][]): Record<string, any>[] {
  return rows.map(row => {
    const obj: Record<string, any> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });
}

/**
 * Format a row for summary display (handles both array and object formats)
 */
function formatRowForSummary(
  row: any[] | Record<string, any>,
  columns: string[],
  formatSpec: { nameCol: string; valueCol: string; extraCol?: string }
): string {
  // If row is an array, convert to object first
  let obj: Record<string, any>;
  if (Array.isArray(row)) {
    obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
  } else {
    obj = row;
  }

  const name = obj[formatSpec.nameCol] ?? 'unknown';
  const value = obj[formatSpec.valueCol];
  const valueStr = typeof value === 'number' ? value.toFixed(2) : String(value ?? 'N/A');
  const extra = formatSpec.extraCol ? ` (${obj[formatSpec.extraCol] ?? ''})` : '';

  return `- ${name}: ${valueStr}ms${extra}`;
}

// ============================================================================
// Main Perfetto SQL Skill Service
// ============================================================================

export class PerfettoSqlSkill {
  private traceProcessor: TraceProcessorService;
  private knowledgeBase: SqlKnowledgeBase;
  private enhancedEngine: EnhancedSQLTemplateEngine | null = null;
  private enhancedEngineInitializing: Promise<EnhancedSQLTemplateEngine> | null = null;

  constructor(traceProcessor: TraceProcessorService, knowledgeBase?: SqlKnowledgeBase) {
    this.traceProcessor = traceProcessor;
    this.knowledgeBase = knowledgeBase || createKnowledgeBase();
  }

  /**
   * Get the enhanced SQL template engine (lazy initialization)
   * Provides access to 527 official Perfetto SQL templates
   */
  private async getEnhancedEngine(): Promise<EnhancedSQLTemplateEngine> {
    if (this.enhancedEngine) {
      return this.enhancedEngine;
    }

    // Prevent multiple concurrent initializations
    if (!this.enhancedEngineInitializing) {
      this.enhancedEngineInitializing = getEnhancedSQLTemplateEngine().then(engine => {
        this.enhancedEngine = engine;
        return engine;
      });
    }

    return this.enhancedEngineInitializing;
  }

  /**
   * Get AI context enriched with official Perfetto SQL patterns
   * This provides the AI with relevant official templates for generating SQL
   */
  async getEnrichedAIContext(question: string): Promise<string> {
    try {
      const engine = await this.getEnhancedEngine();
      return await engine.getAIContext(question);
    } catch (error) {
      console.error('[PerfettoSqlSkill] Failed to get enriched AI context:', error);
      return '';
    }
  }

  /**
   * Get recommended SQL queries for a given category
   */
  async getRecommendedSQLForCategory(category: string): Promise<Array<{name: string; description: string; sql: string}>> {
    try {
      const engine = await this.getEnhancedEngine();
      return await engine.getRecommendedSQL(category);
    } catch (error) {
      console.error('[PerfettoSqlSkill] Failed to get recommended SQL:', error);
      return [];
    }
  }

  /**
   * Get matching official templates for a user query
   */
  async findOfficialTemplates(query: string): Promise<{
    builtinTemplate: any | null;
    officialTemplates: any[];
    recommendedSQL: Array<{name: string; description: string; sql: string}>;
  }> {
    try {
      const engine = await this.getEnhancedEngine();
      return await engine.smartMatchWithOfficial(query);
    } catch (error) {
      console.error('[PerfettoSqlSkill] Failed to find official templates:', error);
      return { builtinTemplate: null, officialTemplates: [], recommendedSQL: [] };
    }
  }

  // ========================================================================
  // Main Entry Point
  // ========================================================================

  /**
   * Analyze a trace based on a natural language question
   */
  async analyze(request: PerfettoSqlRequest): Promise<PerfettoSqlResponse> {
    const { traceId, question, packageName, timeRange } = request;

    // Check if trace exists (for WASM traces, it won't exist in backend)
    const trace = this.traceProcessor.getTrace(traceId);
    const isWasmTrace = !trace;

    if (isWasmTrace) {
      // For WASM traces (Perfetto UI browser engine), generate SQL-only response
      // The UI will execute the SQL locally
      return this.generateSqlOnlyResponse(question, packageName, traceId);
    }

    // Detect the appropriate skill
    const intent = this.detectIntent(question);

    // Route to appropriate skill method
    let result: PerfettoSqlResponse;

    switch (intent.skillType) {
      case PerfettoSkillType.STARTUP:
        result = await this.analyzeStartup(traceId, intent.params.packageName as string || packageName);
        break;
      case PerfettoSkillType.SCROLLING:
        result = await this.analyzeScrolling(traceId, packageName);
        break;
      case PerfettoSkillType.NAVIGATION:
        result = await this.analyzeNavigation(traceId, packageName);
        break;
      case PerfettoSkillType.CLICK_RESPONSE:
        result = await this.analyzeClickResponse(traceId, packageName);
        break;
      case PerfettoSkillType.MEMORY:
        result = await this.analyzeMemory(traceId, packageName);
        break;
      case PerfettoSkillType.CPU:
        result = await this.analyzeCpu(traceId, packageName);
        break;
      case PerfettoSkillType.SURFACE_FLINGER:
        result = await this.analyzeSurfaceFlinger(traceId);
        break;
      case PerfettoSkillType.SYSTEM_SERVER:
        result = await this.analyzeSystemServer(traceId);
        break;
      case PerfettoSkillType.INPUT:
        result = await this.analyzeInput(traceId, packageName);
        break;
      case PerfettoSkillType.BINDER:
        result = await this.analyzeBinder(traceId, packageName);
        break;
      case PerfettoSkillType.BUFFER_FLOW:
        result = await this.analyzeBufferFlow(traceId);
        break;
      case PerfettoSkillType.SLOW_FUNCTIONS:
        result = await this.analyzeSlowFunctions(traceId, packageName);
        break;
      case PerfettoSkillType.NETWORK:
        result = await this.analyzeNetwork(traceId, packageName);
        break;
      case PerfettoSkillType.DATABASE:
        result = await this.analyzeDatabase(traceId, packageName);
        break;
      case PerfettoSkillType.FILE_IO:
        result = await this.analyzeFileIO(traceId, packageName);
        break;
      default:
        // Fallback to generic SQL generation
        result = await this.analyzeGeneric(traceId, question, packageName);
    }

    return result;
  }

  /**
   * Detect the appropriate analysis skill from the question
   */
  private detectIntent(question: string): DetectedIntent {
    const lowerQuestion = question.toLowerCase();

    for (const pattern of SKILL_PATTERNS) {
      // Check keyword matches
      for (const keyword of pattern.keywords) {
        if (lowerQuestion.includes(keyword.toLowerCase())) {
          return {
            skillType: pattern.skillType,
            confidence: 0.8,
            params: this.extractParams(question, pattern.skillType),
          };
        }
      }

      // Check regex patterns
      for (const regex of pattern.patterns) {
        if (regex.test(question)) {
          return {
            skillType: pattern.skillType,
            confidence: 0.75,
            params: this.extractParams(question, pattern.skillType),
          };
        }
      }
    }

    // Default to generic analysis
    return {
      skillType: PerfettoSkillType.STARTUP, // Default fallback
      confidence: 0.3,
      params: {},
    };
  }

  /**
   * Extract parameters from the question
   */
  private extractParams(question: string, skillType: PerfettoSkillType): Record<string, string | number> {
    const params: Record<string, string | number> = {};

    // Extract package name (common pattern: com.example.app)
    const packageMatch = question.match(/([a-z][a-z0-9_]*(\.[a-z0-9_]+)+)/i);
    if (packageMatch) {
      params.packageName = packageMatch[1];
    }

    // Extract numbers (time limits, counts, etc.)
    const numberMatches = question.match(/\b(\d+)\b/g);
    if (numberMatches) {
      params.limit = parseInt(numberMatches[0], 10);
    }

    return params;
  }

  /**
   * Generate SQL-only response for WASM traces (where trace is in browser)
   * The UI will execute this SQL locally
   */
  private async generateSqlOnlyResponse(
    question: string,
    packageName: string | undefined,
    traceId: string
  ): Promise<PerfettoSqlResponse> {
    // Detect the appropriate skill
    const intent = this.detectIntent(question);

    // Build SQL based on the detected skill type
    let sql = '';
    let analysisType = intent.skillType;
    let summary = '';

    switch (intent.skillType) {
      case PerfettoSkillType.STARTUP:
        sql = this.getStartupSql(packageName);
        summary = `Execute this SQL to analyze app startup performance. Look for startup_type (cold/warm/hot), dur (duration), and ttid/ttfd metrics.`;
        break;
      case PerfettoSkillType.SCROLLING:
        sql = this.getScrollingSql(packageName);
        summary = `Execute this SQL to analyze scrolling performance and jank. Look for frame durations, jank_type, and on_time_finish flags.`;
        break;
      case PerfettoSkillType.NAVIGATION:
        sql = this.getNavigationSql(packageName);
        summary = `Execute this SQL to analyze activity navigation performance. Look for activity transitions and their durations.`;
        break;
      case PerfettoSkillType.CLICK_RESPONSE:
        sql = this.getClickResponseSql(packageName);
        summary = `Execute this SQL to analyze click/tap response latency. Look for time from input event to UI response.`;
        break;
      case PerfettoSkillType.MEMORY:
        sql = this.getMemorySql(packageName);
        summary = `Execute this SQL to analyze memory usage. Look for heap size, GC events, and allocation counts.`;
        break;
      case PerfettoSkillType.CPU:
        sql = this.getCpuSql(packageName);
        summary = `Execute this SQL to analyze CPU usage. Look for thread CPU time, utilization, and frequency.`;
        break;
      case PerfettoSkillType.SURFACE_FLINGER:
        sql = this.getSurfaceFlingerSql();
        summary = `Execute this SQL to analyze SurfaceFlinger performance. Look for frame misses, GPU composition, and buffer latency.`;
        break;
      case PerfettoSkillType.INPUT:
        sql = this.getInputSql(packageName);
        summary = `Execute this SQL to analyze input events. Look for event types and their timestamps.`;
        break;
      case PerfettoSkillType.BINDER:
        sql = this.getBinderSql(packageName);
        summary = `Execute this SQL to analyze Binder transactions. Look for transaction durations and AIDL interface names.`;
        break;
      case PerfettoSkillType.BUFFER_FLOW:
        sql = this.getBufferFlowSql();
        summary = `Execute this SQL to analyze buffer queue flow. Look for queue depth and fence wait times.`;
        break;
      case PerfettoSkillType.SYSTEM_SERVER:
        sql = this.getSystemServerSql();
        summary = `Execute this SQL to analyze SystemServer performance. Look for system service call latencies.`;
        break;
      case PerfettoSkillType.SLOW_FUNCTIONS:
        sql = this.getSlowFunctionsSql(packageName);
        summary = `Execute this SQL to analyze long-running main-thread slices (>16ms). Correlate these slices with jank evidence before claiming dropped frames.`;
        break;
      case PerfettoSkillType.NETWORK:
        sql = this.getNetworkSql(packageName);
        summary = `Execute this SQL to analyze network traffic. Look for request/response durations and URLs.`;
        break;
      case PerfettoSkillType.DATABASE:
        sql = this.getDatabaseSql(packageName);
        summary = `Execute this SQL to analyze database queries. Look for SQLite/Room operations and their durations.`;
        break;
      case PerfettoSkillType.FILE_IO:
        sql = this.getFileIOSql(packageName);
        summary = `Execute this SQL to analyze file I/O operations. Look for read/write operations and their durations.`;
        break;
      default:
        // Generic query - suggest exploring tables
        sql = `
-- General trace exploration
-- List all available tables
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- Get process list
SELECT pid, name, uid FROM process ORDER BY name;

-- Get thread list with process info
SELECT
  t.tid,
  t.name as thread_name,
  p.name as process_name,
  p.pid
FROM thread t
LEFT JOIN process p ON t.upid = p.upid
ORDER BY p.name, t.name;
        `;
        analysisType = PerfettoSkillType.STARTUP; // Use startup as default
        summary = 'Explore the trace structure using these queries.';
    }

    // Get official template recommendations for enriched context
    let officialTemplates: any[] = [];
    let recommendedSQL: Array<{name: string; description: string; sql: string}> = [];
    let aiContext = '';

    try {
      const matchResult = await this.findOfficialTemplates(question);
      officialTemplates = matchResult.officialTemplates.slice(0, 5); // Top 5 matches
      recommendedSQL = matchResult.recommendedSQL.slice(0, 3); // Top 3 recommendations
      aiContext = await this.getEnrichedAIContext(question);
    } catch (error) {
      console.log('[PerfettoSqlSkill] Could not load official templates (optional enhancement)');
    }

    return {
      analysisType,
      sql,
      rows: [],
      rowCount: 0,
      summary,
      details: {
        note: 'For WASM traces: Execute this SQL in Perfetto UI to see results',
        question,
        packageName: packageName || null,
        // Enhanced with official Perfetto SQL library
        officialTemplates: officialTemplates.map(t => ({
          id: t.id,
          name: t.name,
          category: t.category,
          type: t.type,
          description: t.description,
        })),
        recommendedSQL,
        hasOfficialLibrary: officialTemplates.length > 0,
      },
      // Provide AI context for downstream processing
      aiContext,
    };
  }

  // SQL template generators for WASM trace mode
  private getStartupSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE package GLOB '${packageName}*'` : '';
    return `
-- App Startup Analysis
SELECT
  startup_id,
  ts / 1e6 as ts_ms,
  dur / 1e6 as dur_ms,
  package,
  process_name,
  startup_type,
  ttid,
  ttfd
FROM android_startups
${whereClause}
ORDER BY ts ASC;
    `;
  }

  private getScrollingSql(packageName?: string): string {
    const processFilter = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Scrolling Performance Analysis (FrameTimeline)
SELECT
  afs.id,
  afs.ts / 1e6 as ts_ms,
  afs.dur / 1e6 as dur_ms,
  p.name as process,
  afs.name,
  afs.on_time_finish,
  afs.gpu_composition,
  afs.jank_type
FROM actual_frame_timeline_slice afs
LEFT JOIN process p ON afs.upid = p.upid
${processFilter}
ORDER BY afs.ts ASC;
    `;
  }

  private getNavigationSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE package GLOB '${packageName}*'` : '';
    return `
-- Activity Navigation Analysis
SELECT
  ts / 1e6 as ts_ms,
  dur / 1e6 as dur_ms,
  package,
  activity,
  reason
FROM activity_manager_transitions
${whereClause}
ORDER BY ts ASC;
    `;
  }

  private getClickResponseSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Click Response Analysis
SELECT
  e.ts / 1e6 as ts_ms,
  e.name as event_type,
  e.arg_set_id
FROM slice e
JOIN track t ON e.track_id = t.id
JOIN process_track pt ON t.id = pt.id
JOIN process p ON pt.upid = p.upid
${whereClause.replace('WHERE', 'AND')} AND e.name LIKE '%Click%'
ORDER BY e.ts ASC;
    `;
  }

  private getMemorySql(packageName?: string): string {
    const whereClause = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Memory Analysis (Heap Profile)
SELECT
  ts / 1e6 as ts_ms,
  upid,
  heap_size,
  anon_rss,
  file_rss,
  swap_rss
FROM heap_profile_summary
ORDER BY ts ASC;
    `;
  }

  private getCpuSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- CPU Usage Analysis
SELECT
  t.tid,
  t.name as thread_name,
  p.name as process_name,
  SUM(s.dur) / 1e9 as total_cpu_sec
FROM sched s
JOIN thread t ON s.utid = t.utid
LEFT JOIN process p ON t.upid = p.upid
${whereClause.replace('WHERE', 'AND')}
GROUP BY t.tid, t.name, p.name
ORDER BY total_cpu_sec DESC;
    `;
  }

  private getSurfaceFlingerSql(): string {
    return `
-- SurfaceFlinger Analysis
SELECT
  ts / 1e6 as ts_ms,
  dur / 1e6 as dur_ms,
  display_id,
  present_type,
  gpu_composition,
  sf_jank_type
FROM gfx_composition
ORDER BY ts ASC;
    `;
  }

  private getInputSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Input Events Analysis
SELECT
  e.ts / 1e6 as ts_ms,
  e.name as event_name,
  p.name as process_name
FROM slice e
JOIN track t ON e.track_id = t.id
JOIN process_track pt ON t.id = pt.id
JOIN process p ON pt.upid = p.upid
${whereClause.replace('WHERE', 'AND')} AND (e.name GLOB '*Input*' OR e.name GLOB '*Touch*' OR e.name GLOB '*Key*')
ORDER BY e.ts ASC;
    `;
  }

  private getBinderSql(packageName?: string): string {
    const whereClause = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Binder Transactions Analysis
SELECT
  ts / 1e6 as ts_ms,
  dur / 1e6 as dur_ms,
  aidl_name,
  is_sync,
  thread_name
FROM binder_txn
${whereClause.replace('WHERE', 'AND')}
ORDER BY ts ASC;
    `;
  }

  private getBufferFlowSql(): string {
    return `
-- Buffer Queue Flow Analysis
SELECT
  ts / 1e6 as ts_ms,
  queue_depth,
  fence_wait_time_ns / 1e6 as fence_wait_ms,
  buffer_id
FROM buffer_queue_state
ORDER BY ts ASC;
    `;
  }

  private getSystemServerSql(): string {
    return `
-- SystemServer Performance
SELECT
  ts / 1e6 as ts_ms,
  dur / 1e6 as dur_ms,
  service_name,
  interface_name
FROM system_server_calls
ORDER BY ts ASC;
    `;
  }

  private getSlowFunctionsSql(packageName?: string): string {
    const processFilter = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Slow Main-Thread Functions Analysis (>16ms)
SELECT
  s.name as function_name,
  COUNT(*) as count,
  AVG(s.dur) / 1e6 as avg_dur_ms,
  MAX(s.dur) / 1e6 as max_dur_ms,
  SUM(s.dur) / 1e6 as total_dur_ms,
  p.name as process_name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
${processFilter.replace('WHERE', 'AND')}
  AND s.dur > 16000000
  AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = p.pid OR LOWER(COALESCE(t.name, '')) = 'main')
GROUP BY s.name, p.name
ORDER BY total_dur_ms DESC;
    `;
  }

  private getNetworkSql(packageName?: string): string {
    const processFilter = packageName ? `AND p.name GLOB '${packageName}*'` : '';
    return `
-- Network Traffic Analysis
SELECT
  net.name,
  net.slice_id,
  net.ts / 1e6 as ts_ms,
  net.dur / 1e6 as dur_ms,
  t.name as thread_name,
  p.name as process_name
FROM network_traffic_slice net
JOIN thread_track tt ON net.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE 1=1
  ${processFilter}
ORDER BY net.ts ASC;
    `;
  }

  private getDatabaseSql(packageName?: string): string {
    const processFilter = packageName ? `AND p.name GLOB '${packageName}*'` : '';
    return `
-- Database Query Analysis (SQLite/Room)
SELECT
  s.name,
  s.ts / 1e6 as ts_ms,
  s.dur / 1e6 as dur_ms,
  t.name as thread_name,
  p.name as process_name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE s.name GLOB '*sqlite*%' OR s.name GLOB '*room*%'
  ${processFilter}
ORDER BY s.ts ASC;
    `;
  }

  private getFileIOSql(packageName?: string): string {
    const processFilter = packageName ? `AND p.name GLOB '${packageName}*'` : '';
    return `
-- File I/O Analysis
SELECT
  s.name,
  s.ts / 1e6 as ts_ms,
  s.dur / 1e6 as dur_ms,
  t.name as thread_name,
  p.name as process_name
FROM slice s
JOIN thread_track tt ON s.track_id = tt.id
JOIN thread t ON tt.utid = t.utid
JOIN process p ON t.upid = p.upid
WHERE s.name GLOB '*read*%' OR s.name GLOB '*write*%' OR s.name GLOB '*fs_*%'
  ${processFilter}
ORDER BY s.ts ASC;
    `;
  }

  // ========================================================================
  // Skill-Specific Analysis Methods
  // ========================================================================

  /**
   * Analyze app startup performance
   * Based on: perfetto_sql/stdlib/android/startup/startups_minsdk33.sql
   */
  async analyzeStartup(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    // 尝试多种方法获取启动数据
    console.log('[PerfettoSqlSkill] analyzeStartup called for package:', packageName);

    // 方法1: 尝试使用 android_startup_processes 表（更可靠）
    try {
      await this.traceProcessor.query(traceId, 'INCLUDE PERFETTO MODULE android.startup.startup_events;');
      console.log('[PerfettoSqlSkill] android.startup.startup_events module included');
    } catch (e) {
      console.log('[PerfettoSqlSkill] startup_events module not available');
    }

    // 方法2: 尝试 android.startup.startups 模块
    try {
      await this.traceProcessor.query(traceId, 'INCLUDE PERFETTO MODULE android.startup.startups;');
      console.log('[PerfettoSqlSkill] android.startup.startups module included');
    } catch (e) {
      console.log('[PerfettoSqlSkill] startups module not available');
    }

    // 诊断：检查可用的启动相关表
    const availableTables: string[] = [];
    const tablesToCheck = ['android_startups', 'android_startup_processes', '_startup_events'];
    for (const table of tablesToCheck) {
      try {
        const checkResult = await this.traceProcessor.query(traceId, `SELECT COUNT(*) as cnt FROM ${table}`);
        const count = checkResult.rows?.[0]?.[0] ?? 0;
        console.log(`[PerfettoSqlSkill] Table ${table}: ${count} rows`);
        if (count > 0) availableTables.push(table);
      } catch (e) {
        console.log(`[PerfettoSqlSkill] Table ${table} not available`);
      }
    }

    // 如果 android_startups 有数据，使用它
    if (availableTables.includes('android_startups')) {
      let whereClause = '';
      if (packageName) {
        whereClause = `WHERE (
          package GLOB '${packageName}*'
          OR package GLOB '*${packageName.split('.').pop()}*'
        )`;
      }

      const sql = `
        SELECT
          startup_id,
          ts / 1e6 as ts_ms,
          dur / 1e6 as dur_ms,
          package,
          startup_type
        FROM android_startups
        ${whereClause}
        ORDER BY ts ASC
      `;

      const queryResult = await this.traceProcessor.query(traceId, sql);
      if (!queryResult.error && queryResult.rows.length > 0) {
        console.log('[PerfettoSqlSkill] Got data from android_startups:', queryResult.rows.length, 'rows');
        const startupObjects = rowsToObjects(queryResult.columns, queryResult.rows);
        return {
          analysisType: 'startup',
          sql,
          rows: queryResult.rows,
          rowCount: queryResult.rows.length,
          summary: this.formatStartupSummary(startupObjects),
          metrics: {
            totalStartups: queryResult.rows.length,
            coldStarts: startupObjects.filter((s: any) => s.startup_type === 'cold').length,
            warmStarts: startupObjects.filter((s: any) => s.startup_type === 'warm').length,
            hotStarts: startupObjects.filter((s: any) => s.startup_type === 'hot').length,
          },
        };
      }
    }

    // 如果 android_startup_processes 有数据，使用它
    if (availableTables.includes('android_startup_processes')) {
      let whereClause = '';
      if (packageName) {
        whereClause = `WHERE (
          package GLOB '${packageName}*'
          OR package GLOB '*${packageName.split('.').pop()}*'
          OR name GLOB '${packageName}*'
        )`;
      }

      const sql = `
        SELECT
          startup_id,
          startup_type,
          package,
          name as process_name,
          ts / 1e6 as ts_ms,
          dur / 1e6 as dur_ms
        FROM android_startup_processes
        ${whereClause}
        ORDER BY ts ASC
      `;

      const queryResult = await this.traceProcessor.query(traceId, sql);
      if (!queryResult.error && queryResult.rows.length > 0) {
        console.log('[PerfettoSqlSkill] Got data from android_startup_processes:', queryResult.rows.length, 'rows');
        const startupObjects = rowsToObjects(queryResult.columns, queryResult.rows);
        return {
          analysisType: 'startup',
          sql,
          rows: queryResult.rows,
          rowCount: queryResult.rows.length,
          summary: this.formatStartupProcessesSummary(startupObjects),
          metrics: {
            totalStartups: queryResult.rows.length,
            coldStarts: startupObjects.filter((s: any) => s.startup_type === 'cold').length,
            warmStarts: startupObjects.filter((s: any) => s.startup_type === 'warm').length,
            hotStarts: startupObjects.filter((s: any) => s.startup_type === 'hot').length,
          },
        };
      }
    }

    // 方法3: 直接从 slice 表查询启动生命周期事件
    console.log('[PerfettoSqlSkill] Falling back to slice-based startup analysis');
    return this.analyzeStartupFromSlices(traceId, packageName);
  }

  /**
   * 从 slice 表直接分析启动事件
   * 查询完整的 Activity 生命周期和启动相关事件
   */
  private async analyzeStartupFromSlices(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    // 构建进程过滤条件 - 支持包名和进程名的多种匹配方式
    let processFilter = '';
    if (packageName) {
      // Android 进程名可能被截断，所以使用多种匹配方式
      const lastPart = packageName.split('.').pop() || packageName;
      processFilter = `AND (
        p.name GLOB '${packageName}*'
        OR p.name GLOB '*${lastPart}*'
        OR p.name LIKE '%${packageName}%'
        OR p.cmdline GLOB '*${packageName}*'
      )`;
    }

    // 查询完整的启动生命周期事件
    const sql = `
      SELECT
        s.name as event_name,
        s.ts / 1e6 as ts_ms,
        s.dur / 1e6 as dur_ms,
        p.name as process_name,
        t.name as thread_name,
        p.pid,
        CASE
          WHEN s.name GLOB '*bindApplication*' THEN 1
          WHEN s.name GLOB '*activityStart*' THEN 2
          WHEN s.name GLOB '*performCreate*' OR s.name GLOB '*onCreate*' THEN 3
          WHEN s.name GLOB '*performResume*' OR s.name GLOB '*onResume*' THEN 4
          WHEN s.name GLOB '*inflate*' THEN 5
          WHEN s.name GLOB '*traversal*' OR s.name GLOB '*measure*' OR s.name GLOB '*layout*' THEN 6
          WHEN s.name GLOB '*draw*' OR s.name GLOB '*Choreographer*doFrame*' THEN 7
          WHEN s.name GLOB '*reportFullyDrawn*' THEN 8
          ELSE 99
        END as phase_order
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE (
        s.name GLOB '*bindApplication*'
        OR s.name GLOB '*activityStart*'
        OR s.name GLOB '*ActivityThread*main*'
        OR s.name GLOB '*performCreate*'
        OR s.name GLOB '*onCreate*'
        OR s.name GLOB '*performResume*'
        OR s.name GLOB '*onResume*'
        OR s.name GLOB '*inflate*'
        OR s.name GLOB '*traversal*'
        OR s.name GLOB '*measure*'
        OR s.name GLOB '*layout*'
        OR s.name GLOB '*draw*'
        OR s.name GLOB '*Choreographer*doFrame*'
        OR s.name GLOB '*reportFullyDrawn*'
        OR s.name GLOB '*launching*'
        OR s.name GLOB '*ResourcesImpl*'
        OR s.name GLOB '*Lock*contention*'
        OR s.name GLOB '*Choreographer*'
      )
      ${processFilter}
      ORDER BY s.ts ASC
    `;

    console.log('[PerfettoSqlSkill] analyzeStartupFromSlices SQL (truncated):', sql.substring(0, 400));
    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      console.log('[PerfettoSqlSkill] analyzeStartupFromSlices error:', queryResult.error);
      return this.analyzeStartupFallback(traceId, packageName);
    }

    if (queryResult.rows.length === 0) {
      console.log('[PerfettoSqlSkill] analyzeStartupFromSlices: no results, trying broader fallback');
      return this.analyzeStartupFallback(traceId, packageName);
    }

    console.log('[PerfettoSqlSkill] analyzeStartupFromSlices found', queryResult.rows.length, 'events');

    // 转换为对象并生成摘要
    const events = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatStartupEventsSummary(events);

    return {
      analysisType: 'startup',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
      details: {
        method: 'slice_based_analysis',
        events: events.slice(0, 20), // 前 20 个事件
      },
    };
  }

  /**
   * Analyze app startup with detailed breakdown
   * Includes: slice durations, CPU core distribution, frequency, thread blocking
   */
  async analyzeStartupDetailed(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    console.log('[PerfettoSqlSkill] analyzeStartupDetailed called for package:', packageName);

    // Include startup modules
    try {
      await this.traceProcessor.query(traceId, 'INCLUDE PERFETTO MODULE android.startup.startups;');
    } catch (e) {
      console.log('[PerfettoSqlSkill] startups module not available');
    }

    // 1. First, get all startups from android_startups table
    let whereClause = '';
    if (packageName) {
      whereClause = `WHERE (package GLOB '${packageName}*' OR package GLOB '*${packageName.split('.').pop()}*')`;
    }

    const startupsSql = `
      SELECT
        startup_id,
        ts,
        ts + dur as ts_end,
        ts / 1e6 as ts_ms,
        dur / 1e6 as dur_ms,
        package,
        startup_type
      FROM android_startups
      ${whereClause}
      ORDER BY ts ASC
    `;

    const startupsResult = await this.traceProcessor.query(traceId, startupsSql);

    if (startupsResult.error || startupsResult.rows.length === 0) {
      console.log('[PerfettoSqlSkill] No startups found in android_startups table');
      return {
        analysisType: 'startup_detailed',
        sql: startupsSql,
        rows: [],
        rowCount: 0,
        summary: '未找到启动事件。请确保 Trace 包含应用启动数据。',
        error: startupsResult.error || 'No startup events found',
      };
    }

    const startups = rowsToObjects(startupsResult.columns, startupsResult.rows);
    console.log(`[PerfettoSqlSkill] Found ${startups.length} startup(s) to analyze`);

    // Analyze each startup separately
    const startupAnalyses: any[] = [];

    for (let i = 0; i < startups.length; i++) {
      const startup = startups[i];
      const startupStart = startup.ts as number;
      const startupEnd = startup.ts_end as number;
      const startupPackage = startup.package as string;
      const startupType = startup.startup_type as string;
      const startupDurMs = startup.dur_ms as number;

      console.log(`[PerfettoSqlSkill] Analyzing startup ${i + 1}/${startups.length}: ${startupPackage} (${startupType}), ${startupDurMs.toFixed(2)}ms`);

      // Get main thread utid for this startup
      let mainThreadUtid = 0;
      try {
        const utidSql = `
          SELECT t.utid
          FROM thread t
          JOIN process p ON t.upid = p.upid
          WHERE t.name = 'main' AND p.name GLOB '${startupPackage}*'
          LIMIT 1
        `;
        const utidResult = await this.traceProcessor.query(traceId, utidSql);
        if (utidResult.rows.length > 0) {
          mainThreadUtid = utidResult.rows[0][0] as number;
        }
      } catch (e) {
        console.log('[PerfettoSqlSkill] Could not find main thread utid');
      }

      const analysis = await this.analyzeOneStartup(
        traceId,
        startupStart,
        startupEnd,
        startupPackage,
        startupType,
        startupDurMs,
        mainThreadUtid,
        i + 1
      );

      startupAnalyses.push(analysis);
    }

    // Build final result
    const results: any = {
      analysisType: 'startup_detailed',
      packageName: packageName || 'all',
      totalStartups: startups.length,
      startupAnalyses,
      sql: startupsSql,
      rowCount: startups.length,
    };

    results.summary = this.formatMultiStartupSummary(startupAnalyses);
    return results;
  }

  /**
   * Analyze a single startup event with all detailed metrics
   */
  private async analyzeOneStartup(
    traceId: string,
    startupStart: number,
    startupEnd: number,
    packageName: string,
    startupType: string,
    durationMs: number,
    mainThreadUtid: number,
    startupIndex: number
  ): Promise<any> {
    const sections: any = {};

    // Basic info
    sections.basicInfo = {
      title: `启动 #${startupIndex} 基本信息`,
      data: {
        packageName,
        startupType,
        durationMs: durationMs.toFixed(2),
        startTimeNs: startupStart,
        endTimeNs: startupEnd,
      }
    };

    // 2. Get top slices by duration during startup
    try {
      const topSlicesSql = `
        SELECT
          s.name as slice_name,
          s.dur / 1e6 as dur_ms,
          (s.ts - ${startupStart}) / 1e6 as relative_ts_ms,
          t.name as thread_name,
          s.depth
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.dur > 0
          AND p.name GLOB '${packageName}*'
          AND s.ts >= ${startupStart} AND s.ts <= ${startupEnd}
        ORDER BY s.dur DESC
        LIMIT 50
      `;

      const topSlicesResult = await this.traceProcessor.query(traceId, topSlicesSql);
      if (!topSlicesResult.error && topSlicesResult.rows.length > 0) {
        sections.topSlices = {
          title: '启动期间耗时最长的 Slice',
          columns: topSlicesResult.columns,
          data: rowsToObjects(topSlicesResult.columns, topSlicesResult.rows),
          sql: topSlicesSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] topSlices query failed:', e);
    }

    // 3. CPU Core Distribution (Big vs Little cores) for main thread
    try {
      const utidFilter = mainThreadUtid > 0 ? `sched.utid = ${mainThreadUtid}` :
        `t.name = 'main' AND p.name GLOB '${packageName}*'`;

      const cpuCoreSql = `
        SELECT
          sched.cpu,
          CASE
            WHEN sched.cpu IN (0, 1, 2, 3) THEN 'little'
            WHEN sched.cpu IN (4, 5, 6, 7) THEN 'big'
            ELSE 'unknown'
          END as core_type,
          SUM(sched.dur) / 1e6 as total_dur_ms,
          COUNT(*) as slice_count,
          AVG(sched.dur) / 1e6 as avg_dur_ms
        FROM sched_slice sched
        JOIN thread t ON sched.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE sched.dur > 0
          AND ${utidFilter}
          AND sched.ts >= ${startupStart} AND sched.ts <= ${startupEnd}
        GROUP BY sched.cpu
        ORDER BY total_dur_ms DESC
      `;

      const cpuCoreResult = await this.traceProcessor.query(traceId, cpuCoreSql);
      if (!cpuCoreResult.error && cpuCoreResult.rows.length > 0) {
        const coreData = rowsToObjects(cpuCoreResult.columns, cpuCoreResult.rows);

        // Calculate big vs little ratio
        let bigCoreTime = 0;
        let littleCoreTime = 0;
        coreData.forEach((row: any) => {
          if (row.core_type === 'big') bigCoreTime += row.total_dur_ms || 0;
          else if (row.core_type === 'little') littleCoreTime += row.total_dur_ms || 0;
        });

        const totalCoreTime = bigCoreTime + littleCoreTime;
        sections.cpuCoreDistribution = {
          title: 'CPU 大小核分布',
          data: coreData,
          summary: {
            bigCoreTime: bigCoreTime.toFixed(2),
            littleCoreTime: littleCoreTime.toFixed(2),
            bigCorePercent: totalCoreTime > 0 ? ((bigCoreTime / totalCoreTime) * 100).toFixed(1) : '0',
            littleCorePercent: totalCoreTime > 0 ? ((littleCoreTime / totalCoreTime) * 100).toFixed(1) : '0',
          },
          sql: cpuCoreSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] cpuCore query failed:', e);
    }

    // 4. CPU Frequency during startup
    try {
      const cpuFreqSql = `
        SELECT
          cpu,
          CAST(AVG(value) AS INTEGER) / 1000 as avg_freq_mhz,
          CAST(MAX(value) AS INTEGER) / 1000 as max_freq_mhz,
          CAST(MIN(value) AS INTEGER) / 1000 as min_freq_mhz
        FROM counter c
        JOIN cpu_counter_track cct ON c.track_id = cct.id
        WHERE cct.name = 'cpufreq'
          AND c.ts >= ${startupStart} AND c.ts <= ${startupEnd}
        GROUP BY cpu
        ORDER BY cpu
      `;

      const cpuFreqResult = await this.traceProcessor.query(traceId, cpuFreqSql);
      if (!cpuFreqResult.error && cpuFreqResult.rows.length > 0) {
        const freqData = rowsToObjects(cpuFreqResult.columns, cpuFreqResult.rows);

        // Calculate average across big and little cores
        let bigCoreAvgFreq = 0;
        let littleCoreAvgFreq = 0;
        let bigCount = 0;
        let littleCount = 0;

        freqData.forEach((row: any) => {
          const cpu = row.cpu as number;
          const avgFreq = row.avg_freq_mhz || 0;
          if (cpu >= 4) {
            bigCoreAvgFreq += avgFreq;
            bigCount++;
          } else {
            littleCoreAvgFreq += avgFreq;
            littleCount++;
          }
        });

        sections.cpuFrequency = {
          title: 'CPU 频率信息',
          data: freqData,
          summary: {
            bigCoreAvgFreq: bigCount > 0 ? (bigCoreAvgFreq / bigCount).toFixed(0) : 'N/A',
            littleCoreAvgFreq: littleCount > 0 ? (littleCoreAvgFreq / littleCount).toFixed(0) : 'N/A',
          },
          sql: cpuFreqSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] cpuFreq query failed:', e);
    }

    // 5. Main Thread State Analysis (Running/Runnable/Sleeping breakdown)
    try {
      const utidFilter = mainThreadUtid > 0 ? `ts.utid = ${mainThreadUtid}` :
        `t.name = 'main' AND p.name GLOB '${packageName}*'`;

      const threadStateSql = `
        SELECT
          ts.state,
          CASE ts.state
            WHEN 'Running' THEN 'Running (执行中)'
            WHEN 'R' THEN 'Runnable (可运行)'
            WHEN 'R+' THEN 'Runnable (可运行,抢占)'
            WHEN 'S' THEN 'Sleeping (睡眠)'
            WHEN 'D' THEN 'Uninterruptible Sleep (不可中断睡眠)'
            WHEN 'I' THEN 'Idle (空闲)'
            ELSE ts.state
          END as state_desc,
          SUM(ts.dur) / 1e6 as total_dur_ms,
          COUNT(*) as count,
          (SUM(ts.dur) * 100.0) / ${startupEnd - startupStart} as percent
        FROM thread_state ts
        JOIN thread t ON ts.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE ${utidFilter}
          AND ts.ts >= ${startupStart} AND ts.ts <= ${startupEnd}
        GROUP BY ts.state
        ORDER BY total_dur_ms DESC
      `;

      const threadStateResult = await this.traceProcessor.query(traceId, threadStateSql);
      if (!threadStateResult.error && threadStateResult.rows.length > 0) {
        sections.threadStateDistribution = {
          title: '主线程状态分布',
          data: rowsToObjects(threadStateResult.columns, threadStateResult.rows),
          sql: threadStateSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] threadState query failed:', e);
    }

    // 6. Thread Blocking Analysis (detailed)
    try {
      const utidFilter = mainThreadUtid > 0 ? `ts.utid = ${mainThreadUtid}` : '';

      const blockingSql = `
        SELECT
          ts.state,
          ts.blocked_function,
          ts.dur / 1e6 as dur_ms,
          (ts.ts - ${startupStart}) / 1e6 as relative_ts_ms,
          CASE
            WHEN ts.blocked_function GLOB '*binder*' THEN 'binder'
            WHEN ts.blocked_function GLOB '*futex*' OR ts.blocked_function GLOB '*mutex*' THEN 'lock_contention'
            WHEN ts.blocked_function GLOB '*epoll*' OR ts.blocked_function GLOB '*poll*' THEN 'io_wait'
            WHEN ts.blocked_function GLOB '*sleep*' THEN 'sleep'
            WHEN ts.blocked_function GLOB '*SurfaceFlinger*' OR ts.blocked_function GLOB '*dequeue*' THEN 'surfaceflinger'
            WHEN ts.blocked_function GLOB '*GC*' OR ts.blocked_function GLOB '*art::gc*' THEN 'gc'
            ELSE 'other'
          END as block_type
        FROM thread_state ts
        JOIN thread t ON ts.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE ts.state IN ('S', 'D', 'I')
          AND ts.dur > 1000000
          ${utidFilter ? `AND ${utidFilter}` : `AND t.name = 'main' AND p.name GLOB '${packageName}*'`}
          AND ts.ts >= ${startupStart} AND ts.ts <= ${startupEnd}
        ORDER BY ts.dur DESC
        LIMIT 50
      `;

      const blockingResult = await this.traceProcessor.query(traceId, blockingSql);
      if (!blockingResult.error && blockingResult.rows.length > 0) {
        const blockData = rowsToObjects(blockingResult.columns, blockingResult.rows);

        // Summarize by block type
        const blockSummary: Record<string, { count: number; totalMs: number }> = {};
        blockData.forEach((row: any) => {
          const type = row.block_type || 'other';
          if (!blockSummary[type]) {
            blockSummary[type] = { count: 0, totalMs: 0 };
          }
          blockSummary[type].count++;
          blockSummary[type].totalMs += row.dur_ms || 0;
        });

        sections.threadBlocking = {
          title: '主线程阻塞分析',
          data: blockData,
          summary: blockSummary,
          sql: blockingSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] blocking query failed:', e);
    }

    // 7. Binder transactions during startup
    try {
      const binderTxnSql = `
        SELECT
          client_process,
          server_process,
          client_dur / 1e6 as client_dur_ms,
          server_dur / 1e6 as server_dur_ms,
          (client_ts - ${startupStart}) / 1e6 as relative_ts_ms
        FROM android_binder_txns
        WHERE client_dur > 1000000
          AND (client_process GLOB '${packageName}*' OR server_process GLOB '${packageName}*')
          AND client_ts >= ${startupStart} AND client_ts <= ${startupEnd}
        ORDER BY client_dur DESC
        LIMIT 30
      `;

      const binderResult = await this.traceProcessor.query(traceId, binderTxnSql);
      if (!binderResult.error && binderResult.rows.length > 0) {
        sections.binderTransactions = {
          title: 'Binder 事务分析',
          data: rowsToObjects(binderResult.columns, binderResult.rows),
          sql: binderTxnSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] binder query failed (table may not exist):', e);
    }

    // 8. Main thread CPU utilization
    try {
      const utidFilter = mainThreadUtid > 0 ? `sched.utid = ${mainThreadUtid}` :
        `t.name = 'main' AND p.name GLOB '${packageName}*'`;

      const cpuUtilSql = `
        SELECT
          SUM(sched.dur) / 1e6 as running_time_ms,
          ${durationMs.toFixed(2)} as total_time_ms,
          (SUM(sched.dur) * 100.0) / ${startupEnd - startupStart} as cpu_utilization_percent
        FROM sched_slice sched
        JOIN thread t ON sched.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE ${utidFilter}
          AND sched.ts >= ${startupStart} AND sched.ts <= ${startupEnd}
      `;

      const cpuUtilResult = await this.traceProcessor.query(traceId, cpuUtilSql);
      if (!cpuUtilResult.error && cpuUtilResult.rows.length > 0) {
        const utilData = rowsToObjects(cpuUtilResult.columns, cpuUtilResult.rows);
        sections.cpuUtilization = {
          title: '主线程 CPU 利用率',
          data: utilData[0],
          sql: cpuUtilSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] cpuUtil query failed:', e);
    }

    // 9. GC Events during startup
    try {
      const gcSql = `
        SELECT
          s.name as gc_type,
          s.dur / 1e6 as dur_ms,
          (s.ts - ${startupStart}) / 1e6 as relative_ts_ms
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name GLOB '${packageName}*'
          AND (s.name GLOB '*GC*' OR s.name GLOB '*garbage*' OR s.name GLOB '*art::gc*')
          AND s.ts >= ${startupStart} AND s.ts <= ${startupEnd}
        ORDER BY s.dur DESC
      `;

      const gcResult = await this.traceProcessor.query(traceId, gcSql);
      if (!gcResult.error && gcResult.rows.length > 0) {
        const gcData = rowsToObjects(gcResult.columns, gcResult.rows);
        const totalGcTime = gcData.reduce((sum: number, row: any) => sum + (row.dur_ms || 0), 0);
        sections.gcEvents = {
          title: 'GC 事件',
          data: gcData,
          summary: {
            count: gcData.length,
            totalTimeMs: totalGcTime.toFixed(2),
            percentOfStartup: ((totalGcTime / durationMs) * 100).toFixed(1),
          },
          sql: gcSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] GC query failed:', e);
    }

    // 10. Key startup phases breakdown
    try {
      const phasesSql = `
        SELECT
          s.name as phase_name,
          s.dur / 1e6 as dur_ms,
          (s.ts - ${startupStart}) / 1e6 as relative_start_ms,
          ((s.ts + s.dur) - ${startupStart}) / 1e6 as relative_end_ms
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name GLOB '${packageName}*'
          AND t.name = 'main'
          AND (s.name GLOB '*bindApplication*'
               OR s.name GLOB '*activityStart*'
               OR s.name GLOB '*performCreate*'
               OR s.name GLOB '*onCreate*'
               OR s.name GLOB '*performResume*'
               OR s.name GLOB '*onResume*'
               OR s.name GLOB '*Choreographer#doFrame*'
               OR s.name GLOB '*reportFullyDrawn*'
               OR s.name GLOB '*contentProviderCreate*'
               OR s.name GLOB '*Application.onCreate*')
          AND s.ts >= ${startupStart} AND s.ts <= ${startupEnd}
        ORDER BY s.ts ASC
      `;

      const phasesResult = await this.traceProcessor.query(traceId, phasesSql);
      if (!phasesResult.error && phasesResult.rows.length > 0) {
        sections.startupPhases = {
          title: '关键启动阶段',
          data: rowsToObjects(phasesResult.columns, phasesResult.rows),
          sql: phasesSql,
        };
      }
    } catch (e) {
      console.log('[PerfettoSqlSkill] phases query failed:', e);
    }

    // Return the complete analysis for this startup
    return {
      startupIndex,
      packageName,
      startupType,
      durationMs: durationMs.toFixed(2),
      sections,
      summary: this.formatSingleStartupSummary(sections, packageName, startupType, durationMs, startupIndex),
    };
  }

  /**
   * Format summary for a single startup event
   */
  private formatSingleStartupSummary(
    sections: any,
    packageName: string,
    startupType: string,
    durationMs: number,
    startupIndex: number
  ): string {
    const lines: string[] = [`\n========== 启动 #${startupIndex} 详细分析 ==========\n`];

    // Basic info
    lines.push('【基础信息】');
    lines.push(`  包名: ${packageName}`);
    lines.push(`  启动类型: ${startupType}`);
    lines.push(`  总耗时: ${durationMs.toFixed(2)}ms`);
    lines.push('');

    // Key startup phases
    if (sections.startupPhases?.data?.length > 0) {
      lines.push('【关键启动阶段】');
      sections.startupPhases.data.forEach((row: any) => {
        lines.push(`  ${row.phase_name}: ${row.dur_ms?.toFixed(2) ?? 'N/A'}ms (@ ${row.relative_start_ms?.toFixed(1) ?? 'N/A'}ms)`);
      });
      lines.push('');
    }

    // Top Slices
    if (sections.topSlices?.data?.length > 0) {
      lines.push('【耗时最长的操作 (Top 10)】');
      sections.topSlices.data.slice(0, 10).forEach((row: any, idx: number) => {
        lines.push(`  ${idx + 1}. ${row.slice_name}: ${row.dur_ms?.toFixed(2) ?? 'N/A'}ms (${row.thread_name})`);
      });
      lines.push('');
    }

    // Thread State Distribution
    if (sections.threadStateDistribution?.data?.length > 0) {
      lines.push('【主线程状态分布】');
      sections.threadStateDistribution.data.forEach((row: any) => {
        lines.push(`  ${row.state_desc || row.state}: ${row.total_dur_ms?.toFixed(2) ?? 'N/A'}ms (${row.percent?.toFixed(1) ?? 'N/A'}%)`);
      });
      lines.push('');
    }

    // CPU Core Distribution
    if (sections.cpuCoreDistribution?.summary) {
      const s = sections.cpuCoreDistribution.summary;
      lines.push('【CPU 大小核分布】');
      lines.push(`  大核运行时间: ${s.bigCoreTime}ms (${s.bigCorePercent}%)`);
      lines.push(`  小核运行时间: ${s.littleCoreTime}ms (${s.littleCorePercent}%)`);
      lines.push('');
    }

    // CPU Frequency
    if (sections.cpuFrequency?.summary) {
      const s = sections.cpuFrequency.summary;
      lines.push('【CPU 平均频率】');
      lines.push(`  大核平均频率: ${s.bigCoreAvgFreq} MHz`);
      lines.push(`  小核平均频率: ${s.littleCoreAvgFreq} MHz`);
      lines.push('');
    }

    // CPU Utilization
    if (sections.cpuUtilization?.data) {
      const d = sections.cpuUtilization.data;
      lines.push('【主线程 CPU 利用率】');
      lines.push(`  运行时间: ${d.running_time_ms?.toFixed(2) ?? 'N/A'}ms`);
      lines.push(`  CPU 利用率: ${d.cpu_utilization_percent?.toFixed(1) ?? 'N/A'}%`);
      lines.push('');
    }

    // GC Events
    if (sections.gcEvents?.summary) {
      const s = sections.gcEvents.summary;
      lines.push('【GC 事件】');
      lines.push(`  GC 次数: ${s.count}`);
      lines.push(`  GC 总耗时: ${s.totalTimeMs}ms (占启动 ${s.percentOfStartup}%)`);
      lines.push('');
    }

    // Thread Blocking Summary
    if (sections.threadBlocking?.summary) {
      const s = sections.threadBlocking.summary;
      lines.push('【主线程阻塞分析】');
      Object.entries(s).forEach(([type, info]: [string, any]) => {
        lines.push(`  ${type}: ${info.count}次, 总计 ${info.totalMs.toFixed(2)}ms`);
      });
      lines.push('');

      // Top blocking events
      if (sections.threadBlocking.data?.length > 0) {
        lines.push('  Top 5 阻塞事件:');
        sections.threadBlocking.data.slice(0, 5).forEach((row: any, idx: number) => {
          const func = row.blocked_function || 'unknown';
          const shortFunc = func.length > 50 ? func.substring(0, 50) + '...' : func;
          lines.push(`    ${idx + 1}. [${row.block_type}] ${shortFunc}: ${row.dur_ms?.toFixed(2) ?? 'N/A'}ms (@ ${row.relative_ts_ms?.toFixed(1)}ms)`);
        });
      }
      lines.push('');
    }

    // Binder transactions
    if (sections.binderTransactions?.data?.length > 0) {
      lines.push('【Binder 事务 (耗时最长)】');
      sections.binderTransactions.data.slice(0, 5).forEach((row: any, idx: number) => {
        lines.push(`  ${idx + 1}. ${row.client_process} -> ${row.server_process}: ${row.client_dur_ms?.toFixed(2) ?? 'N/A'}ms`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format summary for multiple startup events
   */
  private formatMultiStartupSummary(startupAnalyses: any[]): string {
    if (startupAnalyses.length === 0) {
      return '未找到启动事件';
    }

    const lines: string[] = ['╔══════════════════════════════════════════════════════════════╗'];
    lines.push(`║             详细启动分析报告 (共 ${startupAnalyses.length} 个启动事件)              ║`);
    lines.push('╚══════════════════════════════════════════════════════════════╝\n');

    // Quick overview
    lines.push('【启动事件概览】');
    startupAnalyses.forEach((analysis: any) => {
      const typeLabel = analysis.startupType === 'cold' ? '冷启动' :
                       analysis.startupType === 'warm' ? '温启动' :
                       analysis.startupType === 'hot' ? '热启动' : analysis.startupType;
      lines.push(`  #${analysis.startupIndex}: ${analysis.packageName} (${typeLabel}) - ${analysis.durationMs}ms`);
    });
    lines.push('');

    // Detailed analysis for each startup
    startupAnalyses.forEach((analysis: any) => {
      lines.push(analysis.summary);
    });

    return lines.join('\n');
  }

  /**
   * 格式化 android_startup_processes 查询结果
   */
  private formatStartupProcessesSummary(startups: Record<string, any>[]): string {
    if (startups.length === 0) return '未找到启动数据';

    const lines = ['=== 应用启动分析 ===\n'];

    startups.forEach((s, idx) => {
      lines.push(`启动 #${idx + 1}:`);
      lines.push(`  包名: ${s.package || s.process_name || 'unknown'}`);
      lines.push(`  类型: ${s.startup_type || 'unknown'}`);
      lines.push(`  耗时: ${s.dur_ms?.toFixed?.(2) ?? s.dur_ms ?? 'N/A'} ms`);
      lines.push(`  开始时间: ${s.ts_ms?.toFixed?.(2) ?? s.ts_ms ?? 'N/A'} ms\n`);
    });

    return lines.join('\n');
  }

  /**
   * 格式化启动事件摘要（从 slice 表查询的数据）
   */
  private formatStartupEventsSummary(events: Record<string, any>[]): string {
    if (events.length === 0) return '未找到启动事件';

    const lines = ['=== 应用启动事件分析 ===\n'];

    // 按进程分组
    const byProcess = new Map<string, Record<string, any>[]>();
    events.forEach(e => {
      const proc = e.process_name || 'unknown';
      if (!byProcess.has(proc)) byProcess.set(proc, []);
      byProcess.get(proc)!.push(e);
    });

    byProcess.forEach((procEvents, procName) => {
      lines.push(`进程: ${procName}`);
      lines.push(`  事件数: ${procEvents.length}`);

      // 找关键生命周期事件
      const bindApp = procEvents.find(e => e.event_name?.includes('bindApplication'));
      const actStart = procEvents.find(e => e.event_name?.includes('activityStart'));
      const onCreate = procEvents.find(e => e.event_name?.includes('performCreate') || e.event_name?.includes('onCreate'));
      const onResume = procEvents.find(e => e.event_name?.includes('performResume') || e.event_name?.includes('onResume'));
      const firstFrame = procEvents.find(e => e.event_name?.includes('Choreographer') && e.event_name?.includes('doFrame'));

      if (bindApp) lines.push(`  bindApplication: ${bindApp.dur_ms?.toFixed?.(2) ?? 'N/A'} ms`);
      if (actStart) lines.push(`  activityStart: ${actStart.dur_ms?.toFixed?.(2) ?? 'N/A'} ms`);
      if (onCreate) lines.push(`  onCreate/performCreate: ${onCreate.dur_ms?.toFixed?.(2) ?? 'N/A'} ms`);
      if (onResume) lines.push(`  onResume/performResume: ${onResume.dur_ms?.toFixed?.(2) ?? 'N/A'} ms`);
      if (firstFrame) lines.push(`  首帧 (Choreographer): ${firstFrame.dur_ms?.toFixed?.(2) ?? 'N/A'} ms`);

      // 计算总耗时（从最早到最晚事件）
      if (procEvents.length > 1) {
        const sorted = [...procEvents].sort((a, b) => (a.ts_ms || 0) - (b.ts_ms || 0));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const totalDur = (last.ts_ms || 0) + (last.dur_ms || 0) - (first.ts_ms || 0);
        lines.push(`  总耗时(估算): ${totalDur.toFixed(2)} ms`);
      }

      lines.push('');
    });

    // 添加关键事件列表
    lines.push('关键启动事件:');
    const keyEvents = events.filter(e =>
      e.event_name?.includes('bindApplication') ||
      e.event_name?.includes('activityStart') ||
      e.event_name?.includes('performCreate') ||
      e.event_name?.includes('performResume') ||
      e.event_name?.includes('inflate')
    ).slice(0, 10);

    keyEvents.forEach(e => {
      lines.push(`  - ${e.event_name}: ${e.dur_ms?.toFixed?.(2) ?? 'N/A'} ms @ ${e.ts_ms?.toFixed?.(2) ?? 'N/A'} ms`);
    });

    return lines.join('\n');
  }

  // 保留原有的 android_startups 查询逻辑（作为备用）
  private async analyzeStartupLegacy(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let whereClause = '';
    if (packageName) {
      whereClause = `WHERE package GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        startup_id,
        ts / 1e6 as ts_ms,
        dur / 1e6 as dur_ms,
        package,
        startup_type
      FROM android_startups
      ${whereClause}
      ORDER BY ts ASC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      // android_startups table might not exist, try fallback
      console.log('[PerfettoSqlSkill] android_startups query failed, trying fallback...');
      return this.analyzeStartupFallback(traceId, packageName);
    }

    // If no results from android_startups, try fallback approach
    if (queryResult.rows.length === 0) {
      console.log('[PerfettoSqlSkill] android_startups returned 0 rows, trying fallback...');
      return this.analyzeStartupFallback(traceId, packageName);
    }

    // Convert rows (arrays) to objects for easier property access
    const startupObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    const summary = this.formatStartupSummary(startupObjects);

    return {
      analysisType: 'startup',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
      metrics: {
        totalStartups: queryResult.rows.length,
        coldStarts: startupObjects.filter((s: any) => s.startup_type === 'cold').length,
        warmStarts: startupObjects.filter((s: any) => s.startup_type === 'warm').length,
        hotStarts: startupObjects.filter((s: any) => s.startup_type === 'hot').length,
      },
    };
  }

  /**
   * Fallback startup analysis when android_startups is not available
   * Uses slice table to find activity lifecycle events
   */
  private async analyzeStartupFallback(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    // Try to find activity launch slices
    let processFilter = '';
    if (packageName) {
      processFilter = `AND process.name GLOB '${packageName}*'`;
    }

    // Look for common activity launch patterns
    // IMPORTANT: Use ASC to get earliest (startup) events first, not latest!
    const fallbackSql = `
      SELECT
        slice.name,
        slice.ts / 1e6 as ts_ms,
        slice.dur / 1e6 as dur_ms,
        process.name as process_name,
        thread.name as thread_name
      FROM slice
      JOIN thread_track ON slice.track_id = thread_track.id
      JOIN thread USING (utid)
      JOIN process USING (upid)
      WHERE (
        slice.name GLOB '*launching*'
        OR slice.name GLOB '*activityStart*'
        OR slice.name GLOB '*ActivityThread*'
        OR slice.name GLOB '*bindApplication*'
        OR slice.name GLOB '*Choreographer#doFrame*'
        OR slice.name = 'inflate'
        OR slice.name GLOB '*onCreate*'
        OR slice.name GLOB '*onStart*'
        OR slice.name GLOB '*onResume*'
        OR slice.name GLOB '*reportFullyDrawn*'
        OR slice.name GLOB '*performCreate*'
        OR slice.name GLOB '*traversal*'
        OR slice.name GLOB '*measure*'
        OR slice.name GLOB '*layout*'
        OR slice.name GLOB '*draw*'
      )
      ${processFilter}
      ORDER BY slice.ts ASC
    `;

    const fallbackResult = await this.traceProcessor.query(traceId, fallbackSql);

    if (fallbackResult.error || fallbackResult.rows.length === 0) {
      // Try even more generic approach - look for any slow slices on main thread
      const genericSql = `
        SELECT
          slice.name,
          slice.ts / 1e6 as ts_ms,
          slice.dur / 1e6 as dur_ms,
          process.name as process_name,
          thread.name as thread_name
        FROM slice
        JOIN thread_track ON slice.track_id = thread_track.id
        JOIN thread USING (utid)
        JOIN process USING (upid)
        WHERE slice.dur > 10000000  -- > 10ms
        AND thread.is_main_thread = 1
        ${processFilter}
        ORDER BY slice.ts ASC
      `;

      const genericResult = await this.traceProcessor.query(traceId, genericSql);

      if (genericResult.error) {
        return {
          analysisType: 'startup',
          sql: genericSql,
          rows: [],
          rowCount: 0,
          summary: `无法分析启动性能。此 trace 可能不包含 Android 应用启动数据。\n\n错误: ${genericResult.error}\n\n建议:\n- 确保 trace 包含应用启动过程\n- 尝试使用 "分析慢函数" 或 "分析主线程" 等其他分析方式`,
        };
      }

      if (genericResult.rows.length === 0) {
        return {
          analysisType: 'startup',
          sql: genericSql,
          rows: [],
          rowCount: 0,
          summary: `此 trace 中未找到启动相关数据。\n\n可能的原因:\n1. Trace 未捕获应用启动过程\n2. Trace 来自非 Android 平台\n3. 应用已经在后台运行\n\n建议:\n- 尝试其他分析类型，如 "分析慢函数" 或 "分析 CPU 使用"`,
        };
      }

      // Found some slow slices - convert to objects for easier access
      const columns = genericResult.columns;
      const sliceObjects = rowsToObjects(columns, genericResult.rows);
      return {
        analysisType: 'startup',
        sql: genericSql,
        rows: genericResult.rows,
        rowCount: genericResult.rows.length,
        summary: `未找到标准启动事件，但发现 ${genericResult.rows.length} 个主线程慢操作。\n\n最慢的操作:\n${sliceObjects.slice(0, 5).map((s: Record<string, any>) => `- ${s.name}: ${s.dur_ms?.toFixed?.(2) ?? s.dur_ms ?? 'N/A'}ms`).join('\n')}`,
        details: {
          method: 'fallback_slow_slices',
          note: 'android_startups 表为空，使用慢操作分析替代',
        },
      };
    }

    // Found activity launch related slices - convert to objects for easier access
    const columns = fallbackResult.columns;
    const sliceObjects = rowsToObjects(columns, fallbackResult.rows);
    return {
      analysisType: 'startup',
      sql: fallbackSql,
      rows: fallbackResult.rows,
      rowCount: fallbackResult.rows.length,
      summary: `找到 ${fallbackResult.rows.length} 个启动相关事件。\n\n主要事件:\n${sliceObjects.slice(0, 5).map((s: Record<string, any>) => `- ${s.name}: ${s.dur_ms?.toFixed?.(2) ?? s.dur_ms ?? 'N/A'}ms (${s.process_name})`).join('\n')}`,
      details: {
        method: 'fallback_activity_slices',
        note: 'android_startups 表为空，使用 Activity 生命周期事件分析',
      },
    };
  }

  /**
   * Analyze scrolling performance with multi-dimensional jank detection
   *
   * For Android 12+: Uses FrameTimeline tables (expected_frame_timeline_slice, actual_frame_timeline_slice)
   * For Android < 12: Falls back to combining Choreographer, RenderThread, SF, and Vsync analysis
   *
   * Based on:
   * - https://perfetto.dev/docs/data-sources/frametimeline
   * - android_performance.com systrace analysis series
   */
  async analyzeScrolling(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    // First, check if FrameTimeline tables are available (Android 12+)
    const frameTimelineCheck = await this.traceProcessor.query(traceId, `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE name IN ('actual_frame_timeline_slice', 'expected_frame_timeline_slice')
    `);

    const hasFrameTimeline = frameTimelineCheck.rows &&
      frameTimelineCheck.rows.length > 0 &&
      (frameTimelineCheck.rows[0] as any[])[0] >= 2;

    if (hasFrameTimeline) {
      return this.analyzeScrollingWithFrameTimeline(traceId, packageName);
    } else {
      return this.analyzeScrollingLegacy(traceId, packageName);
    }
  }

  /**
   * Modern jank detection using FrameTimeline (Android 12+)
   * Uses actual_frame_timeline_slice and expected_frame_timeline_slice tables
   */
  private async analyzeScrollingWithFrameTimeline(
    traceId: string,
    packageName?: string
  ): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // FrameTimeline-based jank analysis
    // This is the official way to detect jank on Android 12+
    const sql = `
      WITH frame_timeline AS (
        SELECT
          a.id,
          a.ts,
          a.dur,
          a.upid,
          a.name,
          a.present_type,
          a.on_time_finish,
          a.gpu_composition,
          a.jank_type,
          p.name as process_name
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE 1=1
          ${processFilter}
      ),
      jank_analysis AS (
        SELECT
          *,
          dur > 16666666 as is_long_frame,
          CASE
            WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1
            ELSE 0
          END as is_jank
        FROM frame_timeline
      )
      SELECT
        COUNT(*) as total_frames,
        SUM(is_jank) as jank_frames,
        SUM(is_long_frame) as long_frames,
        AVG(dur) / 1e6 as avg_frame_dur_ms,
        MIN(dur) / 1e6 as min_frame_dur_ms,
        MAX(dur) / 1e6 as max_frame_dur_ms,
        SUM(CASE WHEN on_time_finish = 0 THEN 1 ELSE 0 END) as missed_deadline_frames,
        SUM(CASE WHEN gpu_composition = 1 THEN 1 ELSE 0 END) as gpu_composition_frames,
        process_name
      FROM jank_analysis
      GROUP BY process_name
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'scrolling_frametimeline',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing scrolling (FrameTimeline): ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    // Get jank type breakdown for more detailed analysis
    const jankTypeSql = `
      SELECT
        a.jank_type,
        COUNT(*) as count,
        AVG(a.dur) / 1e6 as avg_dur_ms,
        p.name as process_name
      FROM actual_frame_timeline_slice a
      JOIN process p ON a.upid = p.upid
      WHERE a.jank_type IS NOT NULL AND a.jank_type != 'None'
        ${processFilter}
      GROUP BY a.jank_type, p.name
      ORDER BY count DESC
    `;

    const jankTypeResult = await this.traceProcessor.query(traceId, jankTypeSql);
    const jankTypeRowObjects = rowsToObjects(jankTypeResult.columns, jankTypeResult.rows || []);

    // Add enhanced analysis for consecutive jank and frozen frames
    const enhancedAnalysis = await this.analyzeJankySessions(traceId, packageName);

    // Add frame stability analysis
    const stabilityAnalysis = await this.analyzeFrameStability(traceId, packageName);

    // Add root cause analysis for janky frames
    const rootCauseAnalysis = await this.analyzeJankRootCauses(traceId, packageName);

    const summary = this.formatFrameTimelineScrollingSummary(
      rowObjects,
      jankTypeRowObjects,
      enhancedAnalysis,
      stabilityAnalysis,
      rootCauseAnalysis
    );

    return {
      analysisType: 'scrolling_frametimeline',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
      metrics: rowObjects.length > 0 ? rowObjects[0] : {},
      details: {
        jankBreakdown: jankTypeRowObjects,
        method: 'FrameTimeline (Android 12+)',
        enhancedAnalysis,
        stabilityAnalysis,
        rootCauseAnalysis,
      },
    };
  }

  /**
   * Analyze janky sessions (consecutive janky frames) and frozen frames
   * Helps identify patterns of continuous jank that are more noticeable to users
   */
  private async analyzeJankySessions(
    traceId: string,
    packageName?: string
  ): Promise<{
    jankySessions: Array<{ startIdx: number; length: number; severity: string; totalDurMs?: number }>;
    frozenFrames: Array<{ ts: number; dur: number; process: string }>;
    consecutiveJankCount: number;
  }> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Analyze consecutive janky frames and frozen frames
    const sql = `
      WITH numbered_frames AS (
        SELECT
          a.id,
          a.ts,
          a.dur,
          a.jank_type,
          a.on_time_finish,
          p.name as process_name,
          ROW_NUMBER() OVER (PARTITION BY p.upid ORDER BY a.ts) as frame_num
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE 1=1
          ${processFilter}
      ),
      jank_groups AS (
        SELECT
          frame_num,
          dur,
          ts,
          process_name,
          jank_type,
          -- Identify start of jank group (previous frame was not janky)
          CASE
            WHEN jank_type IS NOT NULL AND jank_type != 'None'
              AND LAG(jank_type) OVER (ORDER BY frame_num) IS NULL
              OR (jank_type IS NOT NULL AND jank_type != 'None'
                  AND LAG(jank_type) OVER (ORDER BY frame_num) = 'None')
            THEN 1
            ELSE 0
          END as is_jank_start
        FROM numbered_frames
      ),
      jank_sessions AS (
        SELECT
          frame_num,
          dur,
          ts,
          process_name,
          jank_type,
          SUM(is_jank_start) OVER (ORDER BY frame_num) as session_id
        FROM jank_groups
        WHERE jank_type IS NOT NULL AND jank_type != 'None'
      )
      SELECT
        MIN(frame_num) as start_frame,
        COUNT(*) as session_length,
        SUM(dur) / 1e6 as total_dur_ms,
        process_name,
        -- Determine severity based on length and duration
        CASE
          WHEN COUNT(*) >= 5 THEN 'severe'
          WHEN COUNT(*) >= 3 THEN 'moderate'
          ELSE 'mild'
        END as severity
      FROM jank_sessions
      GROUP BY session_id, process_name
      ORDER BY session_length DESC
    `;

    const jankSessionsResult = await this.traceProcessor.query(traceId, sql);
    const jankSessionsObjects = rowsToObjects(jankSessionsResult.columns || [], jankSessionsResult.rows || []);

    // Detect frozen frames (> 700ms - very long frames that freeze UI)
    const frozenFrameSql = `
      SELECT
        a.ts,
        a.dur / 1e6 as dur_ms,
        p.name as process_name,
        a.jank_type
      FROM actual_frame_timeline_slice a
      JOIN process p ON a.upid = p.upid
      WHERE a.dur > 700000000
        ${processFilter}
      ORDER BY a.ts ASC
    `;

    const frozenFrameResult = await this.traceProcessor.query(traceId, frozenFrameSql);
    const frozenFrameObjects = rowsToObjects(frozenFrameResult.columns || [], frozenFrameResult.rows || []);

    // Get consecutive jank statistics
    const consecutiveJankSql = `
      WITH janky_frames AS (
        SELECT
          a.ts,
          a.dur,
          p.name as process_name,
          CASE
            WHEN a.jank_type IS NOT NULL AND a.jank_type != 'None' THEN 1
            ELSE 0
          END as is_janky
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE 1=1
          ${processFilter}
        ORDER BY a.ts
      ),
      consecutive_groups AS (
        SELECT
          is_janky,
          SUM(CASE WHEN is_janky = 0 THEN 1 ELSE 0 END) OVER (ORDER BY ts) as group_id
        FROM janky_frames
      )
      SELECT
        COUNT(*) as total_janky_frames,
        MAX(cnt) as max_consecutive_jank
      FROM (
        SELECT COUNT(*) as cnt
        FROM consecutive_groups
        WHERE is_janky = 1
        GROUP BY group_id
      )
    `;

    const consecutiveResult = await this.traceProcessor.query(traceId, consecutiveJankSql);
    const consecutiveObjects = rowsToObjects(consecutiveResult.columns || [], consecutiveResult.rows || []);

    return {
      jankySessions: jankSessionsObjects.map((r: any) => ({
        startIdx: r.start_frame,
        length: r.session_length,
        severity: r.severity,
        totalDurMs: r.total_dur_ms,
        process: r.process_name,
      })),
      frozenFrames: frozenFrameObjects.map((r: any) => ({
        ts: r.ts,
        dur: r.dur_ms,
        process: r.process_name,
        jankType: r.jank_type,
      })),
      consecutiveJankCount: consecutiveObjects.length > 0
        ? (consecutiveObjects[0].max_consecutive_jank as number) || 0
        : 0,
    };
  }

  /**
   * Analyze frame rate stability and calculate smoothness metrics
   * Returns statistical analysis of frame timing consistency
   */
  private async analyzeFrameStability(
    traceId: string,
    packageName?: string
  ): Promise<{
    avgFrameTimeMs: number;
    stdDevMs: number;
    coefficientOfVariation: number;
    framePercentiles: { p50: number; p95: number; p99: number };
    stabilityScore: number; // 0-100, higher is better
  } | null> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Calculate frame time statistics with exact percentiles from ordered samples.
    const sql = `
      WITH frame_stats AS (
        SELECT
          a.dur / 1e6 as frame_time_ms,
          p.name as process_name
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE 1=1
          ${processFilter}
      ),
      ordered AS (
        SELECT
          frame_time_ms,
          ROW_NUMBER() OVER (ORDER BY frame_time_ms) as rn,
          COUNT(*) OVER () as total_count
        FROM frame_stats
      ),
      stats AS (
        SELECT
          AVG(frame_time_ms) as avg_ms,
          SUM(frame_time_ms * frame_time_ms) / COUNT(*) as avg_sq_ms,
          COUNT(*) as frame_count
        FROM frame_stats
      ),
      percentiles AS (
        SELECT
          MAX(CASE
            WHEN rn = CAST(ROUND((total_count - 1) * 0.50) AS INT) + 1 THEN frame_time_ms
          END) as p50_ms,
          MAX(CASE
            WHEN rn = CAST(ROUND((total_count - 1) * 0.95) AS INT) + 1 THEN frame_time_ms
          END) as p95_ms,
          MAX(CASE
            WHEN rn = CAST(ROUND((total_count - 1) * 0.99) AS INT) + 1 THEN frame_time_ms
          END) as p99_ms
        FROM ordered
      )
      SELECT
        s.avg_ms,
        CASE
          WHEN s.frame_count <= 1 THEN 0
          ELSE SQRT(MAX(s.avg_sq_ms - s.avg_ms * s.avg_ms, 0))
        END as std_dev_ms,
        s.frame_count,
        p.p50_ms,
        p.p95_ms,
        p.p99_ms
      FROM stats s
      CROSS JOIN percentiles p
    `;

    const result = await this.traceProcessor.query(traceId, sql);

    if (result.error || !result.rows || result.rows.length === 0) {
      return null;
    }

    const rowObjects = rowsToObjects(result.columns || [], result.rows);
    const r = rowObjects[0];
    const frameCount = Number(r.frame_count || 0);
    const avgMs = Number(r.avg_ms || 0);
    const stdDevMs = Number(r.std_dev_ms || 0);

    if (!Number.isFinite(avgMs) || frameCount <= 0 || avgMs <= 0) {
      return null;
    }

    const p50 = Number.isFinite(Number(r.p50_ms)) ? Number(r.p50_ms) : avgMs;
    const p95 = Number.isFinite(Number(r.p95_ms)) ? Number(r.p95_ms) : avgMs;
    const p99 = Number.isFinite(Number(r.p99_ms)) ? Number(r.p99_ms) : avgMs;

    // Calculate coefficient of variation (CV = std/mean)
    // Lower CV means more stable frame rate.
    const cv = avgMs > 0 ? (stdDevMs / avgMs) * 100 : 0;

    // Calculate stability score (0-100):
    // - penalize high variation
    // - penalize high-tail latency (p95)
    // - penalize mean frame time drifting above the 60fps budget
    let stabilityScore = 100;
    stabilityScore -= Math.min(cv * 1.8, 45);
    stabilityScore -= Math.min(Math.max(p95 - 16.6, 0) * 1.5, 35);
    stabilityScore -= Math.min(Math.max(avgMs - 16.6, 0) * 1.2, 20);
    stabilityScore = Math.max(0, Math.min(100, stabilityScore));

    return {
      avgFrameTimeMs: avgMs,
      stdDevMs: stdDevMs,
      coefficientOfVariation: cv,
      framePercentiles: {
        p50,
        p95,
        p99,
      },
      stabilityScore: Math.round(stabilityScore),
    };
  }

  /**
   * Analyze root cause for each janky frame
   * Identifies whether jank is caused by main thread, GPU, or system issues
   */
  private async analyzeJankRootCauses(
    traceId: string,
    packageName?: string
  ): Promise<{
    mainThreadJank: number;
    gpuJank: number;
    sfJank: number;
    bufferJank: number;
    details: Array<{
      frameTs: number;
      jankType: string;
      rootCause: string;
      description: string;
      confidence: 'high' | 'medium' | 'low';
      evidence?: {
        mainOverlapMs?: number;
        maxMainSliceMs?: number;
        presentType?: string;
      };
    }>;
  } | null> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Analyze janky frames with stricter root-cause attribution:
    // - Main-thread cause requires >=8ms overlap with frame window
    // - GPU cause relies on gpu_composition flag
    // - BufferQueue cause uses present_type/jank_type late indicators
    // - Otherwise fallback to system pipeline
    const sql = `
      WITH janky_frames AS (
        SELECT
          a.id,
          a.ts,
          a.dur,
          a.jank_type,
          a.gpu_composition,
          a.present_type,
          p.name as process_name,
          p.upid,
          p.pid,
          a.ts as frame_start_ns,
          a.ts + a.dur as frame_end_ns
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE a.jank_type IS NOT NULL AND a.jank_type != 'None'
          ${processFilter}
        ORDER BY a.ts
      ),
      main_thread_overlap AS (
        SELECT
          jf.id,
          COUNT(*) as overlapping_main_slice_count,
          SUM(
            CASE
              WHEN MIN(s.ts + s.dur, jf.frame_end_ns) > MAX(s.ts, jf.frame_start_ns)
                THEN MIN(s.ts + s.dur, jf.frame_end_ns) - MAX(s.ts, jf.frame_start_ns)
              ELSE 0
            END
          ) / 1e6 as main_overlap_ms,
          MAX(s.dur) / 1e6 as max_main_slice_ms
        FROM janky_frames jf
        JOIN thread t ON t.upid = jf.upid
        JOIN thread_track tt ON tt.utid = t.utid
        JOIN slice s ON s.track_id = tt.id
        WHERE s.dur > 0
          AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = jf.pid OR LOWER(COALESCE(t.name, '')) = 'main')
          AND s.ts < jf.frame_end_ns
          AND s.ts + s.dur > jf.frame_start_ns
        GROUP BY jf.id
      ),
      classified AS (
        SELECT
          jf.ts,
          jf.jank_type,
          jf.gpu_composition,
          jf.present_type,
          COALESCE(mto.overlapping_main_slice_count, 0) as overlapping_main_slice_count,
          COALESCE(mto.main_overlap_ms, 0) as main_overlap_ms,
          COALESCE(mto.max_main_slice_ms, 0) as max_main_slice_ms,
          CASE
            WHEN COALESCE(mto.main_overlap_ms, 0) >= 8.0 THEN 'MainThread'
            WHEN jf.gpu_composition = 1 THEN 'GPU'
            WHEN LOWER(COALESCE(jf.present_type, '')) LIKE '%late%'
              OR LOWER(COALESCE(jf.present_type, '')) LIKE '%miss%'
              OR LOWER(COALESCE(jf.jank_type, '')) LIKE '%buffer%'
              THEN 'BufferQueue'
            ELSE 'System'
          END as root_cause,
          CASE
            WHEN COALESCE(mto.main_overlap_ms, 0) >= 8.0 THEN 'high'
            WHEN jf.gpu_composition = 1 THEN 'medium'
            WHEN LOWER(COALESCE(jf.present_type, '')) LIKE '%late%'
              OR LOWER(COALESCE(jf.present_type, '')) LIKE '%miss%'
              OR LOWER(COALESCE(jf.jank_type, '')) LIKE '%buffer%'
              THEN 'medium'
            ELSE 'low'
          END as confidence
        FROM janky_frames jf
        LEFT JOIN main_thread_overlap mto ON mto.id = jf.id
      )
      SELECT
        ts,
        jank_type,
        gpu_composition,
        present_type,
        overlapping_main_slice_count,
        main_overlap_ms,
        max_main_slice_ms,
        root_cause,
        confidence
      FROM classified
      ORDER BY ts ASC
    `;

    const result = await this.traceProcessor.query(traceId, sql);

    if (result.error || !result.rows || result.rows.length === 0) {
      return null;
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(result.columns, result.rows);

    // Count by root cause
    let mainThreadJank = 0;
    let gpuJank = 0;
    let sfJank = 0;
    let bufferJank = 0;

    const details = rowObjects.map((r) => {
      if (r.root_cause === 'MainThread') mainThreadJank++;
      else if (r.root_cause === 'GPU') gpuJank++;
      else if (r.root_cause === 'BufferQueue') bufferJank++;
      else sfJank++;

      return {
        frameTs: r.ts,
        jankType: r.jank_type,
        rootCause: r.root_cause,
        description: this.getRootCauseDescription(r.root_cause as string, r.jank_type as string),
        confidence: (r.confidence as 'high' | 'medium' | 'low') || 'low',
        evidence: {
          mainOverlapMs: Number(r.main_overlap_ms || 0),
          maxMainSliceMs: Number(r.max_main_slice_ms || 0),
          presentType: String(r.present_type || ''),
        },
      };
    });

    return {
      mainThreadJank,
      gpuJank,
      sfJank,
      bufferJank,
      details,
    };
  }

  /**
   * Get human-readable description for root cause
   */
  private getRootCauseDescription(rootCause: string, jankType: string): string {
    const descriptions: Record<string, string> = {
      MainThread: 'Main thread blocked - too much work on UI thread',
      GPU: 'GPU composition fallback - too complex to draw with hardware overlay',
      BufferQueue: 'Buffer queue starvation - no buffer ready for composition',
      System: 'System-level delay - SurfaceFlinger or display pipeline issue',
    };

    const base = descriptions[rootCause] || 'Unknown cause';
    return `${base} (JankType: ${jankType})`;
  }

  /**
   * Legacy jank detection for Android < 12
   * Combines multiple data sources to detect real jank
   */
  private async analyzeScrollingLegacy(
    traceId: string,
    packageName?: string
  ): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Multi-dimensional analysis combining:
    // 1. Choreographer doFrame (main thread frame timing)
    // 2. RenderThread execution
    // 3. SurfaceFlinger composition status
    // 4. BufferQueue buffer availability
    // 5. Vsync timing correlation

    const sql = `
      WITH choreographer_frames AS (
        -- Get all doFrame calls from Choreographer
        SELECT
          s.id,
          s.ts,
          s.dur,
          t.utid,
          p.name as process_name,
          p.upid
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name = 'doFrame'
          ${processFilter}
      ),
      render_thread_frames AS (
        -- Get RenderThread frame work
        SELECT
          s.ts,
          s.dur,
          s.name,
          p.upid
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.name GLOB '*Draw*' OR s.name GLOB '*frame*'
          ${processFilter}
      ),
      sf_composition AS (
        -- SurfaceFlinger composition events
        SELECT
          s.ts,
          s.dur,
          s.name
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE p.name = '/system/bin/surfaceflinger'
          AND (s.name GLOB '*composition*' OR s.name GLOB '*present*')
      ),
      frame_analysis AS (
        SELECT
          c.id,
          c.ts,
          c.dur as doframe_dur,
          c.process_name,
          c.upid,
          -- Frame is considered janky if:
          -- 1. doFrame duration > 16.6ms (missed vsync)
          -- 2. There's no corresponding SF composition within reasonable time
          CASE
            WHEN c.dur > 16666666 THEN 1
            ELSE 0
          END as doframe_missed,
          -- Check if SF composition happened for this frame window
          EXISTS(
            SELECT 1 FROM sf_composition sf
            WHERE sf.ts >= c.ts AND sf.ts <= c.ts + c.dur + 16000000
          ) as has_sf_composition
        FROM choreographer_frames c
      )
      SELECT
        COUNT(*) as total_frames,
        SUM(doframe_missed) as jank_frames,
        SUM(CASE WHEN has_sf_composition = 0 THEN 1 ELSE 0 END) as no_sf_composition_frames,
        AVG(doframe_dur) / 1e6 as avg_frame_dur_ms,
        MIN(doframe_dur) / 1e6 as min_frame_dur_ms,
        MAX(doframe_dur) / 1e6 as max_frame_dur_ms,
        process_name
      FROM frame_analysis
      GROUP BY process_name
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'scrolling_legacy',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing scrolling (Legacy): ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatLegacyScrollingSummary(rowObjects);

    return {
      analysisType: 'scrolling_legacy',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
      metrics: rowObjects.length > 0 ? rowObjects[0] : {},
      details: {
        method: 'Legacy multi-dimensional (Android < 12)',
        note: 'For accurate jank detection, use Android 12+ with FrameTimeline',
      },
    };
  }

  /**
   * Analyze memory usage
   * Based on: linux/memory/*.sql patterns
   */
  async analyzeMemory(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Find GC events and memory-related slices
    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*GC*' OR s.name GLOB '*allocation*' OR s.name GLOB '*Allocation*'
        ${processFilter}
      GROUP BY s.name, p.name
      ORDER BY count DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'memory',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing memory: ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatMemorySummary(rowObjects);

    return {
      analysisType: 'memory',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
    };
  }

  /**
   * Analyze CPU utilization
   * Based on: linux/cpu/utilization/*.sql patterns
   */
  async analyzeCpu(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Thread state analysis for CPU time
    const sql = `
      SELECT
        t.name as thread_name,
        p.name as process_name,
        SUM(ts.dur) / 1e6 as total_dur_ms,
        SUM(CASE WHEN ts.state = 'R' THEN ts.dur ELSE 0 END) / 1e6 as running_dur_ms,
        SUM(CASE WHEN ts.state = 'S' THEN ts.dur ELSE 0 END) / 1e6 as sleeping_dur_ms,
        COUNT(*) as state_changes
      FROM thread_state ts
      JOIN thread t ON ts.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE 1=1
        ${processFilter}
      GROUP BY t.name, p.name
      ORDER BY total_dur_ms DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'cpu',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing CPU: ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatCpuSummary(rowObjects);

    return {
      analysisType: 'cpu',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
    };
  }

  /**
   * Analyze SurfaceFlinger performance
   * Based on: android/surfaceflinger.sql, android_surfaceflinger.sql
   */
  async analyzeSurfaceFlinger(traceId: string): Promise<PerfettoSqlResponse> {
    // SurfaceFlinger frame analysis
    const sql = `
      SELECT
        COUNT(*) as total_frames,
        SUM(CAST(s.dur > 16666666 AS INT)) as missed_frames,
        AVG(s.dur) / 1e6 as avg_frame_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name = '/system/bin/surfaceflinger'
        AND (s.name GLOB '*frame*' OR s.name GLOB '*Frame*')
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'surfaceflinger',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing SurfaceFlinger: ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatSurfaceFlingerSummary(rowObjects);

    return {
      analysisType: 'surfaceflinger',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
      metrics: rowObjects.length > 0 ? rowObjects[0] : {},
    };
  }

  /**
   * Analyze Binder transactions
   * Based on: android/android_binder.sql
   */
  async analyzeBinder(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*Binder*'
        ${processFilter}
      GROUP BY s.name, p.name
      ORDER BY count DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'binder',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing Binder: ${queryResult.error}`,
      };
    }

    // Convert rows to objects for easier access
    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatBinderSummary(rowObjects);

    return {
      analysisType: 'binder',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary,
    };
  }

  /**
   * Generic analysis with template-based SQL generation
   */
  private async analyzeGeneric(
    traceId: string,
    question: string,
    packageName?: string
  ): Promise<PerfettoSqlResponse> {
    // This would use AI to generate SQL from templates
    // For now, return a basic slice query
    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms
      FROM slice s
      GROUP BY s.name
      ORDER BY count DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'generic',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error: ${queryResult.error}`,
      };
    }

    return {
      analysisType: 'generic',
      sql,
      rows: queryResult.rows,
      rowCount: queryResult.rows.length,
      summary: `Found ${queryResult.rows.length} slice types in trace`,
    };
  }

  /**
   * Analyze navigation/activity switching performance
   * Based on activity transition slice patterns
   */
  async analyzeNavigation(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MIN(s.dur) / 1e6 as min_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB 'perform*' OR s.name GLOB '*Activity*'
        ${processFilter}
      GROUP BY s.name, p.name
      ORDER BY count DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'navigation',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing navigation: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatNavigationSummary(rowObjects);

    return {
      analysisType: 'navigation',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
    };
  }

  /**
   * Analyze click/tap response performance
   * Based on input event latency patterns
   */
  async analyzeClickResponse(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MIN(s.dur) / 1e6 as min_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*Input*' OR s.name GLOB '*Click*' OR s.name GLOB '*Touch*'
        ${processFilter}
      GROUP BY s.name, p.name
      ORDER BY avg_dur_ms DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'click_response',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing click response: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatClickResponseSummary(rowObjects);

    return {
      analysisType: 'click_response',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
    };
  }

  /**
   * Analyze input events and latency
   * Based on input system tracking
   */
  async analyzeInput(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*input*' OR s.name GLOB '*Input*' OR s.name GLOB '*gesture*'
        ${processFilter}
      GROUP BY s.name, p.name
      ORDER BY count DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'input',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing input: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatInputSummary(rowObjects);

    return {
      analysisType: 'input',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
    };
  }

  /**
   * Analyze buffer flow and queue
   * Based on GPU fence and buffer queue patterns
   */
  async analyzeBufferFlow(traceId: string): Promise<PerfettoSqlResponse> {
    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name = '/system/bin/surfaceflinger'
        AND (s.name GLOB '*fence*' OR s.name GLOB '*GPU*')
      GROUP BY s.name
      ORDER BY total_dur_ms DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'bufferflow',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing buffer flow: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatBufferFlowSummary(rowObjects);

    return {
      analysisType: 'bufferflow',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
    };
  }

  /**
   * Analyze SystemServer performance
   * Based on system_server process patterns
   */
  async analyzeSystemServer(traceId: string): Promise<PerfettoSqlResponse> {
    const sql = `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name = 'system_server'
        AND s.dur > 10000000
      GROUP BY s.name
      ORDER BY total_dur_ms DESC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'systemserver',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing SystemServer: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);
    const summary = this.formatSystemServerSummary(rowObjects);

    return {
      analysisType: 'systemserver',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
    };
  }

  /**
   * Analyze slow functions (>16ms)
   * Detects functions that exceed the 16.6ms frame budget
   */
  async analyzeSlowFunctions(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const frameTimelineCheck = await this.traceProcessor.query(traceId, `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE name = 'actual_frame_timeline_slice'
    `);
    const hasFrameTimeline = frameTimelineCheck.rows &&
      frameTimelineCheck.rows.length > 0 &&
      Number((frameTimelineCheck.rows[0] as any[])[0] || 0) > 0;

    // Find long-running slices on app main thread only.
    // If FrameTimeline exists, also compute overlap with janky frames.
    const sql = hasFrameTimeline
      ? `
        WITH main_thread_slices AS (
          SELECT
            s.name as function_name,
            s.dur / 1e6 as dur_ms,
            s.ts / 1e6 as ts_ms,
            s.ts as slice_start_ns,
            s.ts + s.dur as slice_end_ns,
            t.name as thread_name,
            p.name as process_name,
            p.upid
          FROM slice s
          JOIN thread_track tt ON s.track_id = tt.id
          JOIN thread t ON tt.utid = t.utid
          JOIN process p ON t.upid = p.upid
          WHERE s.dur > 16000000
            ${processFilter}
            AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = p.pid OR LOWER(COALESCE(t.name, '')) = 'main')
        ),
        janky_frames AS (
          SELECT
            a.upid,
            a.ts as frame_start_ns,
            a.ts + a.dur as frame_end_ns
          FROM actual_frame_timeline_slice a
          WHERE a.jank_type IS NOT NULL
            AND a.jank_type != 'None'
        ),
        overlap_annotated AS (
          SELECT
            mts.*,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM janky_frames jf
                WHERE jf.upid = mts.upid
                  AND jf.frame_start_ns < mts.slice_end_ns
                  AND jf.frame_end_ns > mts.slice_start_ns
              ) THEN 1
              ELSE 0
            END as overlaps_jank_frame,
            COALESCE((
              SELECT SUM(
                CASE
                  WHEN MIN(mts.slice_end_ns, jf.frame_end_ns) > MAX(mts.slice_start_ns, jf.frame_start_ns)
                    THEN MIN(mts.slice_end_ns, jf.frame_end_ns) - MAX(mts.slice_start_ns, jf.frame_start_ns)
                  ELSE 0
                END
              )
              FROM janky_frames jf
              WHERE jf.upid = mts.upid
                AND jf.frame_start_ns < mts.slice_end_ns
                AND jf.frame_end_ns > mts.slice_start_ns
            ), 0) / 1e6 as overlap_jank_ms
          FROM main_thread_slices mts
        ),
        aggregated AS (
          SELECT
            function_name,
            process_name,
            COUNT(*) as count,
            AVG(dur_ms) as avg_dur_ms,
            MAX(dur_ms) as max_dur_ms,
            SUM(dur_ms) as total_dur_ms,
            SUM(overlaps_jank_frame) as jank_overlap_count,
            SUM(overlap_jank_ms) as total_jank_overlap_ms
          FROM overlap_annotated
          GROUP BY function_name, process_name
        )
        SELECT
          function_name,
          process_name,
          count,
          avg_dur_ms,
          max_dur_ms,
          total_dur_ms,
          jank_overlap_count,
          total_jank_overlap_ms
        FROM aggregated
        ORDER BY total_dur_ms DESC
      `
      : `
        WITH slow_functions AS (
          SELECT
            s.name as function_name,
            s.dur / 1e6 as dur_ms,
            s.ts / 1e6 as ts_ms,
            t.name as thread_name,
            p.name as process_name
          FROM slice s
          JOIN thread_track tt ON s.track_id = tt.id
          JOIN thread t ON tt.utid = t.utid
          JOIN process p ON t.upid = p.upid
          WHERE s.dur > 16000000
            ${processFilter}
            AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = p.pid OR LOWER(COALESCE(t.name, '')) = 'main')
        ),
        aggregated AS (
          SELECT
            function_name,
            process_name,
            COUNT(*) as count,
            AVG(dur_ms) as avg_dur_ms,
            MAX(dur_ms) as max_dur_ms,
            SUM(dur_ms) as total_dur_ms,
            0 as jank_overlap_count,
            0 as total_jank_overlap_ms
          FROM slow_functions
          GROUP BY function_name, process_name
        )
        SELECT
          function_name,
          process_name,
          count,
          avg_dur_ms,
          max_dur_ms,
          total_dur_ms,
          jank_overlap_count,
          total_jank_overlap_ms
        FROM aggregated
        ORDER BY total_dur_ms DESC
      `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'slow_functions',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing slow functions: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    // Get top slowest individual instances from main thread.
    const topSlowestSql = hasFrameTimeline
      ? `
        WITH janky_frames AS (
          SELECT
            a.upid,
            a.ts as frame_start_ns,
            a.ts + a.dur as frame_end_ns
          FROM actual_frame_timeline_slice a
          WHERE a.jank_type IS NOT NULL AND a.jank_type != 'None'
        )
        SELECT
          s.name as function_name,
          s.dur / 1e6 as dur_ms,
          s.ts / 1e6 as ts_ms,
          t.name as thread_name,
          p.name as process_name,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM janky_frames jf
              WHERE jf.upid = p.upid
                AND jf.frame_start_ns < s.ts + s.dur
                AND jf.frame_end_ns > s.ts
            ) THEN 1
            ELSE 0
          END as overlaps_jank_frame
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.dur > 16000000
          ${processFilter}
          AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = p.pid OR LOWER(COALESCE(t.name, '')) = 'main')
        ORDER BY s.ts ASC
      `
      : `
        SELECT
          s.name as function_name,
          s.dur / 1e6 as dur_ms,
          s.ts / 1e6 as ts_ms,
          t.name as thread_name,
          p.name as process_name,
          0 as overlaps_jank_frame
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.dur > 16000000
          ${processFilter}
          AND (COALESCE(t.is_main_thread, 0) = 1 OR t.tid = p.pid OR LOWER(COALESCE(t.name, '')) = 'main')
        ORDER BY s.ts ASC
      `;

    const topSlowestResult = await this.traceProcessor.query(traceId, topSlowestSql);
    const topSlowestObjects = rowsToObjects(topSlowestResult.columns || [], topSlowestResult.rows || []);

    const summary = this.formatSlowFunctionsSummary(rowObjects, topSlowestObjects);

    return {
      analysisType: 'slow_functions',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
      metrics: {
        totalSlowFunctions: rowObjects.length,
        threshold: '16ms (long main-thread slice)',
        hasFrameTimeline: hasFrameTimeline ? 1 : 0,
      },
      details: {
        topSlowest: topSlowestObjects,
      },
    };
  }

  /**
   * Analyze network request performance
   * Uses network_traffic_slice table to track HTTP requests
   */
  async analyzeNetwork(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        net.name,
        net.slice_id,
        net.ts / 1e6 as ts_ms,
        net.dur / 1e6 as dur_ms,
        t.name as thread_name,
        p.name as process_name
      FROM network_traffic_slice net
      JOIN thread_track tt ON net.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE 1=1
        ${processFilter}
      ORDER BY net.ts ASC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'network',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing network traffic: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    // Get aggregate statistics
    const statsSql = `
      SELECT
        COUNT(*) as total_requests,
        AVG(net.dur) / 1e6 as avg_dur_ms,
        MAX(net.dur) / 1e6 as max_dur_ms,
        MIN(net.dur) / 1e6 as min_dur_ms,
        SUM(CASE WHEN net.dur > 1000000000 THEN 1 ELSE 0 END) as slow_requests
      FROM network_traffic_slice net
      JOIN thread_track tt ON net.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE 1=1
        ${processFilter}
    `;

    const statsResult = await this.traceProcessor.query(traceId, statsSql);
    const statsObjects = rowsToObjects(statsResult.columns || [], statsResult.rows || []);
    const stats = statsObjects.length > 0 ? statsObjects[0] : null;

    const summary = this.formatNetworkSummary(rowObjects, stats);

    return {
      analysisType: 'network',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
      metrics: stats ? {
        totalRequests: stats.total_requests as number,
        avgDurationMs: stats.avg_dur_ms as number,
        maxDurationMs: stats.max_dur_ms as number,
        slowRequests: stats.slow_requests as number,
      } : undefined,
    };
  }

  /**
   * Analyze database query performance
   * Uses slice table to find SQLite/Room operations
   */
  async analyzeDatabase(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        s.ts / 1e6 as ts_ms,
        s.dur / 1e6 as dur_ms,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*sqlite*%' OR s.name GLOB '*room*%'
        ${processFilter}
      ORDER BY s.ts ASC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'database',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing database queries: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    // Get aggregate statistics by query type
    const statsSql = `
      SELECT
        COUNT(*) as total_queries,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        SUM(CASE WHEN s.dur > 16000000 THEN 1 ELSE 0 END) as slow_queries
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*sqlite*%' OR s.name GLOB '*room*%'
        ${processFilter}
    `;

    const statsResult = await this.traceProcessor.query(traceId, statsSql);
    const statsObjects = rowsToObjects(statsResult.columns || [], statsResult.rows || []);
    const stats = statsObjects.length > 0 ? statsObjects[0] : null;

    const summary = this.formatDatabaseSummary(rowObjects, stats);

    return {
      analysisType: 'database',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
      metrics: stats ? {
        totalQueries: stats.total_queries as number,
        avgDurationMs: stats.avg_dur_ms as number,
        maxDurationMs: stats.max_dur_ms as number,
        slowQueries: stats.slow_queries as number,
      } : undefined,
    };
  }

  /**
   * Analyze file I/O performance
   * Uses slice table to find read/write operations
   */
  async analyzeFileIO(traceId: string, packageName?: string): Promise<PerfettoSqlResponse> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    const sql = `
      SELECT
        s.name,
        s.ts / 1e6 as ts_ms,
        s.dur / 1e6 as dur_ms,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*read*%' OR s.name GLOB '*write*%' OR s.name GLOB '*fs_*%'
        ${processFilter}
      ORDER BY s.ts ASC
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'file_io',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing file I/O: ${queryResult.error}`,
      };
    }

    const rowObjects = rowsToObjects(queryResult.columns, queryResult.rows);

    // Get aggregate statistics
    const statsSql = `
      SELECT
        COUNT(*) as total_operations,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        MAX(s.dur) / 1e6 as max_dur_ms,
        SUM(CASE WHEN s.name GLOB '*read*' THEN 1 ELSE 0 END) as read_ops,
        SUM(CASE WHEN s.name GLOB '*write*' THEN 1 ELSE 0 END) as write_ops
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*read*%' OR s.name GLOB '*write*%' OR s.name GLOB '*fs_*%'
        ${processFilter}
    `;

    const statsResult = await this.traceProcessor.query(traceId, statsSql);
    const statsObjects = rowsToObjects(statsResult.columns || [], statsResult.rows || []);
    const stats = statsObjects.length > 0 ? statsObjects[0] : null;

    const summary = this.formatFileIOSummary(rowObjects, stats);

    return {
      analysisType: 'file_io',
      sql,
      rows: rowObjects,
      rowCount: rowObjects.length,
      summary,
      metrics: stats ? {
        totalOperations: stats.total_operations as number,
        avgDurationMs: stats.avg_dur_ms as number,
        maxDurationMs: stats.max_dur_ms as number,
        readOps: stats.read_ops as number,
        writeOps: stats.write_ops as number,
      } : undefined,
    };
  }

  // ========================================================================
  // Summary Formatting Methods
  // ========================================================================

  private formatStartupSummary(startups: Record<string, unknown>[]): string {
    if (startups.length === 0) {
      return 'No startup events found in trace.';
    }

    const byType: Record<string, number> = {};
    let totalDur = 0;

    for (const startup of startups as any[]) {
      byType[startup.startup_type] = (byType[startup.startup_type] || 0) + 1;
      totalDur += startup.dur_ms;
    }

    const avgDur = totalDur / startups.length;
    let summary = `Found ${startups.length} startup events. `;

    if (byType.cold) summary += `${byType.cold} cold, `;
    if (byType.warm) summary += `${byType.warm} warm, `;
    if (byType.hot) summary += `${byType.hot} hot. `;

    summary += `Average duration: ${avgDur.toFixed(2)}ms.`;

    return summary;
  }

  private formatScrollingSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No frame data found in trace.';
    }

    const r = rows[0] as any;
    const jankPercent = r.total_frames > 0 ? ((r.jank_frames / r.total_frames) * 100).toFixed(1) : '0';
    const fps = r.avg_frame_dur_ms > 0 ? (1000 / r.avg_frame_dur_ms).toFixed(1) : 'N/A';

    return `Analyzed ${r.total_frames} frames. ` +
      `Jank frames: ${r.jank_frames} (${jankPercent}%). ` +
      `Average FPS: ${fps}. ` +
      `Frame duration: ${r.avg_frame_dur_ms?.toFixed(2)}ms avg, ` +
      `${r.min_frame_dur_ms?.toFixed(2)}ms min, ` +
      `${r.max_frame_dur_ms?.toFixed(2)}ms max.`;
  }

  /**
   * Format summary for FrameTimeline-based scrolling analysis (Android 12+)
   */
  private formatFrameTimelineScrollingSummary(
    rows: Record<string, unknown>[],
    jankTypeRows: Record<string, unknown>[],
    enhancedAnalysis?: {
      jankySessions: Array<{ startIdx: number; length: number; severity: string; totalDurMs?: number }>;
      frozenFrames: Array<{ ts: number; dur: number; process: string }>;
      consecutiveJankCount: number;
    },
    stabilityAnalysis?: {
      avgFrameTimeMs: number;
      stdDevMs: number;
      coefficientOfVariation: number;
      framePercentiles: { p50: number; p95: number; p99: number };
      stabilityScore: number;
    } | null,
    rootCauseAnalysis?: {
      mainThreadJank: number;
      gpuJank: number;
      sfJank: number;
      bufferJank: number;
      details: Array<{ frameTs: number; jankType: string; rootCause: string; description: string }>;
    } | null
  ): string {
    if (rows.length === 0) {
      return 'No FrameTimeline data found in trace. Make sure FrameTimeline is enabled (Android 12+).';
    }

    const r = rows[0] as any;
    const jankPercent = r.total_frames > 0 ? ((r.jank_frames / r.total_frames) * 100).toFixed(1) : '0';
    const fps = r.avg_frame_dur_ms > 0 ? (1000 / r.avg_frame_dur_ms).toFixed(1) : 'N/A';

    let summary = `[FrameTimeline Analysis - Android 12+] `;
    summary += `Analyzed ${r.total_frames} frames for ${r.process_name || 'app'}. `;
    summary += `Jank frames: ${r.jank_frames} (${jankPercent}%). `;

    if (r.missed_deadline_frames > 0) {
      summary += `Missed deadline: ${r.missed_deadline_frames} frames. `;
    }
    if (r.gpu_composition_frames > 0) {
      const gpuPercent = ((r.gpu_composition_frames / r.total_frames) * 100).toFixed(1);
      summary += `GPU composition: ${r.gpu_composition_frames} frames (${gpuPercent}% - indicates potential jank). `;
    }

    summary += `Average FPS: ${fps}. `;

    // Add stability score if available
    if (stabilityAnalysis) {
      summary += `\n\n[Stability Analysis] `;
      summary += `Score: ${stabilityAnalysis.stabilityScore}/100. `;
      summary += `Frame time: ${stabilityAnalysis.avgFrameTimeMs.toFixed(2)}ms avg, `;
      summary += `±${stabilityAnalysis.stdDevMs.toFixed(2)}ms (CV: ${stabilityAnalysis.coefficientOfVariation.toFixed(1)}%). `;
      summary += `P95: ${stabilityAnalysis.framePercentiles.p95.toFixed(1)}ms, P99: ${stabilityAnalysis.framePercentiles.p99.toFixed(1)}ms.`;
    }

    // Add jank type breakdown if available
    if (jankTypeRows.length > 0) {
      summary += `\n\n[Jank Type Breakdown] `;
      const jankTypes = jankTypeRows.map((jt: any) => {
        const typeName = jt.jank_type || 'Unknown';
        return `${typeName} (${jt.count})`;
      }).join(', ');
      summary += jankTypes;
    }

    // Add root cause analysis if available
    if (rootCauseAnalysis) {
      summary += `\n\n[Root Cause Analysis] `;
      const causes = [];
      if (rootCauseAnalysis.mainThreadJank > 0) {
        causes.push(`MainThread: ${rootCauseAnalysis.mainThreadJank}`);
      }
      if (rootCauseAnalysis.gpuJank > 0) {
        causes.push(`GPU: ${rootCauseAnalysis.gpuJank}`);
      }
      if (rootCauseAnalysis.bufferJank > 0) {
        causes.push(`BufferQueue: ${rootCauseAnalysis.bufferJank}`);
      }
      if (rootCauseAnalysis.sfJank > 0) {
        causes.push(`System: ${rootCauseAnalysis.sfJank}`);
      }
      if (causes.length > 0) {
        summary += causes.join(', ');
      }
    }

    // Add enhanced analysis if available
    if (enhancedAnalysis) {
      summary += `\n\n[Enhanced Analysis] `;

      if (enhancedAnalysis.consecutiveJankCount > 0) {
        summary += `Max consecutive janky frames: ${enhancedAnalysis.consecutiveJankCount}. `;
      }

      if (enhancedAnalysis.jankySessions && enhancedAnalysis.jankySessions.length > 0) {
        summary += `Janky sessions: ${enhancedAnalysis.jankySessions.length}`;
        const severeSessions = enhancedAnalysis.jankySessions.filter(s => s.severity === 'severe');
        if (severeSessions.length > 0) {
          summary += ` (Severe: ${severeSessions.length}, Max length: ${Math.max(...enhancedAnalysis.jankySessions.map(s => s.length))} frames). `;
        }
      }

      if (enhancedAnalysis.frozenFrames && enhancedAnalysis.frozenFrames.length > 0) {
        summary += `Frozen frames (>700ms): ${enhancedAnalysis.frozenFrames.length}`;
        summary += `, Longest: ${Math.max(...enhancedAnalysis.frozenFrames.map(f => f.dur)).toFixed(0)}ms.`;
      }
    }

    return summary;
  }

  /**
   * Format summary for legacy scrolling analysis (Android < 12)
   */
  private formatLegacyScrollingSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No frame data found in trace. Ensure Choreographer doFrame events are present.';
    }

    const r = rows[0] as any;
    const jankPercent = r.total_frames > 0 ? ((r.jank_frames / r.total_frames) * 100).toFixed(1) : '0';
    const fps = r.avg_frame_dur_ms > 0 ? (1000 / r.avg_frame_dur_ms).toFixed(1) : 'N/A';

    let summary = `[Legacy Multi-dimensional Analysis - Android < 12] `;
    summary += `Analyzed ${r.total_frames} frames for ${r.process_name || 'app'}. `;
    summary += `Frames with missed doFrame: ${r.jank_frames} (${jankPercent}%). `;

    if (r.no_sf_composition_frames > 0) {
      summary += `Frames without SF composition: ${r.no_sf_composition_frames} (indicates buffer queue issues). `;
    }

    summary += `Average FPS: ${fps}. `;
    summary += `Frame duration: ${r.avg_frame_dur_ms?.toFixed(2)}ms avg, ` +
      `${r.min_frame_dur_ms?.toFixed(2)}ms min, ` +
      `${r.max_frame_dur_ms?.toFixed(2)}ms max.`;

    summary += `\n\nNote: For accurate jank detection with FrameTimeline, use Android 12+. ` +
      `This legacy analysis combines doFrame timing and SurfaceFlinger composition status.`;

    return summary;
  }

  private formatMemorySummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No memory events found in trace.';
    }

    let totalGcTime = 0;
    let gcCount = 0;

    for (const row of rows as any[]) {
      if (row.name?.toLowerCase().includes('gc')) {
        gcCount += row.count;
        totalGcTime += row.total_dur_ms;
      }
    }

    return `Found ${rows.length} memory-related event types. ` +
      `GC events: ${gcCount}, total GC time: ${totalGcTime.toFixed(2)}ms.`;
  }

  private formatCpuSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No CPU data found in trace.';
    }

    const topThread = rows[0] as any;
    const cpuPercent = topThread.total_dur_ms > 0
      ? ((topThread.running_dur_ms / topThread.total_dur_ms) * 100).toFixed(1)
      : '0';

    return `Analyzed ${rows.length} threads. ` +
      `Top thread: ${topThread.thread_name} (${topThread.process_name}). ` +
      `CPU utilization: ${cpuPercent}%.`;
  }

  private formatSurfaceFlingerSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No SurfaceFlinger data found in trace.';
    }

    const r = rows[0] as any;
    const jankPercent = r.total_frames > 0 ? ((r.missed_frames / r.total_frames) * 100).toFixed(1) : '0';

    return `SurfaceFlinger: ${r.total_frames} frames, ` +
      `${r.missed_frames} missed (${jankPercent}% jank). ` +
      `Average frame duration: ${r.avg_frame_dur_ms?.toFixed(2)}ms.`;
  }

  private formatBinderSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No Binder transactions found in trace.';
    }

    const totalTxns = rows.reduce((sum, r: any) => sum + r.count, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalTxns;

    return `Found ${totalTxns} Binder transactions across ${rows.length} types. ` +
      `Average duration: ${avgDur?.toFixed(2)}ms.`;
  }

  private formatNavigationSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No navigation events found in trace.';
    }

    const totalNavs = rows.reduce((sum, r: any) => sum + r.count, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalNavs;

    return `Found ${totalNavs} navigation/transition events across ${rows.length} types. ` +
      `Average duration: ${avgDur?.toFixed(2)}ms.`;
  }

  private formatClickResponseSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No click/touch events found in trace.';
    }

    const totalClicks = rows.reduce((sum, r: any) => sum + r.count, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalClicks;

    return `Found ${totalClicks} click/touch events across ${rows.length} types. ` +
      `Average response time: ${avgDur?.toFixed(2)}ms.`;
  }

  private formatInputSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No input events found in trace.';
    }

    const totalInputs = rows.reduce((sum, r: any) => sum + r.count, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalInputs;

    return `Found ${totalInputs} input events across ${rows.length} types. ` +
      `Average duration: ${avgDur?.toFixed(2)}ms.`;
  }

  private formatBufferFlowSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No buffer flow events found in trace.';
    }

    const totalDur = rows.reduce((sum, r: any) => sum + r.total_dur_ms, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / rows.length;

    return `Found ${rows.length} buffer flow event types. ` +
      `Total GPU/buffer wait time: ${totalDur.toFixed(2)}ms, average: ${avgDur.toFixed(2)}ms.`;
  }

  private formatSystemServerSummary(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) {
      return 'No SystemServer operations found in trace.';
    }

    const totalOps = rows.reduce((sum, r: any) => sum + r.count, 0);
    const totalDur = rows.reduce((sum, r: any) => sum + r.total_dur_ms, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalOps;

    return `Found ${totalOps} SystemServer operations (>10ms). ` +
      `Total time: ${totalDur.toFixed(2)}ms, average: ${avgDur.toFixed(2)}ms.`;
  }

  private formatSlowFunctionsSummary(
    rows: Record<string, unknown>[],
    topSlowest: Record<string, unknown>[]
  ): string {
    if (rows.length === 0) {
      return 'No long main-thread slices (>16ms) were found.';
    }

    const totalCount = rows.reduce((sum, r: any) => sum + r.count, 0);
    const totalDur = rows.reduce((sum, r: any) => sum + r.total_dur_ms, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalCount;
    const jankOverlapCount = rows.reduce((sum, r: any) => sum + Number(r.jank_overlap_count || 0), 0);
    const overlapRatio = totalCount > 0 ? (jankOverlapCount / totalCount) * 100 : 0;

    let summary = `Found ${rows.length} types of long main-thread slices (>16ms). `;
    summary += `Total occurrences: ${totalCount}. `;
    summary += `Total time: ${totalDur.toFixed(2)}ms, average: ${avgDur.toFixed(2)}ms.`;
    if (jankOverlapCount > 0) {
      summary += ` Overlap with janky frames: ${jankOverlapCount}/${totalCount} (${overlapRatio.toFixed(1)}%).`;
    } else {
      summary += ' No overlap with detected janky frames in this trace.';
    }

    if (topSlowest.length > 0) {
      const slowest = topSlowest[0] as any;
      const overlapTag = Number(slowest.overlaps_jank_frame || 0) > 0 ? ' [overlaps jank frame]' : '';
      summary += ` Slowest instance: ${slowest.function_name} at ${slowest.dur_ms.toFixed(2)}ms ` +
        `in ${slowest.thread_name} thread (${slowest.process_name}).${overlapTag}`;
    }

    return summary;
  }

  private formatNetworkSummary(
    rows: Record<string, unknown>[],
    stats: Record<string, unknown> | null
  ): string {
    if (rows.length === 0) {
      return 'No network traffic found in trace.';
    }

    let summary = `Found ${rows.length} network requests.`;

    if (stats) {
      const avgDur = stats.avg_dur_ms as number;
      const minDur = stats.min_dur_ms as number;
      const maxDur = stats.max_dur_ms as number;
      const slowRequests = stats.slow_requests as number;

      summary += ` Average duration: ${avgDur?.toFixed(2)}ms. `;
      summary += `Min: ${minDur?.toFixed(2)}ms, Max: ${maxDur?.toFixed(2)}ms.`;

      if (slowRequests > 0) {
        summary += ` Slow requests (>1s): ${slowRequests}.`;
      }
    }

    return summary;
  }

  private formatDatabaseSummary(
    rows: Record<string, unknown>[],
    stats: Record<string, unknown> | null
  ): string {
    if (rows.length === 0) {
      return 'No database queries found in trace.';
    }

    let summary = `Found ${rows.length} database queries (SQLite/Room).`;

    if (stats) {
      const avgDur = stats.avg_dur_ms as number;
      const maxDur = stats.max_dur_ms as number;
      const slowQueries = stats.slow_queries as number;

      summary += ` Average duration: ${avgDur?.toFixed(2)}ms. `;
      summary += `Max: ${maxDur?.toFixed(2)}ms.`;

      if (slowQueries > 0) {
        summary += ` Slow queries (>16ms): ${slowQueries}.`;
      }
    }

    return summary;
  }

  private formatFileIOSummary(
    rows: Record<string, unknown>[],
    stats: Record<string, unknown> | null
  ): string {
    if (rows.length === 0) {
      return 'No file I/O operations found in trace.';
    }

    let summary = `Found ${rows.length} file I/O operations.`;

    if (stats) {
      const avgDur = stats.avg_dur_ms as number;
      const maxDur = stats.max_dur_ms as number;
      const readOps = stats.read_ops as number;
      const writeOps = stats.write_ops as number;

      summary += ` Average duration: ${avgDur?.toFixed(2)}ms. `;
      summary += `Max: ${maxDur?.toFixed(2)}ms. `;
      summary += `Read ops: ${readOps}, Write ops: ${writeOps}.`;
    }

    return summary;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Get available analysis types
   */
  getAvailableSkills(): PerfettoSkillType[] {
    return Object.values(PerfettoSkillType);
  }

  /**
   * Get knowledge base reference
   */
  getKnowledgeBase(): SqlKnowledgeBase {
    return this.knowledgeBase;
  }
}

export default PerfettoSqlSkill;
