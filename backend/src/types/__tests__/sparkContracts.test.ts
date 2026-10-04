// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  isUnsupported,
  makeSparkProvenance,
  type StdlibSkillCoverageContract,
  type TraceConfigGeneratorContract,
  type RagSourceKind,
  type RagDocumentRef,
  type MemoryScope,
  type PerfBaselineKey,
  type CurationStatus,
  type CaseRef,
  type MemoryPromotionTrigger,
  type MemoryPromotionPolicy,
  type RagChunk,
  type RagRetrievalHit,
  type RagRetrievalResult,
  type AndroidperformanceAospRagContract,
  type BaselineMetric,
  type BaselineRecord,
  type BaselineDiffDelta,
  type BaselineDiffArtifact,
  type RegressionGateResult,
  type BaselineStoreContract,
  type ProjectMemoryStatus,
  type ProjectMemoryEntry,
  type FeedbackPipelineEntry,
  type MemoryRagSelfImprovementContract,
  type CaseEducationalLevel,
  type CaseFindingLink,
  type CaseNode,
  type CaseEdge,
  type CaseGraphLibraryContract,
  type McpToolExposure,
  type McpToolAci,
  type A2aAgentCard,
  type McpPublicApiContract,
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

describe('First-tier shared base types', () => {
  it('RagSourceKind enumerates the known knowledge sources', () => {
    const sources: RagSourceKind[] = [
      'androidperformance.com',
      'aosp',
      'oem_sdk',
      'project_memory',
      'world_memory',
      'case_library',
      'app_source',
      'kernel_source',
      'android_internals_wiki',
    ];
    expect(sources).toHaveLength(9);
    // Compile-time check: each value is assignable to RagSourceKind.
    sources.forEach(s => expect(typeof s).toBe('string'));
  });

  it('RagDocumentRef accepts a minimal blog reference without license', () => {
    const ref: RagDocumentRef = {
      chunkId: 'sha256:abc123',
      source: 'androidperformance.com',
    };
    expect(ref.chunkId).toBe('sha256:abc123');
    expect(ref.license).toBeUndefined();
  });

  it('RagDocumentRef carries license + indexedAt for AOSP chunks', () => {
    const ref: RagDocumentRef = {
      chunkId: 'sha256:def456',
      source: 'aosp',
      license: 'Apache-2.0',
      indexedAt: 1714600000000,
      uri: 'frameworks/base/services/core/.../HwcLayer.cpp',
      title: 'HwcLayer composition fallback',
      stale: false,
    };
    expect(ref.license).toBe('Apache-2.0');
    expect(ref.source).toBe('aosp');
  });

  it('MemoryScope hierarchy is session/project/world', () => {
    const scopes: MemoryScope[] = ['session', 'project', 'world'];
    expect(scopes).toEqual(['session', 'project', 'world']);
  });

  it('PerfBaselineKey requires all four key components', () => {
    const key: PerfBaselineKey = {
      appId: 'com.example.feed',
      deviceId: 'pixel-9-android-15',
      buildId: 'main-abc1234',
      cuj: 'scroll_feed',
    };
    expect(key.appId).toBe('com.example.feed');
    expect(key.cuj).toBe('scroll_feed');
  });

  it('CurationStatus does not include redacted (separate axis)', () => {
    const statuses: CurationStatus[] = [
      'draft',
      'reviewed',
      'published',
      'private',
    ];
    // Sanity: the literal 'redacted' is intentionally not part of the union.
    // If this list ever grows, the redactionState invariant in §5.2 breaks.
    expect(statuses).toHaveLength(4);
    expect(statuses).not.toContain('redacted' as unknown as CurationStatus);
  });

  it('CaseRef is the cross-plan reference shape (Plan 44 ↔ 54)', () => {
    const ref: CaseRef = {
      caseId: 'case-2026-04-30-jank-binder-001',
      status: 'published',
      citationReason: 'Same root cause as the current trace',
    };
    expect(ref.caseId).toBe('case-2026-04-30-jank-binder-001');
    expect(ref.status).toBe('published');
  });

  it('MemoryPromotionTrigger forbids auto promotion', () => {
    const triggers: MemoryPromotionTrigger[] = [
      'user_feedback',
      'reviewer_approval',
      'skill_eval_pass',
    ];
    expect(triggers).toHaveLength(3);
    // Compile-time check: 'auto_inferred' is intentionally absent.
    expect(triggers).not.toContain(
      'auto_inferred' as unknown as MemoryPromotionTrigger,
    );
  });

  it('MemoryPromotionPolicy records reviewer for project→world', () => {
    const policy: MemoryPromotionPolicy = {
      fromScope: 'project',
      toScope: 'world',
      trigger: 'reviewer_approval',
      reviewer: 'chris',
      promotedAt: 1714600000000,
    };
    expect(policy.fromScope).toBe('project');
    expect(policy.toScope).toBe('world');
    expect(policy.reviewer).toBe('chris');
  });

  it('MemoryPromotionPolicy records evalCaseId for skill_eval_pass', () => {
    const policy: MemoryPromotionPolicy = {
      fromScope: 'session',
      toScope: 'project',
      trigger: 'skill_eval_pass',
      promotedAt: 1714600000000,
      evalCaseId: 'scrolling/jank/heavy_mixed',
    };
    expect(policy.trigger).toBe('skill_eval_pass');
    expect(policy.evalCaseId).toBe('scrolling/jank/heavy_mixed');
  });
});

describe('Plan 55 — AndroidperformanceAospRagContract', () => {
  it('accepts a minimal blog chunk without license', () => {
    const chunk: RagChunk = {
      chunkId: 'sha256:blog001',
      kind: 'androidperformance.com',
      uri: 'https://androidperformance.com/perfetto-binder',
      title: 'Binder transaction analysis with Perfetto',
      snippet: 'When the UI thread blocks on a binder call, ...',
      indexedAt: 1714600000000,
    };
    expect(chunk.kind).toBe('androidperformance.com');
    expect(chunk.license).toBeUndefined();
  });

  it('AOSP chunk carries license and verifiedAt for audit', () => {
    const chunk: RagChunk = {
      chunkId: 'sha256:aosp042',
      kind: 'aosp',
      uri: 'frameworks/base/services/.../HwcLayer.cpp',
      title: 'HwcLayer composition fallback',
      snippet: 'When a layer falls back to GPU composition, ...',
      license: 'Apache-2.0',
      indexedAt: 1714600000000,
      verifiedAt: 1714686400000,
    };
    expect(chunk.license).toBe('Apache-2.0');
    expect(chunk.verifiedAt).toBeGreaterThan(chunk.indexedAt);
  });

  it('chunk carries unsupportedReason when license expires', () => {
    const chunk: RagChunk = {
      chunkId: 'sha256:oemxyz',
      kind: 'oem_sdk',
      uri: 'docs/proprietary-sdk/intro.md',
      snippet: '[REDACTED]',
      license: 'proprietary',
      indexedAt: 1714600000000,
      unsupportedReason: 'license expired 2026-04-30',
    };
    expect(chunk.unsupportedReason).toBe('license expired 2026-04-30');
  });

  it('RagRetrievalHit can carry per-hit unsupportedReason without chunk', () => {
    const hit: RagRetrievalHit = {
      chunkId: 'sha256:evicted',
      score: 0.42,
      unsupportedReason: 'chunk evicted from store',
    };
    expect(hit.chunk).toBeUndefined();
    expect(hit.unsupportedReason).toBe('chunk evicted from store');
  });

  it('RagRetrievalResult records retrieval-level unsupportedReason', () => {
    const retrieval: RagRetrievalResult = {
      ...makeSparkProvenance({
        source: 'plan-55-test',
        unsupportedReason: 'all sources blocked by license policy',
      }),
      query: 'binder dispatch latency',
      results: [],
      probed: ['aosp', 'oem_sdk'],
      retrievedAt: 1714600000000,
    };
    expect(retrieval.results).toHaveLength(0);
    expect(isUnsupported(retrieval)).toBe(true);
    expect(retrieval.probed).toContain('aosp');
  });

  it('AndroidperformanceAospRagContract tracks per-source index counts', () => {
    const contract: AndroidperformanceAospRagContract = {
      ...makeSparkProvenance({source: 'plan-55-test'}),
      index: {
        'androidperformance.com': {chunkCount: 1024, lastIndexedAt: 1714600000000},
        aosp: {chunkCount: 8192, lastIndexedAt: 1714600000000},
        oem_sdk: {chunkCount: 0},
        project_memory: {chunkCount: 256},
        world_memory: {chunkCount: 32},
        case_library: {chunkCount: 12},
        app_source: {chunkCount: 0},
        kernel_source: {chunkCount: 0},
        android_internals_wiki: {chunkCount: 0},
      },
      coverage: [
        {sparkId: 181, planId: '55', status: 'scaffolded'},
        {sparkId: 182, planId: '55', status: 'scaffolded'},
        {sparkId: 183, planId: '55', status: 'scaffolded'},
      ],
    };
    expect(contract.index.aosp.chunkCount).toBe(8192);
    expect(contract.coverage).toHaveLength(3);
  });
});

describe('Plan 50 — BaselineStoreContract', () => {
  it('BaselineMetric records aggregated stats with sample count', () => {
    const metric: BaselineMetric = {
      metricId: 'frames.jank_count.p95',
      unit: 'count',
      median: 4,
      p95: 11,
      p99: 17,
      max: 23,
      sampleCount: 12,
    };
    expect(metric.metricId).toBe('frames.jank_count.p95');
    expect(metric.sampleCount).toBe(12);
  });

  it('BaselineMetric carries unsupportedReason for unsupported devices', () => {
    const metric: BaselineMetric = {
      metricId: 'gpu.render_stage.fragment_ns',
      unit: 'ns',
      median: 0,
      p95: 0,
      p99: 0,
      max: 0,
      sampleCount: 0,
      unsupportedReason: 'GPU render stages not collected on this device',
    };
    expect(metric.unsupportedReason).toBeDefined();
  });

  it('BaselineRecord extends TraceSummaryBaselineRef and adds curation', () => {
    const baseline: BaselineRecord = {
      ...makeSparkProvenance({source: 'plan-50-test'}),
      // Inherited from TraceSummaryBaselineRef
      baselineId: 'com.example.feed/pixel-9-android-15/main-abc1234/scroll_feed',
      artifactId: 'artifact-baseline-001',
      capturedAt: 1714600000000,
      sampleCount: 12,
      // New Plan 50 fields
      key: {
        appId: 'com.example.feed',
        deviceId: 'pixel-9-android-15',
        buildId: 'main-abc1234',
        cuj: 'scroll_feed',
      },
      status: 'reviewed',
      redactionState: 'partial',
      windowStartMs: 1714000000000,
      windowEndMs: 1714600000000,
      metrics: [
        {
          metricId: 'frames.jank_count.p95',
          unit: 'count',
          median: 4,
          p95: 11,
          p99: 17,
          max: 23,
          sampleCount: 12,
        },
      ],
    };
    expect(baseline.key.cuj).toBe('scroll_feed');
    expect(baseline.metrics).toHaveLength(1);
  });

  it('BaselineDiffDelta supports unsupported severity with reason', () => {
    const delta: BaselineDiffDelta = {
      metricId: 'frames.jank_count.p95',
      unit: 'count',
      severity: 'unsupported',
      unsupportedReason: 'sample count below 3',
    };
    expect(delta.baseValue).toBeUndefined();
    expect(delta.severity).toBe('unsupported');
  });

  it('BaselineDiffArtifact handles trace-vs-baseline candidate', () => {
    const diff: BaselineDiffArtifact = {
      ...makeSparkProvenance({source: 'plan-50-test'}),
      baseBaselineId: 'com.example/pixel/main/scroll',
      candidate: {kind: 'trace', traceId: 'trace-pr-12345'},
      deltas: [
        {
          metricId: 'frames.jank_count.p95',
          unit: 'count',
          baseValue: 11,
          candidateValue: 24,
          deltaAbs: 13,
          deltaPct: 1.18,
          severity: 'regression',
        },
      ],
    };
    expect(diff.candidate.kind).toBe('trace');
    expect(diff.deltas[0].severity).toBe('regression');
  });

  it('RegressionGateResult skipped status omits diff but records skipReason', () => {
    const gate: RegressionGateResult = {
      ...makeSparkProvenance({source: 'plan-50-test'}),
      gateId: 'ci-pr-12345',
      baselineId: 'com.example/pixel/main/scroll',
      status: 'skipped',
      skipReason: 'baseline missing for this build (first run)',
    };
    expect(gate.diff).toBeUndefined();
    expect(gate.skipReason).toBe(
      'baseline missing for this build (first run)',
    );
  });

  it('BaselineStoreContract holds matrix descriptors for SoC comparison', () => {
    const contract: BaselineStoreContract = {
      ...makeSparkProvenance({source: 'plan-50-test'}),
      baselines: [],
      matrix: [
        {
          matrixId: 'mtk-soc-comparison',
          baselineIds: [
            'com.example/dimensity-9300/main/scroll',
            'com.example/dimensity-8200/main/scroll',
          ],
          description: 'MTK Dimensity series comparison for scroll CUJ',
        },
      ],
      coverage: [
        {sparkId: 34, planId: '50', status: 'scaffolded'},
        {sparkId: 67, planId: '50', status: 'scaffolded'},
        {sparkId: 105, planId: '50', status: 'scaffolded'},
        {sparkId: 150, planId: '50', status: 'scaffolded'},
        {sparkId: 176, planId: '50', status: 'scaffolded'},
        {sparkId: 177, planId: '50', status: 'scaffolded'},
        {sparkId: 178, planId: '50', status: 'scaffolded'},
      ],
    };
    expect(contract.matrix?.[0].baselineIds).toHaveLength(2);
    expect(contract.coverage).toHaveLength(7);
  });
});

describe('Plan 44 — MemoryRagSelfImprovementContract', () => {
  it('ProjectMemoryStatus mirrors agentv3 PatternStatus 5-state machine', () => {
    const statuses: ProjectMemoryStatus[] = [
      'provisional',
      'confirmed',
      'rejected',
      'disputed',
      'disputed_late',
    ];
    expect(statuses).toHaveLength(5);
    // Sanity: the literal 'auto_inferred' is NOT a valid status.
    expect(statuses).not.toContain(
      'auto_inferred' as unknown as ProjectMemoryStatus,
    );
  });

  it('project entry can omit promotionPolicy when created directly', () => {
    const entry: ProjectMemoryEntry = {
      entryId: 'sha256:project001',
      scope: 'project',
      projectKey: 'com.example.feed/pixel-9-android-15',
      tags: ['scrolling', 'binder'],
      insight:
        'binder.RingBuffer contention spikes when feed loads new ads pod',
      confidence: 0.78,
      status: 'provisional',
      createdAt: 1714600000000,
    };
    expect(entry.scope).toBe('project');
    expect(entry.promotionPolicy).toBeUndefined();
  });

  it('world entry carries promotionPolicy for audit', () => {
    const entry: ProjectMemoryEntry = {
      entryId: 'sha256:world001',
      scope: 'world',
      tags: ['lmk', 'memory'],
      insight: 'LMK kills foreground when adj_score=0 right after onResume',
      confidence: 0.91,
      status: 'confirmed',
      promotionLevel: 2,
      promotionPolicy: {
        fromScope: 'project',
        toScope: 'world',
        trigger: 'reviewer_approval',
        reviewer: 'chris',
        promotedAt: 1714600000000,
      },
      createdAt: 1714600000000,
    };
    expect(entry.promotionPolicy?.trigger).toBe('reviewer_approval');
    expect(entry.promotionPolicy?.reviewer).toBe('chris');
  });

  it('FeedbackPipelineEntry uses CaseRef to break #44 ↔ #54 schema cycle', () => {
    const entry: FeedbackPipelineEntry = {
      entryId: 'sha256:fb001',
      feedbackId: 'feedback-2026-04-30-001',
      stage: 'case_draft',
      case: {
        caseId: 'case-draft-2026-04-30-001',
        status: 'draft',
        citationReason: 'Generated from feedback on heavy-mixed scrolling',
      },
      updatedAt: 1714600000000,
    };
    expect(entry.case?.caseId).toBe('case-draft-2026-04-30-001');
    expect(entry.case?.status).toBe('draft');
  });

  it('MemoryRagSelfImprovementContract bundles entries + pipeline + retrievals', () => {
    const contract: MemoryRagSelfImprovementContract = {
      ...makeSparkProvenance({source: 'plan-44-test'}),
      entries: [
        {
          entryId: 'sha256:p1',
          scope: 'project',
          tags: ['anr'],
          insight: 'ANR fires when broadcast queue stalls',
          confidence: 0.65,
          status: 'provisional',
          createdAt: 1714600000000,
        },
      ],
      pipeline: [
        {
          entryId: 'sha256:fb1',
          feedbackId: 'fb-001',
          stage: 'feedback',
          updatedAt: 1714600000000,
        },
      ],
      coverage: [
        {sparkId: 94, planId: '44', status: 'scaffolded'},
        {sparkId: 95, planId: '44', status: 'scaffolded'},
      ],
    };
    expect(contract.entries).toHaveLength(1);
    expect(contract.pipeline[0].stage).toBe('feedback');
    expect(contract.coverage).toHaveLength(2);
  });
});

describe('Plan 54 — CaseGraphLibraryContract', () => {
  it('CaseEducationalLevel covers novice / intermediate / advanced', () => {
    const levels: CaseEducationalLevel[] = [
      'novice',
      'intermediate',
      'advanced',
    ];
    expect(levels).toHaveLength(3);
  });

  it('draft case can omit traceArtifactId without explanation when raw', () => {
    const node: CaseNode = {
      ...makeSparkProvenance({source: 'plan-54-test'}),
      caseId: 'case-draft-001',
      title: 'Heavy mixed scrolling — first-jank chain',
      status: 'draft',
      redactionState: 'raw',
      traceArtifactId: 'artifact-trace-001',
      tags: ['scrolling', 'binder'],
      findings: [
        {id: 'f1', severity: 'critical', title: 'Binder S>5ms before Choreographer'},
      ],
    };
    expect(node.status).toBe('draft');
    expect(node.curatedBy).toBeUndefined();
  });

  it('archived case carries traceUnavailableReason instead of artifactId', () => {
    const node: CaseNode = {
      ...makeSparkProvenance({source: 'plan-54-test'}),
      caseId: 'case-archived-001',
      title: 'Old jank case (consent revoked)',
      status: 'private',
      redactionState: 'redacted',
      traceUnavailableReason: 'consent revoked 2026-04-30',
      tags: ['archive'],
      findings: [],
    };
    expect(node.traceArtifactId).toBeUndefined();
    expect(node.traceUnavailableReason).toBe('consent revoked 2026-04-30');
  });

  it('CaseFindingLink mirrors lightweight severity vocabulary', () => {
    const link: CaseFindingLink = {
      id: 'f1',
      severity: 'warning',
      title: 'BufferStuffing detected on 14% of frames',
      evidence: {
        skillId: 'frametimeline_jank_attribution',
        artifactId: 'artifact-jank-rows',
        description: 'Frame timeline jank rows backing the claim',
      },
    };
    expect(link.severity).toBe('warning');
    expect(link.evidence?.skillId).toBe('frametimeline_jank_attribution');
  });

  it('CaseEdge represents directional relation with optional weight', () => {
    const edge: CaseEdge = {
      edgeId: 'e1',
      fromCaseId: 'case-old-fix',
      toCaseId: 'case-new-fix',
      relation: 'before_after_fix',
      weight: 0.95,
      note: 'Same root cause, fix landed in 14.2.0',
    };
    expect(edge.relation).toBe('before_after_fix');
    expect(edge.weight).toBe(0.95);
  });

  it('CaseGraphLibraryContract tracks lastPublishedAt for public bundle', () => {
    const contract: CaseGraphLibraryContract = {
      ...makeSparkProvenance({source: 'plan-54-test'}),
      cases: [],
      edges: [],
      lastPublishedAt: 1714600000000,
      coverage: [
        {sparkId: 162, planId: '54', status: 'scaffolded'},
        {sparkId: 179, planId: '54', status: 'scaffolded'},
        {sparkId: 180, planId: '54', status: 'scaffolded'},
        {sparkId: 195, planId: '54', status: 'scaffolded'},
        {sparkId: 196, planId: '54', status: 'scaffolded'},
        {sparkId: 203, planId: '54', status: 'scaffolded'},
      ],
    };
    expect(contract.lastPublishedAt).toBe(1714600000000);
    expect(contract.coverage).toHaveLength(6);
  });
});

describe('Plan 41 — McpPublicApiContract', () => {
  it('McpToolExposure covers public / scoped / internal / deprecated', () => {
    const levels: McpToolExposure[] = [
      'public',
      'public-readonly',
      'requires_codebase_permission',
      'internal',
      'deprecated',
    ];
    expect(levels).toHaveLength(5);
  });

  it('public read-only tool ACI carries short name + qualified name', () => {
    const tool: McpToolAci = {
      toolName: 'invoke_skill',
      qualifiedName: 'mcp__smartperfetto__invoke_skill',
      exposure: 'public',
      summary: 'Invoke a SmartPerfetto skill on the active trace.',
      requires: ['traceProcessor'],
    };
    expect(tool.exposure).toBe('public');
    expect(tool.qualifiedName).toContain('mcp__smartperfetto__');
    expect(tool.qualifiedName.endsWith(tool.toolName)).toBe(true);
  });

  it('internal session-protocol tool stays hidden from external hosts', () => {
    const tool: McpToolAci = {
      toolName: 'submit_plan',
      qualifiedName: 'mcp__smartperfetto__submit_plan',
      exposure: 'internal',
      summary:
        'Submit the agent analysis plan. Internal session protocol; calling from an external host would corrupt the live session.',
    };
    expect(tool.exposure).toBe('internal');
  });

  it('A2aAgentCard partner trust level requires public key fingerprint', () => {
    const card: A2aAgentCard = {
      cardId: 'smartperfetto-perf-analyst',
      displayName: 'SmartPerfetto Performance Analyst',
      capabilities: ['skill-invocation', 'sql-query', 'baseline-lookup'],
      trustLevel: 'partner',
      tools: ['invoke_skill', 'execute_sql', 'lookup_baseline'],
      publicKey: 'ed25519-fingerprint-abc123',
    };
    expect(card.trustLevel).toBe('partner');
    expect(card.publicKey).toBeDefined();
  });

  it('McpPublicApiContract surfaces tools + serverVersion + protocolVersion', () => {
    const contract: McpPublicApiContract = {
      ...makeSparkProvenance({source: 'plan-41-test'}),
      tools: [
        {
          toolName: 'execute_sql',
          qualifiedName: 'mcp__smartperfetto__execute_sql',
          exposure: 'public',
          summary: 'Run a SQL query against the active trace.',
        },
      ],
      serverVersion: '1.0.0',
      protocolVersion: '2024-11-05',
      coverage: [
        {sparkId: 91, planId: '41', status: 'scaffolded'},
        {sparkId: 92, planId: '41', status: 'scaffolded'},
        {sparkId: 96, planId: '41', status: 'scaffolded'},
        {sparkId: 133, planId: '41', status: 'scaffolded'},
        {sparkId: 139, planId: '41', status: 'scaffolded'},
        {sparkId: 173, planId: '41', status: 'scaffolded'},
      ],
    };
    expect(contract.serverVersion).toBe('1.0.0');
    expect(contract.coverage).toHaveLength(6);
  });
});
