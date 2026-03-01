/**
 * Skill Admin Routes
 *
 * API endpoints for skill management (CRUD operations).
 */

import express from 'express';
import SkillAdminController from '../controllers/skillAdminController';
import { authenticate } from '../middleware/auth';

const router = express.Router();
const skillAdminController = new SkillAdminController();

// Admin endpoints must always be authenticated.
router.use(authenticate);

// =============================================================================
// Skill CRUD
// =============================================================================

/**
 * GET /api/admin/skills
 *
 * List all skills with admin metadata
 */
router.get('/skills', skillAdminController.listSkills);

/**
 * GET /api/admin/skills/:skillId
 *
 * Get skill details including raw YAML
 */
router.get('/skills/:skillId', skillAdminController.getSkill);

/**
 * POST /api/admin/skills
 *
 * Create a new custom skill
 * Body: { yaml: string } or { definition: SkillDefinition }
 */
router.post('/skills', skillAdminController.createSkill);

/**
 * PUT /api/admin/skills/:skillId
 *
 * Update an existing custom skill
 * Body: { yaml: string } or { definition: SkillDefinition }
 */
router.put('/skills/:skillId', skillAdminController.updateSkill);

/**
 * DELETE /api/admin/skills/:skillId
 *
 * Delete a custom skill
 */
router.delete('/skills/:skillId', skillAdminController.deleteSkill);

// =============================================================================
// Validation
// =============================================================================

/**
 * POST /api/admin/skills/validate
 *
 * Validate skill YAML without saving
 * Body: { yaml: string }
 */
router.post('/skills/validate', skillAdminController.validateSkill);

/**
 * POST /api/admin/skills/reload
 *
 * Reload all skills from disk
 */
router.post('/skills/reload', skillAdminController.reloadSkills);

// =============================================================================
// Vendor Management
// =============================================================================

/**
 * GET /api/admin/vendors
 *
 * List all vendors with override counts
 */
router.get('/vendors', skillAdminController.listVendors);

/**
 * GET /api/admin/vendors/:vendor/overrides
 *
 * Get all overrides for a specific vendor
 */
router.get('/vendors/:vendor/overrides', skillAdminController.getVendorOverrides);

export default router;
