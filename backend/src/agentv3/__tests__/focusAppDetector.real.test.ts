// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Real-trace gate for focus-app detection: the pinned trace_processor_shell
// runs the detector's own SQL on the canonical corpus and the ranking must
// keep today's answers. Every statement must succeed — a failed query would
// otherwise read as an empty trace.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import {randomUUID} from 'crypto';
import {WorkingTraceProcessor} from '../../services/workingTraceProcessor';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {resolveTraceCase} from '../../utils/traceCorpus';
import {detectFocusApps} from '../focusAppDetector';

jest.setTimeout(120_000);
const processors: WorkingTraceProcessor[] = [];
afterEach(() => {for (const processor of processors.splice(0)) processor.destroy();});

const CASES = [
  {selector: 'android-scroll-customer', primary: 'com.example.wechatfriendforcustomscroller',
    confidence: 'high', method: 'frame_timeline'},
  {selector: 'android-scroll-standard', primary: 'com.example.wechatfriendforcustomscroller',
    confidence: 'high', method: 'frame_timeline'},
  {selector: 'android-startup-heavy', primary: 'com.example.launch.aosp.heavy',
    confidence: 'high', method: 'battery_stats'},
  {selector: 'android-startup-light', primary: 'com.example.androidappdemo',
    confidence: 'high', method: 'battery_stats'},
  // No oom_adj, FrameTimeline or battery data: CPU activity of app uids only.
  {selector: 'flutter-scroll-surface-view', primary: 'com.tencent.mm',
    confidence: 'medium', method: 'sched_activity'},
  {selector: 'flutter-scroll-texture-view', primary: 'com.example.friendscircle.v27.textureview',
    confidence: 'high', method: 'frame_timeline'},
] as const;

async function openTrace(selector: string): Promise<{service: TraceProcessorService; traceId: string; errors: string[]}> {
  const tracePath = resolveTraceCase(selector);
  if (!fs.existsSync(tracePath)) throw new Error(`${selector} is not available at ${tracePath}`);
  const traceId = `focus-app-real-${randomUUID()}`;
  const processor = new WorkingTraceProcessor(traceId, tracePath);
  processors.push(processor);
  await processor.initialize();
  const errors: string[] = [];
  const service = {query: async (_id: string, sql: string) => {
    const result = await processor.query(sql);
    if (result.error) errors.push(`${result.error.split('\n')[0]} <- ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    return result;
  }} as unknown as TraceProcessorService;
  return {service, traceId, errors};
}

describe('focus-app detection on the pinned trace processor', () => {
  it.each(CASES)('$selector -> $primary ($confidence, $method)', async ({selector, primary, confidence, method}) => {
    const {service, traceId, errors} = await openTrace(selector);
    const result = await detectFocusApps(service, traceId);

    expect(errors).toEqual([]);
    expect(result).toMatchObject({primaryApp: primary, confidence, method});
    expect(result.apps[0]).toMatchObject({packageName: primary, signals: expect.objectContaining({
      runningNs: expect.any(Number)})});
    expect(result.apps[0].signals!.runningNs).toBeGreaterThan(0);
  });
});
