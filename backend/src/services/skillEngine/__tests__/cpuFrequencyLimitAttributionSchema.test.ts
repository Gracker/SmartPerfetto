// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';

/**
 * Contract test for the CPU frequency limit attribution Skill family.
 *
 * These Skills exist to separate three things a Perfetto trace keeps apart but
 * a reader easily conflates: a limit that was APPLIED, kernel thermal
 * mitigation that happened AT THE SAME TIME, and a name that merely sounds
 * thermal. The assertions below pin that separation, the parameter contract the
 * iterator depends on, and the fragment wiring - all of which are silent
 * failures at runtime rather than loud ones.
 */
describe('cpu frequency limit attribution skill family', () => {
  const skillsDir = path.join(process.cwd(), 'skills');
  const load = (rel: string) => yaml.load(fs.readFileSync(path.join(skillsDir, rel), 'utf-8')) as any;

  const attribution = load('composite/cpu_frequency_limit_attribution.skill.yaml');
  const episode = load('composite/cpu_frequency_limit_episode.skill.yaml');
  const timeline = load('atomic/cpu_freq_limit_timeline.skill.yaml');
  const cooling = load('atomic/thermal_cooling_device_timeline.skill.yaml');
  const workload = load('atomic/cpu_workload_attribution_in_range.skill.yaml');
  const anomalies = load('atomic/cpu_anomalous_threads_in_range.skill.yaml');

  const step = (skill: any, id: string) => {
    const found = skill.steps?.find((s: any) => s.id === id);
    expect(found).toBeDefined();
    return found;
  };
  const columns = (s: any) => (s.display?.columns ?? []).map((c: any) => c.name);
  const inputNames = (skill: any) => (skill.inputs ?? []).map((i: any) => i.name);
  const inputDefault = (skill: any, name: string) =>
    (skill.inputs ?? []).find((i: any) => i.name === name)?.default;

  it('keeps the iterator parameter contract intact between the two composites', () => {
    // item_params map CHILD parameter name -> COLUMN NAME of the episodes row.
    // The engine looks the value up on the item and silently falls back to the
    // literal string when the column is missing, so a renamed column becomes a
    // string parameter rather than an error.
    const drilldown = step(attribution, 'episode_drilldown');
    expect(drilldown.item_skill).toBe(episode.name);

    const episodeColumns = columns(step(attribution, 'episodes'));
    const childInputs = new Set(inputNames(episode));

    for (const [param, column] of Object.entries<string>(drilldown.item_params)) {
      expect(childInputs.has(param)).toBe(true);
      expect(episodeColumns).toContain(column);
    }
    // The drill-down is anchored on the trace-wide onset, never on the start
    // of the window-clipped episode, and is scoped to the parent's window.
    expect(drilldown.item_params).toMatchObject({
      episode_start_ts: 'onset_ts',
      trace_episode_id: 'trace_episode_id',
      window_start_ts: 'window_start_ts',
      window_end_ts: 'window_end_ts',
    });
  });

  it('declares every threshold as an input with a documented default', () => {
    const thresholds = [
      ['episode_drop_pct', 10],
      ['merge_gap_ms', 500],
      ['lookback_ms', 10000],
      ['who_window_ms', 2000],
      ['cooling_coincidence_ms', 50],
      ['max_episodes', 3],
      ['cdev_policy_pair_ms', 1],
      ['cdev_policy_min_transitions', 3],
      ['cdev_policy_min_pair_pct', 80],
      ['sustained_pct', 80],
      ['spin_avg_slice_us', 200],
      ['spin_switches_per_s', 2000],
      ['waker_per_s', 500],
      ['kernel_daemon_share_pct', 10],
    ] as const;

    for (const [name, value] of thresholds) {
      expect(inputNames(attribution)).toContain(name);
      expect(inputDefault(attribution, name)).toBe(value);
    }

    for (const [name, value] of [
      ['sustained_pct', 80],
      ['spin_avg_slice_us', 200],
      ['spin_switches_per_s', 2000],
      ['waker_per_s', 500],
      ['kernel_daemon_share_pct', 10],
    ] as const) {
      expect(inputDefault(anomalies, name)).toBe(value);
    }
  });

  it('keeps the episode reference labelled as an in-trace observation', () => {
    const fragment = fs.readFileSync(
      path.join(skillsDir, 'fragments', 'system_cpu_freq_limit_spans.sql'), 'utf-8');
    // The reference is the largest max-limit seen in THIS trace. Calling it the
    // hardware maximum would turn "already throttled at trace start" into
    // "never throttled", which is the exact failure mode on an always-capped
    // device.
    expect(fragment).toContain("'observed_max_limit_in_trace_not_hardware_max' AS reference_basis");
    expect(columns(step(attribution, 'episodes'))).toContain('reference_basis');
    expect(columns(step(timeline, 'limit_summary'))).toContain('reference_basis');
  });

  it('keeps onset and offset observability visible on every episode row', () => {
    for (const s of [step(attribution, 'episodes'), step(timeline, 'limit_episodes')]) {
      expect(columns(s)).toEqual(expect.arrayContaining([
        'starts_at_data_start', 'ends_at_data_end', 'evidence_status',
        'trace_episode_id', 'onset_ts', 'onset_observed',
      ]));
    }
  });

  it('the drill-down reads the shared verdict and keeps no ladder', () => {
    // The closed class and rank tables are asserted by querying the fragment
    // in cpuFrequencyLimitVerdicts.test.ts.
    const who = step(episode, 'who_verdict');
    expect(who.sql_fragments).toContain('fragments/system_cpu_freq_limit_episode_verdicts.sql');
    expect(who.sql).not.toMatch(/THEN '(thermal_cooling_device_confirmed|userspace_thermal_daemon_active_before_limit)'/);
    expect(columns(who)).toEqual(expect.arrayContaining([
      'who_verdict', 'trigger_class', 'trigger_class_rank', 'onset_trigger_mix', 'onset_count',
      'confirmed_onset_count', 'onset_ts', 'onset_observed', 'cooling_policy_association', 'verdict_scope',
    ]));
  });

  it('labels signature matching as discovery material, never as evidence', () => {
    const discovery = step(attribution, 'vendor_signal_discovery');
    expect(columns(discovery)).toEqual(expect.arrayContaining([
      'matched_pattern', 'source_process', 'exploration_hint',
    ]));
    expect(discovery.sql).toContain("'discovery_candidate_not_evidence' AS evidence_scope");

    const signatures = fs.readFileSync(
      path.join(skillsDir, 'fragments', 'thermal_signal_signatures.sql'), 'utf-8');
    expect(signatures).toContain('exclude_pattern');
    // The generic `*limit*` probe must keep excluding the meminfo CommitLimit
    // counter, which is not a frequency limit at all.
    expect(signatures).toContain("'*commit*limit*'");
  });

  it('marks every attribution surface as observation rather than cause', () => {
    for (const [skill, id] of [
      [workload, 'workload_by_thread'],
      [workload, 'workload_summary'],
      [anomalies, 'anomalous_threads'],
      [episode, 'who_verdict'],
      [episode, 'limit_onsets'],
      [attribution, 'attribution_summary'],
    ] as const) {
      expect(columns(step(skill, id))).toContain('evidence_scope');
      const sources = [step(skill, id).sql, ...(step(skill, id).sql_fragments ?? [])
        .map((p: string) => fs.readFileSync(path.join(skillsDir, p), 'utf-8'))].join('\n');
      expect(sources).toContain("'observation_not_causal'");
    }
  });

  it('keeps the frequency-weighted work join on the interval intersect path', () => {
    const sql: string = step(workload, 'workload_by_thread').sql;
    // A hand written overlap join on these CTEs measured 7.8 s on a 60 s trace;
    // the stdlib operator measured 86 ms for an identical result.
    expect(sql).toContain('_interval_intersect!((ii_sched, ii_freq), (ucpu))');
    expect(sql).toContain('perfetto-interval-intersect-non-overlap-proof');
    expect(workload.prerequisites.modules).toContain('intervals.intersect');
  });

  it('keeps an explicit unavailable path instead of an empty result', () => {
    expect(step(timeline, 'limit_unavailable').sql).toContain('power/cpu_frequency_limits');
    expect(step(cooling, 'cooling_unavailable').sql).toContain('thermal/cdev_update');
    expect(step(attribution, 'no_limit_capture_advice').sql).toContain('power/cpu_frequency_limits');
    // Absence of cooling-device tracks must never read as absence of throttling.
    expect(step(cooling, 'cooling_unavailable').sql).toContain('用户态温控守护进程');
  });

  it('keeps the per-episode drill-down out of keyword triggering', () => {
    // It is invoked as an item_skill with a window it cannot derive on its own.
    expect(episode.triggers).toBeUndefined();
    expect(attribution.triggers?.keywords?.zh).toEqual(expect.arrayContaining(['限频', '温控']));
  });
});
