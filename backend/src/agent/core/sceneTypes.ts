import { Finding, Intent } from '../types';

export type ConclusionSceneId = string;

export interface ConclusionScenePromptHints {
  sceneId: ConclusionSceneId;
  sceneName: string;
  focusLines: string[];
  outputRequirementLines: string[];
  nextStepLine: string;
  requireTopClusters: boolean;
}

export interface SceneTemplateRecord {
  id: ConclusionSceneId;
  sceneName: string;
  aspectHints: string[];
  keywords: string[];
  focusLines: string[];
  outputRequirementTemplates: string[];
  nextStepLine: string;
  requireTopClusters: boolean;
}

export interface SceneRouteCandidate {
  sceneId: ConclusionSceneId;
  aspectScore: number;
  goalScore: number;
  findingScore: number;
  totalScore: number;
}

export interface SceneRoutingResult {
  selectedTemplate: SceneTemplateRecord;
  selectedScore: number;
  candidates: SceneRouteCandidate[];
}

export interface BuildScenePromptHintsInput {
  intent: Intent;
  findings: Finding[];
  deepReasonLabel: string;
}

