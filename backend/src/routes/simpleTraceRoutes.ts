// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { attachRequestContext, requireRequestContext, type RequestContext } from '../middleware/auth';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { getPortPool } from '../services/portPool';
import { TraceProcessorFactory } from '../services/workingTraceProcessor';
import {
  buildTraceOwnerMetadata,
  getTraceFilePath,
  getTracesDir,
  listTraceMetadata,
  readTraceMetadataForContext,
  type TraceMetadata,
  writeTraceMetadata,
} from '../services/traceMetadataStore';
import { isPrivilegedRequestContext, sendResourceNotFound } from '../services/resourceOwnership';

const router = Router();
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const URL_UPLOAD_TIMEOUT_MS = 300000;

async function finalizeTraceUpload(
  traceId: string,
  filename: string,
  size: number,
  finalPath: string,
  context: RequestContext,
) {
  const tps = getTraceProcessorService();

  if (tps) {
    await tps.initializeUploadWithId(traceId, filename, size);
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

  if (tps) {
    try {
      await tps.completeUpload(traceId);
      console.log(`[TraceProcessor] Loaded trace ${traceId}`);
    } catch (tpError: any) {
      console.error(`[TraceProcessor] Failed to load trace ${traceId}:`, tpError.message);
    }
  }

  return tps?.getTraceWithPort(traceId);
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

function isBlockedTraceUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost') return true;

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split('.').map(part => Number.parseInt(part, 10));
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  } else if (ipVersion === 6) {
    if (hostname === '::1') return true;
    if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) return true;
  }

  return false;
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
    cb(null, process.env.UPLOAD_DIR || './uploads');
  },
  filename: (req, file, cb) => {
    // Keep the original filename
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES, // 500MB
  },
});

// POST /api/traces/upload - Simple upload with RequestContext ownership
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    const file = req.file;

    // Store trace info (in a real app, this would go to a database)
    const tracesDir = getTracesDir();
    await fs.mkdir(tracesDir, { recursive: true });

    // Generate trace ID upfront for consistency
    const traceId = uuidv4();

    // Move file to traces directory with proper name
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    await fs.rename(file.path, finalPath);

    console.log(`File uploaded successfully: ${file.originalname} -> ${traceId}`);

    // Get trace status and processor port from service
    const traceInfo = await finalizeTraceUpload(traceId, file.originalname, file.size, finalPath, context);

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
        processorStatus: traceInfo?.processor?.status,
      }
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Upload failed',
      details: error.message
    });
  }
});

// POST /api/traces/upload-url - Fetch a remote trace from the backend side.
router.post('/upload-url', async (req, res) => {
  try {
    const context = requireRequestContext(req);
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
    if (isBlockedTraceUrl(url)) {
      return res.status(400).json({
        error: 'Local and private trace URLs are not supported'
      });
    }

    const filename = typeof req.body?.filename === 'string' && req.body.filename.trim()
      ? path.basename(req.body.filename.trim())
      : getFilenameFromUrl(rawUrl);

    console.log(`Fetching URL trace: ${rawUrl}`);
    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(URL_UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return res.status(502).json({
        error: 'Failed to fetch trace URL',
        details: `${response.status} ${response.statusText}`
      });
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${MAX_UPLOAD_BYTES} bytes`
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        error: 'Trace file too large',
        details: `Remote trace exceeds ${MAX_UPLOAD_BYTES} bytes`
      });
    }

    const tracesDir = getTracesDir();
    await fs.mkdir(tracesDir, { recursive: true });

    const traceId = uuidv4();
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    await fs.writeFile(finalPath, buffer);

    console.log(`URL trace fetched successfully: ${rawUrl} -> ${traceId}`);

    const traceInfo = await finalizeTraceUpload(traceId, filename, buffer.byteLength, finalPath, context);

    res.json({
      success: true,
      trace: {
        id: traceId,
        filename,
        size: buffer.byteLength,
        uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
        status: traceInfo?.status || 'ready',
        port: traceInfo?.port,
        processorStatus: traceInfo?.processor?.status,
      }
    });

  } catch (error: any) {
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
    const ownedTraces: TraceMetadata[] = [];
    for (const trace of await listTraceMetadata()) {
      const owned = await readTraceMetadataForContext(trace.id, context);
      if (owned) ownedTraces.push(owned);
    }

    // Sort by upload date (newest first)
    ownedTraces.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    res.json({ traces: ownedTraces });
  } catch (error: any) {
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
    const ownedTraceIds = new Set<string>();
    for (const metadata of await listTraceMetadata()) {
      if (await readTraceMetadataForContext(metadata.id, context)) {
        ownedTraceIds.add(metadata.id);
      }
    }
    const portPoolStats = getPortPool().getStats();
    const processorStats = TraceProcessorFactory.getStats();
    const traceService = getTraceProcessorService();
    const traces = traceService.getAllTraces().filter(t => ownedTraceIds.has(t.id));
    const allocations = portPoolStats.allocations.filter(a => ownedTraceIds.has(a.traceId));

    res.json({
      success: true,
      stats: {
        portPool: {
          total: portPoolStats.total,
          available: portPoolStats.available,
          allocated: allocations.length,
          allocations: allocations.map(a => ({
            port: a.port,
            traceId: a.traceId,
            allocatedAt: a.allocatedAt,
          })),
        },
        processors: {
          count: processorStats.traceIds.filter(traceId => ownedTraceIds.has(traceId)).length,
          traceIds: processorStats.traceIds.filter(traceId => ownedTraceIds.has(traceId)),
        },
        traces: {
          count: traces.length,
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
    if (!isPrivilegedRequestContext(context)) {
      return sendResourceNotFound(res);
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

    res.json({
      success: true,
      traceId,
      port,
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

    res.json({
      success: true,
      trace: {
        ...metadata,
        processorStatus: traceInfo?.status || 'unknown',
        hasProcessor: !!traceInfo?.processor,
        port: traceInfo?.port ?? metadata.port,
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
    const metadata = await readTraceMetadataForContext(id, context);
    if (!metadata) {
      return res.status(404).json({
        error: 'Trace not found',
        id
      });
    }
    const tracesDir = getTracesDir();

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
    const tracePath = path.join(tracesDir, `${id}.trace`);
    try {
      await fs.unlink(tracePath);
      console.log(`[Traces] Trace file deleted: ${tracePath}`);
    } catch (error) {
      // File might not exist, continue
    }

    // Delete metadata file
    const infoPath = path.join(tracesDir, `${id}.json`);
    try {
      await fs.unlink(infoPath);
      console.log(`[Traces] Metadata file deleted: ${infoPath}`);
    } catch (error) {
      // File might not exist, continue
    }

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
