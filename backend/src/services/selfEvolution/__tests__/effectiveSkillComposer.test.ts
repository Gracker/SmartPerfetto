// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {jest} from '@jest/globals';

import type {
  SkillOverlayDeltaV1,
} from '../../../types/selfEvolution';
import {SkillExecutor} from '../../skillEngine/skillExecutor';
import type {SkillDefinition} from '../../skillEngine/types';
import {
  composeEffectiveSkills,
  parseSkillOverlayDeltaV1,
} from '../effectiveSkillComposer';
import {fingerprintSkillDefinition} from '../skillFingerprint';

const scope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
};

function baseSkill(
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    name: 'base_analysis',
    version: '1',
    type: 'composite',
    meta: {
      display_name: 'Base analysis',
      description: 'Base description',
      tags: ['base'],
    },
    triggers: {
      keywords: {zh: ['基础'], en: ['base']},
      patterns: ['base'],
    },
    steps: [{
      id: 'base_step',
      type: 'atomic',
      sql: 'SELECT 1 AS base_value',
    }],
    output: {
      fields: [{name: 'base_value'}],
      display: {
        title: 'Base display',
        layer: 'overview',
        level: 'summary',
        format: 'table',
      },
    },
    ...overrides,
  };
}

function overlay(
  base: SkillDefinition,
  overrides: Partial<SkillOverlayDeltaV1> = {},
): SkillOverlayDeltaV1 {
  return {
    schemaVersion: 1,
    overlayId: 'overlay_a',
    baseSkillId: base.name,
    baseFingerprint: fingerprintSkillDefinition(base),
    proposalId: 'proposal-a',
    createdAt: '2026-07-28T00:00:00.000Z',
    scope,
    operations: [{
      op: 'append_steps',
      operationId: 'append-step-a',
      steps: [{
        id: 'ovl_overlay_a_extra',
        type: 'atomic',
        sql: 'SELECT 2 AS overlay_value',
      }],
    }],
    ...overrides,
  };
}

describe('effectiveSkillComposer', () => {
  it('applies the closed operation set with replacement semantics', () => {
    const base = baseSkill();
    const result = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [overlay(base, {
        operations: [
          {
            op: 'append_steps',
            operationId: 'append-step-a',
            steps: [{
              id: 'ovl_overlay_a_extra',
              type: 'atomic',
              sql: 'SELECT 2 AS overlay_value',
            }],
          },
          {
            op: 'set_display',
            operationId: 'replace-display-a',
            display: {
              title: 'Overlay display',
              layer: 'list',
              level: 'detail',
              format: 'table',
            },
          },
          {
            op: 'set_metadata',
            operationId: 'replace-metadata-a',
            meta: {
              description: 'Overlay description',
              tags: ['overlay'],
            },
            triggers: {
              keywords: {en: ['overlay']},
              patterns: ['overlay'],
            },
          },
        ],
      })],
    });

    expect(result.validationState).toBe('passed');
    if (result.validationState !== 'passed') return;
    const effective = result.skills[0];
    expect(effective.steps?.map(step => step.id)).toEqual([
      'base_step',
      'ovl_overlay_a_extra',
    ]);
    expect(effective.output?.display).toMatchObject({
      title: 'Overlay display',
      layer: 'list',
    });
    expect(effective.output?.fields).toEqual([{name: 'base_value'}]);
    expect(effective.meta).toMatchObject({
      description: 'Overlay description',
      tags: ['overlay'],
      display_name: 'Base analysis',
    });
    expect(effective.triggers).toEqual({
      keywords: {en: ['overlay']},
      patterns: ['overlay'],
    });
    expect(result.appliedOverlayIds).toEqual({
      base_analysis: ['overlay_a'],
    });
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.steps)).toBe(true);
    expect(base.meta.description).toBe('Base description');
  });

  it('rejects unknown schema fields and invalid step prefixes', () => {
    const base = baseSkill();
    expect(parseSkillOverlayDeltaV1({
      ...overlay(base),
      unexpected: true,
    }).ok).toBe(false);

    const result = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [overlay(base, {
        operations: [{
          op: 'append_steps',
          operationId: 'append-step-a',
          steps: [{
            id: 'extra',
            type: 'atomic',
            sql: 'SELECT 2',
          }],
        }],
      })],
    });
    expect(result).toMatchObject({
      validationState: 'failed',
      reason: 'invalid_overlay',
    });
  });

  it('rejects incomplete or unknown SkillStep union members', () => {
    const base = baseSkill();
    for (const invalidStep of [
      {
        id: 'ovl_overlay_a_invalid',
        type: 'diagnostic',
      },
      {
        id: 'ovl_overlay_a_unknown',
        type: 'atomic',
        sql: 'SELECT 2',
        unexpected: true,
      },
      {
        id: 'ovl_overlay_a_missing_inputs',
        type: 'diagnostic',
        rules: [{
          condition: 'true',
          diagnosis: 'Missing diagnostic inputs.',
          confidence: 'high',
        }],
      },
      {
        id: 'ovl_overlay_a_missing_confidence',
        type: 'diagnostic',
        inputs: ['base_step'],
        rules: [{
          condition: 'true',
          diagnosis: 'Missing diagnostic confidence.',
        }],
      },
    ]) {
      const result = composeEffectiveSkills({
        scope,
        baseSkills: [base],
        overlays: [overlay(base, {
          operations: [{
            op: 'append_steps',
            operationId: 'append-step-a',
            steps: [invalidStep as never],
          }],
        })],
      });
      expect(result).toMatchObject({
        validationState: 'failed',
        reason: 'invalid_overlay',
      });
    }
  });

  it('rejects unknown nested set_display fields', () => {
    const base = baseSkill();
    const result = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [overlay(base, {
        operations: [{
          op: 'set_display',
          operationId: 'replace-display-a',
          display: {
            title: 'Overlay display',
            unexpected: true,
          } as never,
        }],
      })],
    });

    expect(result).toMatchObject({
      validationState: 'failed',
      reason: 'invalid_overlay',
    });
  });

  it('checks every overlay against the uncomposed base fingerprint', () => {
    const base = baseSkill();
    const result = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [overlay(base, {baseFingerprint: 'stale'})],
    });
    expect(result).toMatchObject({
      validationState: 'failed',
      reason: 'base_fingerprint_mismatch',
    });
  });

  it('rejects append_steps for deep, atomic, and metadata-only pipeline definitions', () => {
    const atomic = baseSkill();
    atomic.type = 'atomic';
    delete atomic.steps;
    atomic.sql = 'SELECT 1';
    for (const candidate of [
      baseSkill({type: 'deep'}),
      atomic,
      baseSkill({type: 'pipeline_definition', steps: []}),
    ]) {
      const result = composeEffectiveSkills({
        scope,
        baseSkills: [candidate],
        overlays: [overlay(candidate)],
      });
      expect(result).toMatchObject({
        validationState: 'failed',
        reason: 'operation_not_supported',
      });
    }
  });

  it('fails the whole base group when overlays replace the same leaf', () => {
    const base = baseSkill();
    const first = overlay(base, {
      operations: [{
        op: 'set_metadata',
        operationId: 'metadata-a',
        meta: {tags: ['first']},
      }],
    });
    const second = overlay(base, {
      overlayId: 'overlay_b',
      proposalId: 'proposal-b',
      createdAt: '2026-07-28T00:01:00.000Z',
      operations: [{
        op: 'set_metadata',
        operationId: 'metadata-b',
        meta: {tags: ['second']},
      }],
    });
    const result = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [first, second],
    });
    expect(result).toMatchObject({
      validationState: 'failed',
      reason: 'overlay_conflict',
    });
  });

  it('derives the same composition fingerprint for the same overlay set', () => {
    const base = baseSkill();
    const first = overlay(base);
    const second = overlay(base, {
      overlayId: 'overlay_b',
      proposalId: 'proposal-b',
      createdAt: '2026-07-28T00:01:00.000Z',
      operations: [{
        op: 'append_steps',
        operationId: 'append-step-b',
        steps: [{
          id: 'ovl_overlay_b_extra',
          type: 'atomic',
          sql: 'SELECT 3 AS overlay_value_b',
        }],
      }],
    });
    const forward = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [first, second],
    });
    const reverse = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [second, first],
    });

    expect(forward.validationState).toBe('passed');
    expect(reverse.validationState).toBe('passed');
    if (
      forward.validationState !== 'passed'
      || reverse.validationState !== 'passed'
    ) {
      return;
    }
    expect(reverse.compositionFingerprint)
      .toBe(forward.compositionFingerprint);
    expect(reverse.skills).toEqual(forward.skills);
  });

  it('executes appended steps through the real SkillExecutor', async () => {
    const base = baseSkill();
    const composition = composeEffectiveSkills({
      scope,
      baseSkills: [base],
      overlays: [overlay(base)],
    });
    expect(composition.validationState).toBe('passed');
    if (composition.validationState !== 'passed') return;

    const traceProcessor = {
      query: jest.fn<() => Promise<{
        columns: string[];
        rows: number[][];
      }>>()
        .mockResolvedValueOnce({columns: ['base_value'], rows: [[1]]})
        .mockResolvedValueOnce({columns: ['overlay_value'], rows: [[2]]}),
    };
    const executor = new SkillExecutor(traceProcessor);
    executor.registerSkills([...composition.skills]);

    const result = await executor.execute(base.name, 'trace-a');

    expect(result.success).toBe(true);
    expect(Object.keys(result.rawResults ?? {})).toEqual([
      'base_step',
      'ovl_overlay_a_extra',
    ]);
    expect(traceProcessor.query).toHaveBeenNthCalledWith(
      2,
      'trace-a',
      'SELECT 2 AS overlay_value',
    );
  });
});
