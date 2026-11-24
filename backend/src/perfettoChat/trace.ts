// SPDX-License-Identifier: AGPL-3.0-or-later

import {link, lstat, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import type {RequestContext} from '../middleware/auth';
import {getTraceFilePath, readTraceMetadataForContext} from '../services/traceMetadataStore';
import {isTraceTimestamp} from './skillBundle';

export const MAX_TRACE_BYTES = 256 * 1024 * 1024;

export interface TraceAsset {
  id: string;
  path: string;
  identity: string;
}

export interface TraceBounds { start_ns: string; end_ns: string }
export interface Selection {
  traceId: string;
  kind: 'whole_trace' | 'area' | 'event' | 'visible_window';
  startNs?: string;
  endNs?: string;
  trackHints?: {kind: 'track'; label: string}[];
}

async function fileIdentity(file: string): Promise<string> {
  const stats = await lstat(file, {bigint: true});
  if (!stats.isFile() || stats.size === 0n || stats.size > BigInt(MAX_TRACE_BYTES)) {
    throw new Error('TRACE_UNAVAILABLE');
  }
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(':');
}

export async function resolveChatTrace(id: string, context: RequestContext): Promise<TraceAsset> {
  const storedFile = getTraceFilePath(id);
  const file = storedFile && path.resolve(storedFile);
  const metadata = await readTraceMetadataForContext(id, context);
  if (!file || !metadata || metadata.externalRpc ||
      (metadata.path && path.resolve(metadata.path) !== path.resolve(file))) {
    throw new Error('TRACE_UNAVAILABLE');
  }
  return {id, path: file, identity: await fileIdentity(file)};
}

export async function prepareTraceInput(asset: TraceAsset): Promise<{file: string; dispose(): Promise<void>}> {
  const dir = await mkdtemp(path.join(path.dirname(asset.path), '.perfetto-chat-'));
  const file = path.join(dir, 'input.trace');
  const dispose = () => rm(dir, {force: true, recursive: true});
  try {
    // Hard-link the local store's immutable file into a private per-turn directory.
    // The request remains bound to this exact inode even if the public path is replaced.
    await link(asset.path, file);
    if (await fileIdentity(file) !== asset.identity) throw new Error('TRACE_UNAVAILABLE');
    return {file, dispose};
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function parseSelection(input: unknown, traceId?: string): Selection | undefined {
  if (input === undefined) return traceId ? {traceId, kind: 'whole_trace'} : undefined;
  if (!traceId || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_SELECTION');
  const value = input as Record<string, unknown>;
  if (value.traceId !== traceId || Object.keys(value).some(
    key => !['traceId', 'kind', 'startNs', 'endNs', 'trackHints'].includes(key),
  )) throw new Error('INVALID_SELECTION');
  if (value.kind === 'whole_trace') {
    if (Object.keys(value).length !== 2) throw new Error('INVALID_SELECTION');
    return {traceId, kind: value.kind};
  }
  const {kind, startNs, endNs, trackHints} = value;
  if ((kind !== 'area' && kind !== 'event' && kind !== 'visible_window') ||
      typeof startNs !== 'string' || typeof endNs !== 'string' ||
      !isTraceTimestamp(startNs) || !isTraceTimestamp(endNs) ||
      BigInt(startNs) > BigInt(endNs) || (startNs === endNs && kind !== 'event')) {
    throw new Error('INVALID_SELECTION');
  }
  const selection: Selection = {traceId, kind, startNs, endNs};
  if (trackHints !== undefined) {
    if (!Array.isArray(trackHints) || trackHints.length > 4) throw new Error('INVALID_SELECTION');
    selection.trackHints = trackHints.map(item => {
      if (item?.kind !== 'track' || typeof item.label !== 'string' ||
          item.label.length > 160 || Object.keys(item).length !== 2) {
        throw new Error('INVALID_SELECTION');
      }
      return {kind: item.kind, label: item.label};
    });
  }
  return selection;
}

export function selectionWithinBounds(selection: Selection, bounds: TraceBounds): boolean {
  return selection.kind === 'whole_trace' ||
    (BigInt(selection.startNs!) >= BigInt(bounds.start_ns) && BigInt(selection.endNs!) <= BigInt(bounds.end_ns));
}
