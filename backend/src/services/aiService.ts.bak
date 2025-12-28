import OpenAI from 'openai';
import axios from 'axios';
import { GenerateSqlRequest, TraceAnalysisRequest, TraceAnalysisResponse, GenerateSqlResponse } from '../types';

// Perfetto SQL 知识库 - 官方表结构
const PERFETTO_SQL_KNOWLEDGE = `
Perfetto Official SQL Tables Reference:

### 核心事件表 (Events Tables)

1. **slice** - 用户空间切片事件
   - id: 切片唯一标识符
   - type: 切片类型 (slice, instant, counter)
   - name: 人类可读的名称
   - ts: 开始时间戳 (纳秒)
   - dur: 持续时间 (纳秒)
   - track_id: 轨道引用
   - category: 事件类别
   - depth: 切片深度
   - parent_id: 父切片ID

2. **ftrace_event** - 原始 ftrace 事件
   - id: 事件唯一标识符
   - ts: 时间戳
   - name: 事件名称
   - utid: 线程唯一ID
   - arg_set_id: 参数集ID
   - common_flags: 通用标志
   - ucpu: 用户CPU

3. **sched** - Linux内核线程调度
   - id: 调度事件ID
   - ts: 时间戳
   - dur: 持续时间
   - utid: 线程唯一ID
   - end_state: 结束状态
   - priority: 优先级
   - ucpu: CPU编号

4. **thread_state** - 线程调度状态
   - id: 状态ID
   - ts: 时间戳
   - dur: 持续时间
   - utid: 线程唯一ID
   - state: 状态 (R, S, D, Z, T, etc)
   - io_wait: IO等待
   - blocked_function: 阻塞函数

### 元数据表 (Metadata Tables)

5. **process** - 进程信息
   - upid: 进程唯一ID
   - pid: 进程ID
   - name: 进程名称
   - start_ts: 开始时间戳
   - end_ts: 结束时间戳
   - parent_upid: 父进程ID
   - uid: 用户ID

6. **thread** - 线程信息
   - utid: 线程唯一ID
   - tid: 线程ID
   - name: 线程名称
   - start_ts: 开始时间戳
   - end_ts: 结束时间戳
   - upid: 所属进程ID
   - is_main_thread: 是否主线程

7. **machine** - 系统信息
   - id: 机器ID
   - raw_id: 原始ID
   - sysname: 系统名称
   - release: 版本
   - version: 版本详情
   - arch: 架构

### 性能分析表 (Profiler Tables)

8. **cpu_profile_stack_sample** - CPU栈采样
   - id: 采样ID
   - ts: 时间戳
   - callsite_id: 调用点ID
   - utid: 线程ID

9. **heap_profile_allocation** - 内存分配
   - id: 分配ID
   - ts: 时间戳
   - callsite_id: 调用点ID
   - size: 分配大小
   - upid: 进程ID

### Android 特定表 (Android Tables)

10. **android_dumpstate** - Android dumpsys条目
    - id: 条目ID
    - ts: 时间戳
    - upid: 进程ID
    - title: 标题
    - dumpsys: dumpsys内容

### 其他重要表

11. **counter** - 计数器时序数据
    - id: 计数器ID
    - ts: 时间戳
    - value: 计数值
    - track_id: 轨道引用

12. **args** - 键值对参数
    - arg_set_id: 参数集ID
    - key: 键
    - int_value: 整数值
    - string_value: 字符串值
    - real_value: 浮点值

13. **flow** - 数据流
    - id: 流ID
    - ts: 时间戳
    - dur: 持续时间
    - slice_out: 输出切片
    - slice_in: 输入切片

14. **track** - 轨道信息
    - id: 轨道ID
    - name: 轨道名称
    - parent_id: 父轨道ID
    - uuid: 唯一标识符

### 内置函数和宏 (Built-in Functions and Macros)

**常用函数**:
- EXTRACT_ARG(arg_set_id, 'key') - 提取参数
- EXTRACT_UTID(utid) - 提取线程信息
- EXTRACT_UPID(upid) - 提取进程信息
- SPAN_JOIN(a_table, b_table) - 时间片连接
- INTERSECTION() - 时间区间交集
- IIF(condition, true_value, false_value) - 条件表达式
- LEAST(a, b) / GREATEST(a, b) - 最小/最大值

**常用宏**:
- ANDROID_APP_CRASH() - Android应用崩溃
- ANDROID_JANK() - Android卡顿
- ANDROID_PROCESS_STARTUP() - Android进程启动
- ANDROID_POWER_RAILS() - Android功耗轨

### 性能分析常用查询

**1. ANR检测 (Application Not Responding)**
```sql
SELECT
  thread.name AS thread_name,
  process.name AS process_name,
  slice.ts,
  slice.dur / 1e6 AS dur_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 5e9  -- 5 seconds
  AND process.name NOT LIKE 'com.android.'
ORDER BY slice.dur DESC;
```

**2. 主线程卡顿 (Jank)**
```sql
WITH main_thread_slices AS (
  SELECT slice.*
  FROM slice
  JOIN thread_track ON slice.track_id = thread_track.id
  JOIN thread USING (utid)
  JOIN process USING (upid)
  WHERE thread.is_main_thread = 1
    AND slice.category = 'gfx'
)
SELECT
  name,
  COUNT(*) AS count,
  AVG(dur) / 1e6 AS avg_dur_ms,
  MAX(dur) / 1e6 AS max_dur_ms
FROM main_thread_slices
WHERE dur > 16.67e6  -- 60fps threshold
GROUP BY name;
```

**3. 内存分配分析**
```sql
SELECT
  process.name,
  SUM(heap_profile_allocation.size) / 1024 / 1024 AS total_mb,
  COUNT(*) AS allocation_count
FROM heap_profile_allocation
JOIN process USING (upid)
WHERE heap_profile_allocation.size > 0
GROUP BY process.name
ORDER BY total_mb DESC
LIMIT 10;
```

**4. CPU使用率**
```sql
SELECT
  cpu,
  COUNT(*) AS scheduling_events,
  SUM(dur) / 1e9 AS total_runtime_sec,
  (SUM(dur) * 100.0 / MAX(ts_end)) AS cpu_usage_percent
FROM (
  SELECT
    cpu,
    SUM(dur) AS dur,
    MAX(ts + dur) AS ts_end
  FROM sched
  GROUP BY cpu, utid
)
GROUP BY cpu;
```

**5. 进程启动时间**
```sql
SELECT
  process.name AS process_name,
  slice.name AS startup_phase,
  slice.ts / 1e6 AS start_time_ms,
  slice.dur / 1e6 AS dur_ms
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.name LIKE '%startup%'
  AND thread.is_main_thread
ORDER BY process.name, slice.ts;
```

### 时间单位转换
- 1 ns = 1e-9 秒
- 1 μs = 1e-6 秒 (微秒)
- 1 ms = 1e-3 秒 (毫秒)
- 1 s = 1e9 纳秒
- Perfetto中时间戳为Unix纳秒时间戳

### 注意事项
- 所有时间相关的值都以纳秒为单位
- 使用JOIN时注意使用正确的连接条件
- 大数据查询时考虑使用LIMIT和索引
- 使用EXPLAIN QUERY PLAN查看查询计划
- Android trace分析可使用ANDROID_*()宏函数
`;

class AIService {
  private openai?: OpenAI;
  private claudeUrl?: string;

  constructor() {
    const aiService = process.env.AI_SERVICE;

    if (aiService === 'openai' && process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    } else if (aiService === 'claude' && process.env.ANTHROPIC_API_KEY) {
      this.claudeUrl = 'https://api.anthropic.com/v1/messages';
    }
  }

  private async callOpenAI(prompt: string): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI not configured');
    }

    const completion = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are a Perfetto SQL expert. Generate accurate Perfetto SQL queries based on user requirements. Always provide explanations for your queries. ${PERFETTO_SQL_KNOWLEDGE}`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    return completion.choices[0].message.content || '';
  }

  private async callClaude(prompt: string): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Claude not configured');
    }

    const response = await axios.post(
      this.claudeUrl!,
      {
        model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: `You are a Perfetto SQL expert. Generate accurate Perfetto SQL queries based on user requirements. Always provide explanations for your queries. ${PERFETTO_SQL_KNOWLEDGE}\n\nUser request: ${prompt}`,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    return response.data.content[0].text;
  }

  async generatePerfettoSQL(request: GenerateSqlRequest): Promise<GenerateSqlResponse> {
    const prompt = `Generate a Perfetto SQL query for the following request: "${request.query}"`;

    if (request.context) {
      prompt += `\n\nAdditional context: ${request.context}`;
    }

    prompt += `

    Please provide:
    1. The SQL query
    2. A clear explanation of what the query does
    3. Any important notes about the query

    Format your response as:
    --- SQL ---
    [Your SQL query here]
    --- EXPLANATION ---
    [Your explanation here]
    --- NOTES ---
    [Any important notes]
    `;

    const response = process.env.AI_SERVICE === 'claude'
      ? await this.callClaude(prompt)
      : await this.callOpenAI(prompt);

    // Parse response
    const sqlMatch = response.match(/--- SQL ---\n([\s\S]*?)\n--- EXPLANATION ---/);
    const explanationMatch = response.match(/--- EXPLANATION ---\n([\s\S]*?)(\n--- NOTES ---|\n$|$)/);
    const notesMatch = response.match(/--- NOTES ---\n([\s\S]*)/);

    const sql = sqlMatch ? sqlMatch[1].trim() : response;
    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Query generated successfully';
    const notes = notesMatch ? notesMatch[1].trim() : '';

    return {
      sql,
      explanation,
      examples: notes ? [notes] : [],
    };
  }

  async analyzeTrace(request: TraceAnalysisRequest): Promise<TraceAnalysisResponse> {
    // For now, return a mock response
    // In production, this would analyze the actual trace file
    return {
      insights: [
        'Main thread blocked for 234ms at timestamp 15.3s',
        'Memory usage peaked at 856MB during app startup',
        'Detected 12 GC events with average duration of 45ms',
        'Frame drops detected during list scrolling',
      ],
      sqlQueries: [
        `SELECT name, dur, ts
         FROM slice
         JOIN thread_track USING(track_id)
         JOIN thread USING(utid)
         WHERE thread.name = 'main'
           AND dur > 100000000  -- > 100ms
         ORDER BY dur DESC
         LIMIT 10;`,
        `SELECT *
         FROM heap_graph_object
         WHERE type_name LIKE 'Bitmap%'
         GROUP BY type_name
         HAVING COUNT(*) > 100;`,
      ],
      recommendations: [
        'Optimize main thread operations by moving heavy work to background threads',
        'Implement object pooling for frequently created objects',
        'Consider using image loading libraries with memory caching',
        'Implement view recycling for better scrolling performance',
      ],
      metrics: {
        duration: 1234567890,
        memoryPeak: 856 * 1024 * 1024,
        cpuUsage: 75,
        frameDrops: 23,
      },
    };
  }
}

export default AIService;