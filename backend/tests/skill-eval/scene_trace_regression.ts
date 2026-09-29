/**
 * Scene Reconstruction Trace Regression
 *
 * Mandatory post-change regression suite for scene_reconstruction.
 *
 * Runs the skill on the canonical 6 trace files and checks:
 * 1) skill executes successfully;
 * 2) key extraction steps are present and successful;
 * 3) trace-specific minimum expectations remain true.
 */

import { createSkillEvaluator, getTestTracePath, findStepInLayers } from './runner';

type StepResultLike = {
  success?: boolean;
  error?: string;
  data?: any[];
};

type TraceCase = {
  file: string;
  label: string;
  minCounts?: Record<string, number>;
  maxUnlockEvents?: number;
  minMaxDurationMs?: Record<string, number>;
};

const TRACE_CASES: TraceCase[] = [
  // ── Launch traces (2) ──
  {
    file: 'lacunh_heavy.pftrace',
    label: '重度启动',
    minCounts: {
      app_launches: 1,
    },
    maxUnlockEvents: 0,
  },
  {
    file: 'launch_light.pftrace',
    label: '轻度启动',
    minCounts: {
      app_launches: 1,
    },
    maxUnlockEvents: 0,
  },
  // ── Scroll traces (4) ──
  {
    file: 'scroll_Standard-AOSP-App-Without-PreAnimation.pftrace',
    label: '标准滑动',
    maxUnlockEvents: 0,
  },
  {
    file: 'scroll-demo-customer-scroll.pftrace',
    label: '客户场景滑动',
    minCounts: {
      user_gestures: 1,
    },
    maxUnlockEvents: 0,
  },
  {
    file: 'Scroll-Flutter-327-TextureView.pftrace',
    label: 'Flutter TextureView 滑动',
    maxUnlockEvents: 0,
  },
  {
    file: 'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace',
    label: 'Flutter SurfaceView 滑动',
    maxUnlockEvents: 0,
  },
];

const REQUIRED_STEPS = [
  'input_coverage',
  'user_gestures',
  'scroll_initiation',
  'inertial_scrolls',
  'idle_periods',
  'app_launches',
  'system_events',
  'jank_events',
] as const;

const findStep = findStepInLayers;

async function runCase(testCase: TraceCase): Promise<void> {
  const evaluator = createSkillEvaluator('scene_reconstruction');

  try {
    await evaluator.loadTrace(getTestTracePath(testCase.file));
    const result = await evaluator.executeSkill(
      { trace_id: `scene_regression_${testCase.file}` },
      { allowFailedSteps: ['scene_summary'] },
    );

    if (!result.success) {
      throw new Error(`skill execution failed: ${result.error || 'unknown error'}`);
    }

    const counts: Record<string, number> = {};
    const maxDurationMs: Record<string, number> = {};
    let unlockEventCount = 0;

    for (const stepId of REQUIRED_STEPS) {
      const step = findStep(result.layers, stepId);
      if (!step) {
        throw new Error(`missing step result: ${stepId}`);
      }
      if (!step.success) {
        throw new Error(`step failed: ${stepId}, error=${step.error || 'unknown error'}`);
      }

      const count = Array.isArray(step.data) ? step.data.length : 0;
      counts[stepId] = count;
      maxDurationMs[stepId] = Array.isArray(step.data)
        ? step.data.reduce((max: number, row: any) => {
          const durNs = Number(row?.dur || 0);
          if (!Number.isFinite(durNs) || durNs <= 0) return max;
          const durMs = Math.floor(durNs / 1_000_000);
          return durMs > max ? durMs : max;
        }, 0)
        : 0;

      if (stepId === 'system_events') {
        unlockEventCount = Array.isArray(step.data)
          ? step.data.filter((row: any) => String(row?.event || '').includes('解锁')).length
          : 0;
      }
    }

    const gestures = findStep(result.layers, 'user_gestures')?.data || [];
    const gaps = findStep(result.layers, 'idle_periods')?.data || [];
    for (const gap of gaps) {
      if (gap.category !== 'unknown' || gap.source_status !== 'partial') {
        throw new Error('input observation gaps must not assert device/user idle');
      }
      for (const gesture of gestures) {
        const start = BigInt(gesture.ts);
        const end = start + BigInt(gesture.dur);
        if (BigInt(gap.ts) < end && start < BigInt(gap.ts) + BigInt(gap.dur)) {
          throw new Error('input coverage gap overlaps an observed contact');
        }
      }
    }
    const coverage = findStep(result.layers, 'input_coverage')?.data?.[0];
    if (!coverage || !coverage.normalization_version || coverage.output_truncated !== 0) {
      throw new Error('canonical trace must have explicit, untruncated input coverage');
    }
    if (testCase.file === 'scroll-demo-customer-scroll.pftrace') {
      const movement = gestures.filter((row: any) => row.gesture_type === 'touch_move');
      if (movement.length !== 2 || movement.some((row: any) => BigInt(row.dur) > 200000000n)) {
        throw new Error('customer trace must preserve two observed movement contacts without frame-based extensions');
      }
      if (coverage.physical_event_count !== 35 || coverage.observed_event_count !== 140) {
        throw new Error('customer trace physical-event/delivery identity regression');
      }
    }
    if (testCase.file === 'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace') {
      // Since the 99234d73fe runtime the app's 18 physical events carry their
      // action, so the contact resolves to one movement gesture; the 37
      // system_server/systemui deliveries still lack one and must stay counted.
      if (coverage.observed_event_count !== 55 || coverage.physical_event_count !== 18 ||
          coverage.missing_action_count !== 37 ||
          !gestures.some((row: any) => row.gesture_type === 'touch_move')) {
        throw new Error('SurfaceView contact must resolve to movement while missing-action deliveries stay counted');
      }
    }

    for (const [stepId, minCount] of Object.entries(testCase.minCounts || {})) {
      const actual = counts[stepId] ?? 0;
      if (actual < minCount) {
        throw new Error(`step ${stepId} count ${actual} < required ${minCount}`);
      }
    }

    if (typeof testCase.maxUnlockEvents === 'number' && unlockEventCount > testCase.maxUnlockEvents) {
      throw new Error(
        `system_events unlock count ${unlockEventCount} > max ${testCase.maxUnlockEvents}`
      );
    }

    for (const [stepId, minDurationMs] of Object.entries(testCase.minMaxDurationMs || {})) {
      const actual = maxDurationMs[stepId] ?? 0;
      if (actual < minDurationMs) {
        throw new Error(`step ${stepId} max duration ${actual}ms < required ${minDurationMs}ms`);
      }
    }

    console.log(
      `[PASS] ${testCase.label} (${testCase.file}) | ` +
      `gestures=${counts.user_gestures}, scroll_starts=${counts.scroll_initiation}, ` +
      `inertial=${counts.inertial_scrolls}, idle=${counts.idle_periods}, ` +
      `launches=${counts.app_launches}, sys=${counts.system_events}, ` +
      `unlock=${unlockEventCount}, janks=${counts.jank_events}`,
    );
  } finally {
    await evaluator.cleanup();
  }
}

async function main() {
  const failures: Array<{ trace: string; reason: string }> = [];

  for (const traceCase of TRACE_CASES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runCase(traceCase);
    } catch (error: any) {
      const reason = error?.message || String(error);
      failures.push({ trace: traceCase.file, reason });
      console.error(`[FAIL] ${traceCase.label} (${traceCase.file}) -> ${reason}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nScene trace regression failed:');
    for (const f of failures) {
      console.error(`- ${f.trace}: ${f.reason}`);
    }
    process.exit(1);
  }

  console.log('\nScene trace regression passed for all 6 traces.');
}

main().catch((error) => {
  console.error('[scene_trace_regression] fatal:', error);
  process.exit(1);
});
