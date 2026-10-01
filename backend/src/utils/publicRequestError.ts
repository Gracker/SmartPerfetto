// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A failure whose message SmartPerfetto wrote for the API caller: a rejected
 * input, a missing resource the caller named, or a state the caller has to
 * act on. Its text and `code` are part of the route contract and safe to
 * return; any other exception is answered with fixed text.
 *
 * Each domain throws its own subclass, and a route echoes only the subclasses
 * it lists (`sendRouteError`), so a public error thrown deep inside an
 * unrelated service does not surface with its status through another route.
 */
export class PublicRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = new.target.name;
  }
}

const THROWN_REASON = /^([a-z][a-z0-9_]{2,79})(?::\S*)?$/;

/**
 * The reason token a service wrote as a whole message
 * (`root_outside_allowlist`, `source_chunk_limit_exceeded:5000`), without the
 * detail after the first `:`, which can carry ids or sizes. Anything else,
 * prose included, is not a reason. Transitional: services that still throw
 * plain-Error reason codes get typed errors over time.
 */
export function messageReasonCode(message: string): string | undefined {
  return THROWN_REASON.exec(message)?.[1];
}

/** `messageReasonCode` of a thrown Error's message. */
export function thrownReasonCode(err: unknown): string | undefined {
  return err instanceof Error ? messageReasonCode(err.message) : undefined;
}
