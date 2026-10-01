// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Skill Admin Controller
 *
 * Handles CRUD operations for skill management.
 */

import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { skillRegistry, ensureSkillRegistryInitialized, getSkillsDir } from '../services/skillEngine/skillLoader';
import { SkillDefinition } from '../services/skillEngine/types';
import { sendRouteFailure } from '../middleware/routeFailure';
import { toSingleString } from '../utils/httpValue';

const SKILLS_DIR = getSkillsDir();
const COMPOSITE_DIR = path.join(SKILLS_DIR, 'composite');
const VENDORS_DIR = path.join(SKILLS_DIR, 'vendors');
const CUSTOM_DIR = path.join(SKILLS_DIR, 'custom');

class SkillAdminController {
  /**
   * Ensure skill registry is initialized
   */
  private async ensureInitialized(): Promise<void> {
    await ensureSkillRegistryInitialized();
  }

  /**
   * List all skills with admin metadata
   * GET /api/admin/skills
   */
  listSkills = async (_req: Request, res: Response) => {
    try {
      await this.ensureInitialized();

      const skills = skillRegistry.getAllSkills();

      const result = skills.map(skill => ({
        id: skill.name,
        name: skill.name,
        version: skill.version,
        displayName: skill.meta?.display_name || skill.name,
        description: skill.meta?.description || '',
        category: skill.category,
        type: skill.type,
        stepsCount: skill.steps?.length || 0,
        tags: skill.meta?.tags,
      }));

      res.json({
        skills: result,
        count: result.length,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_list_failed',
        error: 'Failed to list skills',
        logLabel: '[SkillAdminController] Error listing skills',
      }, error);
    }
  };

  /**
   * Get skill details including raw YAML
   * GET /api/admin/skills/:skillId
   */
  getSkill = async (req: Request, res: Response) => {
    try {
      const skillId = toSingleString(req.params.skillId);
      await this.ensureInitialized();

      if (!skillId) {
        return res.status(400).json({
          error: 'Missing skill ID',
          details: 'skillId is required',
        });
      }

      const skill = skillRegistry.getSkill(skillId);
      if (!skill) {
        return res.status(404).json({
          error: 'Skill not found',
          details: `No skill found with ID: ${skillId}`,
        });
      }

      // Try to find the YAML file
      const possiblePaths = [
        path.join(COMPOSITE_DIR, `${skillId}.skill.yaml`),
        path.join(SKILLS_DIR, 'atomic', `${skillId}.skill.yaml`),
        path.join(CUSTOM_DIR, `${skillId}.skill.yaml`),
      ];

      let rawYaml = '';
      let filePath = '';
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          rawYaml = fs.readFileSync(p, 'utf-8');
          filePath = p;
          break;
        }
      }

      res.json({
        id: skill.name,
        definition: skill,
        rawYaml,
        filePath,
        isCustom: filePath.includes('/custom/'),
        isEditable: filePath.includes('/custom/'),
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_read_failed',
        error: 'Failed to get skill',
        logLabel: '[SkillAdminController] Error getting skill',
      }, error);
    }
  };

  /**
   * Create a new custom skill
   * POST /api/admin/skills
   * Body: { yaml: string } or { definition: SkillDefinition }
   */
  createSkill = async (req: Request, res: Response) => {
    try {
      const { yaml: yamlContent, definition } = req.body;

      let skillDef: SkillDefinition;
      let yamlToSave: string;

      if (yamlContent) {
        // Parse YAML
        skillDef = yaml.load(yamlContent) as SkillDefinition;
        yamlToSave = yamlContent;
      } else if (definition) {
        skillDef = definition;
        yamlToSave = yaml.dump(definition);
      } else {
        return res.status(400).json({
          error: 'Missing skill data',
          details: 'Either yaml or definition is required',
        });
      }

      // Validate required fields
      if (!skillDef.name) {
        return res.status(400).json({
          error: 'Invalid skill definition',
          details: 'Skill name is required',
        });
      }

      // Ensure custom directory exists
      if (!fs.existsSync(CUSTOM_DIR)) {
        fs.mkdirSync(CUSTOM_DIR, { recursive: true });
      }

      // Check if skill already exists
      const fileName = `${skillDef.name}.skill.yaml`;
      const filePath = path.join(CUSTOM_DIR, fileName);

      if (fs.existsSync(filePath)) {
        return res.status(409).json({
          error: 'Skill already exists',
          details: `A skill with name '${skillDef.name}' already exists`,
        });
      }

      // Save file
      fs.writeFileSync(filePath, yamlToSave, 'utf-8');

      // Reload skills
      await skillRegistry.reload();

      res.status(201).json({
        success: true,
        message: 'Skill created successfully',
        skillId: skillDef.name,
        filePath,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_create_failed',
        error: 'Failed to create skill',
        logLabel: '[SkillAdminController] Error creating skill',
      }, error);
    }
  };

  /**
   * Update an existing custom skill
   * PUT /api/admin/skills/:skillId
   * Body: { yaml: string } or { definition: SkillDefinition }
   */
  updateSkill = async (req: Request, res: Response) => {
    try {
      const skillId = toSingleString(req.params.skillId);
      const { yaml: yamlContent, definition } = req.body;

      if (!skillId) {
        return res.status(400).json({
          error: 'Missing skill ID',
          details: 'skillId is required',
        });
      }

      await this.ensureInitialized();

      const skill = skillRegistry.getSkill(skillId);
      if (!skill) {
        return res.status(404).json({
          error: 'Skill not found',
          details: `No skill found with ID: ${skillId}`,
        });
      }

      // Find the file path - only custom skills are editable
      const customFilePath = path.join(CUSTOM_DIR, `${skillId}.skill.yaml`);
      if (!fs.existsSync(customFilePath)) {
        return res.status(403).json({
          error: 'Skill not editable',
          details: 'Only custom skills can be edited. Base and vendor skills are read-only.',
        });
      }
      const filePath = customFilePath;

      let yamlToSave: string;

      if (yamlContent) {
        yamlToSave = yamlContent;
      } else if (definition) {
        yamlToSave = yaml.dump(definition);
      } else {
        return res.status(400).json({
          error: 'Missing skill data',
          details: 'Either yaml or definition is required',
        });
      }

      // Save file
      fs.writeFileSync(filePath, yamlToSave, 'utf-8');

      // Reload skills
      await skillRegistry.reload();

      res.json({
        success: true,
        message: 'Skill updated successfully',
        skillId,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_update_failed',
        error: 'Failed to update skill',
        logLabel: '[SkillAdminController] Error updating skill',
      }, error);
    }
  };

  /**
   * Delete a custom skill
   * DELETE /api/admin/skills/:skillId
   */
  deleteSkill = async (req: Request, res: Response) => {
    try {
      const skillId = toSingleString(req.params.skillId);

      if (!skillId) {
        return res.status(400).json({
          error: 'Missing skill ID',
          details: 'skillId is required',
        });
      }

      await this.ensureInitialized();

      const skill = skillRegistry.getSkill(skillId);
      if (!skill) {
        return res.status(404).json({
          error: 'Skill not found',
          details: `No skill found with ID: ${skillId}`,
        });
      }

      // Check if deletable (only custom skills)
      const customFilePath = path.join(CUSTOM_DIR, `${skillId}.skill.yaml`);
      if (!fs.existsSync(customFilePath)) {
        return res.status(403).json({
          error: 'Skill not deletable',
          details: 'Only custom skills can be deleted. Base and vendor skills are protected.',
        });
      }

      // Delete file
      fs.unlinkSync(customFilePath);

      // Also delete SOP if exists
      const sopPath = customFilePath.replace('.skill.yaml', '.sop.md');
      if (fs.existsSync(sopPath)) {
        fs.unlinkSync(sopPath);
      }

      // Reload skills
      await skillRegistry.reload();

      res.json({
        success: true,
        message: 'Skill deleted successfully',
        skillId,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_delete_failed',
        error: 'Failed to delete skill',
        logLabel: '[SkillAdminController] Error deleting skill',
      }, error);
    }
  };

  /**
   * Validate skill YAML
   * POST /api/admin/skills/validate
   * Body: { yaml: string }
   */
  validateSkill = async (req: Request, res: Response) => {
    try {
      const { yaml: yamlContent } = req.body;

      if (!yamlContent) {
        return res.status(400).json({
          error: 'Missing YAML content',
          details: 'yaml is required',
        });
      }

      const errors: string[] = [];
      const warnings: string[] = [];

      // Parse YAML
      let skillDef: SkillDefinition;
      try {
        skillDef = yaml.load(yamlContent) as SkillDefinition;
      } catch (e: any) {
        return res.json({
          valid: false,
          errors: [`YAML parse error: ${e.message}`],
          warnings: [],
        });
      }

      // Validate required fields
      if (!skillDef.name) errors.push('Missing required field: name');
      if (!skillDef.version) errors.push('Missing required field: version');
      if (!skillDef.meta) errors.push('Missing required field: meta');
      if (!skillDef.steps || skillDef.steps.length === 0) {
        errors.push('Missing required field: steps');
      }

      // Validate meta
      if (skillDef.meta) {
        if (!skillDef.meta.display_name) errors.push('Missing meta.display_name');
        if (!skillDef.meta.description) errors.push('Missing meta.description');
      }

      // Validate steps
      if (skillDef.steps) {
        const stepIds = new Set<string>();
        skillDef.steps.forEach((step, i) => {
          if (!step.id) errors.push(`steps[${i}]: Missing id`);
          // name is optional for most step types
          // sql is only required for atomic steps
          if ('type' in step && step.type === 'atomic' && !('sql' in step && step.sql)) {
            errors.push(`steps[${i}]: Atomic step missing sql`);
          }
          if (step.id && stepIds.has(step.id)) {
            errors.push(`steps[${i}]: Duplicate id '${step.id}'`);
          }
          if (step.id) stepIds.add(step.id);
        });
      }

      res.json({
        valid: errors.length === 0,
        errors,
        warnings,
        parsedDefinition: errors.length === 0 ? skillDef : undefined,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_validate_failed',
        error: 'Failed to validate skill',
        logLabel: '[SkillAdminController] Error validating skill',
      }, error);
    }
  };

  /**
   * List all vendors
   * GET /api/admin/vendors
   */
  listVendors = async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(VENDORS_DIR)) {
        return res.json({ vendors: [] });
      }

      const vendorDirs = fs.readdirSync(VENDORS_DIR).filter(f =>
        fs.statSync(path.join(VENDORS_DIR, f)).isDirectory()
      );

      const vendors = vendorDirs.map(vendor => {
        const vendorPath = path.join(VENDORS_DIR, vendor);
        const overrides = fs.readdirSync(vendorPath).filter(f =>
          f.endsWith('.override.yaml')
        );

        return {
          id: vendor,
          overrideCount: overrides.length,
          overrides: overrides.map(f => f.replace('.override.yaml', '')),
        };
      });

      res.json({
        vendors,
        count: vendors.length,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_list_vendors_failed',
        error: 'Failed to list vendors',
        logLabel: '[SkillAdminController] Error listing vendors',
      }, error);
    }
  };

  /**
   * Get vendor overrides
   * GET /api/admin/vendors/:vendor/overrides
   */
  getVendorOverrides = async (req: Request, res: Response) => {
    try {
      const vendor = toSingleString(req.params.vendor);
      if (!vendor) {
        return res.status(400).json({
          error: 'Missing vendor',
          details: 'vendor is required',
        });
      }
      const vendorPath = path.join(VENDORS_DIR, vendor);

      if (!fs.existsSync(vendorPath)) {
        return res.status(404).json({
          error: 'Vendor not found',
          details: `No vendor found: ${vendor}`,
        });
      }

      const overrideFiles = fs.readdirSync(vendorPath).filter(f =>
        f.endsWith('.override.yaml')
      );

      const overrides = overrideFiles.map(file => {
        const filePath = path.join(vendorPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const override = yaml.load(content) as any;

        return {
          skillId: file.replace('.override.yaml', ''),
          extends: override.extends,
          version: override.version,
          meta: override.meta,
          additionalStepsCount: override.additional_steps?.length || 0,
          rawYaml: content,
        };
      });

      res.json({
        vendor,
        overrides,
        count: overrides.length,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_get_vendor_overrides_failed',
        error: 'Failed to get vendor overrides',
        logLabel: '[SkillAdminController] Error getting vendor overrides',
      }, error);
    }
  };

  /**
   * Reload all skills
   * POST /api/admin/skills/reload
   */
  reloadSkills = async (_req: Request, res: Response) => {
    try {
      await skillRegistry.reload();

      const skills = skillRegistry.getAllSkills();

      res.json({
        success: true,
        message: 'Skills reloaded successfully',
        count: skills.length,
      });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'skill_admin_reload_failed',
        error: 'Failed to reload skills',
        logLabel: '[SkillAdminController] Error reloading skills',
      }, error);
    }
  };
}

export default SkillAdminController;
