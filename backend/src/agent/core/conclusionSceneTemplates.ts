import { buildScenePromptHintsFromTemplate } from './scenePolicy';
import { routeSceneTemplate } from './sceneRouter';
import {
  getSceneTemplateStoreDiagnostics,
  getSceneTemplates,
  resetSceneTemplateStoreCacheForTests,
  SceneTemplateStoreDiagnostics,
} from './sceneTemplateStore';
import type {
  BuildScenePromptHintsInput,
  ConclusionSceneId,
  ConclusionScenePromptHints,
  SceneRouteCandidate,
  SceneRoutingResult,
  SceneTemplateRecord,
} from './sceneTypes';

export type {
  ConclusionSceneId,
  ConclusionScenePromptHints,
  SceneRouteCandidate,
  SceneRoutingResult,
  SceneTemplateRecord,
};

export function resolveConclusionScene(params: BuildScenePromptHintsInput): SceneRoutingResult {
  const templates = getSceneTemplates();
  return routeSceneTemplate({
    intent: params.intent,
    findings: params.findings,
    templates,
  });
}

export function buildConclusionScenePromptHints(
  params: BuildScenePromptHintsInput
): ConclusionScenePromptHints {
  const routing = resolveConclusionScene(params);
  return buildScenePromptHintsFromTemplate(routing.selectedTemplate, params.deepReasonLabel);
}

export function resetConclusionSceneTemplateCacheForTests(): void {
  resetSceneTemplateStoreCacheForTests();
}

export function getConclusionSceneTemplateDiagnostics(): SceneTemplateStoreDiagnostics {
  return getSceneTemplateStoreDiagnostics();
}
