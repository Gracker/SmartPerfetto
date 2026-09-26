// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SQL模板引擎 - 管理和执行Perfetto SQL模板
 */

export interface SQLTemplate {
  name: string;
  sql: string;
  params: string[];
  description: string;
  category: 'launch' | 'cpu' | 'memory' | 'render' | 'general';
  examples?: { [key: string]: any };
}

export interface SQLValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Perfetto SQL 模板库
 */
export const PERFETTO_SQL_TEMPLATES: { [key: string]: SQLTemplate } = {
  // 1. 应用启动时间
  APP_LAUNCH_TIME: {
    name: 'APP_LAUNCH_TIME',
    sql: `SELECT slice.name AS phase, MIN(slice.ts) / 1e9 AS start_time_s, slice.dur / 1e6 AS duration_ms FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' AND (slice.name = 'activityStart' OR slice.name = 'activityResume') ORDER BY slice.ts ASC;`,
    params: ['app_package'],
    description: '获取应用启动的activityStart和activityResume阶段时间',
    category: 'launch',
    examples: {
      app_package: 'com.example.app'
    }
  },

  // 2. 总启动时间
  TOTAL_LAUNCH_TIME: {
    name: 'TOTAL_LAUNCH_TIME',
    sql: `SELECT MIN(slice.ts) / 1e9 AS launch_start_s, MAX(slice.ts + slice.dur) / 1e9 AS launch_end_s, (MAX(slice.ts + slice.dur) - MIN(slice.ts)) / 1e6 AS total_launch_time_ms FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' AND (slice.name = 'activityStart' OR slice.name = 'activityResume');`,
    params: ['app_package'],
    description: '计算应用的总启动时间',
    category: 'launch',
    examples: {
      app_package: 'com.example.app'
    }
  },

  // 3. Top耗时操作
  TOP_OPERATIONS: {
    name: 'TOP_OPERATIONS',
    sql: `SELECT slice.name AS operation, slice.dur / 1e6 AS duration_ms, slice.ts / 1e9 AS timestamp_s, thread.name AS thread_name FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' AND slice.ts >= {start_ts} AND slice.ts <= {end_ts} AND slice.dur > {min_duration_ns} ORDER BY slice.dur DESC LIMIT {limit};`,
    params: ['app_package', 'start_ts', 'end_ts', 'min_duration_ns', 'limit'],
    description: '获取指定时间范围内的Top耗时操作',
    category: 'general',
    examples: {
      app_package: 'com.example.app',
      start_ts: '40919970000000',
      end_ts: '40920200000000',
      min_duration_ns: '1000000',
      limit: '20'
    }
  },

  // 4. 主线程CPU核心分布
  MAIN_THREAD_CPU_DISTRIBUTION: {
    name: 'MAIN_THREAD_CPU_DISTRIBUTION',
    sql: `SELECT sched.cpu AS cpu_core, COUNT(*) AS schedule_count, SUM(sched.dur) / 1e6 AS total_time_ms, AVG(sched.dur) / 1e6 AS avg_time_ms FROM sched JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' AND thread.is_main_thread = 1 AND sched.ts >= {start_ts} AND sched.ts <= {end_ts} GROUP BY sched.cpu ORDER BY sched.cpu;`,
    params: ['app_package', 'start_ts', 'end_ts'],
    description: '分析主线程在各CPU核心上的运行时间分布',
    category: 'cpu',
    examples: {
      app_package: 'com.example.app',
      start_ts: '40919970000000',
      end_ts: '40920200000000'
    }
  },

  // 5. CPU频率分布
  CPU_FREQUENCY_DISTRIBUTION: {
    name: 'CPU_FREQUENCY_DISTRIBUTION',
    sql: `SELECT counter_track.name AS cpu, AVG(counter.value) / 1000000 AS avg_freq_ghz, MIN(counter.value) / 1000000 AS min_freq_ghz, MAX(counter.value) / 1000000 AS max_freq_ghz FROM counter JOIN counter_track ON counter.track_id = counter_track.id WHERE counter_track.name LIKE 'cpufreq%' AND counter.ts >= {start_ts} AND counter.ts <= {end_ts} GROUP BY counter_track.name ORDER BY counter_track.name;`,
    params: ['start_ts', 'end_ts'],
    description: '获取指定时间范围内的CPU频率统计',
    category: 'cpu',
    examples: {
      start_ts: '40919970000000',
      end_ts: '40920200000000'
    }
  },

  // 6. CPU负载
  CPU_LOAD: {
    name: 'CPU_LOAD',
    sql: `SELECT cpu AS cpu_core, COUNT(*) AS total_schedules, SUM(dur) / 1e6 AS total_run_time_ms, ROUND((SUM(dur) * 100.0 / {window_ns}), 2) AS utilization_percent FROM sched WHERE ts >= {start_ts} AND ts <= {end_ts} GROUP BY cpu ORDER BY cpu;`,
    params: ['start_ts', 'end_ts', 'window_ns'],
    description: '分析各CPU核心的负载情况',
    category: 'cpu',
    examples: {
      start_ts: '40919970000000',
      end_ts: '40920200000000',
      window_ns: '230000000'
    }
  },

  // 7. 查找应用的所有slice
  APP_ALL_SLICES: {
    name: 'APP_ALL_SLICES',
    sql: `SELECT slice.name, COUNT(*) AS count, AVG(slice.dur) / 1e6 AS avg_duration_ms, MAX(slice.dur) / 1e6 AS max_duration_ms FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' GROUP BY slice.name HAVING COUNT(*) > {min_count} ORDER BY avg_duration_ms DESC LIMIT {limit};`,
    params: ['app_package', 'min_count', 'limit'],
    description: '获取应用的所有slice及其统计信息',
    category: 'general',
    examples: {
      app_package: 'com.example.app',
      min_count: '5',
      limit: '50'
    }
  },

  // 8. 帧渲染分析
  FRAME_RENDERING: {
    name: 'FRAME_RENDERING',
    sql: `SELECT slice.name, slice.ts / 1e9 AS timestamp_s, slice.dur / 1e6 AS duration_ms FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = '{app_package}' AND (slice.name LIKE '%DrawFrame%' OR slice.name LIKE '%Choreographer%') AND slice.ts >= {start_ts} AND slice.ts <= {end_ts} ORDER BY slice.ts ASC;`,
    params: ['app_package', 'start_ts', 'end_ts'],
    description: '分析应用的帧渲染性能',
    category: 'render',
    examples: {
      app_package: 'com.example.app',
      start_ts: '40919970000000',
      end_ts: '40920200000000'
    }
  }
};

/**
 * SQL模板引擎类
 */
export class SQLTemplateEngine {
  private templates: Map<string, SQLTemplate>;

  constructor() {
    this.templates = new Map();
    this.loadTemplates();
  }

  /**
   * 加载所有模板
   */
  private loadTemplates(): void {
    Object.entries(PERFETTO_SQL_TEMPLATES).forEach(([key, template]) => {
      this.templates.set(key, template);
    });
  }

  /**
   * 根据名称获取模板
   */
  getTemplate(name: string): SQLTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * 根据分类获取模板
   */
  getTemplatesByCategory(category: string): SQLTemplate[] {
    return Array.from(this.templates.values()).filter(t => t.category === category);
  }

  /**
   * 列出所有模板
   */
  listTemplates(): SQLTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * 渲染模板 - 将参数替换到SQL中
   */
  render(templateName: string, params: { [key: string]: any }): string {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    // 检查所需参数
    const missingParams = template.params.filter(p => !(p in params));
    if (missingParams.length > 0) {
      throw new Error(`Missing parameters: ${missingParams.join(', ')}`);
    }

    // 替换参数
    let sql = template.sql;
    template.params.forEach(param => {
      const value = params[param];
      sql = sql.replace(new RegExp(`\\{${param}\\}`, 'g'), value.toString());
    });

    return sql;
  }

  /**
   * 智能匹配模板 - 根据用户查询匹配最合适的模板
   */
  matchTemplate(userQuery: string): SQLTemplate | null {
    const query = userQuery.toLowerCase();

    // 关键词匹配规则
    const matchRules: { [key: string]: string[] } = {
      'APP_LAUNCH_TIME': ['启动时间', '启动阶段', 'launch time', 'activity start'],
      'TOTAL_LAUNCH_TIME': ['总启动时间', '完整启动', 'total launch'],
      'TOP_OPERATIONS': ['耗时操作', '慢操作', 'slow operations', 'top operations'],
      'MAIN_THREAD_CPU_DISTRIBUTION': ['主线程', '核心分布', 'main thread', 'cpu distribution'],
      'CPU_FREQUENCY_DISTRIBUTION': ['cpu频率', 'frequency', '频率分布'],
      'CPU_LOAD': ['cpu负载', 'cpu load', 'cpu utilization'],
      'FRAME_RENDERING': ['帧渲染', '渲染性能', 'frame', 'rendering']
    };

    // 遍历规则，找到匹配的模板
    for (const [templateName, keywords] of Object.entries(matchRules)) {
      if (keywords.some(keyword => query.includes(keyword))) {
        return this.getTemplate(templateName) || null;
      }
    }

    return null;
  }

  /**
   * 验证SQL
   */
  validateSQL(sql: string): SQLValidationResult {
    const result: SQLValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: []
    };

    // 1. 检查是否为空
    if (!sql || sql.trim().length === 0) {
      result.isValid = false;
      result.errors.push('SQL不能为空');
      return result;
    }

    // 2. 检查是否包含多行（trace_processor要求单行）
    if (sql.includes('\n') && sql.split('\n').filter(l => l.trim()).length > 1) {
      result.warnings.push('SQL包含多行，trace_processor可能不支持');
      result.suggestions.push('请将SQL合并为单行');
    }

    // 3. 检查表名
    const validTables = ['slice', 'thread', 'process', 'thread_track', 'sched', 'counter', 'counter_track', 'track'];
    const sqlLower = sql.toLowerCase();

    const invalidTables = ['app_launch', 'performance', 'metrics']; // 常见错误
    invalidTables.forEach(table => {
      if (sqlLower.includes(`from ${table}`) || sqlLower.includes(`join ${table}`)) {
        result.isValid = false;
        result.errors.push(`表 '${table}' 不存在于Perfetto schema中`);
        result.suggestions.push(`可能需要使用 'slice' 或其他有效表: ${validTables.join(', ')}`);
      }
    });

    // 4. 检查时间单位转换
    if (sqlLower.includes('ts') && !sqlLower.includes('/ 1e')) {
      result.warnings.push('时间戳(ts)的单位是纳秒，建议转换单位');
      result.suggestions.push('使用 ts / 1e9 转换为秒，或 ts / 1e6 转换为毫秒');
    }

    if (sqlLower.includes('dur') && !sqlLower.includes('/ 1e')) {
      result.warnings.push('持续时间(dur)的单位是纳秒，建议转换单位');
      result.suggestions.push('使用 dur / 1e6 转换为毫秒，或 dur / 1e9 转换为秒');
    }

    // 5. 检查JOIN语法
    if (sqlLower.includes('join slice') && !sqlLower.includes('thread_track')) {
      result.warnings.push('直接JOIN slice可能缺少中间表');
      result.suggestions.push('slice通常需要通过thread_track -> thread -> process来JOIN');
    }

    // 6. 检查常见字段错误
    if (sqlLower.includes('cpu') && sqlLower.includes('from counter')) {
      result.errors.push('counter表没有cpu字段');
      result.suggestions.push('CPU信息在sched表中，或从counter_track.name中提取');
      result.isValid = false;
    }

    return result;
  }

  /**
   * 尝试修正SQL错误
   */
  suggestFix(sql: string, error: string): string | null {
    // 简单的错误修正规则
    let fixed = sql;

    // 修正常见表名错误
    fixed = fixed.replace(/FROM\s+app_launch/gi, 'FROM slice');
    fixed = fixed.replace(/JOIN\s+app_launch/gi, 'JOIN slice');

    // 添加时间单位转换
    if (error.includes('时间戳') || error.includes('timestamp')) {
      fixed = fixed.replace(/SELECT\s+ts\s/gi, 'SELECT ts / 1e9 AS timestamp_s ');
      fixed = fixed.replace(/SELECT\s+dur\s/gi, 'SELECT dur / 1e6 AS duration_ms ');
    }

    return fixed !== sql ? fixed : null;
  }
}

export default SQLTemplateEngine;