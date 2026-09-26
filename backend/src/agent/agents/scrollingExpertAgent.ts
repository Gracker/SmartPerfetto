// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { BaseExpertAgent, LLMClient } from './baseExpertAgent';
import { ExpertAgentConfig, Intent, AnalysisContext } from '../types';

const SCROLLING_EXPERT_CONFIG: ExpertAgentConfig = {
  name: 'ScrollingExpert',
  domain: 'scrolling_performance',
  description: 'Analyzes scrolling performance, frame drops, jank causes, and rendering issues',
  tools: ['execute_sql', 'calculate_stats'],
  maxIterations: 3, // Reduced from 10 - initial queries should provide most info
  confidenceThreshold: 0.7, // Lower threshold to conclude faster
};

const JANK_KNOWLEDGE = {
  causes: [
    { pattern: 'q3_pct > 20', cause: 'CPU scheduling delay', severity: 'warning' },
    { pattern: 'q4_pct > 50', cause: 'Thread blocking/sleeping', severity: 'info' },
    { pattern: 'q1_pct < 30', cause: 'Running on small cores', severity: 'warning' },
    { pattern: 'binder_total_ms > 5', cause: 'Slow Binder calls', severity: 'warning' },
    { pattern: 'main_slice_ms > 16', cause: 'Heavy main thread work', severity: 'critical' },
  ],
  jankTypes: {
    'App Deadline Missed': 'Application did not finish frame rendering in time',
    'Buffer Stuffing': 'GPU/RenderThread backpressure, previous frames not consumed',
    'SurfaceFlinger Deadline Missed': 'System compositor was slow',
    'Prediction Error': 'Frame timing prediction was incorrect',
  },
};

export class ScrollingExpertAgent extends BaseExpertAgent {
  constructor(llm: LLMClient) {
    super(SCROLLING_EXPERT_CONFIG, llm);
  }

  canHandle(intent: Intent): boolean {
    const scrollingKeywords = ['scroll', 'jank', 'frame', 'fps', 'stutter', 'lag', 'smooth', 
                                '滑动', '掉帧', '卡顿', '流畅', '帧率'];
    const aspectMatch = intent.aspects.some(a => 
      scrollingKeywords.some(k => a.toLowerCase().includes(k))
    );
    const goalMatch = scrollingKeywords.some(k => 
      intent.primaryGoal.toLowerCase().includes(k)
    );
    return aspectMatch || goalMatch;
  }

  protected getSystemPrompt(): string {
    return `You are a Scrolling Performance Expert Agent specializing in Android frame rendering analysis.

Your expertise includes:
- Frame timeline analysis using Perfetto's FrameTimeline data
- Understanding jank causes: CPU scheduling, Binder calls, main thread blocking
- Quadrant analysis: Q1(Big Core), Q2(Little Core), Q3(Runnable), Q4(Sleeping)
- Identifying patterns in frame drops and rendering delays

Known jank patterns:
${JANK_KNOWLEDGE.causes.map(c => `- ${c.pattern}: ${c.cause} (${c.severity})`).join('\n')}

Jank type meanings:
${Object.entries(JANK_KNOWLEDGE.jankTypes).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Analysis approach:
1. First, get overall frame statistics to understand severity
2. Identify jank type distribution to understand the pattern
3. Sample 2-3 worst frames for detailed analysis
4. Look for common patterns across sampled frames
5. Generate root cause diagnosis and actionable suggestions

Be efficient: if you see the same pattern in multiple frames, you don't need to analyze more.`;
  }

  protected getAnalysisGoals(context: AnalysisContext): string[] {
    const pkg = context.package || 'target app';
    return [
      `Determine if ${pkg} has scrolling performance issues`,
      'Identify the jank rate and severity',
      'Find the most common jank types',
      'Analyze 2-3 worst frames to understand root causes',
      'Provide specific optimization suggestions',
    ];
  }

  protected getInitialQueries(): string[] {
    return [
      // Query 1: Overall frame statistics
      `SELECT
        COUNT(*) as total_frames,
        SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) as janky_frames,
        ROUND(100.0 * SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) / COUNT(*), 2) as jank_rate_pct,
        ROUND(AVG(dur) / 1e6, 2) as avg_frame_time_ms,
        ROUND(MAX(dur) / 1e6, 2) as max_frame_time_ms
      FROM actual_frame_timeline_slice
      WHERE surface_frame_token IS NOT NULL`,

      // Query 2: Jank type distribution
      `SELECT jank_type, COUNT(*) as count,
        ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM actual_frame_timeline_slice WHERE jank_type != 'None'), 1) as pct
      FROM actual_frame_timeline_slice
      WHERE jank_type != 'None'
      GROUP BY jank_type
      ORDER BY count DESC`,

      // Query 3: Scroll sessions with FPS (key metric)
      `WITH frames_with_gap AS (
        SELECT
          ts,
          dur,
          jank_type,
          ts - LAG(ts + dur) OVER (ORDER BY ts) AS gap_ns
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL AND dur > 0
      ),
      session_boundaries AS (
        SELECT
          ts,
          dur,
          jank_type,
          SUM(CASE WHEN gap_ns IS NULL OR gap_ns > 100000000 THEN 1 ELSE 0 END)
            OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS session_id
        FROM frames_with_gap
      )
      SELECT
        session_id,
        COUNT(*) as frame_count,
        ROUND(1e9 * COUNT(*) / NULLIF(MAX(ts + dur) - MIN(ts), 0), 1) as fps,
        ROUND(100.0 * SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) / COUNT(*), 1) as jank_pct,
        ROUND((MAX(ts + dur) - MIN(ts)) / 1e6, 1) as duration_ms
      FROM session_boundaries
      GROUP BY session_id
      HAVING frame_count >= 10 AND duration_ms > 200
      ORDER BY frame_count DESC
      LIMIT 10`,
    ];
  }
}

export function createScrollingExpertAgent(llm: LLMClient): ScrollingExpertAgent {
  return new ScrollingExpertAgent(llm);
}