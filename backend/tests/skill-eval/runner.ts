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
import { SkillDefinition, SkillStep, StepResult, SkillExecutionResult, SkillExecutionContext } from '../../src/services/skillEngine/types';
import { validateSkillInputs } from '../../src/services/skillEngine/skillValidator';
import { selectedStepResult } from '../../src/services/skillEngine/referencedSkillStep';
import { resultScopeProvenance } from '../../src/services/skillEngine/scopeEvidence';
import { normalizeSkillDefinition } from '../../src/services/skillEngine/skillLoader';
import { assertEffectiveProcessScope, createEffectiveProcessScope } from '../../src/services/processIdentity/effectiveProcessScope';
import { getEffectiveIdentityConfig, processSelectorKeys } from '../../src/services/processIdentity/identityGate';
import { sqlIsReadOnly } from '../../src/services/skillEngine/sqlStructure';
import { exactProcessScopeSupportCatalog, sqlRunBy, type ExactProcessScopeSupport, type ScopedSqlSource } from '../../src/services/skillEngine/processScopeSql';
import { boundSqlPlaceholders } from '../../src/services/skillEngine/sqlTemplate';
import type { EvidenceScopeProvenanceV1 } from '../../src/types/identityContract';
import yaml from 'js-yaml';
import fs from 'fs';
import { resolveTraceCase } from '../helpers/traceCorpus';

// =============================================================================
// Types
// =============================================================================

export interface EvalStepResult {
  success: boolean;
  stepId: string;
  data: any[];
  error?: string;
  code?: string;
  executionTimeMs: number;
  /** The process scope the step's evidence was produced under, as the executor recorded it. */
  scopeProvenance?: EvidenceScopeProvenanceV1;
  /**
   * The step's scope-isolation variants, for a step named in `scopeProbeStepIds`;
   * `open` only where an unscoped run executes the same SQL (no exact_sql),
   * `sibling` only when `scopeProbeSiblingUpid` names one.
   */
  scopeProbe?: {blanked: ScopeProbeOutcome; open?: ScopeProbeOutcome; sibling?: ScopeProbeOutcome};
}

export interface EvalSkillResult {
  success: boolean;
  skillId: string;
  layers: LayeredResult['layers'];
  displayResults: any[];
  executionTimeMs: number;
  error?: string;
}

export interface EvalStepSequenceOptions {
  /**
   * SQL contract probes may explicitly execute selected read-only SQL steps
   * even when their production condition is false. Callers must keep this
   * list manifest-backed; the default path always preserves conditions.
   */
  forceSqlStepIds?: readonly string[];
  /**
   * Steps whose scope-probe answers the results report. Naming any runs the
   * whole sequence in each probe run beside the production run
   * (scopeProbeContexts); the production context never sees their results.
   */
  scopeProbeStepIds?: readonly string[];
  /** A same-named instance of the run's exact UPID, probed as ScopeProbeVariant `sibling`. */
  scopeProbeSiblingUpid?: number;
}

/**
 * How a scope-isolation probe reruns a step sequence beside its production
 * run. `blanked` keeps the exact process scope and removes the process
 * selectors (processSelectorKeys), so a unit that still reads them under an
 * exact scope, itself or through an earlier step's result, sees its
 * every-process fallback. `open` also swaps in an unscoped scope: that
 * fallback itself, what every process in the trace carries. `sibling` is the
 * production run again, admitted from the same parameters under the UPID of
 * a same-named instance: a unit that selects by process name, which neither
 * stripping selectors nor dropping the scope can change, sees that instance's
 * rows in both runs.
 */
type ScopeProbeVariant = 'blanked' | 'open' | 'sibling';
type ScopeProbeContexts = Record<Exclude<ScopeProbeVariant, 'sibling'>, SkillExecutionContext> & {sibling?: SkillExecutionContext};

export type ScopeProbeOutcome = Pick<EvalStepResult, 'success' | 'code' | 'error' | 'data'>;

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
  private static skillRegistry: Map<string, SkillDefinition> | null = null;
  private static fragmentRegistry: Map<string, string> | null = null;

  constructor(skillId: string) {
    this.skillId = skillId;
    // 使用共享的 TraceProcessorService 实例，避免重复启动进程
    if (!SkillEvaluator.sharedTraceProcessor) {
      SkillEvaluator.sharedTraceProcessor = new TraceProcessorService(
        path.join(process.cwd(), 'uploads', 'trace-corpus-eval')
      );
    }
    this.traceProcessor = SkillEvaluator.sharedTraceProcessor;
  }

  /**
   * 加载 trace 文件
 * @param tracePath Trace catalog 解析出的绝对路径，或相对于项目根目录的路径
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

    await this.selectSkill(this.skillId);
  }

  /** Reuse the currently loaded trace while switching to another corpus Skill. */
  async selectSkill(skillId: string): Promise<void> {
    if (!this.traceId) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }
    this.skillId = skillId;
    this.skill = null;
    this.availablePrerequisiteModules = null;
    this.executor = createSkillExecutor(this.traceProcessor);
    this.executor.setFragmentRegistry(SkillEvaluator.loadFragmentRegistry(path.join(process.cwd(), 'skills')));
    await this.loadSkill();
    if (!this.skill) throw new Error(`Skill not found: ${skillId}`);
    this.executor.registerSkill(this.skill);
    await this.registerDependentSkills();
  }

  /**
   * 加载 skill 定义
   */
  private async loadSkill(): Promise<void> {
    const skillsDir = path.join(process.cwd(), 'skills');
    const skill = SkillEvaluator.getSkillRegistry(skillsDir).get(this.skillId);
    if (skill) {
      this.skill = skill;
      this.availablePrerequisiteModules = null;
      console.log(`[SkillEvaluator] Loaded skill: ${skill.name}`);
      return;
    }
    throw new Error(`Skill not found: ${this.skillId}`);
  }

  private static getSkillRegistry(skillsDir: string): Map<string, SkillDefinition> {
    if (SkillEvaluator.skillRegistry) return SkillEvaluator.skillRegistry;
    // An empty registry would read as "no Skill has exact SQL"; fail closed instead.
    if (!fs.existsSync(skillsDir)) throw new Error(`Skills directory not found: ${skillsDir}`);
    const registry = new Map<string, SkillDefinition>();
    const stack = [skillsDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '_template') stack.push(absolute);
          continue;
        }
        if (
          !entry.isFile()
          || entry.name.startsWith('_')
          || (!entry.name.endsWith('.skill.yaml') && !entry.name.endsWith('.skill.yml'))
        ) continue;
        try {
          const skill = normalizeSkillDefinition(
            yaml.load(fs.readFileSync(absolute, 'utf8')),
            absolute,
          );
          if (skill?.name && !registry.has(skill.name)) registry.set(skill.name, skill);
        } catch {
          // The normal Skill validators report malformed YAML with file context.
        }
      }
    }
    if (registry.size === 0) throw new Error(`No Skill definitions loaded from ${skillsDir}`);
    SkillEvaluator.skillRegistry = registry;
    return registry;
  }

  private static loadFragmentRegistry(skillsDir: string): Map<string, string> {
    if (SkillEvaluator.fragmentRegistry) return SkillEvaluator.fragmentRegistry;
    const fragmentsRoot = path.join(skillsDir, 'fragments');
    const registry = new Map<string, string>();
    if (!fs.existsSync(fragmentsRoot)) return registry;

    const stack = [fragmentsRoot];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
        } else if (entry.isFile() && entry.name.endsWith('.sql')) {
          const key = path.relative(skillsDir, absolute).split(path.sep).join('/');
          registry.set(key, fs.readFileSync(absolute, 'utf8'));
        }
      }
    }
    SkillEvaluator.fragmentRegistry = registry;
    return registry;
  }

  /**
   * 注册依赖的子 skills（递归处理 skill/iterator/parallel/conditional 引用）
   */
  private async registerDependentSkills(): Promise<void> {
    if (!this.skill || !this.executor) return;

    const skillsDir = path.join(process.cwd(), 'skills');
    const visited = new Set<string>([this.skill.name]);
    // Explicit UPID/PID selectors invoke the identity gate even without an
    // identity block. Root and nested Skills share this executor dependency.
    const queue = [...this.collectReferencedSkills(this.skill.steps || []), 'process_identity_resolver'];

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
    return SkillEvaluator.getSkillRegistry(skillsDir).get(skillName) ?? null;
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
    const stepResult = this.findStepInLayers(result.layers, stepId)
      || result.stepResults?.find(step => step.stepId === stepId)
      || null;

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
      data: this.extractStepData(stepResult),
      error: stepResult.error,
      code: stepResult.code,
      executionTimeMs: stepResult.executionTimeMs || 0,
    };
  }

  /**
   * Execute selected steps in order through SkillExecutor's real step path.
   * This avoids running an entire heavy composite while still exercising
   * input validation, prerequisite checks, conditions, SQL substitution, and
   * save_as context wiring between the requested steps.
   */
  async executeStepSequence(
    stepIds: string[],
    params: Record<string, any> = {},
    options: EvalStepSequenceOptions = {},
  ): Promise<EvalStepResult[]> {
    if (!this.executor || !this.traceId || !this.skill) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }

    const admitted = await this.admitStepSequence(params);
    const executor = this.executor as any;
    // Perfetto stdlib tables declared by a Skill do not exist until their
    // modules are included. Match the production execution order before
    // checking required_tables, otherwise valid module-owned tables look
    // absent in the regression harness.
    const moduleIncludes = await this.getAvailablePrerequisiteModules();
    const prereqCheck = await executor.checkPrerequisites(this.skill, this.traceId);
    if (!prereqCheck.success) {
      throw new Error(`Skipped: ${prereqCheck.error}`);
    }

    const context: SkillExecutionContext = {
      traceId: this.traceId,
      ...admitted,
      results: {},
      variables: {},
      variableScopes: {},
      variableSteps: {},
      moduleIncludes,
    };

    const results: EvalStepResult[] = [];
    const forcedSqlSteps = new Set(options.forceSqlStepIds || []);
    const probed = new Set(options.scopeProbeStepIds ?? []);
    // Steps after the last probed one feed no comparison, so the probe runs stop there.
    const lastProbed = Math.max(-1, ...stepIds.map((id, index) => probed.has(id) ? index : -1));
    const probes = probed.size
      ? await this.scopeProbeContexts(context, params, options.scopeProbeSiblingUpid) : undefined;
    for (const [index, stepId] of stepIds.entries()) {
      // A root-atomic Skill's SQL runs here as its one step. The production
      // root path is executeRootAtomic; this one serves the scope probe, whose
      // variants and baseline must share an execution path.
      const step = stepId === 'root' && this.skill.sql
        ? {id: 'root', type: 'atomic', sql: this.skill.sql, sql_fragments: this.skill.sql_fragments,
          process_scope: this.skill.process_scope, exact_sql: this.skill.exact_sql} as SkillStep
        : this.skill.steps?.find(s => s.id === stepId);
      if (!step) {
        throw new Error(`Step not found: ${stepId}`);
      }

      const shouldForceSql = forcedSqlSteps.has(stepId)
        && 'sql' in step
        && typeof step.sql === 'string';
      const executionStep = shouldForceSql
        ? { ...step, condition: undefined }
        : step;
      const stepResult = await executor.executeStep(executionStep, context, this.skill.name) as StepResult;
      this.recordStepResult(step, stepResult, context);
      const scopeProbe = probes && index <= lastProbed
        ? await this.runScopeProbeStep(executionStep, stepResult, probes, probed.has(stepId)) : undefined;

      results.push({
        success: stepResult.success,
        stepId,
        data: this.extractStepData(stepResult),
        error: stepResult.error,
        code: stepResult.code,
        executionTimeMs: stepResult.executionTimeMs || 0,
        scopeProvenance: resultScopeProvenance(stepResult),
        ...(scopeProbe ? {scopeProbe} : {}),
      });
    }

    return results;
  }

  /** Records a step's result and its save_as through production's own recording path. */
  private recordStepResult(step: SkillStep, result: StepResult, context: SkillExecutionContext): void {
    this.executor!['recordStepResult'](step, result, context);
  }

  /**
   * The production identity gate and input validation for `params`: what a
   * run of the sequence starts from.
   */
  private async admitStepSequence(params: Record<string, any>):
    Promise<Pick<SkillExecutionContext, 'params' | 'inherited' | 'processScope'>> {
    const gate = await this.executor!.prepareInvocation(this.skill!.name, this.traceId!, params);
    if (!gate.allowed) throw new Error(gate.error ?? 'Skill identity admission failed');
    if (!gate.processScope) throw new Error('Skill identity admission did not issue a process scope');
    assertEffectiveProcessScope(gate.processScope, this.traceId!, 'current');
    const validation = validateSkillInputs(this.skill!.name, this.skill!.inputs, gate.params);
    if (validation.errors.length > 0) {
      const msg = validation.errors.map(error => `${error.paramName}: ${error.message}`).join('; ');
      throw new Error(`Input validation failed: ${msg}`);
    }
    return {params: validation.params, inherited: gate.inherited, processScope: gate.processScope};
  }

  /**
   * The probe runs (ScopeProbeVariant), each starting with no results and
   * binding its own: a unit that takes its process from an earlier result is
   * judged through the choice its own run made, not the production run's.
   * `blanked` and `open` copy the production run's starting context; `sibling`
   * is admitted afresh from the caller's `params`, never the gate's rewrite of
   * them, which may have consumed the production UPID.
   */
  private async scopeProbeContexts(
    context: SkillExecutionContext,
    params: Record<string, any>,
    siblingUpid: number | undefined,
  ): Promise<ScopeProbeContexts> {
    const selectors = new Set(processSelectorKeys(getEffectiveIdentityConfig(this.skill!)));
    const strip = (values: Record<string, any> | undefined) =>
      Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => !selectors.has(key)));
    const copy = (processScope: SkillExecutionContext['processScope']): SkillExecutionContext => ({
      ...context, params: strip(context.params), inherited: strip(context.inherited),
      results: {}, variables: {}, variableScopes: {}, variableSteps: {}, processScope,
    });
    const contexts: ScopeProbeContexts = {
      blanked: copy(context.processScope),
      open: copy(createEffectiveProcessScope(this.traceId!, 'current')),
    };
    if (siblingUpid !== undefined) {
      const sibling = await this.admitStepSequence({...params, upid: siblingUpid});
      if (sibling.processScope?.mode !== 'exact_upid' || sibling.processScope.upid !== siblingUpid) {
        throw new Error(`Scope-isolation sibling UPID ${siblingUpid} was not admitted as an exact scope`);
      }
      contexts.sibling = {...context, ...sibling, results: {}, variables: {}, variableScopes: {}, variableSteps: {}};
    }
    return contexts;
  }

  /**
   * Runs `step` in each probe run and, when it is `probed`, returns what each
   * answered. The runs share the loaded trace, so SQL that writes state runs
   * once, and its production answer is theirs only when neither it nor its
   * fragments bind a placeholder (an idempotent fallback view): nothing of the
   * scope or a parameter can reach it. Unscoped, a step with an exact_sql runs
   * its named SQL, another statement, so its open answer is no comparison.
   */
  private async runScopeProbeStep(
    step: any,
    production: StepResult,
    probes: ScopeProbeContexts,
    probed: boolean,
  ): Promise<EvalStepResult['scopeProbe']> {
    const sources = (['exact', 'named'] as const).map(variant => sqlRunBy(step, variant))
      .filter((source): source is ScopedSqlSource => typeof source?.sql === 'string');
    if (!sources.every(source => sqlIsReadOnly(source.sql!))) {
      const fragments = SkillEvaluator.loadFragmentRegistry(path.join(process.cwd(), 'skills'));
      const bindsPlaceholder = sources.some(source => [source.sql!, ...(source.sql_fragments ?? [])
        .map(fragment => fragments.get(fragment) ?? '')].some(sql => boundSqlPlaceholders(sql).length > 0));
      if (probed || bindsPlaceholder) {
        throw new Error(`Scope-isolation probe of ${step.id} needs read-only step SQL`);
      }
      for (const context of Object.values(probes)) this.recordStepResult(step, production, context);
      return undefined;
    }
    const run = async (context: SkillExecutionContext): Promise<ScopeProbeOutcome> => {
      const result = await (this.executor as any).executeStep(step, context, this.skill!.name) as StepResult;
      this.recordStepResult(step, result, context);
      return {success: result.success, code: result.code, error: result.error, data: this.extractStepData(result)};
    };
    const blanked = await run(probes.blanked);
    const open = await run(probes.open);
    const sibling = probes.sibling && await run(probes.sibling);
    if (!probed) return undefined;
    return {
      blanked,
      ...(sqlRunBy(step, 'named') === sqlRunBy(step, 'exact') ? {open} : {}),
      ...(sibling ? {sibling} : {}),
    };
  }

  /** Execute a root-level atomic Skill through the production runtime path. */
  async executeRootAtomic(params: Record<string, any> = {}): Promise<EvalStepResult> {
    const result = await this.executeRuntimeSkill(params);
    if (!result.success) {
      return {
        success: false,
        stepId: 'root',
        data: [],
        error: result.error || 'Root atomic Skill execution failed',
        executionTimeMs: result.executionTimeMs || 0,
      };
    }

    const root = result.rawResults?.root;
    if (!root) {
      return {
        success: false,
        stepId: 'root',
        data: [],
        error: 'Root atomic Skill completed without rawResults.root',
        executionTimeMs: result.executionTimeMs || 0,
      };
    }

    return {
      success: root.success,
      stepId: 'root',
      data: this.extractStepData(root),
      error: root.error,
      code: root.code,
      executionTimeMs: root.executionTimeMs || result.executionTimeMs || 0,
      scopeProvenance: resultScopeProvenance(root),
    };
  }

  private extractStepData(stepResult: StepResult): any[] {
    // A `skill` reference step exposes the child step its save_as would bind.
    const data: any = selectedStepResult(stepResult).data;
    if (Array.isArray(data)) return data;
    // A diagnostic step's result is the list of rules it fired.
    return Array.isArray(data?.diagnostics) ? data.diagnostics : [];
  }

  /**
   * 从分层结果中查找步骤
   */
  private findStepInLayers(layers: LayeredResult['layers'], stepId: string): StepResult | null {
    // 检查 overview
    if (layers.overview?.[stepId]) return layers.overview[stepId];

    // 检查 list
    if (layers.list?.[stepId]) return layers.list[stepId];

    // 检查 diagnosis
    if (layers.diagnosis?.[stepId]) return layers.diagnosis[stepId];

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

  private collectResultSteps(result: LayeredResult): StepResult[] {
    const byId = new Map<string, StepResult>();
    for (const step of result.stepResults || []) {
      byId.set(step.stepId, step);
    }

    const steps: StepResult[] = [];
    for (const step of Object.values(result.layers.overview || {})) steps.push(step);
    for (const step of Object.values(result.layers.list || {})) steps.push(step);
    for (const step of Object.values(result.layers.diagnosis || {})) steps.push(step);
    for (const sessionData of Object.values(result.layers.session || {})) {
      for (const step of Object.values(sessionData)) steps.push(step);
    }
    for (const sessionData of Object.values(result.layers.deep || {})) {
      for (const step of Object.values(sessionData)) steps.push(step);
    }
    for (const step of steps) {
      byId.set(step.stepId, step);
    }
    return [...byId.values()];
  }

  /**
   * 执行完整 skill
   */
  async executeSkill(
    params: Record<string, any> = {},
  ): Promise<EvalSkillResult> {
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
      // A step whose condition was not met did not run; the executor carries
      // on past it (`code: 'condition_not_met'`), so it is no failure here.
      const failedSteps = this.collectResultSteps(result)
        .filter(step => !step.success && step.code !== 'condition_not_met');

      return {
        success: failedSteps.length === 0,
        skillId: this.skillId,
        layers: result.layers,
        displayResults: [],
        executionTimeMs: Date.now() - startTime,
        error: failedSteps.length > 0
          ? `Failed step(s): ${failedSteps.map(step => `${step.stepId}${step.error ? ` (${step.error})` : ''}`).join(', ')}`
          : undefined,
      };
    } catch (error: any) {
      return {
        success: false,
        skillId: this.skillId,
        layers: { overview: {}, list: {}, diagnosis: {}, session: {}, deep: {} },
        displayResults: [],
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  async executeRuntimeSkill(params: Record<string, any> = {}): Promise<SkillExecutionResult> {
    if (!this.executor || !this.traceId) {
      throw new Error('SkillEvaluator not initialized. Call loadTrace() first.');
    }

    return this.executor.execute(this.skillId, this.traceId, params);
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

  /** Every Skill the evaluator can select, normalized as the production loader does. */
  static listSkillDefinitions(): SkillDefinition[] {
    return [...SkillEvaluator.getSkillRegistry(path.join(process.cwd(), 'skills')).values()];
  }

  /** Whether the executor admits an exact UPID run of each Skill, by name (the admission closure). */
  static exactScopeSupportCatalog(): ReadonlyMap<string, ExactProcessScopeSupport> {
    const skillsDir = path.join(process.cwd(), 'skills');
    return exactProcessScopeSupportCatalog(
      SkillEvaluator.getSkillRegistry(skillsDir), SkillEvaluator.loadFragmentRegistry(skillsDir));
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
 * The trace a case is analyzed on, by case id or alias: a real case's committed
 * trace, or a constructed case's materialized base plus overlay.
 */
export function getTestTracePath(traceName: string): string {
  return resolveTraceCase(traceName, path.resolve(process.cwd(), '..'));
}

/**
 * `describe(name, fn)` over a Trace corpus case. Every case trace is committed
 * or materialized from committed overlays, so a case that does not resolve or a
 * trace that is not on disk fails the suite instead of skipping it: a skipped
 * suite asserts nothing while the gate stays green.
 */
export function describeWithTrace(
  suiteName: string,
  traceName: string,
  fn: () => void,
): void {
  const absolute = getTestTracePath(traceName);
  if (!fs.existsSync(absolute)) {
    throw new Error(`${suiteName}: trace ${traceName} is not on disk at ${absolute}; ` +
      'run `npm run trace:materialize` for a constructed case');
  }
  describe(suiteName, fn);
}

/** Find a step result across all 4 layer types (overview → list → session → deep). */
export function findStepInLayers(layers: any, stepId: string): { success?: boolean; error?: string; data?: any[] } | null {
  if (layers?.overview?.[stepId]) return layers.overview[stepId];
  if (layers?.list?.[stepId]) return layers.list[stepId];

  for (const sessionData of Object.values(layers?.session || {})) {
    const step = (sessionData as any)?.[stepId];
    if (step) return step;
  }
  for (const sessionData of Object.values(layers?.deep || {})) {
    const step = (sessionData as any)?.[stepId];
    if (step) return step;
  }
  return null;
}
