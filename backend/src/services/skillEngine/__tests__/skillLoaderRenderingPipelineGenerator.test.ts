// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('skill loader rendering pipeline generator', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('loads the compact generated rendering_pipeline_detection skill by default', async () => {
    const { ensureSkillRegistryInitialized, skillRegistry } = await import('../skillLoader');

    await ensureSkillRegistryInitialized();

    const skill = skillRegistry.getSkill('rendering_pipeline_detection') as any;
    const scoreStep = skill?.steps?.find((step: any) => step.id === 'score_pipelines');
    const determineStep = skill?.steps?.find((step: any) => step.id === 'determine_pipeline');

    expect(skill?.version).toBe('5.0');
    expect(scoreStep).toBeTruthy();
    expect(determineStep).toBeTruthy();
    expect(scoreStep.save_as).toBe('pipeline_scores');
    expect(determineStep.save_as).toBe('pipeline_result');
    expect(skill.steps.findIndex((step: any) => step.id === 'score_pipelines')).toBeLessThan(
      skill.steps.findIndex((step: any) => step.id === 'determine_pipeline')
    );
    expect(Buffer.byteLength(scoreStep.sql, 'utf8')).toBeLessThan(45_000);
    expect(Buffer.byteLength(determineStep.sql, 'utf8')).toBeLessThan(10_000);
    expect(scoreStep.sql).not.toContain('COALESCE((SELECT SUM(');
    expect(skill?.steps?.some((step: any) => step.id === 'pipeline_bundle')).toBe(true);
  });
});
