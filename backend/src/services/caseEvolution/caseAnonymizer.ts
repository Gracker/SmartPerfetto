// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseCandidate, CaseCandidateReview } from '../../types/caseEvolution';
import { bucketPackageDomain } from './domainBucket';

export type CaseEvolutionAnonymizeResult =
  | {
      ok: true;
      candidate: CaseCandidate;
      review: CaseCandidateReview;
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
      warnings: string[];
    };

export type CaseCandidateAnonymizeResult =
  | { ok: true; candidate: CaseCandidate; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export type CaseReviewAnonymizeResult =
  | { ok: true; review: CaseCandidateReview; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Anonymize a candidate in isolation, BEFORE it is first persisted
 * (capture/enqueue). This is the §3.4 PII gate for the candidate half —
 * without it, raw PII from a captured run lands in the outbox DB and the
 * shadow sidecar before the worker ever runs.
 *
 * Required-field PII rejection does not apply to the candidate payload (the
 * candidate has no `review.proposed.*` required paths); every string field
 * is either redacted (PII) or bucketed (package/path). So this path always
 * returns ok:true for well-formed candidates.
 */
export function anonymizeCaseCandidate(candidate: CaseCandidate): CaseCandidateAnonymizeResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const cleanCandidate = sanitizeValue(candidate, 'candidate', warnings, errors) as CaseCandidate | undefined;
  if (!cleanCandidate || errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, candidate: cleanCandidate, warnings };
}

/**
 * Anonymize a review in isolation, BEFORE the worker persists it
 * (fenced outbox completion / sidecar write). This is the §3.4 PII gate for the
 * review half. Required-field PII (title, finding titles, recommendation
 * actions) rejects the review; optional-field PII is redacted.
 */
export function anonymizeCaseReview(review: CaseCandidateReview): CaseReviewAnonymizeResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const cleanReview = sanitizeValue(review, 'review', warnings, errors) as CaseCandidateReview | undefined;
  if (!cleanReview || errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, review: cleanReview, warnings };
}

const PACKAGE_RE = /\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}\b/gi;
const APP_DATA_PATH_RE = /\/data\/data\/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)(\/[^\s"'`)]*)?/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;
const MAC_RE = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

const REQUIRED_REVIEW_PATHS = new Set<string>([
  'review.proposed.title',
  'review.proposed.primaryRootCause',
]);

export function anonymizeCaseEvolutionInput(
  candidate: CaseCandidate,
  review: CaseCandidateReview,
): CaseEvolutionAnonymizeResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const cleanCandidate = sanitizeValue(candidate, 'candidate', warnings, errors) as CaseCandidate | undefined;
  const cleanReview = sanitizeValue(review, 'review', warnings, errors) as CaseCandidateReview | undefined;
  if (!cleanCandidate || !cleanReview || errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, candidate: cleanCandidate, review: cleanReview, warnings };
}

function sanitizeValue(
  value: unknown,
  path: string,
  warnings: string[],
  errors: string[],
): unknown {
  if (typeof value === 'string') return sanitizeString(value, path, warnings, errors);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item, index) => sanitizeValue(item, `${path}[${index}]`, warnings, errors))
      .filter(item => item !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const clean = sanitizeValue(child, `${path}.${key}`, warnings, errors);
      if (clean !== undefined) out[key] = clean;
      else warnings.push(`omitted unsupported field at ${path}.${key}`);
    }
    return out;
  }
  warnings.push(`omitted unsupported value at ${path}`);
  return undefined;
}

function sanitizeString(
  value: string,
  path: string,
  warnings: string[],
  errors: string[],
): string {
  if (containsPii(value)) {
    if (isRequiredPath(path)) {
      errors.push(`PII detected in required field ${path}`);
      return value;
    }
    warnings.push(`redacted PII in optional field ${path}`);
    return '<redacted>';
  }

  let clean = value.replace(APP_DATA_PATH_RE, (_match, _pkg, rest) => `<app_data_dir>${rest ?? ''}`);
  clean = clean.replace(PACKAGE_RE, pkg => bucketPackageDomain(pkg));
  return clean;
}

function containsPii(value: string): boolean {
  return EMAIL_RE.test(value) || URL_RE.test(value) || MAC_RE.test(value) || PHONE_RE.test(value);
}

function isRequiredPath(path: string): boolean {
  if (REQUIRED_REVIEW_PATHS.has(path)) return true;
  if (/^review\.proposed\.findings\[\d+\]\.title$/.test(path)) return true;
  if (/^review\.proposed\.recommendations\.(app|oem)\[\d+\]\.action$/.test(path)) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
