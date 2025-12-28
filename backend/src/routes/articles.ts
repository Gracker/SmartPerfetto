import { Router } from 'express';
import {
  getArticles,
  getArticle,
  searchArticles,
  getCategories,
  getTags,
  getSources,
  getStats,
  addArticle,
  refreshArticles,
  getRecommended,
} from '../controllers/articleController';
import { authenticate } from '../middleware/auth';
import { body, query } from 'express-validator';

const router = Router();

// Public routes
router.get('/', query(['page', 'limit', 'category', 'tags', 'source', 'query']), getArticles);
router.get('/search', query(['q']), searchArticles);
router.get('/categories', getCategories);
router.get('/tags', getTags);
router.get('/sources', getSources);
router.get('/stats', getStats);
router.get('/recommended', query(['limit']), getRecommended);

// Individual article
router.get('/:id', getArticle);

// Protected routes (admin only)
router.post(
  '/',
  authenticate,
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('url').isURL().withMessage('Valid URL is required'),
    body('summary').notEmpty().withMessage('Summary is required'),
    body('category').isIn(['perfetto', 'android', 'performance', 'tools', 'best-practices']).withMessage('Invalid category'),
  ],
  addArticle
);

router.post('/refresh', authenticate, refreshArticles);

export default router;