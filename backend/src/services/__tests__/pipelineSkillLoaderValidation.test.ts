// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeAll, describe, expect, it } from '@jest/globals';
import {
  getPipelineSkillLoader,
  renderingTypeSource,
  type PipelineCatalog,
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
    teaching: { source: renderingTypeSource('S01_OVERVIEW') },
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

  describe.each(['required_signals', 'scoring_signals', 'exclude_if'])('%s slice aliases', (kind) => {
    const detectionWith = (selector: Record<string, unknown>): unknown => ({
      scoring_signals: [{signal: 'valid', slice: 'A', weight: 1}],
      [kind]: [{...(kind === 'scoring_signals' ? {signal: 'alias', weight: 1} : {}), ...selector}],
    });

    it.each([
      [], [''], ['   '], ['A', null], ['A', 1], ['A', 'A'],
      'Draw*', null, undefined, new Array(1),
    ].map((patterns) => ({patterns})))('rejects an invalid alias array %#', ({patterns}) => {
      expect(() => validateDetection(detectionWith({slice_patterns: patterns})))
        .toThrow('invalid detection config');
    });

    it.each(['slice', 'slice_pattern', 'thread', 'thread_pattern'])('rejects aliases mixed with %s', (key) => {
      expect(() => validateDetection(detectionWith({slice_patterns: ['A', 'B'], [key]: 'A'})))
        .toThrow('exactly one selector');
    });

    it('accepts a nonempty OR group without treating each alias as a separate selector', () => {
      expect(() => validateDetection(detectionWith({slice_patterns: ['DrawGL*', 'WebViewFunctor::drawVk']})))
        .not.toThrow();
    });
  });

  it('loads all committed pipeline definitions', async () => {
    const loader = getPipelineSkillLoader();
    await loader.reload();

    expect(loader.getAllPipelineIds()).toHaveLength(31);
  });
});

describe('PipelineSkillLoader product teaching validation', () => {
  beforeAll(async () => {
    await getPipelineSkillLoader().reload();
  });

  const validateCatalog = (catalog: unknown): void =>
    (getPipelineSkillLoader() as any).validateCatalog(catalog);
  const catalogCopy = (): PipelineCatalog => structuredClone(getPipelineSkillLoader().getCatalog());

  it.each([
    ['title', ''],
    ['summary', '   '],
    ['title', 42],
    ['mermaidBlocks', 'flowchart LR'],
    ['mermaidBlocks', [null]],
    ['keySlices', undefined],
    ['keySlices', ['']],
    ['threadRoles', null],
    ['threadRoles', [null]],
    ['threadRoles', [{thread: '', responsibility: 'draw'}]],
    ['threadRoles', [{thread: 'main', responsibility: 42}]],
    ['threadRoles', [{thread: 'main', responsibility: 'draw', traceTag: null}]],
    ['threadRoles', [{thread: 'main', responsibility: 'draw', source: 'unexpected'}]],
  ])('rejects malformed teaching %s', (field, value) => {
    const catalog = catalogCopy();
    (catalog.rendering_types.S02_AOSP_STANDARD.teaching as unknown as Record<string, unknown>)[field] = value;
    expect(() => validateCatalog(catalog)).toThrow('invalid teaching card');
  });

  it.each([null, [], 'card'])('rejects a non-object teaching card', (teaching) => {
    const catalog = catalogCopy();
    (catalog.rendering_types.S02_AOSP_STANDARD as unknown as Record<string, unknown>).teaching = teaching;
    expect(() => validateCatalog(catalog)).toThrow('invalid teaching card');
  });

  it('rejects legacy document/source contracts instead of accepting article payloads', () => {
    const catalog = catalogCopy();
    expect(() => validateCatalog({...catalog, documents: []})).toThrow('product teaching v3 contract');
    expect(() => validateCatalog({...catalog, source: {repository: 'legacy'}})).toThrow('product teaching v3 contract');
    (catalog.rendering_types.S02_AOSP_STANDARD as unknown as Record<string, unknown>).document = 'legacy.md';
    expect(() => validateCatalog(catalog)).toThrow('invalid teaching card');
  });

  it('rejects a missing teaching type and an invalid default type', () => {
    const catalog = catalogCopy();
    catalog.pipelines.ANDROID_VIEW_STANDARD_BLAST.teaching_type_id = 'UNKNOWN';
    expect(() => validateCatalog(catalog)).toThrow('unknown teaching type');
    const invalidDefault = catalogCopy();
    invalidDefault.default.rendering_type_id = 'UNKNOWN';
    expect(() => validateCatalog(invalidDefault)).toThrow('Catalog default is invalid');
  });

  it('accepts optional thread trace tags and empty optional teaching lists', () => {
    const catalog = catalogCopy();
    catalog.rendering_types.S02_AOSP_STANDARD.teaching = {
      title: 'Product guidance', summary: 'Rendering boundaries',
      mermaidBlocks: [], keySlices: [],
      threadRoles: [{thread: 'main', responsibility: 'UI work'}],
    };
    expect(() => validateCatalog(catalog)).not.toThrow();
  });
});
