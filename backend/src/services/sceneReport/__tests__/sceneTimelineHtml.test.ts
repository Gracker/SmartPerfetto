// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, describe, expect, it, jest} from '@jest/globals';
jest.mock('../../traceProcessorService', () => ({getTraceProcessorService: () => ({getTrace: () => undefined})}));
import {renderSceneTimelineHtml} from '../sceneTimelineHtml';
import {buildAgentDrivenReportData} from '../../agentReportData';
import {HTMLReportGenerator} from '../../htmlReportGenerator';
import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import type {SceneTimelineAssessment} from '../../../agent/scene/sceneTimelineContract';
import type {AnalyzeManagedSession} from '../../../assistant/application/agentAnalyzeSessionService';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../../security/codeAwareOutputRegistry';

const sessionId = 'scene-html-session';
const start = 9007199254740993000n;
function timeline(count = 2): SceneTimelineAssessment {
  return {schemaVersion: 'scene_timeline@1', sessionId, traceId: 'trace-scene', runId: 'run-scene', revision: 3,
    status: 'partial', coverage: {status: 'unknown', captureStatus: 'unknown', reason: 'capture_completeness_unproven', sources: []},
    unresolved: ['presentation remains unknown'], diagnostics: [],
    segments: Array.from({length: count}, (_, index) => ({
      segment: {id: `segment-${index}`, startNs: String(start + BigInt(index)), endNs: String(start + BigInt(index) + 1n),
        object: {kind: 'upid', key: '42'}, userAction: `action-${index}`, deviceState: 'state unknown', appResponse: `response-${index}`,
        evidenceRefs: [{artifactId: `artifact-${index}`, rowIndex: index, column: 'ts', value: 'REFERENCE_CELL_NOT_FOR_HTML'}],
        boundaries: {start: {source: 'inferred'}, end: {source: 'open'}}, dependencies: [], supersedes: []},
      contentFingerprint: `content-${index}`, dependencyFingerprint: `deps-${index}`, issuedRevision: 3,
      semanticStatus: 'unverified', referencesResolved: true,
      checks: [{predicate: 'time.start_cell_equals_boundary', status: 'passed'},
        {predicate: 'story.semantic', status: 'unknown'}], diagnostics: [],
      evidence: [{captureId: `capture-${index}`, originalRowIndex: index, referenceIndex: 0, fingerprint: `fingerprint-${index}`,
        source: {originRunId: 'run-scene'}, row: {audit: 'RAW_SCENE_AUDIT_ROW'}, fields: {}}],
    }))};
}
const reference = (): NonNullable<AnalysisResult['sceneReport']> => ({schemaVersion: 'scene_report_ref@1',
  reportId: 'scene-v3-report', traceId: 'trace-scene', sessionId, runId: 'run-scene', revision: 3,
  expiresAt: Date.now() + 60_000, manifestSha256: 'a'.repeat(64)});
function reportData(value: SceneTimelineAssessment, privateKnowledge = false) {
  const result: AnalysisResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion: 'A bounded scene story.',
    confidence: 0, rounds: 1, totalDurationMs: 50, partial: true, sceneTimeline: value, sceneReport: reference()};
  const session = {sessionId, traceId: 'trace-scene', query: 'reconstruct', outputLanguage: 'en',
    orchestrator: {}, hypotheses: [], agentDialogue: [], conversationSteps: [], dataEnvelopes: [], agentResponses: [],
    queryHistory: [], conclusionHistory: [], ...(privateKnowledge ? {codeAwareMode: 'provider_send', codebaseIds: ['private-app']} : {}),
  } as unknown as AnalyzeManagedSession;
  return buildAgentDrivenReportData({session, result, backendBaseUrl: 'http://127.0.0.1:9010',
    privateContext: {codebase: privateKnowledge, knowledge: false}});
}
afterEach(() => {clearCodeAwareOutputGuards(sessionId);});

describe('canonical scene HTML report projection', () => {
  it('renders every canonical segment with exact ns, separate narration/checks and no raw evidence', () => {
    const data = reportData(timeline(601));
    const html = new HTMLReportGenerator().generateAgentDrivenHTML(data);
    expect((html.match(/class="scene-timeline-segment"/g) ?? [])).toHaveLength(601);
    expect(html).toContain('action-600');
    expect(html).toContain('response-600');
    expect(html).toContain(String(start + 601n));
    expect(html).toContain('User action');
    expect(html).toContain('Device state');
    expect(html).toContain('Application response');
    expect(html).toContain('Story verification status');
    expect(html).toContain('unverified');
    expect(html).toContain('time.start_cell_equals_boundary');
    expect(html).toContain('not the story, attribution or coverage');
    expect(html).toContain('capture_completeness_unproven');
    expect(html).toContain('http://127.0.0.1:9010/api/agent/v1/scene-reconstruct/report/scene-v3-report');
    expect(html).not.toContain('RAW_SCENE_AUDIT_ROW');
    expect(html).not.toContain('REFERENCE_CELL_NOT_FOR_HTML');
    expect(data.result.sceneTimeline?.segments[0]).not.toHaveProperty('evidence');
  });

  it('applies owner text guards before creating the row-free report DTO', () => {
    const value = timeline();
    registerCodeAwareCanary(sessionId, 'PRIVATE_SCENE_CANARY');
    value.segments[0].segment.userAction = 'PRIVATE_SCENE_CANARY';
    const data = reportData(value, true);
    expect(JSON.stringify(data.result.sceneTimeline)).not.toContain('PRIVATE_SCENE_CANARY');
    expect(JSON.stringify(data.result.sceneTimeline)).not.toContain('RAW_SCENE_AUDIT_ROW');
    expect(data.result.sceneTimeline?.segments).toHaveLength(1);
    expect(data.result.sceneTimeline?.diagnostics).toContainEqual({code: 'scene_output_projection_restricted'});
  });

  it('escapes all story text and identifiers while preserving their exact meaning', () => {
    const value = timeline(1);
    value.segments[0].segment.id = '"><img src=x onerror=alert(1)>';
    value.segments[0].segment.userAction = '<script>bad()</script>';
    value.segments[0].segment.object.key = '42&43';
    const html = renderSceneTimelineHtml({timeline: value, reference: reference(), outputLanguage: 'en'});
    expect(html).not.toContain('<script>bad()');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('42&amp;43');
    expect(html).not.toContain('RAW_SCENE_AUDIT_ROW');
  });

  it('localizes only labels, preserves the original story, and refuses expired or mismatched archive links', () => {
    const value = timeline(1);
    const zh = renderSceneTimelineHtml({timeline: value, reference: reference(), outputLanguage: 'zh-CN'});
    expect(zh).toContain('用户操作');
    expect(zh).toContain('action-0');
    expect(zh).toContain('场景详情（JSON）');
    for (const invalid of [{...reference(), revision: 2}, {...reference(), expiresAt: 1}, {...reference(), runId: 'other'}]) {
      const html = renderSceneTimelineHtml({timeline: value, reference: invalid, outputLanguage: 'en'});
      expect(html).toContain('Scene archive details are unavailable');
      expect(html).not.toContain('<a href=');
      expect(html).toContain('action-0');
    }
  });

  it('does not generate a scene section or details link for ordinary analysis', () => {
    expect(renderSceneTimelineHtml({reference: reference(), outputLanguage: 'en'})).toBe('');
  });
});
