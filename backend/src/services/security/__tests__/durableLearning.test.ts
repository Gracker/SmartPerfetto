// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {NO_PRIVATE_CONTEXT} from '../analysisPrivateContext';
import {
  admitLearnedEntry,
  isAdmittedLearning,
  resolveDurableLearningPermission,
  withDurableLearningPermission,
} from '../durableLearning';

describe('durable learning permission', () => {
  it('is granted only from an explicit public marker to options that carry a run id', () => {
    expect(resolveDurableLearningPermission(withDurableLearningPermission({runId: 'run-a'}, NO_PRIVATE_CONTEXT)))
      .toEqual({runId: 'run-a'});
    for (const privateContext of [
      {codebase: true, knowledge: false},
      {codebase: false, knowledge: true},
      'unknown' as const,
      undefined,
      {} as never,
      {codebase: false} as never,
    ]) {
      expect(resolveDurableLearningPermission(withDurableLearningPermission({runId: 'run-a'}, privateContext)))
        .toBeUndefined();
    }
    expect(resolveDurableLearningPermission(withDurableLearningPermission({}, NO_PRIVATE_CONTEXT))).toBeUndefined();
  });

  it('binds the grant to the run it was issued for', () => {
    const granted = withDurableLearningPermission({runId: 'run-a'}, NO_PRIVATE_CONTEXT);
    expect(resolveDurableLearningPermission({...granted, runId: 'run-b'})).toBeUndefined();
    const {runId: _runId, ...withoutRunId} = granted;
    expect(resolveDurableLearningPermission(withoutRunId)).toBeUndefined();
  });

  it('survives internal options spreads but never JSON or a forged handle', () => {
    const granted = withDurableLearningPermission({runId: 'run-a', analysisMode: 'full' as const}, NO_PRIVATE_CONTEXT);
    const wrapped = {...granted, packageName: 'com.example'};
    expect(resolveDurableLearningPermission(wrapped)).toEqual({runId: 'run-a'});
    expect(resolveDurableLearningPermission(JSON.parse(JSON.stringify(granted)))).toBeUndefined();
    const [key] = Object.getOwnPropertySymbols(granted);
    const issued = (granted as Record<symbol, object>)[key];
    for (const handle of [Object.freeze({}), 'run-a', {runId: 'run-a'}, {...issued}]) {
      expect(resolveDurableLearningPermission({runId: 'run-a', [key]: handle})).toBeUndefined();
    }
  });

  it('is withdrawn when the selection carries private material', () => {
    const granted = withDurableLearningPermission({runId: 'run-a'}, NO_PRIVATE_CONTEXT);
    expect(resolveDurableLearningPermission({...granted, codebaseIds: ['app']})).toBeUndefined();
    expect(resolveDurableLearningPermission({...granted, knowledgeSourceIds: ['wiki']})).toBeUndefined();
    expect(resolveDurableLearningPermission({...granted, codeAwareMode: 'off', codebaseIds: ['app']}))
      .toEqual({runId: 'run-a'});
  });
});

describe('learning admission', () => {
  const grant = () => resolveDurableLearningPermission(withDurableLearningPermission({runId: 'run-a'}, NO_PRIVATE_CONTEXT));

  it('stamps an entry with the run that learned it, only under an issued permission', () => {
    const permission = grant();
    expect(admitLearnedEntry(permission, 42)).toEqual({
      version: 1, basis: 'public_run', runId: 'run-a', admittedAt: 42,
    });
    for (const forged of [
      undefined,
      {runId: 'run-a'},
      {...permission!},
      JSON.parse(JSON.stringify(permission)),
      'run-a' as never,
    ]) {
      expect(admitLearnedEntry(forged, 42)).toBeUndefined();
    }
  });

  it('admits only a complete stamp', () => {
    const stamp = admitLearnedEntry(grant(), 1)!;
    expect(isAdmittedLearning({learningAdmission: stamp})).toBe(true);
    for (const learningAdmission of [
      undefined,
      null,
      'public_run',
      {...stamp, version: 2},
      {...stamp, basis: 'curated'},
      {...stamp, runId: ''},
      {...stamp, runId: undefined},
      {...stamp, admittedAt: Number.NaN},
      {...stamp, admittedAt: '1'},
    ]) {
      expect(isAdmittedLearning({learningAdmission})).toBe(false);
    }
    expect(isAdmittedLearning(null)).toBe(false);
    expect(isAdmittedLearning('entry')).toBe(false);
  });
});
