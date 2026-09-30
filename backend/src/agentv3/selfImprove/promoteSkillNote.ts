// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI to promote a runtime skill note (under logs/skill_notes/) to the
 * curated baseline (backend/skills/curated_skill_notes/) which is checked
 * into git. The promoted note is removed from the runtime file so it
 * doesn't double-count at injection time.
 *
 * Usage:
 *   npx tsx src/agentv3/selfImprove/promoteSkillNote.ts <skillId> <noteId> [--dry-run]
 *
 * The runtime file lives in `logs/` (gitignored) so skill notes don't
 * pollute repo history with auto-generated content. Promotion is a manual
 * gate — a human reviews the note and explicitly elevates it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readSkillNotesFile,
  runtimeSkillNotesDir,
  type SkillNotesFile,
} from './skillNotesWriter';

const CURATED_DIR = path.resolve(__dirname, '..', '..', '..', 'skills', 'curated_skill_notes');

export interface PromoteResult {
  ok: boolean;
  reason?: 'skill_not_found' | 'note_not_found' | 'already_curated' | 'io_error';
  details?: string;
  /** Where the note ended up after promotion (only set on ok=true). */
  curatedPath?: string;
}

/**
 * Move a single note from runtime → curated. Idempotent: a second call with
 * the same arguments is a no-op once the runtime entry is gone.
 */
export function promoteSkillNote(
  skillId: string,
  noteId: string,
  opts: {
    runtimeDir?: string;
    curatedDir?: string;
    dryRun?: boolean;
  } = {},
): PromoteResult {
  const runtimeDir = opts.runtimeDir ?? runtimeSkillNotesDir();
  const curatedDir = opts.curatedDir ?? CURATED_DIR;
  const runtimeFile = path.join(runtimeDir, `${skillId}.notes.json`);
  const curatedFile = path.join(curatedDir, `${skillId}.notes.json`);

  if (!fs.existsSync(runtimeFile)) {
    return { ok: false, reason: 'skill_not_found', details: `${runtimeFile} does not exist` };
  }

  const runtime = readSkillNotesFile(runtimeFile);
  const noteIdx = runtime.notes.findIndex(n => n.id === noteId);
  if (noteIdx < 0) {
    return { ok: false, reason: 'note_not_found', details: `noteId ${noteId} not found in ${runtimeFile}` };
  }
  const note = runtime.notes[noteIdx];

  const curated = fs.existsSync(curatedFile)
    ? readSkillNotesFile(curatedFile)
    : { schemaVersion: 1 as const, skillId, notes: [], lastUpdated: 0, totalBytes: 0 };

  if (curated.notes.some(n => n.id === note.id)) {
    return { ok: false, reason: 'already_curated', details: `note ${note.id} already in curated baseline` };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      curatedPath: curatedFile,
      details: 'dry-run — no files modified',
    };
  }

  try {
    if (!fs.existsSync(curatedDir)) fs.mkdirSync(curatedDir, { recursive: true });
    const updatedCurated: SkillNotesFile = {
      ...curated,
      notes: [...curated.notes, note],
      lastUpdated: Date.now(),
    };
    updatedCurated.totalBytes = Buffer.byteLength(JSON.stringify(updatedCurated, null, 2), 'utf-8');
    atomicWrite(curatedFile, updatedCurated);

    const updatedRuntime: SkillNotesFile = {
      ...runtime,
      notes: runtime.notes.filter(n => n.id !== note.id),
      lastUpdated: Date.now(),
    };
    updatedRuntime.totalBytes = Buffer.byteLength(JSON.stringify(updatedRuntime, null, 2), 'utf-8');
    atomicWrite(runtimeFile, updatedRuntime);

    return { ok: true, curatedPath: curatedFile };
  } catch (err) {
    return { ok: false, reason: 'io_error', details: (err as Error).message };
  }
}

function atomicWrite(file: string, data: SkillNotesFile): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function printUsage(): void {
  console.error(
    'Usage: npx tsx src/agentv3/selfImprove/promoteSkillNote.ts <skillId> <noteId> [--dry-run]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    printUsage();
    process.exit(2);
  }
  const [skillId, noteId, ...rest] = args;
  const dryRun = rest.includes('--dry-run');

  const result = promoteSkillNote(skillId, noteId, { dryRun });
  if (result.ok) {
    console.log(`[promote] ${dryRun ? 'would promote' : 'promoted'} ${skillId}/${noteId}`);
    if (result.curatedPath) console.log(`[promote] target: ${result.curatedPath}`);
  } else {
    console.error(`[promote] failed (${result.reason}): ${result.details}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[promote] unhandled:', err);
    process.exit(1);
  });
}
