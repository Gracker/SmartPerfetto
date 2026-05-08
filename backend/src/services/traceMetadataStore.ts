// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs/promises';
import type { RequestContext } from '../middleware/auth';
import {
  isOwnedByContext,
  ownerFieldsFromContext,
  type ResourceOwnerFields,
} from './resourceOwnership';

export interface TraceMetadata extends ResourceOwnerFields {
  id: string;
  filename: string;
  size: number;
  uploadedAt: string;
  status: string;
  path?: string;
  port?: number;
  externalRpc?: boolean;
}

const SAFE_TRACE_ID_RE = /^[a-zA-Z0-9._:-]+$/;

export function getUploadRoot(): string {
  return process.env.UPLOAD_DIR || './uploads';
}

export function getTracesDir(): string {
  return path.join(getUploadRoot(), 'traces');
}

export function isSafeTraceId(traceId: string): boolean {
  return SAFE_TRACE_ID_RE.test(traceId);
}

export function getTraceMetadataPath(traceId: string): string | null {
  if (!isSafeTraceId(traceId)) return null;
  return path.join(getTracesDir(), `${traceId}.json`);
}

export function getTraceFilePath(traceId: string): string | null {
  if (!isSafeTraceId(traceId)) return null;
  return path.join(getTracesDir(), `${traceId}.trace`);
}

export async function writeTraceMetadata(metadata: TraceMetadata): Promise<void> {
  if (!isSafeTraceId(metadata.id)) {
    throw new Error(`Unsafe trace id: ${metadata.id}`);
  }
  const tracesDir = getTracesDir();
  await fs.mkdir(tracesDir, { recursive: true });
  await fs.writeFile(
    path.join(tracesDir, `${metadata.id}.json`),
    JSON.stringify(metadata, null, 2),
  );
}

export async function readTraceMetadata(traceId: string): Promise<TraceMetadata | null> {
  const metadataPath = getTraceMetadataPath(traceId);
  if (!metadataPath) return null;

  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw) as TraceMetadata;
    if (!parsed || parsed.id !== traceId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function listTraceMetadata(): Promise<TraceMetadata[]> {
  const tracesDir = getTracesDir();
  let files: string[];
  try {
    files = await fs.readdir(tracesDir);
  } catch {
    return [];
  }

  const traces: TraceMetadata[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const traceId = file.slice(0, -'.json'.length);
    const metadata = await readTraceMetadata(traceId);
    if (metadata) traces.push(metadata);
  }
  return traces;
}

export function buildTraceOwnerMetadata(context: RequestContext): ResourceOwnerFields {
  return ownerFieldsFromContext(context);
}

export function isTraceMetadataOwnedByContext(
  metadata: TraceMetadata | null | undefined,
  context: RequestContext,
): metadata is TraceMetadata {
  return Boolean(metadata && isOwnedByContext(metadata, context));
}

export async function readTraceMetadataForContext(
  traceId: string,
  context: RequestContext,
): Promise<TraceMetadata | null> {
  const metadata = await readTraceMetadata(traceId);
  return isTraceMetadataOwnedByContext(metadata, context) ? metadata : null;
}
