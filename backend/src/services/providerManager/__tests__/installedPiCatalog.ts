// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {execFileSync} from 'node:child_process';
import path from 'node:path';

type CatalogModel = Record<string, unknown>;

let cached: Array<{id: string; name: string; models: CatalogModel[]}> | undefined;

/**
 * The installed pi-ai builtin catalog, read by a real Node process (Jest's
 * module system cannot import the ESM package) and served through the same
 * module surface `resolvePiRouteModel` loads, so tests resolve routes against
 * exactly the catalog data production uses.
 */
export function installedPiCatalogLoader(): (specifier: string) => Promise<unknown> {
  cached ??= JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const all = await import('@earendil-works/pi-ai/providers/all');
    process.stdout.write(JSON.stringify(all.builtinProviders().map(provider => ({
      id: provider.id, name: provider.name, models: all.getBuiltinModels(provider.id) ?? [],
    }))));
  `], {cwd: path.resolve(__dirname, '../../../..'), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8'}));
  const providers = cached!;
  const module = {
    builtinProviders: () => providers.map(({id, name}) => ({id, name, auth: {}})),
    getBuiltinModels: (provider: string) => providers.find(candidate => candidate.id === provider)?.models,
    getBuiltinModel: (provider: string, modelId: string) => providers.find(candidate => candidate.id === provider)
      ?.models.find(model => model.id === modelId),
  };
  return async (specifier: string) => {
    if (specifier !== '@earendil-works/pi-ai/providers/all') throw new Error(`unexpected module ${specifier}`);
    return module;
  };
}
