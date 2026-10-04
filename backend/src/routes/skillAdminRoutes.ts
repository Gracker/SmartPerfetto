// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Admin Routes
 *
 * API endpoints for skill management (CRUD operations).
 */

import express from 'express';
import SkillAdminController from '../controllers/skillAdminController';
import { resolveFeatureConfig } from '../config';
import { authenticate } from '../middleware/auth';
import { requireRbacPermission } from '../services/rbac';

const router = express.Router();
const skillAdminController = new SkillAdminController();

const CUSTOM_SKILL_DISABLED_PAYLOAD = {
  error: 'disabled_in_enterprise_mode',
  details: 'Custom skill write endpoints are disabled in enterprise mode.',
} as const;

function disableCustomSkillWritesInEnterpriseMode(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (resolveFeatureConfig().enterprise) {
    res.status(404).json(CUSTOM_SKILL_DISABLED_PAYLOAD);
    return;
  }
  next();
}

// Admin endpoints must always be authenticated.
router.use(authenticate);

// Each operation class has its own permission, checked per route: this router
// is mounted on the shared /api/admin prefix, so a router-level guard would
// also gate the strategy and Self-Evolution admin routers after it. Keyless
// local mode and the operator API key hold every permission.
//
// The built-in Skill catalog is the agent's own tool catalog (`list_skills`),
// so anyone who may run the agent may list it. Raw Skill and vendor-override
// YAML, validating arbitrary YAML server-side, reloading the process-wide
// registry and writing custom Skills manage the runtime's analysis content.
const canReadSkillCatalog = requireRbacPermission(
  'agent:run',
  'Listing skills requires agent:run permission',
);
const canReadSkillSource = requireRbacPermission(
  'runtime:manage',
  'Reading skill source requires runtime:manage permission',
);
const canValidateSkill = requireRbacPermission(
  'runtime:manage',
  'Validating skill YAML requires runtime:manage permission',
);
const canReloadSkills = requireRbacPermission(
  'runtime:manage',
  'Reloading skills requires runtime:manage permission',
);
const canWriteCustomSkill = requireRbacPermission(
  'runtime:manage',
  'Writing custom skills requires runtime:manage permission',
);

// =============================================================================
// Skill CRUD
// =============================================================================

/**
 * GET /api/admin/skills
 *
 * List all skills with admin metadata
 */
router.get('/skills', canReadSkillCatalog, skillAdminController.listSkills);

/**
 * GET /api/admin/skills/:skillId
 *
 * Get skill details including raw YAML
 */
router.get('/skills/:skillId', canReadSkillSource, skillAdminController.getSkill);

/**
 * POST /api/admin/skills
 *
 * Create a new custom skill
 * Body: { yaml: string } or { definition: SkillDefinition }
 */
router.post('/skills', disableCustomSkillWritesInEnterpriseMode, canWriteCustomSkill, skillAdminController.createSkill);

/**
 * PUT /api/admin/skills/:skillId
 *
 * Update an existing custom skill
 * Body: { yaml: string } or { definition: SkillDefinition }
 */
router.put('/skills/:skillId', disableCustomSkillWritesInEnterpriseMode, canWriteCustomSkill,
  skillAdminController.updateSkill);

/**
 * DELETE /api/admin/skills/:skillId
 *
 * Delete a custom skill
 */
router.delete('/skills/:skillId', disableCustomSkillWritesInEnterpriseMode, canWriteCustomSkill,
  skillAdminController.deleteSkill);

// =============================================================================
// Validation
// =============================================================================

/**
 * POST /api/admin/skills/validate
 *
 * Validate skill YAML without saving
 * Body: { yaml: string }
 */
router.post('/skills/validate', canValidateSkill, skillAdminController.validateSkill);

/**
 * POST /api/admin/skills/reload
 *
 * Reload all skills from disk
 */
router.post('/skills/reload', canReloadSkills, skillAdminController.reloadSkills);

// =============================================================================
// Vendor Management
// =============================================================================

/**
 * GET /api/admin/vendors
 *
 * List all vendors with override counts
 */
router.get('/vendors', canReadSkillCatalog, skillAdminController.listVendors);

/**
 * GET /api/admin/vendors/:vendor/overrides
 *
 * Get all overrides for a specific vendor
 */
router.get('/vendors/:vendor/overrides', canReadSkillSource, skillAdminController.getVendorOverrides);

export default router;
