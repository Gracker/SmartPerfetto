// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smp knowledge`: register and manage document folders as searchable
 * knowledge bases from the terminal. It uses the same registry, ingester and
 * store as the `/api/rag/knowledge` routes; only the trust differs: the
 * local user's own folder stands in for `SMARTPERFETTO_KNOWLEDGE_ROOTS`, as
 * `smp codebase` trusts a registered source root.
 *
 * Output never carries a registered absolute root. Document text reaches
 * stdout only through `search`, which the owner runs to see it.
 */

import {bootstrap, resolveInvocationPath} from '../bootstrap';
import {writeCliInputError, writeCliOperationError} from '../io/operationErrors';
import {withConsoleLogToStderr} from '../io/stdio';
import {resolveCodebaseScope} from '../../services/codebase/codebaseRegistry';
import {
  getDefaultExternalKnowledgeSourceRegistry,
  projectKnowledgeSourceForManagement,
} from '../../services/externalKnowledgeSourceRegistry';
import {createDocumentCollectionGate} from '../../services/knowledge/documentCollectionCorpus';
import {DocumentCollectionIngester} from '../../services/knowledge/documentCollectionIngester';
import {getDefaultDocumentCollectionStore} from '../../services/knowledge/documentCollectionStore';
import {removeKnowledgeSource} from '../../services/knowledge/knowledgeSourceRemoval';
import {getDefaultRagStore} from '../../services/ragStore';
import {PublicRequestError, thrownReasonCode} from '../../utils/publicRequestError';

export type KnowledgeOutputFormat = 'text' | 'json';

export interface KnowledgeCommandBaseArgs {
  envFile?: string;
  sessionDir?: string;
  format?: KnowledgeOutputFormat;
}

function prepare(args: KnowledgeCommandBaseArgs) {
  bootstrap({envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false});
  const scope = resolveCodebaseScope();
  const registry = getDefaultExternalKnowledgeSourceRegistry();
  const ingester = (allowlistRoot: string | undefined) => new DocumentCollectionIngester(
    registry, getDefaultDocumentCollectionStore(),
    createDocumentCollectionGate({allowlistRoots: allowlistRoot ? [allowlistRoot] : []}));
  return {scope, registry, ingester};
}

function writeError(format: KnowledgeOutputFormat, error: unknown): number {
  return writeCliOperationError(format === 'json', error instanceof PublicRequestError ? error : undefined,
    {code: 'KNOWLEDGE_OPERATION_FAILED', message: 'Knowledge operation failed', reason: thrownReasonCode(error)});
}

function writeInputError(format: KnowledgeOutputFormat, code: string, message: string): number {
  return writeCliInputError(format === 'json', code, message);
}

async function run(
  format: KnowledgeOutputFormat,
  operation: () => Promise<{json: Record<string, unknown>; text: string[]}>,
): Promise<number> {
  try {
    const output = await withConsoleLogToStderr(true, operation);
    if (format === 'json') console.log(JSON.stringify({success: true, ...output.json}, null, 2));
    else for (const line of output.text) console.log(line);
    return 0;
  } catch (error) {
    return writeError(format, error);
  }
}

function skippedText(skipped: Record<string, number>): string {
  const entries = Object.entries(skipped).filter(([, count]) => count > 0);
  return entries.length > 0 ? entries.map(([reason, count]) => `${reason}=${count}`).join(' ') : 'none';
}

export async function runKnowledgePreviewCommand(args: KnowledgeCommandBaseArgs & {rootPath: string}): Promise<number> {
  const rootPath = resolveInvocationPath(args.rootPath);
  const format = args.format ?? 'text';
  const {ingester} = prepare(args);
  return run(format, async () => {
    const {summary} = await ingester(rootPath).previewIndexable(rootPath);
    return {json: {preview: summary}, text: [
      `documents  ${summary.documentCount}`,
      `skipped    ${skippedText(summary.skipped as Record<string, number>)}`,
    ]};
  });
}

export async function runKnowledgeRegisterCommand(args: KnowledgeCommandBaseArgs & {
  rootPath: string;
  acceptRights?: boolean;
  sendToProvider?: boolean;
  name?: string;
  description?: string;
  attribution?: string;
  license?: string;
}): Promise<number> {
  const format = args.format ?? 'text';
  if (args.acceptRights !== true) {
    return writeInputError(format, 'KNOWLEDGE_SOURCE_RIGHTS_REQUIRED',
      '--accept-rights is required: confirm you may use these documents.');
  }
  const rootPath = resolveInvocationPath(args.rootPath);
  const {scope, ingester} = prepare(args);
  return run(format, async () => {
    const {source, preview} = await ingester(rootPath).register({
      rootPath, displayName: args.name, description: args.description, attribution: args.attribution,
      license: args.license, rightsAcknowledged: true, sendToProvider: args.sendToProvider,
      consentedBy: scope.userId, scope,
    });
    return {json: {source: projectKnowledgeSourceForManagement(source), preview: preview.summary}, text: [
      `${source.sourceId}\t${source.displayName}`,
      `provider consent ${source.sendToProvider ? 'enabled' : 'disabled'}; run: smp knowledge reindex ${source.sourceId}`,
    ]};
  });
}

export async function runKnowledgeListCommand(args: KnowledgeCommandBaseArgs): Promise<number> {
  const format = args.format ?? 'text';
  const {scope, registry} = prepare(args);
  return run(format, async () => {
    const sources = registry.list(scope).map(projectKnowledgeSourceForManagement);
    return {json: {sources}, text: sources.length === 0 ? ['(no knowledge sources registered)'] : sources.map(source => [
      source.sourceId,
      source.retired ? `${source.kind} (retired: delete it, re-register the folder)` : source.kind,
      source.displayName,
      `documents=${source.documentCount}`,
      `index=${source.hasActiveIndex ? 'active' : 'none'}`,
      `consent=${source.sendToProvider ? 'enabled' : 'disabled'}`,
    ].join('\t'))};
  });
}

export async function runKnowledgeReindexCommand(args: KnowledgeCommandBaseArgs & {sourceId: string}): Promise<number> {
  const format = args.format ?? 'text';
  const {scope, registry, ingester} = prepare(args);
  return run(format, async () => {
    // The folder this user registered is the only root the reindex trusts.
    const result = await ingester(registry.get(args.sourceId, scope)?.rootRealpath).ingest(args.sourceId, scope);
    return {json: {result}, text: [
      `${result.sourceId}\tgeneration=${result.generation}`,
      `documents=${result.documentCount} sections=${result.sectionCount} chunks=${result.chunkCount}`,
      `skipped ${skippedText(result.skipped as Record<string, number>)}`,
    ]};
  });
}

export async function runKnowledgeRemoveCommand(args: KnowledgeCommandBaseArgs & {
  sourceId: string;
  yes?: boolean;
}): Promise<number> {
  const format = args.format ?? 'text';
  if (args.yes !== true) {
    return writeInputError(format, 'KNOWLEDGE_REMOVE_CONFIRMATION_REQUIRED',
      '--yes is required to delete a knowledge source and every index it has.');
  }
  const {scope, registry, ingester} = prepare(args);
  return run(format, async () => {
    // Any kind, so a record of the retired Wiki connector can be deleted too.
    await removeKnowledgeSource({registry, collections: ingester(undefined), ragStore: getDefaultRagStore()},
      args.sourceId, scope, scope.userId);
    return {json: {sourceId: args.sourceId, deleted: true}, text: [`${args.sourceId}\tdeleted`]};
  });
}

export async function runKnowledgeSearchCommand(args: KnowledgeCommandBaseArgs & {
  sourceId: string;
  query: string;
  topK?: number;
}): Promise<number> {
  const format = args.format ?? 'text';
  const topK = args.topK ?? 5;
  if (!args.query.trim()) return writeInputError(format, 'KNOWLEDGE_REQUEST_INVALID', 'A search query is required.');
  if (!Number.isInteger(topK) || topK < 1) {
    return writeInputError(format, 'KNOWLEDGE_REQUEST_INVALID', '--top-k must be a positive integer.');
  }
  const {scope, ingester} = prepare(args);
  return run(format, async () => {
    const {generation, hits} = ingester(undefined).search(args.sourceId, scope, args.query, topK);
    return {json: {generation, hits}, text: hits.length === 0 ? ['(no hits)'] : hits.flatMap(hit => [
      `kb:${hit.relativePath}#L${hit.startLine}-L${hit.endLine}\t${(hit.headingPath.length > 0 ? hit.headingPath : [hit.title]).join(' › ')}`,
      `  ${hit.snippet.replace(/\s+/g, ' ').trim()}`,
    ])};
  });
}
