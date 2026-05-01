// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * claudeSystemPrompt unit tests
 *
 * Tests system prompt building:
 * - Section assembly from template files
 * - Token budget enforcement (progressive section dropping)
 * - Architecture-specific guidance injection
 * - Selection context formatting
 * - Conversation context (notes, findings, entities)
 * - Previous plan injection
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { ClaudeAnalysisContext } from '../types';

// Mock strategyLoader — return minimal templates
jest.mock('../strategyLoader', () => ({
  getStrategyContent: jest.fn((scene: string) => {
    if (scene === 'scrolling') return '滑动分析：检查 frame_timeline 表，关注掉帧根因';
    if (scene === 'startup') return '启动分析：检查 android.startup.startups 表';
    return '通用分析指引';
  }),
  loadPromptTemplate: jest.fn((name: string) => {
    if (name === 'prompt-role') return '# 角色\n\n你是 SmartPerfetto Android 性能分析专家。';
    if (name === 'prompt-language-zh') return '## 输出语言\n\n所有面向用户的回答必须使用简体中文。';
    if (name === 'prompt-language-en') return '## Output Language\n\nAll user-facing answers MUST be written in English.';
    if (name === 'prompt-quick') return '# 角色\n\n你是 Android 性能 trace 分析专家。\n\n{{outputLanguageSection}}\n\n{{architectureContext}}\n\n{{focusAppContext}}\n\n{{selectionSection}}';
    if (name === 'prompt-methodology') return '## 分析方法论\n\n{{sceneStrategy}}';
    if (name === 'prompt-output-format') return '## 输出格式\n\n使用 Markdown 格式输出。';
    if (name.startsWith('arch-')) return `### ${name} 架构分析指导\n\n专项指导内容`;
    return null;
  }),
  loadSelectionTemplate: jest.fn((kind: string) => {
    if (kind === 'area') return '## 用户选区\n\n时间范围: {{startNs}} - {{endNs}} ({{durationMs}}ms)\nTrack 数: {{trackCount}}{{trackSummary}}';
    if (kind === 'slice') return '## 用户选区\n\n选中 Slice: eventId={{eventId}}, ts={{ts}}, dur={{durationStr}}';
    return null;
  }),
  renderTemplate: jest.fn((template: string, vars: Record<string, any>) => {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''));
    }
    return result;
  }),
}));

jest.mock('../focusAppDetector', () => ({
  formatDurationNs: jest.fn((ns: number) => `${(ns / 1e6).toFixed(1)}ms`),
}));

import { buildQuickSystemPrompt, buildSystemPrompt, buildSystemPromptParts } from '../claudeSystemPrompt';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ClaudeAnalysisContext> = {}): ClaudeAnalysisContext {
  return {
    query: '分析滑动卡顿',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  describe('basic structure', () => {
    it('should include role section', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).toContain('角色');
      expect(prompt).toContain('SmartPerfetto');
    });

    it('should include methodology section', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).toContain('分析方法论');
    });

    it('should include output format section', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).toContain('输出格式');
    });

    it('should default to Simplified Chinese output language guidance', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).toContain('## 输出语言');
      expect(prompt).toContain('简体中文');
    });

    it('should inject English output language guidance when requested', () => {
      const prompt = buildSystemPrompt(makeContext({ outputLanguage: 'en' }));
      expect(prompt).toContain('## Output Language');
      expect(prompt).toContain('MUST be written in English');
      expect(prompt).not.toContain('所有面向用户的回答必须使用简体中文');
    });

    it('should inject output language guidance into quick prompts', () => {
      const prompt = buildQuickSystemPrompt({ outputLanguage: 'en' });
      expect(prompt).toContain('## Output Language');
      expect(prompt).toContain('MUST be written in English');
    });
  });

  describe('architecture context', () => {
    it('should inject architecture info', () => {
      const prompt = buildSystemPrompt(makeContext({
        architecture: { type: 'STANDARD', confidence: 0.95, evidence: [] },
        packageName: 'com.example.app',
      }));
      expect(prompt).toContain('STANDARD');
      expect(prompt).toContain('95%');
      expect(prompt).toContain('com.example.app');
    });

    it('should inject Flutter-specific details', () => {
      const prompt = buildSystemPrompt(makeContext({
        architecture: {
          type: 'FLUTTER',
          confidence: 0.9,
          evidence: [],
          flutter: { engine: 'IMPELLER', surfaceType: 'SURFACEVIEW', versionHint: '3.x', newThreadModel: true },
        },
      }));
      expect(prompt).toContain('Flutter');
      expect(prompt).toContain('IMPELLER');
      expect(prompt).toContain('新线程模型');
    });

    it('should inject arch-specific guidance from template', () => {
      const prompt = buildSystemPrompt(makeContext({
        architecture: { type: 'FLUTTER', confidence: 0.8, evidence: [] },
      }));
      expect(prompt).toContain('arch-flutter 架构分析指导');
    });

    it('should suggest detect_architecture when architecture not yet detected', () => {
      const prompt = buildSystemPrompt(makeContext({
        packageName: 'com.example.app',
      }));
      expect(prompt).toContain('detect_architecture');
    });
  });

  describe('scene strategy injection', () => {
    it('should inject scrolling strategy for scrolling scene', () => {
      const prompt = buildSystemPrompt(makeContext({ sceneType: 'scrolling' }));
      expect(prompt).toContain('frame_timeline');
      expect(prompt).toContain('掉帧根因');
    });

    it('should inject startup strategy for startup scene', () => {
      const prompt = buildSystemPrompt(makeContext({ sceneType: 'startup' }));
      expect(prompt).toContain('android.startup.startups');
    });

    it('should use general strategy for general scene', () => {
      const prompt = buildSystemPrompt(makeContext({ sceneType: 'general' }));
      expect(prompt).toContain('通用分析指引');
    });
  });

  describe('focus app context', () => {
    it('should list focus apps with primary marker', () => {
      const prompt = buildSystemPrompt(makeContext({
        focusApps: [
          { packageName: 'com.example.app', totalDurationNs: 5000000000, switchCount: 3 },
          { packageName: 'com.other.app', totalDurationNs: 1000000000, switchCount: 1 },
        ],
      }));
      expect(prompt).toContain('com.example.app');
      expect(prompt).toContain('主焦点');
      expect(prompt).toContain('com.other.app');
    });
  });

  describe('selection context', () => {
    it('should format area selection', () => {
      const prompt = buildSystemPrompt(makeContext({
        selectionContext: {
          kind: 'area',
          startNs: 1000000000,
          endNs: 2000000000,
          durationNs: 1000000000,
          trackCount: 5,
        },
      }));
      expect(prompt).toContain('用户选区');
      expect(prompt).toContain('1000000000');
      expect(prompt).toContain('1000.00'); // durationMs
    });

    it('should format track_event selection', () => {
      const prompt = buildSystemPrompt(makeContext({
        selectionContext: {
          kind: 'track_event',
          eventId: 42,
          ts: 1500000000,
          dur: 16000000,
        },
      }));
      expect(prompt).toContain('Slice');
      expect(prompt).toContain('42');
    });
  });

  describe('conversation context', () => {
    it('should inject analysis notes (limited to 10, priority sorted)', () => {
      const notes = Array.from({ length: 15 }, (_, i) => ({
        section: 'finding' as const,
        content: `Note ${i}`,
        priority: i < 3 ? 'high' as const : 'low' as const,
        timestamp: Date.now(),
      }));
      const prompt = buildSystemPrompt(makeContext({ analysisNotes: notes }));
      expect(prompt).toContain('分析笔记');
      expect(prompt).toContain('显示 10/15'); // P1-3: shows count
      // High priority notes should be first
      expect(prompt).toContain('Note 0');
    });

    it('should inject previous findings', () => {
      const prompt = buildSystemPrompt(makeContext({
        previousFindings: [{
          id: 'f1',
          title: 'RenderThread blocked',
          description: 'Binder call caused 50ms delay',
          severity: 'critical',
        }],
      }));
      expect(prompt).toContain('之前的分析发现');
      expect(prompt).toContain('RenderThread blocked');
    });

    it('should inject entity context', () => {
      const prompt = buildSystemPrompt(makeContext({
        entityContext: '已分析帧: frame_42, frame_43',
      }));
      expect(prompt).toContain('已知实体');
      expect(prompt).toContain('frame_42');
    });

    it('should inject conversation summary', () => {
      const prompt = buildSystemPrompt(makeContext({
        conversationSummary: '上一轮分析了帧渲染性能',
      }));
      expect(prompt).toContain('对话摘要');
    });

    it('should not inject conversation section when no context', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).not.toContain('对话上下文');
    });
  });

  describe('previous plan injection', () => {
    it('should inject previous plan with phase status', () => {
      const prompt = buildSystemPrompt(makeContext({
        previousPlan: {
          phases: [
            { id: 'p1', name: 'Data Collection', goal: 'G', expectedTools: [], status: 'completed', summary: 'Got frames' },
            { id: 'p2', name: 'Root Cause', goal: 'G', expectedTools: [], status: 'skipped' },
          ],
          successCriteria: 'Find root cause',
          submittedAt: Date.now(),
          toolCallLog: [],
        },
      }));
      expect(prompt).toContain('上一轮分析计划');
      expect(prompt).toContain('✓'); // completed marker
      expect(prompt).toContain('⊘'); // skipped marker
      expect(prompt).toContain('Find root cause');
    });
  });

  describe('sub-agent guidance', () => {
    it('should inject sub-agent section when agents available', () => {
      const prompt = buildSystemPrompt(makeContext({
        availableAgents: ['system-expert', 'frame-expert'],
      }));
      expect(prompt).toContain('子代理协作');
      expect(prompt).toContain('system-expert');
      expect(prompt).toContain('frame-expert');
    });

    it('should inject scrolling parallel guidance when scrolling + system-expert', () => {
      const prompt = buildSystemPrompt(makeContext({
        sceneType: 'scrolling',
        availableAgents: ['system-expert'],
      }));
      expect(prompt).toContain('并行证据收集');
    });

    it('should not inject sub-agent section when no agents', () => {
      const prompt = buildSystemPrompt(makeContext());
      expect(prompt).not.toContain('子代理协作');
    });
  });

  describe('droppable sections', () => {
    it('should inject knowledge base context', () => {
      const prompt = buildSystemPrompt(makeContext({
        knowledgeBaseContext: 'SELECT * FROM android_frames...',
      }));
      expect(prompt).toContain('Perfetto SQL 知识库参考');
    });

    it('should inject SQL error fix pairs', () => {
      const prompt = buildSystemPrompt(makeContext({
        sqlErrorFixPairs: [{
          errorSql: 'SELECT * FROM bad_table',
          errorMessage: 'no such table: bad_table',
          fixedSql: 'SELECT * FROM good_table',
        }],
      }));
      expect(prompt).toContain('SQL 踩坑记录');
      expect(prompt).toContain('bad_table');
    });

    it('should cap SQL error fix pairs at 10 entries', () => {
      const pairs = Array.from({ length: 15 }, (_, i) => ({
        errorSql: `SELECT * FROM bad_${i}`,
        errorMessage: `no such table: bad_${i}`,
        fixedSql: `SELECT * FROM good_${i}`,
      }));
      const prompt = buildSystemPrompt(makeContext({ sqlErrorFixPairs: pairs }));
      // First 10 entries injected
      expect(prompt).toContain('bad_0');
      expect(prompt).toContain('bad_9');
      // 11th onwards must NOT appear (cap is exclusive of index 10)
      expect(prompt).not.toContain('bad_10');
      expect(prompt).not.toContain('bad_14');
    });

    it('should inject pattern context', () => {
      const prompt = buildSystemPrompt(makeContext({
        patternContext: '## 历史分析经验（跨会话记忆）\n\n有用的经验',
      }));
      expect(prompt).toContain('历史分析经验');
    });

    it('should inject negative pattern context', () => {
      const prompt = buildSystemPrompt(makeContext({
        negativePatternContext: '## 历史踩坑记录（避免重复失败）\n\n避免做某事',
      }));
      expect(prompt).toContain('历史踩坑记录');
    });
  });

  /**
   * Phase 1.4 of v2.1 — protect the implicit prompt cache.
   *
   * The Claude Agent SDK does not expose `cache_control` (see
   * `docs/archive/context-engineering/sdk-capability-spike-2026-04-28.md`), so the only lever we have
   * over caching is making sure the prompt bytes themselves are stable
   * across turns. These tests catch silent regressions where a timestamp,
   * Date.now() call, or non-determinism quietly leaks into the prompt.
   */
  describe('cache stability', () => {
    it('produces byte-identical output for the same context (deterministic)', () => {
      const ctx = makeContext({
        sceneType: 'scrolling',
        architecture: { type: 'Standard', confidence: 0.9 } as any,
        packageName: 'com.example',
      });
      const a = buildSystemPrompt(ctx);
      const b = buildSystemPrompt(ctx);
      expect(a).toBe(b);
    });

    it('keeps the leading section byte-stable when only the volatile (selection) context changes', () => {
      const base = makeContext({
        sceneType: 'scrolling',
        architecture: { type: 'Standard', confidence: 0.9 } as any,
        packageName: 'com.example',
      });
      const withoutSelection = buildSystemPrompt(base);
      const withSelection = buildSystemPrompt({
        ...base,
        selectionContext: { kind: 'area', startNs: 100, endNs: 200 } as any,
      });
      // Find a stable anchor in the leading sections (architecture description
      // is in Tier 2 and must precede any user selection block in Tier 4).
      const anchor = '## 当前 Trace 架构';
      const idxA = withoutSelection.indexOf(anchor);
      const idxB = withSelection.indexOf(anchor);
      expect(idxA).toBeGreaterThan(-1);
      expect(idxB).toBe(idxA);
      // The shared prefix up to and including the architecture section header
      // is byte-equal — selection context is appended later, not interleaved.
      expect(withSelection.startsWith(withoutSelection.slice(0, idxA + anchor.length))).toBe(true);
    });

    it('changing only previousFindings does not perturb the leading sections', () => {
      const base = makeContext({ sceneType: 'scrolling' });
      const withoutFindings = buildSystemPrompt(base);
      const withFindings = buildSystemPrompt({
        ...base,
        previousFindings: [
          { severity: 'critical', title: 't', description: 'd' } as any,
        ],
      });
      // Both prompts share their byte-identical Tier 1-3 prefix; the
      // conversation context block lives strictly later.
      const anchor = '## 分析方法论';
      const idx = withoutFindings.indexOf(anchor);
      expect(idx).toBeGreaterThan(-1);
      expect(withFindings.startsWith(withoutFindings.slice(0, idx + anchor.length))).toBe(true);
    });

    it('does not leak `Date.now()` style timestamps into the prompt', () => {
      const prompt = buildSystemPrompt(makeContext({ sceneType: 'scrolling' }));
      // Catch obvious epoch-millis leakage: any 13-digit run of digits is suspicious.
      // Section markers + tokens never carry such patterns; if any do, the test
      // fails and the offender must justify itself or move the value into a
      // volatile context object.
      expect(prompt).not.toMatch(/\b1[6-9]\d{11}\b/);
    });
  });

  /**
   * Phase 1.2 of v2.1 — verify the structured-segments API. Cache stability
   * tests above used anchor strings to slice prefix/suffix. The parts API
   * exposes the segmentation directly so future cache_breakpoint logic
   * (when SDK adds support) can route through it.
   */
  describe('buildSystemPromptParts (Phase 1.2 structured API)', () => {
    it('full output is byte-equal to buildSystemPrompt', () => {
      const ctx = makeContext({
        sceneType: 'scrolling',
        architecture: { type: 'Standard', confidence: 0.9 } as any,
        packageName: 'com.example',
      });
      const wrapper = buildSystemPrompt(ctx);
      const parts = buildSystemPromptParts(ctx);
      expect(parts.fullPrompt).toBe(wrapper);
    });

    it('every segment carries a non-empty label and a valid tier', () => {
      const parts = buildSystemPromptParts(makeContext({ sceneType: 'scrolling' }));
      expect(parts.segments.length).toBeGreaterThan(0);
      for (const seg of parts.segments) {
        expect(seg.label.length).toBeGreaterThan(0);
        expect([1, 2, 3, 4]).toContain(seg.tier);
        expect(seg.content.length).toBeGreaterThan(0);
      }
    });

    it('segments are emitted in tier order (1 → 4 monotonic)', () => {
      const parts = buildSystemPromptParts(makeContext({
        sceneType: 'scrolling',
        architecture: { type: 'Standard', confidence: 0.9 } as any,
        selectionContext: { kind: 'area', startNs: 0, endNs: 1 } as any,
        previousFindings: [{ severity: 'critical', title: 't', description: 'd' } as any],
      }));
      let lastTier = 1;
      for (const seg of parts.segments) {
        expect(seg.tier).toBeGreaterThanOrEqual(lastTier);
        lastTier = seg.tier;
      }
    });

    it('stablePrefix excludes Tier 4 sections and volatileSuffix only contains them', () => {
      const parts = buildSystemPromptParts(makeContext({
        sceneType: 'scrolling',
        architecture: { type: 'Standard', confidence: 0.9 } as any,
        selectionContext: { kind: 'area', startNs: 0, endNs: 1 } as any,
      }));
      const tier4Labels = parts.segments.filter(s => s.tier === 4).map(s => s.label);
      expect(tier4Labels).toContain('selection_context');
      // Tier 4 sections must not appear in the stable prefix.
      for (const seg of parts.segments.filter(s => s.tier === 4)) {
        expect(parts.stablePrefix).not.toContain(seg.content);
        expect(parts.volatileSuffix).toContain(seg.content);
      }
    });

    it('always includes a Tier 1 role segment', () => {
      const parts = buildSystemPromptParts(makeContext());
      const role = parts.segments.find(s => s.label === 'role');
      expect(role).toBeDefined();
      expect(role!.tier).toBe(1);
    });

    it('drops a known low-priority label first when the budget is tight', () => {
      const parts = buildSystemPromptParts(makeContext({
        sceneType: 'scrolling',
        knowledgeBaseContext: 'X'.repeat(20_000),
        sqlErrorFixPairs: [{ errorSql: 'a', errorMessage: 'b', fixedSql: 'c' }],
      }), /* maxTokens */ 2_000);
      // knowledge_base is the first label in the drop order, so it must be
      // among the dropped labels when the budget is small.
      expect(parts.droppedLabels).toContain('knowledge_base');
    });

    it('returns a non-empty droppedLabels array only when over budget', () => {
      const parts = buildSystemPromptParts(makeContext({ sceneType: 'scrolling' }));
      // Default fixture is comfortably under MAX_PROMPT_TOKENS (4500), so
      // nothing should be dropped.
      expect(parts.droppedLabels).toEqual([]);
    });
  });
});
