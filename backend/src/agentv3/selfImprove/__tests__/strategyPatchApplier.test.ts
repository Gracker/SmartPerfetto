// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { applyPhaseHintPatch } from '../strategyPatchApplier';

const SAMPLE_STRATEGY = `<!-- license header -->

---
scene: scrolling
keywords:
  - 滑动
phase_hints:
  - id: overview
    keywords: ['概览']
    constraints: 'must call scrolling_analysis first'
    critical_tools: ['scrolling_analysis']
    critical: true
---

# Strategy body markdown lives below the frontmatter.

This is preserved verbatim across patches.
`;

const SAMPLE_ENTRY = yaml.dump([{
  id: 'auto_misdiagnosis_vsync_vrr_abc12345',
  keywords: ['vsync', 'vrr'],
  constraints: 'invoke vsync_dynamics_analysis first',
  critical_tools: ['vsync_dynamics_analysis'],
  critical: false,
  auto_generated: true,
  applied_at: 1_700_000_000_000,
  evidence: 'evidence text',
}]);

describe('applyPhaseHintPatch', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-strategy-patch-'));
    file = path.join(dir, 'scrolling.strategy.md');
    fs.writeFileSync(file, SAMPLE_STRATEGY);
  });

  it('appends a fresh phase_hint entry', () => {
    const result = applyPhaseHintPatch(file, SAMPLE_ENTRY);
    expect(result.ok).toBe(true);
    expect(result.appended).toBe(true);

    const updated = fs.readFileSync(file, 'utf-8');
    const match = updated.match(/^([\s\S]*?\n)?---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    const frontmatter = yaml.load(match![2]) as Record<string, unknown>;
    const hints = frontmatter.phase_hints as Array<Record<string, unknown>>;
    expect(hints).toHaveLength(2);
    expect(hints[1].id).toBe('auto_misdiagnosis_vsync_vrr_abc12345');
    // Markdown body preserved verbatim.
    expect(match![3]).toContain('Strategy body markdown lives below');
  });

  it('returns file_missing when the strategy file does not exist', () => {
    const result = applyPhaseHintPatch(path.join(dir, 'nope.strategy.md'), SAMPLE_ENTRY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('file_missing');
  });

  it('returns no_frontmatter when frontmatter delimiters are absent', () => {
    fs.writeFileSync(file, '# just markdown, no frontmatter\n');
    const result = applyPhaseHintPatch(file, SAMPLE_ENTRY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_frontmatter');
  });

  it('returns parse_error for a non-array rendered entry', () => {
    const bad = yaml.dump({ not: 'an array' });
    const result = applyPhaseHintPatch(file, bad);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('parse_error');
  });

  it('replaces an existing auto_generated entry with the same id (idempotent re-render)', () => {
    // First apply.
    expect(applyPhaseHintPatch(file, SAMPLE_ENTRY).ok).toBe(true);
    // Second apply with new evidence/constraints but same id.
    const updatedEntry = yaml.dump([{
      id: 'auto_misdiagnosis_vsync_vrr_abc12345',
      keywords: ['vsync', 'vrr', 'extra'],
      constraints: 'updated constraint',
      critical_tools: ['vsync_dynamics_analysis'],
      critical: false,
      auto_generated: true,
      applied_at: 1_700_000_000_001,
      evidence: 'new evidence',
    }]);
    const result = applyPhaseHintPatch(file, updatedEntry);
    expect(result.ok).toBe(true);
    expect(result.appended).toBe(false);

    const after = fs.readFileSync(file, 'utf-8');
    const match = after.match(/^([\s\S]*?\n)?---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const fm = yaml.load(match![2]) as Record<string, unknown>;
    const hints = fm.phase_hints as Array<Record<string, unknown>>;
    expect(hints).toHaveLength(2);
    const overwritten = hints.find(h => h.id === 'auto_misdiagnosis_vsync_vrr_abc12345')!;
    expect(overwritten.constraints).toBe('updated constraint');
    expect(overwritten.evidence).toBe('new evidence');
  });

  it('refuses to overwrite a hand-written hint with the same id', () => {
    // Pre-populate the file with a hand-written hint that happens to share
    // the auto id (no auto_generated flag).
    const handWritten = SAMPLE_STRATEGY.replace(
      '  - id: overview',
      "  - id: auto_misdiagnosis_vsync_vrr_abc12345\n    keywords: ['hand']\n    constraints: 'hand written'\n    critical_tools: ['x']\n    critical: true\n  - id: overview",
    );
    fs.writeFileSync(file, handWritten);
    const result = applyPhaseHintPatch(file, SAMPLE_ENTRY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('duplicate_id');
  });
});
