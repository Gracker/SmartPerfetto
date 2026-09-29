// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {classifyTraceHead, detectTraceFormat, TRACE_HEAD_SCAN_BYTES} from '../traceFormatDetector';
import {resolveTraceCase} from '../../utils/traceCorpus';

const tempDirs: string[] = [];

const PROTOBUF_HEADER = Buffer.from([0x0a, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
// Real shapes from local traces; the surrounding bytes mimic protobuf framing,
// whose tag and length bytes can be printable (`Q...r` in android-scroll-customer).
const FINGERPRINT = 'google/raven_beta/raven:CinnamonBun/CP31.260508.005.A1/15421647:user/release-keys';
const FINGERPRINT_FIELD = `\x12Q${FINGERPRINT}r\x00`;
const KERNEL_RELEASE_FIELD = '\x1a.6.6.89-android15-8-g97a9aaefab9a-ab14519050-4k\x00';
const AIDL_SLICES = [
  'AIDL::cpp::ISurfaceComposerClient::createSurface::cppClient',
  'HIDL::IWifiChip::getStaIface::server',
  'vendor.honor.hardware.iawareperf.IUniPerfAidlInterface::uniPerfEvent',
].join('\x00');
const FORMER_HARMONY_TAGS = [
  'ace::', 'ArkTS', 'ark_ts', 'RSRender', 'RenderService', 'FFRT', 'ffrt::', 'Hiperf', 'hiperf',
  'Hisysevent', 'hitrace', 'HiViewNode', 'AppExecFwk', 'AbilityManagerService', 'ohos.',
].join('\x00');

function protobuf(...parts: string[]): Buffer {
  return Buffer.concat([PROTOBUF_HEADER, Buffer.from(parts.join('\x00'), 'latin1')]);
}

function text(...lines: string[]): Buffer {
  return Buffer.from(lines.join('\n'));
}

function writeFixture(content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-trace-format-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'trace.ptrace');
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

const FTRACE_HEADER = ['# tracer: nop', '#', '#           TASK-PID    TGID   CPU#  ||||    TIMESTAMP  FUNCTION'];
const APP_LINE = 'com.example.app-7200  ( 7200) [004] ...1  1000.000000: tracing_mark_write: B|7200|Choreographer#doFrame';
const SURFACEFLINGER_LINE = '  surfaceflinger-642   (  642) [003] ...1  1000.000100: tracing_mark_write: B|642|onMessageRefresh';
const ATRACE_SWITCH_LINE = '          <idle>-0     (-----) [002] d..2  1000.000200: sched_switch: '
  + 'prev_comm=swapper/2 prev_pid=0 prev_prio=120 prev_state=R ==> next_comm=atrace next_pid=9123 next_prio=120';

describe('classifyTraceHead: Perfetto protobuf', () => {
  it('needs positive Android evidence: AIDL slices alone stay unknown', () => {
    expect(classifyTraceHead(protobuf(AIDL_SLICES))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'unknown',
      detectionMethod: 'magic',
    });
  });

  it('labels a head carrying an Android build fingerprint android', () => {
    expect(classifyTraceHead(protobuf(FINGERPRINT_FIELD, AIDL_SLICES))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'android',
      detectionMethod: 'content_scan',
    });
  });

  it('labels a head carrying an Android kernel release android', () => {
    expect(classifyTraceHead(protobuf(KERNEL_RELEASE_FIELD))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'android',
    });
  });

  it('never derives harmonyos from former tags or HongMeng thread names', () => {
    const head = protobuf(FORMER_HARMONY_TAGS, 'sysmgr-reclaim-12 (   12) [000]');
    expect(classifyTraceHead(head)).toMatchObject({format: 'perfetto_protobuf', os: 'unknown'});
    expect(classifyTraceHead(protobuf(FORMER_HARMONY_TAGS, KERNEL_RELEASE_FIELD))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'android',
    });
  });

  it('never derives harmonyos from a hitrace header inside protobuf', () => {
    const head = protobuf('2026/05/10 12:00:00 start capture, please wait');
    expect(classifyTraceHead(head).os).toBe('unknown');
  });

  it('does not treat an Android H: tracing marker as OS evidence', () => {
    const markers = 'C|790|H:CPU_LOAD_RESET|33\nB|790|H:CPU_LOAD_RESET:33';
    expect(classifyTraceHead(protobuf(markers))).toMatchObject({format: 'perfetto_protobuf', os: 'unknown'});
    expect(classifyTraceHead(protobuf(markers, FINGERPRINT_FIELD))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'android',
    });
  });

  // Existing behaviour, kept on purpose: the first byte alone decides the
  // protobuf format (a text file starting with a blank line included); only
  // the OS claim now needs evidence.
  it('keeps the 0x0A format rule for a non-trace file but claims no OS', () => {
    expect(classifyTraceHead(text('', 'meeting notes: nothing to see here', 'second line'))).toMatchObject({
      format: 'perfetto_protobuf',
      os: 'unknown',
    });
  });

  it.each([
    ['missing build type', 'google/raven/raven:14/UQ1A.240205.004/11269751:release-keys'],
    ['unknown build type', 'google/raven/raven:14/UQ1A.240205.004/11269751:debug/release-keys'],
    ['free text with slashes', 'see a/b/c:d/e/f for the user/keys notes'],
    ['too few components', 'google/raven:14/UQ1A/11269751:user/release-keys'],
    ['kernel token without a version', 'com.example-android14-feature'],
  ])('does not accept a malformed fingerprint or kernel token (%s)', (_label, payload) => {
    expect(classifyTraceHead(protobuf(`\x12${payload}\x00`)).os).toBe('unknown');
  });

  it('accepts userdebug/eng fingerprints with multiple tags', () => {
    const fingerprint = 'OnePlus/OP5929L1/OP5929L1:15/AP3A.240617.008/U.1b2c3d:userdebug/test-keys,dev-keys';
    expect(classifyTraceHead(protobuf(`\x12${fingerprint}\x00`)).os).toBe('android');
  });
});

describe('classifyTraceHead: text traces', () => {
  it.each([
    ['documented line with duration', '2026/05/10 12:00:00 start capture, please wait 10s ...'],
    ['duration without space before the ellipsis', '2026/05/10 12:00:00 start capture, please wait 5s...'],
    ['no suffix', '2026/05/10 12:00:00 start capture, please wait'],
    ['BOM and CRLF', '\uFEFF2026/05/10 12:00:00 start capture, please wait 10s ...\r'],
  ])('labels the hitrace first-line header harmonyos (%s)', (_label, header) => {
    expect(classifyTraceHead(text(header, ...FTRACE_HEADER, APP_LINE))).toMatchObject({
      format: 'atrace_text',
      os: 'harmonyos',
    });
  });

  it.each([
    ['no ", please wait"', ['2026/05/10 12:00:00 start capture', ...FTRACE_HEADER]],
    ['arbitrary trailing text', ['2026/05/10 12:00:00 start capture, please wait now what', ...FTRACE_HEADER]],
    ['header on line 3', [...FTRACE_HEADER.slice(0, 2), '2026/05/10 12:00:00 start capture, please wait', APP_LINE]],
    ['embedded in another line', ['log: 2026/05/10 12:00:00 start capture, please wait', ...FTRACE_HEADER]],
    ['wrong date shape', ['2026-05-10 12:00:00 start capture, please wait', ...FTRACE_HEADER]],
  ])('does not label harmonyos without the exact first-line header (%s)', (_label, lines) => {
    expect(classifyTraceHead(text(...lines)).os).not.toBe('harmonyos');
  });

  it('does not treat a HiTraceMeter level-suffix marker as OS evidence', () => {
    const line = 'hiperf-952  (  952) [001] ...1  1000.000000: tracing_mark_write: B|952|H:CheckMsgFromNetlink|I62';
    expect(classifyTraceHead(text(...FTRACE_HEADER, line))).toMatchObject({format: 'systrace_text', os: 'unknown'});
  });

  it('does not treat an anchored HongMeng kernel thread as OS evidence', () => {
    const line = '  sysmgr-reclaim-123   (  123) [000] ...1  1000.000000: sched_waking: comm=kswapd0 pid=77';
    expect(classifyTraceHead(text(...FTRACE_HEADER, line))).toMatchObject({format: 'systrace_text', os: 'unknown'});
  });

  it('labels an Android system process in an ftrace task field android', () => {
    const androidMarker = 'com.example.app-790   (  790) [002] ...1  1000.000000: tracing_mark_write: C|790|H:CPU_LOAD_RESET|33';
    expect(classifyTraceHead(text(...FTRACE_HEADER, androidMarker))).toMatchObject({os: 'unknown'});
    expect(classifyTraceHead(text(...FTRACE_HEADER, androidMarker, SURFACEFLINGER_LINE))).toMatchObject({
      format: 'systrace_text',
      os: 'android',
    });
  });

  it('labels the atrace capture tool in a sched_switch comm field android', () => {
    expect(classifyTraceHead(text(...FTRACE_HEADER, APP_LINE, ATRACE_SWITCH_LINE))).toMatchObject({
      format: 'systrace_text',
      os: 'android',
    });
  });

  it('matches system process names only in anchored fields', () => {
    const payload = 'com.example.app-7200  ( 7200) [004] ...1  1000.000000: tracing_mark_write: '
      + 'B|7200|waiting on surfaceflinger-642 and system_server prev_comm=x';
    expect(classifyTraceHead(text(...FTRACE_HEADER, payload))).toMatchObject({os: 'unknown'});
  });

  it('needs a whole ftrace event line, not a look-alike line or a quoted comm field', () => {
    // A line that only starts like a task field, without cpu, timestamp or event.
    expect(classifyTraceHead(text(...FTRACE_HEADER, 'surfaceflinger-642 restarted by the user'))).toMatchObject({os: 'unknown'});
    // A marker payload quoting a sched_switch comm field is not a sched_switch event.
    const quoted = 'com.example.app-7200  ( 7200) [004] ...1  1000.000000: tracing_mark_write: '
      + 'B|7200|prev_comm=atrace next_comm=surfaceflinger ';
    expect(classifyTraceHead(text(...FTRACE_HEADER, quoted))).toMatchObject({os: 'unknown'});
  });

  it('labels a text trace carrying an Android build fingerprint android', () => {
    expect(classifyTraceHead(text(...FTRACE_HEADER, `# build: ${FINGERPRINT}`, APP_LINE))).toMatchObject({
      format: 'systrace_text',
      os: 'android',
    });
  });

  it('keeps Android AIDL slices without a system process unknown, and ArkTS-only text unknown', () => {
    const aidl = 'com.example.app-7200  ( 7200) [004] ...1  1000.000000: tracing_mark_write: '
      + 'B|7200|AIDL::cpp::ISurfaceComposerClient::createSurface::cppClient';
    expect(classifyTraceHead(text(...FTRACE_HEADER, aidl))).toMatchObject({format: 'systrace_text', os: 'unknown'});
    expect(classifyTraceHead(text(...FTRACE_HEADER, aidl, SURFACEFLINGER_LINE))).toMatchObject({
      format: 'systrace_text',
      os: 'android',
    });
    const arkts = 'com.example.app-7200  ( 7200) [004] ...1  1000.000000: tracing_mark_write: B|7200|H:ArkTS::onPageShow';
    expect(classifyTraceHead(text(...FTRACE_HEADER, arkts))).toMatchObject({format: 'systrace_text', os: 'unknown'});
  });

  it('recognizes an ftrace header on the first line and one that appears later', () => {
    expect(classifyTraceHead(text(...FTRACE_HEADER, SURFACEFLINGER_LINE)).format).toBe('systrace_text');
    expect(classifyTraceHead(text('captured by a wrapper script', ...FTRACE_HEADER, SURFACEFLINGER_LINE)))
      .toMatchObject({format: 'systrace_text', os: 'android'});
  });

  it('leaves unrecognized text and unrecognized binary unknown', () => {
    expect(classifyTraceHead(text('just some notes', 'nothing trace-like here at all'))).toMatchObject({
      format: 'unknown',
      os: 'unknown',
    });
    expect(classifyTraceHead(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toMatchObject({
      format: 'unknown',
      os: 'unknown',
    });
  });
});

describe('classifyTraceHead on adversarial heads', () => {
  // Without the look-behinds a full window of near-miss input backtracks
  // quadratically and takes seconds; the bound leaves room for a slow machine.
  const LINEAR_BOUND_MS = 1000;
  const window = (unit: string): string => unit.repeat(Math.ceil(TRACE_HEAD_SCAN_BYTES / unit.length))
    .slice(0, TRACE_HEAD_SCAN_BYTES - PROTOBUF_HEADER.length);

  it.each([
    ['one long component run', 'a'],
    ['slash-separated near-miss fingerprints', 'a/'],
    ['fingerprints missing the build type', 'b/p/d:1/X/2:/'],
    ['kernel release look-alikes', '1.'],
  ])('scans a protobuf window of %s in linear time', (_label, unit) => {
    const start = process.hrtime.bigint();
    const result = classifyTraceHead(protobuf(window(unit)));
    expect(Number(process.hrtime.bigint() - start) / 1e6).toBeLessThan(LINEAR_BOUND_MS);
    expect(result).toMatchObject({format: 'perfetto_protobuf', os: 'unknown'});
  });

  it('scans a text window of near-miss ftrace lines in linear time', () => {
    const line = '  app-7200  ( 7200) [004] ...1  1000.000000: sched_switch: prev_comm=x '.padEnd(120, 'y');
    const start = process.hrtime.bigint();
    const result = classifyTraceHead(text(...FTRACE_HEADER, window(`${line}\n`)));
    expect(Number(process.hrtime.bigint() - start) / 1e6).toBeLessThan(LINEAR_BOUND_MS);
    expect(result).toMatchObject({format: 'systrace_text', os: 'unknown'});
  });
});

describe('detectTraceFormat', () => {
  it('classifies the first 64 KB of a file', async () => {
    const early = writeFixture(Buffer.concat([protobuf(FINGERPRINT_FIELD), Buffer.alloc(TRACE_HEAD_SCAN_BYTES + 4096)]));
    await expect(detectTraceFormat(early)).resolves.toMatchObject({format: 'perfetto_protobuf', os: 'android'});

    const late = writeFixture(Buffer.concat([protobuf(), Buffer.alloc(TRACE_HEAD_SCAN_BYTES + 4096), Buffer.from(FINGERPRINT_FIELD, 'latin1')]));
    await expect(detectTraceFormat(late)).resolves.toMatchObject({format: 'perfetto_protobuf', os: 'unknown'});
  });
});

// The six canonical scene traces are real Android devices. Each contains `ace::`
// (inside names such as `ISurfaceComposerClient::`), which the former substring
// rule read as HarmonyOS, so these assertions fail under that rule.
describe('canonical scene traces', () => {
  it.each([
    'android-scroll-customer',
    'android-scroll-standard',
    'android-startup-heavy',
    'android-startup-light',
    'flutter-scroll-surface-view',
    'flutter-scroll-texture-view',
  ])('%s is Android over the whole file, the 64 KB window and the upload path', async (selector) => {
    const filePath = resolveTraceCase(selector);
    const whole = fs.readFileSync(filePath);
    expect(whole.includes('ace::')).toBe(true);

    expect(classifyTraceHead(whole)).toMatchObject({format: 'perfetto_protobuf', os: 'android'});
    const window = classifyTraceHead(whole.subarray(0, TRACE_HEAD_SCAN_BYTES));
    expect(window).toMatchObject({format: 'perfetto_protobuf', os: 'android'});
    expect(window.reason).toContain('android build fingerprint');
    await expect(detectTraceFormat(filePath)).resolves.toMatchObject({format: 'perfetto_protobuf', os: 'android'});
  }, 60_000);
});
