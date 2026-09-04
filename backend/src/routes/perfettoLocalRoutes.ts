// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { perfettoLocalService } from '../services/perfettoLocalService';
import { resolveTraceUploadLimitBytes } from '../services/traceUploadLimit';

const router = express.Router();

// Configure multer for file uploads
// Portable launchers provide a writable user-data directory through UPLOAD_DIR.
// Keep the package-local path as the source/development fallback.
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
fsSync.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: resolveTraceUploadLimitBytes(),
  },
  fileFilter: (req, file, cb) => {
    // Accept common trace file extensions
    const allowedExtensions = ['.trace', '.pb', '.perfetto', '.json'];
    const fileExtension = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(fileExtension) || file.originalname.includes('trace')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a valid trace file.'));
    }
  }
});

// Get current status of the Perfetto server
router.get('/status', async (req, res) => {
  try {
    const status = perfettoLocalService.getStatus();
    res.json({
      success: true,
      data: status,
      uiUrl: status.running ? perfettoLocalService.getTraceProcessorUrl : null
    });
  } catch (error) {
    console.error('Error getting Perfetto status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get Perfetto server status'
    });
  }
});

// Start the Perfetto server
router.post('/start', async (req, res) => {
  try {
    const { traceFile } = req.body || {};

    const status = await perfettoLocalService.startServer(traceFile);

    res.json({
      success: true,
      data: {
        ...status,
        uiUrl: perfettoLocalService.getTraceProcessorUrl
      },
      message: 'Perfetto server started successfully'
    });
  } catch (error) {
    console.error('Error starting Perfetto server:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start Perfetto server'
    });
  }
});

// Stop the Perfetto server
router.post('/stop', async (req, res) => {
  try {
    await perfettoLocalService.stopServer();

    res.json({
      success: true,
      message: 'Perfetto server stopped successfully'
    });
  } catch (error) {
    console.error('Error stopping Perfetto server:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop Perfetto server'
    });
  }
});

// Upload and load a trace file
router.post('/upload', upload.single('trace'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const filePath = req.file.path;
    console.log(`Trace file uploaded to: ${filePath}`);

    // Check file size - if too small, it might be empty
    const stats = await fs.stat(filePath);
    if (stats.size < 100) {
      console.log('Warning: Trace file seems too small');
    }

    // Don't automatically load the trace, just save it
    res.json({
      success: true,
      data: {
        fileName: req.file.originalname,
        filePath: filePath,
        size: stats.size
      },
      message: 'Trace file uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading trace file:', error);

    // Clean up uploaded file on error
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up uploaded file:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload trace file'
    });
  }
});

// Open a trace file in Perfetto UI
router.post('/open-trace', async (req, res) => {
  try {
    const { traceFile } = req.body;

    if (!traceFile) {
      return res.status(400).json({
        success: false,
        error: 'No trace file path provided'
      });
    }

    // Check if file exists and has content
    try {
      const stats = await fs.stat(traceFile);
      console.log(`Opening trace file: ${traceFile}, size: ${stats.size} bytes`);

      if (stats.size === 0) {
        return res.status(400).json({
          success: false,
          error: 'Trace file is empty'
        });
      }
    } catch (err) {
      return res.status(404).json({
        success: false,
        error: 'Trace file not found'
      });
    }

    // Start Perfetto server with the trace file
    console.log('Starting Perfetto server with trace file...');
    const status = await perfettoLocalService.loadTrace(traceFile);

    // Construct Perfetto UI URL
    const port = status.port;
    // 不使用 ~no_open 参数，让 Perfetto UI 自动加载数据
    const perfettoUrl = `https://ui.perfetto.dev/#!/?rpc~http://localhost:${port}`;

    console.log(`Perfetto server started on port ${port}`);

    res.json({
      success: true,
      data: {
        url: perfettoUrl,
        port: port,
        ...status,
        // 提示用户手动刷新数据
        tip: 'If trace doesn\'t appear automatically, press Ctrl+R or Cmd+R in Perfetto UI'
      },
      message: 'Trace file opened successfully'
    });
  } catch (error) {
    console.error('Error opening trace file:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to open trace file'
    });
  }
});

// Load an existing trace file
router.post('/load', async (req, res) => {
  try {
    const { traceFile } = req.body;

    if (!traceFile) {
      return res.status(400).json({
        success: false,
        error: 'No trace file path provided'
      });
    }

    const status = await perfettoLocalService.loadTrace(traceFile);

    res.json({
      success: true,
      data: {
        ...status,
        uiUrl: perfettoLocalService.getTraceProcessorUrl
      },
      message: 'Trace file loaded successfully'
    });
  } catch (error) {
    console.error('Error loading trace file:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load trace file'
    });
  }
});

// Proxy to Perfetto HTTP RPC API - simplified for now
// The actual Perfetto UI will be served directly from the trace_processor
// We may add RPC proxying later if needed

export default router;
