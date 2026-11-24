// SPDX-License-Identifier: AGPL-3.0-or-later

import type {NextFunction, Request, RequestHandler, Response} from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import {requireRequestContext} from './auth';
import {getWritableTraceDirForContext} from '../services/traceMetadataStore';
import {resolveTraceUploadLimitBytes} from '../services/traceUploadLimit';
import {getUploadRoot} from '../services/traceUploadPaths';
import {uuidv4} from '../utils/uuid';

const TEMP_UPLOAD_SUFFIX = '.uploading';
// 2x covers the in-flight upload and space for the adjacent temporary file.
const DISK_SAFETY_MULTIPLIER = 2;

/**
 * Multer/Busboy decodes multipart filename parameters as Latin-1 by default,
 * while browsers send the filename bytes as UTF-8. Recover the original name
 * only when the Latin-1 code units form a lossless UTF-8 byte sequence.
 */
export function normalizeUtf8Filename(filename: string): string {
  if ([...filename].some(character => (character.codePointAt(0) ?? 0) > 0xff)) {
    return filename;
  }
  const decoded = Buffer.from(filename, 'latin1').toString('utf8');
  return Buffer.from(decoded, 'utf8').toString('latin1') === filename
    ? decoded
    : filename;
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

export function createUploadDiskSpaceCheck(includePathInErrors: boolean): RequestHandler {
  return (req, res, next) => checkDiskSpace(req, res, next, includePathInErrors);
}

function checkDiskSpace(req: Request, res: Response, next: NextFunction, showPath: boolean): void {
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
        const formatBytes = (bytes: number): string => {
          const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
          let value = bytes;
          let unit = 0;
          while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
          }
          return `${unit === 0 ? value : value.toFixed(2)} ${units[unit]}`;
        };
        res.status(507).json({
          error: 'Insufficient disk space',
          details:
            `Need ${formatBytes(required)} (declared ${formatBytes(contentLength)} x ${DISK_SAFETY_MULTIPLIER} safety), ` +
            `only ${formatBytes(available)} free${showPath ? ` on ${tracesDir}` : ''}`,
        });
        return;
      }
      next();
    })
    .catch(() => next());
}

export function tempUploadFilename(): string {
  return `${uuidv4()}${TEMP_UPLOAD_SUFFIX}`;
}

export async function cleanupUploadFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    let tracesDir: string;
    try {
      tracesDir = getWritableTraceDirForContext(requireRequestContext(req));
    } catch (error) {
      cb(error as Error, getUploadRoot());
      return;
    }

    fs.mkdir(tracesDir, { recursive: true })
      .then(() => cb(null, tracesDir))
      .catch((error) => cb(error, tracesDir));
  },
  filename: (_req, _file, cb) => {
    cb(null, tempUploadFilename());
  },
});

export function createTraceMultipartUpload(limits?: multer.Options['limits']): RequestHandler {
  return multer({storage, limits: {fileSize: resolveTraceUploadLimitBytes(), ...limits}}).single('file');
}
