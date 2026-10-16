// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import {trustLocalCliRegistrations} from '../../services/codebase/codebaseCapability';
import {getDefaultCodebaseRegistry} from '../../services/codebase/defaultCodebaseServices';

/**
 * The CLI's registry: the process default, resolved after bootstrap. Its
 * entries were registered by the local user, whom this process trusts to
 * read what they registered without a configured allowlist.
 */
export function cliCodebaseRegistry(): CodebaseRegistry {
  trustLocalCliRegistrations();
  return getDefaultCodebaseRegistry();
}
