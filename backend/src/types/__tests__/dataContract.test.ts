import {describe, it, expect} from '@jest/globals';
import {inferColumnDefinition} from '../dataContract';

describe('dataContract column inference', () => {
  it('infers start timestamp columns as range-navigable', () => {
    const start = inferColumnDefinition('start_ts');

    expect(start.type).toBe('timestamp');
    expect(start.clickAction).toBe('navigate_range');
    expect(start.durationColumn).toBe('dur_str');
    expect(start.unit).toBe('ns');
  });

  it('infers end timestamp columns as point-navigable', () => {
    const end = inferColumnDefinition('end_ts');

    expect(end.type).toBe('timestamp');
    expect(end.clickAction).toBe('navigate_timeline');
    expect(end.durationColumn).toBeUndefined();
    expect(end.unit).toBe('ns');
  });

  it('infers explicit duration suffix units correctly', () => {
    const durMs = inferColumnDefinition('dur_ms');
    const durUs = inferColumnDefinition('dur_us');
    const durNs = inferColumnDefinition('dur_ns');

    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    expect(durUs.type).toBe('duration');
    expect(durUs.format).toBe('duration_ms');
    expect(durUs.unit).toBe('us');

    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
  });

  it('does not misclassify refresh_rate as percentage', () => {
    const refreshRate = inferColumnDefinition('refresh_rate');

    expect(refreshRate.type).not.toBe('percentage');
  });
});
