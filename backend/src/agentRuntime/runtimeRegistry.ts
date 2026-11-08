// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import {
  PRODUCTION_RUNTIME_DESCRIPTORS,
} from './runtimeDescriptors';
import type {
  RuntimeEngineDefinition,
  RuntimeFactoryInput,
} from './runtimeDescriptorTypes';
export type { RuntimeEngineDefinition, RuntimeFactoryInput } from './runtimeDescriptorTypes';

function assertRuntimeDefinition(definition: RuntimeEngineDefinition): void {
  if (definition.kind !== definition.capabilities.kind) {
    throw new Error(
      `Runtime registration mismatch: ${definition.kind} != ${definition.capabilities.kind}`,
    );
  }
}

function createDefinitionMap(
  definitions: readonly RuntimeEngineDefinition[],
): Map<string, RuntimeEngineDefinition> {
  const byKind = new Map<string, RuntimeEngineDefinition>();
  for (const definition of definitions) {
    assertRuntimeDefinition(definition);
    if (byKind.has(definition.kind)) {
      throw new Error(`Runtime already registered: ${definition.kind}`);
    }
    byKind.set(definition.kind, definition);
  }
  return byKind;
}

function requireDefinition(
  definitions: ReadonlyMap<string, RuntimeEngineDefinition>,
  kind: string,
): RuntimeEngineDefinition {
  const definition = definitions.get(kind);
  if (!definition) {
    throw new Error(`Unsupported agent runtime: ${kind}`);
  }
  return definition;
}

export class RuntimeRegistry {
  private readonly definitions: ReadonlyMap<string, RuntimeEngineDefinition>;

  constructor(definitions: readonly RuntimeEngineDefinition[] = []) {
    this.definitions = createDefinitionMap(definitions);
  }

  createOrchestrator(kind: string, input: RuntimeFactoryInput): IOrchestrator {
    return requireDefinition(this.definitions, kind).createOrchestrator(input);
  }
}

const productionRuntimeDefinitions: readonly RuntimeEngineDefinition[] = PRODUCTION_RUNTIME_DESCRIPTORS;

export function createRuntimeRegistry(
  definitions: readonly RuntimeEngineDefinition[] = [],
): RuntimeRegistry {
  return new RuntimeRegistry(definitions);
}

const productionRuntimeRegistry = createRuntimeRegistry(productionRuntimeDefinitions);

/** The registry of the engines a selection can name (Pi, and the hidden Claude/OpenAI fallback). */
export function getProductionRuntimeRegistry(): RuntimeRegistry {
  return productionRuntimeRegistry;
}
