import { describe, expect, it } from '@jest/globals';
import { scrollingStrategy } from '../scrollingStrategy';

describe('scrollingStrategy', () => {
  it('defines analyze_scrolling as focused tool for overview and session_overview stages', () => {
    const overviewTask = scrollingStrategy.stages[0].tasks[0];
    const sessionOverviewTask = scrollingStrategy.stages[1].tasks[0];

    expect(overviewTask.focusTools).toEqual(['analyze_scrolling']);
    expect(sessionOverviewTask.focusTools).toEqual(['analyze_scrolling']);
  });

  it('keeps frame_analysis in direct skill mode with jank_frame_detail', () => {
    const frameAnalysisTask = scrollingStrategy.stages[2].tasks[0];

    expect(frameAnalysisTask.executionMode).toBe('direct_skill');
    expect(frameAnalysisTask.directSkillId).toBe('jank_frame_detail');
  });

  it('adds per-session system context skills for IO/network/thermal breadth', () => {
    const sessionTasks = scrollingStrategy.stages[1].tasks;
    const directSkills = sessionTasks
      .filter(task => task.executionMode === 'direct_skill')
      .map(task => task.directSkillId);

    expect(directSkills).toContain('io_pressure');
    expect(directSkills).toContain('network_analysis');
    expect(directSkills).toContain('thermal_throttling');
  });
});
