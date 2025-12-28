import { Request, Response } from 'express';
import { TraceProcessorService } from '../services/traceProcessorService';
import multer from 'multer';
import path from 'path';

// Initialize trace processor service
const traceService = new TraceProcessorService();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB limit
  },
});

// Listen for trace events
traceService.on('trace-status-changed', (trace) => {
  console.log(`Trace ${trace.id} status: ${trace.status}`);
});

// Initialize a trace upload
export async function initializeUpload(req: Request, res: Response): Promise<void> {
  try {
    const { filename, size } = req.body;

    if (!filename || !size) {
      res.status(400).json({ error: 'Filename and size are required' });
      return;
    }

    const traceId = await traceService.initializeUpload(filename, parseInt(size));

    res.json({
      traceId,
      uploadUrl: `/api/traces/${traceId}/upload`,
    });
  } catch (error: any) {
    console.error('Failed to initialize upload:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
}

// Upload a complete trace file
export const uploadTrace = upload.single('trace');

export async function handleUpload(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const { filename } = req.body;
    const traceId = await traceService.initializeUpload(
      filename || req.file.originalname,
      req.file.size
    );

    // Write the file
    const fs = require('fs');
    const tracePath = path.join(__dirname, '../../../uploads/traces', `${traceId}.trace`);
    fs.writeFileSync(tracePath, req.file.buffer);

    // Process the trace
    await traceService.completeUpload(traceId);

    const trace = traceService.getTrace(traceId);

    res.json({
      traceId,
      status: trace?.status,
      message: 'Trace uploaded successfully',
    });
  } catch (error: any) {
    console.error('Failed to upload trace:', error);
    res.status(500).json({ error: 'Failed to upload trace' });
  }
}

// Upload chunk for large files
export async function uploadChunk(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    const { offset } = req.headers;

    if (!req.body || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'Invalid chunk data' });
      return;
    }

    await traceService.uploadChunk(
      traceId,
      req.body,
      offset ? parseInt(offset as string) : 0
    );

    res.json({ received: true });
  } catch (error: any) {
    console.error('Failed to upload chunk:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
}

// Complete upload
export async function completeUpload(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    await traceService.completeUpload(traceId);

    const trace = traceService.getTrace(traceId);
    res.json({
      traceId,
      status: trace?.status,
    });
  } catch (error: any) {
    console.error('Failed to complete upload:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
}

// Get trace status
export async function getTraceStatus(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    const trace = traceService.getTrace(traceId);

    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json(trace);
  } catch (error: any) {
    console.error('Failed to get trace status:', error);
    res.status(500).json({ error: 'Failed to get trace status' });
  }
}

// List all traces
export async function listTraces(req: Request, res: Response): Promise<void> {
  try {
    const traces = traceService.getAllTraces();
    res.json({ traces });
  } catch (error: any) {
    console.error('Failed to list traces:', error);
    res.status(500).json({ error: 'Failed to list traces' });
  }
}

// Delete a trace
export async function deleteTrace(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    await traceService.deleteTrace(traceId);

    res.json({ message: 'Trace deleted successfully' });
  } catch (error: any) {
    console.error('Failed to delete trace:', error);
    res.status(500).json({ error: 'Failed to delete trace' });
  }
}

// Query a trace
export async function queryTrace(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    const { q: query } = req.query;

    if (!query) {
      res.status(400).json({ error: 'Query parameter is required' });
      return;
    }

    const result = await traceService.query(traceId, query as string);
    res.json(result);
  } catch (error: any) {
    console.error('Failed to query trace:', error);
    res.status(500).json({ error: 'Failed to query trace' });
  }
}

// Get trace metadata
export async function getTraceMetadata(req: Request, res: Response): Promise<void> {
  try {
    const { traceId } = req.params;
    const trace = traceService.getTrace(traceId);

    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json({
      metadata: trace.metadata,
      status: trace.status,
      error: trace.error,
    });
  } catch (error: any) {
    console.error('Failed to get trace metadata:', error);
    res.status(500).json({ error: 'Failed to get trace metadata' });
  }
}

// Export the service for use in other modules
export { traceService };