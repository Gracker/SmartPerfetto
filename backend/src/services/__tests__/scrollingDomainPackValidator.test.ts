// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {validateCaseDomainPack} from '../caseDomainPacks';
import type {CaseKnowledgeFrontmatter} from '../../types/caseKnowledge';

function makeFrontmatter(
  overrides: Partial<CaseKnowledgeFrontmatter> = {},
): CaseKnowledgeFrontmatter {
  return {
    case_id: 'scroll_shader_compile_pixel8_001',
    title: 'Shader compile during scroll',
    status: 'reviewed',
    quality: 'curated',
    scene: 'scrolling',
    domain_pack: 'scrolling.v1',
    curator: 'perf-team',
    taxonomy: {
      primary_root_cause: 'shader_compile',
      secondary_root_causes: ['render_thread_heavy'],
      responsibility: 'app',
      severity: 'critical',
    },
    context: {
      app_architecture: 'android_view_standard',
      device_vendor: 'pixel',
      os_version: 'Android 15',
      refresh_rate_hz: 120,
      workload: 'list_scroll',
    },
    evidence_signatures: {
      required: [
        {field: 'reason_code', op: 'eq', value: 'shader_compile'},
        {
          field: 'render_slices',
          op: 'contains_any',
          value: ['compileShader', 'makePipeline'],
        },
      ],
      supportive: [
        {field: 'jank_responsibility', op: 'eq', value: 'APP'},
        {field: 'vsync_missed', op: 'gte', value: 1},
      ],
    },
    findings: [
      {
        id: 'f1',
        title: 'Shader compilation overlaps a dropped frame',
        evidence_refs: [],
        confidence: 'high',
      },
    ],
    recommendations: {
      app: [
        {
          id: 'app_precompile_shader',
          priority: 'P0',
          action: 'Precompile shaders before first scroll.',
          applies_when: 'Shader compile slices overlap dropped-frame windows.',
          risks: 'Warmup can move cost earlier.',
        },
      ],
      oem: [
        {
          id: 'oem_gpu_freq_floor',
          priority: 'P1',
          action: 'Inspect GPU and RenderThread scheduling response.',
          applies_when: 'Shader work remains after app-side precompile.',
          risks: 'Frequency policy can increase power.',
        },
      ],
    },
    relations: {
      similar_root_cause: [],
      same_app: [],
      same_device: [],
      before_after_fix: [],
      derived_pattern: [],
      contradicts: [],
    },
    ...overrides,
  };
}

describe('scrolling.v1 domain pack validation', () => {
  it('accepts known scrolling evidence fields and reason codes', () => {
    const result = validateCaseDomainPack(makeFrontmatter(), 'case.md');

    expect(result).toEqual([]);
  });

  it('accepts direct lock and RenderThread sync codes while preserving legacy snapshots', () => {
    for (const reasonCode of ['lock_contention', 'render_sync_wait', 'lock_binder_wait']) {
      const result = validateCaseDomainPack(
        makeFrontmatter({
          taxonomy: {
            primary_root_cause: reasonCode,
            secondary_root_causes: [],
            responsibility: 'app',
            severity: 'critical',
          },
          evidence_signatures: {
            required: [{field: 'reason_code', op: 'eq', value: reasonCode}],
            supportive: [],
          },
        }),
        'case.md',
      );

      expect(result).toEqual([]);
    }
  });

  it('accepts evidence-bound FrameTimeline terminal reason codes', () => {
    for (const reasonCode of [
      'prediction_error',
      'display_hal',
      'app_jank_unattributed',
      'frame_timeline_unattributed',
    ]) {
      const result = validateCaseDomainPack(
        makeFrontmatter({
          taxonomy: {
            primary_root_cause: reasonCode,
            secondary_root_causes: [],
            responsibility: reasonCode === 'app_jank_unattributed'
              ? 'app'
              : reasonCode === 'frame_timeline_unattributed'
                ? 'unknown'
                : 'oem',
            severity: 'warning',
          },
          evidence_signatures: {
            required: [{field: 'reason_code', op: 'eq', value: reasonCode}],
            supportive: [],
          },
        }),
        'case.md',
      );

      expect(result).toEqual([]);
    }
  });

  it('rejects evidence fields that the pack does not define', () => {
    const result = validateCaseDomainPack(
      makeFrontmatter({
        evidence_signatures: {
          required: [
            {field: 'render_thread_heavy_pct', op: 'gte', value: 80},
          ],
          supportive: [],
        },
      }),
      'case.md',
    );

    expect(result.map(issue => issue.message).join('\n')).toMatch(
      /render_thread_heavy_pct/,
    );
  });

  it('rejects unknown reason_code values', () => {
    const result = validateCaseDomainPack(
      makeFrontmatter({
        evidence_signatures: {
          required: [
            {field: 'reason_code', op: 'eq', value: 'not_a_reason'},
          ],
          supportive: [],
        },
      }),
      'case.md',
    );

    expect(result.map(issue => issue.message).join('\n')).toMatch(
      /not_a_reason/,
    );
  });

  it('rejects taxonomy root causes outside the scrolling.v1 vocabulary', () => {
    const result = validateCaseDomainPack(
      makeFrontmatter({
        taxonomy: {
          primary_root_cause: 'not_a_reason',
          secondary_root_causes: ['shader_compile'],
          responsibility: 'app',
          severity: 'critical',
        },
      }),
      'case.md',
    );

    expect(result.map(issue => issue.message).join('\n')).toMatch(
      /not_a_reason/,
    );
  });
});
