// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity} from '../../types/analysisDelivery';
import type {SafeSourceProvenanceProjection} from '../../services/codebase/sourceClaimVerifier';
import {sourceUseDecisionForClient} from '../../services/codebase/sourceUseDecision';
import {
  parseClosedAnalysisEvidencePresentation,
  projectAnalysisEvidenceForDisplay,
  type AnalysisEvidencePresentation,
} from '../../services/evidence/analysisEvidencePresentation';
import type {SessionPaths} from '../io/paths';

export const CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION = 'cli_analysis_evidence@1' as const;

export interface CliAnalysisEvidenceBundle {
  schemaVersion: typeof CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION;
  binding: {
    sessionId: string;
    turn: number;
    conclusionFingerprint: string;
    turnMarkdownFingerprint: string;
    candidate: AnalysisCandidateIdentity | null;
  };
  evidenceFingerprint: string;
  evidence: AnalysisEvidencePresentation;
}

export interface CliAnalysisEvidenceUnavailableBundle {
  schemaVersion: typeof CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION;
  binding: CliAnalysisEvidenceBundle['binding'];
  evidenceFingerprint: null;
  evidence: null;
  unavailableReason: 'analysis_evidence_projection_invalid';
}

export type CliAnalysisEvidenceOutput = CliAnalysisEvidenceBundle | CliAnalysisEvidenceUnavailableBundle;

export type LoadedCliAnalysisEvidence =
  | {status: 'available'; bundle: CliAnalysisEvidenceBundle; legacy: boolean}
  | {status: 'none'}
  | {status: 'unavailable'; reason: string};

export function buildCliAnalysisEvidenceBundle(input: {
  sessionId: string;
  turn: number;
  conclusion: string;
  turnMarkdown: string;
  result: AnalysisResult;
  sourceProvenance?: SafeSourceProvenanceProjection;
}): CliAnalysisEvidenceOutput {
  const evidence = projectAnalysisEvidenceForDisplay({
    result: input.result,
    sourceProvenance: input.sourceProvenance,
  });
  const binding = {
    sessionId: input.sessionId,
    turn: input.turn,
    conclusionFingerprint: analysisDeliveryFingerprint(input.conclusion),
    turnMarkdownFingerprint: analysisDeliveryFingerprint(input.turnMarkdown),
    candidate: copyBoundCandidate(input.result.completion, input.conclusion),
  };
  if (!evidence) return {
    schemaVersion: CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION,
    binding,
    evidenceFingerprint: null,
    evidence: null,
    unavailableReason: 'analysis_evidence_projection_invalid',
  };
  return {
    schemaVersion: CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION,
    binding,
    evidenceFingerprint: analysisDeliveryFingerprint(evidence),
    evidence,
  };
}

export function latestCliAnalysisEvidencePath(sp: SessionPaths): string {
  return path.join(sp.dir, 'analysis-evidence.json');
}

export function turnCliAnalysisEvidencePath(sp: SessionPaths, turn: number): string {
  return `${turnPrefix(sp, turn)}.analysis-evidence.json`;
}

export function loadCliAnalysisEvidence(input: {
  sp: SessionPaths;
  sessionId: string;
  turn: number;
  conclusion?: string;
  turnMarkdown: string;
  latest?: boolean;
}): LoadedCliAnalysisEvidence {
  const bundlePath = input.latest
    ? latestCliAnalysisEvidencePath(input.sp)
    : turnCliAnalysisEvidencePath(input.sp, input.turn);
  if (fs.existsSync(bundlePath)) {
    const parsed = readJson(bundlePath);
    if (isMatchingUnavailableBundle(parsed, input)) {
      return {status: 'unavailable', reason: parsed.unavailableReason};
    }
    const bundle = parseMatchingBundle(parsed, input);
    return bundle
      ? {status: 'available', bundle, legacy: false}
      : {status: 'unavailable', reason: 'analysis_evidence_bundle_invalid_or_mismatched'};
  }
  return loadLegacyCliAnalysisEvidence(input);
}

export function loadedCliAnalysisEvidence(output: CliAnalysisEvidenceOutput): LoadedCliAnalysisEvidence {
  return output.evidence === null
    ? {status: 'unavailable', reason: output.unavailableReason}
    : {status: 'available', bundle: output, legacy: false};
}

export function renderCliAnalysisEvidence(
  loaded: LoadedCliAnalysisEvidence,
  language: OutputLanguage,
): string {
  if (loaded.status === 'none') return '';
  if (loaded.status === 'unavailable') {
    return localize(
      language,
      '## 证据详情\n\n> 证据详情不可用：持久化证据与当前结论不匹配或已损坏。',
      '## Evidence details\n\n> Evidence details are unavailable because the persisted evidence is invalid or does not match this conclusion.',
    );
  }
  const evidence = loaded.bundle.evidence;
  const lines = [
    localize(language, '## 证据详情', '## Evidence details'), '',
    `- schema: \`${loaded.bundle.schemaVersion}\``,
    `- binding: \`${evidence.conclusionBindingEligibility ?? 'not_checked'}\``,
    `- verification: \`${evidence.claimVerificationResult?.status ?? 'not_checked'}\``,
    `- delivery: \`${evidence.deliveryAssurance?.claims ?? 'not_checked'}\``,
    `- source: \`${evidence.sourceUseDecision?.status ?? 'not_used'}\``,
  ];
  appendJsonSection(lines, localize(language, '声明的结论与引用', 'Declared claims and references'), evidence.claims);
  appendJsonSection(lines, localize(language, '证据支持', 'Claim support'), evidence.claimSupport);
  appendJsonSection(lines, localize(language, '声明核验', 'Claim verification'), evidence.claimVerificationResult);
  appendJsonSection(lines, localize(language, '身份解析', 'Identity resolutions'), evidence.identityResolutions);
  appendJsonSection(lines, localize(language, '调查覆盖', 'Investigation assessment'), evidence.investigationAssessment);
  appendJsonSection(lines, localize(language, '交付状态', 'Delivery assurance'), evidence.deliveryAssurance);
  // Rendered output only: the persisted evidence and its fingerprint stay without the derived counts.
  appendJsonSection(lines, localize(language, '源码使用决策', 'Source use decision'),
    sourceUseDecisionForClient(evidence.sourceUseDecision));
  appendJsonSection(lines, localize(language, '源码引用', 'Source references'), evidence.sourceReferences);
  appendJsonSection(lines, localize(language, '声明与源码绑定', 'Claim-to-source bindings'), evidence.sourceClaimBindings);
  // Present only for results the current verifier judged.
  if (evidence.sourceClaimStatuses) {
    appendJsonSection(lines, localize(language, '依赖源码的结论', 'Source-dependent conclusions'), evidence.sourceClaimStatuses);
  }
  if (evidence.sourceCitations) {
    appendJsonSection(lines, localize(language, '答案中的源码引用', 'Source locations cited in the answer'), evidence.sourceCitations);
  }
  // Background the answer used, never evidence; present only on recorded results.
  if (evidence.knowledgeUse) {
    appendJsonSection(lines, localize(language, '引用的内部资料', 'Internal knowledge used'), evidence.knowledgeUse);
  }
  return lines.join('\n');
}

function parseMatchingBundle(
  value: unknown,
  input: {sessionId: string; turn: number; conclusion?: string; turnMarkdown: string},
): CliAnalysisEvidenceBundle | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['schemaVersion', 'binding', 'evidenceFingerprint', 'evidence']) ||
      value.schemaVersion !== CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION || !isPlainRecord(value.binding) ||
      !hasExactKeys(value.binding, ['sessionId', 'turn', 'conclusionFingerprint', 'turnMarkdownFingerprint', 'candidate']) ||
      value.binding.sessionId !== input.sessionId || value.binding.turn !== input.turn ||
      value.binding.turnMarkdownFingerprint !== analysisDeliveryFingerprint(input.turnMarkdown) ||
      (input.conclusion !== undefined && value.binding.conclusionFingerprint !== analysisDeliveryFingerprint(input.conclusion)) ||
      !isFingerprint(value.binding.conclusionFingerprint) || !isCandidateOrNull(value.binding.candidate) ||
      !isFingerprint(value.evidenceFingerprint)) return undefined;
  const evidence = parseClosedAnalysisEvidencePresentation(value.evidence);
  if (!evidence || value.evidenceFingerprint !== analysisDeliveryFingerprint(evidence) ||
      (value.binding.candidate !== null &&
        value.binding.candidate.conclusionFingerprint !== value.binding.conclusionFingerprint)) return undefined;
  return {
    schemaVersion: CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION,
    binding: value.binding as CliAnalysisEvidenceBundle['binding'],
    evidenceFingerprint: value.evidenceFingerprint,
    evidence,
  };
}

function isMatchingUnavailableBundle(
  value: unknown,
  input: {sessionId: string; turn: number; conclusion?: string; turnMarkdown: string},
): value is CliAnalysisEvidenceUnavailableBundle {
  return isPlainRecord(value) &&
    hasExactKeys(value, ['schemaVersion', 'binding', 'evidenceFingerprint', 'evidence', 'unavailableReason']) &&
    value.schemaVersion === CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION && value.evidenceFingerprint === null &&
    value.evidence === null && value.unavailableReason === 'analysis_evidence_projection_invalid' &&
    isPlainRecord(value.binding) &&
    hasExactKeys(value.binding, ['sessionId', 'turn', 'conclusionFingerprint', 'turnMarkdownFingerprint', 'candidate']) &&
    value.binding.sessionId === input.sessionId && value.binding.turn === input.turn &&
    value.binding.turnMarkdownFingerprint === analysisDeliveryFingerprint(input.turnMarkdown) &&
    (input.conclusion === undefined || value.binding.conclusionFingerprint === analysisDeliveryFingerprint(input.conclusion)) &&
    isFingerprint(value.binding.conclusionFingerprint) && isCandidateOrNull(value.binding.candidate) &&
    (value.binding.candidate === null || value.binding.candidate.conclusionFingerprint === value.binding.conclusionFingerprint);
}

function loadLegacyCliAnalysisEvidence(input: {
  sp: SessionPaths;
  sessionId: string;
  turn: number;
  conclusion?: string;
  turnMarkdown: string;
}): LoadedCliAnalysisEvidence {
  const prefix = turnPrefix(input.sp, input.turn);
  const files = {
    claimSupport: `${prefix}.claim-support.json`, claimVerificationResult: `${prefix}.claim-verification.json`,
    identityResolutions: `${prefix}.identity-resolutions.json`, investigationAssessment: `${prefix}.investigation-assessment.json`,
    deliveryAssurance: `${prefix}.delivery-assurance.json`, sourceUseDecision: `${prefix}.source-use-decision.json`,
    sourceClaimBindings: `${prefix}.source-claim-bindings.json`,
  };
  if (!Object.values(files).some(file => fs.existsSync(file))) return {status: 'none'};
  const values: Record<string, unknown> = {};
  for (const [key, file] of Object.entries(files)) {
    const parsed = readLegacyJson(file);
    if (!parsed.ok) return {status: 'unavailable', reason: 'legacy_analysis_evidence_invalid'};
    values[key] = parsed.value;
  }
  const sourceUseDecision = isPlainRecord(values.sourceUseDecision) ? values.sourceUseDecision : null;
  const evidence = parseClosedAnalysisEvidencePresentation({
    conclusionBindingEligibility: null,
    claims: [],
    claimSupport: values.claimSupport,
    claimVerificationResult: values.claimVerificationResult,
    identityResolutions: values.identityResolutions,
    investigationAssessment: values.investigationAssessment,
    deliveryAssurance: values.deliveryAssurance,
    sourceUseDecision,
    sourceReferences: sourceUseDecision?.references ?? [],
    sourceClaimBindings: values.sourceClaimBindings,
  });
  if (!evidence) return {status: 'unavailable', reason: 'legacy_analysis_evidence_invalid'};
  return {status: 'available', legacy: true, bundle: {
    schemaVersion: CLI_ANALYSIS_EVIDENCE_SCHEMA_VERSION,
    binding: {
      sessionId: input.sessionId, turn: input.turn,
      conclusionFingerprint: analysisDeliveryFingerprint(input.conclusion ?? ''),
      turnMarkdownFingerprint: analysisDeliveryFingerprint(input.turnMarkdown), candidate: null,
    },
    evidenceFingerprint: analysisDeliveryFingerprint(evidence), evidence,
  }};
}

function copyBoundCandidate(value: AnalysisResult['completion'], conclusion: string): AnalysisCandidateIdentity | null {
  if (!value || !value.candidateRef || !value.runId || !value.attemptId ||
      value.conclusionFingerprint !== analysisDeliveryFingerprint(conclusion)) return null;
  return {candidateRef: value.candidateRef, runId: value.runId, attemptId: value.attemptId,
    conclusionFingerprint: value.conclusionFingerprint};
}

function appendJsonSection(lines: string[], title: string, value: unknown): void {
  lines.push('', `### ${title}`, '');
  for (const line of JSON.stringify(value, null, 2).split('\n')) lines.push(`    ${line}`);
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function readLegacyJson(file: string): {ok: true; value: unknown} | {ok: false} {
  if (!fs.existsSync(file)) {
    const arrayFiles = ['claim-support.json', 'identity-resolutions.json', 'source-claim-bindings.json'];
    return {ok: true, value: arrayFiles.some(suffix => file.endsWith(suffix)) ? [] : null};
  }
  const value = readJson(file);
  return value === undefined ? {ok: false} : {ok: true, value};
}

function turnPrefix(sp: SessionPaths, turn: number): string {
  return path.join(sp.turnsDir, String(turn).padStart(3, '0'));
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isCandidateOrNull(value: unknown): value is AnalysisCandidateIdentity | null {
  return value === null || isPlainRecord(value) &&
    hasExactKeys(value, ['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint']) &&
    [value.candidateRef, value.runId, value.attemptId].every(item => typeof item === 'string' && item.length > 0) &&
    isFingerprint(value.conclusionFingerprint);
}
