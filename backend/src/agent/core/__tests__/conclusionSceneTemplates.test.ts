import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Finding, Intent } from '../../types';
import {
  buildConclusionScenePromptHints,
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

  test('uses jank template and requires why-slow evidence', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['jank'], primaryGoal: '分析滑动卡顿' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('jank');
    expect(hints.requireTopClusters).toBe(true);
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
  });

  test('uses anr template when query contains ANR keywords', () => {
    const hints = buildConclusionScenePromptHints({
      intent: createIntent({ aspects: ['anr'], primaryGoal: '为什么会 ANR，主线程卡死在哪里？' }),
      findings: [],
      deepReasonLabel: '为什么慢',
    });

    expect(hints.sceneId).toBe('anr');
    expect(hints.focusLines.join('\n')).toContain('阻塞');
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
