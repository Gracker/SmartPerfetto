import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { ErrorResponse } from '../types';

class TraceController {
  private uploadDir: string;

  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    this.ensureUploadDir();
  }

  private async ensureUploadDir() {
    try {
      await fs.access(this.uploadDir);
    } catch {
      await fs.mkdir(this.uploadDir, { recursive: true });
    }
  }

  uploadTrace = async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        const error: ErrorResponse = {
          error: 'No file uploaded',
          details: 'Please upload a .perfetto trace file',
        };
        return res.status(400).json(error);
      }

      const file = req.file;

      // Removed file extension validation - accept all files
      console.log(`Uploading file: ${file.originalname}, size: ${file.size} bytes`);

      // Validate file size (default 2GB)
      const maxSize = parseInt(process.env.MAX_FILE_SIZE || '2147483648');
      if (file.size > maxSize) {
        const error: ErrorResponse = {
          error: 'File too large',
          details: `Maximum file size is ${maxSize / 1024 / 1024}MB`,
        };
        return res.status(400).json(error);
      }

      // Move file to upload directory
      const fileName = `${Date.now()}-${file.originalname}`;
      const filePath = path.join(this.uploadDir, fileName);
      await fs.rename(file.path, filePath);

      // Return file info
      res.json({
        fileId: fileName,
        fileName: file.originalname,
        fileSize: file.size,
        filePath: filePath,
        uploadTime: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error uploading trace:', error);
      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  analyzeTrace = async (req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      code: 'TRACE_ANALYZE_DEPRECATED',
      error: '/api/trace/analyze has been removed',
      details: 'Use AgentRuntime unified flow: upload with /api/traces/* and analyze with /api/agent/analyze.',
      migration: {
        upload: [
          'POST /api/traces/initialize',
          'POST /api/traces/:traceId/upload (or chunk upload)',
          'POST /api/traces/:traceId/complete',
        ],
        analyze: 'POST /api/agent/analyze',
      },
      removedAt: '2026-02-22',
    });
  };

  getTraceInfo = async (req: Request, res: Response) => {
    try {
      const { fileId } = req.params;

      if (!fileId) {
        const error: ErrorResponse = {
          error: 'Missing file ID',
          details: 'Please provide a file ID',
        };
        return res.status(400).json(error);
      }

      const filePath = path.join(this.uploadDir, fileId);

      try {
        const stats = await fs.stat(filePath);
        res.json({
          fileId,
          fileName: fileId,
          fileSize: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
        });
      } catch {
        const error: ErrorResponse = {
          error: 'File not found',
          details: 'The requested trace file does not exist',
        };
        return res.status(404).json(error);
      }
    } catch (error) {
      console.error('Error getting trace info:', error);
      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  deleteTrace = async (req: Request, res: Response) => {
    try {
      const { fileId } = req.params;

      if (!fileId) {
        const error: ErrorResponse = {
          error: 'Missing file ID',
          details: 'Please provide a file ID',
        };
        return res.status(400).json(error);
      }

      const filePath = path.join(this.uploadDir, fileId);

      try {
        await fs.unlink(filePath);
        res.json({
          message: 'Trace file deleted successfully',
          fileId,
        });
      } catch {
        const error: ErrorResponse = {
          error: 'File not found',
          details: 'The requested trace file does not exist',
        };
        return res.status(404).json(error);
      }
    } catch (error) {
      console.error('Error deleting trace:', error);
      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  downloadTrace = async (req: Request, res: Response) => {
    try {
      const { fileId } = req.params;

      if (!fileId) {
        const error: ErrorResponse = {
          error: 'Missing file ID',
          details: 'Please provide a file ID',
        };
        return res.status(400).json(error);
      }

      const filePath = path.join(this.uploadDir, fileId);

      try {
        // Check if file exists
        await fs.access(filePath);

        // Get file stats
        const stats = await fs.stat(filePath);

        // Set appropriate headers
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stats.size);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${fileId.replace(/^\d+-/, '')}"`
        );

        // Create read stream and pipe to response
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);

        fileStream.on('error', (error: Error) => {
          console.error('Error streaming file:', error);
          if (!res.headersSent) {
            res.status(500).json({
              error: 'Internal server error',
              details: 'Error streaming file',
            });
          }
        });
      } catch {
        const error: ErrorResponse = {
          error: 'File not found',
          details: 'The requested trace file does not exist',
        };
        return res.status(404).json(error);
      }
    } catch (error) {
      console.error('Error downloading trace:', error);
      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };
}

export default TraceController;
