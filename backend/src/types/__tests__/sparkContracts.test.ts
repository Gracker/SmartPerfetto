// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  isUnsupported,
  makeSparkProvenance,
  type StdlibSkillCoverageContract,
  type TraceSummaryV2Contract,
  type SmartPerfettoSqlPackageContract,
  type ArtifactSchemaContract,
  type TimelineBinningContract,
  type AnonymizationContract,
} from '../sparkContracts';

describe('sparkContracts — shared provenance', () => {
  it('makeSparkProvenance stamps schemaVersion and createdAt', () => {
    const p = makeSparkProvenance({source: 'plan-01-test'});
    expect(p.schemaVersion).toBe(1);
    expect(p.source).toBe('plan-01-test');
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.unsupportedReason).toBeUndefined();
  });

  it('makeSparkProvenance carries unsupportedReason when supplied', () => {
    const p = makeSparkProvenance({
      source: 'plan-01-test',
      unsupportedReason: 'stdlib asset missing',
    });
    expect(p.unsupportedReason).toBe('stdlib asset missing');
    expect(isUnsupported(p)).toBe(true);
  });

  it('isUnsupported is false when no reason is set', () => {
    const p = makeSparkProvenance({source: 'plan-01-test'});
    expect(isUnsupported(p)).toBe(false);
  });
});

describe('Plan 01 — StdlibSkillCoverageContract', () => {
  it('accepts a minimal contract with only required provenance', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({source: 'stdlib-skill-coverage'}),
      totalModules: 0,
      modulesCovered: 0,
      skillsWithDrift: 0,
      uncoveredModules: [],
      skillUsage: [],
      coverage: [
        {sparkId: 1, planId: '01', status: 'scaffolded'},
        {sparkId: 21, planId: '01', status: 'scaffolded'},
      ],
    };
    expect(contract.coverage).toHaveLength(2);
    expect(contract.totalModules).toBe(0);
  });

  it('records unsupported probes without inventing metrics', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({
        source: 'stdlib-skill-coverage',
        unsupportedReason: 'stdlib asset missing on host',
      }),
      totalModules: 0,
      modulesCovered: 0,
      skillsWithDrift: 0,
      uncoveredModules: [],
      skillUsage: [],
      coverage: [{sparkId: 1, planId: '01', status: 'unsupported'}],
    };
    expect(isUnsupported(contract)).toBe(true);
    expect(contract.coverage[0].status).toBe('unsupported');
  });

  it('captures per-skill drift when a skill omits a stdlib prerequisite', () => {
    const contract: StdlibSkillCoverageContract = {
      ...makeSparkProvenance({source: 'stdlib-skill-coverage'}),
      totalModules: 200,
      modulesCovered: 60,
      skillsWithDrift: 1,
      uncoveredModules: [
        {module: 'android.input.events', declaredBySkills: 0, usedBySkills: 0},
      ],
      skillUsage: [
        {
          skillId: 'binder_root_cause',
          declared: ['android.binder'],
          detected: ['android.binder', 'slices.with_context'],
          declaredButUnused: [],
          detectedButUndeclared: ['slices.with_context'],
        },
      ],
      coverage: [{sparkId: 1, planId: '01', status: 'scaffolded'}],
    };
    expect(contract.skillUsage[0].detectedButUndeclared).toContain(
      'slices.with_context',
    );
    expect(contract.uncoveredModules[0].module).toBe('android.input.events');
  });
});

describe('Plan 02 — TraceSummaryV2Contract', () => {
  it('keeps probes and metrics aligned with provenance', () => {
    const contract: TraceSummaryV2Contract = {
      ...makeSparkProvenance({source: 'trace-summary-v2'}),
      traceProcessorBuild: 'v55.0',
      traceRange: {startNs: 0, endNs: 5_000_000_000},
      probes: {
        frame_timeline: true,
        cpu_frequency: false,
      },
      metrics: [
        {
          metricId: 'frames.jank_count',
          value: 12,
          unit: 'count',
          layer: 'L1',
          source: 'frame_timeline',
        },
      ],
      coverage: [
        {sparkId: 2, planId: '02', status: 'scaffolded'},
        {sparkId: 22, planId: '02', status: 'scaffolded'},
        {sparkId: 102, planId: '02', status: 'scaffolded'},
      ],
    };
    expect(contract.metrics[0].layer).toBe('L1');
    expect(contract.probes.cpu_frequency).toBe(false);
    expect(contract.coverage.map(c => c.sparkId)).toEqual([2, 22, 102]);
  });

  it('represents missing trace_processor builds as unsupported', () => {
    const contract: TraceSummaryV2Contract = {
      ...makeSparkProvenance({
        source: 'trace-summary-v2',
        unsupportedReason: 'trace_processor_shell version cannot be probed',
      }),
      traceRange: {startNs: 0, endNs: 0},
      probes: {},
      metrics: [],
      coverage: [{sparkId: 102, planId: '02', status: 'unsupported'}],
    };
    expect(isUnsupported(contract)).toBe(true);
    expect(contract.metrics).toHaveLength(0);
  });
});

describe('Plan 03 — SmartPerfettoSqlPackageContract', () => {
  it('lists exported symbols with stability and dependency provenance', () => {
    const contract: SmartPerfettoSqlPackageContract = {
      ...makeSparkProvenance({source: 'smartperfetto-sql-package'}),
      packageVersion: '0.1.0',
      symbols: [
        {
          name: 'smartperfetto.scrolling.jank_frames',
          kind: 'view',
          module: 'scrolling/jank_frames.sql',
          dependencies: ['android.frames.timeline'],
          stability: 'experimental',
        },
        {
          name: 'smartperfetto.binder.victim_to_server',
          kind: 'function',
          module: 'binder/victim_to_server.sql',
          dependencies: ['android.binder'],
          stability: 'experimental',
        },
      ],
      bootSnippet: 'INCLUDE PERFETTO MODULE smartperfetto.*;',
      coverage: [
        {sparkId: 3, planId: '03', status: 'scaffolded'},
        {sparkId: 36, planId: '03', status: 'scaffolded'},
      ],
    };
    expect(contract.symbols).toHaveLength(2);
    expect(contract.symbols[0].dependencies).toContain('android.frames.timeline');
    expect(contract.bootSnippet).toMatch(/INCLUDE PERFETTO MODULE/);
  });
});

describe('Plan 04 — ArtifactSchemaContract', () => {
  it('records compression strategy with full provenance', () => {
    const contract: ArtifactSchemaContract = {
      ...makeSparkProvenance({source: 'artifact-schema'}),
      artifactId: 'art-42',
      columns: [
        {name: 'frame_id', type: 'number', source: 'frame_timeline'},
        {name: 'dur_ns', type: 'duration', unit: 'ns', source: 'frame_timeline'},
        {name: 'jank_type', type: 'enum', source: 'frame_timeline'},
      ],
      compression: {
        strategy: 'top_k',
        originalRowCount: 5000,
        compressedRowCount: 50,
        ratio: 0.01,
        topK: 50,
      },
      rankBy: 'dur_ns',
      coverage: [
        {sparkId: 24, planId: '04', status: 'scaffolded'},
        {sparkId: 25, planId: '04', status: 'scaffolded'},
        {sparkId: 26, planId: '04', status: 'scaffolded'},
        {sparkId: 28, planId: '04', status: 'scaffolded'},
      ],
    };
    expect(contract.compression.strategy).toBe('top_k');
    expect(contract.compression.ratio).toBeCloseTo(0.01);
    expect(contract.columns[1].unit).toBe('ns');
  });

  it('preserves CUJ window when strategy is cuj_window', () => {
    const contract: ArtifactSchemaContract = {
      ...makeSparkProvenance({source: 'artifact-schema'}),
      artifactId: 'art-9',
      columns: [{name: 'ts', type: 'timestamp', unit: 'ns'}],
      compression: {
        strategy: 'cuj_window',
        originalRowCount: 100000,
        compressedRowCount: 1200,
        ratio: 0.012,
        window: {startNs: 1_000_000_000, endNs: 3_000_000_000},
      },
      range: {startNs: 1_000_000_000, endNs: 3_000_000_000},
      coverage: [{sparkId: 24, planId: '04', status: 'scaffolded'}],
    };
    expect(contract.compression.window).toEqual({
      startNs: 1_000_000_000,
      endNs: 3_000_000_000,
    });
  });
});

describe('Plan 05 — TimelineBinningContract', () => {
  it('represents binned stream output with aggregation', () => {
    const contract: TimelineBinningContract = {
      ...makeSparkProvenance({source: 'timeline-binning'}),
      trackId: 'cpu0_freq',
      range: {startNs: 0, endNs: 10_000_000_000},
      binDurNs: 50_000_000,
      aggregation: 'avg',
      bins: [
        {startNs: 0, durNs: 50_000_000, value: 1_200_000, rowCount: 5},
        {startNs: 50_000_000, durNs: 50_000_000, value: 1_800_000, rowCount: 4},
      ],
      originalSampleCount: 9,
      coverage: [{sparkId: 23, planId: '05', status: 'scaffolded'}],
    };
    expect(contract.bins).toHaveLength(2);
    expect(contract.aggregation).toBe('avg');
  });

  it('represents counter RLE turning points', () => {
    const contract: TimelineBinningContract = {
      ...makeSparkProvenance({source: 'counter-rle'}),
      trackId: 12345,
      range: {startNs: 0, endNs: 5_000_000_000},
      rle: [
        {startNs: 0, endNs: 1_000_000_000, value: 50},
        {startNs: 1_000_000_000, endNs: 3_000_000_000, value: 80, delta: 30},
        {startNs: 3_000_000_000, endNs: 5_000_000_000, value: 60, delta: -20},
      ],
      originalSampleCount: 4096,
      coverage: [{sparkId: 27, planId: '05', status: 'scaffolded'}],
    };
    expect(contract.rle).toHaveLength(3);
    expect(contract.rle![1].delta).toBe(30);
    expect(contract.originalSampleCount).toBeGreaterThan(contract.rle!.length);
  });
});

describe('Plan 06 — AnonymizationContract', () => {
  it('captures stable identifier mappings across domains', () => {
    const contract: AnonymizationContract = {
      ...makeSparkProvenance({source: 'anonymizer'}),
      state: 'redacted',
      mappings: [
        {
          domain: 'package',
          original: 'com.example.confidential',
          placeholder: 'app_a',
        },
        {domain: 'process', original: 'main', placeholder: 'proc_a'},
        {
          domain: 'path',
          original: '/data/data/com.example.confidential/files/x.db',
          placeholder: '/data/data/app_a/files/file_1',
        },
      ],
      coverage: [{sparkId: 29, planId: '06', status: 'scaffolded'}],
    };
    expect(contract.state).toBe('redacted');
    expect(contract.mappings).toHaveLength(3);
  });

  it('tracks streaming progress for large traces', () => {
    const contract: AnonymizationContract = {
      ...makeSparkProvenance({source: 'large-trace-streamer'}),
      state: 'partial',
      mappings: [],
      pendingDomains: ['path', 'user_id'],
      streamProgress: {
        totalBytes: 2_000_000_000,
        processedBytes: 1_200_000_000,
        chunksEmitted: 24,
        done: false,
        lastChunkMs: 350,
      },
      coverage: [{sparkId: 30, planId: '06', status: 'scaffolded'}],
    };
    expect(contract.streamProgress?.done).toBe(false);
    expect(contract.pendingDomains).toContain('path');
  });
});
