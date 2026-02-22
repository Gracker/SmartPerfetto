import type {
  FocusInterval,
  StageDefinition,
  StagedAnalysisStrategy,
} from '../../../strategies';
import type { ExecutionContext } from '../../orchestratorTypes';

export type PrebuiltEntityType = 'frame' | 'session' | 'unknown';

export interface StrategyPrebuiltContext {
  prebuiltIntervals: FocusInterval[];
  hasPrebuiltContext: boolean;
  prebuiltEntityType: PrebuiltEntityType;
  effectiveTotalStages: number;
}

export function resolveStrategyPrebuiltContext(
  strategy: StagedAnalysisStrategy,
  ctx: ExecutionContext
): StrategyPrebuiltContext {
  const prebuiltIntervals = getPrebuiltIntervals(ctx);
  const hasPrebuiltContext = prebuiltIntervals.length > 0;
  const prebuiltEntityType = inferPrebuiltEntityType(prebuiltIntervals, hasPrebuiltContext);

  const stagesToRun = strategy.stages.filter(stage => {
    if (!hasPrebuiltContext) return true;
    const skip = shouldSkipStageForPrebuilt(stage, {
      hasPrebuiltContext,
      prebuiltEntityType,
    });
    return !skip.skip;
  });

  return {
    prebuiltIntervals,
    hasPrebuiltContext,
    prebuiltEntityType,
    effectiveTotalStages: stagesToRun.length,
  };
}

export function shouldSkipStageForPrebuilt(
  stage: StageDefinition,
  context: {
    hasPrebuiltContext: boolean;
    prebuiltEntityType: PrebuiltEntityType;
  }
): { skip: boolean; reason?: string } {
  if (!context.hasPrebuiltContext) {
    return { skip: false };
  }

  if (context.prebuiltEntityType === 'frame' && stage.name === 'session_overview') {
    return {
      skip: true,
      reason: 'Pre-built frame intervals (skip session overview)',
    };
  }

  const isDiscoveryStage = !!stage.extractIntervals;
  const allTasksGlobal = stage.tasks.every(t => t.scope === 'global');
  if (isDiscoveryStage && allTasksGlobal) {
    return {
      skip: true,
      reason: 'Using pre-built intervals from follow-up',
    };
  }

  return { skip: false };
}

function inferPrebuiltEntityType(
  prebuiltIntervals: FocusInterval[],
  hasPrebuiltContext: boolean
): PrebuiltEntityType {
  if (!hasPrebuiltContext) return 'unknown';
  const meta = prebuiltIntervals[0]?.metadata || {};
  if (meta.sourceEntityType === 'frame' || meta.frame_id || meta.frameId) return 'frame';
  if (meta.sourceEntityType === 'session' || meta.session_id || meta.sessionId) return 'session';
  return 'unknown';
}

function getPrebuiltIntervals(ctx: ExecutionContext): FocusInterval[] {
  const optionIntervals = ctx.options.prebuiltIntervals;
  if (Array.isArray(optionIntervals) && optionIntervals.length > 0) {
    return optionIntervals;
  }

  const incrementalIntervals = ctx.incrementalScope?.focusIntervals;
  if (Array.isArray(incrementalIntervals) && incrementalIntervals.length > 0) {
    return incrementalIntervals;
  }

  return [];
}
