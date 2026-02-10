import { buildScenePromptHintsFromTemplate } from '../scenePolicy';
import type { SceneTemplateRecord } from '../sceneTypes';

describe('scenePolicy', () => {
  test('replaces deep reason placeholder in output requirement lines', () => {
    const template: SceneTemplateRecord = {
      id: 'jank',
      sceneName: '卡顿/掉帧',
      aspectHints: [],
      keywords: [],
      focusLines: ['- 焦点'],
      outputRequirementTemplates: ['- 必须解释 {{deep_reason_label}} 并给出证据。'],
      nextStepLine: '- 下一步',
      requireTopClusters: true,
    };

    const hints = buildScenePromptHintsFromTemplate(template, '为什么慢');
    expect(hints.outputRequirementLines.join('\n')).toContain('为什么慢');
    expect(hints.requireTopClusters).toBe(true);
  });

  test('uses fallback lines when template is incomplete', () => {
    const template: SceneTemplateRecord = {
      id: 'custom',
      sceneName: '',
      aspectHints: [],
      keywords: [],
      focusLines: [],
      outputRequirementTemplates: [],
      nextStepLine: '',
      requireTopClusters: false,
    };

    const hints = buildScenePromptHintsFromTemplate(template, '');
    expect(hints.sceneName).toBe('custom');
    expect(hints.focusLines.length).toBeGreaterThan(0);
    expect(hints.outputRequirementLines.length).toBeGreaterThan(0);
    expect(hints.nextStepLine).toContain('下一步');
  });
});

