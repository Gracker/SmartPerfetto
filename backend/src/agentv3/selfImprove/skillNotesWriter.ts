// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Validate, scan, and persist skill notes emitted by the review agent.
 *
 * The review agent only ever emits strict JSON — never writes files itself —
 * so the pipeline here is the trust boundary. Anything that fails schema,
 * security scan, or capacity gating is dropped with a logged reason; the
 * review job is still marked done because the failure is the agent's, not
 * a transient one we want to retry forever.
 *
 * Writes are atomic (tmp + rename) so a partial write never leaves a
 * corrupt notes file that breaks the next invoke_skill injection.
 *
 * See docs/architecture/self-improving-design.md "Skill Notes" and "存储与安全".
 */

import * as fs from 'fs';
import * as path from 'path';
import { backendLogPath } from '../../runtimePaths';
import {
  isKnownCategory,
  type FailureCategory,
} from './failureTaxonomy';
import { scanContent, formatThreats } from './contentScanner';
import { logStoredReadFailure, parseStoredJson } from '../../utils/storedData';

/** Strict JSON shape emitted by the review agent. Anything else is rejected. */
export interface ReviewAgentNoteEmission {
  failureCategoryEnum: FailureCategory;
  evidenceSummary: string;
  candidateKeywords?: string[];
  candidateConstraints?: string;
  candidateCriticalTools?: string[];
  /** Optional self-supplied failureModeHash; backend recomputes regardless. */
  failureModeHash?: string;
  /** Skill that the note targets — required so the writer knows which file. */
  skillId: string;
  /** Provenance fields the writer copies into the persisted note. */
  sourceSessionId?: string;
  sourceTurnIndex?: number;
}

export interface PersistedSkillNote {
  id: string;
  failureCategory: FailureCategory;
  failureModeHash?: string;
  evidenceSummary: string;
  candidateKeywords: string[];
  candidateConstraints: string;
  candidateCriticalTools: string[];
  createdAt: number;
  cooldownUntil: number;
  byteSize: number;
  sourceSessionId?: string;
  sourceTurnIndex?: number;
}

export interface SkillNotesFile {
  schemaVersion: 1;
  skillId: string;
  notes: PersistedSkillNote[];
  lastUpdated: number;
  totalBytes: number;
}

export type WriteOutcome =
  | { ok: true; noteId: string; filePath: string; totalBytes: number }
  | { ok: false; reason: WriteRejectReason; details: string };

export type WriteRejectReason =
  | 'invalid_schema'
  | 'unknown_category'
  | 'security_scan'
  | 'capacity_exceeded'
  | 'invalid_skill_id'
  | 'io_error';

/** Whitelisted characters only — keeps file names safe. */
const SKILL_ID_RE = /^[a-zA-Z0-9_]{1,80}$/;
const MAX_EVIDENCE_CHARS = 600;
const MAX_CONSTRAINTS_CHARS = 400;
const MAX_KEYWORDS = 6;
const MAX_KEYWORD_CHARS = 40;
const MAX_TOOLS = 6;
const MAX_TOOL_CHARS = 80;
const MAX_NOTE_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 16 * 1024;
const NOTE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Runtime skill-notes directory, resolved on use (the CLI sets its log root after import). */
export function runtimeSkillNotesDir(): string {
  return backendLogPath('skill_notes');
}

export interface WriteOptions {
  /** Override notes directory — primarily for tests. */
  notesDir?: string;
  /** Override `Date.now()` for deterministic tests. */
  now?: number;
  /** Optional registry of valid tool/skill IDs; criticalTools are validated against it when supplied. */
  toolRegistry?: ReadonlySet<string>;
}

/**
 * Validate the agent emission against the schema. Truncates over-long fields
 * rather than failing on them — matches the validation style elsewhere in
 * selfImprove. Returns a normalized emission ready to be persisted.
 */
export function validateEmission(
  raw: unknown,
  toolRegistry?: ReadonlySet<string>,
): { ok: true; value: ReviewAgentNoteEmission } | { ok: false; reason: WriteRejectReason; details: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_schema', details: 'emission must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.skillId !== 'string' || !SKILL_ID_RE.test(r.skillId)) {
    return { ok: false, reason: 'invalid_skill_id', details: `skillId must match ${SKILL_ID_RE.source}` };
  }

  if (!isKnownCategory(r.failureCategoryEnum)) {
    return {
      ok: false,
      reason: 'unknown_category',
      details: `failureCategoryEnum must be a known FailureCategory (got ${String(r.failureCategoryEnum)})`,
    };
  }

  if (typeof r.evidenceSummary !== 'string' || r.evidenceSummary.trim().length === 0) {
    return { ok: false, reason: 'invalid_schema', details: 'evidenceSummary must be a non-empty string' };
  }

  const keywords = normalizeStringArray(r.candidateKeywords, MAX_KEYWORDS, MAX_KEYWORD_CHARS);
  if (keywords === 'invalid') {
    return { ok: false, reason: 'invalid_schema', details: 'candidateKeywords must be an array of strings' };
  }

  const constraints = typeof r.candidateConstraints === 'string'
    ? r.candidateConstraints.substring(0, MAX_CONSTRAINTS_CHARS)
    : '';

  const tools = normalizeStringArray(r.candidateCriticalTools, MAX_TOOLS, MAX_TOOL_CHARS);
  if (tools === 'invalid') {
    return { ok: false, reason: 'invalid_schema', details: 'candidateCriticalTools must be an array of strings' };
  }
  if (toolRegistry && tools.length > 0) {
    const unknownTool = tools.find(t => !toolRegistry.has(t));
    if (unknownTool) {
      return {
        ok: false,
        reason: 'invalid_schema',
        details: `candidateCriticalTools includes unknown tool/skill: ${unknownTool}`,
      };
    }
  }

  const value: ReviewAgentNoteEmission = {
    failureCategoryEnum: r.failureCategoryEnum,
    evidenceSummary: r.evidenceSummary.substring(0, MAX_EVIDENCE_CHARS),
    candidateKeywords: keywords,
    candidateConstraints: constraints,
    candidateCriticalTools: tools,
    skillId: r.skillId,
    failureModeHash: typeof r.failureModeHash === 'string' ? r.failureModeHash : undefined,
    sourceSessionId: typeof r.sourceSessionId === 'string' ? r.sourceSessionId : undefined,
    sourceTurnIndex: typeof r.sourceTurnIndex === 'number' ? r.sourceTurnIndex : undefined,
  };

  return { ok: true, value };
}

function normalizeStringArray(input: unknown, maxLen: number, maxItemChars: number): string[] | 'invalid' {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return 'invalid';
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return 'invalid';
    out.push(item.substring(0, maxItemChars));
    if (out.length >= maxLen) break;
  }
  return out;
}

/**
 * Run security scanner across the emission's free-form text. Returns the
 * matches if any are found so the caller can log the offending excerpt.
 */
export function scanEmission(emission: ReviewAgentNoteEmission): string | null {
  const surfaces = [
    emission.evidenceSummary,
    emission.candidateConstraints || '',
    ...(emission.candidateKeywords || []),
    ...(emission.candidateCriticalTools || []),
  ];
  for (const text of surfaces) {
    const matches = scanContent(text);
    if (matches.length > 0) return formatThreats(matches);
  }
  return null;
}

/**
 * Atomically write a new note to `<notesDir>/<skillId>.notes.json`. The full
 * pipeline runs here: schema validation → security scan → capacity check →
 * tmp+rename write. Returns a structured outcome so the worker can log a
 * reason without throwing.
 */
export function writeSkillNote(raw: unknown, opts: WriteOptions = {}): WriteOutcome {
  const validation = validateEmission(raw, opts.toolRegistry);
  if (!validation.ok) return { ok: false, reason: validation.reason, details: validation.details };
  const emission = validation.value;

  const threats = scanEmission(emission);
  if (threats) {
    return { ok: false, reason: 'security_scan', details: threats };
  }

  const now = opts.now ?? Date.now();
  const note: PersistedSkillNote = {
    id: `note-${now}-${Math.random().toString(36).substring(2, 8)}`,
    failureCategory: emission.failureCategoryEnum,
    failureModeHash: emission.failureModeHash,
    evidenceSummary: emission.evidenceSummary,
    candidateKeywords: emission.candidateKeywords ?? [],
    candidateConstraints: emission.candidateConstraints ?? '',
    candidateCriticalTools: emission.candidateCriticalTools ?? [],
    createdAt: now,
    cooldownUntil: now + NOTE_COOLDOWN_MS,
    byteSize: 0,
    sourceSessionId: emission.sourceSessionId,
    sourceTurnIndex: emission.sourceTurnIndex,
  };
  note.byteSize = Buffer.byteLength(JSON.stringify(note), 'utf-8');

  if (note.byteSize > MAX_NOTE_BYTES) {
    return { ok: false, reason: 'capacity_exceeded', details: `note=${note.byteSize}B > ${MAX_NOTE_BYTES}B` };
  }

  const dir = opts.notesDir ?? runtimeSkillNotesDir();
  const filePath = path.join(dir, `${emission.skillId}.notes.json`);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'io_error', details: (err as Error).message };
  }

  const existing = readSkillNotesFile(filePath);
  const existingFromSameSource = note.sourceSessionId && note.sourceTurnIndex !== undefined
    ? existing.notes.find(
        n => n.sourceSessionId === note.sourceSessionId
          && n.sourceTurnIndex === note.sourceTurnIndex
          && n.failureModeHash === note.failureModeHash,
      )
    : undefined;
  if (existingFromSameSource) {
    // Same provenance + failure-mode is a duplicate emission (the worker
    // retried, or the agent looped). Keep the original to preserve audit.
    return {
      ok: true,
      noteId: existingFromSameSource.id,
      filePath,
      totalBytes: existing.totalBytes,
    };
  }

  const merged: SkillNotesFile = {
    schemaVersion: 1,
    skillId: emission.skillId,
    notes: [...existing.notes, note],
    lastUpdated: now,
    totalBytes: 0,
  };
  // Drop oldest notes until the file fits the cap. Newer notes are more
  // valuable than older ones for cross-arch drift like Flutter Impeller.
  while (true) {
    const serialized = JSON.stringify(merged, null, 2);
    const totalBytes = Buffer.byteLength(serialized, 'utf-8');
    merged.totalBytes = totalBytes;
    if (totalBytes <= MAX_FILE_BYTES) break;
    if (merged.notes.length <= 1) {
      return { ok: false, reason: 'capacity_exceeded', details: `single note exceeds file cap (${totalBytes}B)` };
    }
    merged.notes.shift();
  }

  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    return { ok: false, reason: 'io_error', details: (err as Error).message };
  }

  return { ok: true, noteId: note.id, filePath, totalBytes: merged.totalBytes };
}

export function readSkillNotesFile(filePath: string): SkillNotesFile {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, skillId: path.basename(filePath, '.notes.json'), notes: [], lastUpdated: 0, totalBytes: 0 };
  }
  try {
    const parsed = parseStoredJson<Partial<SkillNotesFile>>(fs.readFileSync(filePath, 'utf-8'), 'skill notes');
    if (parsed && Array.isArray(parsed.notes)) return parsed as SkillNotesFile;
  } catch (err) {
    logStoredReadFailure('[skillNotesWriter] Notes file unreadable, using empty notes', err, {path: filePath});
  }
  return { schemaVersion: 1, skillId: path.basename(filePath, '.notes.json'), notes: [], lastUpdated: 0, totalBytes: 0 };
}

/** @internal Test seam. */
export const __testing = {
  MAX_NOTE_BYTES,
  MAX_FILE_BYTES,
  NOTE_COOLDOWN_MS,
  SKILL_ID_RE,
};
