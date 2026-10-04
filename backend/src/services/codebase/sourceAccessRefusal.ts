// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Governance reasons that stop a code-aware source call, with what the model
 * should do instead. A refused call carries the action as `action_required`,
 * which keeps it out of the circuit breaker's failure rate
 * (`isPolicyRefusalResult`). A reason absent from this map (invalid codebase
 * metadata, a missing GitNexus binary, a malformed path, an unreadable file)
 * is a failure and still counts.
 *
 * The actions are closed product tokens, never derived from source content, so
 * the external-surface projection may carry them across its boundary.
 *
 * A path refusal names a tool, not the scope. The registered path filters and
 * exclude globs are owner configuration the model is never shown (an exclude
 * glob can name exactly the private directory it hides), so the refusal points
 * at `search_codebase`, whose results are admitted paths by construction, and
 * echoes neither the requested path nor any filter.
 */
const SOURCE_ACCESS_REFUSAL_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['source_reference_limit_exceeded', 'continue_with_existing_source_evidence'],
  ['no_send_to_provider_consent', 'continue_without_this_codebase'],
  // The provider-send grant no longer matches the codebase's selection, so it
  // authorizes none of it until the owner renews it.
  ['provider_grant_scope_stale', 'continue_without_this_codebase'],
  // The requested file is not admitted by the codebase's source policy.
  ['source_path_outside_registered_filters', 'locate_path_with_search_codebase'],
  ['source_path_excluded', 'locate_path_with_search_codebase'],
  ['source_extension_not_allowed', 'locate_path_with_search_codebase'],
  // A search path_prefix that no admitted file can lie under: nothing was
  // searched, so an empty result would read as source absence.
  ['source_path_prefix_outside_registered_filters', 'retry_search_without_path_prefix'],
  // Registered, but not covered by the provider-send grant: a search without the
  // prefix would withhold the same files, so the model continues without them.
  ['source_path_prefix_outside_provider_grant', 'continue_without_this_path_prefix'],
  // The file is registered but not covered by the provider-send grant, so its
  // body cannot reach the model in this session.
  ['source_path_outside_provider_grant', 'continue_without_this_file'],
  // The named codebase has no active index or no GitNexus graph for this run:
  // decided before any source is reached, and its live root is still searchable.
  ['codebase_index_unavailable', 'use_search_codebase'],
  ['codebase_graph_unavailable', 'use_search_codebase'],
  // The index was rebuilt or retired since this run pinned its generation
  // (`indexGenerationPins.ts`): the pinned one is gone, the live root is not.
  ['codebase_index_generation_changed', 'use_search_codebase'],
]);

const SOURCE_ACCESS_REFUSAL_ACTION_VALUES: ReadonlySet<string> = new Set(
  SOURCE_ACCESS_REFUSAL_ACTIONS.values(),
);

/** The action for a governance reason, or undefined when the reason is a failure. */
export function sourceAccessRefusalAction(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : SOURCE_ACCESS_REFUSAL_ACTIONS.get(reason);
}

/** True only for an action this module issues; anything else is not projected. */
export function isSourceAccessRefusalAction(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ACCESS_REFUSAL_ACTION_VALUES.has(value);
}
