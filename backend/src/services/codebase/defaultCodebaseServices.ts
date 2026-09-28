// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {backendLogPath} from '../../runtimePaths';
import {CodebaseRegistry} from './codebaseRegistry';

let cachedRegistry: {path: string; registry: CodebaseRegistry} | null = null;

/**
 * Resolved on use, never at import: the CLI sets its log root in bootstrap,
 * after its modules are imported, and a fixed import-time path would read a
 * different registry than `smp codebase register` writes.
 */
export function getDefaultCodebaseRegistry(): CodebaseRegistry {
  const registryPath = backendLogPath('codebase_registry.json');
  if (cachedRegistry?.path !== registryPath) {
    cachedRegistry = {path: registryPath, registry: new CodebaseRegistry(registryPath)};
  }
  return cachedRegistry.registry;
}

export function resetDefaultCodebaseRegistryForTests(): void {
  cachedRegistry = null;
}
