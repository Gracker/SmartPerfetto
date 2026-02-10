import type { Finding, Intent } from '../types';
import {
  buildAspectSignalSet,
  normalizeText,
  signalMatchesHint,
} from './sceneTaxonomy';
import type {
  SceneRouteCandidate,
  SceneRoutingResult,
  SceneTemplateRecord,
} from './sceneTypes';

const MAX_GOAL_KEYWORD_SCORE = 12;
const MAX_FINDING_KEYWORD_SCORE = 6;
const ASPECT_EXACT_MATCH_SCORE = 12;
const ASPECT_HINT_MATCH_SCORE = 6;
const MAX_ASPECT_SCORE = 24;

function countKeywordHits(text: string, keywords: string[]): number {
  const source = normalizeText(text);
  if (!source) return 0;

  const hitSet = new Set<string>();
  for (const keyword of keywords || []) {
    const normalized = normalizeText(keyword);
    if (!normalized) continue;
    if (source.includes(normalized)) hitSet.add(normalized);
  }
  return hitSet.size;
}

function calculateAspectScore(template: SceneTemplateRecord, aspectSignals: Set<string>): number {
  let score = 0;
  const normalizedTemplateId = normalizeText(template.id);

  if (aspectSignals.has(normalizedTemplateId)) {
    score += ASPECT_EXACT_MATCH_SCORE;
  }

  for (const signal of aspectSignals) {
    if (signal === normalizedTemplateId) continue;
    const matched = template.aspectHints.some(hint => signalMatchesHint(signal, hint));
    if (matched) score += ASPECT_HINT_MATCH_SCORE;
  }

  return Math.min(score, MAX_ASPECT_SCORE);
}

function calculateGoalScore(template: SceneTemplateRecord, intent: Intent): number {
  const hits = countKeywordHits(intent.primaryGoal || '', template.keywords);
  return Math.min(hits * 4, MAX_GOAL_KEYWORD_SCORE);
}

function calculateFindingScore(template: SceneTemplateRecord, findings: Finding[]): number {
  const merged = findings
    .slice(0, 5)
    .map(item => `${item.title || ''} ${item.description || ''}`)
    .join(' ');
  const hits = countKeywordHits(merged, template.keywords);
  return Math.min(hits * 2, MAX_FINDING_KEYWORD_SCORE);
}

function findGenericTemplate(templates: SceneTemplateRecord[]): SceneTemplateRecord {
  return templates.find(template => normalizeText(template.id) === 'generic')
    || templates[0];
}

export function routeSceneTemplate(params: {
  intent: Intent;
  findings: Finding[];
  templates: SceneTemplateRecord[];
}): SceneRoutingResult {
  const { intent, findings, templates } = params;
  const safeTemplates = Array.isArray(templates) && templates.length > 0
    ? templates
    : [];

  if (safeTemplates.length === 0) {
    const fallback: SceneTemplateRecord = {
      id: 'generic',
      sceneName: '通用性能',
      aspectHints: [],
      keywords: [],
      focusLines: ['- 先用人话说明“现象 -> 直接证据 -> 影响”，再给根因与优化方向。'],
      outputRequirementTemplates: ['- 结论必须绑定明确证据，避免抽象术语堆砌。'],
      nextStepLine: '- “下一步”给出 1-2 个最高信息增益动作，并与当前证据直接对应。',
      requireTopClusters: false,
    };
    return {
      selectedTemplate: fallback,
      selectedScore: 0,
      candidates: [],
    };
  }

  const aspectSignals = buildAspectSignalSet(intent.aspects || []);
  const nonGenericTemplates = safeTemplates.filter(template => normalizeText(template.id) !== 'generic');

  const candidates: SceneRouteCandidate[] = nonGenericTemplates.map((template) => {
    const aspectScore = calculateAspectScore(template, aspectSignals);
    const goalScore = calculateGoalScore(template, intent);
    const findingScore = calculateFindingScore(template, findings);

    return {
      sceneId: template.id,
      aspectScore,
      goalScore,
      findingScore,
      totalScore: aspectScore + goalScore + findingScore,
    };
  }).sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.aspectScore !== a.aspectScore) return b.aspectScore - a.aspectScore;
    if (b.goalScore !== a.goalScore) return b.goalScore - a.goalScore;
    return b.findingScore - a.findingScore;
  });

  const best = candidates[0];
  const genericTemplate = findGenericTemplate(safeTemplates);

  if (!best || best.totalScore <= 0) {
    return {
      selectedTemplate: genericTemplate,
      selectedScore: 0,
      candidates,
    };
  }

  const selectedTemplate = safeTemplates.find(template => template.id === best.sceneId) || genericTemplate;

  return {
    selectedTemplate,
    selectedScore: best.totalScore,
    candidates,
  };
}

