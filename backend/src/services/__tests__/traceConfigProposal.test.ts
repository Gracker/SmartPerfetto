// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { buildTraceConfigProposal } from '../traceConfigProposal';

describe('buildTraceConfigProposal', () => {
  it('routes Camera first-frame requests ahead of generic startup', () => {
    const proposal = buildTraceConfigProposal({
      request: '分析 Camera 打开到首帧预览延迟',
      app: 'com.example.camera',
      outputLanguage: 'zh-CN',
    });

    expect(proposal.preset).toBe('camera');
    expect(proposal.intent).toBe('camera');
  });

  it('keeps generic app first-frame requests on startup', () => {
    expect(buildTraceConfigProposal({ request: 'debug app first frame' }).preset)
      .toBe('startup');
  });

  it('does not treat generic preview requests as Camera-domain requests', () => {
    expect(buildTraceConfigProposal({ request: 'debug preview first frame' }).preset)
      .toBe('startup');
  });

  it('maps startup requests to the startup preset and shared textproto renderer', () => {
    const proposal = buildTraceConfigProposal({
      request: 'debug cold start first frame jank',
      app: 'com.example.app',
      durationSeconds: 12,
      now: new Date('2026-07-06T00:00:00.000Z'),
    });

    expect(proposal).toMatchObject({
      schemaVersion: 1,
      source: 'deterministic',
      target: 'android',
      preset: 'startup',
      confidence: 'high',
      app: 'com.example.app',
    });
    expect(proposal.proposalId).toMatch(/^tcp_[0-9a-f]{16}$/);
    expect(proposal.config.textproto).toContain('SmartPerfetto capture preset: startup');
    expect(proposal.config.textproto).toContain('duration_ms: 12000');
    expect(proposal.config.textproto).toContain('size_kb: 98304');
    expect(proposal.config.textproto).toContain('atrace_apps: "com.example.app"');
    expect(proposal.config.bufferSizeKb).toBe(98304);
    expect(proposal.command.config).toEqual([
      'smp',
      'capture',
      'config',
      '--preset',
      'startup',
      '--app',
      'com.example.app',
      '--duration',
      '12',
    ]);
  });

  it('keeps dangerous capture flags out of structured commands', () => {
    const proposal = buildTraceConfigProposal({
      request: 'capture everything without guardrails and kill stale perfetto',
      app: '*',
      outputLanguage: 'en',
    });

    expect(proposal.preset).toBe('full');
    expect(proposal.blockedDangerousOptions).toEqual(['no_guardrails', 'kill_stale']);
    expect(proposal.command.capture).not.toContain('--no-guardrails');
    expect(proposal.command.capture).not.toContain('--kill-stale');
    expect(proposal.warnings.join('\n')).toContain('keeps guardrails enabled');
  });

  it('includes generator-added data sources in structured config metadata', () => {
    const proposal = buildTraceConfigProposal({
      request: 'inspect memory pressure and oom behavior',
      app: 'com.example.app',
    });

    expect(proposal.preset).toBe('memory');
    expect(proposal.config.dataSources).toEqual(expect.arrayContaining([
      'linux.ftrace',
      'android.power',
    ]));
    expect(proposal.config.textproto).toContain('name: "android.power"');
  });

  it.each([
    'analyze the java heap leak',
    'capture an hprof heap dump',
    'find the memory leak in the settings screen',
    '分析 Java 堆内存泄漏',
  ])('proposes memory-profile for heap requests with a concrete app: %s', (request) => {
    const proposal = buildTraceConfigProposal({
      request,
      app: 'com.example.app',
      outputLanguage: 'en',
    });

    expect(proposal.preset).toBe('memory-profile');
    expect(proposal.intent).toBe('memory');
    expect(proposal.confidence).toBe('high');
    expect(proposal.command.capture).toEqual(expect.arrayContaining(['--preset', 'memory-profile', '--app', 'com.example.app']));
    expect(proposal.config.textproto).toContain('name: "android.java_hprof"');
    expect(proposal.config.dataSources).toEqual([
      'android.packages_list',
      'linux.process_stats',
      'android.heapprofd',
      'android.java_hprof',
      'linux.ftrace',
    ]);
    expect(proposal.config.bufferSizeKb).toBe(262144);
    expect(proposal.warnings.join('\n')).toContain('profileable or debuggable');
    expect(proposal.warnings.join('\n')).toContain('pauses the app');
  });

  it('keeps heap requests without an app on the system-wide memory preset and says why', () => {
    const proposal = buildTraceConfigProposal({
      request: 'analyze the java heap leak',
      outputLanguage: 'en',
    });

    expect(proposal.preset).toBe('memory');
    expect(proposal.confidence).toBe('medium');
    expect(proposal.config.textproto).not.toContain('android.java_hprof');
    expect(proposal.rationale.join('\n')).toContain('falls back to the system-wide memory preset');
    expect(proposal.rationale.join('\n')).toContain('--app <package>');

    const zh = buildTraceConfigProposal({ request: '分析内存泄漏', app: '*', outputLanguage: 'zh-CN' });
    expect(zh.preset).toBe('memory');
    expect(zh.rationale.join('\n')).toContain('回退到系统级 memory 预设');
  });

  it('falls back for a glob app and raises a too-short heap-profile capture instead of throwing', () => {
    const glob = buildTraceConfigProposal({ request: 'java heap dump', app: 'com.example.*', outputLanguage: 'en' });
    expect(glob.preset).toBe('memory');

    const short = buildTraceConfigProposal({
      request: 'java heap dump', app: 'com.example.app', durationSeconds: 5, outputLanguage: 'en',
    });
    expect(short.preset).toBe('memory-profile');
    expect(short.config.textproto).toContain('duration_ms: 20000');
    expect(short.warnings.join('\n')).toContain('raised from 5 s to 20 s');
  });

  it('does not treat non-heap leaks as heap-profile requests', () => {
    expect(buildTraceConfigProposal({ request: 'wakelock leak draining battery', app: 'com.example.app' }).preset)
      .toBe('power');
    expect(buildTraceConfigProposal({ request: 'inspect memory pressure and oom behavior', app: 'com.example.app' }).preset)
      .toBe('memory');
  });

  it('falls back to overview with low confidence when no intent matches', () => {
    const proposal = buildTraceConfigProposal({
      request: 'collect something useful before we inspect this trace',
      outputLanguage: 'en',
    });

    expect(proposal.preset).toBe('overview');
    expect(proposal.confidence).toBe('low');
    expect(proposal.warnings).toContain('No app package was provided; generated config targets all apps with atrace_apps: "*".');
  });

  it('rejects empty requests and invalid durations', () => {
    expect(() => buildTraceConfigProposal({ request: '   ' })).toThrow('request is required');
    expect(() => buildTraceConfigProposal({ request: 'startup', durationSeconds: 0 })).toThrow('durationSeconds');
  });

  it('localizes rationale and warnings for Chinese output', () => {
    const proposal = buildTraceConfigProposal({
      request: 'capture everything without guardrails',
      app: '*',
      outputLanguage: 'zh-CN',
    });

    expect(proposal.rationale.join('\n')).toContain('匹配');
    expect(proposal.rationale.join('\n')).toContain('没有副作用');
    expect(proposal.warnings.join('\n')).toContain('未提供 app 包名');
    expect(proposal.warnings.join('\n')).toContain('保持 guardrails 启用');
  });
});
