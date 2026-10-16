// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SmartPerfetto contributors
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import * as yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '../..');
const skills = path.join(root, 'backend/skills');
const skill = yaml.load(fs.readFileSync(path.join(skills, 'composite/cpu_analysis.skill.yaml'), 'utf8'));

function query(step, packageName, exactUpid = null) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE trace_bounds(start_ts, end_ts);
      INSERT INTO trace_bounds VALUES(0, 1000);
      CREATE TABLE cpu(id, cpu, machine_id, cluster_id, capacity);
      INSERT INTO cpu VALUES(0, 0, NULL, 0, 512);
      CREATE TABLE process(upid, pid, name);
      INSERT INTO process VALUES(2, 100, 'com.example:render'), (3, 200, 'com.other');
      CREATE TABLE thread(utid, upid, tid, name, is_idle);
      INSERT INTO thread VALUES(20, 2, 100, 'main', 0), (30, 3, 200, 'peer', 0);
      CREATE TABLE sched_slice(id, ts, dur, utid, cpu, ucpu, end_state, priority);
      INSERT INTO sched_slice VALUES(1, 0, 100, 20, 0, 0, 'S', 120),
        (2, 100, 300, 30, 0, 0, 'S', 120);
    `);
    const fragments = step.sql_fragments.map(file => fs.readFileSync(path.join(skills, file), 'utf8')).join(',\n');
    const sql = step.sql.replace('WITH ', `WITH ${fragments},\n`)
      .replaceAll('${target_process.data[0].upid}', '2')
      .replaceAll('${__process_scope.upid}', exactUpid === null ? 'NULL' : String(exactUpid))
      .replaceAll('${package}', packageName)
      .replaceAll('${start_ts}', 'NULL')
      .replaceAll('${end_ts}', 'NULL');
    assert.ok(!sql.includes('${'), 'all fixture bindings must be supplied');
    return db.prepare(sql).all().map(row => ({...row}));
  } finally {
    db.close();
  }
}

for (const id of ['core_type_stats', 'thread_cpu_usage', 'main_thread_cores']) {
  const step = skill.steps.find(candidate => candidate.id === id);
  test(`${id} consumes the selected process name without admitting peers`, () => {
    const rows = query(step, 'com.example');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.upid === 2));
    assert.deepEqual(query(step, 'com.other'), []);
  });

  test(`${id} retains exact-UPID execution with an empty name`, () => {
    assert.deepEqual(query(step, '', 2), query(step, 'com.example'));
    assert.deepEqual(query(step, '', 3), []);
  });
}
