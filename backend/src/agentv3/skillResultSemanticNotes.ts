// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Producer semantic notes for Skill results.
 *
 * A note says what the producer means: a column's `semantics` (or the stdlib
 * overlay entry its `semantics_ref` names), the step's closed `row_semantics`,
 * and for an `investigation_evidence` metric column its metric id and the
 * producer's own `aggregation` / `coverage` / `denominator` declarations.
 * Units are not repeated: `columnUnits` already carries the issued unit. Notes
 * come from the authored producer step of each displayed result
 * (the capture's producer), one entry per step and never per row, and each
 * `skillId.stepId.column` note is emitted once per run, at most
 * SKILL_RESULT_NOTE_LIMITS.columns per result. A note is documentation, never
 * a measurement or evidence.
 *
 * Pi alone creates the memory, so the hidden fallback runtimes get no notes.
 * `SMARTPERFETTO_SKILL_RESULT_FACTS` set to an off value disables the notes and
 * the executor's rule facts together.
 */

import {EmittedNoteKeys, normalizeDocText, stdlibColumnSemanticsEntry, type EmittedNotePass} from './sqlStdlibColumnDocs';
import {capturedProducer, evidenceTableFor} from '../services/evidence/evidenceCapture';
import {producerColumn, skillProducerStep, type SkillProducerStep} from '../services/skillEngine/skillProducerSteps';
import type {DisplayResult, RowSemantics, SkillDefinition} from '../services/skillEngine/types';
import {ROW_SEMANTICS} from '../services/skillEngine/types';
import {parseFlagValue} from '../utils/envFlag';

export const SKILL_RESULT_FACTS_ENV = 'SMARTPERFETTO_SKILL_RESULT_FACTS';
export const SKILL_RESULT_NOTE_LIMITS = Object.freeze({columns: 24});

export interface SkillResultColumnNote {
  column: string;
  semantics?: string;
  /** The producer's investigation_evidence metric this column is the value of. */
  metricId?: string;
  aggregation?: string;
  coverageColumn?: string;
  denominatorColumn?: string;
}

export interface SkillResultStepNote {
  stepId: string;
  artifactId?: string;
  /** What one row stands for. */
  rows?: RowSemantics;
  columns: SkillResultColumnNote[];
}

export interface SkillResultNotes {
  steps: SkillResultStepNote[];
  /** Fresh column notes left for a later result by the per-result bound. */
  omittedColumns?: number;
}

/** One displayed result, as a caller locates it. */
export interface SkillResultNoteTarget {
  stepId: string;
  artifactId?: string;
  /** The columns the model sees for this result. */
  columns: readonly string[];
  producer?: SkillProducerStep;
}

/** A computed set of notes: `commit()` marks them emitted, so a caller that drops them keeps them eligible. */
export interface SkillResultNoteDraft {
  readonly notes?: SkillResultNotes;
  commit(): void;
}

/**
 * One column's note, or none when it has nothing left to say. Overlay text is
 * keyed by its entry: a second producer of the same column gets only its metric.
 */
function columnNote(producer: SkillProducerStep, column: string, pass: EmittedNotePass):
  {note: SkillResultColumnNote; overlayKey?: string} | undefined {
  const authored = producerColumn(producer, column);
  const ref = typeof authored?.semantics_ref === 'string' ? authored.semantics_ref : undefined;
  const overlayText = ref && pass.isNew(ref) ? stdlibColumnSemanticsEntry(ref)?.semantics : undefined;
  const semantics = typeof authored?.semantics === 'string' ? normalizeDocText(authored.semantics) : overlayText;
  const metric = producer.investigationEvidence?.metrics.find(entry => entry.value === column);
  if (!semantics && !metric) return undefined;
  return {
    note: {
      column,
      ...(semantics ? {semantics} : {}),
      ...(metric ? {
        metricId: metric.metric_id,
        ...(metric.aggregation ? {aggregation: metric.aggregation} : {}),
        ...(metric.coverage ? {coverageColumn: metric.coverage} : {}),
        ...(metric.denominator ? {denominatorColumn: metric.denominator} : {}),
      } : {}),
    },
    ...(overlayText ? {overlayKey: ref} : {}),
  };
}

export class SkillResultNoteMemory {
  /** Delivered note keys; shared with the run's raw SQL stdlib notes, whose keys are the overlay's. */
  readonly emittedKeys = new EmittedNoteKeys();
  /** The producer of each artifact this run's results located, for a later fetch of it. */
  private readonly producers = new Map<string, {stepId: string; producer: SkillProducerStep}>();

  draft(targets: readonly SkillResultNoteTarget[]): SkillResultNoteDraft {
    for (const target of targets) {
      if (target.artifactId && target.producer) {
        this.producers.set(target.artifactId, {stepId: target.stepId, producer: target.producer});
      }
    }
    const pass = this.emittedKeys.begin(SKILL_RESULT_NOTE_LIMITS.columns);
    const steps: SkillResultStepNote[] = [];
    for (const target of targets) {
      const producer = target.producer;
      if (!producer) continue;
      const prefix = `${producer.skillId}.${producer.stepId}`;
      const rowSemantics = producer.display?.row_semantics;
      const rowsKey = `${prefix}#rows`;
      const rows = typeof rowSemantics === 'string' && (ROW_SEMANTICS as readonly string[]).includes(rowSemantics)
        && pass.isNew(rowsKey) ? rowSemantics : undefined;
      if (rows) pass.claim(rowsKey);
      const columns: SkillResultColumnNote[] = [];
      for (const column of new Set(target.columns)) {
        const key = `${prefix}.${column}`;
        if (!pass.isNew(key)) continue;
        const note = columnNote(producer, column, pass);
        if (!note || !pass.admit(key)) continue;
        if (note.overlayKey) pass.claim(note.overlayKey);
        columns.push(note.note);
      }
      if (!rows && !columns.length) continue;
      steps.push({stepId: target.stepId, ...(target.artifactId ? {artifactId: target.artifactId} : {}),
        ...(rows ? {rows} : {}), columns});
    }
    const notes = steps.length ? {steps, ...(pass.omitted ? {omittedColumns: pass.omitted} : {})} : undefined;
    return {notes, commit: pass.commit};
  }

  /** Notes for `targets`, marked emitted. */
  notesFor(targets: readonly SkillResultNoteTarget[]): SkillResultNotes | undefined {
    const draft = this.draft(targets);
    draft.commit();
    return draft.notes;
  }

  /**
   * Notes still owed for an artifact a result of this run located, as a model
   * fetches it: what the per-result bound left out. An artifact of another run
   * has no producer here and gets none.
   */
  notesForArtifact(artifactId: string, columns: readonly string[]): SkillResultNotes | undefined {
    const located = this.producers.get(artifactId);
    return located ? this.notesFor([{...located, artifactId, columns}]) : undefined;
  }
}

/** The kill switch for notes and rule facts: an explicit off value disables both. */
export function skillResultFactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlagValue(env[SKILL_RESULT_FACTS_ENV]) !== false;
}

/** One memory per run, or none when the kill switch is set: its presence is the gate. */
export function createSkillResultNoteMemory(env: NodeJS.ProcessEnv = process.env): SkillResultNoteMemory | undefined {
  return skillResultFactsEnabled(env) ? new SkillResultNoteMemory() : undefined;
}

type SkillLookup = (skillId: string) => SkillDefinition | undefined;

/** The column names of table data (`{columns, rows}`); none for anything else. */
export function tableColumns(data: unknown): string[] {
  const columns = (data as {columns?: unknown} | undefined)?.columns;
  return Array.isArray(columns) ? columns.filter((column): column is string => typeof column === 'string') : [];
}

/** Note targets for a Skill run's displayed results, by display index, over the columns the model sees. */
export function skillResultNoteTargets(
  displayResults: readonly DisplayResult[] | undefined,
  artifactIdsByDisplayIndex: ReadonlyArray<string | undefined>,
  modelDisplayProjections: ReadonlyArray<{data?: unknown} | undefined>,
  lookupSkill: SkillLookup,
): SkillResultNoteTarget[] {
  return (displayResults ?? []).map((displayResult, index) => {
    const witness = evidenceTableFor(displayResult);
    const source = witness && capturedProducer(witness);
    const producer = source ? skillProducerStep(lookupSkill(source.skillId), source.stepId) : undefined;
    const artifactId = artifactIdsByDisplayIndex[index];
    return {stepId: displayResult.stepId, ...(artifactId ? {artifactId} : {}),
      columns: tableColumns(modelDisplayProjections[index]?.data), ...(producer ? {producer} : {})};
  });
}
