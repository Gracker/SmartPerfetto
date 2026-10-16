// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {SkillExecutor} from '../../src/services/skillEngine/skillExecutor';
import type {SkillDefinition, AtomicStep} from '../../src/services/skillEngine/types';
import {capturedEvidenceTable, evidenceTableFor} from '../../src/services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../src/services/traceProcessorConnectionModel';
import {activateSceneRuntime, createSceneRunDispatchBinding, sceneRunOwnerKey} from '../../src/agent/scene/sceneRuntimeBinding';
import {resolveRuntimeEvidenceStore} from '../../src/agentRuntime/runtimeEvidenceContext';
import {proposeSceneTimeline} from '../../src/agent/scene/sceneTimelineProposal';
import type {SceneTimelineSegment} from '../../src/agent/scene/sceneTimelineContract';
import {sceneRunState} from '../../src/agent/scene/sceneRunContext';
import {androidInputEventsTableDdl} from '../helpers/androidInputEventsFixture';

const start = 9007199254740993n;
const end = start + 10000000000n;
function inputTrace(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
    CREATE TABLE android_motion_events(id INTEGER, event_id INTEGER, ts INTEGER, action INTEGER, device_id INTEGER, display_id INTEGER, source INTEGER);
    CREATE TABLE android_key_events(id INTEGER, event_id INTEGER, ts INTEGER, action INTEGER, device_id INTEGER, display_id INTEGER, source INTEGER);
    ${androidInputEventsTableDdl()}`);
  db.prepare('INSERT INTO trace_bounds VALUES (?, ?)').run(start, end);
  const insert = db.prepare('INSERT INTO android_motion_events VALUES (?, ?, ?, ?, 1, 0, 4098)');
  insert.run(1, 1, start + 1600000000n, 0);
  insert.run(2, 2, start + 2000000000n, 1);
  return db;
}

describe('registered scene producer boundary captures', () => {
  it.each([
    ['scene_reconstruction', 'idle_periods', 'ts'],
    ['state_timeline', 'input_state_lane_frames', 'start_ts'],
    ['state_timeline', 'input_state_lane_fallback', 'start_ts'],
  ])('%s.%s preserves exact authored windows and contradicts shifted model boundaries', async (skillId, stepId, startColumn) => {
    const db = inputTrace();
    const scope = {sessionId: 'boundary-session', runId: 'boundary-run', traceId: 'boundary-trace', ownerKey: sceneRunOwnerKey({})};
    const binding = createSceneRunDispatchBinding({scope, signal: new AbortController().signal, assertCurrent() {}});
    try {
      const query = async (_traceId: string, sql: string) => {
        const statement = db.prepare(sql);
        return {columns: statement.columns().map(column => column.name), rows: statement.raw().all() as unknown[][], durationMs: 0};
      };
      const processor = {query};
      const original = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite', `${skillId}.skill.yaml`), 'utf8')) as SkillDefinition;
      const step = original.steps!.find(item => item.id === stepId) as AtomicStep;
      const executor = new SkillExecutor(processor);
      const fragmentsDir = path.join(process.cwd(), 'skills/fragments');
      executor.setFragmentRegistry(new Map(fs.readdirSync(fragmentsDir).filter(file => file.endsWith('.sql')).map(file =>
        [`fragments/${file}`, fs.readFileSync(path.join(fragmentsDir, file), 'utf8')])));
      executor.registerSkill(original);
      // Focus this production step after its input-presence prerequisite. Keep
      // the original registered definition, SQL, fragments and evidence mapping.
      const execution = await executor.executeCompositeSkill({...original, prerequisites: undefined,
        steps: [{...step, condition: undefined}]}, {trace_id: scope.traceId}, {traceId: scope.traceId});
      const raw = execution.stepResults!.find(item => item.stepId === stepId)!;
      expect({success: raw.success, error: raw.error}).toEqual({success: true, error: undefined});
      const witness = evidenceTableFor(raw)!;
      const table = capturedEvidenceTable(witness)!;
      expect(table).toBeDefined();
      const rowIndex = table.rows.findIndex(row => row[table.columns.indexOf(startColumn)] === String(start));
      expect(rowIndex).toBeGreaterThanOrEqual(0);
      const first = table.rows[rowIndex];
      expect(first[table.columns.indexOf('end_ts')]).toBe(String(start + 1600000000n));
      const tailIndex = table.rows.findIndex(row => row[table.columns.indexOf('end_ts')] === String(end));
      expect(tailIndex).toBeGreaterThanOrEqual(0);
      const options = binding.bindOptions({runId: scope.runId});
      const store = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('missing bound store');});
      const context = await activateSceneRuntime(options, {...scope, artifactStore: store,
        traceProcessorService: processor, deadlineMs: Date.now() + 60000});
      const artifactId = store.store({skillId, stepId, data: {columns: [...table.columns], rows: table.rows.map(row => [...row])},
        traceProvenance: buildTraceProcessorQueryProvenance({traceId: scope.traceId, traceSide: 'current'})});
      expect(store.registerEvidenceCapture(artifactId, witness, {evidenceRefId: 'producer-gap', originRunId: scope.runId})).toBe(true);
      expect(store.createEvidenceReadView({currentRunId: scope.runId, ownerKey: scope.ownerKey,
        allowedTraces: [{traceId: scope.traceId, traceSide: 'current'}]}).investigationEvidence!().records).toEqual([]);
      const base: SceneTimelineSegment = {id: 'gap', startNs: String(start), endNs: String(start + 1600000000n),
        object: {kind: 'device', key: 'trace-device'}, userAction: 'No input observed; capture unknown', deviceState: 'Unknown', appResponse: 'Unknown',
        evidenceRefs: [{artifactId, rowIndex}], dependencies: [], supersedes: [],
        boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: startColumn},
          end: {source: 'evidence', evidenceIndex: 0, column: 'end_ts'}}};
      const variants: Array<{segment: SceneTimelineSegment; expected: ['passed' | 'contradicted', 'passed' | 'contradicted']}> = [
        {segment: base, expected: ['passed', 'passed']},
        {segment: {...base, startNs: String(start + 1n)}, expected: ['contradicted', 'passed']},
        {segment: {...base, startNs: String(start + 375885n)}, expected: ['contradicted', 'passed']},
        {segment: {...base, startNs: String(table.rows[tailIndex][table.columns.indexOf(startColumn)]),
          endNs: String(end - 515209n), evidenceRefs: [{artifactId, rowIndex: tailIndex}]}, expected: ['passed', 'contradicted']},
        {segment: {...base, boundaries: {...base.boundaries, end: {source: 'evidence', evidenceIndex: 0, column: startColumn}}},
          expected: ['passed', 'contradicted']},
      ];
      for (const [index, variant] of variants.entries()) {
        const proposed = await proposeSceneTimeline(context!, {proposalId: `boundary-${index}`, baseRevision: index,
          segments: [variant.segment], unresolved: []});
        expect(proposed.accepted).toBe(true);
        const assessed = proposed.segments!.find(item => item.segment.id === 'gap')!;
        expect(assessed.checks.slice(0, 2).map(check => check.status)).toEqual(variant.expected);
        expect(assessed.semanticStatus).toBe('unverified');
        expect(assessed.evidence[0].source).toMatchObject({skillId, stepId, originRunId: scope.runId});
        expect(assessed.checks.some(check => check.reason === 'producer_time_semantics_unavailable')).toBe(false);
        expect(sceneRunState(context!).scanReceipts.size).toBe(0);
      }
    } finally {binding.release(); db.close();}
  });
});
