// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import {bootstrap} from '../bootstrap';
import {backendLogPath} from '../../runtimePaths';
import {RagStore} from '../../services/ragStore';
import {
  codebaseRegistrationRequirements,
  CodebaseRegistry,
  resolveCodebaseScope,
} from '../../services/codebase/codebaseRegistry';
import {PathSecurityGate} from '../../services/codebase/pathSecurityGate';
import {SourceEnumerator} from '../../services/codebase/sourceEnumerator';
import {buildSourceSelectionIR} from '../../services/codebase/sourceSelectionPolicy';
import {AppSourceIngester} from '../../services/rag/appSourceIngester';
import {AospSourceIngester} from '../../services/rag/aospSourceIngester';
import {KernelSourceIngester} from '../../services/rag/kernelSourceIngester';
import {SymbolResolver} from '../../services/symbol/symbolResolver';
import type {CodebaseKind} from '../../services/codebase/codebaseRegistry';

const registryPath = () => backendLogPath('codebase_registry.json');
const ragStorePath = () => backendLogPath('rag_store.json');

export interface CodebaseCommandBaseArgs {
  envFile?: string;
  sessionDir?: string;
}

export async function runCodebaseListCommand(args: CodebaseCommandBaseArgs): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const registry = new CodebaseRegistry(registryPath());
  const codebases = registry.list();
  if (codebases.length === 0) {
    console.log('(no codebases registered)');
    return 0;
  }
  for (const ref of codebases) {
    console.log(`${ref.codebaseId}\t${ref.kind}\t${ref.displayName}\tchunks=${ref.chunkCount}\tprovider=${ref.eligibleForSendToProvider ? 'yes' : 'no'}`);
  }
  return 0;
}

export async function runCodebasePreviewCommand(args: CodebaseCommandBaseArgs & {
  rootPath: string;
  kind?: CodebaseKind;
  pathFilters?: string[];
  excludeGlobs?: string[];
}): Promise<number> {
  const rootPath = path.resolve(args.rootPath);
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const kind = args.kind ?? 'app_source';
  const gate = new PathSecurityGate({allowlistRoots: [rootPath]});
  const result = await new SourceEnumerator().enumerate({
    rootRealpath: rootPath,
    policy: buildSourceSelectionIR({
      kind,
      includePrefixes: args.pathFilters,
      excludeGlobs: args.excludeGlobs,
    }),
    gate,
  });
  console.log(JSON.stringify({
    blocked: false,
    complete: result.enumerationComplete,
    incompleteReason: result.incompleteReason,
    enumerationBackend: result.backend,
    backendFidelity: result.fidelity,
    deterministic: result.deterministic,
    acceptedFileCount: result.files.length,
    skippedFileCount: result.skippedCount,
    acceptedFiles: result.files.slice(0, 50),
  }, null, 2));
  return 0;
}

export async function runCodebaseRegisterCommand(args: CodebaseCommandBaseArgs & {
  rootPath: string;
  kind?: CodebaseKind;
  name?: string;
  sendToProvider?: boolean;
  pathFilters?: string[];
  excludeGlobs?: string[];
  vendor?: string;
  buildId?: string;
  commitHash?: string;
  licenseTag?: string;
  dryRun?: boolean;
}): Promise<number> {
  const rootPath = path.resolve(args.rootPath);
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const kind = args.kind ?? 'app_source';
  const requirements = codebaseRegistrationRequirements(kind);
  if (requirements.vendor && !args.vendor) {
    console.error('`vendor` is required for kernel_source and oem_sdk codebases');
    return 1;
  }
  if (requirements.licenseTag && !args.licenseTag) {
    console.error('`licenseTag` is required for aosp and oem_sdk codebases');
    return 1;
  }
  if (requirements.pathFilters && !args.pathFilters?.length) {
    console.error('`pathFilters` is required for kernel_source codebases');
    return 1;
  }
  const gate = new PathSecurityGate({allowlistRoots: [rootPath]});
  const rootRealpath = await gate.validateRoot(rootPath);
  const result = await new SourceEnumerator().enumerate({
    rootRealpath,
    policy: buildSourceSelectionIR({
      kind,
      includePrefixes: args.pathFilters,
      excludeGlobs: args.excludeGlobs,
    }),
    gate,
  });
  if (result.enumerationComplete && result.files.length === 0) {
    console.error([
      'blocked: effective_source_selection_empty',
      'No source files matched the effective selection; check path filters, exclude globs, ignored files, and supported extensions.',
    ].join(' - '));
    return 1;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({
      blocked: false,
      kind: args.kind ?? 'app_source',
      displayName: args.name ?? path.basename(rootPath),
      rootPath,
      pathFilters: args.pathFilters ?? [],
      excludeGlobs: args.excludeGlobs ?? [],
      acceptedFileCount: result.files.length,
      skippedFileCount: result.skippedCount,
      enumerationBackend: result.backend,
      backendFidelity: result.fidelity,
      complete: result.enumerationComplete,
      incompleteReason: result.incompleteReason,
    }, null, 2));
    return 0;
  }
  const registry = new CodebaseRegistry(registryPath());
  const ref = registry.register({
    kind,
    displayName: args.name ?? path.basename(rootPath),
    rootPath,
    rootRealpath,
    sendToProvider: Boolean(args.sendToProvider),
    pathFilters: args.pathFilters,
    excludeGlobs: args.excludeGlobs,
    ...(args.vendor ? {vendor: args.vendor} : {}),
    ...(args.buildId ? {buildId: args.buildId} : {}),
    ...(args.commitHash ? {commitHash: args.commitHash} : {}),
    ...(args.licenseTag ? {licenseTag: args.licenseTag} : {}),
  });
  console.log(`${ref.codebaseId}\t${ref.displayName}`);
  return 0;
}

export async function runCodebaseReindexCommand(args: CodebaseCommandBaseArgs & {codebaseId: string}): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const registry = new CodebaseRegistry(registryPath());
  const ref = registry.get(args.codebaseId);
  if (!ref) {
    console.error(`Codebase not found: ${args.codebaseId}`);
    return 1;
  }
  const store = new RagStore(ragStorePath());
  const gate = new PathSecurityGate({allowlistRoots: [ref.rootRealpath]});
  const result = await (ref.kind === 'kernel_source'
    ? new KernelSourceIngester(store, registry, gate).ingest(args.codebaseId)
    : ref.kind === 'aosp' || ref.kind === 'oem_sdk'
      ? new AospSourceIngester(store, registry, gate).ingest(args.codebaseId)
      : new AppSourceIngester(store, registry, gate).ingest(args.codebaseId));
  console.log(JSON.stringify(result, null, 2));
  return result.errors.length > 0 ? 1 : 0;
}

export async function runCodebaseSymbolsCommand(args: CodebaseCommandBaseArgs & {
  codebaseId?: string;
  symbol: string;
}): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const registry = new CodebaseRegistry(registryPath());
  const ref = args.codebaseId ? registry.get(args.codebaseId) : undefined;
  const resolver = new SymbolResolver(
    new RagStore(ragStorePath()),
    resolveCodebaseScope(),
    registry,
  );
  const result = ref?.kind === 'kernel_source'
    ? resolver.resolveKernel({symbol: args.symbol, codebaseId: args.codebaseId, vendor: ref.vendor})
    : ref?.kind === 'aosp' || ref?.kind === 'oem_sdk'
      ? resolver.resolveNative({symbol: args.symbol, codebaseId: args.codebaseId})
      : resolver.resolveApp({
          symbol: args.symbol,
          codebaseId: args.codebaseId,
        });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}
