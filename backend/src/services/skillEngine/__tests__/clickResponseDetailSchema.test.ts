// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';

const skillPath = path.join(
  process.cwd(),
  'skills',
  'composite',
  'click_response_detail.skill.yaml',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf8')) as any;

function inputPipelineTargetEventSql(): string {
  const step = skill.steps?.find((candidate: any) => candidate.id === 'input_pipeline_lifecycle');
  expect(step).toBeDefined();
  const match = String(step.sql).match(
    /WITH target_event AS \(\s*([\s\S]*?LIMIT 1)\s*\)\s*SELECT/,
  );
  expect(match).not.toBeNull();
  return match![1];
}

describe('click_response_detail input event identity', () => {
  it('selects the exact process when a prefix process has the same event bounds', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE android_input_events (
          process_name TEXT,
          dispatch_ts INTEGER,
          receive_ts INTEGER,
          receive_dur INTEGER,
          input_event_id INTEGER,
          event_channel TEXT
        );
        INSERT INTO android_input_events VALUES
          ('com.foo:remote', 100, 180, 20, 1, 'remote'),
          ('com.foo', 100, 180, 20, 2, 'main');
      `);

      const selector = inputPipelineTargetEventSql()
        .replace(/\$\{process_name\}/g, 'com.foo')
        .replace(/\$\{event_ts\}/g, '100')
        .replace(/\$\{event_end_ts\}/g, '200');
      const selected = db.prepare(selector).get() as {
        process_name: string;
        input_event_id: number;
      };

      expect(selected.process_name).toBe('com.foo');
      expect(selected.input_event_id).toBe(2);
    } finally {
      db.close();
    }
  });
});
