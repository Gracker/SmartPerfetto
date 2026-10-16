/**
 * android_heap_graph_leak_candidates Skill Evaluation Tests
 *
 * The checked-in launch fixture has no heap graph rows. This verifies the
 * leak-candidate path keeps a stable empty-data contract when heap graph data
 * is absent, and that the pinned runtime's `_excluded_refs` filters exactly the
 * reference kinds the Skill's wording names (memorySkillSqlSemantics.test.ts
 * holds the wording).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { getTraceProcessorPath } from '../../src/services/workingTraceProcessor';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('android_heap_graph_leak_candidates skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('android_heap_graph_leak_candidates');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('keeps leak candidate detection executable with empty heap graph data', async () => {
    const result = await evaluator.executeStep('leak_candidates');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  }, 30000);

  it('keeps reference holder lookup executable with no suspect objects', async () => {
    const result = await evaluator.executeStep('reference_holders');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  }, 30000);
});

// The stdlib module runs on the pinned trace_processor_shell over heap graph
// tables shadowed by TEMP views (SQLite resolves temp names first): one object
// per reference kind holding a `referent` edge (ids 101..105 for weak, soft,
// phantom, finalizer, normal), plus a non-referent edge (201) on the weak
// object. The probe reads no trace data, so it runs on an empty input in a
// one-shot process that keeps the shadow views off any shared processor.
const EXCLUDED_REFS_PROBE = `
CREATE TEMP VIEW heap_graph_class AS
SELECT 1 AS id, 'KIND_WEAK_REFERENCE' AS kind UNION ALL
SELECT 2, 'KIND_SOFT_REFERENCE' UNION ALL
SELECT 3, 'KIND_PHANTOM_REFERENCE' UNION ALL
SELECT 4, 'KIND_FINALIZER_REFERENCE' UNION ALL
SELECT 5, 'KIND_NORMAL';
CREATE TEMP VIEW heap_graph_object AS
SELECT 10 + id AS id, id AS type_id, id AS reference_set_id FROM heap_graph_class;
CREATE TEMP VIEW heap_graph_reference AS
SELECT 100 + id AS id, id AS reference_set_id, 'java.lang.ref.Reference.referent' AS field_name
FROM heap_graph_class
UNION ALL SELECT 201, 1, 'java.lang.ref.Reference.queue';
INCLUDE PERFETTO MODULE android.memory.heap_graph.excluded_refs;
SELECT group_concat(id, ',') AS excluded_ref_ids FROM (SELECT id FROM _excluded_refs ORDER BY id);
`;

describe('android_heap_graph_leak_candidates _excluded_refs contract', () => {
  it('excludes weak/phantom/finalizer referent edges on the pinned runtime, not soft ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-refs-probe-'));
    try {
      const emptyTrace = path.join(dir, 'empty.pftrace');
      fs.writeFileSync(emptyTrace, '');
      const result = spawnSync(
        getTraceProcessorPath(),
        ['query', emptyTrace, EXCLUDED_REFS_PROBE],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/).slice(-2)).toEqual(['"excluded_ref_ids"', '"101,103,104"']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
