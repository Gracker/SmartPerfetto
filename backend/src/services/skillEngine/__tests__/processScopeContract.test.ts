// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Process-scoping contract for Skill SQL.
 *
 * A caller-supplied package/process must be matched as the exact process or as
 * an Android `package:child` subprocess. A bare `name GLOB target || '*'`
 * prefix silently absorbs unrelated processes that merely share a prefix, which
 * inflates counts and can attribute another app's slices to the target.
 *
 * Real collisions observed in a captured vendor trace:
 *   com.android.chrome      -> com.android.chrome_zygote
 *   com.google.android.gm   -> com.google.android.gms(.persistent/.ui/.unstable)
 *   com.android.se          -> com.android.settings
 *
 * Candidate discovery/scoring (process_identity_resolver) intentionally uses
 * fuzzy prefix matching to *rank* candidates and is not a scoping filter, so
 * this contract targets the `input`-CTE scoping idiom only.
 */

import path from 'path';
import fs from 'fs';
import { describe, it, expect } from '@jest/globals';

const skillsRoot = path.join(process.cwd(), 'skills');

function listFilesRecursive(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, exts));
    else if (exts.some(e => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSkillFiles(full));
    else if (entry.name.endsWith('.skill.yaml')) out.push(full);
  }
  return out;
}

describe('Skill process scoping', () => {
  // process_slice_cpu_hotspots resolves precisely through i.target_upid and
  // keeps an explicitly fuzzy name fallback that also matches with
  // LIKE '%name%'. Tightening only its GLOB would be cosmetic because the
  // adjacent substring match is strictly looser. It is listed here so it stays
  // visible and cannot grow silently; narrowing that fallback needs its own
  // root-cause review.
  const FUZZY_DISCOVERY_ALLOWLIST = new Set(['atomic/process_slice_cpu_hotspots.skill.yaml']);

  it('never scopes a target process with a bare prefix glob', () => {
    const offenders: string[] = [];
    for (const file of listSkillFiles(skillsRoot)) {
      const rel = path.relative(skillsRoot, file);
      if (FUZZY_DISCOVERY_ALLOWLIST.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (/GLOB\s+i\.target_process\s*\|\|\s*'\*'/.test(line)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the fuzzy-discovery allowlist minimal and accurate', () => {
    for (const rel of FUZZY_DISCOVERY_ALLOWLIST) {
      const text = fs.readFileSync(path.join(skillsRoot, rel), 'utf-8');
      // Still fuzzy (otherwise remove it from the allowlist)...
      expect(text).toMatch(/GLOB\s+i\.target_process\s*\|\|\s*'\*'/);
      // ...and only allowed because a precise upid path exists alongside it.
      expect(text).toContain('i.target_upid');
    }
  });

  it('never prefix-globs a process or package column against another column', () => {
    // e.g. `p.name GLOB dp.pkg || '*'` or `bt.client_process GLOB s.package || '*'`.
    // These absorb prefix-sharing siblings exactly like the target_process form.
    const offenders: string[] = [];
    const pattern = /\b(?:p\.name|client_process|process_name)\s+GLOB\s+[A-Za-z_][\w.]*\s*\|\|\s*'\*'/;
    for (const file of listSkillFiles(skillsRoot)) {
      const rel = path.relative(skillsRoot, file);
      if (FUZZY_DISCOVERY_ALLOWLIST.has(rel)) continue;
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('never scopes any Skill or Strategy with a bare package prefix', () => {
    // scrollingAnalysisSchema already enforced this for the scrolling skill.
    // The same idiom existed across ~150 sites repo-wide; keep it from returning.
    const offenders: string[] = [];
    const bad = [
      /(?<![\w.])[A-Za-z_][A-Za-z0-9_.]*\s+(?:NOT\s+)?GLOB\s+'\$\{package\}\*'/,
      /(?<![\w.])[A-Za-z_][A-Za-z0-9_.]*\s+(?:NOT\s+)?LIKE\s+'\$\{package\}%'/,
      /(?<![\w.])[A-Za-z_][A-Za-z0-9_.]*\s+(?:NOT\s+)?GLOB\s+'\{process_name\}\*'/,
    ];
    const roots = [skillsRoot, path.join(process.cwd(), 'strategies')];
    for (const root of roots) {
      for (const file of listFilesRecursive(root, ['.skill.yaml', '.sql', '.md', '.yaml'])) {
        const rel = path.relative(process.cwd(), file);
        fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
          if (bad.some(re => re.test(line))) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps generators from reintroducing the bare prefix on regeneration', () => {
    // rendering_pipeline_detection.skill.yaml is generated. Hand-fixing the YAML
    // is silently reverted by `npm run generate:pipeline-detection`, so the
    // generator source must carry the contract too. It escapes the token as
    // '\${package}' inside TS template literals, which a YAML-only scan misses.
    const generators = [
      path.join(process.cwd(), 'src/services/renderingPipelineDetectionSkillGenerator.ts'),
    ];
    for (const file of generators) {
      const text = fs.readFileSync(file, 'utf-8');
      expect(text).not.toMatch(/p\.name\s+GLOB\s+'\\\$\{package\}\*'/);
      expect(text).not.toMatch(/p\.name\s+GLOB\s+dp\.pkg\s*\|\|\s*'\*'/);
    }
  });

  it('pairs every target_process child glob with an exact-name match', () => {
    // `p.name GLOB target || ':*'` alone would match only subprocesses, so the
    // exact-name branch must always accompany it.
    const missingExact: string[] = [];
    for (const file of listSkillFiles(skillsRoot)) {
      const rel = path.relative(skillsRoot, file);
      const text = fs.readFileSync(file, 'utf-8');
      if (!/GLOB\s+i\.target_process\s*\|\|\s*':\*'/.test(text)) continue;
      if (!/p\.name\s*=\s*i\.target_process/.test(text)) missingExact.push(rel);
    }
    expect(missingExact).toEqual([]);
  });
});
