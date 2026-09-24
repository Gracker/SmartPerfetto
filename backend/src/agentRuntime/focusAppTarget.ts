// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  DetectedFocusApp,
  FocusAppConfidence,
  FocusAppDetectionMethod,
  FocusAppDetectionResult,
  FocusAppExcludedProcess,
  FocusAppPenalty,
  FocusAppSignals,
} from '../agentv3/focusAppDetector';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';

/**
 * Where the package a run scopes to came from. Only `user` binds the analysis
 * target; `auto_detected` is a ranked hypothesis from focus detection.
 */
export type FocusAppTargetSource = 'user' | 'auto_detected' | 'none';

export interface FocusAppCandidate {
  packageName: string;
  processName?: string;
  pid?: number;
  score?: number;
  /** Non-zero signals only. */
  signals?: Partial<FocusAppSignals>;
  penalties?: FocusAppPenalty[];
}

/**
 * The single effective-package decision shared by every runtime and package
 * consumer (prompt, default Skill scoping, architecture scoping, comparison
 * identity, pattern memory).
 */
export interface FocusAppTarget {
  /**
   * Package in effect for default scoping: the user's package, or an
   * auto-detected one with `high`/`medium` confidence. Absent otherwise.
   */
  packageName?: string;
  source: FocusAppTargetSource;
  /**
   * Confidence of the detector's ranking, independent of the source: a
   * user-named package keeps it so the candidates can still be read.
   */
  confidence?: FocusAppConfidence;
  method: FocusAppDetectionMethod;
  candidates: FocusAppCandidate[];
  excludedNoActivity: FocusAppExcludedProcess[];
}

function nonZeroSignals(signals: FocusAppSignals | undefined): Partial<FocusAppSignals> | undefined {
  if (!signals) return undefined;
  const entries = Object.entries(signals).filter(([, value]) => typeof value === 'number' && value > 0);
  return entries.length ? Object.fromEntries(entries) as Partial<FocusAppSignals> : undefined;
}

function toCandidate(app: DetectedFocusApp): FocusAppCandidate {
  const signals = nonZeroSignals(app.signals);
  return {
    packageName: app.packageName,
    ...(app.processName && app.processName !== app.packageName ? {processName: app.processName} : {}),
    ...(app.pid !== undefined ? {pid: app.pid} : {}),
    ...(app.score !== undefined ? {score: app.score} : {}),
    ...(signals ? {signals} : {}),
    ...(app.penalties?.length ? {penalties: app.penalties} : {}),
  };
}

function normalizedPackage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveFocusAppTarget(input: {
  userPackageName?: string;
  focusResult?: FocusAppDetectionResult;
}): FocusAppTarget {
  const focus = input.focusResult;
  const confidence = focus?.confidence;
  const detection = {
    ...(confidence ? {confidence} : {}),
    method: focus?.method ?? 'none',
    candidates: (focus?.apps ?? []).map(toCandidate),
    excludedNoActivity: focus?.excludedNoActivity ?? [],
  } satisfies Pick<FocusAppTarget, 'confidence' | 'method' | 'candidates' | 'excludedNoActivity'>;
  const userPackageName = normalizedPackage(input.userPackageName);
  if (userPackageName) return {packageName: userPackageName, source: 'user', ...detection};
  const inferred = normalizedPackage(focus?.primaryApp);
  if (inferred && confidence !== 'ambiguous') {
    return {packageName: inferred, source: 'auto_detected', ...detection};
  }
  return {source: 'none', ...detection};
}

export interface PackageProvenance {
  source?: Exclude<FocusAppTargetSource, 'none'>;
  confidence?: FocusAppConfidence;
}

/**
 * Provenance of a package a consumer is about to use. A package the focus
 * target inferred is `auto_detected`; any other package came from the caller,
 * i.e. the user — except on a side where no user can name one (the reference
 * trace of a comparison).
 */
export function packageProvenance(
  packageName: string | undefined,
  target: FocusAppTarget | undefined,
  options: {userMayName: boolean} = {userMayName: true},
): PackageProvenance {
  if (!packageName) return {};
  const inferred = target?.source === 'auto_detected' && target.packageName === packageName;
  return {
    source: inferred || !options.userMayName ? 'auto_detected' : 'user',
    ...(inferred && target?.confidence ? {confidence: target.confidence} : {}),
  };
}

/**
 * Provenance of both sides of a comparison identity. Only a user-named package
 * is an expected identity; inferred ones are hypotheses the gate must not
 * enforce. No user names the reference side's package, so it is always inferred.
 */
export function comparisonPackageSources(
  current: FocusAppTarget | undefined,
  comparison: {referencePackageName?: string},
): {currentPackageSource?: PackageProvenance['source']; referencePackageSource?: PackageProvenance['source']} {
  const currentSource = packageProvenance(current?.packageName, current).source;
  const referenceSource = comparison.referencePackageName ? 'auto_detected' : undefined;
  return {
    ...(currentSource ? {currentPackageSource: currentSource} : {}),
    ...(referenceSource ? {referencePackageSource: referenceSource} : {}),
  };
}

/** Detection ran and produced something the model can read. */
export function hasFocusAppDetectionData(target: FocusAppTarget | undefined): target is FocusAppTarget {
  return Boolean(target && (target.candidates.length > 0 || target.excludedNoActivity.length > 0));
}

/** Data-only prompt block; guidance lives in knowledge-focus-app-context.template.md. */
export function buildFocusAppPromptData(target: FocusAppTarget | undefined): Record<string, unknown> | undefined {
  if (!hasFocusAppDetectionData(target)) return undefined;
  return {
    status: target.confidence ?? (target.candidates.length ? 'unknown' : 'none'),
    method: target.method,
    ...(target.source === 'auto_detected' && target.packageName ? {primary: target.packageName} : {}),
    candidates: target.candidates,
    ...(target.excludedNoActivity.length ? {
      excludedNoActivity: target.excludedNoActivity.map(({packageName, processName, pid, maxOomScore}) => ({
        packageName,
        ...(processName && processName !== packageName ? {processName} : {}),
        ...(pid !== undefined ? {pid} : {}),
        ...(maxOomScore !== undefined ? {maxOomScore} : {}),
      })),
    } : {}),
  };
}

/** Candidates a tool returns when a Skill needs a process selector nobody supplied. */
export function focusAppSelectorCandidates(target: FocusAppTarget | undefined): FocusAppCandidate[] {
  return (target?.candidates ?? []).map(({packageName, processName, pid, score}) => ({
    packageName,
    ...(processName ? {processName} : {}),
    ...(pid !== undefined ? {pid} : {}),
    ...(score !== undefined ? {score} : {}),
  }));
}

/**
 * Progress line for an inferred or ambiguous focus app. A user-named package
 * needs no announcement: the user already said it.
 */
export function formatFocusAppTargetProgress(
  target: FocusAppTarget,
  outputLanguage: OutputLanguage,
): string | undefined {
  if (target.source === 'auto_detected' && target.packageName) {
    const confidence = target.confidence ?? 'medium';
    return localize(
      outputLanguage,
      `推断焦点应用: ${target.packageName}（${target.method}，置信度 ${confidence}）`,
      `Inferred focus app: ${target.packageName} (${target.method}, ${confidence} confidence)`,
    );
  }
  if (target.source === 'none' && target.candidates.length > 1) {
    const names = target.candidates.slice(0, 3).map(candidate => candidate.packageName).join(', ');
    return localize(
      outputLanguage,
      `焦点应用不确定，候选: ${names}`,
      `Focus app is ambiguous; candidates: ${names}`,
    );
  }
  return undefined;
}
