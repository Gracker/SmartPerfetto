// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {describe, expect, it} from '@jest/globals';

import type {AnalysisPlanV3, VerificationIssue} from '../../agentv3/types';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import {assessRuntimeDraft, chooseRuntimeDraftRecovery} from '../runtimeDraftDiagnostics';
import {
  INVALID_NATIVE_DECLARATION,
  MISSING_NATIVE_DECLARATION,
  type NativeDeclarationCompletionRequest,
} from '../runtimeConclusionProtocol';

const SRC = path.resolve(__dirname, '../..');

function draftContext(body: string, status: 'completed' | 'incomplete', outputOrigin: 'sdk_final' | 'runtime_fallback' = 'sdk_final'): AnalysisDeliveryContext {
  const candidate = {runId: 'run-1', attemptId: '1', candidateRef: 'run-1:1', conclusionFingerprint: analysisDeliveryFingerprint(body)};
  return {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin,
    completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk', ...candidate, status}};
}

function pendingPlan(): AnalysisPlanV3 {
  return {phases: [{id: 'p1', name: 'Explore', goal: 'Optional exploration', expectedTools: ['execute_sql'], status: 'pending'}],
    successCriteria: 'Explore', submittedAt: 1, toolCallLog: []} as AnalysisPlanV3;
}

function request(reason: NativeDeclarationCompletionRequest['reason']): NativeDeclarationCompletionRequest {
  return {reason, originalBody: 'Body.', diagnostic: {} as NativeDeclarationCompletionRequest['diagnostic']};
}

const correctable: VerificationIssue = {type: 'truncation', severity: 'error', message: 'cut off', recoveryKind: 'continue_output'};

describe('assessRuntimeDraft', () => {
  it('separates submitted obligations from delivery errors and keeps only repairable ones recoverable', async () => {
    const body = 'Frame 12 missed its deadline.';
    const draft = await assessRuntimeDraft({conclusion: body, plan: pendingPlan(),
      hypotheses: [{id: 'h1', statement: 'Another cause', status: 'formed', formedAt: 1} as never],
      deliveryContext: draftContext(body, 'incomplete'), outputLanguage: 'en'});
    // The pending plan and the unresolved hypothesis are obligations, not delivery errors.
    expect(draft.deliveryErrors.map(issue => issue.type)).toEqual(['truncation']);
    expect(draft.recoverableIssues).toEqual([expect.objectContaining({type: 'truncation', recoveryKind: 'continue_output'})]);
  });

  it('reports a runtime fallback as a delivery error no correction can repair', async () => {
    const body = 'Replaced text.';
    const draft = await assessRuntimeDraft({conclusion: body, deliveryContext: draftContext(body, 'completed', 'runtime_fallback'),
      outputLanguage: 'zh-CN'});
    expect(draft.deliveryErrors.length).toBeGreaterThan(0);
    expect(draft.recoverableIssues).toEqual([]);
  });
});

describe('assessRuntimeDraft on a reply without an answer body', () => {
  it('asks for the body when the completed reply carries only a declaration', async () => {
    // Claude assesses the reply with its sidecar still attached; a non-empty string is not a body.
    const declarationOnly = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], claims: [],
      uncertainties: [], nextSteps: []});
    const draft = await assessRuntimeDraft({conclusion: declarationOnly,
      deliveryContext: draftContext(declarationOnly, 'completed'), outputLanguage: 'en'});
    expect(draft.recoverableIssues).toEqual([
      expect.objectContaining({type: 'missing_reasoning', recoveryKind: 'continue_output'})]);
  });
});

describe('chooseRuntimeDraftRecovery', () => {
  it('prefers an admitted declaration repair', () => {
    const admitted = request(MISSING_NATIVE_DECLARATION);
    expect(chooseRuntimeDraftRecovery({declarationNeed: admitted, declarationRequest: admitted, recoverableIssues: [correctable]}))
      .toEqual({kind: 'declaration', request: admitted});
  });

  it('falls back to the issue correction only when the declaration was valid or rejected', () => {
    expect(chooseRuntimeDraftRecovery({recoverableIssues: [correctable]})).toEqual({kind: 'correction', issues: [correctable]});
    expect(chooseRuntimeDraftRecovery({declarationNeed: request(INVALID_NATIVE_DECLARATION), recoverableIssues: [correctable]}))
      .toEqual({kind: 'correction', issues: [correctable]});
    // A missing declaration that cannot be repaired is not something a correction supplies.
    expect(chooseRuntimeDraftRecovery({declarationNeed: request(MISSING_NATIVE_DECLARATION), recoverableIssues: [correctable]}))
      .toBeUndefined();
    expect(chooseRuntimeDraftRecovery({recoverableIssues: []})).toBeUndefined();
  });
});

describe('finalizer-owned terminal state', () => {
  const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
  const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

  it('no runtime engine applies the quality gate or writes its termination reason', () => {
    const engines = sourceFiles(path.join(SRC, 'agentRuntime/engines'));
    expect(engines.length).toBeGreaterThan(5);
    const offenders = engines.filter(file => {
      const text = fs.readFileSync(file, 'utf8');
      return /\b(?:applyFinalResultQualityGate|assessFinalResultQuality(?:Assessment)?)\b/.test(text) ||
        text.includes("'quality_gate_failed'");
    }).map(relative);
    expect(offenders).toEqual([]);
  });

  it('only the product finalizer applies the quality gate', () => {
    const callers = sourceFiles(SRC).filter(file => !file.endsWith('services/finalResultQualityGate.ts') &&
      /\bapplyFinalResultQualityGate\s*\(/.test(fs.readFileSync(file, 'utf8'))).map(relative);
    expect(callers).toEqual(['services/finalizeAnalysisResult.ts']);
  });
});
