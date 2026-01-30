import { describe, it, expect } from '@jest/globals';
import { generateRenderingPipelineDetectionSkill } from '../services/renderingPipelineDetectionSkillGenerator';

describe('rendering_pipeline_detection generator', () => {
  it('generates determine_pipeline SQL from pipeline YAML detection config', async () => {
    const skill = await generateRenderingPipelineDetectionSkill();

    expect(skill.name).toBe('rendering_pipeline_detection');
    expect(skill.type).toBe('composite');

    const determineStep = skill.steps?.find((s) => s.id === 'determine_pipeline') as any;
    expect(determineStep).toBeTruthy();
    expect(typeof determineStep.sql).toBe('string');

    // A representative signal name from pipeline YAML that must appear in generated SQL.
    // This ensures YAML detection is the single source of truth for scoring configuration.
    expect(determineStep.sql).toContain('has_blast_buffer_queue');
    expect(determineStep.sql).toContain('ANDROID_VIEW_STANDARD_BLAST');
  });
});

