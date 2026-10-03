// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {parseCaseMarkdown} from '../caseMarkdownParser';
import {validateParsedCaseFiles} from '../caseSchemaValidator';
import type {ParsedCaseMarkdown} from '../../types/caseKnowledge';

function parseValid(content: string, filePath = 'case.md'): ParsedCaseMarkdown {
  const result = parseCaseMarkdown(filePath, content);
  if (!result.ok) {
    throw new Error(result.issues.map(issue => issue.message).join('\n'));
  }
  return result.parsed;
}

function validCase(overrides = ''): string {
  return `---
case_id: scroll_shader_compile_pixel8_001
title: Shader compile during scroll
status: reviewed
quality: curated
scene: scrolling
domain_pack: scrolling.v1
curator: perf-team
taxonomy:
  primary_root_cause: shader_compile
  secondary_root_causes: [render_thread_heavy]
  responsibility: app
  severity: critical
context:
  app_architecture: standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll
evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: shader_compile
    - field: render_slices
      op: contains_any
      value: ["compileShader", "makePipeline"]
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
      action: Precompile or warm up shaders before the first scroll.
      applies_when: Shader compilation slices overlap dropped-frame windows.
      risks: Warmup can move CPU and memory cost earlier in the flow.
  oem:
    - id: oem_gpu_freq_floor
      priority: P1
      action: Inspect GPU and RenderThread scheduling response during warmup.
      applies_when: Shader work remains after app-side precompile.
      risks: Frequency policy changes can increase power.
relations:
  similar_root_cause: []
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: []
  contradicts: []
${overrides}
---

## Summary

Shader compilation blocked the scroll frame.
`;
}

describe('caseSchemaValidator', () => {
  it('accepts a complete curated scrolling case', () => {
    const parsed = parseValid(validCase());

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases[0].frontmatter.case_id).toBe(
      'scroll_shader_compile_pixel8_001',
    );
  });

  it('rejects missing common required fields', () => {
    const parsed = parseValid(validCase().replace('title: Shader compile during scroll\n', ''));

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /title/,
    );
  });

  it('requires a curator for published Markdown cases', () => {
    const parsed = parseValid(
      validCase()
        .replace('status: reviewed', 'status: published')
        .replace('curator: perf-team\n', ''),
    );

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /curator/,
    );
  });

  it('requires both app and oem recommendation arrays', () => {
    const parsed = parseValid(validCase().replace('  oem:\n    - id: oem_gpu_freq_floor\n      priority: P1\n      action: Inspect GPU and RenderThread scheduling response during warmup.\n      applies_when: Shader work remains after app-side precompile.\n      risks: Frequency policy changes can increase power.\n', ''));

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /recommendations\.oem/,
    );
  });

  it('rejects non-string evidence_refs entries instead of dropping them', () => {
    const parsed = parseValid(
      validCase().replace('    evidence_refs: []', '    evidence_refs: [123]'),
    );

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /evidence_refs/,
    );
  });

  it('rejects the retired learned-case id prefix, so an exported learned case cannot come back as curated', () => {
    const parsed = parseValid(validCase().replace(
      'case_id: scroll_shader_compile_pixel8_001',
      "case_id: 'learned:0123456789abcdef'",
    ));

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /retired learned cases/,
    );
  });

  it('rejects a relation to a retired learned case before ingest writes anything', () => {
    const parsed = parseValid(validCase().replace(
      '  similar_root_cause: []',
      "  similar_root_cause: ['learned:0123456789abcdef']",
    ));

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /relations\.similar_root_cause links the retired learned case/,
    );
  });

  it.each([
    ['any', 'any'],
    ['one detector architecture', 'flutter'],
    ['a list of detector architectures', '[standard, compose]'],
  ])('accepts context.app_architecture as %s', (_label, value) => {
    const parsed = parseValid(
      validCase().replace('app_architecture: standard', `app_architecture: ${value}`),
    );

    expect(validateParsedCaseFiles([parsed]).ok).toBe(true);
  });

  it.each([
    ['missing', ''],
    ['a value outside the detector vocabulary', '  app_architecture: android_view_standard\n'],
    ['the detector spelling instead of the case spelling', '  app_architecture: STANDARD\n'],
    ['unknown, which declares nothing', '  app_architecture: unknown\n'],
    ['any mixed into a list', '  app_architecture: [any, standard]\n'],
    ['an empty list', '  app_architecture: []\n'],
    ['a list with a repeated architecture', '  app_architecture: [standard, standard]\n'],
  ])('rejects context.app_architecture when it is %s', (_label, line) => {
    const parsed = parseValid(
      validCase().replace('  app_architecture: standard\n', line),
    );

    const result = validateParsedCaseFiles([parsed]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({fieldPath: 'context.app_architecture'}),
    ]);
  });

  it('rejects duplicate case_id values across files', () => {
    const first = parseValid(validCase(), 'one.md');
    const second = parseValid(validCase(), 'two.md');

    const result = validateParsedCaseFiles([first, second]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(issue => issue.message).join('\n')).toMatch(
      /duplicate case_id/i,
    );
  });
});
