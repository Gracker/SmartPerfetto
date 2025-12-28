import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { getTraceProcessorService } from '../services/traceProcessorService';

const router = Router();

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
    fileSize: 500 * 1024 * 1024, // 500MB
  },
});

// POST /api/traces/upload - Simple upload without auth
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    const file = req.file;

    // Store trace info (in a real app, this would go to a database)
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');
    await fs.mkdir(tracesDir, { recursive: true });

    // Generate trace ID upfront for consistency
    const traceId = uuidv4();

    // Load trace into TraceProcessorService for SQL analysis
    // Use the traceId we generated so everything is consistent
    const tps = getTraceProcessorService();

    if (tps) {
      // Initialize upload in the service with our traceId
      await tps.initializeUploadWithId(traceId, file.originalname, file.size);
      console.log(`[TraceProcessor] Initialized upload with traceId: ${traceId}`);
    }

    // Move file to traces directory with proper name
    const finalPath = path.join(tracesDir, `${traceId}.trace`);
    await fs.rename(file.path, finalPath);

    console.log(`File uploaded successfully: ${file.originalname} -> ${traceId}`);

    // Create metadata JSON file for the trace
    const metadataPath = path.join(tracesDir, `${traceId}.json`);
    const metadata = {
      id: traceId,
      filename: file.originalname,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: finalPath,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    console.log(`[TraceProcessor] Created metadata: ${metadataPath}`);

    // Complete the upload which will process the trace
    if (tps) {
      try {
        await tps.completeUpload(traceId);
        console.log(`[TraceProcessor] Loaded trace ${traceId}`);
      } catch (tpError: any) {
        console.error(`[TraceProcessor] Failed to load trace ${traceId}:`, tpError.message);
        // Continue anyway - file is saved
      }
    }

    // Get trace status from service
    const traceInfo = tps?.getTrace(traceId);

    res.json({
      success: true,
      trace: {
        id: traceId,
        filename: file.originalname,
        size: file.size,
        uploadedAt: traceInfo?.uploadTime || new Date().toISOString(),
        status: traceInfo?.status || 'ready'
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

// GET /api/traces - List all traces
router.get('/', async (req, res) => {
  try {
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');

    try {
      const files = await fs.readdir(tracesDir);
      const traces = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const traceData = await fs.readFile(path.join(tracesDir, file), 'utf8');
          const trace = JSON.parse(traceData);
          traces.push(trace);
        }
      }

      // Sort by upload date (newest first)
      traces.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

      res.json({ traces });
    } catch (error) {
      // Directory doesn't exist yet
      res.json({ traces: [] });
    }
  } catch (error: any) {
    console.error('List traces error:', error);
    res.status(500).json({
      error: 'Failed to list traces',
      details: error.message
    });
  }
});

// DELETE /api/traces/:id - Delete a trace
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');

    // Delete trace file
    const tracePath = path.join(tracesDir, `${id}.trace`);
    try {
      await fs.unlink(tracePath);
    } catch (error) {
      // File might not exist, continue
    }

    // Delete metadata file
    const infoPath = path.join(tracesDir, `${id}.json`);
    try {
      await fs.unlink(infoPath);
    } catch (error) {
      // File might not exist, continue
    }

    console.log(`Trace deleted: ${id}`);
    res.json({ success: true, message: 'Trace deleted successfully' });

  } catch (error: any) {
    console.error('Delete trace error:', error);
    res.status(500).json({
      error: 'Failed to delete trace',
      details: error.message
    });
  }
});

// GET /api/traces/:id/file - Download trace file
router.get('/:id/file', async (req, res) => {
  try {
    const { id } = req.params;
    const tracesDir = path.join(process.env.UPLOAD_DIR || './uploads', 'traces');
    const tracePath = path.join(tracesDir, `${id}.trace`);

    try {
      await fs.access(tracePath);
      res.sendFile(tracePath, { root: '.' });
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