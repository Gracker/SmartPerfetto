// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RequestHandler} from 'express';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireRequestContext} from '../middleware/auth';
import {
  cleanupUploadFile, createUploadDiskSpaceCheck, createTraceMultipartUpload, normalizeUtf8Filename,
} from '../middleware/traceMultipartUpload';
import {hasRbacPermission} from '../services/rbac';
import {evaluateTenantMutationPolicy} from '../services/enterpriseTenantLifecycleService';
import {evaluateTraceUploadQuota} from '../services/enterpriseQuotaPolicyService';
import {buildTraceOwnerMetadata, getTraceMetadataPath, writeTraceMetadata} from '../services/traceMetadataStore';
import {moveManagedTraceInput} from '../services/capabilityManifestRuntimeIdentity';
import {loadSkillBundle, loadSkillRuntime} from './skillBundle';
import {resolveTraceUploadLimitBytes} from '../services/traceUploadLimit';
import {MAX_TRACE_BYTES, resolveChatTrace} from './trace';

const uploadTraceAssetMultipart = createTraceMultipartUpload({
  fileSize: Math.min(MAX_TRACE_BYTES, resolveTraceUploadLimitBytes()), files: 1, fields: 0,
});

const MAX_REQUESTS = 64;
const TTL = 30 * 60_000;
interface UploadRecord { key: string; expires: number; traceId?: string; committing?: boolean }
const uploadRequests = new Map<string, UploadRecord>();

function releaseUncommitted(record: UploadRecord): void {
  if (!record.traceId && uploadRequests.get(record.key) === record) {
    uploadRequests.delete(record.key);
  }
}

const admission: RequestHandler = async (req, res, next) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'trace:write') || !evaluateTenantMutationPolicy(context).allowed) {
    return res.status(403).json({code: 'TRACE_UPLOAD_FORBIDDEN'});
  }
  if (!await loadSkillRuntime(await loadSkillBundle())) {
    return res.status(503).json({code: 'SKILL_RUNTIME_UNAVAILABLE'});
  }
  const uploadId = req.get('X-Perfetto-Chat-Upload-Id');
  if (!uploadId || !/^[\w-]{1,100}$/.test(uploadId)) {
    return res.status(400).json({code: 'INVALID_TRACE_UPLOAD'});
  }
  const key = JSON.stringify([context.tenantId, context.workspaceId, context.userId, uploadId]);
  for (const [id, entry] of uploadRequests) {
    if (entry.expires <= Date.now()) uploadRequests.delete(id);
  }
  const existing = uploadRequests.get(key);
  if (existing?.traceId) {
    try {
      await resolveChatTrace(existing.traceId, context);
      return res.json({traceId: existing.traceId});
    } catch {
      return res.status(404).json({code: 'TRACE_UNAVAILABLE'});
    }
  }
  if (existing) return res.status(409).json({code: 'TRACE_PREPARING'});
  if (uploadRequests.size >= MAX_REQUESTS) return res.status(429).json({code: 'CAPACITY_EXCEEDED'});
  const entry: UploadRecord = {key, expires: Infinity};
  uploadRequests.set(key, entry);
  res.once('finish', () => releaseUncommitted(entry));
  res.once('close', () => { if (!entry.committing) releaseUncommitted(entry); });
  res.locals.perfettoChatUpload = entry;
  next();
};

const upload: RequestHandler = (req, res, next) => {
  uploadTraceAssetMultipart(req, res, error => {
    if (!error) return next();
    releaseUncommitted(res.locals.perfettoChatUpload);
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      code: error.code === 'LIMIT_FILE_SIZE' ? 'TRACE_TOO_LARGE' : 'INVALID_TRACE_UPLOAD',
    });
  });
};

const commit: RequestHandler = async (req, res) => {
  const context = requireRequestContext(req);
  const entry = res.locals.perfettoChatUpload as UploadRecord;
  entry.committing = true;
  const file = req.file;
  let finalPath: string | undefined;
  let traceId: string | undefined;
  try {
    if (!file || file.size === 0) return res.status(400).json({code: 'INVALID_TRACE_UPLOAD'});
    if (res.destroyed) return;
    const quota = evaluateTraceUploadQuota(context, file.size);
    if (!quota.allowed) return res.status(quota.httpStatus).json({code: quota.code});
    const id = traceId = randomUUID();
    finalPath = path.join(path.dirname(file.path), `${id}.trace`);
    await moveManagedTraceInput({tempPath: file.path, finalPath, traceId: id});
    await writeTraceMetadata({
      id, filename: normalizeUtf8Filename(file.originalname), size: file.size, path: finalPath,
      status: 'ready', uploadedAt: new Date().toISOString(), ...buildTraceOwnerMetadata(context),
    });
    entry.traceId = id;
    return res.status(201).json({traceId: id});
  } catch {
    if (!entry.traceId) {
      await cleanupUploadFile(finalPath);
      if (traceId) await cleanupUploadFile(getTraceMetadataPath(traceId) ?? undefined);
    }
    if (!res.destroyed) return res.status(500).json({code: 'TRACE_UPLOAD_FAILED'});
  } finally {
    try { await cleanupUploadFile(file?.path); }
    finally {
      if (entry.traceId) entry.expires = Date.now() + TTL;
      else releaseUncommitted(entry);
    }
  }
};

export const chatAssetUpload = [admission, createUploadDiskSpaceCheck(false), upload, commit];
