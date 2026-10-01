// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import {warningsDuring} from '../../../tests/helpers/consoleWarnings';

import {
  BaselineStore,
  BASELINE_PUBLISH_MIN_SAMPLES,
  deriveBaselineId,
  keyHasIdentifiableInfo,
} from '../baselineStore';
import {
  type BaselineRecord,
  type PerfBaselineKey,
  makeSparkProvenance,
} from '../../types/sparkContracts';

let tmpDir: string;
let storagePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-store-test-'));
  storagePath = path.join(tmpDir, 'baselines.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

const RAW_KEY: PerfBaselineKey = {
  appId: 'com.example.feed',
  deviceId: 'pixel-9-android-15',
  buildId: 'main-abc1234',
  cuj: 'scroll_feed',
};

const ANON_KEY: PerfBaselineKey = {
  appId: 'anon-app-001',
  deviceId: 'anon-device-001',
  buildId: 'main-abc1234',
  cuj: 'scroll_feed',
};

function makeBaseline(overrides: Partial<BaselineRecord> = {}): BaselineRecord {
  const key = overrides.key ?? RAW_KEY;
  return {
    ...makeSparkProvenance({source: 'baseline-store-test'}),
    baselineId: overrides.baselineId ?? deriveBaselineId(key),
    artifactId: 'artifact-001',
    capturedAt: 1714600000000,
    sampleCount: 12,
    key,
    status: 'reviewed',
    redactionState: 'partial',
    windowStartMs: 1714000000000,
    windowEndMs: 1714600000000,
    metrics: [],
    ...overrides,
  };
}

describe('BaselineStore — helpers', () => {
  it('deriveBaselineId joins the four key components with slashes', () => {
    expect(deriveBaselineId(RAW_KEY)).toBe(
      'com.example.feed/pixel-9-android-15/main-abc1234/scroll_feed',
    );
  });

  it('keyHasIdentifiableInfo flags raw appId / deviceId', () => {
    expect(keyHasIdentifiableInfo(RAW_KEY)).toBe(true);
  });

  it('keyHasIdentifiableInfo accepts anon- prefixed keys', () => {
    expect(keyHasIdentifiableInfo(ANON_KEY)).toBe(false);
  });

  it('keyHasIdentifiableInfo accepts redacted- and placeholder- prefixes', () => {
    expect(
      keyHasIdentifiableInfo({
        ...ANON_KEY,
        appId: 'redacted-app',
        deviceId: 'placeholder-device',
      }),
    ).toBe(false);
  });
});

describe('BaselineStore — basic CRUD', () => {
  it('adds and reads back a baseline', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({baselineId: 'b1'});
    store.addBaseline(record);
    expect(store.getBaseline('b1')).toEqual(record);
  });

  it('returns undefined for an unknown baselineId', () => {
    const store = new BaselineStore(storagePath);
    expect(store.getBaseline('nope')).toBeUndefined();
  });

  it('removeBaseline returns true when present, false otherwise', () => {
    const store = new BaselineStore(storagePath);
    store.addBaseline(makeBaseline({baselineId: 'b1'}));
    expect(store.removeBaseline('b1')).toBe(true);
    expect(store.removeBaseline('b1')).toBe(false);
  });

  it('replaces a baseline on re-add with the same id', () => {
    const store = new BaselineStore(storagePath);
    store.addBaseline(makeBaseline({baselineId: 'b1', sampleCount: 5}));
    store.addBaseline(makeBaseline({baselineId: 'b1', sampleCount: 7}));
    expect(store.getBaseline('b1')?.sampleCount).toBe(7);
  });

  it('preserves writes from store instances created before either mutation', () => {
    const first = new BaselineStore(storagePath);
    const second = new BaselineStore(storagePath);

    first.addBaseline(makeBaseline({baselineId: 'b1'}));
    second.addBaseline(makeBaseline({baselineId: 'b2'}));

    expect(new BaselineStore(storagePath).listBaselines().map(item => item.baselineId)).toEqual([
      'b1',
      'b2',
    ]);
  });
});

describe('BaselineStore — publish invariants', () => {
  it('rejects publish when sampleCount is below minimum', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({
      key: ANON_KEY,
      status: 'published',
      redactionState: 'raw',
      sampleCount: BASELINE_PUBLISH_MIN_SAMPLES - 1,
    });
    expect(() => store.addBaseline(record)).toThrow(
      /sampleCount/,
    );
  });

  it('accepts publish when sampleCount meets the minimum', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({
      key: ANON_KEY,
      status: 'published',
      redactionState: 'raw',
      sampleCount: BASELINE_PUBLISH_MIN_SAMPLES,
    });
    expect(() => store.addBaseline(record)).not.toThrow();
  });

  it('rejects publish when key has identifiable info and redactionState != redacted', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({
      key: RAW_KEY,
      status: 'published',
      redactionState: 'partial',
      sampleCount: 12,
    });
    expect(() => store.addBaseline(record)).toThrow(/redactionState/);
  });

  it('accepts publish when identifiable key is paired with redactionState=redacted', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({
      key: RAW_KEY,
      status: 'published',
      redactionState: 'redacted',
      sampleCount: 12,
    });
    expect(() => store.addBaseline(record)).not.toThrow();
  });

  it('does not gate non-published statuses by sampleCount', () => {
    const store = new BaselineStore(storagePath);
    const record = makeBaseline({
      status: 'draft',
      sampleCount: 0,
    });
    expect(() => store.addBaseline(record)).not.toThrow();
  });
});

describe('BaselineStore — listing', () => {
  function seed(store: BaselineStore): void {
    store.addBaseline(makeBaseline({
      baselineId: 'a/d/b/c',
      key: ANON_KEY,
      status: 'draft',
    }));
    store.addBaseline(makeBaseline({
      baselineId: 'b/d/b/c',
      key: ANON_KEY,
      status: 'published',
      redactionState: 'raw',
      sampleCount: 5,
    }));
    store.addBaseline(makeBaseline({
      baselineId: 'b/e/b/c',
      key: ANON_KEY,
      status: 'reviewed',
    }));
  }

  it('listBaselines returns all baselines sorted by id by default', () => {
    const store = new BaselineStore(storagePath);
    seed(store);
    const list = store.listBaselines();
    expect(list.map(b => b.baselineId)).toEqual([
      'a/d/b/c',
      'b/d/b/c',
      'b/e/b/c',
    ]);
  });

  it('listBaselines respects status filter', () => {
    const store = new BaselineStore(storagePath);
    seed(store);
    const list = store.listBaselines({status: 'published'});
    expect(list.map(b => b.baselineId)).toEqual(['b/d/b/c']);
  });

  it('listBaselines respects keyPrefix filter', () => {
    const store = new BaselineStore(storagePath);
    seed(store);
    const list = store.listBaselines({keyPrefix: 'b/'});
    expect(list.map(b => b.baselineId)).toEqual(['b/d/b/c', 'b/e/b/c']);
  });
});

describe('BaselineStore — persistence', () => {
  it('persists across instances at the same path', () => {
    const store1 = new BaselineStore(storagePath);
    store1.addBaseline(makeBaseline({baselineId: 'b1'}));

    const store2 = new BaselineStore(storagePath);
    expect(store2.getBaseline('b1')).toBeDefined();
  });

  it('persisted file has schemaVersion 1 and is valid JSON', () => {
    const store = new BaselineStore(storagePath);
    store.addBaseline(makeBaseline({baselineId: 'b1'}));
    const raw = fs.readFileSync(storagePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.baselines).toHaveLength(1);
  });

  it('preserves corrupted on-disk JSON and refuses to overwrite it, quoting none of it', () => {
    // Unquoted, so the parser quotes the text around it: another user's baseline.
    const corrupt = '{"baselines":[{"appId":[BASELINE-CANARY-2a7c x]}]}';
    fs.writeFileSync(storagePath, corrupt, 'utf-8');
    const warnings = warningsDuring(() => {
      const store = new BaselineStore(storagePath);
      expect(store.getBaseline('b1')).toBeUndefined();
      expect(fs.existsSync(storagePath)).toBe(true);
      expect(() => store.addBaseline(makeBaseline({baselineId: 'b1'})))
        .toThrow(/^Baseline store is unreadable$/);
    });
    expect(JSON.stringify(warnings)).not.toContain('BASELINE-CANARY');
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe(corrupt);
  });

  it('atomic write does not leave the temp file around', () => {
    const store = new BaselineStore(storagePath);
    store.addBaseline(makeBaseline({baselineId: 'b1'}));
    expect(fs.existsSync(`${storagePath}.tmp`)).toBe(false);
  });

  it('does not crash on a missing storage file', () => {
    const store = new BaselineStore(path.join(tmpDir, 'absent.json'));
    expect(store.getBaseline('b1')).toBeUndefined();
  });
});
