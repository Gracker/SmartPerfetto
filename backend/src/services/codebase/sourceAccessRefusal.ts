// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Governance reasons that stop a code-aware source call, with what the model
 * should do instead. A refused call carries the action as `action_required`,
 * which keeps it out of the circuit breaker's failure rate
 * (`isPolicyRefusalResult`). A reason absent from this map (an inactive index,
 * invalid codebase metadata, a missing GitNexus binary, an unreadable file) is
 * a failure and still counts.
 *
 * The actions are closed product tokens, never derived from source content, so
 * the external-surface projection may carry them across its boundary.
 */
const SOURCE_ACCESS_REFUSAL_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  source_reference_limit_exceeded: 'continue_with_existing_source_evidence',
  no_send_to_provider_consent: 'continue_without_this_codebase',
  // The requested file lies outside the codebase's registered path filters;
  // a search result or a path inside those filters is admissible.
  source_path_outside_registered_filters: 'use_path_within_registered_filters',
  // The file is registered but not covered by the provider-send grant, so its
  // body cannot reach the model in this session.
  source_path_outside_provider_grant: 'continue_without_this_file',
});

const SOURCE_ACCESS_REFUSAL_ACTION_VALUES: ReadonlySet<string> = new Set(
  Object.values(SOURCE_ACCESS_REFUSAL_ACTIONS),
);

/** The action for a governance reason, or undefined when the reason is a failure. */
export function sourceAccessRefusalAction(reason: string | undefined): string | undefined {
  return reason !== undefined && Object.prototype.hasOwnProperty.call(SOURCE_ACCESS_REFUSAL_ACTIONS, reason)
    ? SOURCE_ACCESS_REFUSAL_ACTIONS[reason]
    : undefined;
}

/** True only for an action this module issues; anything else is not projected. */
export function isSourceAccessRefusalAction(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ACCESS_REFUSAL_ACTION_VALUES.has(value);
}
