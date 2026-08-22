// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  getCoreTraceSummarySpecV1,
  renderTraceSummarySpecV1,
} from '../traceSummarySpecRegistry';

describe('traceSummarySpecRegistry', () => {
  it('renders one deterministic upstream spec with stable metric semantics', () => {
    const first = getCoreTraceSummarySpecV1();
    const second = getCoreTraceSummarySpecV1();

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe('trace_summary_spec@1');
    expect(first.id).toBe('smartperfetto.core.v1');
    expect(first.digestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.metricIds).toEqual([
      'smartperfetto_trace_duration_ns',
      'smartperfetto_frame_timeline_total_count',
      'smartperfetto_frame_timeline_jank_count',
    ]);
    expect(first.metrics).toEqual([
      expect.objectContaining({
        id: 'smartperfetto_trace_duration_ns', dimensions: [], unit: 'TIME_NANOS',
        polarity: 'NOT_APPLICABLE', dimensionUniqueness: 'UNIQUE',
      }),
      expect.objectContaining({
        id: 'smartperfetto_frame_timeline_total_count', dimensions: [], unit: 'COUNT',
        polarity: 'NOT_APPLICABLE', dimensionUniqueness: 'UNIQUE',
      }),
      expect.objectContaining({
        id: 'smartperfetto_frame_timeline_jank_count', dimensions: [], unit: 'COUNT',
        polarity: 'LOWER_IS_BETTER', dimensionUniqueness: 'UNIQUE',
      }),
    ]);

    const rendered = renderTraceSummarySpecV1();
    expect(rendered).toContain('metric_spec {');
    expect(rendered).toContain('metric_template_spec {');
    expect(rendered).toContain('HAVING COUNT(*) > 0');
    expect(rendered).toContain('GROUP BY upid, name');
    expect(rendered).not.toContain('COUNT(*) FROM actual_frame_timeline_slice');
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('returns defensive copies so callers cannot mutate registry identity', () => {
    const first = getCoreTraceSummarySpecV1();
    first.metricIds.push('hostile');
    first.metrics[0].dimensions.push('hostile');

    const second = getCoreTraceSummarySpecV1();
    expect(second.metricIds).not.toContain('hostile');
    expect(second.metrics[0].dimensions).toEqual([]);
  });
});
