/**
 * Skill Loader
 *
 * 加载 skill 文件，包括普通 skills 和 module expert skills
 *
 * Module Expert Skills:
 * - 位于 skills/modules/ 目录下
 * - 包含 module 和 dialogue 字段
 * - 可以被跨领域专家调用
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition, ModuleLayer, DialogueCapability, SkillStep } from './types';
import { generateRenderingPipelineDetectionSkill } from '../renderingPipelineDetectionSkillGenerator';
import {
  VALID_DISPLAY_LAYERS,
  VALID_DISPLAY_LEVELS,
  VALID_DISPLAY_FORMATS,
  VALID_COLUMN_TYPES,
  VALID_COLUMN_FORMATS,
  VALID_CLICK_ACTIONS,
  isValidDisplayLayer,
  ColumnDefinition,
} from '../../types/dataContract';

// =============================================================================
// Skill Validation
// =============================================================================

interface ValidationWarning {
  skillName: string;
  stepId?: string;
  field: string;
  message: string;
  value?: any;
}

/**
 * Validate a skill definition's display configurations
 * Returns warnings for invalid values (does not throw)
 */
function validateSkillDisplayConfig(skill: SkillDefinition): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Validate output display config
  if (skill.output?.display) {
    const display = skill.output.display;
    if (display.layer && !isValidDisplayLayer(display.layer)) {
      warnings.push({
        skillName: skill.name,
        field: 'output.display.layer',
        message: `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
        value: display.layer
      });
    }
    if (display.level && !VALID_DISPLAY_LEVELS.includes(display.level as any)) {
      warnings.push({
        skillName: skill.name,
        field: 'output.display.level',
        message: `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
        value: display.level
      });
    }
  }

  // Validate step display configs
  if (skill.steps) {
    for (const step of skill.steps) {
      validateStepDisplay(skill.name, step, warnings);
    }
  }

  return warnings;
}

/**
 * Validate a single column definition from YAML
 */
function validateColumnDefinition(
  skillName: string,
  stepId: string,
  column: any,
  index: number,
  warnings: ValidationWarning[]
): void {
  const prefix = `display.columns[${index}]`;

  if (!column || typeof column !== 'object') {
    warnings.push({
      skillName,
      stepId,
      field: prefix,
      message: 'Column definition must be an object',
      value: column
    });
    return;
  }

  // Name is required
  if (!column.name || typeof column.name !== 'string') {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.name`,
      message: 'Column name is required and must be a string',
      value: column.name
    });
  }

  // Validate type if specified
  if (column.type && !VALID_COLUMN_TYPES.includes(column.type as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.type`,
      message: `Invalid column type. Valid values: ${VALID_COLUMN_TYPES.join(', ')}`,
      value: column.type
    });
  }

  // Validate format if specified
  if (column.format && !VALID_COLUMN_FORMATS.includes(column.format as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.format`,
      message: `Invalid column format. Valid values: ${VALID_COLUMN_FORMATS.join(', ')}`,
      value: column.format
    });
  }

  // Validate clickAction if specified
  if (column.clickAction && !VALID_CLICK_ACTIONS.includes(column.clickAction as any)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.clickAction`,
      message: `Invalid click action. Valid values: ${VALID_CLICK_ACTIONS.join(', ')}`,
      value: column.clickAction
    });
  }

  // Validate unit if specified
  if (column.unit && !['ns', 'us', 'ms', 's'].includes(column.unit)) {
    warnings.push({
      skillName,
      stepId,
      field: `${prefix}.unit`,
      message: `Invalid time unit. Valid values: ns, us, ms, s`,
      value: column.unit
    });
  }

  // Validate width if specified
  if (column.width !== undefined) {
    const validWidths = ['narrow', 'medium', 'wide', 'auto'];
    if (typeof column.width !== 'number' && !validWidths.includes(column.width)) {
      warnings.push({
        skillName,
        stepId,
        field: `${prefix}.width`,
        message: `Invalid width. Must be a number or one of: ${validWidths.join(', ')}`,
        value: column.width
      });
    }
  }
}

/**
 * Recursively validate step display configurations
 */
function validateStepDisplay(
  skillName: string,
  step: SkillStep,
  warnings: ValidationWarning[]
): void {
  // Check if step has display config (could be object or boolean)
  const display = (step as any).display;
  if (display && typeof display === 'object') {
    if (display.layer && !isValidDisplayLayer(display.layer)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.layer',
        message: `Invalid layer value. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
        value: display.layer
      });
    }
    if (display.level && !VALID_DISPLAY_LEVELS.includes(display.level as any)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.level',
        message: `Invalid level value. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
        value: display.level
      });
    }
    if (display.format && !VALID_DISPLAY_FORMATS.includes(display.format as any)) {
      warnings.push({
        skillName,
        stepId: step.id,
        field: 'display.format',
        message: `Invalid format value. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
        value: display.format
      });
    }

    // Validate columns array if present (Phase 0 - DataEnvelope refactoring)
    if (display.columns && Array.isArray(display.columns)) {
      for (let i = 0; i < display.columns.length; i++) {
        validateColumnDefinition(skillName, step.id, display.columns[i], i, warnings);
      }
    }

    // Validate metadataFields if present
    if (display.metadataFields) {
      if (!Array.isArray(display.metadataFields)) {
        warnings.push({
          skillName,
          stepId: step.id,
          field: 'display.metadataFields',
          message: 'metadataFields must be an array of strings',
          value: display.metadataFields
        });
      } else {
        for (let i = 0; i < display.metadataFields.length; i++) {
          if (typeof display.metadataFields[i] !== 'string') {
            warnings.push({
              skillName,
              stepId: step.id,
              field: `display.metadataFields[${i}]`,
              message: 'Each metadataField must be a string',
              value: display.metadataFields[i]
            });
          }
        }
      }
    }
  }

  // Recursively check nested steps (parallel, conditional)
  if ((step as any).steps) {
    for (const nestedStep of (step as any).steps) {
      validateStepDisplay(skillName, nestedStep, warnings);
    }
  }
  if ((step as any).conditions) {
    for (const condition of (step as any).conditions) {
      if (condition.then && typeof condition.then === 'object') {
        validateStepDisplay(skillName, condition.then as SkillStep, warnings);
      }
    }
    if ((step as any).else && typeof (step as any).else === 'object') {
      validateStepDisplay(skillName, (step as any).else as SkillStep, warnings);
    }
  }
}

// =============================================================================
// Skill Registry
// =============================================================================

class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
  private moduleSkills: Map<string, SkillDefinition> = new Map();  // Skills with module metadata
  private initialized = false;

  /**
   * 加载所有 skills
   */
  async loadSkills(skillsDir: string): Promise<void> {
    if (this.initialized) return;

    console.log(`[SkillLoader] Loading skills from: ${skillsDir}`);

    // 加载原子 skills
    const atomicDir = path.join(skillsDir, 'atomic');
    if (fs.existsSync(atomicDir)) {
      await this.loadSkillsFromDir(atomicDir);
    }

    // 加载组合 skills
    const compositeDir = path.join(skillsDir, 'composite');
    if (fs.existsSync(compositeDir)) {
      await this.loadSkillsFromDir(compositeDir);
    }

    // 加载深度分析 skills (Phase 6)
    const deepDir = path.join(skillsDir, 'deep');
    if (fs.existsSync(deepDir)) {
      await this.loadSkillsFromDir(deepDir);
    }

    // 加载系统分析 skills (Phase 6)
    const systemDir = path.join(skillsDir, 'system');
    if (fs.existsSync(systemDir)) {
      await this.loadSkillsFromDir(systemDir);
    }

    // 加载模块专家 skills (Cross-Domain Expert System)
    const modulesDir = path.join(skillsDir, 'modules');
    if (fs.existsSync(modulesDir)) {
      await this.loadModuleSkillsRecursively(modulesDir);
    }

    // 加载 pipeline skills (Pipeline Skill Architecture)
    // Note: Pipeline skills are loaded separately by PipelineSkillLoader
    // but we register them here for skill discovery
    const pipelinesDir = path.join(skillsDir, 'pipelines');
    if (fs.existsSync(pipelinesDir)) {
      await this.loadPipelineSkills(pipelinesDir);
    }

    this.initialized = true;
    console.log(`[SkillLoader] Loaded ${this.skills.size} skills (${this.moduleSkills.size} module experts)`);
  }

  /**
   * 递归加载 modules 目录下的 skills
   * modules/
   *   ├── app/
   *   ├── framework/
   *   ├── kernel/
   *   └── hardware/
   */
  private async loadModuleSkillsRecursively(dir: string): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.loadModuleSkillsRecursively(fullPath);
      } else if (entry.name.endsWith('.skill.yaml') || entry.name.endsWith('.skill.yml')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const skill = yaml.load(content) as SkillDefinition;

          if (skill && skill.name) {
            // Validate display configurations
            const warnings = validateSkillDisplayConfig(skill);
            for (const warn of warnings) {
              console.warn(`[SkillLoader] Validation warning in ${skill.name}${warn.stepId ? `.${warn.stepId}` : ''}: ${warn.field} - ${warn.message} (value: ${warn.value})`);
            }

            this.skills.set(skill.name, skill);

            // Track module skills separately for efficient lookup
            if (skill.module) {
              this.moduleSkills.set(skill.name, skill);
              console.log(`[SkillLoader] Loaded module skill: ${skill.name} (${skill.module.layer}/${skill.module.component})`);
            } else {
              console.log(`[SkillLoader] Loaded skill: ${skill.name} (${skill.type})`);
            }
          }
        } catch (error: any) {
          console.error(`[SkillLoader] Failed to load ${fullPath}:`, error.message);
        }
      }
    }
  }

  /**
   * 加载 pipeline skills
   * Pipeline skills are a special type that define rendering pipeline configurations
   */
  private async loadPipelineSkills(dir: string): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      // Skip non-skill files and template files
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;
      if (file.startsWith('_')) continue;

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = yaml.load(content) as SkillDefinition;

        if (skill && skill.name && skill.type === 'pipeline_definition') {
          // Register pipeline skills with a special prefix for discoverability
          this.skills.set(skill.name, skill);
          console.log(`[SkillLoader] Loaded pipeline skill: ${skill.name}`);
        }
      } catch (error: any) {
        console.error(`[SkillLoader] Failed to load pipeline ${file}:`, error.message);
      }
    }
  }

  /**
   * 从目录加载 skills
   */
  private async loadSkillsFromDir(dir: string): Promise<void> {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) {
        continue;
      }

      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = yaml.load(content) as SkillDefinition;

        if (skill && skill.name) {
          // Validate display configurations
          const warnings = validateSkillDisplayConfig(skill);
          for (const warn of warnings) {
            console.warn(`[SkillLoader] Validation warning in ${skill.name}${warn.stepId ? `.${warn.stepId}` : ''}: ${warn.field} - ${warn.message} (value: ${warn.value})`);
          }

          this.skills.set(skill.name, skill);
          console.log(`[SkillLoader] Loaded skill: ${skill.name} (${skill.type})`);
        }
      } catch (error: any) {
        console.error(`[SkillLoader] Failed to load ${file}:`, error.message);
      }
    }
  }

  /**
   * 获取 skill
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 获取所有 skills
   */
  getAllSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Programmatically insert/override a skill definition.
   * Used for runtime-generated skills where YAML should be the single source of truth.
   */
  upsertSkill(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);

    // Keep moduleSkills map consistent
    if (skill.module) {
      this.moduleSkills.set(skill.name, skill);
    } else {
      this.moduleSkills.delete(skill.name);
    }
  }

  /**
   * 获取所有模块专家 skills
   */
  getAllModuleSkills(): SkillDefinition[] {
    return Array.from(this.moduleSkills.values());
  }

  /**
   * 根据模块层级查找 skills
   */
  findSkillsByLayer(layer: ModuleLayer): SkillDefinition[] {
    return Array.from(this.moduleSkills.values()).filter(
      (skill) => skill.module?.layer === layer
    );
  }

  /**
   * 根据组件名查找 skill
   */
  findSkillByComponent(component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) => skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据层级和组件查找 skill
   */
  findModuleSkill(layer: ModuleLayer, component: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find(
      (skill) =>
        skill.module?.layer === layer &&
        skill.module?.component.toLowerCase() === component.toLowerCase()
    );
  }

  /**
   * 根据对话能力查找 skill
   * 查找能够回答特定问题类型的模块
   */
  findSkillByCapability(capabilityId: string): SkillDefinition | undefined {
    return Array.from(this.moduleSkills.values()).find((skill) =>
      skill.dialogue?.capabilities?.some((cap) => cap.id === capabilityId)
    );
  }

  /**
   * 获取所有可用的对话能力
   */
  getAllCapabilities(): Array<{ skillName: string; capability: DialogueCapability }> {
    const capabilities: Array<{ skillName: string; capability: DialogueCapability }> = [];

    for (const skill of this.moduleSkills.values()) {
      if (skill.dialogue?.capabilities) {
        for (const cap of skill.dialogue.capabilities) {
          capabilities.push({ skillName: skill.name, capability: cap });
        }
      }
    }

    return capabilities;
  }

  /**
   * 检查 skill 是否为模块专家
   */
  isModuleSkill(skillName: string): boolean {
    return this.moduleSkills.has(skillName);
  }

  /**
   * 根据关键词匹配 skill
   */
  findMatchingSkill(question: string): SkillDefinition | undefined {
    const lowerQuestion = question.toLowerCase();

    for (const skill of this.skills.values()) {
      if (!skill.triggers) continue;

      // 检查关键词
      const keywords = skill.triggers.keywords;
      if (keywords) {
        let keywordList: string[] = [];

        if (Array.isArray(keywords)) {
          keywordList = keywords;
        } else {
          keywordList = [
            ...(keywords.zh || []),
            ...(keywords.en || []),
          ];
        }

        for (const keyword of keywordList) {
          if (lowerQuestion.includes(keyword.toLowerCase())) {
            return skill;
          }
        }
      }

      // 检查模式
      if (skill.triggers.patterns) {
        for (const pattern of skill.triggers.patterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(question)) {
              return skill;
            }
          } catch {
            // 无效的正则表达式，跳过
          }
        }
      }
    }

    return undefined;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 重新加载所有 skills
   */
  async reload(): Promise<void> {
    this.skills.clear();
    this.initialized = false;
    const skillsDir = path.resolve(__dirname, '../../../skills');
    await this.loadSkills(skillsDir);
  }
}

// 单例
export const skillRegistry = new SkillRegistry();

// =============================================================================
// 辅助函数
// =============================================================================

// Promise-based lock to prevent concurrent initialization
let initializationPromise: Promise<void> | null = null;

/**
 * 确保 skill registry 已初始化
 * NOTE: This function is safe to call concurrently - it will only initialize once
 */
export async function ensureSkillRegistryInitialized(): Promise<void> {
  // Fast path: already initialized
  if (skillRegistry.isInitialized()) return;

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization (only one caller will reach here)
  const skillsDir = path.resolve(__dirname, '../../../skills');
  initializationPromise = (async () => {
    await skillRegistry.loadSkills(skillsDir);

    // Runtime-generated skills (YAML-driven single source of truth)
    try {
      const generated = await generateRenderingPipelineDetectionSkill();
      skillRegistry.upsertSkill(generated);
      console.log(`[SkillLoader] Overrode skill with YAML-driven generator: ${generated.name} (v${generated.version})`);
    } catch (error: any) {
      console.warn('[SkillLoader] Failed to generate YAML-driven rendering pipeline detection skill:', error?.message || error);
    }
  })();

  try {
    await initializationPromise;
  } finally {
    // Clear the promise after completion (success or failure)
    // This allows retry on failure
    if (!skillRegistry.isInitialized()) {
      initializationPromise = null;
    }
  }
}

/**
 * 获取默认的 skills 目录
 */
export function getSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}
