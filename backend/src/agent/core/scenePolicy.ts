import type { ConclusionScenePromptHints, SceneTemplateRecord } from './sceneTypes';

const DEEP_REASON_LABEL_PLACEHOLDER = /\{\{\s*deep_reason_label\s*\}\}/g;

const DEFAULT_FOCUS_LINE = '- 先用人话说明“现象 -> 直接证据 -> 影响”，再给根因与优化方向。';
const DEFAULT_OUTPUT_REQUIREMENT_LINE = '- 结论必须绑定明确证据，避免抽象术语堆砌。';
const DEFAULT_NEXT_STEP_LINE = '- “下一步”给出 1-2 个最高信息增益动作，并与当前证据直接对应。';

function ensureBulletLine(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.startsWith('-') ? text : `- ${text}`;
}

function renderLineTemplate(value: string, deepReasonLabel: string): string {
  return value.replace(DEEP_REASON_LABEL_PLACEHOLDER, deepReasonLabel);
}

function renderLineList(lines: string[], deepReasonLabel: string, fallbackLine: string): string[] {
  const out = lines
    .map(line => ensureBulletLine(renderLineTemplate(line, deepReasonLabel)))
    .filter((line): line is string => Boolean(line));

  if (out.length === 0) return [fallbackLine];
  return out;
}

export function buildScenePromptHintsFromTemplate(
  template: SceneTemplateRecord,
  deepReasonLabel: string
): ConclusionScenePromptHints {
  const resolvedReasonLabel = String(deepReasonLabel || '').trim() || '为什么慢';

  const focusLines = renderLineList(
    Array.isArray(template.focusLines) ? template.focusLines : [],
    resolvedReasonLabel,
    DEFAULT_FOCUS_LINE
  );
  const outputRequirementLines = renderLineList(
    Array.isArray(template.outputRequirementTemplates) ? template.outputRequirementTemplates : [],
    resolvedReasonLabel,
    DEFAULT_OUTPUT_REQUIREMENT_LINE
  );
  const nextStepLine = ensureBulletLine(
    renderLineTemplate(String(template.nextStepLine || ''), resolvedReasonLabel)
  ) || DEFAULT_NEXT_STEP_LINE;

  return {
    sceneId: String(template.id || 'generic'),
    sceneName: String(template.sceneName || template.id || '通用性能'),
    focusLines,
    outputRequirementLines,
    nextStepLine,
    requireTopClusters: Boolean(template.requireTopClusters),
  };
}

