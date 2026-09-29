// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';

/**
 * Trace format and OS detector.
 *
 * Detection is content-based (magic bytes plus a bounded head scan), never
 * extension-based: users upload text traces with arbitrary extensions.
 *
 * Format and OS are separate questions. The format comes from the magic bytes;
 * the OS needs positive evidence and otherwise stays `unknown`, because a wrong
 * OS label is worse than none: it reaches the model's `trace_context` and can
 * steer it to the wrong rendering pipeline.
 *
 *   - `android` needs an Android build fingerprint, an Android kernel release
 *     token (binary traces), or an anchored ftrace task/comm field naming an
 *     Android-only system process (text traces).
 *   - `harmonyos` needs the documented hitrace first line on a text trace.
 *     Perfetto protobuf never yields `harmonyos`: no HarmonyOS producer of it
 *     is known.
 *
 * Substring tags such as `ace::` are deliberately not evidence: `ace::` matches
 * every `Surface::`/`Iface::`/`Interface::` in ordinary Android AIDL slice names.
 *
 * Formats:
 *   - perfetto_protobuf: Perfetto protobuf trace
 *   - systrace_text: ftrace/atrace text
 *   - atrace_text: HarmonyOS hitrace text output
 */

// ── Types ─────────────────────────────────────────────────────────────

export type TraceFormat =
  | 'perfetto_protobuf'
  | 'systrace_text'
  | 'atrace_text'
  | 'unknown';

export type TraceOs = 'android' | 'harmonyos' | 'unknown';

export interface TraceFormatInfo {
  format: TraceFormat;
  os: TraceOs;
  confidence: number; // 0..1
  detectionMethod: 'magic' | 'content_scan' | 'probe_query';
  /** Human-readable explanation for logging/debugging. */
  reason?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Bytes read from the file head for detection. */
export const TRACE_HEAD_SCAN_BYTES = 65536;

/**
 * HarmonyOS hitrace first line, as documented by OpenHarmony and as written by
 * `scripts/collect-harmonyos-ftrace.sh` (`hitrace --text -t N` with `2>&1`):
 * `2026/05/10 12:00:00 start capture, please wait 10s ...`. The duration
 * suffix is optional and bounded; nothing else may follow. Captures written
 * with `hitrace -o` carry no such line and stay `unknown`.
 */
const HITRACE_HEADER_RE =
  /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} start capture, please wait(?: \d{1,5}s(?: ?\.{3})?)?[ \t]*$/;

/**
 * Android build fingerprint (`Build.FINGERPRINT`):
 * `<brand>/<product>/<device>:<release>/<build id>/<incremental>:<type>/<tags>`
 * with type user|userdebug|eng and tags ending in `keys`. The release may be a
 * codename (`CinnamonBun`). Every component is drawn from a printable class
 * without `/` or `:`, so a match never crosses a non-printable protobuf byte.
 * The protobuf tag and length bytes around the string may themselves be
 * printable (android-scroll-customer stores `Q<fingerprint>r`), so the brand
 * may absorb a leading byte and the match ends at `keys` without a trailing
 * boundary; nothing reads the components. The look-behind only starts matching
 * at the beginning of a component run. It is what keeps the scan linear: without
 * it a 64 KB adversarial head takes seconds (quadratic backtracking).
 */
const FINGERPRINT_PART = '[A-Za-z0-9._+-]+';
const ANDROID_FINGERPRINT_RE = new RegExp(
  `(?<![A-Za-z0-9._+-])${FINGERPRINT_PART}/${FINGERPRINT_PART}/${FINGERPRINT_PART}`
  + `:${FINGERPRINT_PART}/${FINGERPRINT_PART}/${FINGERPRINT_PART}`
  + `:(?:user|userdebug|eng)/[A-Za-z0-9._,-]*keys`,
);

/**
 * Android (GKI) kernel release, e.g. `6.1.162-android14-11-g...`, as stored in
 * the Perfetto SystemInfo utsname. The byte before it may be a printable
 * length byte (`.6.6.89-android15-8-...`), so only a preceding digit is excluded.
 */
const ANDROID_KERNEL_RELEASE_RE = /(?<!\d)\d+\.\d+(?:\.\d+)?-android\d+-/;

/**
 * Android-only system processes, matched only in an ftrace task field
 * (`  surfaceflinger-642  (  642) [003] ...`) or a sched_switch
 * `prev_comm=`/`next_comm=` value, never as a bare substring. Names are the
 * kernel comm, truncated to 15 characters (`hwservicemanage`,
 * `android.hardwar`). `atrace` is the Android capture tool, which appears as a
 * sched comm near the head of every real-device systrace; `adbd` is not listed
 * because embedded Linux, Ubuntu Touch and Waydroid hosts ship it too.
 */
const ANDROID_SYSTEM_TASKS = [
  'surfaceflinger', 'system_server', 'servicemanager', 'hwservicemanage', 'vndservicemanag',
  'zygote', 'zygote64', 'android.hardwar', 'atrace',
];
const ANDROID_SYSTEM_TASK =
  `(?:${ANDROID_SYSTEM_TASKS.map(name => name.replace(/\./g, '\\.')).join('|')})`;
/**
 * A whole ftrace event line: `<comm>-<pid> [(<tgid>)] [<cpu>] [<flags>]
 * <sec>.<usec>: <event>:`. Evidence must sit in a real event line, so a line
 * that merely starts with `surfaceflinger-642` or a marker payload that quotes
 * `prev_comm=` proves nothing. Every part is bounded or a single non-space run.
 */
function ftraceEventLine(comm: string, event: string): string {
  return `^[ \\t]*${comm}-\\d+[ \\t]+(?:\\([ \\t]*[\\d-]+\\)[ \\t]+)?\\[\\d{3,}\\][ \\t]+`
    + `(?:[^ \\t\\n]+[ \\t]+)?\\d+\\.\\d+:[ \\t]+${event}:`;
}
/** An Android system task emitting any ftrace event. */
const ANDROID_TASK_FIELD_RE = new RegExp(ftraceEventLine(ANDROID_SYSTEM_TASK, '\\w+'), 'm');
/** An Android system task switched in or out, in a sched_switch event line (comm is at most 15 characters). */
const ANDROID_COMM_FIELD_RE = new RegExp(
  `${ftraceEventLine('[^\\n]{1,16}', 'sched_switch')}[^\\n]*?[ \\t](?:prev|next)_comm=${ANDROID_SYSTEM_TASK}[ \\t]`,
  'm',
);

// ── Evidence ──────────────────────────────────────────────────────────

interface OsEvidence {
  os: TraceOs;
  reason: string;
}

/** Android identity carried by binary (protobuf) trace metadata. */
function findBinaryAndroidEvidence(text: string): OsEvidence | null {
  if (ANDROID_FINGERPRINT_RE.test(text)) return {os: 'android', reason: 'android build fingerprint'};
  if (ANDROID_KERNEL_RELEASE_RE.test(text)) {
    return {os: 'android', reason: 'android kernel release'};
  }
  return null;
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  const line = newline < 0 ? text : text.slice(0, newline);
  return line.replace(/^\uFEFF/, '').replace(/\r$/, '');
}

/** OS evidence for a text trace. */
function findTextOsEvidence(text: string): OsEvidence | null {
  if (HITRACE_HEADER_RE.test(firstLine(text))) {
    return {os: 'harmonyos', reason: 'hitrace first-line header'};
  }
  if (ANDROID_TASK_FIELD_RE.test(text)) {
    return {os: 'android', reason: 'android system process in ftrace task field'};
  }
  if (ANDROID_COMM_FIELD_RE.test(text)) {
    return {os: 'android', reason: 'android system process in sched comm field'};
  }
  if (ANDROID_FINGERPRINT_RE.test(text)) {
    return {os: 'android', reason: 'android build fingerprint'};
  }
  return null;
}

// ── Classification ────────────────────────────────────────────────────

/**
 * Quick heuristic: text files have almost no NUL bytes in their first 512 bytes.
 */
function isLikelyText(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 512);
  let nullCount = 0;
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) nullCount++;
    if (nullCount > checkLen * 0.05) return false;
  }
  return true;
}

function explain(base: string, evidence: OsEvidence | null): string {
  return evidence ? `${base}; os=${evidence.os} (${evidence.reason})` : `${base}; os=unknown (no OS evidence)`;
}

/**
 * Classify a trace from the bytes of its head. Pure: the caller decides how
 * many bytes to pass (`detectTraceFormat` passes the first 64 KB).
 */
export function classifyTraceHead(head: Buffer): TraceFormatInfo {
  if (head.length >= 8 && head[0] === 0x0a) {
    // Perfetto protobuf: TracePacket field 1, wire type 2.
    const evidence = findBinaryAndroidEvidence(head.toString('latin1'));
    const base = 'magic: 0x0A TracePacket header';
    return {
      format: 'perfetto_protobuf',
      os: evidence?.os ?? 'unknown',
      confidence: 0.95,
      detectionMethod: evidence ? 'content_scan' : 'magic',
      reason: explain(base, evidence),
    };
  }

  if (!isLikelyText(head)) {
    const evidence = findBinaryAndroidEvidence(head.toString('latin1'));
    return {
      format: 'unknown',
      os: evidence?.os ?? 'unknown',
      confidence: 0.1,
      detectionMethod: 'probe_query',
      reason: explain('fallback: unrecognized binary format, will probe with trace_processor_shell', evidence),
    };
  }

  const text = head.toString('utf8');
  const evidence = findTextOsEvidence(text);
  if (evidence?.os === 'harmonyos') {
    return {
      format: 'atrace_text',
      os: 'harmonyos',
      confidence: 0.9,
      detectionMethod: 'content_scan',
      reason: explain('text: hitrace output', evidence),
    };
  }

  const start = text.slice(0, 512);
  if (start.includes('# tracer:') || start.includes('TRACE:')) {
    return {
      format: 'systrace_text',
      os: evidence?.os ?? 'unknown',
      confidence: 0.85,
      detectionMethod: 'content_scan',
      reason: explain('text: ftrace header "# tracer:" or "TRACE:"', evidence),
    };
  }

  return {
    format: 'unknown',
    os: evidence?.os ?? 'unknown',
    confidence: 0.5,
    detectionMethod: 'content_scan',
    reason: explain('text: unrecognized format', evidence),
  };
}

/**
 * Detect the format and OS of a trace file from its first 64 KB.
 *
 * @param filePath Absolute path to the trace file.
 */
export async function detectTraceFormat(filePath: string): Promise<TraceFormatInfo> {
  // Synchronous on purpose: the upload path creates the processor right after
  // detection, and its deletion/reload ordering (see
  // traceProcessorLeaseProcessorRouting.test.ts) assumes no I/O turn between.
  const head = Buffer.alloc(TRACE_HEAD_SCAN_BYTES);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(fd, head, 0, TRACE_HEAD_SCAN_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  return classifyTraceHead(head.subarray(0, bytesRead));
}
