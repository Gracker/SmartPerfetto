// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes, getStrategyContent,
  getStrategyDetailByRef, loadPromptTemplate} from '../strategyLoader';
import {compactRuntimeToolDescription, RUNTIME_TOOL_DESCRIPTION_MAX_CHARS} from '../../agentRuntime/runtimeToolSpec';
import {renderRequiredLocalizedStrategyTemplate} from '../localizedStrategyTemplate';
import {resolveAnalysisInvestigationRequirements} from '../../agentRuntime/analysisInvestigationRequirements';
import {parseAnalysisTurnIntentDecision, type AnalysisTurnIntent} from '../../agentRuntime/analysisTurnIntent';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: getRegisteredScenes(),
  overlayGeneration: 'scene-reconstruction-contract'});
const strategy = registry.getStrategy('scene_reconstruction');
const intent: AnalysisTurnIntent = {schemaVersion: 1, status: 'resolved', source: 'semantic',
  taskKind: 'investigation', sceneId: 'scene_reconstruction', scope: 'scene_wide',
  recommendedComplexity: 'full', deliverable: 'report', evidenceAccess: 'read_new',
  registryFingerprint: registry.registryFingerprint};

function producerMetrics(relativePath: string): Set<string> {
  const skill = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../../skills', relativePath), 'utf8')) as {
    steps: Array<{investigation_evidence?: {metrics?: Array<{metric_id: string}>}}>
  };
  return new Set(skill.steps.flatMap(step => step.investigation_evidence?.metrics?.map(metric => metric.metric_id) ?? []));
}

describe('scene reconstruction strategy contracts', () => {
  it('registers a dedicated scene with active investigation and final delivery obligations', () => {
    expect(strategy).toBeDefined();
    expect(strategy?.strategyKind).toBe('normal');
    const resolved = resolveAnalysisInvestigationRequirements({intent, strategyRegistry: registry});
    expect(resolved.status).toBe('resolved');
    expect(resolved.requirements.map(requirement => requirement.id)).toEqual(expect.arrayContaining([
      'scene_input_observations', 'scene_device_observations', 'scene_application_response',
      'scene_scan_coverage', 'scene_finding_coverage', 'scene_candidate_revision',
    ]));
    expect(resolved.requirements.every(requirement => requirement.required)).toBe(true);
    expect(strategy?.investigationContract?.profileRefs).toEqual([{id: 'scene_reconstruction', version: 1}]);
    expect(strategy?.finalReportContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'scene_timeline', 'scene_evidence_coverage', 'scene_uncertainty_and_revisions',
    ]));
  });

  it('binds acquisition metrics to declarations in the real input and device Skills', () => {
    const emitted = new Set([
      ...producerMetrics('composite/scene_reconstruction.skill.yaml'),
      ...producerMetrics('atomic/scene_device_state_changes.skill.yaml'),
    ]);
    const metrics = strategy!.investigationContract!.requirements.flatMap(requirement => requirement.evidenceMetrics ?? []);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) expect(emitted.has(metric)).toBe(true);
    const response = strategy!.investigationContract!.requirements.find(requirement => requirement.id === 'scene_application_response');
    expect(response?.evidenceMetrics).toBeUndefined();
  });

  it('keeps missing capture capabilities inside the investigation rather than refusing all reconstruction', () => {
    expect(strategy?.requiredCapabilities).toEqual([]);
    expect(strategy?.optionalCapabilities).toEqual(expect.arrayContaining(['device_state', 'input_latency', 'frame_rendering']));
    const declared = {schemaVersion: 1, taskKind: 'investigation', sceneId: 'scene_reconstruction', scope: 'scene_wide',
      recommendedComplexity: 'full', deliverable: 'report', evidenceAccess: 'read_new'};
    expect(parseAnalysisTurnIntentDecision(JSON.stringify(declared), registry)).toEqual(declared);
    expect(resolveAnalysisInvestigationRequirements({intent: {...intent, registryFingerprint: 'stale'}, strategyRegistry: registry}))
      .toMatchObject({status: 'not_checked', reason: 'registry_fingerprint_mismatch'});
  });

  it('separates dedicated operation reconstruction from performance overview routing', () => {
    const overview = registry.getStrategy('overview')!;
    for (const keyword of ['场景还原', 'scene reconstruction', 'scene replay']) {
      expect(strategy?.keywords).toContain(keyword);
      expect(overview.keywords).not.toContain(keyword);
    }
    expect(overview.investigationContract?.profileRefs.map(profile => profile.id)).not.toContain('scene_reconstruction');
    expect(overview.investigationContract?.requirements.map(requirement => requirement.id)).toContain('overview_critical_path');
  });

  it('keeps detailed source, pagination and revision limits available through the pinned detail loader', () => {
    const core = getStrategyContent('scene_reconstruction', registry);
    const detail = getStrategyDetailByRef('scene_reconstruction:full', undefined, registry);
    expect(core).toContain('Core Strategy');
    expect(core).not.toContain('<!-- strategy-detail');
    expect(detail?.content).toContain('normalized before window clipping');
    expect(detail?.content).toContain('`start_ts` and `end_ts`');
    expect(detail?.content).toContain('cannot recover rows discarded by a producer SQL limit');
    expect(detail?.content).toContain('completed ACK chain');
    expect(detail?.content).toContain('unfinished touch sequences');
    expect(detail?.content).toContain('current-run evidence');
    const empty = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'no-scene'});
    expect(getStrategyDetailByRef('scene_reconstruction:full', undefined, empty)).toBeUndefined();
  });

  it.each(['zh-CN', 'en'] as const)('loads the server-owned %s request using the shared localized renderer', language => {
    const query = renderRequiredLocalizedStrategyTemplate('prompt-scene-reconstruction-query', language, {});
    expect(query).not.toMatch(/\{\{\w+\}\}/);
    expect(query).toContain(language === 'en' ? 'device state' : '设备状态');
    expect(query).toContain(language === 'en' ? 'application response' : '应用响应');
    expect(query).toContain(language === 'en' ? 'unknown' : '未知');
    expect(query).not.toContain('verified: true');
  });

  it('loads candidate-tool instructions as a standalone required template, with no proof grant', () => {
    const guidance = loadPromptTemplate('scene-tool-guidance');
    expect(guidance).toBeDefined();
    expect(guidance!.length).toBeLessThanOrEqual(RUNTIME_TOOL_DESCRIPTION_MAX_CHARS);
    expect(compactRuntimeToolDescription(guidance!)).toBe(guidance);
    expect(guidance).toContain('baseRevision');
    expect(guidance).toContain('removeSegmentIds');
    expect(guidance).toContain('artifact-wide rowIndex');
    expect(guidance).toContain('acquires no trace evidence');
    expect(guidance).toContain('proposal acceptance does not prove');
    expect(guidance).not.toMatch(/\{\{\w+\}\}/);
  });
});
