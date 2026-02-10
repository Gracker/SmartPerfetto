import type { Finding, Intent } from '../../types';
import { routeSceneTemplate } from '../sceneRouter';
import type { SceneTemplateRecord } from '../sceneTypes';

function createIntent(partial: Partial<Intent>): Intent {
  return {
    primaryGoal: '分析性能问题',
    aspects: [],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
    ...partial,
  };
}

function createFinding(partial: Partial<Finding>): Finding {
  return {
    id: 'f-1',
    severity: 'warning',
    title: '发现性能风险',
    description: '',
    source: 'test',
    confidence: 0.7,
    ...partial,
  };
}

const templates: SceneTemplateRecord[] = [
  {
    id: 'generic',
    sceneName: '通用性能',
    aspectHints: [],
    keywords: [],
    focusLines: ['- 通用焦点'],
    outputRequirementTemplates: ['- 通用约束'],
    nextStepLine: '- 通用下一步',
    requireTopClusters: false,
  },
  {
    id: 'anr',
    sceneName: 'ANR/卡死',
    aspectHints: ['anr', 'freeze', 'hang'],
    keywords: ['anr', '无响应', '卡死'],
    focusLines: ['- ANR 焦点'],
    outputRequirementTemplates: ['- ANR 约束'],
    nextStepLine: '- ANR 下一步',
    requireTopClusters: false,
  },
  {
    id: 'system',
    sceneName: '系统级约束',
    aspectHints: ['system', 'thermal', 'power'],
    keywords: ['system', 'thermal', '温度'],
    focusLines: ['- SYSTEM 焦点'],
    outputRequirementTemplates: ['- SYSTEM 约束'],
    nextStepLine: '- SYSTEM 下一步',
    requireTopClusters: false,
  },
];

describe('sceneRouter', () => {
  test('prefers exact aspect scene match', () => {
    const result = routeSceneTemplate({
      intent: createIntent({ aspects: ['anr'], primaryGoal: '分析为什么无响应' }),
      findings: [],
      templates,
    });

    expect(result.selectedTemplate.id).toBe('anr');
    expect(result.selectedScore).toBeGreaterThan(0);
  });

  test('uses goal keywords to select scene when aspects are empty', () => {
    const result = routeSceneTemplate({
      intent: createIntent({ aspects: [], primaryGoal: '系统温度升高导致卡顿吗？' }),
      findings: [],
      templates,
    });

    expect(result.selectedTemplate.id).toBe('system');
  });

  test('falls back to generic when no scene signals are present', () => {
    const result = routeSceneTemplate({
      intent: createIntent({ primaryGoal: '看下整体情况', aspects: ['overview'] }),
      findings: [createFinding({ title: '指标波动', description: '暂无明显特征' })],
      templates,
    });

    expect(result.selectedTemplate.id).toBe('generic');
    expect(result.selectedScore).toBe(0);
  });
});

