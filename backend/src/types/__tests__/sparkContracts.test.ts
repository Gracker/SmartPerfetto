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
  type TraceConfigGeneratorContract,
  type JankDecisionTreeContract,
  type ThreadSchedContextContract,
  type BinderRootCauseChainContract,
  type CpuThermalPmuContract,
  type MemoryRootCauseContract,
  type IoNetworkWakeupContract,
  type GpuSurfaceFlingerContract,
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

describe('Plan 07 — TraceConfigGeneratorContract', () => {
  it('emits config fragments with rationale and self-description', () => {
    const contract: TraceConfigGeneratorContract = {
      ...makeSparkProvenance({source: 'trace-config-generator'}),
      fragments: [
        {
          dataSource: 'linux.ftrace',
          reason: 'scheduler events for jank',
          options: {sched_switch: 'true'},
        },
        {
          dataSource: 'android.frametimeline',
          reason: 'frame jank ground truth',
        },
      ],
      customSlices: [
        {
          name: 'AppEvent.firstFrame',
          trackHint: 'main_thread',
          emittedBy: 'analytics-sdk',
          fields: [
            {name: 'frame_id', type: 'number'},
            {name: 'duration_ms', type: 'duration', unit: 'ms'},
          ],
        },
      ],
      selfDescription: {
        ...makeSparkProvenance({source: 'self-description'}),
        packageName: 'com.example.app',
        cuj: 'scroll_feed',
        device: 'Pixel 8 Pro / Android 15',
        intent: 'scrolling',
      },
      rationale: 'Targeted scroll-jank capture with FrameTimeline + sched.',
      coverage: [
        {sparkId: 53, planId: '07', status: 'scaffolded'},
        {sparkId: 197, planId: '07', status: 'scaffolded'},
        {sparkId: 201, planId: '07', status: 'scaffolded'},
      ],
    };
    expect(contract.fragments).toHaveLength(2);
    expect(contract.customSlices?.[0].fields?.[1].unit).toBe('ms');
    expect(contract.selfDescription?.cuj).toBe('scroll_feed');
  });
});

describe('Plan 10 — JankDecisionTreeContract', () => {
  it('routes a frame from FrameTimeline ground truth to a leaf verdict', () => {
    const contract: JankDecisionTreeContract = {
      ...makeSparkProvenance({source: 'jank-decision-tree'}),
      root: {
        nodeId: 'root',
        label: 'jank_type branching',
        rule: 'switch on actual_frame_timeline_slice.jank_type',
        children: [
          {
            nodeId: 'app_deadline_missed',
            label: 'App deadline missed',
            confidence: 'high',
            children: [
              {
                nodeId: 'app_cpu_starvation',
                label: 'CPU starvation on UI thread',
                rule: 'thread_state.runnable_dur > 5ms',
                skillId: 'thread_state',
                confidence: 'medium',
              },
            ],
          },
          {
            nodeId: 'sf_cpu_deadline_missed',
            label: 'SurfaceFlinger CPU deadline missed',
            confidence: 'high',
          },
        ],
      },
      frameAttributions: [
        {
          frameId: 100123,
          range: {startNs: 5_000_000_000, endNs: 5_016_667_000},
          jankType: 'AppDeadlineMissed',
          routePath: ['root', 'app_deadline_missed', 'app_cpu_starvation'],
          reasonCode: 'cpu_starvation',
          evidence: [{skillId: 'thread_state', stepId: 'aggregate'}],
        },
      ],
      coverage: [
        {sparkId: 16, planId: '10', status: 'scaffolded'},
        {sparkId: 31, planId: '10', status: 'scaffolded'},
      ],
    };
    expect(contract.frameAttributions[0].jankType).toBe('AppDeadlineMissed');
    expect(contract.frameAttributions[0].routePath).toEqual([
      'root',
      'app_deadline_missed',
      'app_cpu_starvation',
    ]);
  });

  it('keeps unclassified frames separate when FrameTimeline is missing', () => {
    const contract: JankDecisionTreeContract = {
      ...makeSparkProvenance({
        source: 'jank-decision-tree',
        unsupportedReason: 'frame_timeline data unavailable',
      }),
      root: {nodeId: 'root', label: 'no data'},
      frameAttributions: [],
      unclassifiedFrames: [
        {
          frameId: 200001,
          range: {startNs: 0, endNs: 16_667_000},
          jankType: 'Unknown',
          routePath: [],
        },
      ],
      coverage: [{sparkId: 16, planId: '10', status: 'unsupported'}],
    };
    expect(isUnsupported(contract)).toBe(true);
    expect(contract.unclassifiedFrames).toHaveLength(1);
  });
});

describe('Plan 11 — ThreadSchedContextContract', () => {
  it('captures thread state breakdown plus wakeup edges and critical chain', () => {
    const contract: ThreadSchedContextContract = {
      ...makeSparkProvenance({source: 'thread-sched-context'}),
      range: {startNs: 0, endNs: 100_000_000},
      threadStates: [
        {
          utid: 12,
          pid: 1234,
          threadName: 'main',
          range: {startNs: 0, endNs: 100_000_000},
          durByStateNs: {Running: 60_000_000, R: 5_000_000, S: 35_000_000},
          wakeupCount: 24,
          runnableLatencyP95Ns: 1_200_000,
        },
      ],
      wakeupEdges: [
        {
          fromUtid: 5,
          toUtid: 12,
          ts: 1_000_000,
          latencyNs: 350_000,
          reason: 'binder',
        },
      ],
      criticalChain: [
        {
          utid: 12,
          threadName: 'main',
          range: {startNs: 0, endNs: 50_000_000},
          reason: 'on critical path during inflate()',
        },
      ],
      coverage: [
        {sparkId: 6, planId: '11', status: 'scaffolded'},
        {sparkId: 17, planId: '11', status: 'scaffolded'},
      ],
    };
    expect(contract.threadStates[0].durByStateNs.Running).toBe(60_000_000);
    expect(contract.wakeupEdges?.[0].reason).toBe('binder');
    expect(contract.criticalChain?.[0].threadName).toBe('main');
  });
});

describe('Plan 12 — BinderRootCauseChainContract', () => {
  it('chains victim to root cause across processes', () => {
    const contract: BinderRootCauseChainContract = {
      ...makeSparkProvenance({source: 'binder-root-cause'}),
      victim: {
        step: 0,
        side: 'client',
        pid: 1234,
        tid: 1234,
        process: 'com.example.app',
        thread: 'main',
        method: 'IPackageManager.queryIntentActivities',
        range: {startNs: 100_000_000, endNs: 200_000_000},
      },
      chain: [
        {
          step: 1,
          side: 'server',
          pid: 1000,
          tid: 1042,
          process: 'system_server',
          thread: 'binder:1000_3',
          method: 'queryIntentActivities',
          range: {startNs: 110_000_000, endNs: 195_000_000},
          blockedOn: 'lock(PackageManagerService.mLock)',
        },
        {
          step: 2,
          side: 'server',
          pid: 1000,
          tid: 1500,
          process: 'system_server',
          thread: 'PackageManager',
          method: 'scanPackageLocked',
          range: {startNs: 50_000_000, endNs: 110_000_000},
          blockedOn: 'io(read)',
        },
      ],
      rootCause: {
        step: 2,
        side: 'server',
        pid: 1000,
        tid: 1500,
        process: 'system_server',
        thread: 'PackageManager',
        method: 'scanPackageLocked',
        range: {startNs: 50_000_000, endNs: 110_000_000},
        blockedOn: 'io(read)',
      },
      coverage: [{sparkId: 7, planId: '12', status: 'scaffolded'}],
    };
    expect(contract.chain).toHaveLength(2);
    expect(contract.rootCause?.blockedOn).toBe('io(read)');
  });

  it('marks truncated chains rather than fabricating root cause', () => {
    const contract: BinderRootCauseChainContract = {
      ...makeSparkProvenance({source: 'binder-root-cause'}),
      victim: {
        step: 0,
        side: 'client',
        pid: 1234,
        tid: 1234,
        range: {startNs: 0, endNs: 100_000},
      },
      chain: [],
      truncated: true,
      coverage: [{sparkId: 7, planId: '12', status: 'scaffolded'}],
    };
    expect(contract.truncated).toBe(true);
    expect(contract.rootCause).toBeUndefined();
  });
});

describe('Plan 13 — CpuThermalPmuContract', () => {
  it('joins frequency residency, thermal decision, and PMU attribution', () => {
    const contract: CpuThermalPmuContract = {
      ...makeSparkProvenance({source: 'cpu-thermal-pmu'}),
      range: {startNs: 0, endNs: 1_000_000_000},
      cpuFreqResidency: [
        {cpu: 0, freqHz: 600_000_000, durNs: 200_000_000, fraction: 0.2},
        {cpu: 0, freqHz: 1_800_000_000, durNs: 800_000_000, fraction: 0.8},
      ],
      thermalSamples: [
        {zone: 'cpu0', ts: 100_000, tempMc: 75_000, throttleStage: 1},
      ],
      thermalDecision: 'soft_throttle',
      pmuAttribution: [
        {counter: 'cycles', value: 1.2e10, derived: {ipc: 0.85}},
      ],
      smoothVsJankComparison: {
        smoothFraction: 0.95,
        jankFraction: 0.6,
        delta: 0.35,
      },
      coverage: [
        {sparkId: 8, planId: '13', status: 'scaffolded'},
        {sparkId: 9, planId: '13', status: 'scaffolded'},
        {sparkId: 10, planId: '13', status: 'scaffolded'},
        {sparkId: 35, planId: '13', status: 'scaffolded'},
      ],
    };
    expect(contract.cpuFreqResidency?.[1].fraction).toBe(0.8);
    expect(contract.thermalDecision).toBe('soft_throttle');
    expect(contract.pmuAttribution?.[0].derived?.ipc).toBe(0.85);
    expect(contract.smoothVsJankComparison?.delta).toBeCloseTo(0.35);
  });
});

describe('Plan 14 — MemoryRootCauseContract', () => {
  it('combines RSS, LMK, DMABUF and external artifacts', () => {
    const contract: MemoryRootCauseContract = {
      ...makeSparkProvenance({source: 'memory-root-cause'}),
      range: {startNs: 0, endNs: 60_000_000_000},
      processSnapshots: [
        {
          pid: 1234,
          process: 'com.example.app',
          ts: 1_000_000,
          rssBytes: 800_000_000,
          swapBytes: 100_000_000,
          oomScoreAdj: 100,
          mmEvent: {majorFaults: 200},
        },
      ],
      lmkEvents: [
        {
          ts: 30_000_000_000,
          pid: 5678,
          process: 'com.example.background',
          oomScoreAdj: 600,
          reason: 'visible_app_critical',
          freedBytes: 250_000_000,
        },
      ],
      dmaAllocations: [
        {
          ts: 45_000_000_000,
          bufferBytes: 50_000_000,
          allocator: 'dmabuf',
          process: 'composer',
          refcount: 2,
        },
      ],
      externalArtifacts: [
        {
          kind: 'leak_canary',
          artifactId: 'art-leak-1',
          summary: 'Activity leak in MainActivity',
          retainedBytes: 80_000_000,
        },
      ],
      baselineDiff: {
        baselineId: 'app/cold_start',
        deltaBytes: 120_000_000,
        topContributors: [
          {key: 'graphics_buffer', deltaBytes: 60_000_000},
          {key: 'java_heap', deltaBytes: 40_000_000},
        ],
      },
      coverage: [
        {sparkId: 11, planId: '14', status: 'scaffolded'},
        {sparkId: 12, planId: '14', status: 'scaffolded'},
        {sparkId: 13, planId: '14', status: 'scaffolded'},
        {sparkId: 34, planId: '14', status: 'scaffolded'},
        {sparkId: 51, planId: '14', status: 'scaffolded'},
        {sparkId: 70, planId: '14', status: 'scaffolded'},
        {sparkId: 109, planId: '14', status: 'scaffolded'},
        {sparkId: 112, planId: '14', status: 'scaffolded'},
      ],
    };
    expect(contract.lmkEvents?.[0].reason).toBe('visible_app_critical');
    expect(contract.externalArtifacts?.[0].retainedBytes).toBe(80_000_000);
    expect(contract.baselineDiff?.topContributors).toHaveLength(2);
  });
});

describe('Plan 15 — IoNetworkWakeupContract', () => {
  it('blends IO, network, wakelock baseline and wakeup edges', () => {
    const contract: IoNetworkWakeupContract = {
      ...makeSparkProvenance({source: 'io-network-wakeup'}),
      range: {startNs: 0, endNs: 5_000_000_000},
      ioEvents: [
        {
          ts: 100_000_000,
          durNs: 50_000_000,
          process: 'com.example.app',
          thread: 'main',
          op: 'fsync',
          path: '/data/data/com.example.app/databases/main.db',
          bytes: 4096,
          fs: 'f2fs',
        },
      ],
      networkAttribution: [
        {
          endpoint: 'api.example.com:443',
          process: 'com.example.app',
          ts: 200_000_000,
          durNs: 800_000_000,
          protocol: 'tcp',
          bytesIn: 50_000,
          bytesOut: 1_200,
          waitReason: 'tcp_recv',
        },
      ],
      wakelockBaseline: [
        {
          process: 'com.example.app',
          uid: 10100,
          totalMs: 12_000,
          wakeCount: 24,
          medianMs: 250,
        },
      ],
      wakeupEdges: [
        {
          fromUtid: 5,
          toUtid: 12,
          ts: 100_500_000,
          latencyNs: 200_000,
          reason: 'irq[mmc0]',
        },
      ],
      coverage: [
        {sparkId: 15, planId: '15', status: 'scaffolded'},
        {sparkId: 18, planId: '15', status: 'scaffolded'},
        {sparkId: 20, planId: '15', status: 'scaffolded'},
        {sparkId: 56, planId: '15', status: 'scaffolded'},
      ],
    };
    expect(contract.ioEvents?.[0].fs).toBe('f2fs');
    expect(contract.networkAttribution?.[0].waitReason).toBe('tcp_recv');
    expect(contract.wakelockBaseline?.[0].wakeCount).toBe(24);
    expect(contract.wakeupEdges?.[0].reason).toMatch(/irq/);
  });
});

describe('Plan 16 — GpuSurfaceFlingerContract', () => {
  it('captures render stages, composition outcomes and vendor imports', () => {
    const contract: GpuSurfaceFlingerContract = {
      ...makeSparkProvenance({source: 'gpu-surfaceflinger'}),
      range: {startNs: 0, endNs: 1_000_000_000},
      renderStages: [
        {stage: 'vertex_shading', durNs: 4_000_000, vendorBucket: 'mali_g78'},
        {stage: 'fragment_shading', durNs: 12_000_000, vendorBucket: 'mali_g78'},
      ],
      surfaceFlingerCompositions: [
        {
          vsyncId: 1024,
          ts: 100_000_000,
          hwcFallback: true,
          bufferStuffing: false,
          compositionDurNs: 6_500_000,
          layerCount: 6,
        },
      ],
      gpuMemory: [
        {ts: 500_000_000, process: 'composer', bytes: 200_000_000, bucket: 'gl'},
      ],
      vendorProfilerImports: [
        {
          kind: 'agi',
          artifactId: 'art-agi-1',
          range: {startNs: 0, endNs: 1_000_000_000},
          summary: 'AGI counters captured.',
        },
      ],
      surfaceFlingerLatency: {
        layerName: 'com.example.app/MainActivity',
        framesAnalyzed: 600,
        p95DesiredPresentNs: 16_667_000,
        droppedFrames: 12,
      },
      coverage: [
        {sparkId: 14, planId: '16', status: 'scaffolded'},
        {sparkId: 19, planId: '16', status: 'scaffolded'},
        {sparkId: 46, planId: '16', status: 'scaffolded'},
        {sparkId: 65, planId: '16', status: 'scaffolded'},
        {sparkId: 66, planId: '16', status: 'scaffolded'},
        {sparkId: 106, planId: '16', status: 'scaffolded'},
        {sparkId: 107, planId: '16', status: 'scaffolded'},
      ],
    };
    expect(contract.renderStages?.[1].vendorBucket).toBe('mali_g78');
    expect(contract.surfaceFlingerCompositions?.[0].hwcFallback).toBe(true);
    expect(contract.vendorProfilerImports?.[0].kind).toBe('agi');
    expect(contract.surfaceFlingerLatency?.droppedFrames).toBe(12);
  });
});
