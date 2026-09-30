// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {projectCodeAwareStructuredText, withOwnerCodeAwareProjection} from '../../services/security/codeAwareOutputRegistry';
import type {SceneTimelineAssessment} from './sceneTimelineContract';
import type {SceneTimelineView} from '../../types/sceneTimeline';
import {assertSceneRunActive, sceneRunState, type SceneRunContext} from './sceneRunContext';
import {assessSceneScanCoverage} from './sceneScanCoverage';
export type {SceneTimelineView} from '../../types/sceneTimeline';

/** A display of the currently committed proposal, never a finalized assessment. */
export function projectSceneRunCandidate(handle: SceneRunContext): SceneTimelineView {
  const state = sceneRunState(handle);
  assertSceneRunActive(state);
  const {runId, sessionId, traceId} = state.options;
  return projectSceneTimelineForClient(projectSceneTimelineForOwner({schemaVersion: 'scene_timeline@1',
    runId, sessionId, traceId, revision: state.revision, status: 'partial',
    segments: [...state.segments.values()], unresolved: [...state.unresolved],
    diagnostics: [...state.diagnostics, ...state.scanDiagnostics],
    coverage: assessSceneScanCoverage({revision: state.revision, requestedWindow: state.options.traceBounds,
      receipts: [...state.scanReceipts.values()], diagnostics: state.scanDiagnostics,
      maxUnionWindows: state.limits.maxScanUnionWindows, ...(state.coveragePlan ? {plan: state.coveragePlan} : {})}),
  }));
}

/** Browser/chat projection retains locators and checks; raw audit rows stay in the report archive. */
export function projectSceneTimelineForClient(value: SceneTimelineAssessment | SceneTimelineView): SceneTimelineView {
  return {schemaVersion: value.schemaVersion, runId: value.runId, sessionId: value.sessionId,
    traceId: value.traceId, revision: value.revision, status: value.status, coverage: value.coverage,
    unresolved: value.unresolved, diagnostics: value.diagnostics, segments: value.segments.map(segment => {
    if (!('evidence' in segment)) return segment;
    const {evidence: _auditRows, ...view} = segment;
    return view;
  })};
}

/** Project each bounded segment independently so long histories do not bypass or
 * exhaust the ordinary output guard. Changed evidence is never shown with its
 * original finite checks: omit that segment and record the delivery limitation.
 */
export function projectSceneTimelineForOwner<T extends SceneTimelineAssessment | SceneTimelineView>(value: T): T {
  return withOwnerCodeAwareProjection(() => {
    let restricted = false;
    const segments: Array<T['segments'][number]> = [];
    for (const segment of value.segments) {
      const projection = projectCodeAwareStructuredText(value.sessionId, segment);
      if (projection.changed || !projection.value) restricted = true;
      else segments.push(projection.value);
    }
    // A redacted prerequisite also removes its dependent story. Keep no receipt
    // whose displayed dependency closure differs from the audited revision.
    const surviving = new Set(segments.map(item => item.segment.id));
    const dependants = new Map<string, string[]>();
    for (const item of value.segments) {
      for (const dependency of item.segment.dependencies) {
        const ids = dependants.get(dependency) ?? [];
        ids.push(item.segment.id); dependants.set(dependency, ids);
      }
    }
    const missing = value.segments.filter(item => !surviving.has(item.segment.id)).map(item => item.segment.id);
    for (let index = 0; index < missing.length; index++) {
      for (const id of dependants.get(missing[index]) ?? []) {
        if (surviving.delete(id)) {missing.push(id); restricted = true;}
      }
    }
    const unresolved: string[] = [];
    for (const item of value.unresolved) {
      const projection = projectCodeAwareStructuredText(value.sessionId, item);
      if (projection.changed || typeof projection.value !== 'string') restricted = true;
      else unresolved.push(projection.value);
    }
    const diagnostics = value.diagnostics.flatMap(item => {
      const projection = projectCodeAwareStructuredText(value.sessionId, item);
      if (projection.changed || !projection.value) {restricted = true; return [];}
      return [projection.value];
    });
    return {...value, segments: segments.filter(item => surviving.has(item.segment.id)), unresolved, diagnostics: restricted
      ? [...diagnostics, {code: 'scene_output_projection_restricted'}] : diagnostics};
  });
}
