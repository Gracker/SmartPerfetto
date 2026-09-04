// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Canonical source→frontend transforms for the analysis quality contracts.
 *
 * The generator and the sync checker both have to reduce a backend contract
 * module to the fragment that belongs in the generated frontend types. They
 * used to hold private copies of those rules, and they drifted: the generator
 * rewrote `SourceUseDecisionV1` to `Record<string, unknown>` (the frontend has
 * no `sourceUseDecision` module) while the checker compared against the
 * untransformed source. The check could then never pass, which left
 * `./scripts/start-dev.sh` failing at its type-sync gate.
 *
 * Both scripts import from here so the two can no longer disagree.
 */

const CASE_KNOWLEDGE_IMPORT =
  /import type \{CaseKnowledgeReportRecommendation\} from '..\/..\/types\/caseKnowledge';\n\n?/;

const SOURCE_USE_DECISION_IMPORT =
  /import type \{\s*SourceClaimBindingV1,\s*SourceReferenceV1,\s*SourceUseDecisionV1,\s*\} from '..\/..\/services\/codebase\/sourceUseDecision';\n\n?/;

const TRACE_TIMESTAMP_ALIAS = /export type TraceTimestampNs = string \| number;\n\n/;

/**
 * `conclusionContract.ts` as it appears in the generated frontend types.
 *
 * Backend-only imports are dropped and the types they brought in become
 * `Record<string, unknown>`: the frontend never needs their shape, and copying
 * the codebase modules across the boundary would pull source-access contracts
 * into the UI bundle.
 */
export function conclusionContractFragment(content: string): string {
  return content
    .trim()
    .replace(CASE_KNOWLEDGE_IMPORT, '')
    .replace(SOURCE_USE_DECISION_IMPORT, '')
    .replace(/SourceUseDecisionV1/g, 'Record<string, unknown>')
    .replace(/SourceReferenceV1/g, 'Record<string, unknown>')
    .replace(/SourceClaimBindingV1/g, 'Record<string, unknown>');
}

/** Contracts that need no rewriting beyond trimming. */
export function verbatimContractFragment(content: string): string {
  return content.trim();
}

/**
 * `identityContract.ts` shares `TraceTimestampNs` with the evidence contract,
 * and the generated frontend types concatenate both into one file.
 */
export function identityContractFragment(content: string): string {
  return content.trim().replace(TRACE_TIMESTAMP_ALIAS, '');
}

/** Per-file SPDX headers are emitted once at the top of the generated file. */
export function externalIssueReportingFragment(content: string): string {
  return content
    .trim()
    .replace(/^\/\/ SPDX-License-Identifier:[^\n]*\n/, '')
    .replace(/^\/\/ Copyright[^\n]*\n/, '')
    .replace(/^\/\/ This file[^\n]*\n\n/, '');
}
