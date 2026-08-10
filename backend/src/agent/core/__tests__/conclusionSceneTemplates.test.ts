// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Finding, Intent } from '../../types';
import {
  buildConclusionScenePromptHints,
  deriveConclusionSceneAspectsFromSkillIds,
  getConclusionSceneTemplateDiagnostics,
  resetConclusionSceneTemplateCacheForTests,
} from '../conclusionSceneTemplates';

function createIntent(partial: Partial<Intent>): Intent {
  return {
    primaryGoal: '分析性能问题',
    aspects: [],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
    ...partial,
  };
}

function createFinding(partial: Partial<Finding>): Finding {
  return {
    id: 'f-1',
    severity: 'warning',
    title: '发现性能风险',
    description: '',
    source: 'test',
    confidence: 0.7,
    ...partial,
  };
}

describe('conclusionSceneTemplates', () => {
  const envKey = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_PATH';
  const baseEnvKey = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_BASE_PATH';
  const overrideEnvKey = 'SMARTPERFETTO_CONCLUSION_SCENE_TEMPLATE_OVERRIDE_PATH';

  beforeEach(() => {
    delete process.env[envKey];
    delete process.env[baseEnvKey];
    delete process.env[overrideEnvKey];
    resetConclusionSceneTemplateCacheForTests();
  });

  afterEach(() => {
    delete process.env[envKey];
    delete process.env[baseEnvKey];
    delete process.env[overrideEnvKey];
    resetConclusionSceneTemplateCacheForTests();
  });

  test('uses startup template when startup aspect is present', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['startup'], primaryGoal: '分析冷启动慢原因' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('startup');
    expect(hints.sceneName).toBe('启动性能');
    expect(hints.requireTopClusters).toBe(false);
    expect(hints.outputRequirementLines.join('\n')).toContain('TTID/TTFD');
  });

  test('uses navigation template from goal keywords', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ primaryGoal: '页面跳转慢，帮我定位瓶颈' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('navigation');
    expect(hints.focusLines.join('\n')).toContain('startActivity');
  });

  test('uses click-response template from findings', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ primaryGoal: '分析交互延迟', aspects: ['interaction'] }),
      findings: [createFinding({ title: '点击响应慢', description: 'input latency 120ms' })],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('click_response');
    expect(hints.focusLines.join('\n')).toContain('Input');
  });

  test('click-response template preserves ACK, focus/window, and present boundaries', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ primaryGoal: '分析点击响应和 InputDispatcher wait queue', aspects: ['interaction'] }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    const requirements = hints.outputRequirementLines.join('\n');
    expect(hints.sceneId).toBe('click_response');
    expect(requirements).toContain('ACK/FINISHED');
    expect(requirements).toContain('dispatch-to-ACK');
    expect(requirements).toContain('stale drop');
    expect(requirements).toContain('focused/target window');
    expect(requirements).toContain('InputChannel');
    expect(requirements).toContain('FrameTimeline');
  });

  test('uses jank template and requires why-slow evidence', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['jank'], primaryGoal: '分析滑动卡顿' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('jank');
    expect(hints.requireTopClusters).toBe(true);
    expect(hints.clusterPolicy.outputMode).toBe('required');
    expect(hints.clusterPolicy.frameListMode).toBe('full');
    expect(hints.clusterPolicy.maxFramesPerCluster).toBe(120);
    expect(hints.outputRequirementLines.join('\n')).toContain('为什么慢');
  });

  test('uses memory template when memory aspect is present', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['memory'], primaryGoal: '分析内存上涨和 GC 抖动' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('memory');
    expect(hints.sceneName).toContain('内存');
    const requirements = hints.outputRequirementLines.join('\n');
    expect(requirements).toContain('Java Heap');
    expect(requirements).toContain('Native Heap');
    expect(requirements).toContain('Graphics/dma-buf');
    expect(requirements).toContain('LMK/freezer');
    expect(requirements).toContain('高内存不等于泄漏');
  });

  test('startup template preserves TTID/TTFD and external-signal boundaries', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['startup'], primaryGoal: '分析启动慢' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    const requirements = hints.outputRequirementLines.join('\n');
    expect(requirements).toContain('TTID');
    expect(requirements).toContain('TTFD');
    expect(requirements).toContain('业务 ready');
    expect(requirements).toContain('Vitals/APM/Score');
  });

  test('network template distinguishes packet evidence from request-stage evidence', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['network'], primaryGoal: '分析网络请求慢，是否 DNS 或 TLS 慢' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    const promptText = [
      ...hints.focusLines,
      ...hints.outputRequirementLines,
      hints.nextStepLine,
    ].join('\n');
    expect(hints.sceneId).toBe('network');
    expect(promptText).toContain('packet-level');
    expect(promptText).toContain('request-stage');
    expect(promptText).toContain('不得直接归因为 DNS/连接/TLS/首包慢');
  });

  test('io template preserves storage, database, and provider evidence boundaries', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['io'], primaryGoal: '分析 SQLite fsync 和 ContentProvider 是否导致卡顿' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    const requirements = hints.outputRequirementLines.join('\n');
    expect(hints.sceneId).toBe('io');
    expect(requirements).toContain('SharedPreferences/QueuedWork');
    expect(requirements).toContain('SQLite/Room');
    expect(requirements).toContain('ConnectionPool/WAL/checkpoint/CursorWindow');
    expect(requirements).toContain('ContentProvider/MediaProvider');
    expect(requirements).toContain('D-state 或 fsync');
    expect(requirements).toContain('不能在缺少 SQLite/Provider/路径/栈证据时升级为数据库根因');
  });

  test('generic template requires evidence type and version boundary', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ primaryGoal: '帮我看一下整体表现', aspects: ['overview'] }),
      findings: [createFinding({ title: '指标波动', description: '无明确场景关键词' })],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('generic');
    expect(hints.outputRequirementLines.join('\n')).toContain('证据类型');
    expect(hints.outputRequirementLines.join('\n')).toContain('Android/API/设备边界');
  });

  test('uses anr template when query contains ANR keywords', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['anr'], primaryGoal: '为什么会 ANR，主线程卡死在哪里？' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('anr');
    const promptText = [
      ...hints.focusLines,
      ...hints.outputRequirementLines,
    ].join('\n');
    expect(promptText).toContain('阻塞');
    expect(promptText).toContain('ANR 类型');
    expect(promptText).toContain('timeout_source');
    expect(promptText).toContain('确认来源或证据缺口');
    expect(promptText).toContain('受害进程和根因进程');
    expect(promptText).toContain('nativePollOnce');
  });

  test('uses executed analysis skills to disambiguate mixed query wording', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({
        primaryGoal: '检查这个启动 Trace 是否包含 ANR',
        aspects: deriveConclusionSceneAspectsFromSkillIds([
          'anr_analysis',
          'anr_analysis',
          'blocking_chain_analysis',
          'anr_detection',
        ]),
      }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('anr');
  });

  test('falls back to generic template when no scene hints are present', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ primaryGoal: '帮我看一下整体表现', aspects: ['overview'] }),
      findings: [createFinding({ title: '指标波动', description: '无明确场景关键词' })],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('generic');
    expect(hints.sceneName).toBe('通用性能');
    expect(hints.requireTopClusters).toBe(false);
  });

  test('loads scene templates from env-configured yaml path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-template-config-'));
    const configPath = path.join(tempDir, 'scene_templates.yaml');

    fs.writeFileSync(configPath, `version: 1
scenes:
  - id: startup
    scene_name: 启动性能（测试配置）
    aspect_hints: [startup]
    keywords: [启动]
    focus_lines:
      - "- 测试配置：启动链路聚焦。"
    output_requirement_lines:
      - "- 需要补充 {{deep_reason_label}} 的测试约束。"
    next_step_line: "- 测试配置下一步。"
    require_top_clusters: false
    cluster_output_mode: optional
    cluster_frame_list_mode: top
    max_frames_per_cluster: 3
  - id: generic
    scene_name: 通用性能（测试配置）
    aspect_hints: []
    keywords: []
    focus_lines:
      - "- 测试配置：通用焦点。"
    output_requirement_lines:
      - "- 测试配置：通用约束。"
    next_step_line: "- 测试配置：通用下一步。"
    require_top_clusters: false
`);

    process.env[envKey] = configPath;
    resetConclusionSceneTemplateCacheForTests();

    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['startup'], primaryGoal: '分析启动慢' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneName).toBe('启动性能（测试配置）');
    expect(hints.focusLines.join('\n')).toContain('测试配置：启动链路聚焦');
    expect(hints.outputRequirementLines.join('\n')).toContain('为什么慢');
    expect(hints.nextStepLine).toContain('测试配置下一步');
    expect(hints.clusterPolicy.frameListMode).toBe('top');
    expect(hints.clusterPolicy.maxFramesPerCluster).toBe(3);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('merges base and override template files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-template-layer-'));
    const basePath = path.join(tempDir, 'base.yaml');
    const overridePath = path.join(tempDir, 'override.yaml');

    fs.writeFileSync(basePath, `version: 1
scenes:
  - id: startup
    scene_name: 启动性能（基线）
    aspect_hints: [startup]
    keywords: [启动]
    output_requirement_lines:
      - "- 基线：必须解释 {{deep_reason_label}}。"
    next_step_line: "- 基线：下一步。"
  - id: generic
    scene_name: 通用性能（基线）
    aspect_hints: []
    keywords: []
    output_requirement_lines:
      - "- 基线：通用约束。"
    next_step_line: "- 基线：通用下一步。"
`);

    fs.writeFileSync(overridePath, `version: 1
scenes:
  - id: startup
    scene_name: 启动性能（覆盖）
    next_step_line: "- 覆盖：下一步。"
`);

    process.env[baseEnvKey] = basePath;
    process.env[overrideEnvKey] = overridePath;
    resetConclusionSceneTemplateCacheForTests();

    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['startup'], primaryGoal: '分析启动慢' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneName).toBe('启动性能（覆盖）');
    expect(hints.outputRequirementLines.join('\n')).toContain('为什么慢');
    expect(hints.nextStepLine).toContain('覆盖：下一步');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('collects validation warnings when config contains invalid schema', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-template-invalid-'));
    const configPath = path.join(tempDir, 'invalid_scene_templates.yaml');

    fs.writeFileSync(configPath, `version: 2
scenes:
  - id: startup
    scene_name: 123
    output_requirement_lines: wrong_type
    unknown_field: true
`);

    process.env[envKey] = configPath;
    resetConclusionSceneTemplateCacheForTests();

    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['startup'], primaryGoal: '分析启动慢' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    const diagnostics = getConclusionSceneTemplateDiagnostics();

    expect(hints.sceneId).toBe('startup');
    expect(hints.sceneName).toBe('启动性能');
    expect(diagnostics.templateCount).toBeGreaterThan(0);
    expect(diagnostics.sourceFiles).toContain(configPath);
    expect(diagnostics.warnings.some(line => line.includes('unsupported version'))).toBe(true);
    expect(diagnostics.warnings.some(line => line.includes('unknown fields'))).toBe(true);
    expect(diagnostics.warnings.some(line => line.includes('scene_name must be a string'))).toBe(true);
    expect(diagnostics.warnings.some(line => line.includes('output_requirement_lines must be an array'))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
