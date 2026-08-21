// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  getPipelineSkillLoader,
  type PipelineDefinition,
} from '../pipelineSkillLoader';

function pipelineWith(detection: unknown): PipelineDefinition {
  return {
    name: 'test_pipeline',
    version: '1.0.0',
    type: 'pipeline_definition',
    category: 'rendering',
    meta: {
      pipeline_id: 'TEST_PIPELINE',
      display_name: 'Test pipeline',
      description: 'A pipeline used to validate detection configuration.',
      icon: 'test',
      family: 'test',
    },
    detection: detection as PipelineDefinition['detection'],
    teaching: { source: 'rendering_pipelines/S01_rendering_types_overview.md' },
    auto_pin: { instructions: [] },
  };
}

function validateDetection(detection: unknown): void {
  (getPipelineSkillLoader() as any).validateDetection(
    pipelineWith(detection),
    'test_pipeline.skill.yaml',
  );
}

describe('PipelineSkillLoader detection validation', () => {
  it.each([
    ['two selectors', { signal: 'bad', slice: 'A', thread: 'B', weight: 1 }],
    ['missing signal', { slice: 'A', weight: 1 }],
    ['negative weight', { signal: 'bad', slice: 'A', weight: -1 }],
    ['NaN weight', { signal: 'bad', slice: 'A', weight: Number.NaN }],
    ['fractional weight', { signal: 'bad', slice: 'A', weight: 1.5 }],
    ['string weight', { signal: 'bad', slice: 'A', weight: '2' }],
    ['fractional min_count', { signal: 'bad', slice: 'A', weight: 1, min_count: 1.5 }],
    ['string min_count', { signal: 'bad', slice: 'A', weight: 1, min_count: '2' }],
  ])('fails closed for scoring signal with %s', (_label, scoringSignal) => {
    expect(() => validateDetection({ scoring_signals: [scoringSignal] }))
      .toThrow('invalid detection config');
  });

  it('fails closed for empty scoring signals', () => {
    expect(() => validateDetection({ scoring_signals: [] }))
      .toThrow('invalid detection config');
  });

  it.each([
    ['missing detection', undefined],
    ['missing scoring signals', {}],
    ['non-array scoring signals', { scoring_signals: {} }],
  ])('fails closed for %s', (_label, detection) => {
    expect(() => validateDetection(detection)).toThrow('invalid detection config');
  });

  it('fails closed when every scoring signal has zero weight', () => {
    expect(() => validateDetection({
      scoring_signals: [{ signal: 'valid', slice: 'A', weight: 0 }],
    })).toThrow('invalid detection config');
  });

  it('fails closed for an invalid required signal min_count', () => {
    expect(() => validateDetection({
      required_signals: [{ thread: 'main', min_count: 0 }],
      scoring_signals: [{ signal: 'valid', slice: 'A', weight: 1 }],
    })).toThrow('invalid detection config');
  });

  it('fails closed for an exclude signal with multiple selectors', () => {
    expect(() => validateDetection({
      scoring_signals: [{ signal: 'valid', slice: 'A', weight: 1 }],
      exclude_if: [{ slice: 'A', thread: 'B' }],
    })).toThrow('invalid detection config');
  });

  it('fails closed for an exclude signal with min_count', () => {
    expect(() => validateDetection({
      scoring_signals: [{ signal: 'valid', slice: 'A', weight: 1 }],
      exclude_if: [{ slice: 'ignored', min_count: 1 }],
    })).toThrow('invalid detection config');
  });

  it.each([
    ['', 'empty string'],
    [null, 'null'],
    [42, 'number'],
  ])('fails closed for a %s selector value', (selector, _label) => {
    expect(() => validateDetection({
      scoring_signals: [{ signal: 'valid', slice: selector, weight: 1 }],
    })).toThrow('invalid detection config');
  });

  it('fails closed for a typo-only selector', () => {
    expect(() => validateDetection({
      scoring_signals: [{ signal: 'valid', slice_patern: '*', weight: 1 }],
    })).toThrow('invalid detection config');
  });

  it.each([
    [
      'required_signals',
      {
        required_signals: [null],
        scoring_signals: [{ signal: 'valid', slice: 'A', weight: 1 }],
      },
    ],
    [
      'exclude_if',
      {
        exclude_if: [null],
        scoring_signals: [{ signal: 'valid', slice: 'A', weight: 1 }],
      },
    ],
    [
      'scoring_signals',
      {
        scoring_signals: [null, { signal: 'valid', slice: 'A', weight: 1 }],
      },
    ],
  ])('fails closed for a non-object %s entry', (kind, detection) => {
    expect(() => validateDetection(detection)).toThrow(
      `invalid detection config: test_pipeline.skill.yaml (TEST_PIPELINE): ${kind} entry must be an object`,
    );
  });

  it('includes the source file and pipeline ID in a detection error', () => {
    expect(() => validateDetection({ scoring_signals: [] })).toThrow(
      'invalid detection config: test_pipeline.skill.yaml (TEST_PIPELINE)',
    );
  });

  it('accepts a zero-weight signal when another signal has positive integer weight', () => {
    expect(() => validateDetection({
      required_signals: [{ thread: 'main', min_count: 1 }],
      scoring_signals: [
        {
          signal: 'zero_weight',
          slice_pattern: 'doFrame',
          weight: 0,
          min_count: 2,
        },
        { signal: 'valid', thread: 'main', weight: 1 },
      ],
      exclude_if: [{ slice: 'ignored' }],
    })).not.toThrow();
  });

  it('loads all committed pipeline definitions', async () => {
    const loader = getPipelineSkillLoader();
    await loader.reload();

    expect(loader.getAllPipelineIds()).toHaveLength(31);
  });
});
