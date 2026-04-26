// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Apply a rendered phase_hint entry to a `.strategy.md` file inside a
 * worktree. The patch is YAML-only — markdown body is preserved verbatim,
 * frontmatter is round-tripped through js-yaml so the resulting structure
 * matches what `strategyLoader.ts` already parses.
 *
 * Trust boundary: the renderer (phaseHintsRenderer.ts) has already validated
 * + security-scanned the entry. This module only handles file IO.
 *
 * The two-step "render → apply" split lets the orchestrator decide whether
 * to land the patch in the developer worktree, a tmp worktree (PR9c real
 * flow), or just preview the diff for a human reviewer.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^([\s\S]*?\n)?---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export interface ApplyPatchResult {
  ok: boolean;
  reason?: 'file_missing' | 'no_frontmatter' | 'parse_error' | 'duplicate_id' | 'io_error';
  details?: string;
  /** Whether the entry was appended (true) or replaced an existing auto-id (false). */
  appended?: boolean;
}

/**
 * Append a rendered phase_hints YAML entry to `strategyFilePath`. The
 * entry must be a single-element array (the renderer's normal output).
 * Returns a structured result so the orchestrator can map to worktree
 * cleanup without try/catch.
 */
export function applyPhaseHintPatch(
  strategyFilePath: string,
  renderedEntryYaml: string,
): ApplyPatchResult {
  if (!fs.existsSync(strategyFilePath)) {
    return { ok: false, reason: 'file_missing', details: strategyFilePath };
  }

  const raw = fs.readFileSync(strategyFilePath, 'utf-8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { ok: false, reason: 'no_frontmatter', details: 'no `---\\n…\\n---` block found' };

  const prefix = match[1] ?? '';
  const frontmatterText = match[2];
  const body = match[3];

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = yaml.load(frontmatterText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'parse_error', details: 'frontmatter is not a YAML mapping' };
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: 'parse_error', details: (err as Error).message };
  }

  let entry: unknown;
  try {
    const parsedEntry = yaml.load(renderedEntryYaml);
    if (!Array.isArray(parsedEntry) || parsedEntry.length !== 1) {
      return { ok: false, reason: 'parse_error', details: 'rendered entry must be a 1-element YAML array' };
    }
    entry = parsedEntry[0];
  } catch (err) {
    return { ok: false, reason: 'parse_error', details: (err as Error).message };
  }

  const existingHints = Array.isArray(frontmatter.phase_hints)
    ? (frontmatter.phase_hints as Array<Record<string, unknown>>)
    : [];

  const newId = (entry as { id?: unknown }).id;
  if (typeof newId !== 'string' || newId.length === 0) {
    return { ok: false, reason: 'parse_error', details: 'rendered entry missing string `id` field' };
  }

  let appended = true;
  const replaceIdx = existingHints.findIndex(h => h.id === newId);
  if (replaceIdx >= 0) {
    // An auto-generated entry with the same id is treated as an update,
    // not a duplicate. Hand-written entries that happen to collide on id
    // *should* fail the patch — protect them via auto_generated flag.
    if (existingHints[replaceIdx].auto_generated !== true) {
      return {
        ok: false,
        reason: 'duplicate_id',
        details: `phase_hint id ${newId} exists and is not auto_generated; refusing to overwrite hand-written entry`,
      };
    }
    existingHints[replaceIdx] = entry as Record<string, unknown>;
    appended = false;
  } else {
    existingHints.push(entry as Record<string, unknown>);
  }

  frontmatter.phase_hints = existingHints;

  const updatedFrontmatter = yaml.dump(frontmatter, {
    noRefs: true,
    sortKeys: false,
    lineWidth: 100,
  });
  const updatedRaw = `${prefix}---\n${updatedFrontmatter}---\n${body}`;

  try {
    const tmp = `${strategyFilePath}.tmp`;
    fs.writeFileSync(tmp, updatedRaw);
    fs.renameSync(tmp, strategyFilePath);
  } catch (err) {
    return { ok: false, reason: 'io_error', details: (err as Error).message };
  }

  return { ok: true, appended };
}
