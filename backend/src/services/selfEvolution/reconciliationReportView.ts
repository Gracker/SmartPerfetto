// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {VendorOverrideLoadIssue} from '../skillEngine/skillLoader';
import type {
  UpgradeReconciliationIssueV1,
  UpgradeReconciliationReportV1,
} from '../../types/selfEvolution';

type ReconciliationReasonCode =
  | VendorOverrideLoadIssue['reasonCode']
  | 'overlay_artifact_invalid'
  | 'overlay_conflict';

// The reasonCodes `overlayReconciler` writes. The stored field is a plain
// string, so a code added there without a text here reads generically.
const ISSUE_TEXT: ReadonlyMap<string, string> = new Map(Object.entries({
  vendor_override_base_missing: 'Vendor override base skill is missing',
  vendor_override_base_not_built_in: 'Vendor override base must be built in',
  vendor_override_parse_failure: 'Vendor override could not be parsed',
  overlay_artifact_invalid: 'Overlay artifact could not be loaded',
  overlay_conflict: 'Overlay candidate generation failed validation',
} satisfies Record<ReconciliationReasonCode, string>));

const UNKNOWN_ISSUE_TEXT = 'Reconciliation issue';

// The admin surface's error-code shape (see the routes' `sendError`): no
// quote, space or capital, so it cannot carry a parser's quotation.
const ERROR_CODE = /^[a-z0-9_:-]{1,160}$/;

/**
 * The admin view of a stored, hash-verified reconciliation report.
 *
 * Reports written before overlay and override loads stopped recording parser
 * errors keep a V8 or js-yaml message that quotes the artifact or YAML it
 * failed on. Storage and `contentHash` stay as written; only the outgoing
 * issue message changes: an error code is kept, and any other text becomes
 * the fixed text for its `reasonCode`. `contentHash` still names the stored
 * report, so the view itself is not re-hashable.
 */
export function projectReconciliationReportForAdmin(
  report: UpgradeReconciliationReportV1 | null,
): UpgradeReconciliationReportV1 | null {
  if (!report) return report;
  let changed = false;
  const issues = report.issues.map((issue): UpgradeReconciliationIssueV1 => {
    if (ERROR_CODE.test(issue.message)) return issue;
    changed = true;
    return {
      ...issue,
      message: ISSUE_TEXT.get(issue.reasonCode) ?? UNKNOWN_ISSUE_TEXT,
    };
  });
  return changed ? {...report, issues} : report;
}
