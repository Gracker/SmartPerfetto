// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  ensureSkillRegistryInitialized,
  skillRegistry,
} from '../skillEngine/skillLoader';
import {
  assertBuiltInSkillLocalizationCoverage,
  localizeSkillDefinition,
  localizeSkillDiagnostics,
  localizeSkillDisplayResults,
  localizeSkillListItem,
  localizeSkillNarrative,
  localizedSchemaLabel,
  skillLocalizationInventory,
} from '../skillLocalization';

describe('Skill localization catalog', () => {
  it('uses authored titles instead of the legacy stable identifier while preserving that identifier', async () => {
    await ensureSkillRegistryInitialized();
    const skill = skillRegistry.getSkill('scene_reconstruction')!;
    for (const [locale, title] of [['en', 'Intervals with no observed input (capture completeness unconfirmed)'],
      ['zh-CN', '未观测到输入的区间（采集完整性未确认）']] as const) {
      const localized = localizeSkillDefinition(skill, locale);
      const step = localized.steps!.find(value => value.id === 'idle_periods') as any;
      expect(step.id).toBe('idle_periods');
      expect(step.name).toBe(title);
      expect(step.display.title).toBe(title);
      expect(step.display.title_i18n).toBeUndefined();
    }
    expect((skill.steps!.find(value => value.id === 'idle_periods') as any).display.title_i18n.en)
      .toBe('Intervals with no observed input (capture completeness unconfirmed)');
  });
  it('uses authored meta translations for the Skill name and description, then drops them from runtime meta', async () => {
    await ensureSkillRegistryInitialized();
    const skill = skillRegistry.getSkill('thermal_predictor')!;
    const english = localizeSkillDefinition(skill, 'en');
    expect(english.meta).toMatchObject({
      display_name: 'CPU Frequency Trend',
      description: expect.stringContaining('names no cause'),
    });
    expect(localizeSkillDefinition(skill, 'zh-CN').meta.display_name).toBe('CPU 频率趋势观察');
    for (const localized of [english, localizeSkillDefinition({...skill, name: 'not_in_catalog'}, 'en', {externalAuthored: true})]) {
      expect(localized.meta.display_name_i18n).toBeUndefined();
      expect(localized.meta.description_i18n).toBeUndefined();
    }
    expect(skill.meta.display_name_i18n?.en).toBe('CPU Frequency Trend');
  });

  it('strictly covers every built-in Skill and rendering pipeline', async () => {
    await ensureSkillRegistryInitialized();
    const skills = skillRegistry.getAllSkills();

    expect(() => assertBuiltInSkillLocalizationCoverage(skills)).not.toThrow();
    expect(skillLocalizationInventory()).toMatchObject({
      skillCount: skills.length,
      pipelineDefinitionCount: skills.filter(
        skill => skill.type === 'pipeline_definition',
      ).length,
      moduleExpertCount: skills.filter(skill => Boolean(skill.module)).length,
    });
  });

  it('localizes display metadata without changing identifiers or narratives', () => {
    const source = {
      id: 'scrolling_analysis',
      displayName: '滑动性能分析',
      description: '分析滑动性能',
      origin: {origin: 'built_in' as const},
    };

    expect(localizeSkillListItem(source, 'en')).toMatchObject({
      id: 'scrolling_analysis',
      displayName: 'Scrolling Analysis',
      description: expect.not.stringMatching(/\p{Script=Han}/u),
      localizationStatus: 'catalog',
    });
    expect(localizeSkillListItem(source, 'zh-CN')).toMatchObject({
      id: 'scrolling_analysis',
      displayName: '滑动性能分析',
      localizationStatus: 'catalog',
    });
  });

  it('projects descriptions for every built-in Skill in both locales', async () => {
    await ensureSkillRegistryInitialized();
    for (const skill of skillRegistry.getAllSkills()) {
      const origin = skillRegistry.getSkillOrigin(skill.name);
      const source = {
        id: skill.name,
        displayName: skill.meta.display_name,
        description: skill.meta.description,
        origin,
      };
      const english = localizeSkillListItem(source, 'en');
      const chinese = localizeSkillListItem(source, 'zh-CN');
      const englishDefinition = localizeSkillDefinition(skill, 'en');

      expect(english.description).toBeTruthy();
      expect(english.description).not.toMatch(/\p{Script=Han}/u);
      expect(chinese.description).toBeTruthy();
      expect(englishDefinition.meta.description).toBe(
        english.description,
      );
    }
  });

  it('projects only presentation fields and preserves structured evidence', () => {
    const data = {
      columns: ['actual_fps', 'jank_rate'],
      rows: [[58.2, 3.5]],
    };
    const source = [{
      stepId: 'performance_summary',
      title: '性能概览',
      data,
      columnDefinitions: [
        {name: 'actual_fps', label: '实际 FPS'},
        {name: 'jank_rate', label: '卡顿率'},
      ],
    }];

    const english = localizeSkillDisplayResults(
      'scrolling_analysis',
      source,
      'en',
    );
    expect(english?.[0].title).not.toMatch(/\p{Script=Han}/u);
    expect(english?.[0].data).toEqual(data);
    expect((english?.[0].data as typeof data).rows).toBe(data.rows);
    expect(english?.[0].columnDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'actual_fps',
          label: expect.not.stringMatching(/\p{Script=Han}/u),
        }),
      ]),
    );
  });

  it('labels a column by its authored translation and keeps the translation out of results', () => {
    const [english] = localizeSkillDisplayResults('thermal_predictor', [{
      stepId: 'root',
      columnDefinitions: [{name: 'throttled_core_ratio_pct', label: '频率变化核心占比', label_i18n: {en: 'authoring only'}}],
    }], 'en')!;
    expect(english.columnDefinitions).toEqual([{name: 'throttled_core_ratio_pct', label: 'Frequency-drop core ratio (%)'}]);
  });

  it('uses a locale-aware label policy for inferred schema columns', () => {
    expect(localizedSchemaLabel('cpu_frequency', 'en')).toBe('CPU Frequency');
    expect(localizedSchemaLabel('cpu_frequency', 'zh-CN')).toBe('CPU频率');
    expect(localizedSchemaLabel('ttid_ms', 'en')).toBe('TTID ms');
    expect(localizedSchemaLabel('pss_mb', 'zh-CN')).toBe('PSSMB');
  });

  it('localizes presentation summaries without changing execution evidence', () => {
    const display = [{
      stepId: 'performance_summary',
      executionMessage: '查询完成，但有 3 行被阈值过滤。',
      executionError: 'SQL failed near sched_slice at byte 42',
      data: {
        summary: {
          title: '原始摘要',
          content: '主线程阻塞 18.4 ms，证据来自 slice #42。',
        },
      },
    }];
    const diagnostics = [{
      message: 'Binder contention on thread RenderThread',
      diagnosis: '主线程等待 binder transaction #7',
      suggestions: ['Inspect transaction #7 before changing the threshold.'],
    }];

    const localizedDisplay = localizeSkillDisplayResults(
      'scrolling_analysis',
      display,
      'en',
    );
    expect(localizedDisplay?.[0].executionMessage).toBe(
      display[0].executionMessage,
    );
    expect(localizedDisplay?.[0].executionError).toBe(
      display[0].executionError,
    );
    expect(localizedDisplay?.[0].data).toMatchObject({
      summary: {
        content: expect.not.stringMatching(/\p{Script=Han}/u),
        sourceContent: display[0].data.summary.content,
      },
    });
    const localizedDiagnostics = localizeSkillDiagnostics(
      diagnostics,
      'zh-CN',
    );
    expect(localizedDiagnostics?.[0].message).toMatch(/\p{Script=Han}/u);
    expect(localizedDiagnostics?.[0].diagnosis).toBe(
      diagnostics[0].diagnosis,
    );
    const englishDiagnostics = localizeSkillDiagnostics(diagnostics, 'en');
    expect(englishDiagnostics?.[0].diagnosis).not.toMatch(
      /\p{Script=Han}/u,
    );
    expect(englishDiagnostics?.[0].suggestions?.[0]).toBe(
      diagnostics[0].suggestions[0],
    );
    expect(localizeSkillNarrative(
      'Frame #42 missed its deadline by 8.1 ms.',
      'zh-CN',
    )).toMatch(/\p{Script=Han}/u);
  });

  it('uses a presentation fallback for runtime-generated step identifiers', () => {
    const localized = localizeSkillDisplayResults(
      'scroll_session_analysis',
      [{
        stepId: 'session_0_detect_scroll_sessions',
        title: 'Session 0: detect scroll sessions',
      }],
      'en',
    );
    expect(localized?.[0].title).toBe('Session 0 Detect Scroll Sessions');
  });

  it('fails loudly when a built-in Skill has no catalog entry', () => {
    expect(() =>
      localizeSkillListItem({
        id: 'missing_builtin_skill',
        displayName: 'Missing',
        description: 'Missing',
        origin: {origin: 'built_in'},
      }, 'en')).toThrow(/Missing built-in Skill localization entry/);
  });

  it('marks external Skill Pack text as authored instead of pretending it was translated', () => {
    expect(localizeSkillListItem({
      id: 'scrolling_analysis',
      displayName: '外部 Skill',
      description: '由外部包提供',
      origin: {origin: 'external_pack'},
    }, 'en')).toMatchObject({
      displayName: '外部 Skill',
      localizationStatus: 'external_authored',
    });
  });
});
