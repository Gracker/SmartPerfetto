import { PerfettoLocalService } from './perfettoLocalService';

// Create singleton instance
const traceProcessorService = new PerfettoLocalService();

interface SceneEvent {
  type: 'app_launch' | 'activity_start' | 'screen_transition' | 'scroll' | 'click' | 'animation' | 'jank' | 'anr' | 'gc' | 'network_request' | 'file_io';
  timestamp: number;
  duration?: number;
  details: any;
  confidence: number;
  name?: string;
}

interface UserScene {
  id: string;
  type: 'app_usage' | 'game_play' | 'web_browsing' | 'video_playback' | 'photo_editing' | 'document_editing' | 'idle';
  startTime: number;
  endTime: number;
  appName?: string;
  packageName?: string;
  activities: string[];
  events: SceneEvent[];
  issues: SceneEvent[];
  summary: string;
  insights: string[];
  recommendations: string[];
}

interface Pattern {
  name: string;
  description: string;
  sql: string;
  severity: 'info' | 'warning' | 'error';
  category: 'performance' | 'usability' | 'stability' | 'battery';
}

class AutoAnalysisService {
  private patterns: Pattern[] = [
    {
      name: '应用启动时间过长',
      description: '应用冷启动或热启动时间超过预期',
      sql: `
        SELECT
          process.name as app_name,
          MIN(slice.ts) as launch_start,
          MAX(slice.ts + slice.dur) as launch_end,
          (MAX(slice.ts + slice.dur) - MIN(slice.ts)) / 1e6 as launch_duration_ms
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        JOIN process ON thread.upid = process.upid
        WHERE slice.name LIKE '%launch%' OR slice.name LIKE '%startActivity%'
        GROUP BY process.name
        HAVING launch_duration_ms > 1000
        ORDER BY launch_duration_ms DESC
      `,
      severity: 'warning',
      category: 'performance'
    },
    {
      name: '主线程卡顿',
      description: '主线程执行耗时操作导致 UI 卡顿',
      sql: `
        SELECT
          slice.name,
          slice.ts,
          slice.dur / 1e6 as duration_ms,
          thread.name as thread_name,
          process.name as process_name
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        JOIN process ON thread.upid = process.upid
        WHERE thread.name = 'main'
          AND slice.dur > 16666666  -- > 16.67ms (60fps)
          AND slice.dur < 500000000  -- < 500ms
        ORDER BY slice.dur DESC
        LIMIT 50
      `,
      severity: 'error',
      category: 'performance'
    },
    {
      name: 'ANR 检测',
      description: '应用无响应事件',
      sql: `
        SELECT
          slice.name,
          slice.ts,
          slice.dur / 1e6 as duration_ms,
          thread.name as thread_name,
          process.name as process_name,
          EXTRACT_ARG(arg_set.arg_set_id, 'package') AS package_name,
          EXTRACT_ARG(arg_set.arg_set_id, 'activity') AS activity
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        JOIN process ON thread.upid = process.upid
        WHERE slice.name = 'ANR'
        ORDER BY slice.dur DESC
      `,
      severity: 'error',
      category: 'stability'
    },
    {
      name: '内存分配压力',
      description: '频繁的内存分配可能导致 GC 卡顿',
      sql: `
        SELECT
          COUNT(*) as alloc_count,
          SUM(dur) / 1e6 as total_duration_ms,
          thread.name
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        WHERE slice.name LIKE 'malloc%' OR slice.name LIKE 'new%'
        GROUP BY thread.name
        HAVING alloc_count > 100
        ORDER BY alloc_count DESC
      `,
      severity: 'warning',
      category: 'performance'
    },
    {
      name: '过度渲染',
      description: '界面绘制和布局操作过于频繁',
      sql: `
        SELECT
          slice.name,
          COUNT(*) as count,
          AVG(dur) / 1e6 as avg_duration_ms,
          thread.name as thread_name
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        WHERE slice.name LIKE '%draw%'
          OR slice.name LIKE '%layout%'
          OR slice.name LIKE '%measure%'
          OR slice.name LIKE '%Choreographer%'
        GROUP BY slice.name, thread.name
        HAVING count > 60  -- 超过 60次可能是过度渲染
        ORDER BY count DESC
      `,
      severity: 'warning',
      category: 'performance'
    },
    {
      name: '网络请求延迟',
      description: '网络请求耗时过长',
      sql: `
        SELECT
          slice.name,
          slice.ts,
          slice.dur / 1e6 as duration_ms,
          EXTRACT_ARG(arg_set.arg_set_id, 'url') AS url,
          thread.name as thread_name
        FROM slice
        JOIN thread ON slice.utid = thread.utid
        WHERE slice.name LIKE '%http%' OR slice.name LIKE '%network%'
          AND slice.dur > 1000000000  -- > 1 second
        ORDER BY slice.dur DESC
        LIMIT 20
      `,
      severity: 'warning',
      category: 'performance'
    }
  ];

  constructor() {
    // 初始化时可以加载自定义模式
  }

  /**
   * 返回可用的分析模式
   */
  getPatterns(): Pattern[] {
    return this.patterns.map((pattern) => ({ ...pattern }));
  }

  /**
   * 增强分析结果（可选 AI）
   */
  async enhanceAnalysis(
    analysis: UserScene,
    query?: string,
    aiService?: { chat: (prompt: string, options?: { systemPrompt?: string }) => Promise<string> }
  ): Promise<any> {
    const issueTypes = (analysis.issues || []).reduce<Record<string, number>>((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {});

    const enhancementSummary = {
      eventCount: analysis.events?.length || 0,
      issueCount: analysis.issues?.length || 0,
      issueTypes,
      timeRangeNs: analysis.endTime - analysis.startTime,
    };

    let aiSummary = '';
    if (aiService) {
      try {
        const prompt = `请根据以下分析结果生成简明的总结和优化建议。
用户问题: ${query || '未提供'}
应用: ${analysis.appName || analysis.packageName || '未知'}
事件数: ${enhancementSummary.eventCount}
问题数: ${enhancementSummary.issueCount}
问题类型统计: ${JSON.stringify(issueTypes)}
概要: ${analysis.summary}
已有建议: ${analysis.recommendations?.join('；') || '无'}
输出要求: 总结 3-5 句，建议 3-5 条。`;
        aiSummary = await aiService.chat(prompt, {
          systemPrompt: '你是 Android 性能分析专家，请给出可执行的优化建议。',
        });
      } catch (error) {
        console.warn('[AutoAnalysisService] AI enhancement failed:', error);
      }
    }

    return {
      ...analysis,
      enhancement: enhancementSummary,
      aiSummary: aiSummary || undefined,
    };
  }

  /**
   * 分析 Trace 并还原用户场景
   */
  async analyzeTrace(traceFile: string): Promise<UserScene> {
    try {
      // 为了演示，这里返回预设的分析结果
      // 在实际生产环境中，这里会启动 trace processor 并执行真实的分析

      const mockEvents: SceneEvent[] = [
        {
          type: 'app_launch',
          timestamp: Date.now() * 1000 - 10000000000,
          duration: 1500000000,
          details: { appName: 'com.example.app', type: 'cold' },
          confidence: 0.95
        },
        {
          type: 'activity_start',
          timestamp: Date.now() * 1000 - 9000000000,
          duration: 50000000,
          details: { activity: 'MainActivity', theme: 'light' },
          confidence: 0.98
        },
        {
          type: 'scroll',
          timestamp: Date.now() * 1000 - 7000000000,
          duration: 100000000,
          details: { direction: 'vertical', distance: 500 },
          confidence: 0.85
        },
        {
          type: 'scroll',
          timestamp: Date.now() * 1000 - 6000000000,
          duration: 150000000,
          details: { direction: 'vertical', distance: 800 },
          confidence: 0.88
        },
        {
          type: 'click',
          timestamp: Date.now() * 1000 - 5000000000,
          duration: 5000000,
          details: { x: 100, y: 200, view: 'RecyclerView' },
          confidence: 0.9
        },
        {
          type: 'click',
          timestamp: Date.now() * 1000 - 4000000000,
          duration: 3000000,
          details: { x: 150, y: 350, view: 'Button' },
          confidence: 0.92
        }
      ];

      const mockIssues: SceneEvent[] = [
        {
          type: 'jank',
          timestamp: Date.now() * 1000 - 8000000000,
          duration: 16666666,
          details: { frameMissed: 1, reason: 'main_thread_blocked', pattern: '主线程卡顿' },
          confidence: 0.92
        },
        {
          type: 'jank',
          timestamp: Date.now() * 1000 - 5500000000,
          duration: 33333333,
          details: { frameMissed: 2, reason: 'expensive_animation', pattern: '主线程卡顿' },
          confidence: 0.88
        },
        {
          type: 'gc',
          timestamp: Date.now() * 1000 - 3000000000,
          duration: 50000000,
          details: { type: 'major_gc', freed: '10MB', pattern: '内存分配压力' },
          confidence: 0.85
        }
      ];

      const mockInsights = [
        '检测到 2 次卡顿事件，主要发生在滚动和界面切换时',
        '用户进行了 2 次滚动操作，可能是浏览长列表内容',
        '应用启动耗时 1.5 秒，属于正常范围',
        '检测到内存回收事件，建议优化内存使用'
      ];

      const mockRecommendations = [
        '优化列表项布局，减少过度绘制',
        '考虑使用 ViewHolder 模式优化列表性能',
        '避免在主线程执行耗时操作，使用异步处理',
        '优化图片加载和缓存策略',
        '考虑使用分页加载减少内存压力'
      ];

      return {
        id: `scene_${Date.now()}`,
        type: 'app_usage',
        startTime: Date.now() * 1000 - 10000000000,
        endTime: Date.now() * 1000,
        appName: 'com.example.app',
        packageName: 'com.example.app',
        activities: ['MainActivity'],
        events: mockEvents,
        issues: mockIssues,
        summary: '在 10 秒的录制中，用户主要使用 com.example.app，遇到了 3 个性能问题。主要操作包括：应用启动、界面切换、滚动、点击等。',
        insights: mockInsights,
        recommendations: mockRecommendations
      };
    } catch (error) {
      console.error('Failed to analyze trace:', error);
      throw error;
    }
  }

  private async getTraceStats(port: number) {
    try {
      const perfettoService = traceProcessorService;

      // 获取时间范围
      const timeRangeQuery = `
        SELECT
          MIN(ts) as start_ts,
          MAX(ts + dur) as end_ts
        FROM slice
        WHERE ts IS NOT NULL
      `;

      const legacyQuery = (perfettoService as unknown as {
        query?: (sql: string, port: number) => Promise<any[]>;
      }).query;
      const timeRangeResult = typeof legacyQuery === 'function'
        ? await legacyQuery.call(perfettoService, timeRangeQuery, port)
        : [];

      let start = 0;
      let end = Date.now() * 1e6;

      if (timeRangeResult && timeRangeResult.length > 0) {
        start = timeRangeResult[0].start_ts || 0;
        end = timeRangeResult[0].end_ts || Date.now() * 1e6;
      }

      // 获取总览统计
      const statsQuery = `
        SELECT
          COUNT(DISTINCT slice.utid) as unique_threads,
          COUNT(DISTINCT thread.upid) as unique_processes,
          COUNT(*) as total_slices
        FROM slice
        LEFT JOIN thread ON slice.utid = thread.utid
      `;

      const statsResult = typeof legacyQuery === 'function'
        ? await legacyQuery.call(perfettoService, statsQuery, port)
        : [];

      return {
        timeRange: {
          start,
          end
        },
        totalSlices: statsResult?.[0]?.total_slices || 0,
        totalThreads: statsResult?.[0]?.unique_threads || 0,
        totalProcesses: statsResult?.[0]?.unique_processes || 0
      };
    } catch (error) {
      console.error('Error getting trace stats:', error);
      // 返回默认值
      return {
        timeRange: {
          start: 0,
          end: Date.now() * 1e6
        },
        totalSlices: 0,
        totalThreads: 0,
        totalProcesses: 0
      };
    }
  }

  private async detectEvents(startTime: number, endTime: number): Promise<SceneEvent[]> {
    const events: SceneEvent[] = [];

    // 检测应用启动
    const launchQuery = `
      SELECT slice.name, slice.ts, slice.dur, process.name as process_name
      FROM slice
      JOIN thread ON slice.utid = thread.utid
      JOIN process ON thread.upid = process.upid
      WHERE slice.ts BETWEEN ${startTime} AND ${endTime}
        AND (slice.name LIKE '%launch%' OR slice.name LIKE '%startActivity%')
    `;

    // 这里应该实际执行查询，但为了演示，我们添加一些模拟事件
    events.push(
      {
        type: 'app_launch',
        timestamp: startTime + 1000000,
        duration: 1500000000,
        details: { appName: 'com.example.app', type: 'cold' },
        confidence: 0.9
      },
      {
        type: 'activity_start',
        timestamp: startTime + 2000000,
        duration: 50000000,
        details: { activity: 'MainActivity', theme: 'light' },
        confidence: 0.95
      },
      {
        type: 'scroll',
        timestamp: startTime + 5000000,
        duration: 100000000,
        details: { direction: 'vertical', distance: 500 },
        confidence: 0.8
      },
      {
        type: 'click',
        timestamp: startTime + 6000000,
        duration: 5000000,
        details: { x: 100, y: 200, view: 'RecyclerView' },
        confidence: 0.85
      }
    );

    // 检测性能问题
    const jankEvents = await this.detectJank(startTime, endTime);
    events.push(...jankEvents);

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async detectJank(startTime: number, endTime: number): Promise<SceneEvent[]> {
    // 这里应该查询实际的 jank 事件
    return [
      {
        type: 'jank',
        timestamp: startTime + 3000000,
        duration: 16666666,
        details: { frameMissed: 1, reason: 'main_thread_blocked' },
        confidence: 0.9
      },
      {
        type: 'jank',
        timestamp: startTime + 7000000,
        duration: 33333333,
        details: { frameMissed: 2, reason: 'expensive_animation' },
        confidence: 0.85
      }
    ];
  }

  private async analyzeApps(startTime: number, endTime: number): Promise<any[]> {
    // 分析哪些应用在运行
    const sql = `
      SELECT DISTINCT
        process.name,
        process.upid,
        COUNT(*) as slice_count,
        MIN(slice.ts) as first_seen,
        MAX(slice.ts + slice.dur) as last_seen
      FROM slice
      JOIN thread ON slice.utid = thread.utid
      JOIN process ON thread.upid = process.upid
      WHERE slice.ts BETWEEN ${startTime} AND ${endTime}
        AND process.name IS NOT NULL
      GROUP BY process.upid
      ORDER BY slice_count DESC
    `;

    // 返回模拟数据
    return [
      {
        name: 'com.example.app',
        upid: 1,
        sliceCount: 1500,
        firstSeen: startTime,
        lastSeen: endTime
      }
    ];
  }

  private async identifyScene(events: SceneEvent[], apps: any[]): Promise<any> {
    // 根据事件特征识别场景类型
    const hasLaunchEvent = events.some(e => e.type === 'app_launch');
    const hasScrollEvents = events.some(e => e.type === 'scroll');
    const hasClickEvents = events.some(e => e.type === 'click');
    const hasVideoEvents = events.some(e => e.name?.includes('video') || e.name?.includes('player'));
    const hasGameEvents = events.some(e => e.name?.includes('game') || e.name?.includes('opengl'));

    let sceneType: UserScene['type'] = 'app_usage';
    if (hasGameEvents) {
      sceneType = 'game_play';
    } else if (hasVideoEvents) {
      sceneType = 'video_playback';
    } else if (hasScrollEvents && hasClickEvents) {
      sceneType = 'web_browsing';
    } else if (events.length < 10) {
      sceneType = 'idle';
    }

    return {
      type: sceneType,
      appName: apps[0]?.name || 'Unknown',
      packageName: apps[0]?.name || 'Unknown',
      activities: ['MainActivity']
    };
  }

  private async detectIssues(startTime: number, endTime: number): Promise<SceneEvent[]> {
    const issues: SceneEvent[] = [];

    // 运行所有检测模式
    for (const pattern of this.patterns) {
      try {
        // 这里应该实际执行 SQL 查询
        // const result = await traceProcessorService.query(pattern.sql);

        // 基于模式类型创建问题事件
        if (pattern.category === 'stability') {
          issues.push({
            type: 'anr',
            timestamp: startTime + Math.random() * (endTime - startTime),
            details: { pattern: pattern.name },
            confidence: 0.7
          });
        } else if (pattern.severity === 'error') {
          issues.push({
            type: 'jank',
            timestamp: startTime + Math.random() * (endTime - startTime),
            duration: 16666666,
            details: { pattern: pattern.name },
            confidence: 0.8
          });
        }
      } catch (error) {
        console.error(`Failed to run pattern ${pattern.name}:`, error);
      }
    }

    return issues;
  }

  private generateInsights(events: SceneEvent[], issues: SceneEvent[]): string[] {
    const insights: string[] = [];

    // 分析事件模式
    const scrollCount = events.filter(e => e.type === 'scroll').length;
    const clickCount = events.filter(e => e.type === 'click').length;
    const jankCount = issues.filter(e => e.type === 'jank').length;

    if (jankCount > 0) {
      insights.push(`检测到 ${jankCount} 次卡顿事件，影响了用户体验`);
    }

    if (scrollCount > 20) {
      insights.push(`用户进行了 ${scrollCount} 次滚动操作，可能是浏览长列表`);
    }

    if (clickCount > 30) {
      insights.push(`用户进行了 ${clickCount} 次点击，交互较为频繁`);
    }

    if (events.length < 10) {
      insights.push('应用大部分时间处于空闲状态');
    }

    return insights;
  }

  private generateRecommendations(issues: SceneEvent[]): string[] {
    const recommendations: string[] = [];

    const hasJank = issues.some(e => e.type === 'jank');
    const hasANR = issues.some(e => e.type === 'anr');

    if (hasJank) {
      recommendations.push('优化主线程任务，避免在主线程执行耗时操作');
      recommendations.push('考虑使用异步加载和后台处理');
      recommendations.push('优化动画性能，减少过度绘制');
    }

    if (hasANR) {
      recommendations.push('检查是否有死锁或长时间阻塞操作');
      recommendations.push('优化启动流程，减少启动时间');
      recommendations.push('添加适当的超时处理和用户反馈');
    }

    if (issues.length === 0) {
      recommendations.push('性能表现良好，继续保持');
    }

    return recommendations;
  }

  private generateSummary(scene: any, events: SceneEvent[], issues: SceneEvent[]): string {
    const duration = (scene.endTime - scene.startTime) / 1e9;
    const formatDuration = duration < 60 ? `${Math.round(duration)}秒` : `${Math.round(duration / 60)}分钟`;

    let summary = `在 ${formatDuration} 的录制中，用户主要使用 ${scene.appName}`;

    if (issues.length > 0) {
      summary += `，遇到了 ${issues.length} 个性能问题`;
    }

    summary += `。主要操作包括：${events.slice(0, 3).map(e => this.getEventDescription(e)).join('、')}等。`;

    return summary;
  }

  private getEventDescription(event: SceneEvent): string {
    const descriptions: Record<string, string> = {
      'app_launch': '应用启动',
      'activity_start': '界面切换',
      'screen_transition': '界面切换',
      'scroll': '滚动',
      'click': '点击',
      'animation': '动画',
      'jank': '卡顿',
      'anr': '无响应',
      'gc': '垃圾回收',
      'network_request': '网络请求',
      'file_io': '文件操作'
    };

    return descriptions[event.type] || event.type;
  }

  /**
   * 生成详细的分析报告
   */
  async generateReport(analysis: UserScene): Promise<{
    summary: any;
    patterns: any[];
    recommendations: any[];
  }> {
    const report = {
      summary: {
        sceneType: analysis.type,
        appName: analysis.appName,
        duration: (analysis.endTime - analysis.startTime) / 1e9,
        totalEvents: analysis.events.length,
        issueCount: analysis.issues.length,
        activities: analysis.activities
      },
      patterns: this.patterns,
      recommendations: analysis.recommendations.map(rec => ({
        title: rec,
        priority: 'high',
        category: 'optimization'
      }))
    };

    return report;
  }
}

export default AutoAnalysisService;
