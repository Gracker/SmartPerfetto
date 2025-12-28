# PerfettoSqlSkill Standard Operating Procedure

## Overview

PerfettoSqlSkill is an intelligent SQL generation and analysis service that automatically identifies analysis intents from natural language questions and generates corresponding SQL queries for Perfetto trace analysis.

The skill system supports 15 specialized analysis types, each optimized for specific Android performance scenarios using official Perfetto SQL patterns and stdlib modules.

## Architecture

### Core Components

1. **Skill Classifier** (`detectIntent`)
   - Uses keyword matching and regex patterns to identify analysis type
   - Extracts parameters (package names, thresholds, etc.)
   - Returns confidence scores for each detected skill

2. **Skill Router** (`analyze` method)
   - Routes questions to appropriate skill analysis method
   - Handles both backend traces and WASM browser-based traces
   - Generates SQL-only responses for WASM mode

3. **Analysis Methods**
   - Each skill has a dedicated `analyze*` method
   - Methods execute Perfetto SQL queries
   - Format results with human-readable summaries

4. **SQL Template Generators** (WASM mode)
   - Pre-built SQL templates for each skill
   - Support package name filtering
   - Include helpful comments and schema information

## Supported Analysis Skills

### 1. Startup Analysis (STARTUP)
- **Trigger Words**: startup, launch, 启动, 启动时间, 冷启动, 热启动, 温启动
- **Patterns**: `/startup|launch/i`, `/启动|启动速度|启动时间/i`, `/cold.*start|warm.*start|hot.*start/i`
- **Analysis Content**: App startup time, startup phase breakdown, TTID/TTFD metrics
- **SQL Pattern**: `android_startups` table
- **Metrics**:
  - `startup_id`: Unique startup identifier
  - `startup_type`: cold/warm/hot
  - `dur`: Startup duration
  - `ttid`: Time to Initial Display
  - `ttfd`: Time to Full Display
- **Based on**: `perfetto_sql/stdlib/android/startup/startups_minsdk33.sql`

### 2. Scrolling/Jank Analysis (SCROLLING)
- **Trigger Words**: scroll, jank, fps, frame, 滑动, 卡顿, 帧率
- **Patterns**: `/scroll|jank|fps/i`, `/滑动|卡顿|帧率|掉帧/i`, `/frame.*miss/i`
- **Analysis Content**:
  - Frame rate statistics and jank detection
  - FrameTimeline analysis (Android 12+)
  - Legacy multi-dimensional analysis (Android < 12)
  - Root cause attribution (Main Thread, GPU, BufferQueue, System)
  - Consecutive jank detection
  - Frozen frame detection (>700ms)
  - Frame stability metrics
- **SQL Patterns**:
  - Modern: `actual_frame_timeline_slice`, `expected_frame_timeline_slice`
  - Legacy: `doFrame` + `RenderThread` + `SurfaceFlinger` combination
- **Based on**: https://perfetto.dev/docs/data-sources/frametimeline
- **Special Features**:
  - Janky session analysis (grouping consecutive janky frames)
  - Stability score calculation (0-100)
  - Frame percentiles (P50, P95, P99)
  - GPU composition detection

### 3. Navigation Analysis (NAVIGATION)
- **Trigger Words**: navigation, activity, switch, 切换, 界面切换, 页面跳转
- **Patterns**: `/navigation|activity.*switch/i`, `/界面切换|页面跳转|activity.*切换/i`
- **Analysis Content**: Activity navigation performance, transition timing
- **SQL Pattern**:
  - Backend mode: Uses `slice` table with filtering for `perform*` and `*Activity*` patterns
  - WASM mode: Uses dedicated `activity_manager_transitions` table
- **Metrics**: Count, avg/min/max duration per navigation type
- **Important Note**: The backend implementation queries the `slice` table filtering for activity lifecycle events, while WASM mode uses the specialized `activity_manager_transitions` table which provides more structured navigation data.

### 4. Click Response Analysis (CLICK_RESPONSE)
- **Trigger Words**: click, tap, response, latency, 点击, 响应, 点击响应
- **Patterns**: `/click.*response|input.*latency/i`, `/点击响应|点击延迟|输入响应/i`
- **Analysis Content**: Click/tap response latency, input event timing
- **SQL Pattern**: Filter slice table for `*Input*`, `*Click*`, `*Touch*`
- **Metrics**: Event count, avg/min/max response time
- **Important Note**: Backend mode uses `GLOB '*Click*'` pattern, while WASM mode uses `LIKE '%Click%'`. Both achieve the same filtering but use different SQL syntax due to implementation differences.

### 5. Memory Analysis (MEMORY)
- **Trigger Words**: memory, heap, oom, leak, gc, 内存, 内存泄漏, OOM
- **Patterns**: `/memory|heap|oom|leak|gc/i`, `/内存|内存泄漏|OOM|GC/i`
- **Analysis Content**: GC events, heap memory allocation, memory leaks
- **SQL Pattern**: Filter slice for `*GC*`, `*allocation*`, `*Allocation*`
- **Based on**: `linux/memory/*.sql` patterns
- **Metrics**: GC count, total GC time, average GC duration

### 6. CPU Analysis (CPU)
- **Trigger Words**: cpu, utilization, core, frequency, CPU利用率, CPU频率
- **Patterns**: `/cpu.*util|cpu.*freq|core/i`, `/CPU利用率|CPU频率|核心/i`
- **Analysis Content**: CPU utilization, core scheduling, thread states
- **SQL Pattern**: `thread_state` table with state grouping (R=Running, S=Sleeping)
- **Based on**: `linux/cpu/utilization/*.sql` patterns
- **Metrics**:
  - Total duration per thread
  - Running vs sleeping time
  - State change count

### 7. SurfaceFlinger Analysis (SURFACE_FLINGER)
- **Trigger Words**: surfaceflinger, sf, composition, gpu, fence
- **Patterns**: `/surfaceflinger|composition|gpu.*fence/i`
- **Analysis Content**: Frame composition, GPU fallback, frame misses
- **SQL Pattern**: Filter for `/system/bin/surfaceflinger` process with `*frame*`, `*Frame*`
- **Based on**: `android/surfaceflinger.sql`, `android_surfaceflinger.sql`
- **Metrics**: Total frames, missed frames, average frame duration

### 8. SystemServer Analysis (SYSTEM_SERVER)
- **Trigger Words**: systemserver, system.*service, anr
- **Patterns**: `/system.*server|system.*service|anr/i`
- **Analysis Content**: System service performance, long-running operations
- **SQL Pattern**: Filter for `system_server` process, slices > 10ms
- **Metrics**: Operation count, total/max duration

### 9. Input Analysis (INPUT)
- **Trigger Words**: input, touch, gesture, 输入, 触摸, 手势
- **Patterns**: `/input.*latency|touch.*event/i`, `/输入延迟|触摸事件|手势/i`
- **Analysis Content**: Input event tracking, gesture latency
- **SQL Pattern**: Filter for `*input*`, `*Input*`, `*gesture*`
- **Metrics**: Event count, total/average duration

### 10. Binder Analysis (BINDER)
- **Trigger Words**: binder, ipc, transaction, binder调用
- **Patterns**: `/binder|ipc|transaction/i`
- **Analysis Content**: Inter-process communication, transaction latency
- **SQL Pattern**: Filter for `*Binder*` slices
- **Based on**: `android/android_binder.sql`
- **Metrics**: Transaction count, avg/max duration, total time per type

### 11. Buffer Flow Analysis (BUFFER_FLOW)
- **Trigger Words**: buffer, queue, fence, bufferqueue, 流转
- **Patterns**: `/buffer.*queue|buffer.*flow/i`
- **Analysis Content**: Buffer queue operations, GPU fence waits
- **SQL Pattern**: Filter for `/system/bin/surfaceflinger` with `*fence*`, `*GPU*`
- **Metrics**: Event count, total/average duration

### 12. Slow Functions Analysis (SLOW_FUNCTIONS)
- **Trigger Words**: slow, function, method, latency, 耗时, 慢函数, 函数耗时
- **Patterns**: `/slow.*function|method.*latency/i`, `/慢函数|函数耗时|耗时.*函数/i`
- **Analysis Content**: Functions exceeding 16ms frame budget
- **SQL Pattern**: `slice` table with `dur > 16000000` (16ms)
- **Metrics**:
  - Function count by name
  - Average/max duration
  - Total time spent
  - Top slowest instances
- **Threshold**: 16ms (60fps frame budget)

### 13. Network Analysis (NETWORK) - NEW
- **Trigger Words**: network, http, request, socket, 网络, 请求, HTTP
- **Patterns**: `/network|http.*request|socket/i`, `/网络|网络请求|HTTP/i`
- **Analysis Content**: HTTP request performance, network latency
- **SQL Pattern**: `network_traffic_slice` table
- **Metrics**:
  - Request count
  - Average/min/max duration
  - Slow requests (>1s)
  - Request URLs and types

### 14. Database Analysis (DATABASE) - NEW
- **Trigger Words**: database, sqlite, room, db, 数据库, SQL
- **Patterns**: `/database|sqlite|room.*query|db.*query/i`, `/数据库|sqlite|room/i`
- **Analysis Content**: SQLite/Room query performance
- **SQL Pattern**: Filter for `*sqlite*%`, `*room*%` in slice table
- **Metrics**:
  - Query count
  - Average/max duration
  - Slow queries (>16ms)
  - Query types and frequencies

### 15. File I/O Analysis (FILE_IO) - NEW
- **Trigger Words**: file, io, read, write, 文件, 读写
- **Patterns**: `/file.*io|file.*read|file.*write|storage/i`, `/文件|读写|文件读写|磁盘/i`
- **Analysis Content**: File read/write operations
- **SQL Pattern**: Filter for `*read*%`, `*write*%`, `*fs_*%`
- **Metrics**:
  - Operation count
  - Average/max duration
  - Read vs write operation breakdown

## Adding New Skills

### Step 1: Define Skill Type
Add to `PerfettoSkillType` enum in `types/perfettoSql.ts`:
```typescript
export enum PerfettoSkillType {
  // ... existing types
  YOUR_NEW_SKILL = 'your_new_skill',
}
```

### Step 2: Add Pattern Matching
Add to `SKILL_PATTERNS` array in `perfettoSqlSkill.ts`:
```typescript
{
  skillType: PerfettoSkillType.YOUR_NEW_SKILL,
  keywords: ['keyword1', 'keyword2', '关键词'],
  patterns: [
    /regex.*pattern/i,
    /正则表达式/i,
  ],
}
```

### Step 3: Implement Analysis Method
```typescript
async analyzeYourNewSkill(
  traceId: string,
  packageName?: string
): Promise<PerfettoSqlResponse> {
  // 1. Build WHERE clause for package filtering
  const processFilter = packageName
    ? `AND p.name GLOB '${packageName}*'`
    : '';

  // 2. Write SQL query
  const sql = `YOUR SQL HERE ${processFilter}`;

  // 3. Execute query
  const queryResult = await this.traceProcessor.query(traceId, sql);

  // 4. Handle errors
  if (queryResult.error) {
    return {
      analysisType: 'your_new_skill',
      sql,
      rows: [],
      rowCount: 0,
      summary: `Error: ${queryResult.error}`,
    };
  }

  // 5. Format results
  const rows = queryResult.rows as any[];
  const summary = this.formatYourNewSkillSummary(rows);

  return {
    analysisType: 'your_new_skill',
    sql,
    rows,
    rowCount: rows.length,
    summary,
    metrics: { /* optional metrics */ },
  };
}
```

### Step 4: Add WASM SQL Template
For browser-based trace analysis:
```typescript
private getYourNewSkillSql(packageName?: string): string {
  const processFilter = packageName
    ? `AND p.name GLOB '${packageName}*'`
    : '';

  return `
-- Your Skill Analysis
SELECT ... FROM ...
WHERE 1=1 ${processFilter}
ORDER BY ... DESC
LIMIT 50;
  `;
}
```

### Step 5: Add Summary Formatter
```typescript
private formatYourNewSkillSummary(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return 'No data found in trace.';
  }

  // Calculate statistics
  // Return human-readable summary
  return `Found X events. Average duration: Yms.`;
}
```

### Step 6: Wire into Router
Add case in `analyze` method switch statement:
```typescript
case PerfettoSkillType.YOUR_NEW_SKILL:
  result = await this.analyzeYourNewSkill(traceId, packageName);
  break;
```

### Step 7: Add to WASM Router
Add case in `generateSqlOnlyResponse` method:
```typescript
case PerfettoSkillType.YOUR_NEW_SKILL:
  sql = this.getYourNewSkillSql(packageName);
  summary = 'Execute this SQL to analyze...';
  break;
```

### Step 8: Update Type Definitions
Add result type to `types/perfettoSql.ts` if needed:
```typescript
export interface YourNewSkillResult {
  // your result fields
}
```

### Step 9: Write Tests
Create test cases for:
- Pattern matching (keywords and regex)
- SQL generation with/without package filter
- Result formatting
- Edge cases (no data, errors)

### Step 10: Update Documentation
- Add entry to this SOP
- Document trigger words and patterns
- Include SQL examples
- Note any Perfetto stdlib dependencies

## Best Practices

### SQL Patterns
1. **Use official Perfetto tables** - Reference `perfetto_sql/stdlib/` modules
2. **Filter by package** - Support optional `packageName` parameter
3. **Convert timestamps** - Use `/ 1e6` for milliseconds, `/ 1e9` for seconds
4. **Limit results** - Use `LIMIT` to avoid excessive data
5. **Join properly** - Use `track_id`, `utid`, `upid` foreign keys

### Pattern Matching
1. **Start broad** - Use multiple keywords for flexibility
2. **Add regex patterns** - Catch variations and word combinations
3. **Avoid over-matching** - Be specific enough to avoid false positives
4. **Support bilingual** - Include both English and Chinese terms

### Summary Formatting
1. **Handle empty results** - Provide helpful message when no data found
2. **Include statistics** - Count, avg, min, max
3. **Be concise** - One or two sentences max
4. **Highlight issues** - Point out anomalies (slow ops, errors, etc.)

### Error Handling
1. **Check query errors** - Return error message in summary
2. **Validate inputs** - Check traceId, packageName format
3. **Graceful degradation** - Fall back to generic analysis if needed

## Troubleshooting

### Skill Not Triggering
1. Check keyword spelling in query
2. Verify pattern is in `SKILL_PATTERNS`
3. Test regex patterns separately
4. Check confidence score in `detectIntent`

### No Results Returned
1. Verify table exists in trace schema
2. Check package name matches process name
3. Relax filters (remove package filter temporarily)
4. Increase `LIMIT` clause
5. Check trace collection settings

### SQL Errors
1. Validate column names against schema
2. Check JOIN conditions (foreign keys)
3. Verify timestamp conversions (nanoseconds!)
4. Test SQL in Perfetto UI first

### Wrong Analysis Type
1. Check pattern overlap with other skills
2. Adjust regex specificity
3. Review skill priority in `detectIntent`
4. Consider user intent vs literal matching

## References

- **Perfetto SQL Documentation**: https://perfetto.dev/docs/analysis/sql-queries
- **Perfetto Stdlib**: https://perfetto.dev/docs/analysis/stdlib
- **Android Performance Patterns**: https://developer.android.com/topic/performance
- **FrameTimeline**: https://perfetto.dev/docs/data-sources/frametimeline
- **Trace Collection**: https://perfetto.dev/docs/concepts/config

## File Locations

- **Service**: `/backend/src/services/perfettoSqlSkill.ts`
- **Types**: `/backend/src/types/perfettoSql.ts`
- **Tests**: `/backend/src/tests/perfettoSqlSkill.test.ts` (when created)
- **This SOP**: `/docs/sops/perfettoSqlSkill.md`
