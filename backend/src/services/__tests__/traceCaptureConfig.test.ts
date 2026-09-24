// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import { describe, expect, it } from '@jest/globals';
import {
  addAtraceCategories,
  calculateCaptureBufferSizeKb,
  getCapturePreset,
  listCapturePresets,
  memoryProfileJavaDumpIntervalMs,
  renderAndroidTraceConfig,
  renderTraceConfigTemplate,
  resolveCaptureBufferSizeKb,
  resolveCaptureDataSources,
} from '../traceCaptureConfig';

// SHA-256 of every system-wide preset rendered at its default duration,
// recorded before memory-profile introduced a second render path. A change
// here means an existing preset's device config changed: update the digest
// only when that change is intended.
const SYSTEM_PRESET_CONFIG_SHA256: Record<string, string> = {
  'startup|com.example.app': 'ac1bee0b74b81db156c280c3cd34d8c66b3adbf60546ccff80c4427619e72eb0',
  'startup|*': '195594ba6f365d8e96451340c9353b8da96ff0ca9e34e59b3ce0b4e771ce9eb9',
  'scrolling|com.example.app': 'a1e1a05fabf789275dae9049bd5c92d34a7ff3e9d2d6c12a1678a5c8a0855861',
  'scrolling|*': 'f14ddc0ae89afba2e1e871ce15f2aaa44aaaea6ea6640410d36ad723480bd2ad',
  'camera|com.example.app': '1a5ce16d753c0c1015ecf2b2ba2359f442aebfc154da40d98d15622c0f2f6f5c',
  'camera|*': 'de1b7d888ff01da394af3fccabb0242cfa6161318bf5cef4ca599284d981c511',
  'anr|com.example.app': 'aa023370b010e7caf50780e2f94cbd0f0adff50c8726b7b33a59f2bec52574cd',
  'anr|*': 'f4fe0c3cb653eeeea38740d500d165862e1e5eef40de6c965089380c41ff0548',
  'game|com.example.app': '5d9ce0e48bd02e444ed81622484bfdab0252371ec9b65d2849c1d10580304699',
  'game|*': '8ceacf3261e0f835d59586d086d9dd37848d6ba8be3a0cf08f179ceaa8124326',
  'memory|com.example.app': '1a04cadbd2b31674040103951b1070bfa0421a6cfb84b76fef89a7cbf3e376a5',
  'memory|*': '85fd09c6f574963eb0ac4d6f4f7cd0fdcc2c70720a081f91d73f418e48ce5be2',
  'cpu|com.example.app': '1a08794ad5607eebd0519563a2a326fbff7a61ef8498f75bafd6c2695b622756',
  'cpu|*': 'e9cbdc2fa636008066645030c56d6f1ac0e087cf8acf2a56c61078cc596b1a6d',
  'power|com.example.app': '421fccd0bfe87829e621042c65abad9d3ad28635e8590fbd54f62fbb3827b382',
  'power|*': 'e52725f0cd916c3abb51cefa2d8e67c66018975e93a1b2fad468c9ef105bd51a',
  'overview|com.example.app': '38d81a028d5064b9d82693145236d3f4012e5219eb3110f9662955439f9caf0f',
  'overview|*': '7dead897c29df9329cfd5a97042693736a510ce991b9f0b958feb75106cc6415',
  'full|com.example.app': '36b4149edc613f52b0c6af93ea9f550576f90eb535dd6a7e4348f0d28a92da57',
  'full|*': '1bfa11421468a7ace64de86cdff239a6b5f5cbd92a83d740e0742834cb74ad08',
};

// Fields each memory-profile message may use. All exist at the pinned Perfetto
// revision and in Android 11 (API 30) perfetto, whose textproto parser rejects
// unknown fields, so anything newer (record_process_age, smaps_config,
// BufferConfig.name, target_buffer_name) must stay out.
const MEMORY_PROFILE_ALLOWED_FIELDS: Record<string, string[]> = {
  TraceConfig: ['buffers', 'data_sources', 'duration_ms', 'flush_period_ms', 'incremental_state_config'],
  BufferConfig: ['size_kb', 'fill_policy'],
  DataSource: ['config'],
  DataSourceConfig: [
    'name', 'target_buffer', 'process_stats_config', 'heapprofd_config', 'java_hprof_config', 'ftrace_config',
  ],
  ProcessStatsConfig: ['scan_all_processes_on_start', 'proc_stats_poll_ms'],
  HeapprofdConfig: [
    'process_cmdline', 'sampling_interval_bytes', 'shmem_size_bytes', 'block_client', 'continuous_dump_config',
  ],
  JavaHprofConfig: ['process_cmdline', 'continuous_dump_config'],
  ContinuousDumpConfig: ['dump_phase_ms', 'dump_interval_ms'],
  FtraceConfig: ['ftrace_events', 'atrace_categories', 'atrace_apps'],
  IncrementalStateConfig: ['clear_period_ms'],
};

const MESSAGE_TYPE_OF_FIELD: Record<string, string> = {
  buffers: 'BufferConfig',
  data_sources: 'DataSource',
  config: 'DataSourceConfig',
  process_stats_config: 'ProcessStatsConfig',
  heapprofd_config: 'HeapprofdConfig',
  java_hprof_config: 'JavaHprofConfig',
  continuous_dump_config: 'ContinuousDumpConfig',
  ftrace_config: 'FtraceConfig',
  incremental_state_config: 'IncrementalStateConfig',
};

interface TextProtoMessage {
  type: string;
  fields: Array<{ name: string; value: string | TextProtoMessage }>;
}

/** Minimal textproto reader: enough to check nesting and field names. */
function parseTextProto(source: string): TextProtoMessage {
  const tokens = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .match(/"(?:\\.|[^"\\])*"|[{}:]|[^\s{}:"]+/g) ?? [];
  let index = 0;
  const readMessage = (type: string, closing: boolean): TextProtoMessage => {
    const message: TextProtoMessage = { type, fields: [] };
    while (index < tokens.length) {
      const token = tokens[index++]!;
      if (token === '}') {
        if (!closing) throw new Error('unexpected }');
        return message;
      }
      const next = tokens[index++];
      if (next === '{') {
        const childType = MESSAGE_TYPE_OF_FIELD[token];
        if (!childType) throw new Error(`unknown message field ${type}.${token}`);
        message.fields.push({ name: token, value: readMessage(childType, true) });
      } else if (next === ':') {
        message.fields.push({ name: token, value: tokens[index++]! });
      } else {
        throw new Error(`malformed field ${token}`);
      }
    }
    if (closing) throw new Error(`unterminated ${type}`);
    return message;
  };
  return readMessage('TraceConfig', false);
}

function visitMessages(message: TextProtoMessage, visit: (message: TextProtoMessage) => void): void {
  visit(message);
  for (const field of message.fields) {
    if (typeof field.value !== 'string') visitMessages(field.value, visit);
  }
}

function childMessages(message: TextProtoMessage, name: string): TextProtoMessage[] {
  return message.fields
    .filter((field) => field.name === name && typeof field.value !== 'string')
    .map((field) => field.value as TextProtoMessage);
}

function scalar(message: TextProtoMessage, name: string): string | undefined {
  const field = message.fields.find((candidate) => candidate.name === name);
  return typeof field?.value === 'string' ? field.value : undefined;
}

describe('shared trace capture config rendering', () => {
  it('renders the Camera preset with binder, FrameTimeline, and DMA-BUF evidence', () => {
    const preset = getCapturePreset('camera');
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'camera',
      app: 'com.example.camera',
      durationSeconds: 20,
    });

    expect(preset.intent).toBe('camera');
    expect(config).toContain('atrace_categories: "camera"');
    expect(config).toContain('atrace_categories: "hal"');
    expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
    expect(config).toContain('ftrace_events: "ion/ion_stat"');
    expect(config).toContain('ftrace_events: "binder/binder_transaction"');
    expect(config).toContain('name: "android.surfaceflinger.frametimeline"');
  });

  it('keeps Camera memory evidence in the full diagnostic preset', () => {
    const config = renderAndroidTraceConfig({
      target: 'android',
      preset: 'full',
      app: '*',
      durationSeconds: 20,
    });

    expect(config).toContain('ftrace_events: "dmabuf_heap/dma_heap_stat"');
    expect(config).toContain('ftrace_events: "ion/ion_stat"');
  });

  it('renders every system-wide Android preset through the shared service', () => {
    // App-profiling presets (memory-profile) have their own layout and are
    // covered by the memory-profile tests below.
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
      // Actual frequency without its bounds cannot distinguish an idle CPU from
      // a clamped one, so every preset carries both.
      expect(config).toContain('ftrace_events: "power/cpu_frequency"');
      expect(config).toContain('ftrace_events: "power/cpu_frequency_limits"');
      expect(config).toContain('duration_ms:');
      expect(config).toContain('atrace_apps: "com.example.app"');
    }
  });

  it.each(['cpu', 'power', 'full'] as const)(
    'gives the %s preset thermal zone and cooling device events',
    (presetId) => {
      const config = renderAndroidTraceConfig({
        target: 'android',
        preset: presetId,
        app: 'com.example.app',
        durationSeconds: 15,
      });

      expect(config).toContain('ftrace_events: "thermal/thermal_temperature"');
      expect(config).toContain('ftrace_events: "thermal/cdev_update"');
      expect(config).toContain('ftrace_events: "power/cpu_frequency_limits"');
    },
  );

  it('keeps template rendering and duration-scaled buffers in the shared service', () => {
    const rendered = renderTraceConfigTemplate([
      'buffers { size_kb: {buffer_size_kb} fill_policy: RING_BUFFER }',
      'duration_ms: {duration_ms}',
    ].join('\n'), { durationSeconds: 90 });

    expect(rendered.templated).toBe(true);
    expect(rendered.textproto).toContain('duration_ms: 90000');
    expect(rendered.textproto).toContain(`size_kb: ${512 * 1024}`);
    expect(calculateCaptureBufferSizeKb(1)).toBe(64 * 1024);
    expect(calculateCaptureBufferSizeKb(90)).toBe(512 * 1024);
  });

  it('injects additional atrace categories without duplicating existing categories', () => {
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
  });

  it('keeps every system-wide preset config byte-identical', () => {
    const digests: Record<string, string> = {};
    for (const preset of listCapturePresets().filter((candidate) => !candidate.requirements)) {
      for (const app of ['com.example.app', '*']) {
        const config = renderAndroidTraceConfig({
          target: 'android',
          preset: preset.id,
          app,
          durationSeconds: preset.defaultDurationSeconds,
        });
        digests[`${preset.id}|${app}`] = createHash('sha256').update(config).digest('hex');
      }
    }
    expect(digests).toEqual(SYSTEM_PRESET_CONFIG_SHA256);
  });
});

describe('memory-profile capture preset', () => {
  const render = (overrides: Partial<Parameters<typeof renderAndroidTraceConfig>[0]> = {}) =>
    renderAndroidTraceConfig({
      target: 'android',
      preset: 'memory-profile',
      app: 'com.example.app',
      durationSeconds: getCapturePreset('memory-profile').defaultDurationSeconds,
      ...overrides,
    });

  it('declares an app-scoped memory preset that needs Android 11 and built-in perfetto', () => {
    const preset = getCapturePreset('memory-profile');
    expect(preset.intent).toBe('memory');
    expect(preset.descriptionZh.length).toBeGreaterThan(0);
    expect(preset.requirements).toMatchObject({
      minApiLevel: 30,
      minDurationSeconds: 20,
      appFallbackPreset: 'memory',
    });
    expect(preset.requirements?.notes.map((note) => note.en).join('\n')).toMatch(/profileable or debuggable/);
    expect(preset.requirements?.notes.map((note) => note.en).join('\n')).toMatch(/pauses the app/);
    // Only the new preset carries requirements; the listed shape of every
    // existing preset is unchanged.
    expect(listCapturePresets().filter((candidate) => candidate.requirements).map((candidate) => candidate.id))
      .toEqual(['memory-profile']);
  });

  it('renders four index-addressed buffers with the Memscope data sources', () => {
    const root = parseTextProto(render());
    const buffers = childMessages(root, 'buffers');
    expect(buffers.map((buffer) => [scalar(buffer, 'size_kb'), scalar(buffer, 'fill_policy')])).toEqual([
      ['8192', 'RING_BUFFER'],
      ['131072', 'RING_BUFFER'],
      ['262144', 'DISCARD'],
      ['16384', 'RING_BUFFER'],
    ]);
    for (const buffer of buffers) {
      expect(Number(scalar(buffer, 'size_kb')) % 4).toBe(0);
    }

    const sources = childMessages(root, 'data_sources').map((source) => childMessages(source, 'config')[0]!);
    expect(sources.map((source) => [scalar(source, 'name'), scalar(source, 'target_buffer')])).toEqual([
      ['"android.packages_list"', '0'],
      ['"linux.process_stats"', '0'],
      ['"android.heapprofd"', '1'],
      ['"android.java_hprof"', '2'],
      ['"linux.ftrace"', '3'],
    ]);

    const processStats = childMessages(sources[1]!, 'process_stats_config')[0]!;
    expect(scalar(processStats, 'scan_all_processes_on_start')).toBe('true');
    expect(scalar(processStats, 'proc_stats_poll_ms')).toBe('1000');

    const heapprofd = childMessages(sources[2]!, 'heapprofd_config')[0]!;
    expect(scalar(heapprofd, 'process_cmdline')).toBe('"com.example.app"');
    expect(scalar(heapprofd, 'sampling_interval_bytes')).toBe('32768');
    expect(scalar(heapprofd, 'shmem_size_bytes')).toBe('16777216');
    expect(scalar(heapprofd, 'block_client')).toBe('true');
    const heapDump = childMessages(heapprofd, 'continuous_dump_config')[0]!;
    expect(scalar(heapDump, 'dump_interval_ms')).toBe('5000');

    const javaHprof = childMessages(sources[3]!, 'java_hprof_config')[0]!;
    expect(scalar(javaHprof, 'process_cmdline')).toBe('"com.example.app"');
    const javaDump = childMessages(javaHprof, 'continuous_dump_config')[0]!;
    // Baseline at start, then 25 s and 50 s: about three dumps in 60 s.
    expect(scalar(javaDump, 'dump_phase_ms')).toBe('25000');
    expect(scalar(javaDump, 'dump_interval_ms')).toBe('25000');

    const ftrace = childMessages(sources[4]!, 'ftrace_config')[0]!;
    const repeated = (name: string) => ftrace.fields.filter((field) => field.name === name).map((field) => field.value);
    expect(repeated('ftrace_events')).toEqual(['"ftrace/print"']);
    expect(repeated('atrace_categories')).toEqual(['"dalvik"', '"am"', '"wm"']);
    expect(repeated('atrace_apps')).toEqual(['"com.example.app"']);

    expect(scalar(root, 'duration_ms')).toBe('60000');
  });

  it('uses only fields that Android 11 perfetto parses', () => {
    const config = render();
    visitMessages(parseTextProto(config), (message) => {
      for (const field of message.fields) {
        expect(MEMORY_PROFILE_ALLOWED_FIELDS[message.type]).toContain(field.name);
      }
    });
    expect(config).not.toContain('record_process_age');
    expect(config).not.toContain('smaps_config');
    expect(config).not.toContain('target_buffer_name');
  });

  it.each([undefined, '', '   ', '*', 'com.example.*', 'com.example app', 'com.example.app"'])(
    'rejects %p as the target app',
    (app) => {
      expect(() => render({ app })).toThrow(/memory-profile/);
    },
  );

  it('accepts an app sub-process name', () => {
    expect(render({ app: 'com.example.app:remote' })).toContain('process_cmdline: "com.example.app:remote"');
  });

  it('spreads Java heap dumps over the duration and rejects captures too short for a second dump', () => {
    expect(memoryProfileJavaDumpIntervalMs(60000)).toBe(25000);
    expect(memoryProfileJavaDumpIntervalMs(120000)).toBe(55000);
    expect(memoryProfileJavaDumpIntervalMs(20000)).toBe(10000);
    expect(() => render({ durationSeconds: 19 })).toThrow('--duration >= 20');
    expect(render({ durationSeconds: 20 })).toContain('dump_interval_ms: 10000');
  });

  it('sizes the process_stats ring to the duration', () => {
    const buffersOf = (durationSeconds: number) =>
      childMessages(parseTextProto(render({ durationSeconds })), 'buffers').map((buffer) => scalar(buffer, 'size_kb'));
    expect(buffersOf(600)[0]).toBe(String(600 * 64));
    expect(buffersOf(7200)[0]).toBe(String(128 * 1024));
  });

  it('treats the buffer override as the java_hprof buffer and never shrinks it below a baseline dump', () => {
    const preset = getCapturePreset('memory-profile');
    expect(resolveCaptureBufferSizeKb(preset, 60)).toBe(262144);
    expect(resolveCaptureBufferSizeKb(preset, 60, 524289)).toBe(524292);
    expect(() => resolveCaptureBufferSizeKb(preset, 60, 65536)).toThrow('at least 262144');
    const buffers = childMessages(parseTextProto(render({ bufferSizeKb: 524288 })), 'buffers');
    expect(scalar(buffers[2]!, 'size_kb')).toBe('524288');
    expect(scalar(buffers[0]!, 'size_kb')).toBe('8192');

    // System-wide presets keep the previous meaning: the override replaces the main ring.
    expect(resolveCaptureBufferSizeKb(getCapturePreset('memory'), 30, 1024)).toBe(1024);
    expect(resolveCaptureBufferSizeKb(getCapturePreset('memory'), 30))
      .toBe(calculateCaptureBufferSizeKb(30, getCapturePreset('memory').bufferSizeKb));
  });

  it('adds extra atrace categories and lists exactly the rendered data sources', () => {
    expect(render({ extraAtraceCategories: ['gfx', 'dalvik'] }).match(/atrace_categories: "dalvik"/g)).toHaveLength(1);
    expect(render({ extraAtraceCategories: ['gfx'] })).toContain('atrace_categories: "gfx"');
    expect(resolveCaptureDataSources(getCapturePreset('memory-profile'), { packageName: 'com.example.app' }))
      .toEqual(['android.packages_list', 'linux.process_stats', 'android.heapprofd', 'android.java_hprof', 'linux.ftrace']);
  });
});
