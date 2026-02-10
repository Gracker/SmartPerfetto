import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

describe('scrolling_analysis skill schema', () => {
  const skillPath = path.join(process.cwd(), 'skills', 'composite', 'scrolling_analysis.skill.yaml');
  const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;

  const getStep = (id: string) => {
    const step = skill.steps?.find((s: any) => s.id === id);
    expect(step).toBeDefined();
    return step;
  };

  const getColumn = (step: any, name: string) => {
    const column = step.display?.columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('keeps jank frame ms fields as duration_ms with ms unit', () => {
    const step = getStep('get_app_jank_frames');

    const mainDur = getColumn(step, 'main_dur_ms');
    expect(mainDur.type).toBe('duration');
    expect(mainDur.format).toBe('duration_ms');
    expect(mainDur.unit).toBe('ms');

    const renderDur = getColumn(step, 'render_dur_ms');
    expect(renderDur.type).toBe('duration');
    expect(renderDur.format).toBe('duration_ms');
    expect(renderDur.unit).toBe('ms');

    const dur = getColumn(step, 'dur_ms');
    expect(dur.type).toBe('duration');
    expect(dur.format).toBe('duration_ms');
    expect(dur.unit).toBe('ms');
  });

  it('keeps ns-based frame durations explicitly normalized to ms display', () => {
    const perfSummary = getStep('performance_summary');
    const avgFrameDur = getColumn(perfSummary, 'avg_frame_dur');
    const p95FrameDur = getColumn(perfSummary, 'p95_frame_dur');

    expect(avgFrameDur.type).toBe('duration');
    expect(avgFrameDur.format).toBe('duration_ms');
    expect(avgFrameDur.unit).toBe('ns');

    expect(p95FrameDur.type).toBe('duration');
    expect(p95FrameDur.format).toBe('duration_ms');
    expect(p95FrameDur.unit).toBe('ns');

    const sessionStep = getStep('scroll_sessions');
    const duration = getColumn(sessionStep, 'duration');
    const avgDur = getColumn(sessionStep, 'avg_dur');
    const maxDur = getColumn(sessionStep, 'max_dur');

    expect(duration.type).toBe('duration');
    expect(duration.format).toBe('duration_ms');
    expect(duration.unit).toBe('ns');

    expect(avgDur.type).toBe('duration');
    expect(avgDur.format).toBe('duration_ms');
    expect(avgDur.unit).toBe('ns');

    expect(maxDur.type).toBe('duration');
    expect(maxDur.format).toBe('duration_ms');
    expect(maxDur.unit).toBe('ns');
  });

  it('keeps timestamp-range binding for jank frame navigation', () => {
    const step = getStep('get_app_jank_frames');
    const startTs = getColumn(step, 'start_ts');
    const dur = getColumn(step, 'dur');
    const mainDur = getColumn(step, 'main_dur');
    const renderDur = getColumn(step, 'render_dur');

    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur');

    expect(dur.type).toBe('duration');
    expect(dur.format).toBe('duration_ms');
    expect(dur.unit).toBe('ns');

    expect(mainDur.type).toBe('duration');
    expect(mainDur.format).toBe('duration_ms');
    expect(mainDur.unit).toBe('ns');

    expect(renderDur.type).toBe('duration');
    expect(renderDur.format).toBe('duration_ms');
    expect(renderDur.unit).toBe('ns');
  });
});
