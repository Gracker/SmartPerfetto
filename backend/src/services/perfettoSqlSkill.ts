/**
 * Perfetto SQL Skill
 *
 * Main service for Perfetto trace analysis using official SQL patterns.
 * Provides specialized analysis functions for common Android performance scenarios.
 *
 * All SQL patterns are based on official Perfetto metrics and stdlib modules.
 */

import { TraceProcessorService } from './traceProcessorService';
import { SqlKnowledgeBase, createKnowledgeBase } from './sqlKnowledgeBase';
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
// Main Perfetto SQL Skill Service
// ============================================================================

export class PerfettoSqlSkill {
  private traceProcessor: TraceProcessorService;
  private knowledgeBase: SqlKnowledgeBase;

  constructor(traceProcessor: TraceProcessorService, knowledgeBase?: SqlKnowledgeBase) {
    this.traceProcessor = traceProcessor;
    this.knowledgeBase = knowledgeBase || createKnowledgeBase();
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
        summary = `Execute this SQL to analyze slow functions. Look for slices > 16ms (missed frame threshold).`;
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
      },
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
ORDER BY ts DESC
LIMIT 20;
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
ORDER BY afs.ts DESC
LIMIT 100;
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
ORDER BY ts DESC
LIMIT 50;
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
ORDER BY e.ts DESC
LIMIT 50;
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
ORDER BY ts DESC
LIMIT 50;
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
ORDER BY total_cpu_sec DESC
LIMIT 50;
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
ORDER BY ts DESC
LIMIT 100;
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
ORDER BY e.ts DESC
LIMIT 50;
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
ORDER BY ts DESC
LIMIT 50;
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
ORDER BY ts DESC
LIMIT 50;
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
ORDER BY ts DESC
LIMIT 50;
    `;
  }

  private getSlowFunctionsSql(packageName?: string): string {
    const processFilter = packageName ? `WHERE p.name GLOB '${packageName}*'` : '';
    return `
-- Slow Functions Analysis (>16ms)
SELECT
  s.name as function_name,
  COUNT(*) as count,
  AVG(s.dur) / 1e6 as avg_dur_ms,
  MAX(s.dur) / 1e6 as max_dur_ms,
  SUM(s.dur) / 1e6 as total_dur_ms,
  p.name as process_name
FROM slice s
JOIN track t ON s.track_id = t.id
JOIN process_track pt ON t.id = pt.id
JOIN process p ON pt.upid = p.upid
${processFilter.replace('WHERE', 'AND')} AND s.dur > 16000000
GROUP BY s.name, p.name
ORDER BY total_dur_ms DESC
LIMIT 50;
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
ORDER BY net.dur DESC
LIMIT 100;
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
ORDER BY s.dur DESC
LIMIT 100;
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
ORDER BY s.dur DESC
LIMIT 100;
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
    // Build WHERE clause
    let whereClause = '';
    if (packageName) {
      whereClause = `WHERE package GLOB '${packageName}*'`;
    }

    // Official SQL pattern from android_startup.sql
    const sql = `
      SELECT
        startup_id,
        ts / 1e6 as ts_ms,
        dur / 1e6 as dur_ms,
        package,
        startup_type
      FROM android_startups
      ${whereClause}
      ORDER BY ts DESC
      LIMIT 20
    `;

    const queryResult = await this.traceProcessor.query(traceId, sql);

    if (queryResult.error) {
      return {
        analysisType: 'startup',
        sql,
        rows: [],
        rowCount: 0,
        summary: `Error analyzing startup: ${queryResult.error}`,
      };
    }

    // Parse results - rows are arrays, need to cast for formatting
    const startups = queryResult.rows as any[];
    const summary = this.formatStartupSummary(startups);

    return {
      analysisType: 'startup',
      sql,
      rows: startups,
      rowCount: startups.length,
      summary,
      metrics: {
        totalStartups: startups.length,
        coldStarts: startups.filter((s: any) => s.startup_type === 'cold').length,
        warmStarts: startups.filter((s: any) => s.startup_type === 'warm').length,
        hotStarts: startups.filter((s: any) => s.startup_type === 'hot').length,
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

    const rows = queryResult.rows as any[];

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
    const jankTypeRows = jankTypeResult.rows || [];

    // Add enhanced analysis for consecutive jank and frozen frames
    const enhancedAnalysis = await this.analyzeJankySessions(traceId, packageName);

    // Add frame stability analysis
    const stabilityAnalysis = await this.analyzeFrameStability(traceId, packageName);

    // Add root cause analysis for janky frames
    const rootCauseAnalysis = await this.analyzeJankRootCauses(traceId, packageName);

    const summary = this.formatFrameTimelineScrollingSummary(
      rows,
      jankTypeRows as any[],
      enhancedAnalysis,
      stabilityAnalysis,
      rootCauseAnalysis
    );

    return {
      analysisType: 'scrolling_frametimeline',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: rows.length > 0 ? rows[0] as any : {},
      details: {
        jankBreakdown: jankTypeRows,
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
      ORDER BY a.dur DESC
      LIMIT 10
    `;

    const frozenFrameResult = await this.traceProcessor.query(traceId, frozenFrameSql);

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

    return {
      jankySessions: (jankSessionsResult.rows || []).map((r: any) => ({
        startIdx: r.start_frame,
        length: r.session_length,
        severity: r.severity,
        totalDurMs: r.total_dur_ms,
        process: r.process_name,
      })),
      frozenFrames: (frozenFrameResult.rows || []).map((r: any) => ({
        ts: r.ts,
        dur: r.dur_ms,
        process: r.process_name,
        jankType: r.jank_type,
      })),
      consecutiveJankCount: consecutiveResult.rows && consecutiveResult.rows.length > 0
        ? (consecutiveResult.rows[0] as any).max_consecutive_jank || 0
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

    // Calculate frame time statistics including standard deviation
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
      stats AS (
        SELECT
          AVG(frame_time_ms) as avg_ms,
          SUM(frame_time_ms * frame_time_ms) / COUNT(*) as avg_sq_ms,
          COUNT(*) as frame_count
        FROM frame_stats
      ),
      percentiles AS (
        SELECT
          percentile_val,
          frame_time_ms
        FROM frame_stats
        JOIN (
          SELECT 0.50 as pct, 'p50' as percentile_val
          UNION SELECT 0.95, 'p95'
          UNION SELECT 0.99, 'p99'
        ) ON frame_time_ms >= (
          SELECT frame_time_ms FROM frame_stats f2
          ORDER BY f2.frame_time_ms
          LIMIT 1 OFFSET (CAST((SELECT COUNT(*) FROM frame_stats) * percentile_val.pct) AS INT) - 1
        )
      )
      SELECT
        s.avg_ms,
        SQRT(s.avg_sq_ms - s.avg_ms * s.avg_ms) as std_dev_ms,
        s.frame_count
      FROM stats s
    `;

    const result = await this.traceProcessor.query(traceId, sql);

    if (result.error || !result.rows || result.rows.length === 0) {
      return null;
    }

    const r = result.rows[0] as any;
    const avgMs = r.avg_ms || 0;
    const stdDevMs = r.std_dev_ms || 0;

    // Calculate coefficient of variation (CV = std/mean)
    // Lower CV means more stable frame rate
    const cv = avgMs > 0 ? (stdDevMs / avgMs) * 100 : 0;

    // Calculate stability score (0-100)
    // Based on how close frame times are to ideal 16.6ms and how stable they are
    let stabilityScore = 100;
    stabilityScore -= Math.min(cv * 2, 50); // Penalty for high variation
    stabilityScore -= Math.min(Math.abs(avgMs - 16.6) * 2, 30); // Penalty for deviation from 60fps
    stabilityScore = Math.max(0, Math.min(100, stabilityScore));

    return {
      avgFrameTimeMs: avgMs,
      stdDevMs: stdDevMs,
      coefficientOfVariation: cv,
      framePercentiles: {
        p50: avgMs, // Approximation
        p95: avgMs + stdDevMs * 1.64, // Approximation
        p99: avgMs + stdDevMs * 2.33, // Approximation
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
    }>;
  } | null> {
    let processFilter = '';
    if (packageName) {
      processFilter = `AND p.name GLOB '${packageName}*'`;
    }

    // Analyze janky frames with root cause attribution
    const sql = `
      WITH janky_frames AS (
        SELECT
          a.id,
          a.ts,
          a.dur,
          a.jank_type,
          a.on_time_finish,
          a.gpu_composition,
          a.present_type,
          p.name as process_name,
          p.upid
        FROM actual_frame_timeline_slice a
        JOIN process p ON a.upid = p.upid
        WHERE a.jank_type IS NOT NULL AND a.jank_type != 'None'
          ${processFilter}
        ORDER BY a.ts
        LIMIT 100
      ),
      thread_analysis AS (
        SELECT
          jf.id,
          jf.ts,
          jf.jank_type,
          jf.gpu_composition,
          jf.present_type,
          -- Check for long running slices on main thread during this frame
          EXISTS(
            SELECT 1 FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            WHERE t.upid = jf.upid
              AND t.name GLOB '*main*'
              AND s.ts >= jf.ts - 16000000
              AND s.ts <= jf.ts + jf.dur
              AND s.dur > 8000000
          ) as has_long_main_thread_work,
          -- Check for SF-related issues
          jf.gpu_composition = 1 as has_gpu_composition
        FROM janky_frames jf
      )
      SELECT
        ts,
        jank_type,
        gpu_composition,
        present_type,
        has_long_main_thread_work,
        has_gpu_composition,
        CASE
          WHEN has_long_main_thread_work = 1 THEN 'MainThread'
          WHEN has_gpu_composition = 1 THEN 'GPU'
          WHEN present_type = 'Late' THEN 'BufferQueue'
          ELSE 'System'
        END as root_cause
      FROM thread_analysis
    `;

    const result = await this.traceProcessor.query(traceId, sql);

    if (result.error || !result.rows || result.rows.length === 0) {
      return null;
    }

    const rows = result.rows as any[];

    // Count by root cause
    let mainThreadJank = 0;
    let gpuJank = 0;
    let sfJank = 0;
    let bufferJank = 0;

    const details = rows.map((r: any) => {
      if (r.root_cause === 'MainThread') mainThreadJank++;
      else if (r.root_cause === 'GPU') gpuJank++;
      else if (r.root_cause === 'BufferQueue') bufferJank++;
      else sfJank++;

      return {
        frameTs: r.ts,
        jankType: r.jank_type,
        rootCause: r.root_cause,
        description: this.getRootCauseDescription(r.root_cause, r.jank_type),
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

    const rows = queryResult.rows as any[];
    const summary = this.formatLegacyScrollingSummary(rows);

    return {
      analysisType: 'scrolling_legacy',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: rows.length > 0 ? rows[0] as any : {},
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

    const rows = queryResult.rows as any[];
    const summary = this.formatMemorySummary(rows);

    return {
      analysisType: 'memory',
      sql,
      rows,
      rowCount: rows.length,
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
      LIMIT 20
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

    const rows = queryResult.rows as any[];
    const summary = this.formatCpuSummary(rows);

    return {
      analysisType: 'cpu',
      sql,
      rows,
      rowCount: rows.length,
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

    const rows = queryResult.rows as any[];
    const summary = this.formatSurfaceFlingerSummary(rows);

    return {
      analysisType: 'surfaceflinger',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: rows.length > 0 ? rows[0] as any : {},
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

    const rows = queryResult.rows as any[];
    const summary = this.formatBinderSummary(rows);

    return {
      analysisType: 'binder',
      sql,
      rows,
      rowCount: rows.length,
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
      LIMIT 20
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

    const rows = queryResult.rows as any[];
    const summary = this.formatNavigationSummary(rows);

    return {
      analysisType: 'navigation',
      sql,
      rows,
      rowCount: rows.length,
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

    const rows = queryResult.rows as any[];
    const summary = this.formatClickResponseSummary(rows);

    return {
      analysisType: 'click_response',
      sql,
      rows,
      rowCount: rows.length,
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

    const rows = queryResult.rows as any[];
    const summary = this.formatInputSummary(rows);

    return {
      analysisType: 'input',
      sql,
      rows,
      rowCount: rows.length,
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

    const rows = queryResult.rows as any[];
    const summary = this.formatBufferFlowSummary(rows);

    return {
      analysisType: 'bufferflow',
      sql,
      rows,
      rowCount: rows.length,
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
      LIMIT 50
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

    const rows = queryResult.rows as any[];
    const summary = this.formatSystemServerSummary(rows);

    return {
      analysisType: 'systemserver',
      sql,
      rows,
      rowCount: rows.length,
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

    // Find slow functions (>16ms - frame budget for 60fps)
    const sql = `
      WITH slow_functions AS (
        SELECT
          s.name as function_name,
          s.dur / 1e6 as dur_ms,
          s.ts / 1e6 as ts_ms,
          t.name as thread_name,
          p.name as process_name
        FROM slice s
        JOIN track tr ON s.track_id = tr.id
        JOIN thread_track tt ON tr.id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE s.dur > 16000000
          ${processFilter}
      ),
      aggregated AS (
        SELECT
          function_name,
          process_name,
          COUNT(*) as count,
          AVG(dur_ms) as avg_dur_ms,
          MAX(dur_ms) as max_dur_ms,
          SUM(dur_ms) as total_dur_ms
        FROM slow_functions
        GROUP BY function_name, process_name
      )
      SELECT
        function_name,
        process_name,
        count,
        avg_dur_ms,
        max_dur_ms,
        total_dur_ms
      FROM aggregated
      ORDER BY total_dur_ms DESC
      LIMIT 50
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

    const rows = queryResult.rows as any[];

    // Get top slowest individual instances
    const topSlowestSql = `
      SELECT
        s.name as function_name,
        s.dur / 1e6 as dur_ms,
        s.ts / 1e6 as ts_ms,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN track tr ON s.track_id = tr.id
      JOIN thread_track tt ON tr.id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.dur > 16000000
        ${processFilter}
      ORDER BY s.dur DESC
      LIMIT 20
    `;

    const topSlowestResult = await this.traceProcessor.query(traceId, topSlowestSql);
    const topSlowest = topSlowestResult.rows || [];

    const summary = this.formatSlowFunctionsSummary(rows, topSlowest as any[]);

    return {
      analysisType: 'slow_functions',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: {
        totalSlowFunctions: rows.length,
        threshold: '16ms (frame budget)',
      },
      details: {
        topSlowest,
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
      ORDER BY net.dur DESC
      LIMIT 100
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

    const rows = queryResult.rows as any[];

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
    const stats = statsResult.rows && statsResult.rows.length > 0 ? statsResult.rows[0] as any : null;

    const summary = this.formatNetworkSummary(rows, stats);

    return {
      analysisType: 'network',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: stats ? {
        totalRequests: stats.total_requests,
        avgDurationMs: stats.avg_dur_ms,
        maxDurationMs: stats.max_dur_ms,
        slowRequests: stats.slow_requests,
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
      ORDER BY s.dur DESC
      LIMIT 100
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

    const rows = queryResult.rows as any[];

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
    const stats = statsResult.rows && statsResult.rows.length > 0 ? statsResult.rows[0] as any : null;

    const summary = this.formatDatabaseSummary(rows, stats);

    return {
      analysisType: 'database',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: stats ? {
        totalQueries: stats.total_queries,
        avgDurationMs: stats.avg_dur_ms,
        maxDurationMs: stats.max_dur_ms,
        slowQueries: stats.slow_queries,
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
      ORDER BY s.dur DESC
      LIMIT 100
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

    const rows = queryResult.rows as any[];

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
    const stats = statsResult.rows && statsResult.rows.length > 0 ? statsResult.rows[0] as any : null;

    const summary = this.formatFileIOSummary(rows, stats);

    return {
      analysisType: 'file_io',
      sql,
      rows,
      rowCount: rows.length,
      summary,
      metrics: stats ? {
        totalOperations: stats.total_operations,
        avgDurationMs: stats.avg_dur_ms,
        maxDurationMs: stats.max_dur_ms,
        readOps: stats.read_ops,
        writeOps: stats.write_ops,
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
      return 'No slow functions found in trace. All functions completed within the 16ms frame budget.';
    }

    const totalCount = rows.reduce((sum, r: any) => sum + r.count, 0);
    const totalDur = rows.reduce((sum, r: any) => sum + r.total_dur_ms, 0);
    const avgDur = rows.reduce((sum, r: any) => sum + r.avg_dur_ms * r.count, 0) / totalCount;

    let summary = `Found ${rows.length} types of slow functions (>16ms threshold). `;
    summary += `Total occurrences: ${totalCount}. `;
    summary += `Total time: ${totalDur.toFixed(2)}ms, average: ${avgDur.toFixed(2)}ms.`;

    if (topSlowest.length > 0) {
      const slowest = topSlowest[0] as any;
      summary += ` Slowest instance: ${slowest.function_name} at ${slowest.dur_ms.toFixed(2)}ms ` +
        `in ${slowest.thread_name} thread (${slowest.process_name}).`;
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
