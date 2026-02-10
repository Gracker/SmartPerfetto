import { describe, expect, it } from '@jest/globals';
import { sceneReconstructionStrategy } from '../sceneReconstructionStrategy';
import type { FocusInterval } from '../types';

function buildInterval(sceneType: string): FocusInterval {
  return {
    id: 1,
    processName: 'com.example.app',
    startTs: '1000000',
    endTs: '2000000',
    priority: 90,
    label: sceneType,
    metadata: {
      sceneType,
    },
  };
}

describe('sceneReconstructionStrategy', () => {
  it('matches overview queries and ignores explicit startup deep-dive queries', () => {
    expect(sceneReconstructionStrategy.trigger('发生了什么')).toBe(true);
    expect(sceneReconstructionStrategy.trigger('整体分析 trace')).toBe(true);
    expect(sceneReconstructionStrategy.trigger('分析启动慢原因')).toBe(false);
  });

  it('routes startup vs non-startup scenes from manifest-driven stage2 tasks', () => {
    const stage2 = sceneReconstructionStrategy.stages.find(stage => stage.name === 'problem_scene_analysis');
    expect(stage2).toBeDefined();

    const startupTask = stage2!.tasks.find(task => task.directSkillId === 'startup_detail');
    const scrollingTask = stage2!.tasks.find(task => task.directSkillId === 'scrolling_analysis');

    expect(startupTask).toBeDefined();
    expect(scrollingTask).toBeDefined();

    expect(startupTask!.intervalFilter?.(buildInterval('cold_start'))).toBe(true);
    expect(startupTask!.intervalFilter?.(buildInterval('tap'))).toBe(false);

    expect(scrollingTask!.intervalFilter?.(buildInterval('tap'))).toBe(true);
    expect(scrollingTask!.intervalFilter?.(buildInterval('warm_start'))).toBe(false);
  });
});
