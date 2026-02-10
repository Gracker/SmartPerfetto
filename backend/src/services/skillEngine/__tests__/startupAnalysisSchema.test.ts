import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

describe('startup_analysis skill schema', () => {
  const skillPath = path.join(process.cwd(), 'skills', 'composite', 'startup_analysis.skill.yaml');
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

  it('keeps startup timestamp navigation binding for range jump', () => {
    const step = getStep('get_startups');
    const startTs = getColumn(step, 'start_ts');
    const endTs = getColumn(step, 'end_ts');

    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur_ns');

    expect(endTs.type).toBe('timestamp');
    expect(endTs.unit).toBe('ns');
    expect(endTs.clickAction).toBe('navigate_timeline');
  });

  it('marks startup duration columns with ms display semantics', () => {
    const step = getStep('get_startups');

    const durMs = getColumn(step, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');
    expect(durMs.hidden).toBe(true);

    const durNs = getColumn(step, 'dur_ns');
    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');

    const ttid = getColumn(step, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const ttfd = getColumn(step, 'ttfd_ms');
    expect(ttfd.type).toBe('duration');
    expect(ttfd.format).toBe('duration_ms');
    expect(ttfd.unit).toBe('ms');
  });

  it('keeps IO duration metrics as duration_ms', () => {
    const step = getStep('main_thread_file_io');

    const total = getColumn(step, 'total_dur_ms');
    expect(total.type).toBe('duration');
    expect(total.format).toBe('duration_ms');
    expect(total.unit).toBe('ms');

    const avg = getColumn(step, 'avg_dur_ms');
    expect(avg.type).toBe('duration');
    expect(avg.format).toBe('duration_ms');
    expect(avg.unit).toBe('ms');

    const max = getColumn(step, 'max_dur_ms');
    expect(max.type).toBe('duration');
    expect(max.format).toBe('duration_ms');
    expect(max.unit).toBe('ms');
  });
});
