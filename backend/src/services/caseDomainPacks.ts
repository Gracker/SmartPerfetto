// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CaseEvidenceSignature,
  CaseEvidenceSignatureOperator,
  CaseKnowledgeFrontmatter,
  CaseKnowledgeValidationIssue,
} from '../types/caseKnowledge';

const SCROLLING_V1_FIELDS = new Set([
  'reason_code',
  'render_slices',
  'main_slices',
  'jank_responsibility',
  'vsync_missed',
  'critical_path',
]);

const CASE_EVIDENCE_OPERATORS: ReadonlySet<CaseEvidenceSignatureOperator> =
  new Set(['eq', 'contains_any', 'gte', 'lte']);

export const SCROLLING_V1_REASON_CODES = [
  'buffer_stuffing',
  'sf_composition_slow',
  'display_hal',
  'prediction_error',
  'app_jank_unattributed',
  'frame_timeline_unattributed',
  'binder_sync_blocking',
  'gc_jank',
  'gc_pressure_cascade',
  'input_handling_slow',
  'small_core_placement',
  'sched_delay_in_slice',
  'shader_compile',
  'gpu_fence_wait',
  'render_thread_heavy',
  'workload_heavy',
  'thermal_throttling',
  'cpu_max_limited',
  'big_core_low_freq',
  'freq_ramp_slow',
  'cpu_saturation',
  'scheduling_delay',
  'main_thread_file_io',
  'uninterruptible_wait',
  'binder_timeout',
  'lock_contention',
  'render_sync_wait',
  // Legacy snapshots remain readable, but current Skills require direct
  // lock/Binder evidence and no longer emit this q4b-only classification.
  'lock_binder_wait',
  'unknown',
] as const;

const SCROLLING_V1_REASON_CODE_SET: ReadonlySet<string> =
  new Set(SCROLLING_V1_REASON_CODES);

export function validateCaseDomainPack(
  frontmatter: CaseKnowledgeFrontmatter,
  filePath: string,
): CaseKnowledgeValidationIssue[] {
  if (frontmatter.domain_pack !== 'scrolling.v1') {
    return [
      issue(
        filePath,
        `Unknown domain_pack '${frontmatter.domain_pack}'`,
        'domain_pack',
      ),
    ];
  }

  const issues: CaseKnowledgeValidationIssue[] = [];
  if (frontmatter.scene !== 'scrolling') {
    issues.push(
      issue(
        filePath,
        `domain_pack 'scrolling.v1' requires scene='scrolling'`,
        'scene',
      ),
    );
  }
  validateRootCause(
    frontmatter.taxonomy.primary_root_cause,
    filePath,
    'taxonomy.primary_root_cause',
    issues,
  );
  frontmatter.taxonomy.secondary_root_causes.forEach((rootCause, index) => {
    validateRootCause(
      rootCause,
      filePath,
      `taxonomy.secondary_root_causes[${index}]`,
      issues,
    );
  });

  validateSignatures(
    frontmatter.evidence_signatures.required,
    'evidence_signatures.required',
    filePath,
    issues,
  );
  validateSignatures(
    frontmatter.evidence_signatures.supportive,
    'evidence_signatures.supportive',
    filePath,
    issues,
  );

  return issues;
}

function validateRootCause(
  rootCause: string,
  filePath: string,
  fieldPath: string,
  issues: CaseKnowledgeValidationIssue[],
): void {
  if (!SCROLLING_V1_REASON_CODE_SET.has(rootCause)) {
    issues.push(
      issue(
        filePath,
        `scrolling.v1 does not define root cause '${rootCause}'`,
        fieldPath,
      ),
    );
  }
}

function validateSignatures(
  signatures: CaseEvidenceSignature[],
  basePath: string,
  filePath: string,
  issues: CaseKnowledgeValidationIssue[],
): void {
  signatures.forEach((signature, index) => {
    const fieldPath = `${basePath}[${index}]`;
    if (!SCROLLING_V1_FIELDS.has(signature.field)) {
      issues.push(
        issue(
          filePath,
          `scrolling.v1 does not define evidence field '${signature.field}'`,
          `${fieldPath}.field`,
        ),
      );
    }
    if (!CASE_EVIDENCE_OPERATORS.has(signature.op)) {
      issues.push(
        issue(
          filePath,
          `Unsupported evidence operator '${signature.op}'`,
          `${fieldPath}.op`,
        ),
      );
    }
    if (signature.field === 'reason_code') {
      validateReasonCode(signature, filePath, `${fieldPath}.value`, issues);
    }
  });
}

function validateReasonCode(
  signature: CaseEvidenceSignature,
  filePath: string,
  fieldPath: string,
  issues: CaseKnowledgeValidationIssue[],
): void {
  const values = Array.isArray(signature.value)
    ? signature.value
    : [signature.value];
  for (const value of values) {
    if (typeof value !== 'string' || !SCROLLING_V1_REASON_CODE_SET.has(value)) {
      issues.push(
        issue(
          filePath,
          `scrolling.v1 does not define reason_code '${String(value)}'`,
          fieldPath,
        ),
      );
    }
  }
}

function issue(
  filePath: string,
  message: string,
  fieldPath?: string,
): CaseKnowledgeValidationIssue {
  return {filePath, message, fieldPath};
}
