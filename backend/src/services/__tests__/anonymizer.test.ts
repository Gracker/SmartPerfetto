// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {Anonymizer, LargeTraceStreamReporter} from '../anonymizer';

describe('Anonymizer', () => {
  it('returns the same placeholder for the same input', () => {
    const a = new Anonymizer();
    const p1 = a.redact('package', 'com.example.app');
    const p2 = a.redact('package', 'com.example.app');
    expect(p1).toBe(p2);
    expect(p1).toBe('app_1');
  });

  it('separates counters per domain', () => {
    const a = new Anonymizer();
    expect(a.redact('package', 'com.a')).toBe('app_1');
    expect(a.redact('process', 'main')).toBe('proc_1');
    expect(a.redact('package', 'com.b')).toBe('app_2');
    expect(a.redact('process', 'render')).toBe('proc_2');
  });

  it('redactString replaces every occurrence in a body', () => {
    const a = new Anonymizer();
    const body =
      '/data/data/com.example.app/files/x.db ' +
      'opened by com.example.app';
    const out = a.redactString('package', 'com.example.app', body);
    expect(out).not.toContain('com.example.app');
    expect(out).toMatch(/app_1/);
  });

  it('toContract returns redacted state with no pending domains', () => {
    const a = new Anonymizer();
    a.redact('package', 'com.x');
    const c = a.toContract();
    expect(c.state).toBe('redacted');
    expect(c.mappings).toHaveLength(1);
  });

  it('toContract returns partial state when pending domains supplied', () => {
    const a = new Anonymizer();
    a.redact('package', 'com.x');
    const c = a.toContract({pendingDomains: ['path']});
    expect(c.state).toBe('partial');
    expect(c.pendingDomains).toEqual(['path']);
  });
});

describe('LargeTraceStreamReporter', () => {
  it('accumulates chunk progress and clamps at totalBytes', () => {
    const reporter = new LargeTraceStreamReporter(1000);
    const a = reporter.report(400);
    const b = reporter.report(700);
    expect(a.processedBytes).toBe(400);
    expect(a.chunksEmitted).toBe(1);
    expect(b.processedBytes).toBe(1000);
    expect(b.done).toBe(true);
  });

  it('complete() marks done regardless of byte progress', () => {
    const reporter = new LargeTraceStreamReporter(2000);
    const final = reporter.complete();
    expect(final.done).toBe(true);
    expect(final.processedBytes).toBe(2000);
  });
});
