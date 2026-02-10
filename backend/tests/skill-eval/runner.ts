/**
 * Skill Evaluator - 用于测试 Skill SQL 查询的执行框架
 *
 * 核心功能：
 * 1. 加载 trace 文件到 trace_processor
 * 2. 执行单个 skill 步骤并验证输出
 * 3. 执行完整 skill 并验证分层结果
 * 4. 清理资源
 */

import path from 'path';
import { TraceProcessorService } from '../../src/services/traceProcessorService';
import { SkillExecutor, createSkillExecutor, LayeredResult } from '../../src/services/skillEngine/skillExecutor';
import { SkillDefinition, StepResult, SkillExecutionResult, AtomicStep } from '../../src/services/skillEngine/types';
import yaml from 'js-yaml';
import fs from 'fs';

// =============================================================================
// Types
// =============================================================================

export interface EvalStepResult {
  success: boolean;
  stepId: string;
  data: any[];
  error?: string;
  executionTimeMs: number;
}

export interface EvalSkillResult {
  success: boolean;
  skillId: string;
  layers: LayeredResult['layers'];
  displayResults: any[];
  executionTimeMs: number;
  error?: string;
}

export interface NormalizedResult {
  layers: {
    overview: Record<string, { stepId: string; rowCount: number; hasData: boolean }>;
    list: Record<string, { stepId: string; rowCount: number; hasData: boolean }>;
    session: Record<string, Record<string, { stepId: string; rowCount: number; hasData: boolean }>>;
    deep: Record<string, Record<string, { stepId: string; rowCount: number; hasData: boolean }>>;
  };
  stepCount: number;
}

// =============================================================================
// SkillEvaluator Class
// =============================================================================

export class SkillEvaluator {
  private skillId: string;
  private traceId: string | null = null;
  private traceProcessor: TraceProcessorService;
  private executor: SkillExecutor | null = null;
  private skill: SkillDefinition | null = null;
  private availablePrerequisiteModules: string[] | null = null;
  private static sharedTraceProcessor: TraceProcessorService | null = null;

  constructor(skillId: string) {
    this.skillId = skillId;
    // 使用共享的 TraceProcessorService 实例，避免重复启动进程
    if (!SkillEvaluator.sharedTraceProcessor) {
      SkillEvaluator.sharedTraceProcessor = new TraceProcessorService(
        path.join(process.cwd(), 'uploads', 'test-traces')
      );
    }
    this.traceProcessor = SkillEvaluator.sharedTraceProcessor;
  }

  /**
   * 加载 trace 文件
   * @param tracePath 相对于项目根目录的路径，如 'test-traces/scrolling.pftrace'
   */
  async loadTrace(tracePath: string): Promise<void> {
    const absolutePath = path.resolve(process.cwd(), '..', tracePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Trace file not found: ${absolutePath}`);
    }

    console.log(`[SkillEvaluator] Loading trace: ${absolutePath}`);
    this.traceId = await this.traceProcessor.loadTraceFromFilePath(absolutePath);
    console.log(`[SkillEvaluator] Trace loaded with ID: ${this.traceId}`);
    this.availablePrerequisiteModules = null;

    // 创建 executor
    this.executor = createSkillExecutor(this.traceProcessor);

    // 加载 skill 定义
    await this.loadSkill();

    // 注册 skill
    if (this.skill) {
      this.executor.registerSkill(this.skill);
      // 也需要注册子 skills（如果有 iterator 步骤）
      await this.registerDependentSkills();
    }
  }

  /**
   * 加载 skill 定义
   */
  private async loadSkill(): Promise<void> {
    const skillsDir = path.join(process.cwd(), 'skills');

    // 搜索 skill 文件
    const searchDirs = ['atomic', 'composite', 'base'];

    for (const dir of searchDirs) {
      const dirPath = path.join(skillsDir, dir);
      if (!fs.existsSync(dirPath)) continue;

      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;

        const filePath = path.join(dirPath, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const skill = yaml.load(content) as SkillDefinition;

          if (skill && skill.name === this.skillId) {
            this.skill = skill;
            this.availablePrerequisiteModules = null;
            console.log(`[SkillEvaluator] Loaded skill: ${skill.name}`);
            return;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    throw new Error(`Skill not found: ${this.skillId}`);
  }

  /**
   * 注册依赖的子 skills（递归处理 skill/iterator/parallel/conditional 引用）
   */
  private async registerDependentSkills(): Promise<void> {
    if (!this.skill || !this.executor) return;

    const skillsDir = path.join(process.cwd(), 'skills');
    const visited = new Set<string>([this.skill.name]);
    const queue = [...this.collectReferencedSkills(this.skill.steps || [])];

    while (queue.length > 0) {
      const skillName = queue.shift();
      if (!skillName || visited.has(skillName)) continue;
      visited.add(skillName);

      const skill = await this.findAndLoadSkill(skillName, skillsDir);
      if (skill) {
        this.executor.registerSkill(skill);
        console.log(`[SkillEvaluator] Registered dependent skill: ${skillName}`);

        const nestedRefs = this.collectReferencedSkills(skill.steps || []);
        for (const ref of nestedRefs) {
          if (!visited.has(ref)) {
            queue.push(ref);
          }
        }
      } else {
        console.warn(`[SkillEvaluator] Dependent skill not found: ${skillName}`);
      }
    }
  }

  private collectReferencedSkills(steps: any[]): string[] {
    const refs = new Set<string>();
    for (const step of steps) {
      this.collectReferencedSkillsFromStep(step, refs);
    }
    return Array.from(refs);
  }

  private collectReferencedSkillsFromStep(step: any, refs: Set<string>): void {
    if (!step || typeof step !== 'object') return;

    if (typeof step.skill === 'string' && step.skill.trim().length > 0) {
      refs.add(step.skill.trim());
    }

    if (typeof step.item_skill === 'string' && step.item_skill.trim().length > 0) {
      refs.add(step.item_skill.trim());
    }

    if (Array.isArray(step.steps)) {
      for (const subStep of step.steps) {
        this.collectReferencedSkillsFromStep(subStep, refs);
      }
    }

    if (Array.isArray(step.conditions)) {
      for (const condition of step.conditions) {
        const thenBranch = condition?.then;
        if (typeof thenBranch === 'string' && thenBranch.trim().length > 0) {
          refs.add(thenBranch.trim());
        } else if (thenBranch && typeof thenBranch === 'object') {
          this.collectReferencedSkillsFromStep(thenBranch, refs);
        }
      }
    }

    const elseBranch = step.else;
    if (typeof elseBranch === 'string' && elseBranch.trim().length > 0) {
      refs.add(elseBranch.trim());
    } else if (elseBranch && typeof elseBranch === 'object') {
      this.collectReferencedSkillsFromStep(elseBranch, refs);
    }
  }

  /**
   * 查找并加载 skill
   */
  private async findAndLoadSkill(skillName: string, skillsDir: string): Promise<SkillDefinition | null> {
    const searchDirs = ['atomic', 'composite', 'base'];

    for (const dir of searchDirs) {
      const dirPath = path.join(skillsDir, dir);
      if (!fs.existsSync(dirPath)) continue;

      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (!file.endsWith('.skill.yaml') && !file.endsWith('.skill.yml')) continue;

        const filePath = path.join(dirPath, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const skill = yaml.load(content) as SkillDefinition;

          if (skill && skill.name === skillName) {
            return skill;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return null;
  }

  /**
   * 执行单个步骤
   * @param stepId 步骤 ID（如 'vsync_config', 'performance_summary'）
   */
  async executeStep(stepId: string, params: Record<string, any> = {}): Promise<EvalStepResult> {
    if (!this.executor || !this.traceId || !this.skill) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }

    const step = this.skill.steps?.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step not found: ${stepId}`);
    }

    // 使用 executeCompositeSkill 来执行完整上下文
    // 但只返回指定步骤的结果
    const result = await this.executor.executeCompositeSkill(
      this.skill,
      params,
      { traceId: this.traceId }
    );

    // 从分层结果中提取指定步骤
    const stepResult = this.findStepInLayers(result.layers, stepId);

    if (!stepResult) {
      return {
        success: false,
        stepId,
        data: [],
        error: `Step ${stepId} not found in results (may have been skipped due to condition)`,
        executionTimeMs: 0,
      };
    }

    return {
      success: stepResult.success,
      stepId,
      data: Array.isArray(stepResult.data) ? stepResult.data : [],
      error: stepResult.error,
      executionTimeMs: stepResult.executionTimeMs || 0,
    };
  }

  /**
   * 从分层结果中查找步骤
   */
  private findStepInLayers(layers: LayeredResult['layers'], stepId: string): StepResult | null {
    // 检查 overview
    if (layers.overview?.[stepId]) return layers.overview[stepId];

    // 检查 list
    if (layers.list?.[stepId]) return layers.list[stepId];

    // 检查 session
    for (const sessionData of Object.values(layers.session || {})) {
      if (sessionData[stepId]) {
        return sessionData[stepId];
      }
    }

    // 检查 deep
    for (const sessionData of Object.values(layers.deep || {})) {
      if (sessionData[stepId]) {
        return sessionData[stepId];
      }
    }

    return null;
  }

  /**
   * 执行完整 skill
   */
  async executeSkill(params: Record<string, any> = {}): Promise<EvalSkillResult> {
    if (!this.executor || !this.traceId || !this.skill) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }

    const startTime = Date.now();

    try {
      const result = await this.executor.executeCompositeSkill(
        this.skill,
        params,
        { traceId: this.traceId }
      );

      return {
        success: true,
        skillId: this.skillId,
        layers: result.layers,
        displayResults: [],
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        skillId: this.skillId,
        layers: { overview: {}, list: {}, session: {}, deep: {} },
        displayResults: [],
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 直接执行 SQL 查询（用于调试）
   */
  async executeSQL(sql: string): Promise<{ columns: string[]; rows: any[][]; error?: string }> {
    if (!this.traceId) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }

    const modules = await this.getAvailablePrerequisiteModules();
    const includePrefix = modules.length > 0
      ? `${modules.map(module => `INCLUDE PERFETTO MODULE ${module};`).join('\n')}\n`
      : '';

    const result = await this.traceProcessor.query(this.traceId, `${includePrefix}${sql}`);
    return {
      columns: result.columns,
      rows: result.rows,
      error: result.error,
    };
  }

  private resolvePrerequisiteModules(modules?: string[]): string[] {
    if (!Array.isArray(modules) || modules.length === 0) return [];

    const expanded: string[] = [];
    for (const moduleName of modules) {
      switch (moduleName) {
        case 'sched':
          expanded.push('sched.states', 'sched.runnable');
          break;
        case 'stack_profile':
          expanded.push('callstacks.stack_profile');
          break;
        case 'android.frames':
          expanded.push('android.frames.timeline', 'android.frames.jank_type');
          break;
        case 'android.frames.jank':
          expanded.push('android.frames.jank_type');
          break;
        default:
          expanded.push(moduleName);
      }
    }

    return Array.from(new Set(expanded));
  }

  private async getAvailablePrerequisiteModules(): Promise<string[]> {
    if (!this.traceId) return [];
    if (this.availablePrerequisiteModules !== null) {
      return this.availablePrerequisiteModules;
    }

    const resolved = this.resolvePrerequisiteModules(this.skill?.prerequisites?.modules || []);
    const available: string[] = [];

    for (const moduleName of resolved) {
      const includeResult = await this.traceProcessor.query(
        this.traceId,
        `INCLUDE PERFETTO MODULE ${moduleName};`
      );
      if (!includeResult.error) {
        available.push(moduleName);
      }
    }

    this.availablePrerequisiteModules = available;
    return available;
  }

  /**
   * 将结果规范化以用于快照测试
   * 移除时间戳、执行时间等不确定性字段
   */
  normalizeForSnapshot(result: EvalSkillResult): NormalizedResult {
    const normalize = (steps: Record<string, StepResult> | undefined) => {
      const normalized: Record<string, { stepId: string; rowCount: number; hasData: boolean }> = {};
      if (!steps) return normalized;

      for (const [key, step] of Object.entries(steps)) {
        normalized[key] = {
          stepId: step.stepId,
          rowCount: Array.isArray(step.data) ? step.data.length : 0,
          hasData: Array.isArray(step.data) ? step.data.length > 0 : !!step.data,
        };
      }
      return normalized;
    };

    const normalizeNested = (sessions: Record<string, Record<string, StepResult>> | undefined) => {
      const normalized: Record<string, Record<string, { stepId: string; rowCount: number; hasData: boolean }>> = {};
      if (!sessions) return normalized;

      for (const [sessionKey, steps] of Object.entries(sessions)) {
        normalized[sessionKey] = normalize(steps);
      }
      return normalized;
    };

    let stepCount = 0;
    const countSteps = (obj: any) => {
      if (typeof obj === 'object' && obj !== null) {
        for (const value of Object.values(obj)) {
          if (typeof value === 'object' && value !== null && 'stepId' in value) {
            stepCount++;
          } else {
            countSteps(value);
          }
        }
      }
    };
    countSteps(result.layers);

    return {
      layers: {
        overview: normalize(result.layers.overview),
        list: normalize(result.layers.list),
        session: normalizeNested(result.layers.session),
        deep: normalizeNested(result.layers.deep),
      },
      stepCount,
    };
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.traceId) {
      try {
        await this.traceProcessor.deleteTrace(this.traceId);
        console.log(`[SkillEvaluator] Cleaned up trace: ${this.traceId}`);
      } catch (e) {
        // 忽略清理错误
      }
      this.traceId = null;
      this.availablePrerequisiteModules = null;
    }
    this.executor = null;
    this.skill = null;
  }

  /**
   * 获取 skill 定义
   */
  getSkillDefinition(): SkillDefinition | null {
    return this.skill;
  }

  /**
   * 获取所有步骤 ID
   */
  getStepIds(): string[] {
    return this.skill?.steps?.map(s => s.id) || [];
  }
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 创建 SkillEvaluator 实例
 */
export function createSkillEvaluator(skillId: string): SkillEvaluator {
  return new SkillEvaluator(skillId);
}

/**
 * 获取测试 trace 文件路径
 */
export function getTestTracePath(traceName: string): string {
  return path.join('test-traces', traceName);
}
