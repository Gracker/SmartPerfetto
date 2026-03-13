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

import { buildSystemPrompt } from '../claudeSystemPrompt';

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
          flutter: { engine: 'IMPELLER', versionHint: '3.x', newThreadModel: true },
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
});
