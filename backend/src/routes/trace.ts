import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import TraceController from '../controllers/traceController';
// import { authenticate, checkUsage } from '../middleware/auth';

const router = Router();
const traceController = new TraceController();

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

const fileFilter = (req: any, file: Express.Multer.File, cb: any) => {
  // Accept all files
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '2147483648'), // 2GB default
  },
});

// POST /api/trace/upload - Upload a trace file (auth disabled for development)
router.post('/upload', upload.single('file'), traceController.uploadTrace);

// POST /api/trace/analyze - Deprecated. Returns migration guidance to /api/agent/analyze.
router.post('/analyze', traceController.analyzeTrace);

// GET /api/trace/:fileId - Get trace file information (auth disabled for development)
router.get('/:fileId', traceController.getTraceInfo);

// DELETE /api/trace/:fileId - Delete a trace file (auth disabled for development)
router.delete('/:fileId', traceController.deleteTrace);

// GET /api/trace/:fileId/download - Download a trace file (auth disabled for development)
router.get('/:fileId/download', traceController.downloadTrace);

export default router;
