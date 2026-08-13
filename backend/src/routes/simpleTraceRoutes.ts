// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { uuidv4 } from '../utils/uuid';
import { resolveFeatureConfig } from '../config';
import { attachRequestContext, requireRequestContext, type RequestContext } from '../middleware/auth';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getPortPool } from '../services/portPool';
import { TraceProcessorFactory, type TraceProcessorRuntimeStats } from '../services/workingTraceProcessor';
import { openEnterpriseDb } from '../services/enterpriseDb';
import {
  recordEnterpriseAuditEvent,
  recordEnterpriseAuditEventForContext,
} from '../services/enterpriseAuditService';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseMode,
  type TraceProcessorLeaseRecord,
  type TraceProcessorLeaseState,
  type TraceProcessorHolderType,
} from '../services/traceProcessorLeaseStore';
import {
  buildTraceProcessorLeaseModeDecision,
  sharedQueueLengthForTrace,
  type TraceProcessorLeaseModeDecision,
} from '../services/traceProcessorLeaseModeDecision';
import {
  evaluateTraceUploadQuota,
  type EnterpriseQuotaDecision,
} from '../services/enterpriseQuotaPolicyService';
import {
  evaluateTenantMutationPolicy,
  sendTenantMutationDeniedPayload,
} from '../services/enterpriseTenantLifecycleService';
import {
  buildTraceOwnerMetadata,
  countTraceMetadataForContext,
  deleteTraceMetadataForContext,
  deleteTraceProcessorLeaseBackingMetadata,
  ensureTraceProcessorLeaseBackingMetadata,
  getTraceFilePath,
  getWritableTraceDirForContext,
  InvalidTraceMetadataCursorError,
  listTraceMetadataForContext,
  listTraceMetadataPageForContext,
  readTraceMetadata,
  readTraceMetadataForContext,
  type TraceMetadata,
  writeTraceMetadata,
} from '../services/traceMetadataStore';
import { isPrivilegedRequestContext, sendResourceNotFound } from '../services/resourceOwnership';
import {
  canDeleteTraceResource,
  canDownloadTraceResource,
  hasRbacPermission,
  sendForbidden,
  sharesWorkspaceWithContext,
} from '../services/rbac';
import { resolveTraceUploadLimitBytes } from '../services/traceUploadLimit';
import {issueTraceProcessorProxyCapability} from '../services/traceProcessorProxyCapability';
import {TraceProcessorAdmissionError} from '../services/traceProcessorRamBudget';
import {
  downloadPublicHttpUrl,
  PublicHttpUrlRejectedError,
  sanitizedPublicHttpUrl,
  type PublicHttpDownloadResponse,
} from '../services/publicHttpDownload';

const router = Router();
const URL_UPLOAD_TIMEOUT_MS = 300000;
const TEMP_UPLOAD_SUFFIX = '.uploading';
const CLEANUP_TERMINAL_LEASE_STATES = new Set<TraceProcessorLeaseState>(['released', 'failed']);
const DELETE_BLOCKING_RUN_STATUSES = new Set(['pending', 'running', 'awaiting_user']);
const DEFAULT_TRACE_LIST_LIMIT = 100;
const MAX_TRACE_LIST_LIMIT = 200;
// 2x covers the in-flight upload plus the .uploading temp file written alongside the final trace.
const DISK_SAFETY_MULTIPLIER = 2;

class TraceUploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Trace file too large. Maximum allowed size is ${maxBytes} bytes`);
    this.name = 'TraceUploadTooLargeError';
  }
}

async function getAvailableDiskBytes(targetPath: string): Promise<number | null> {
  let candidate = targetPath;
  for (let i = 0; i < 8; i++) {
    try {
      const stats = await fs.statfs(candidate);
      return stats.bavail * stats.bsize;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
        continue;
      }
      console.warn(`[Traces] statfs precheck failed (${error?.code ?? 'unknown'}) for ${candidate}; allowing upload to proceed`);
      return null;
    }
  }
  return null;
}

function checkUploadDiskSpace(req: Request, res: Response, next: NextFunction): void {
  const contentLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    next();
    return;
  }

  let tracesDir: string;
  try {
    tracesDir = getWritableTraceDirForContext(requireRequestContext(req));
  } catch {
    next();
    return;
  }

  getAvailableDiskBytes(tracesDir)
    .then((available) => {
      if (available === null) {
        next();
        return;
      }
      const required = contentLength * DISK_SAFETY_MULTIPLIER;
      if (available < required) {
        res.status(507).json({
          error: 'Insufficient disk space',
          details: `Need ${required} bytes (declared ${contentLength}, ${DISK_SAFETY_MULTIPLIER}x safety), only ${available} bytes free on trace volume`,
        });
        return;
      }
      next();
    })
    .catch(() => next());
}

interface FinalizedTraceUploadInfo {
  id?: string;
  filename?: string;
  size?: number;
  uploadTime?: Date;
  status?: string;
  error?: string;
  port?: number;
  leaseId?: string;
  leaseState?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
  processor?: {
    status: string;
  };
}

interface TraceProcessorLeaseAcquisition {
  lease: TraceProcessorLeaseRecord;
  decision: TraceProcessorLeaseModeDecision;
  holderRef: string;
}

function requireTracePermission(permission: 'trace:read' | 'trace:write', details: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, permission)) {
      sendForbidden(res, details);
      return;
    }
    next();
  };
}

function enterpriseLeasesEnabled(): boolean {
  return resolveFeatureConfig().enterprise;
}

function leaseScopeFromContext(context: RequestContext) {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

function markLeaseReadyIfNew(
  lease: TraceProcessorLeaseRecord,
  context: RequestContext,
): TraceProcessorLeaseRecord {
  if (lease.state !== 'pending') return lease;
  const store = getTraceProcessorLeaseStore();
  const scope = leaseScopeFromContext(context);
  const starting = store.markStarting(scope, lease.id);
  return store.markReady(scope, starting.id);
}

function recordLeaseRssFromProcessor(
  lease: TraceProcessorLeaseRecord,
  context: RequestContext,
): TraceProcessorLeaseRecord {
  const processor = TraceProcessorFactory.getStats().processors
    .find(item => item.traceId === lease.traceId && (
      lease.mode === 'isolated'
        ? item.leaseId === lease.id
        : (item.leaseMode ?? 'shared') === 'shared'
    ));
  const rssBytes = processor?.rssBytes
    ?? processor?.peakRssBytes
    ?? processor?.startupRssBytes
    ?? null;
  if (rssBytes === null) return lease;
  return getTraceProcessorLeaseStore().recordRss(leaseScopeFromContext(context), lease.id, rssBytes);
}

function processorQueueLength(processor: TraceProcessorRuntimeStats): number {
  const worker = processor.sqlWorker;
  return worker ? worker.queuedP0 + worker.queuedP1 + worker.queuedP2 : 0;
}

function queueLengthForLease(
  lease: TraceProcessorLeaseRecord,
  processors: TraceProcessorRuntimeStats[],
): number {
  if (lease.mode === 'isolated') {
    return processors
      .filter(processor => processor.traceId === lease.traceId && processor.leaseId === lease.id)
      .reduce((sum, processor) => sum + processorQueueLength(processor), 0);
  }
  return sharedQueueLengthForTrace(lease.traceId, processors);
}

function recordTraceCleanupAudit(
  context: RequestContext,
  action: 'trace_cleanup_blocked' | 'trace_cleanup_completed',
  metadata: Record<string, unknown>,
): void {
  const db = openEnterpriseDb();
  try {
    const actor = db.prepare<unknown[], { id: string }>(`
      SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1
    `).get(context.tenantId, context.userId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      actorUserId: actor?.id,
      action,
      resourceType: 'trace_cleanup',
      resourceId: context.workspaceId,
      metadata,
    });
  } finally {
    db.close();
  }
}

function recordTraceDeleteAudit(
  context: RequestContext,
  traceId: string,
  action: 'trace_delete_blocked',
  metadata: Record<string, unknown>,
): void {
  const db = openEnterpriseDb();
  try {
    const actor = db.prepare<unknown[], { id: string }>(`
      SELECT id FROM users WHERE tenant_id = ? AND id = ? LIMIT 1
    `).get(context.tenantId, context.userId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      actorUserId: actor?.id,
      action,
      resourceType: 'trace',
      resourceId: traceId,
      metadata,
    });
  } finally {
    db.close();
  }
}

function recordTraceAudit(
  context: RequestContext,
  action: 'trace.uploaded' | 'trace.read' | 'trace.deleted',
  traceId: string,
  metadata: Record<string, unknown>,
): void {
  recordEnterpriseAuditEventForContext(context, {
    action,
    resourceType: 'trace',
    resourceId: traceId,
    metadata,
  });
}

function sendTraceQuotaDenied(
  res: Response,
  decision: EnterpriseQuotaDecision,
): Response {
  return res.status(decision.httpStatus).json({
    success: false,
    code: decision.code,
    status: decision.status,
    error: decision.message,
    details: decision.details,
  });
}

function summarizeLeaseBlockers(leases: TraceProcessorLeaseRecord[]): Array<{
  id: string;
  traceId: string;
  state: string;
  holderCount: number;
  holderTypes: string[];
}> {
  return leases.map(lease => ({
    id: lease.id,
    traceId: lease.traceId,
    state: lease.state,
    holderCount: lease.holderCount,
    holderTypes: Array.from(new Set(lease.holders.map(holder => holder.holderType))),
  }));
}

function listActiveTraceRuns(context: RequestContext, traceId: string): Array<{
  runId: string;
  sessionId: string;
  status: string;
}> {
  const db = openEnterpriseDb();
  try {
    return db.prepare<unknown[], { run_id: string; session_id: string; status: string }>(`
      SELECT r.id AS run_id, r.session_id, r.status
      FROM analysis_runs r
      JOIN analysis_sessions s
        ON s.tenant_id = r.tenant_id
       AND s.workspace_id = r.workspace_id
       AND s.id = r.session_id
      WHERE r.tenant_id = ?
        AND r.workspace_id = ?
        AND s.trace_id = ?
      ORDER BY r.started_at ASC, r.id ASC
    `).all(context.tenantId, context.workspaceId, traceId)
      .filter(row => DELETE_BLOCKING_RUN_STATUSES.has(row.status))
      .map(row => ({
        runId: row.run_id,
        sessionId: row.session_id,
        status: row.status,
      }));
  } finally {
    db.close();
  }
}

function blockEnterpriseTraceDeleteIfActive(
  context: RequestContext,
  traceId: string,
): {
  blocked: boolean;
  blockedLeases: ReturnType<typeof summarizeLeaseBlockers>;
  activeRuns: Array<{ runId: string; sessionId: string; status: string }>;
} {
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const activeLeases = store.listLeases(scope, { traceId })
    .filter(lease => !CLEANUP_TERMINAL_LEASE_STATES.has(lease.state) && lease.holderCount > 0);
  const drainedLeases = activeLeases.map(lease =>
    lease.state === 'draining' ? lease : store.beginDraining(scope, lease.id),
  );
  const activeRuns = listActiveTraceRuns(context, traceId);
  const blockedLeases = summarizeLeaseBlockers(drainedLeases);
  const blocked = blockedLeases.length > 0 || activeRuns.length > 0;

  if (blocked) {
    recordTraceDeleteAudit(context, traceId, 'trace_delete_blocked', {
      blockedLeaseCount: blockedLeases.length,
      activeRunCount: activeRuns.length,
      blockedLeases,
      activeRuns,
    });
  }

  return {
    blocked,
    blockedLeases,
    activeRuns,
  };
}

async function cleanupEnterpriseWorkspaceProcessors(context: RequestContext): Promise<{
  blocked: boolean;
  blockedLeases: Array<{
    id: string;
    traceId: string;
    state: string;
    holderCount: number;
    holderTypes: string[];
  }>;
  releasedLeaseIds: string[];
  cleanedProcessors: number;
  traceIds: string[];
}> {
  const scope = leaseScopeFromContext(context);
  const traces = await listTraceMetadataForContext(context);
  const traceIds = traces.map(trace => trace.id);
  const traceIdSet = new Set(traceIds);
  const store = getTraceProcessorLeaseStore();
  const leases = store.listLeases(scope)
    .filter(lease => traceIdSet.has(lease.traceId) && !CLEANUP_TERMINAL_LEASE_STATES.has(lease.state));
  const blockedLeases = summarizeLeaseBlockers(
    leases.filter(lease => lease.holderCount > 0),
  );

  if (blockedLeases.length > 0) {
    recordTraceCleanupAudit(context, 'trace_cleanup_blocked', {
      traceCount: traceIds.length,
      blockedLeaseCount: blockedLeases.length,
      blockedLeases,
    });
    return {
      blocked: true,
      blockedLeases,
      releasedLeaseIds: [],
      cleanedProcessors: 0,
      traceIds,
    };
  }

  const releasedLeaseIds: string[] = [];
  for (const lease of leases) {
    const drained = lease.state === 'draining'
      ? lease
      : store.beginDraining(scope, lease.id);
    const current = store.getLeaseById(scope, drained.id);
    if (current?.state === 'released') {
      releasedLeaseIds.push(current.id);
    }
  }

  const cleanedProcessors = getTraceProcessorService().cleanupProcessorsForTraces(traceIdSet);
  recordTraceCleanupAudit(context, 'trace_cleanup_completed', {
    traceCount: traceIds.length,
    releasedLeaseCount: releasedLeaseIds.length,
    cleanedProcessors,
    traceIds,
  });

  return {
    blocked: false,
    blockedLeases: [],
    releasedLeaseIds,
    cleanedProcessors,
    traceIds,
  };
}

function ownedTraceIdForProcessorKey(processorKey: string, ownedTraceIds: Set<string>): string | null {
  if (ownedTraceIds.has(processorKey)) return processorKey;
  for (const traceId of ownedTraceIds) {
    if (processorKey.startsWith(`${traceId}:lease:`)) return traceId;
  }
  return null;
}

function traceListOptions(req: Request): {limit: number; cursor?: string} {
  const rawLimit = req.query.limit;
  const rawCursor = req.query.cursor;
  if (rawLimit !== undefined && typeof rawLimit !== 'string') {
    throw new RangeError('Trace list limit must be a single integer');
  }
  if (rawCursor !== undefined && typeof rawCursor !== 'string') {
    throw new InvalidTraceMetadataCursorError();
  }
  const limit = rawLimit === undefined ? DEFAULT_TRACE_LIST_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRACE_LIST_LIMIT) {
    throw new RangeError(`Trace list limit must be between 1 and ${MAX_TRACE_LIST_LIMIT}`);
  }
  return {limit, ...(rawCursor ? {cursor: rawCursor} : {})};
}

async function readableTraceIdsForCandidates(
  context: RequestContext,
  candidateTraceIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = Array.from(new Set(candidateTraceIds));
  const resolved = await Promise.all(ids.map(async traceId => ({
    traceId,
    metadata: await readTraceMetadataForContext(traceId, context),
  })));
  return new Set(resolved.filter(item => item.metadata !== null).map(item => item.traceId));
}

function decideLeaseModeForTrace(
  context: RequestContext,
  traceId: string,
  holderType: TraceProcessorHolderType,
  requestedMode?: TraceProcessorLeaseMode,
): TraceProcessorLeaseModeDecision {
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const processorStats = TraceProcessorFactory.getStats();
  return buildTraceProcessorLeaseModeDecision({
    traceId,
    holderType,
    requestedMode,
    leases: store.listLeases(scope, { traceId }),
    processors: processorStats.processors,
    ramBudget: processorStats.ramBudget,
  });
}

function leaseResponseFields(acquisition: TraceProcessorLeaseAcquisition | null | undefined): {
  leaseId?: string;
  leaseState?: string;
  leaseMode?: string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
} {
  if (!acquisition) return {};
  return {
    leaseId: acquisition.lease.id,
    leaseState: acquisition.lease.state,
    leaseMode: acquisition.lease.mode,
    leaseModeReason: acquisition.decision.reason,
    leaseQueueLength: acquisition.decision.signals.sharedQueueLength,
  };
}

function leaseHasCurrentPageHolder(
  lease: TraceProcessorLeaseRecord,
  context: RequestContext,
): boolean {
  const windowId = context.windowId?.trim();
  if (!windowId || !context.userId.trim()) return false;
  return lease.holders.some(holder =>
    holder.holderType === 'frontend_http_rpc'
      && holder.windowId === windowId
      && holder.metadata?.userId === context.userId,
  );
}

function websocketCapabilityResponseFields(
  context: RequestContext,
  leaseId: string | undefined,
): {websocketCapability?: ReturnType<typeof issueTraceProcessorProxyCapability>} {
  return leaseId
    ? {websocketCapability: issueTraceProcessorProxyCapability({context, leaseId})}
    : {};
}

function acquireFrontendTraceLease(
  context: RequestContext,
  traceId: string,
  options: {
    sessionId?: string;
    requestedMode?: TraceProcessorLeaseMode;
    deferReady?: boolean;
  } = {},
): TraceProcessorLeaseAcquisition | null {
  if (!enterpriseLeasesEnabled() && options.requestedMode !== 'isolated') {
    return null;
  }
  const holderRef =
    context.windowId ||
    options.sessionId ||
    context.requestId ||
    context.userId;
  const decision = decideLeaseModeForTrace(
    context,
    traceId,
    'frontend_http_rpc',
    options.requestedMode,
  );
  const lease = getTraceProcessorLeaseStore().acquireHolder(
    leaseScopeFromContext(context),
    traceId,
    {
      holderType: 'frontend_http_rpc',
      holderRef,
      windowId: context.windowId,
      sessionId: options.sessionId,
      metadata: {
        requestId: context.requestId,
        userId: context.userId,
        leaseModeReason: decision.reason,
        leaseModeSignals: decision.signals,
      },
    },
    { mode: decision.mode },
  );
  const readyLease = options.deferReady
    ? lease
    : recordLeaseRssFromProcessor(markLeaseReadyIfNew(lease, context), context);
  return {
    lease: readyLease,
    decision,
    holderRef,
  };
}

function acquireManualRegisterLease(
  context: RequestContext,
  traceId: string,
  port: number,
): TraceProcessorLeaseAcquisition | null {
  if (!enterpriseLeasesEnabled()) return null;
  const decision = decideLeaseModeForTrace(context, traceId, 'manual_register');
  const lease = getTraceProcessorLeaseStore().acquireHolder(
    leaseScopeFromContext(context),
    traceId,
    {
      holderType: 'manual_register',
      holderRef: `port:${port}`,
      metadata: {
        port,
        requestId: context.requestId,
        leaseModeReason: decision.reason,
        leaseModeSignals: decision.signals,
      },
    },
    { mode: decision.mode },
  );
  return {
    lease: recordLeaseRssFromProcessor(markLeaseReadyIfNew(lease, context), context),
    decision,
    holderRef: `port:${port}`,
  };
}

async function finalizeTraceUpload(
  traceId: string,
  filename: string,
  size: number,
  finalPath: string,
  context: RequestContext,
  uploadSource: 'local' | 'url',
): Promise<FinalizedTraceUploadInfo | undefined> {
  const tps = getTraceProcessorService();

  if (tps) {
    await tps.initializeUploadWithId(traceId, filename, size, finalPath);
    console.log(`[TraceProcessor] Initialized upload with traceId: ${traceId}`);
  }

  const metadata = {
    id: traceId,
    filename,
    size,
    uploadedAt: new Date().toISOString(),
    status: 'ready',
    path: finalPath,
    ...buildTraceOwnerMetadata(context),
  };
  await writeTraceMetadata(metadata);
  console.log(`[TraceProcessor] Created metadata for trace: ${traceId}`);
  recordTraceAudit(context, 'trace.uploaded', traceId, {
    filename,
    size,
    uploadSource,
  });

  if (tps) {
    let processorError: string | undefined;
    try {
      await tps.completeUpload(traceId);
    } catch (tpError: any) {
      processorError = tpError.message;
      console.error(`[TraceProcessor] Failed to load trace ${traceId}:`, tpError.message);
    }

    const traceWithPort = tps.getTraceWithPort(traceId);
    if (processorError || traceWithPort?.status === 'error') {
      return {
        id: traceId,
        filename,
        size,
        ...(traceWithPort ?? {}),
        status: 'error',
        error: traceWithPort?.error ?? processorError ?? 'trace_processor_shell failed to start',
      };
    }

    console.log(`[TraceProcessor] Loaded trace ${traceId}`);
    const acquisition = acquireFrontendTraceLease(context, traceId);
    return acquisition ? { ...(traceWithPort ?? {}), ...leaseResponseFields(acquisition) } : traceWithPort;
  }

  return undefined;
}

function getFilenameFromUrl(rawUrl: string, fallback = 'trace.perfetto'): string {
  try {
    const url = new URL(rawUrl);
    const name = path.basename(url.pathname);
    return name || fallback;
  } catch {
    return fallback;
  }
}

function tempUploadFilename(): string {
  return `${uuidv4()}${TEMP_UPLOAD_SUFFIX}`;
}

function traceUploadHasRpcTarget(traceInfo: FinalizedTraceUploadInfo | undefined): boolean {
  if (traceInfo?.status === 'error') return false;
  return Boolean(traceInfo?.port || traceInfo?.leaseId);
}

function traceProcessorUnavailableMessage(traceInfo: FinalizedTraceUploadInfo | undefined): string {
  if (traceInfo?.error) {
    return `Trace uploaded, but trace_processor_shell failed to start: ${traceInfo.error}`;
  }

  const status = traceInfo?.processor?.status ?? traceInfo?.status;
  return status
    ? `Trace uploaded, but trace_processor_shell did not become ready (status: ${status})`
    : 'Trace uploaded, but backend did not return an HTTP RPC port or lease';
}

function sendTraceProcessorUnavailable(res: Response, traceInfo: FinalizedTraceUploadInfo | undefined): void {
  res.json({
    success: false,
    error: traceProcessorUnavailableMessage(traceInfo),
    trace: traceInfo,
  });
}

async function cleanupFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}

async function renameTraceAtomically(tempPath: string, finalPath: string): Promise<void> {
  await fs.rename(tempPath, finalPath);
}

function createUploadSizeLimitStream(maxBytes: number): { stream: Transform; getBytesWritten: () => number } {
  let bytesWritten = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.length
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : Buffer.byteLength(String(chunk));
      bytesWritten += bytes;
      if (bytesWritten > maxBytes) {
        callback(new TraceUploadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });

  return {
    stream,
    getBytesWritten: () => bytesWritten,
  };
}

async function streamResponseBodyToTempFile(
  response: PublicHttpDownloadResponse,
  tempPath: string,
): Promise<number> {
  if (!response.body) {
    throw new Error('Trace URL response body is empty');
  }

  const limiter = createUploadSizeLimitStream(resolveTraceUploadLimitBytes());
  try {
    await pipeline(
      response.body,
      limiter.stream,
      createWriteStream(tempPath, { flags: 'wx' }),
    );
    return limiter.getBytesWritten();
  } catch (error) {
    await cleanupFile(tempPath);
    throw error;
  }
}

// GET /api/traces/health - Health check for auto-upload feature
// This endpoint allows the frontend to quickly check if the backend is available
router.get('/health', (req, res) => {
  res.json({
    available: true,
    version: '1.0',
    timestamp: new Date().toISOString(),
  });
});

router.use(attachRequestContext);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let tracesDir: string;
    try {
      tracesDir = getWritableTraceDirForContext(requireRequestContext(req));
    } catch (error) {
      cb(error as Error, process.env.UPLOAD_DIR || './uploads');
      return;
    }

    fs.mkdir(tracesDir, { recursive: true })
      .then(() => cb(null, tracesDir))
      .catch((error) => cb(error, tracesDir));
  },
  filename: (req, file, cb) => {
    cb(null, tempUploadFilename());
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: resolveTraceUploadLimitBytes(),
  },
});

// POST /api/traces/upload - Simple upload with RequestContext ownership
router.post(
  '/upload',
  requireTracePermission('trace:write', 'Uploading traces requires trace:write permission'),
  checkUploadDiskSpace,
  upload.single('file'),
  async (req, res) => {
    try {
      const context = requireRequestContext(req);
      if (!req.file) {
        return res.status(400).json({
          error: 'No file uploaded'
        });
      }

      const file = req.file;
      const tenantDecision = evaluateTenantMutationPolicy(context);
      if (!tenantDecision.allowed) {
        await cleanupFile(file.path);
        return res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
      }
      const quotaDecision = evaluateTraceUploadQuota(context, file.size);
      if (!quotaDecision.allowed) {
        await cleanupFile(file.path);
        return sendTraceQuotaDenied(res, quotaDecision);
      }

      // Generate trace ID upfront for consistency
      const traceId = uuidv4();

      // Move file to traces directory with proper name
      const tracesDir = path.dirname(file.path);
      const finalPath = path.join(tracesDir, `${traceId}.trace`);
      await renameTraceAtomically(file.path, finalPath);

      console.log(`File uploaded successfully: ${file.originalname} -> ${traceId}`);

      // Get trace status and processor port from service
      const traceInfo = await finalizeTraceUpload(traceId, file.originalname, file.size, finalPath, context, 'local');
      if (!traceUploadHasRpcTarget(traceInfo)) {
        sendTraceProcessorUnavailable(res, traceInfo);
        return;
      }

      res.json({
        success: true,
        trace: {
          id: traceId,
          filename: file.originalname,
          size: file.size,
          uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
          status: traceInfo?.status || 'ready',
          // Port for HTTP RPC mode - frontend can connect to trace_processor directly
          port: traceInfo?.port,
          leaseId: traceInfo?.leaseId,
          leaseState: traceInfo?.leaseState,
          leaseMode: traceInfo?.leaseMode,
          leaseModeReason: traceInfo?.leaseModeReason,
          leaseQueueLength: traceInfo?.leaseQueueLength,
          ...websocketCapabilityResponseFields(context, traceInfo?.leaseId),
          processorStatus: traceInfo?.processor?.status,
        }
      });

    } catch (error: any) {
      await cleanupFile(req.file?.path);
      console.error('Upload error:', error);
      res.status(500).json({
        error: 'Upload failed',
        details: error.message
      });
    }
  },
);

// POST /api/traces/upload-url - Fetch a remote trace from the backend side.
router.post('/upload-url', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:write')) {
      return sendForbidden(res, 'Uploading traces requires trace:write permission');
    }
    const tenantDecision = evaluateTenantMutationPolicy(context);
    if (!tenantDecision.allowed) {
      return res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
    }
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!rawUrl) {
      return res.status(400).json({
        error: 'No URL provided'
      });
    }

    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return res.status(400).json({
        error: 'Only http and https trace URLs are supported'
      });
    }
    const filename = typeof req.body?.filename === 'string' && req.body.filename.trim()
      ? path.basename(req.body.filename.trim())
      : getFilenameFromUrl(rawUrl);

    console.log(`Fetching URL trace: ${sanitizedPublicHttpUrl(url)}`);
    const response = await downloadPublicHttpUrl(url, URL_UPLOAD_TIMEOUT_MS);
    if (response.status < 200 || response.status >= 300) {
      response.body.destroy();
      return res.status(502).json({
        error: 'Failed to fetch trace URL',
        details: `${response.status} ${response.statusText}`,
      });
    }

    const contentLength = response.headers.get('content-length');
    const uploadLimitBytes = resolveTraceUploadLimitBytes();
    const contentLengthBytes = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
    if (Number.isFinite(contentLengthBytes) && contentLengthBytes > uploadLimitBytes) {
      response.body.destroy();
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${uploadLimitBytes} bytes`
      });
    }
    if (Number.isFinite(contentLengthBytes)) {
      const quotaDecision = evaluateTraceUploadQuota(context, contentLengthBytes);
      if (!quotaDecision.allowed) {
        response.body.destroy();
        return sendTraceQuotaDenied(res, quotaDecision);
      }
    }

    const tracesDir = getWritableTraceDirForContext(context);
    await fs.mkdir(tracesDir, { recursive: true });

    const traceId = uuidv4();
    const tempPath = path.join(tracesDir, tempUploadFilename());
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    let size = 0;
    try {
      size = await streamResponseBodyToTempFile(response, tempPath);
      const quotaDecision = evaluateTraceUploadQuota(context, size);
      if (!quotaDecision.allowed) {
        await cleanupFile(tempPath);
        return sendTraceQuotaDenied(res, quotaDecision);
      }
      await renameTraceAtomically(tempPath, finalPath);
    } catch (streamError) {
      await cleanupFile(tempPath);
      throw streamError;
    }

    console.log(`URL trace fetched successfully: ${sanitizedPublicHttpUrl(response.finalUrl)} -> ${traceId}`);

    const traceInfo = await finalizeTraceUpload(traceId, filename, size, finalPath, context, 'url');
    if (!traceUploadHasRpcTarget(traceInfo)) {
      sendTraceProcessorUnavailable(res, traceInfo);
      return;
    }

    res.json({
      success: true,
      trace: {
        id: traceId,
        filename,
        size,
        uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
        status: traceInfo?.status || 'ready',
        port: traceInfo?.port,
        leaseId: traceInfo?.leaseId,
        leaseState: traceInfo?.leaseState,
        leaseMode: traceInfo?.leaseMode,
        leaseModeReason: traceInfo?.leaseModeReason,
        leaseQueueLength: traceInfo?.leaseQueueLength,
        ...websocketCapabilityResponseFields(context, traceInfo?.leaseId),
        processorStatus: traceInfo?.processor?.status,
      }
    });

  } catch (error: any) {
    if (error instanceof PublicHttpUrlRejectedError) {
      return res.status(400).json({
        error: 'Local and private trace URLs are not supported',
        details: error.message,
      });
    }
    if (error instanceof TraceUploadTooLargeError) {
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${error.maxBytes} bytes`,
      });
    }
    console.error('URL upload error:', error);
    res.status(500).json({
      error: 'URL upload failed',
      details: error.message
    });
  }
});

// GET /api/traces - List all traces
router.get('/', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:read')) {
      return sendForbidden(res, 'Listing traces requires trace:read permission');
    }
    const page = await listTraceMetadataPageForContext(context, traceListOptions(req));
    res.json(page);
  } catch (error: any) {
    if (error instanceof InvalidTraceMetadataCursorError || error instanceof RangeError) {
      return res.status(400).json({
        error: error.message,
        code: 'INVALID_TRACE_LIST_PAGE',
      });
    }
    console.error('List traces error:', error);
    res.status(500).json({
      error: 'Failed to list traces',
      details: error.message
    });
  }
});

// GET /api/traces/stats - Get resource usage statistics
// IMPORTANT: Must be before /:id to avoid matching "stats" as an id
router.get('/stats', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:read')) {
      return sendForbidden(res, 'Trace stats require trace:read permission');
    }
    const portPoolStats = getPortPool().getStats();
    const processorStats = TraceProcessorFactory.getStats();
    const traceService = getTraceProcessorService();
    const serviceTraces = traceService.getAllTraces();
    const leases = enterpriseLeasesEnabled()
      ? getTraceProcessorLeaseStore().listLeases(leaseScopeFromContext(context))
      : [];
    const candidateTraceIds = new Set<string>([
      ...serviceTraces.map(trace => trace.id),
      ...processorStats.processors.map(processor => processor.traceId),
      ...leases.map(lease => lease.traceId),
      ...portPoolStats.allocations.map(allocation => allocation.traceId.split(':lease:', 1)[0]),
    ]);
    const ownedTraceIds = await readableTraceIdsForCandidates(context, candidateTraceIds);
    const traceMetadataCount = await countTraceMetadataForContext(context);
    const traces = serviceTraces.filter(t => ownedTraceIds.has(t.id));
    const allocations = portPoolStats.allocations
      .map(allocation => ({
        ...allocation,
        ownerTraceId: ownedTraceIdForProcessorKey(allocation.traceId, ownedTraceIds),
      }))
      .filter(allocation => allocation.ownerTraceId !== null);
    const processors = processorStats.processors.filter(processor => ownedTraceIds.has(processor.traceId));
    const queueLength = processors.reduce((sum, processor) => {
      const worker = processor.sqlWorker;
      return sum + (worker ? worker.queuedP0 + worker.queuedP1 + worker.queuedP2 : 0);
    }, 0);
    const ownedLeases = leases.filter(lease => ownedTraceIds.has(lease.traceId));
    const activeLeases = ownedLeases.filter(lease => lease.state !== 'released' && lease.state !== 'failed');

    res.json({
      success: true,
      stats: {
        ramBudget: processorStats.ramBudget,
        portPool: {
          total: portPoolStats.total,
          available: portPoolStats.available,
          allocated: allocations.length,
          allocations: allocations.map(a => ({
            port: a.port,
            traceId: a.ownerTraceId,
            processorKey: a.traceId,
            allocatedAt: a.allocatedAt,
          })),
        },
        processors: {
          count: processors.length,
          traceIds: processors.map(processor => processor.traceId),
          queueLength,
          items: processors,
        },
        leases: {
          count: ownedLeases.length,
          activeCount: activeLeases.length,
          crashCount: ownedLeases.filter(lease => lease.state === 'crashed').length,
          holderCount: ownedLeases.reduce((sum, lease) => sum + lease.holderCount, 0),
          items: ownedLeases.map(lease => ({
            id: lease.id,
            traceId: lease.traceId,
            mode: lease.mode,
            state: lease.state,
            rssBytes: lease.rssBytes,
            queueLength: queueLengthForLease(lease, processors),
            holderCount: lease.holderCount,
            holders: lease.holders.map(holder => ({
              holderType: holder.holderType,
              holderRef: holder.holderRef,
              windowId: holder.windowId,
              heartbeatAt: holder.heartbeatAt,
              expiresAt: holder.expiresAt,
            })),
          })),
        },
        traces: {
          count: traces.length,
          metadataCount: traceMetadataCount,
          items: traces.map(t => ({
            id: t.id,
            filename: t.filename,
            status: t.status,
            uploadTime: t.uploadTime,
          })),
        },
      },
    });
  } catch (error: any) {
    console.error('[Traces] Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/cleanup - Cleanup all resources
// IMPORTANT: Must be before /:id to avoid matching "cleanup" as an id
router.post('/cleanup', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const isEnterprise = enterpriseLeasesEnabled();
    const canAdminCleanup = isEnterprise
      ? hasRbacPermission(context, 'trace:delete_any')
      : isPrivilegedRequestContext(context);
    if (!canAdminCleanup) {
      return sendResourceNotFound(res);
    }

    if (isEnterprise) {
      const result = await cleanupEnterpriseWorkspaceProcessors(context);
      if (result.blocked) {
        return res.status(409).json({
          success: false,
          error: 'Trace cleanup blocked by active trace processor leases',
          blockedLeases: result.blockedLeases,
        });
      }

      return res.json({
        success: true,
        message: `Enterprise cleanup complete. Released ${result.releasedLeaseIds.length} lease(s) and cleaned ${result.cleanedProcessors} processor(s).`,
        releasedLeaseIds: result.releasedLeaseIds,
        cleanedProcessors: result.cleanedProcessors,
        traceCount: result.traceIds.length,
      });
    }

    console.log('[Traces] Starting full cleanup...');

    // Cleanup all trace processors
    TraceProcessorFactory.cleanup();

    // Cleanup stale port allocations
    const portPool = getPortPool();
    const staleCount = portPool.cleanupStale(0); // Cleanup all

    console.log(`[Traces] Cleanup complete. Released ${staleCount} stale allocations.`);

    res.json({
      success: true,
      message: `Cleanup complete. Released ${staleCount} port allocations.`,
      stats: portPool.getStats(),
    });
  } catch (error: any) {
    console.error('[Traces] Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/register-rpc - Register an existing HTTP RPC connection
// This is used when frontend is already connected to a trace_processor via HTTP RPC
// and wants to enable AI analysis without re-uploading the trace
router.post('/register-rpc', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'trace:write')) {
      return sendForbidden(res, 'Registering traces requires trace:write permission');
    }
    if (enterpriseLeasesEnabled()) {
      return res.status(410).json({
        success: false,
        error: 'Direct RPC registration is disabled in enterprise mode; use backend lease proxy targets.',
      });
    }
    const { port, traceName } = req.body;

    if (!port) {
      return res.status(400).json({
        success: false,
        error: 'Port is required',
      });
    }

    console.log(`[Traces] Registering external RPC connection on port ${port}, name: ${traceName || 'External Trace'}`);

    // Generate a trace ID for this external connection
    const traceId = `external-rpc-${port}-${Date.now()}`;

    // Get the trace processor service
    const tps = getTraceProcessorService();

    if (tps) {
      // Register the external RPC connection
      await tps.registerExternalRpc(traceId, port, traceName || 'External RPC Trace');
      console.log(`[Traces] Registered external RPC as traceId: ${traceId}`);
    }

    await writeTraceMetadata({
      id: traceId,
      filename: traceName || 'External RPC Trace',
      size: 0,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      externalRpc: true,
      port,
      ...buildTraceOwnerMetadata(context),
    });

    const lease = acquireManualRegisterLease(context, traceId, Number(port));

    res.json({
      success: true,
      traceId,
      port,
      ...leaseResponseFields(lease),
      message: `External RPC connection registered successfully`,
    });

  } catch (error: any) {
    console.error('[Traces] Register RPC error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/traces/:id/viewer - Create an isolated processor for one UI.
router.post(
  '/:id/viewer',
  requireTracePermission('trace:read', 'Opening a trace viewer requires trace:read permission'),
  async (req, res) => {
    const context = requireRequestContext(req);
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const sessionId = typeof req.body?.sessionId === 'string'
      ? req.body.sessionId.trim() || undefined
      : undefined;
    let acquisition: TraceProcessorLeaseAcquisition | null = null;
    try {
      const metadata = await readTraceMetadataForContext(id, context);
      if (!metadata) {
        return res.status(404).json({error: 'Trace not found', id});
      }
      if (metadata.externalRpc) {
        return res.status(409).json({
          error: 'External RPC traces cannot create isolated viewer processors',
          id,
        });
      }

      const tracePath = metadata.path || getTraceFilePath(id);
      if (!tracePath) {
        return res.status(404).json({error: 'Trace file not found', id});
      }
      await fs.access(tracePath);

      const tps = getTraceProcessorService();
      tps.registerStoredTrace({
        id,
        filename: metadata.filename,
        size: metadata.size,
        filePath: tracePath,
        uploadedAt: metadata.uploadedAt,
      });
      if (!enterpriseLeasesEnabled()) {
        ensureTraceProcessorLeaseBackingMetadata(
          metadata,
          leaseScopeFromContext(context),
        );
      }
      acquisition = acquireFrontendTraceLease(context, id, {
        sessionId,
        requestedMode: 'isolated',
        deferReady: true,
      });
      if (!acquisition) {
        throw new Error('Failed to acquire isolated viewer lease');
      }

      const store = getTraceProcessorLeaseStore();
      const scope = leaseScopeFromContext(context);
      let lease = acquisition.lease;
      if (lease.state === 'pending') {
        lease = store.markStarting(scope, lease.id);
      }
      await tps.ensureProcessorForLease(id, lease.id, lease.mode, scope);
      if (lease.state === 'starting') {
        lease = store.markReady(scope, lease.id);
      }
      lease = recordLeaseRssFromProcessor(lease, context);
      acquisition = {...acquisition, lease};

      const traceInfo = tps.getTraceWithLeasePort(id, lease.id, lease.mode);
      if (!traceInfo?.port) {
        throw new Error('Isolated trace processor did not become ready');
      }
      recordTraceAudit(context, 'trace.read', id, {
        filename: metadata.filename,
        size: metadata.size,
        viewerMode: 'isolated',
      });
      return res.json({
        success: true,
        trace: {
          ...metadata,
          processorStatus: traceInfo.status,
          hasProcessor: true,
          port: traceInfo.port,
          ...leaseResponseFields(acquisition),
          ...websocketCapabilityResponseFields(context, lease.id),
        },
      });
    } catch (error: any) {
      if (acquisition) {
        const store = getTraceProcessorLeaseStore();
        const scope = leaseScopeFromContext(context);
        try {
          store.releaseHolder(
            scope,
            acquisition.lease.id,
            'frontend_http_rpc',
            acquisition.holderRef,
          );
        } catch {
          // Best-effort holder cleanup.
        }
        try {
          store.markFailed(scope, acquisition.lease.id);
        } catch {
          // The lease may already be terminal.
        }
        getTraceProcessorService().cleanupLeaseProcessor(
          id,
          acquisition.lease.id,
          acquisition.lease.mode,
        );
      }
      console.error('[Traces] Open isolated viewer error:', error);
      if (error instanceof TraceProcessorAdmissionError) {
        return res.status(503).json({
          success: false,
          code: 'TRACE_PROCESSOR_RAM_BUDGET_EXCEEDED',
          error: 'Not enough available memory to open another trace viewer',
          details: error.message,
        });
      }
      if (error?.code === 'ENOENT') {
        return res.status(404).json({error: 'Trace file not found', id});
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to open isolated trace viewer',
        details: error.message,
      });
    }
  },
);

router.get(
  '/leases/:leaseId/connection',
  requireTracePermission('trace:read', 'Reading trace connection status requires trace:read permission'),
  async (req, res) => {
    const context = requireRequestContext(req);
    const leaseId = Array.isArray(req.params.leaseId)
      ? req.params.leaseId[0]
      : req.params.leaseId;
    const lease = getTraceProcessorLeaseStore().getLeaseById(
      leaseScopeFromContext(context),
      leaseId,
    );
    if (!lease || !leaseHasCurrentPageHolder(lease, context)) {
      return res.json({success: true, leaseId, status: 'lease_expired'});
    }

    const metadata = await readTraceMetadataForContext(lease.traceId, context);
    if (!metadata) {
      return res.json({
        success: true,
        leaseId: lease.id,
        traceId: lease.traceId,
        status: 'trace_deleted',
      });
    }

    if (lease.state === 'pending' || lease.state === 'starting' || lease.state === 'restarting') {
      return res.json({
        success: true,
        leaseId: lease.id,
        traceId: lease.traceId,
        status: 'preparing',
      });
    }

    if (
      lease.state === 'draining'
      || lease.state === 'released'
      || lease.state === 'failed'
      || !['ready', 'idle', 'active', 'crashed'].includes(lease.state)
    ) {
      return res.json({success: true, leaseId: lease.id, status: 'lease_expired'});
    }

    if (lease.state === 'crashed') {
      return res.json({
        success: true,
        leaseId: lease.id,
        traceId: lease.traceId,
        status: 'backend_unavailable',
      });
    }

    const processor = getTraceProcessorService().getLeaseProcessorSnapshot(
      lease.traceId,
      lease.id,
      lease.mode,
    );
    const usableProcessor = Boolean(
      processor
      && (processor.status === 'ready' || processor.status === 'busy')
      && processor.port,
    );
    return res.json({
      success: true,
      leaseId: lease.id,
      traceId: lease.traceId,
      status: usableProcessor ? 'ready' : 'backend_unavailable',
    });
  },
);

// GET /api/traces/:id - Get a single trace info (for verifying trace exists)
router.get('/:id', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadataForContext(id, context);

    if (!metadata) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }

    // Also check TraceProcessorService for processor status
    const tps = getTraceProcessorService();
    const traceInfo = tps?.getTraceWithPort(id);

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const lease = traceInfo?.port
      ? acquireFrontendTraceLease(context, id, {sessionId})
      : null;
    recordTraceAudit(context, 'trace.read', id, {
      filename: metadata.filename,
      size: metadata.size,
      hasProcessor: Boolean(traceInfo?.processor),
    });

    res.json({
      success: true,
      trace: {
        ...metadata,
        processorStatus: traceInfo?.status || 'unknown',
        hasProcessor: !!traceInfo?.processor,
        port: traceInfo?.port ?? metadata.port,
        ...leaseResponseFields(lease),
        ...websocketCapabilityResponseFields(context, lease?.lease.id),
      }
    });
  } catch (error: any) {
    console.error('[Traces] Get trace error:', error);
    res.status(500).json({
      error: 'Failed to get trace',
      details: error.message
    });
  }
});

// DELETE /api/traces/:id - Delete a trace and cleanup all resources
router.delete('/:id', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadata(id);
    if (!metadata) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
    if (!sharesWorkspaceWithContext(metadata, context)) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
    if (!canDeleteTraceResource(metadata, context)) {
      return sendForbidden(res, 'Deleting this trace requires trace delete permission');
    }
    if (enterpriseLeasesEnabled()) {
      const blockers = blockEnterpriseTraceDeleteIfActive(context, id);
      if (blockers.blocked) {
        return res.status(409).json({
          success: false,
          error: 'Trace delete blocked by active analysis runs or trace processor leases',
          blockedLeases: blockers.blockedLeases,
          activeRuns: blockers.activeRuns,
        });
      }
    }
    console.log(`[Traces] Deleting trace ${id} and cleaning up resources...`);

    // First, cleanup the trace processor (this will release the port)
    try {
      const traceService = getTraceProcessorService();
      await traceService.deleteTrace(id);
      console.log(`[Traces] Trace processor cleaned up for ${id}`);
    } catch (error: any) {
      console.log(`[Traces] Trace processor cleanup skipped: ${error.message}`);
    }

    // Delete trace file
    const tracePath = metadata.path || getTraceFilePath(id);
    try {
      if (tracePath) {
        await fs.unlink(tracePath);
        console.log(`[Traces] Trace file deleted: ${tracePath}`);
      }
    } catch (error) {
      // File might not exist, continue
    }

    await deleteTraceMetadataForContext(id, context);
    if (!enterpriseLeasesEnabled()) {
      deleteTraceProcessorLeaseBackingMetadata(
        id,
        leaseScopeFromContext(context),
      );
    }
    console.log(`[Traces] Metadata deleted for ${id}`);
    recordTraceAudit(context, 'trace.deleted', id, {
      filename: metadata.filename,
      size: metadata.size,
    });

    console.log(`[Traces] Trace ${id} fully deleted`);
    res.json({ success: true, message: 'Trace deleted successfully' });

  } catch (error: any) {
    console.error('[Traces] Delete trace error:', error);
    res.status(500).json({
      error: 'Failed to delete trace',
      details: error.message
    });
  }
});

// GET /api/traces/:id/file - Download trace file
router.get('/:id/file', async (req, res) => {
  try {
    const context = requireRequestContext(req);
    const { id } = req.params;
    const metadata = await readTraceMetadataForContext(id, context);
    if (!metadata) {
      return res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }
    if (!canDownloadTraceResource(metadata, context)) {
      return sendForbidden(res, 'Downloading traces requires trace download permission');
    }
    const tracePath = metadata.path || getTraceFilePath(id);
    if (!tracePath) {
      return res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }

    try {
      await fs.access(tracePath);
      res.sendFile(path.resolve(tracePath));
    } catch (error) {
      res.status(404).json({
        error: 'Trace file not found',
        id
      });
    }
  } catch (error: any) {
    console.error('Download trace error:', error);
    res.status(500).json({
      error: 'Failed to download trace',
      details: error.message
    });
  }
});

export default router;
