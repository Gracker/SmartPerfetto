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

  it('keeps timestamp-range binding for jank frame navigation', () => {
    const step = getStep('get_app_jank_frames');
    const startTs = getColumn(step, 'start_ts');

    expect(startTs.type).toBe('timestamp');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur');
  });
});
