/**
 * Skill Loader
 *
 * 加载 skill 文件
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition } from './types';

// =============================================================================
// Skill Registry
// =============================================================================

class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map();
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

    this.initialized = true;
    console.log(`[SkillLoader] Loaded ${this.skills.size} skills`);
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

/**
 * 确保 skill registry 已初始化
 */
export async function ensureSkillRegistryInitialized(): Promise<void> {
  if (skillRegistry.isInitialized()) return;

  const skillsDir = path.resolve(__dirname, '../../../skills');
  await skillRegistry.loadSkills(skillsDir);
}

/**
 * 获取默认的 skills 目录
 */
export function getSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}

// =============================================================================
// 向后兼容别名 (deprecated)
// =============================================================================

/** @deprecated Use SkillRegistry instead */
export const SkillRegistryV2 = SkillRegistry;

/** @deprecated Use skillRegistry instead */
export const skillRegistryV2 = skillRegistry;

/** @deprecated Use ensureSkillRegistryInitialized instead */
export const ensureSkillRegistryV2Initialized = ensureSkillRegistryInitialized;
