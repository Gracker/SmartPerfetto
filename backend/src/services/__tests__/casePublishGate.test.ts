// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {ingestCaseKnowledge} from '../caseIngester';
import {CaseLibrary} from '../caseLibrary';
import {caseCurationGrantForMarkdownIngest} from '../security/caseCuration';

let tmpDir: string;
let casesDir: string;
let caseLibraryPath: string;
let caseGraphPath: string;
let ragStorePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-publish-gate-test-'));
  casesDir = path.join(tmpDir, 'cases');
  caseLibraryPath = path.join(tmpDir, 'case_library.json');
  caseGraphPath = path.join(tmpDir, 'case_graph.json');
  ragStorePath = path.join(tmpDir, 'rag_store.json');
  fs.mkdirSync(casesDir, {recursive: true});
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function writePublishedCase(withCurator: boolean): void {
  fs.writeFileSync(
    path.join(casesDir, 'published.md'),
    `---
case_id: scroll_shader_compile_pixel8_001
title: Published shader compile case
status: published
quality: curated
scene: scrolling
domain_pack: scrolling.v1
${withCurator ? 'curator: perf-team\n' : ''}taxonomy:
  primary_root_cause: shader_compile
  secondary_root_causes: [render_thread_heavy]
  responsibility: app
  severity: critical
context:
  app_architecture: android_view_standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll
evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: shader_compile
  supportive:
    - field: jank_responsibility
      op: eq
      value: APP
findings:
  - id: f1
    title: Shader compilation overlaps a dropped frame
    evidence_refs: []
    confidence: high
recommendations:
  app:
    - id: app_precompile_shader
      priority: P0
      action: Precompile shaders before first scroll.
      applies_when: Shader compile slices overlap dropped-frame windows.
      risks: Warmup can move cost earlier.
  oem:
    - id: oem_gpu_freq_floor
      priority: P1
      action: Inspect GPU and RenderThread scheduling response.
      applies_when: Shader work remains after app-side precompile.
      risks: Frequency policy can increase power.
relations:
  similar_root_cause: []
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: []
  contradicts: []
---

## Summary

Published Markdown case body.
`,
    'utf-8',
  );
}

function ingest() {
  return ingestCaseKnowledge({
    casesDir,
    grant: caseCurationGrantForMarkdownIngest(),
    caseLibraryPath,
    caseGraphPath,
    ragStorePath,
  });
}

describe('case Markdown publish gate', () => {
  it('publishes a Markdown-sourced case through CaseLibrary.publishCase()', () => {
    writePublishedCase(true);

    ingest();

    const stored = new CaseLibrary(caseLibraryPath).getCase(
      'scroll_shader_compile_pixel8_001',
    );
    expect(stored?.status).toBe('published');
    expect(stored?.redactionState).toBe('redacted');
    expect(stored?.curatedBy).toBe('perf-team');
  });

  it('rejects status=published when curator is missing', () => {
    writePublishedCase(false);

    expect(() => ingest()).toThrow(/curator/);
    expect(new CaseLibrary(caseLibraryPath).listCases()).toEqual([]);
  });
});
