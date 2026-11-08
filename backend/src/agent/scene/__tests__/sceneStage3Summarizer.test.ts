// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';

import {
  buildStage3Prompt,
  parseStage3Summaries,
} from '../sceneStage3Summarizer';
import type {DisplayedScene} from '../types';
import {isolatedClaudeOneShotOptions} from '../../../agentRuntime/engines/claude/claudeOneShot';
import {resolveClaudeSdkPermissionOptions} from '../../../agentv3/claudeConfig';

const scene: DisplayedScene = {
  id: 'scene-1',
  sceneType: 'cold_start',
  sourceStepId: 'app_launches',
  startTs: '0',
  endTs: '1250000000',
  durationMs: 1_250,
  processName: 'com.example.launch.aosp.heavy',
  label: 'Cold start',
  metadata: {},
  severity: 'warning',
  analysisState: 'completed',
};

describe('scene Stage3 bilingual narrative contract', () => {
  it('isolates one-shot scene model calls from tools, settings, and resume persistence', () => {
    const options = isolatedClaudeOneShotOptions({
      model: 'test-model',
      env: {} as NodeJS.ProcessEnv,
      stderr: () => undefined,
    });

    expect(options).toMatchObject({
      maxTurns: 1,
      ...resolveClaudeSdkPermissionOptions(),
      settingSources: [],
      tools: [],
      allowedTools: [],
      skills: [],
      plugins: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(options).not.toHaveProperty('resume');
  });

  it('loads the durable strategy template and renders evidence variables', () => {
    const prompt = buildStage3Prompt({scenes: [scene], jobs: []});

    expect(prompt).toContain('`zh-CN`');
    expect(prompt).toContain('`en`');
    expect(prompt).toContain('[cold_start] launch.aosp.heavy (1.3s)');
    expect(prompt).not.toContain('{{sceneLines}}');
  });

  it('accepts only locale-complete JSON output', () => {
    expect(parseStage3Summaries(
      '```json\n{"zh-CN":"用户启动应用。","en":"The user launched the app."}\n```',
    )).toEqual({
      'zh-CN': '用户启动应用。',
      en: 'The user launched the app.',
    });
    expect(parseStage3Summaries('{"zh-CN":"只有中文"}')).toBeNull();
    expect(parseStage3Summaries('not json')).toBeNull();
  });

  it('rejects extra fields and summaries outside the durable size contract', () => {
    expect(parseStage3Summaries(JSON.stringify({
      'zh-CN': '用户启动应用。',
      en: 'The user launched the app.',
      debug: 'not part of the report contract',
    }))).toBeNull();
    expect(parseStage3Summaries(JSON.stringify({
      'zh-CN': '用'.repeat(201),
      en: 'The user launched the app.',
    }))).toBeNull();
    expect(parseStage3Summaries(JSON.stringify({
      'zh-CN': '用户启动应用。',
      en: Array.from({length: 141}, () => 'word').join(' '),
    }))).toBeNull();
    expect(parseStage3Summaries(JSON.stringify({
      'zh-CN': '用户启动应用。',
      en: 'x'.repeat(4 * 1024 + 1),
    }))).toBeNull();
  });
});
