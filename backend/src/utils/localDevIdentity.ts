// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The identity keyless local mode authenticates as, and the owner a record or
 * scope without one falls back to. Every partition (auth, traces, providers,
 * codebases, knowledge, Self-Evolution) must resolve the same triple, or local
 * data lands in a scope no request reads.
 *
 * Zero dependencies on purpose: `middleware/auth.ts` imports services, so a
 * service importing these from it would close a runtime require cycle.
 */
export const DEFAULT_TENANT_ID = 'default-dev-tenant';
export const DEFAULT_WORKSPACE_ID = 'default-workspace';
export const DEFAULT_DEV_USER_ID = 'dev-user-123';

export const LOCAL_DEV_OWNER: Readonly<{tenantId: string; workspaceId: string; userId: string}> = Object.freeze({
  tenantId: DEFAULT_TENANT_ID,
  workspaceId: DEFAULT_WORKSPACE_ID,
  userId: DEFAULT_DEV_USER_ID,
});
