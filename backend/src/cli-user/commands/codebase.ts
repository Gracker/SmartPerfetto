// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import { bootstrap, resolveInvocationPath } from '../bootstrap';
import {writeCliInputError, writeCliOperationError} from '../io/operationErrors';
import {withConsoleLogToStderr} from '../io/stdio';
import {cliCodebaseRegistry} from '../services/cliCodebaseRegistry';
import {backendLogPath} from '../../runtimePaths';
import {RagStore} from '../../services/ragStore';
import {
  codebaseRegistrationRequirements,
  resolveCodebaseScope,
  type CodebaseScope,
} from '../../services/codebase/codebaseRegistry';
import {
  CodebaseManagementError,
  CodebaseManagementService,
  type RegisteredCodebase,
} from '../../services/codebase/codebaseManagementService';
import {PathSecurityGate} from '../../services/codebase/pathSecurityGate';
import {SourceEnumerator} from '../../services/codebase/sourceEnumerator';
import {buildSourceSelectionIR} from '../../services/codebase/sourceSelectionPolicy';
import {AppSourceIngester} from '../../services/rag/appSourceIngester';
import {AospSourceIngester} from '../../services/rag/aospSourceIngester';
import {KernelSourceIngester} from '../../services/rag/kernelSourceIngester';
import {SymbolResolver} from '../../services/symbol/symbolResolver';
import type {CodebaseKind} from '../../services/codebase/codebaseRegistry';

const ragStorePath = () => backendLogPath('rag_store.json');

export interface CodebaseCommandBaseArgs {
  envFile?: string;
  sessionDir?: string;
  managementService?: CodebaseManagementService;
  format?: CodebaseOutputFormat;
}

export type CodebaseOutputFormat = 'table' | 'json';

function managementContext(
  args: CodebaseCommandBaseArgs,
  allowlistRoot?: string,
): {service: CodebaseManagementService; scope: Required<CodebaseScope>} {
  const scope = resolveCodebaseScope();
  const service = args.managementService ?? new CodebaseManagementService({
    registry: cliCodebaseRegistry(),
    store: new RagStore(ragStorePath()),
    gate: allowlistRoot
      ? new PathSecurityGate({allowlistRoots: [allowlistRoot]})
      : new PathSecurityGate(),
    sourceEnumerator: new SourceEnumerator(),
  });
  return {service, scope};
}

function writeManagementError(format: CodebaseOutputFormat, error: unknown): number {
  return writeCliOperationError(format === 'json', error instanceof CodebaseManagementError ? error : undefined,
    {code: 'CODEBASE_OPERATION_FAILED', message: 'Codebase management operation failed'});
}

function writeInputError(format: CodebaseOutputFormat, code: string, message: string): number {
  return writeCliInputError(format === 'json', code, message);
}

function printCodebaseTableRow(ref: RegisteredCodebase | Awaited<ReturnType<CodebaseManagementService['list']>>[number]): void {
  const pending = ref.pendingGeneration?.candidateGenerationId ?? '-';
  const reindex = ref.reindexRequired ?? '-';
  const grant = ref.providerGrantScopeCurrent ? 'current' : 'mismatch';
  console.log([
    ref.codebaseId,
    ref.kind,
    ref.displayName,
    `root=${ref.rootAvailable ? 'available' : 'unavailable'}`,
    `index=${ref.activeIndexState}`,
    `selection=${ref.selectionPolicyRevision ?? 1}`,
    `reindex=${reindex}`,
    `consent=${ref.eligibleForSendToProvider ? 'enabled' : 'disabled'}`,
    `grant=${grant}`,
    `pending=${pending}`,
  ].join('\t'));
}

export async function runCodebaseListCommand(args: CodebaseCommandBaseArgs): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const format = args.format ?? 'table';
  const {service, scope} = managementContext(args);
  try {
    const codebases = await withConsoleLogToStderr(
      true,
      async () => service.list(scope),
    );
    if (format === 'json') {
      console.log(JSON.stringify({success: true, codebases}, null, 2));
      return 0;
    }
    if (codebases.length === 0) {
      console.log('(no codebases registered)');
      return 0;
    }
    for (const ref of codebases) printCodebaseTableRow(ref);
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebasePreviewCommand(args: CodebaseCommandBaseArgs & {
  rootPath: string;
  kind?: CodebaseKind;
  pathFilters?: string[];
  excludeGlobs?: string[];
}): Promise<number> {
  const rootPath = resolveInvocationPath(args.rootPath);
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const kind = args.kind ?? 'app_source';
  const {service, scope} = managementContext(args, rootPath);
  try {
    const preview = await withConsoleLogToStderr(true, async () => service.preview({
      rootPath,
      kind,
      pathFilters: args.pathFilters,
      excludeGlobs: args.excludeGlobs,
    }, scope));
    console.log(JSON.stringify(preview, null, 2));
    return preview.blocked ? 2 : 0;
  } catch (error) {
    return writeManagementError('json', error);
  }
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
  const rootPath = resolveInvocationPath(args.rootPath);
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
  const registry = cliCodebaseRegistry();
  const ref = registry.register({
    kind,
    displayName: args.name ?? path.basename(rootPath),
    rootPath,
    rootRealpath,
    sendToProvider: Boolean(args.sendToProvider),
    rootAuthorization: 'local_cli',
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

export async function runCodebaseSelectionCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  /** Enumerate what the replacement would admit and print it without saving. */
  preview?: boolean;
  /** The `selectionPolicyRevision` a preview printed; a save against a newer one is refused. */
  expectedRevision?: number;
}): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const format = args.format ?? 'table';
  const {service, scope} = managementContext(args);
  const input = {
    ...(args.pathFilters !== undefined ? {pathFilters: args.pathFilters} : {}),
    ...(args.excludeGlobs !== undefined ? {excludeGlobs: args.excludeGlobs} : {}),
    ...(args.expectedRevision !== undefined ? {expectedSelectionPolicyRevision: args.expectedRevision} : {}),
  };
  if (args.preview) {
    try {
      const selectionPreview = await withConsoleLogToStderr(true,
        async () => service.previewSelection(args.codebaseId, input, scope));
      console.log(JSON.stringify({success: true, selectionPreview}, null, 2));
      return selectionPreview.status === 'unavailable' ? 2 : 0;
    } catch (error) {
      return writeManagementError('json', error);
    }
  }
  try {
    const codebase = await withConsoleLogToStderr(
      format === 'json',
      async () => service.updateSelection(args.codebaseId, input, scope),
    );
    const payload = {
      success: true,
      codebase,
      reindexWarning: Boolean(codebase.reindexRequired),
    };
    if (format === 'json') console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(
        `Selection replaced for ${codebase.codebaseId} (revision ${codebase.selectionPolicyRevision ?? 1}).`,
      );
      if (payload.reindexWarning) {
        console.log(`Active index invalidated; run: smp codebase reindex ${codebase.codebaseId}.`);
      }
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebaseConsentCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
  enable?: boolean;
  disable?: boolean;
}): Promise<number> {
  const format = args.format ?? 'table';
  if (Number(Boolean(args.enable)) + Number(Boolean(args.disable)) !== 1) {
    return writeInputError(
      format,
      'CODEBASE_CONSENT_ACTION_INVALID',
      'Exactly one of --enable or --disable is required.',
    );
  }
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const {service, scope} = managementContext(args);
  try {
    const enabled = Boolean(args.enable);
    const codebase = await withConsoleLogToStderr(
      format === 'json',
      async () => service.setConsent(args.codebaseId, enabled, scope.userId, scope),
    );
    if (format === 'json') {
      console.log(JSON.stringify({success: true, action: enabled ? 'enabled' : 'disabled', codebase}, null, 2));
    } else {
      console.log(enabled
        ? `Provider-send consent enabled for ${codebase.codebaseId}; source text is sent only in provider_send sessions.`
        : `Provider-send consent disabled for ${codebase.codebaseId}; future provider source text is blocked.`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

/**
 * What a provider-send grant means, as the Web source activation discloses it
 * (`source_analysis_disclosure.ts`).
 */
const SOURCE_SEND_DISCLOSURE =
  'Relevant source snippets are sent to the configured AI service, including an internal company service. ' +
  'Analysis results and quoted source may be saved in local history and exported reports; retention by the ' +
  'AI service depends on its configuration and policy. Source searches, reads, and additional model analysis ' +
  'make the workflow longer and increase analysis time.';

/** Runs one consent action and reports the resulting codebase. */
async function runConsentAction(
  args: CodebaseCommandBaseArgs & {codebaseId: string},
  action: string,
  apply: (service: CodebaseManagementService, scope: Required<CodebaseScope>) => Promise<RegisteredCodebase>,
  describe: (codebase: RegisteredCodebase) => string,
): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const format = args.format ?? 'table';
  const {service, scope} = managementContext(args);
  try {
    const codebase = await withConsoleLogToStderr(format === 'json', async () => apply(service, scope));
    if (format === 'json') {
      console.log(JSON.stringify({success: true, action, codebase}, null, 2));
    } else {
      console.log(describe(codebase));
      if (codebase.reindexRequired) console.log(`Reindex required: ${codebase.reindexRequired}.`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

/**
 * Without `confirm`, prints exactly what the combined grant would cover (the
 * relative include prefixes, exclusions and languages, what sending means)
 * and the token that grants exactly that, and grants nothing. With the token,
 * grants it; a selection edit or a newly available language since the
 * disclosure refuses the grant.
 */
export async function runCodebaseAuthorizeContentCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
  confirm?: string;
}): Promise<number> {
  if (args.confirm) {
    const token = args.confirm;
    return runConsentAction(args, 'authorized_content',
      (service, scope) => service.authorizeContent(args.codebaseId, scope.userId, token, scope),
      codebase => `Source text may be sent for the disclosed selection and languages of ${codebase.codebaseId} ` +
        `(grant revision ${codebase.grantRevision}); it is sent only in provider_send sessions.`);
  }
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const format = args.format ?? 'table';
  const {service, scope} = managementContext(args);
  try {
    const codebase = await withConsoleLogToStderr(format === 'json', async () => service.get(args.codebaseId, scope));
    // The service's disclosure: the lists its token names, which is what the grant takes.
    const disclosure = {...codebase.contentDisclosure, codebaseId: codebase.codebaseId, notice: SOURCE_SEND_DISCLOSURE};
    if (format === 'json') {
      console.log(JSON.stringify({success: true, action: 'disclosure', granted: false, disclosure}, null, 2));
    } else {
      console.log(`Granting provider-send for ${codebase.codebaseId} would cover:`);
      console.log(`  include: ${disclosure.includePrefixes.length ? disclosure.includePrefixes.join(', ') : '(whole registered root)'}`);
      console.log(`  exclude: ${disclosure.excludeGlobs.length ? disclosure.excludeGlobs.join(', ') : '(none)'}`);
      console.log(`  languages: ${disclosure.extensions.join(' ')}`);
      console.log(disclosure.notice);
      console.log('Nothing was granted. To grant exactly this scope, run:');
      console.log(`  smp codebase authorize-content ${codebase.codebaseId} --confirm ${disclosure.token}`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebaseAuthorizeExtensionsCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
}): Promise<number> {
  return runConsentAction(args, 'authorized_extensions',
    (service, scope) => service.authorizeAvailableExtensions(args.codebaseId, scope.userId, scope),
    codebase => `Available source extensions authorized for ${codebase.codebaseId} (grant revision ${codebase.grantRevision}).`);
}

export async function runCodebaseAuthorizeSelectionCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
}): Promise<number> {
  return runConsentAction(args, 'authorized_selection',
    (service, scope) => service.authorizeCurrentSelection(args.codebaseId, scope.userId, scope),
    codebase => `Current source selection authorized for ${codebase.codebaseId} (grant revision ${codebase.grantRevision}).`);
}

export async function runCodebasePendingCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
  accept?: boolean;
  reject?: boolean;
  candidateId?: string;
}): Promise<number> {
  const format = args.format ?? 'table';
  if (Number(Boolean(args.accept)) + Number(Boolean(args.reject)) !== 1) {
    return writeInputError(
      format,
      'CODEBASE_PENDING_ACTION_INVALID',
      'Exactly one of --accept or --reject is required.',
    );
  }
  const candidateId = args.candidateId?.trim();
  if (!candidateId || candidateId.length > 256 || candidateId.includes('\0')) {
    return writeInputError(
      format,
      'CODEBASE_PENDING_CANDIDATE_INVALID',
      '--candidate must be a non-empty id of at most 256 characters.',
    );
  }
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const {service, scope} = managementContext(args);
  try {
    const action = args.accept ? 'accepted' : 'rejected';
    const codebase = await withConsoleLogToStderr(
      format === 'json',
      async () => args.accept
        ? service.acceptPending(args.codebaseId, candidateId, scope)
        : service.rejectPending(args.codebaseId, candidateId, scope),
    );
    if (format === 'json') {
      console.log(JSON.stringify({success: true, action, candidateId, codebase}, null, 2));
    } else {
      console.log(`Pending generation ${candidateId} ${action} for ${codebase.codebaseId}.`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebaseAuditCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
}): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const format = args.format ?? 'table';
  const {service, scope} = managementContext(args);
  try {
    const audit = await withConsoleLogToStderr(
      format === 'json',
      async () => service.audit(args.codebaseId, scope),
    );
    if (format === 'json') {
      console.log(JSON.stringify({success: true, audit}, null, 2));
    } else {
      console.log(`codebase\t${audit.codebaseId}`);
      console.log(`kind\t${audit.kind}`);
      console.log(`index\t${audit.activeIndexState}\tgeneration=${audit.activeGeneration ?? '-'}`);
      console.log(`selection\trevision=${audit.selectionPolicyRevision}\treindex=${audit.reindexRequired ?? '-'}`);
      console.log(`grant\trevision=${audit.grantRevision}`);
      console.log(`pending\t${audit.pendingGeneration?.candidateGenerationId ?? '-'}`);
      console.log(`ingest\t${audit.lastIngestStatus ?? '-'}\tchunks=${audit.chunkCount}`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebaseDeleteCommand(args: CodebaseCommandBaseArgs & {
  codebaseId: string;
  yes?: boolean;
}): Promise<number> {
  const format = args.format ?? 'table';
  if (!args.yes) {
    return writeInputError(
      format,
      'CODEBASE_DELETE_CONFIRMATION_REQUIRED',
      'Codebase deletion requires --yes; it removes the registration and all indexed generations.',
    );
  }
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const {service, scope} = managementContext(args);
  try {
    const result = await withConsoleLogToStderr(
      format === 'json',
      async () => service.delete(args.codebaseId, scope),
    );
    if (format === 'json') {
      console.log(JSON.stringify({success: true, ...result}, null, 2));
    } else if (result.alreadyDeleted) {
      console.log(`Codebase ${result.codebaseId} was already deleted; no chunks were removed.`);
    } else {
      console.log(`Deleted codebase ${result.codebaseId}; removed ${result.removedChunkCount} indexed chunks.`);
    }
    return 0;
  } catch (error) {
    return writeManagementError(format, error);
  }
}

export async function runCodebaseReindexCommand(args: CodebaseCommandBaseArgs & {codebaseId: string}): Promise<number> {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir});
  const registry = cliCodebaseRegistry();
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
  const registry = cliCodebaseRegistry();
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
