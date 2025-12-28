import { Router } from 'express';
import {
  initializeUpload,
  handleUpload,
  uploadChunk,
  completeUpload,
  getTraceStatus,
  listTraces,
  deleteTrace,
  queryTrace,
  getTraceMetadata,
  uploadTrace,
} from '../controllers/traceProcessorController';
import { authenticate } from '../middleware/auth';
import path from 'path';

const router = Router();

// Public routes
router.get('/', listTraces);
router.get('/:traceId/status', getTraceStatus);
router.get('/:traceId/metadata', getTraceMetadata);

// Serve trace files for Perfetto UI
router.get('/:traceId/file', (req, res) => {
  const { traceId } = req.params;
  const tracePath = path.join(__dirname, '../../../uploads/traces', `${traceId}.trace`);

  res.sendFile(tracePath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Trace file not found' });
    }
  });
});

// Protected routes (require authentication)
router.use(authenticate);

// Upload routes
router.post('/initialize', initializeUpload);
router.post('/upload', uploadTrace, handleUpload);
router.post('/:traceId/upload', uploadChunk);
router.post('/:traceId/complete', completeUpload);

// Trace management
router.delete('/:traceId', deleteTrace);

// Query execution
router.get('/:traceId/query', queryTrace);

export default router;