// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Routes
 *
 * API endpoints for the skill-based trace analysis system.
 * Skills are configurable analysis workflows defined in YAML files.
 */

import express from 'express';
import SkillController from '../controllers/skillController';

const router = express.Router();
const skillController = new SkillController();

// =============================================================================
// Skill Discovery
// =============================================================================

/**
 * GET /api/skills
 *
 * List all available skills
 *
 * Response: { skills: SkillListItem[], count: number }
 */
router.get('/', skillController.listSkills);

/**
 * GET /api/skills/:skillId
 *
 * Get detailed information about a specific skill
 *
 * Params: skillId - The skill ID (e.g., "startup_analysis")
 * Response: Skill definition with steps, thresholds, and SOP content
 */
router.get('/:skillId', skillController.getSkillDetail);

// =============================================================================
// Skill Execution
// =============================================================================

/**
 * POST /api/skills/execute/:skillId
 *
 * Execute a specific skill against a trace
 *
 * Params: skillId - The skill ID to execute
 * Body: { traceId: string, packageName?: string }
 * Response: SkillAnalysisResponse
 */
router.post('/execute/:skillId', skillController.executeSkill);

/**
 * POST /api/skills/analyze
 *
 * Analyze a trace with automatic skill detection
 *
 * Body: {
 *   traceId: string,
 *   question?: string,   // Natural language question for intent detection
 *   skillId?: string,    // Or specify skill directly
 *   packageName?: string
 * }
 * Response: SkillAnalysisResponse
 */
router.post('/analyze', skillController.analyzeTrace);

// =============================================================================
// Utility Endpoints
// =============================================================================

/**
 * POST /api/skills/detect-intent
 *
 * Detect which skill matches a natural language question
 *
 * Body: { question: string }
 * Response: { matched: boolean, skillId?: string, skillName?: string }
 */
router.post('/detect-intent', skillController.detectIntent);

/**
 * POST /api/skills/detect-vendor
 *
 * Resolve the device vendor, SoC and OS from trace metadata
 *
 * Body: { traceId: string }
 * Response: { schemaVersion: 'trace_vendor@1', vendor, brand?, confidence: number,
 *   vendorConfidence, soc, os, source, evidence }
 */
router.post('/detect-vendor', skillController.detectVendor);

export default router;