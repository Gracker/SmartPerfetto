// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';

/**
 * Smart trace format and OS detector.
 *
 * Detection is content-based (magic bytes + content scanning), not extension-based.
 * This is important because users may upload HarmonyOS text traces with arbitrary
 * extensions (.trace, .txt, etc.).
 *
 * Two-layer strategy:
 *   Layer 1 — Magic bytes (zero-cost, first 128 bytes)
 *   Layer 2 — Content feature scan (sample first 64KB)
 *
 * Supported formats:
 *   - perfetto_protobuf: standard Perfetto protobuf traces (Android)
 *   - systrace_text: standard Android systrace/atrace text
 *   - atrace_text: HarmonyOS hitrace text output (standard ftrace text with HarmonyOS markers)
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

/** Strong HarmonyOS atrace tags. Each can independently refine OS detection. */
const HARMONYOS_ATRACE_TAGS = [
  'ace::',
  'ArkTS',
  'ark_ts',
  'RSRender',
  'RenderService',
  'FFRT',
  'ffrt::',
  'Hiperf',
  'hiperf',
  'Hisysevent',
  'hitrace',
  'HiViewNode',
  'AppExecFwk',
  'AbilityManagerService',
  'ohos.',
] as const;

// Do not classify on the generic `H:` tracing_mark_write prefix alone. Android
// traces can legitimately contain markers such as `H:CPU_LOAD_RESET`; HarmonyOS
// classification needs a hitrace header, a Harmony-only process, or a strong tag.

/**
 * HarmonyOS-specific process/command names that appear in ftrace text output.
 * These are kernel thread and system service names unique to HarmonyOS.
 */
const HARMONYOS_PROCESS_PATTERNS = [
  /sysmgr-reclaim/i,
  /OS_IPC_\d/i,
  /tppmgr-idle/i,
  /udk-irq/i,
  /para_anon_recla/i,
  /sysmgr\.elf/i,
] as const;

/** HarmonyOS hitrace header: "YYYY/MM/DD HH:MM:SS start capture, please wait" */
const HITRACE_HEADER_RE = /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+start capture/i;

/** Maximum bytes to read from the file head for detection. */
const SCAN_SIZE = 65536; // 64KB

// ── Layer 1: Magic bytes ──────────────────────────────────────────────

/**
 * Examine the first bytes of a file to identify the trace format.
 *
 * Signatures observed from real files:
 *   Perfetto protobuf: 0a xx ... (TracePacket field tag)
 *   Systrace/atrace text: starts with date string or "# tracer:"
 */
function detectByMagicBytes(head: Buffer): { format: TraceFormat; reason: string } | null {
  if (head.length < 8) return null;

  // Perfetto protobuf: starts with 0x0A (TracePacket field 1, wire type 2 = length-delimited)
  if (head[0] === 0x0a) {
    return { format: 'perfetto_protobuf', reason: 'magic: 0x0A TracePacket header' };
  }

  // Systrace/atrace text: starts with a date string like "2026/05/10" or "# tracer:"
  const headStr = head.toString('utf8', 0, Math.min(head.length, 256));
  if (headStr.startsWith('# tracer:') || headStr.startsWith('TRACE:')) {
    return { format: 'systrace_text', reason: 'magic: text header "# tracer:" or "TRACE:"' };
  }
  // hitrace text output starts with date string
  if (/^\d{4}\/\d{2}\/\d{2}/.test(headStr) && headStr.includes('# tracer:')) {
    return { format: 'systrace_text', reason: 'magic: date header + "# tracer:"' };
  }

  return null;
}

// ── Layer 2: Content feature scan ─────────────────────────────────────

/**
 * Scan file content for OS-specific markers.
 * Used when magic bytes are inconclusive or to refine OS detection.
 */
function detectByContentScan(head: Buffer): { os: TraceOs; reason: string } | null {
  const headStr = head.toString('utf8', 0, Math.min(head.length, SCAN_SIZE));

  // Check for HarmonyOS hitrace header ("YYYY/MM/DD HH:MM:SS start capture, please wait")
  const firstLine = headStr.split('\n')[0] ?? '';
  if (HITRACE_HEADER_RE.test(firstLine)) {
    return { os: 'harmonyos', reason: `content_scan: hitrace header "${firstLine.trim()}"` };
  }

  // Check for HarmonyOS-specific process names in ftrace lines
  for (const pat of HARMONYOS_PROCESS_PATTERNS) {
    if (pat.test(headStr)) {
      return { os: 'harmonyos', reason: `content_scan: HarmonyOS process name "${pat.source}"` };
    }
  }

  // Check for HarmonyOS atrace markers
  for (const marker of HARMONYOS_ATRACE_TAGS) {
    if (headStr.includes(marker)) {
      return { os: 'harmonyos', reason: `content_scan: found HarmonyOS marker "${marker}"` };
    }
  }

  return null;
}

/**
 * Detect OS from text-format systrace/atrace content.
 * Scans for HarmonyOS-specific markers in the trace body.
 */
function detectOsFromTextContent(head: Buffer): TraceOs {
  const headStr = head.toString('utf8', 0, Math.min(head.length, SCAN_SIZE));

  // Check hitrace header
  const firstLine = headStr.split('\n')[0] ?? '';
  if (HITRACE_HEADER_RE.test(firstLine)) {
    return 'harmonyos';
  }

  // Check HarmonyOS process names
  for (const pat of HARMONYOS_PROCESS_PATTERNS) {
    if (pat.test(headStr)) return 'harmonyos';
  }

  // Check HarmonyOS atrace tags
  for (const tag of HARMONYOS_ATRACE_TAGS) {
    if (headStr.includes(tag)) return 'harmonyos';
  }

  return 'android'; // default for text traces
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Detect the format and OS of a trace file by inspecting its content.
 *
 * @param filePath Absolute path to the trace file.
 * @returns TraceFormatInfo with format, os, confidence, and detection method.
 */
export async function detectTraceFormat(filePath: string): Promise<TraceFormatInfo> {
  // Read up to SCAN_SIZE bytes from file head
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(SCAN_SIZE);
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(fd, head, 0, SCAN_SIZE, 0);
  } finally {
    fs.closeSync(fd);
  }

  const actualHead = head.subarray(0, bytesRead);

  // ── Layer 1: Magic bytes ──
  const magicResult = detectByMagicBytes(actualHead);

  if (magicResult) {
    const format = magicResult.format;

    if (format === 'perfetto_protobuf') {
      // Perfetto protobuf → typically Android, but scan for HarmonyOS markers just in case
      const osResult = detectByContentScan(actualHead);
      if (osResult && osResult.os === 'harmonyos') {
        return {
          format: 'perfetto_protobuf',
          os: 'harmonyos',
          confidence: 0.9,
          detectionMethod: 'content_scan',
          reason: `${magicResult.reason}; ${osResult.reason}`,
        };
      }
      return {
        format: 'perfetto_protobuf',
        os: 'android',
        confidence: 0.95,
        detectionMethod: 'magic',
        reason: magicResult.reason,
      };
    }

    if (format === 'systrace_text') {
      // Text format — detect OS by content
      const os = detectOsFromTextContent(actualHead);
      const isHarmony = os === 'harmonyos';
      return {
        format: isHarmony ? 'atrace_text' : 'systrace_text',
        os,
        confidence: isHarmony ? 0.9 : 0.85,
        detectionMethod: 'content_scan',
        reason: `${magicResult.reason}; OS=${os}`,
      };
    }
  }

  // ── Layer 2: Content scan (magic bytes inconclusive) ──
  const contentOs = detectByContentScan(actualHead);

  // Check if file is text or binary
  const isText = isLikelyText(actualHead);

  if (isText) {
    // Text file — check for ftrace markers
    const headStr = actualHead.toString('utf8', 0, Math.min(actualHead.length, 512));
    const hasFtraceHeader = headStr.includes('# tracer:') || headStr.includes('TRACE:');

    if (contentOs && contentOs.os === 'harmonyos') {
      return {
        format: 'atrace_text',
        os: 'harmonyos',
        confidence: 0.85,
        detectionMethod: 'content_scan',
        reason: contentOs.reason,
      };
    }

    if (hasFtraceHeader) {
      return {
        format: 'systrace_text',
        os: 'android',
        confidence: 0.8,
        detectionMethod: 'content_scan',
        reason: 'content_scan: text file with ftrace header, no HarmonyOS markers',
      };
    }

    // Text file without ftrace header — could be partial trace
    return {
      format: 'unknown',
      os: contentOs?.os ?? 'unknown',
      confidence: 0.5,
      detectionMethod: 'content_scan',
      reason: contentOs?.reason ?? 'content_scan: text file, unrecognized format',
    };
  }

  // ── Layer 3: Fallback ──
  // Binary file not identified as Perfetto protobuf — let trace_processor_shell try
  return {
    format: 'unknown',
    os: contentOs?.os ?? 'unknown',
    confidence: 0.1,
    detectionMethod: 'probe_query',
    reason: 'fallback: unrecognized binary format, will probe with trace_processor_shell',
  };
}

/**
 * Quick heuristic to check if a buffer is likely text (UTF-8) or binary.
 * Checks for common binary byte patterns in the first 512 bytes.
 */
function isLikelyText(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 512);
  let nullCount = 0;
  for (let i = 0; i < checkLen; i++) {
    const b = buf[i];
    // Count null bytes — binary files have many, text files have very few
    if (b === 0) nullCount++;
    // Early exit: if >5% null bytes, likely binary
    if (nullCount > checkLen * 0.05) return false;
  }
  return true;
}

/**
 * Synchronous version for use in non-async contexts (e.g., factory constructors).
 * Reads only up to SCAN_SIZE bytes.
 */
export function detectTraceFormatSync(filePath: string): TraceFormatInfo {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(SCAN_SIZE);
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(fd, head, 0, SCAN_SIZE, 0);
  } finally {
    fs.closeSync(fd);
  }

  const actualHead = head.subarray(0, bytesRead);

  const magicResult = detectByMagicBytes(actualHead);
  if (magicResult) {
    const format = magicResult.format;
    if (format === 'perfetto_protobuf') {
      const osResult = detectByContentScan(actualHead);
      if (osResult?.os === 'harmonyos') {
        return { format: 'perfetto_protobuf', os: 'harmonyos', confidence: 0.9, detectionMethod: 'content_scan', reason: `${magicResult.reason}; ${osResult.reason}` };
      }
      return { format: 'perfetto_protobuf', os: 'android', confidence: 0.95, detectionMethod: 'magic', reason: magicResult.reason };
    }
    if (format === 'systrace_text') {
      const os = detectOsFromTextContent(actualHead);
      const isHarmony = os === 'harmonyos';
      return { format: isHarmony ? 'atrace_text' : 'systrace_text', os, confidence: isHarmony ? 0.9 : 0.85, detectionMethod: 'content_scan', reason: `${magicResult.reason}; OS=${os}` };
    }
  }

  const contentOs = detectByContentScan(actualHead);
  const isTextFile = isLikelyText(actualHead);
  if (isTextFile) {
    if (contentOs?.os === 'harmonyos') {
      return { format: 'atrace_text', os: 'harmonyos', confidence: 0.85, detectionMethod: 'content_scan', reason: contentOs.reason };
    }
    const headStr = actualHead.toString('utf8', 0, Math.min(actualHead.length, 512));
    if (headStr.includes('# tracer:') || headStr.includes('TRACE:')) {
      return { format: 'systrace_text', os: 'android', confidence: 0.8, detectionMethod: 'content_scan', reason: 'content_scan: text file with ftrace header' };
    }
    return { format: 'unknown', os: contentOs?.os ?? 'unknown', confidence: 0.5, detectionMethod: 'content_scan', reason: 'content_scan: text file, unrecognized' };
  }

  return { format: 'unknown', os: contentOs?.os ?? 'unknown', confidence: 0.1, detectionMethod: 'probe_query', reason: 'fallback: unrecognized binary format' };
}
