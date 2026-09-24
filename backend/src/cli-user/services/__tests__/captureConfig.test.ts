// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import {
  addAtraceCategories,
  calculateCaptureBufferSizeKb,
  extractDurationMs,
  listCapturePresets,
  readTraceConfigFile,
  renderAndroidTraceConfig,
  renderTraceConfigTemplate,
} from '../captureConfig';

describe('capture config rendering', () => {
  it('exposes and renders the shared Camera preset', () => {
    expect(listCapturePresets().map(preset => preset.id)).toContain('camera');

    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'camera',
      app: 'com.example.camera',
      durationSeconds: 20,
    });

    expect(config).toContain('SmartPerfetto capture preset: camera');
    expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
  });

  it('renders every system-wide Android preset as a textproto config', () => {
    for (const preset of listCapturePresets().filter((candidate) => !candidate.requirements)) {
      const config = renderAndroidTraceConfig({
        target: 'android',
        preset: preset.id,
        app: 'com.example.app',
        durationSeconds: preset.defaultDurationSeconds,
      });

      expect(config).toContain(`SmartPerfetto capture preset: ${preset.id}`);
      expect(config).toContain('name: "linux.ftrace"');
      expect(config).toContain('ftrace_events: "sched/sched_blocked_reason"');
      expect(config).toContain('duration_ms:');
      expect(config).toContain('atrace_apps: "com.example.app"');
    }
  });

  it('renders the app-scoped memory-profile preset only for a concrete app', () => {
    expect(listCapturePresets().map(preset => preset.id)).toContain('memory-profile');
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'memory-profile',
      app: 'com.example.app',
      durationSeconds: 60,
    });
    expect(config).toContain('name: "android.heapprofd"');
    expect(config).toContain('name: "android.java_hprof"');
    expect(config).toContain('atrace_apps: "com.example.app"');
    expect(() => renderAndroidTraceConfig({
      target: 'android',
      preset: 'memory-profile',
      app: '*',
      durationSeconds: 60,
    })).toThrow("concrete --app <package> (not '*')");
  });

  it('includes FrameTimeline for startup, scrolling, game, overview, and full presets', () => {
    for (const preset of ['startup', 'scrolling', 'game', 'overview', 'full'] as const) {
      const config = renderAndroidTraceConfig({
        target: 'android',
        preset,
        app: '*',
        durationSeconds: 5,
      });
      expect(config).toContain('android.surfaceflinger.frametimeline');
    }
  });

  it('renders the power preset with android.power configuration', () => {
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'power',
      app: '*',
      durationSeconds: 60,
    });

    expect(config).toContain('SmartPerfetto capture preset: power');
    expect(config).toContain('android_power_config');
    expect(config).toContain('battery_poll_ms: 1000');
    expect(config).toContain('collect_power_rails: true');
    expect(config).toContain('android.network_packets');
    expect(config).toContain('android_network_packets_config');
    expect(config).toContain('poll_ms: 250');
    expect(config).toContain('ftrace_events: "power/suspend_resume"');
    expect(config).toContain('ftrace_events: "power/wakeup_source_activate"');
    expect(config).toContain('ftrace_events: "power/cpu_frequency_limits"');
    expect(config).toContain('ftrace_events: "thermal/thermal_temperature"');
    expect(config).toContain('ftrace_events: "thermal/cdev_update"');
  });

  it('extracts duration from pass-through config files without rewriting them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-config-test-'));
    const configPath = path.join(dir, 'perfetto.config');
    const source = [
      'buffers { size_kb: 1024 fill_policy: RING_BUFFER }',
      'duration_ms: 20000',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, source, 'utf-8');

    try {
      const read = readTraceConfigFile(configPath);
      expect(read.textproto).toBe(source);
      expect(read.durationMs).toBe(20000);
      expect(read.templated).toBe(false);
      expect(extractDurationMs('duration_ms: 1\nduration_ms: 2\n')).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders config templates and duration-scaled buffers', () => {
    const rendered = renderTraceConfigTemplate([
      'buffers { size_kb: {buffer_size_kb} fill_policy: RING_BUFFER }',
      'duration_ms: {duration_ms}',
    ].join('\n'), { durationSeconds: 90 });

    expect(rendered.templated).toBe(true);
    expect(rendered.textproto).toContain('duration_ms: 90000');
    expect(rendered.textproto).toContain(`size_kb: ${512 * 1024}`);
    expect(calculateCaptureBufferSizeKb(1)).toBe(64 * 1024);
    expect(calculateCaptureBufferSizeKb(90)).toBe(512 * 1024);
    expect(() => renderTraceConfigTemplate('duration_ms: {duration_ms}')).toThrow('--duration');
  });

  it('injects additional atrace categories into generated and pass-through configs', () => {
    const generated = renderAndroidTraceConfig({
      target: 'android',
      preset: 'startup',
      app: 'com.example.app',
      durationSeconds: 5,
      extraAtraceCategories: ['dalvikviktime', 'my_custom_tag'],
    });
    expect(generated).toContain('atrace_categories: "dalvikviktime"');
    expect(generated).toContain('atrace_categories: "my_custom_tag"');

    const passThrough = addAtraceCategories([
      'data_sources {',
      '  config {',
      '    name: "linux.ftrace"',
      '    ftrace_config {',
      '      atrace_categories: "am"',
      '      atrace_apps: "*"',
      '    }',
      '  }',
      '}',
    ].join('\n'), ['am', 'custom']);
    expect(passThrough.match(/atrace_categories: "am"/g)).toHaveLength(1);
    expect(passThrough).toContain('atrace_categories: "custom"');

    const compact = addAtraceCategories(
      'data_sources { config { name: "linux.ftrace" ftrace_config { atrace_categories: "am" atrace_apps: "*" } } }',
      ['binder_driver'],
    );
    expect(compact).toContain('atrace_categories: "binder_driver"');
  });
});
