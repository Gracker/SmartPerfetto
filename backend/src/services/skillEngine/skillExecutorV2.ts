/**
 * Skill Executor v2.0
 *
 * 核心执行引擎，支持：
 * - Skill 组合（composite）
 * - Skill 迭代（iterator）
 * - AI 协作（ai_decision, ai_summary）
 * - 诊断推理（diagnostic）
 * - 展示控制（display）
 */

import {
  SkillDefinitionV2,
  SkillStep,
  AtomicStep,
  SkillRefStep,
  IteratorStep,
  ParallelStep,
  DiagnosticStep,
  AIDecisionStep,
  AISummaryStep,
  ConditionalStep,
  SkillExecutionContextV2,
  SkillExecutionResultV2,
  StepResult,
  DisplayResult,
  DiagnosticResult,
  DisplayConfig,
  DisplayLevel,
  SkillEvent,
} from './types_v2';

// =============================================================================
// Layered Result Types
// =============================================================================

export interface LayeredResult {
  layers: {
    L1?: Record<string, StepResult>;
    L2?: Record<string, StepResult>;
    L3?: Record<string, Record<string, StepResult>>;
    L4?: Record<string, Record<string, StepResult>>;
  };
  defaultExpanded: ('L1' | 'L2' | 'L3' | 'L4')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}

// =============================================================================
// 表达式求值器
// =============================================================================

class ExpressionEvaluator {
  /**
   * 在上下文中求值表达式
   * 支持：${variable}、${step.field}、比较运算符等
   */
  static evaluate(expression: string, context: SkillExecutionContextV2): any {
    // 检查是否是完整的 ${...} 表达式（整个字符串被包裹）
    const fullExprMatch = expression.match(/^\$\{(.+)\}$/s);
    if (fullExprMatch) {
      // 这是一个 JavaScript 表达式，需要完整求值
      return this.evaluateJsExpression(fullExprMatch[1], context);
    }

    // 否则，做简单的变量替换
    let result = expression;

    // 替换 ${xxx} 格式的变量
    result = result.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const value = this.resolvePath(path, context);
      if (value === undefined) return match;
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });

    // 如果是简单的比较表达式，尝试求值
    if (/^[\d\.\s\+\-\*\/\>\<\=\!\&\|]+$/.test(result)) {
      try {
        // 安全地执行简单数学/比较表达式
        return new Function(`return ${result}`)();
      } catch {
        return result;
      }
    }

    return result;
  }

  /**
   * 评估 JavaScript 表达式
   * 例如: performance_summary.data[0]?.app_jank_rate > 10
   */
  private static evaluateJsExpression(expr: string, context: SkillExecutionContextV2): any {
    try {
      // 从表达式中提取根变量名
      const rootVarNames = this.extractRootVariables(expr);

      // 构建作用域对象
      const scope: Record<string, any> = {};

      for (const varName of rootVarNames) {
        // 从步骤结果中获取
        if (context.results[varName]) {
          scope[varName] = { data: context.results[varName].data };
        }
        // 从变量中获取
        else if (context.variables[varName] !== undefined) {
          scope[varName] = { data: context.variables[varName] };
        }
        // 从参数中获取
        else if (context.params[varName] !== undefined) {
          scope[varName] = context.params[varName];
        }
        // 从继承上下文中获取
        else if (context.inherited[varName] !== undefined) {
          scope[varName] = context.inherited[varName];
        }
        // 当前迭代项
        else if (varName === 'item' && context.currentItem) {
          scope[varName] = context.currentItem;
        }
      }

      // 构建并执行函数
      const varNames = Object.keys(scope);
      const varValues = Object.values(scope);

      if (varNames.length === 0) {
        // 没有变量，直接求值（纯表达式如 true, false, 数字比较）
        return new Function(`return ${expr}`)();
      }

      const fn = new Function(...varNames, `return ${expr}`);
      const result = fn(...varValues);

      return result;
    } catch (e: any) {
      console.warn('[ExpressionEvaluator] JS expression failed:', expr, e.message);
      return undefined;
    }
  }

  /**
   * 从表达式中提取根变量名
   * "performance_summary.data[0]?.app_jank_rate > 10" => ["performance_summary"]
   * "jank_stats.data.find(j => j.jank_type)" => ["jank_stats"]
   */
  private static extractRootVariables(expr: string): string[] {
    const varNames = new Set<string>();

    // 匹配标识符开头的词（不是关键字）
    const identifierRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    const jsKeywords = new Set([
      'true', 'false', 'null', 'undefined', 'if', 'else', 'return',
      'function', 'var', 'let', 'const', 'new', 'this', 'typeof',
      'instanceof', 'in', 'of', 'for', 'while', 'do', 'break', 'continue',
      'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw',
      'async', 'await', 'class', 'extends', 'super', 'import', 'export',
      'NaN', 'Infinity', 'Math', 'JSON', 'Array', 'Object', 'String',
      'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Map', 'Set',
    ]);

    let match;
    while ((match = identifierRegex.exec(expr)) !== null) {
      const name = match[1];
      // 跳过 JavaScript 关键字和内置对象
      if (!jsKeywords.has(name)) {
        // 检查是否是表达式开头或者在运算符后面（说明是根变量）
        const beforeMatch = expr.substring(0, match.index);
        const lastChar = beforeMatch.trim().slice(-1);
        // 如果之前没有 . 则是根变量
        if (lastChar !== '.') {
          varNames.add(name);
        }
      }
    }

    return Array.from(varNames);
  }

  /**
   * 解析路径引用，支持深层嵌套和数组索引
   * 例如: "step1.data[0].field" 或 "performance_summary.data[0].app_jank_rate"
   */
  static resolvePath(path: string, context: SkillExecutionContextV2): any {
    // 解析路径为 token 数组，支持 . 分隔和 [n] 数组索引
    const tokens = this.parsePath(path);
    if (tokens.length === 0) return undefined;

    const rootKey = tokens[0];

    // 获取根值
    let value: any;

    // 尝试从不同来源解析根值
    // 1. 当前迭代项
    if (rootKey === 'item' && context.currentItem) {
      value = context.currentItem;
    }
    // 2. 参数
    else if (context.params[rootKey] !== undefined) {
      value = context.params[rootKey];
    }
    // 3. 继承的上下文
    else if (context.inherited[rootKey] !== undefined) {
      value = context.inherited[rootKey];
    }
    // 4. 变量（save_as 保存的）- 也需要包装以支持 .data[0].field 访问
    else if (context.variables[rootKey] !== undefined) {
      // 如果路径包含 .data，需要包装；否则直接返回
      const nextToken = tokens[1];
      if (nextToken === 'data') {
        value = { data: context.variables[rootKey] };
      } else {
        // 直接访问数组元素，如 ${main_slices[0].name}
        value = context.variables[rootKey];
      }
    }
    // 5. 步骤结果 - 返回包装对象以支持 .data[0].field 访问
    else if (context.results[rootKey]) {
      // 返回包含 data 属性的对象，这样 ${main_slices.data[0].name} 才能正确解析
      value = { data: context.results[rootKey].data };
    }
    else {
      return undefined;
    }

    // 遍历剩余 token 解析深层路径
    for (let i = 1; i < tokens.length; i++) {
      if (value == null) return undefined;
      const token = tokens[i];

      // 处理数组索引 (纯数字)
      if (/^\d+$/.test(token)) {
        const index = parseInt(token, 10);
        if (!Array.isArray(value)) return undefined;
        value = value[index];
      } else {
        // 处理对象属性
        value = value[token];
      }
    }

    return value;
  }

  /**
   * 解析路径字符串为 token 数组
   * "step.data[0].field" => ["step", "data", "0", "field"]
   */
  private static parsePath(path: string): string[] {
    const tokens: string[] = [];
    let current = '';

    for (let i = 0; i < path.length; i++) {
      const char = path[i];

      if (char === '.') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else if (char === '[') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else if (char === ']') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * 评估条件表达式，返回 boolean
   */
  static evaluateCondition(condition: string, context: SkillExecutionContextV2): boolean {
    const result = this.evaluate(condition, context);
    return Boolean(result);
  }
}

// =============================================================================
// SQL 变量替换
// =============================================================================

function substituteVariables(sql: string, context: SkillExecutionContextV2): string {
  let result = sql;

  // 替换所有 ${xxx} 格式的变量
  result = result.replace(/\$\{([^}]+)\}/g, (match, path) => {
    const value = ExpressionEvaluator.resolvePath(path, context);
    if (value === undefined) {
      // 对于简单变量名（如 package），默认返回空字符串
      // 这样 WHERE 子句中的 '${package}' = '' 会正确匹配
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(path)) {
        return '';
      }
      console.warn(`[SkillExecutorV2] Variable not found: ${path}`);
      return match;
    }
    return String(value);
  });

  return result;
}

// =============================================================================
// Layer Organization Functions
// =============================================================================

function organizeByLayer(steps: StepResult[]): LayeredResult['layers'] {
  const layers: LayeredResult['layers'] = {
    L1: {},
    L2: {},
    L3: {},
    L4: {}
  };

  for (const step of steps) {
    const layer = step.display?.layer;
    if (!layer) continue;

    switch (layer) {
      case 'L1':
      case 'L2':
        const targetLayer = layers[layer];
        if (targetLayer) {
          targetLayer[step.stepId] = step;
        }
        break;
      case 'L3':
        // L3 数据需要按 session_id 组织
        // 从 step.data 中提取 session_id
        const l3 = layers.L3;
        if (l3) {
          const sessionId3 = extractSessionId(step);
          if (!l3[sessionId3]) {
            l3[sessionId3] = {};
          }
          l3[sessionId3][step.stepId] = step;
        }
        break;
      case 'L4':
        // L4 数据需要按 session_id 和 frame_id 组织
        const l4 = layers.L4;
        if (l4) {
          const sessionId4 = extractSessionId(step);
          const frameId = extractFrameId(step);
          if (!l4[sessionId4]) {
            l4[sessionId4] = {};
          }
          l4[sessionId4][frameId] = step;
        }
        break;
    }
  }

  return layers;
}

function extractSessionId(step: StepResult): string {
  // 尝试从 step.data 中提取 session_id
  if (Array.isArray(step.data) && step.data.length > 0) {
    return `session_${step.data[0].session_id ?? 0}`;
  }
  return 'session_0';
}

function extractFrameId(step: StepResult): string {
  // 尝试从 step 中提取 frame_id
  if (step.stepId.startsWith('frame_')) {
    return step.stepId;
  }
  if (Array.isArray(step.data) && step.data.length > 0) {
    return `frame_${step.data[0].frame_index ?? step.data[0].frame_id ?? 0}`;
  }
  return 'frame_0';
}

// =============================================================================
// Skill Executor V2
// =============================================================================

export class SkillExecutorV2 {
  private traceProcessor: any;
  private aiService: any;  // AI 服务（用于 ai_decision, ai_summary）
  private skillRegistry: Map<string, SkillDefinitionV2>;
  private eventEmitter?: (event: SkillEvent) => void;

  constructor(
    traceProcessor: any,
    aiService?: any,
    eventEmitter?: (event: SkillEvent) => void
  ) {
    this.traceProcessor = traceProcessor;
    this.aiService = aiService;
    this.eventEmitter = eventEmitter;
    this.skillRegistry = new Map();
  }

  /**
   * 注册 skill
   */
  registerSkill(skill: SkillDefinitionV2): void {
    this.skillRegistry.set(skill.name, skill);
  }

  /**
   * 批量注册 skills
   */
  registerSkills(skills: SkillDefinitionV2[]): void {
    for (const skill of skills) {
      this.registerSkill(skill);
    }
  }

  /**
   * 发送事件到前端
   */
  private emit(event: Omit<SkillEvent, 'timestamp'>): void {
    if (this.eventEmitter) {
      this.eventEmitter({
        ...event,
        timestamp: Date.now(),
      } as SkillEvent);
    }
  }

  /**
   * 执行 skill
   */
  async execute(
    skillId: string,
    traceId: string,
    params: Record<string, any> = {},
    inherited: Record<string, any> = {}
  ): Promise<SkillExecutionResultV2> {
    const startTime = Date.now();

    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      return {
        skillId,
        skillName: skillId,
        success: false,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: Date.now() - startTime,
        error: `Skill not found: ${skillId}`,
      };
    }

    this.emit({
      type: 'skill_started',
      skillId,
      data: { skillName: skill.meta.display_name },
    });

    // 创建执行上下文
    const context: SkillExecutionContextV2 = {
      traceId,
      params,
      inherited,
      results: {},
      variables: {},
    };

    // 加载必要的模块
    if (skill.prerequisites?.modules) {
      for (const module of skill.prerequisites.modules) {
        try {
          await this.traceProcessor.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
        } catch (e: any) {
          console.warn(`[SkillExecutorV2] Module not available: ${module}`);
        }
      }
    }

    try {
      const displayResults: DisplayResult[] = [];
      const diagnostics: DiagnosticResult[] = [];
      let aiSummary: string | undefined;

      // 根据 skill 类型执行
      switch (skill.type) {
        case 'atomic':
          const atomicResult = await this.executeAtomicSkill(skill, context);
          if (atomicResult.display) {
            displayResults.push(this.createDisplayResult('root', skill.meta.display_name, atomicResult, skill.output?.display));
          }
          break;

        case 'composite':
        case 'iterator':
        case 'diagnostic':
          if (skill.steps) {
            for (const step of skill.steps) {
              const stepResult = await this.executeStep(step, context, skillId);

              if (stepResult.success) {
                // 保存结果
                context.results[step.id] = stepResult;

                // 如果有 save_as，保存到变量
                if ('save_as' in step && step.save_as) {
                  context.variables[step.save_as] = stepResult.data;
                }

                // 收集需要展示的结果
                if (this.shouldDisplay(step)) {
                  displayResults.push(this.createDisplayResult(
                    step.id,
                    ('name' in step ? step.name : step.id) || step.id,
                    stepResult,
                    this.getDisplayConfig(step),
                    ('sql' in step ? (step as AtomicStep).sql : undefined)
                  ));
                }

                // 收集诊断结果
                if (step.type === 'diagnostic' && stepResult.data?.diagnostics) {
                  diagnostics.push(...stepResult.data.diagnostics);
                }

                // 收集 AI 总结
                if (step.type === 'ai_summary' && stepResult.data?.summary) {
                  aiSummary = stepResult.data.summary;
                }
              }
            }
          }
          break;
      }

      this.emit({
        type: 'skill_completed',
        skillId,
        data: {
          success: true,
          displayResultsCount: displayResults.length,
          diagnosticsCount: diagnostics.length,
        },
      });

      return {
        skillId,
        skillName: skill.meta.display_name,
        success: true,
        displayResults,
        diagnostics,
        aiSummary,
        rawResults: context.results,
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error: any) {
      this.emit({
        type: 'skill_error',
        skillId,
        data: { error: error.message },
      });

      return {
        skillId,
        skillName: skill.meta.display_name,
        success: false,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute composite skill and return layered results
   * This is an alternative execution path that organizes output by layers (L1/L2/L3/L4)
   */
  async executeCompositeSkill(
    skill: SkillDefinitionV2,
    inputs: Record<string, any>,
    context: Partial<SkillExecutionContextV2>
  ): Promise<LayeredResult> {
    const startTime = Date.now();

    // Validate input
    if (!skill) {
      throw new Error('Skill definition is required');
    }

    if (!skill.steps || skill.steps.length === 0) {
      return {
        layers: { L1: {}, L2: {}, L3: {}, L4: {} },
        defaultExpanded: ['L1', 'L2'],
        metadata: {
          skillName: 'unknown',
          version: 'unknown',
          executedAt: new Date().toISOString()
        }
      };
    }

    // Create execution context
    const execContext: SkillExecutionContextV2 = {
      traceId: context.traceId || '',
      params: inputs,
      inherited: context.inherited || {},
      results: {},
      variables: {},
    };

    // Execute all steps
    const stepResults: StepResult[] = [];
    if (skill.steps) {
      for (const step of skill.steps) {
        const stepResult = await this.executeStep(step, execContext, skill.name);

        // Save result to context
        if (stepResult.success) {
          execContext.results[step.id] = stepResult;

          // Save to variables if save_as is specified
          if ('save_as' in step && step.save_as) {
            execContext.variables[step.save_as] = stepResult.data;
          }
        }

        stepResults.push(stepResult);
      }
    }

    // Return layered structure
    return {
      layers: organizeByLayer(stepResults),
      defaultExpanded: ['L1', 'L2'],
      metadata: {
        skillName: skill.name,
        version: skill.version || '1.0.0',
        executedAt: new Date().toISOString()
      }
    };
  }

  /**
   * 执行原子 skill（单个 SQL）
   */
  private async executeAtomicSkill(
    skill: SkillDefinitionV2,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();

    if (!skill.sql) {
      return {
        stepId: 'root',
        stepType: 'atomic',
        success: false,
        error: 'No SQL defined for atomic skill',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const sql = substituteVariables(skill.sql, context);

    try {
      const result = await this.traceProcessor.query(context.traceId, sql);

      if (result.error) {
        return {
          stepId: 'root',
          stepType: 'atomic',
          success: false,
          error: result.error,
          executionTimeMs: Date.now() - startTime,
        };
      }

      return {
        stepId: 'root',
        stepType: 'atomic',
        success: true,
        data: this.rowsToObjects(result.columns, result.rows),
        executionTimeMs: Date.now() - startTime,
        display: skill.output?.display,
      };

    } catch (error: any) {
      return {
        stepId: 'root',
        stepType: 'atomic',
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(
    step: SkillStep,
    context: SkillExecutionContextV2,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    this.emit({
      type: 'step_started',
      skillId: parentSkillId,
      stepId: step.id,
      data: { stepType: step.type },
    });

    let result: StepResult;

    try {
      switch (step.type) {
        case 'atomic':
          result = await this.executeAtomicStep(step, context);
          break;

        case 'iterator':
          result = await this.executeIteratorStep(step, context, parentSkillId);
          break;

        case 'parallel':
          result = await this.executeParallelStep(step, context, parentSkillId);
          break;

        case 'diagnostic':
          result = await this.executeDiagnosticStep(step, context);
          break;

        case 'ai_decision':
          result = await this.executeAIDecisionStep(step, context);
          break;

        case 'ai_summary':
          result = await this.executeAISummaryStep(step, context);
          break;

        case 'conditional':
          result = await this.executeConditionalStep(step, context, parentSkillId);
          break;

        default:
          // 默认作为 skill 引用处理
          const unknownStep = step as SkillStep;
          if ('skill' in unknownStep) {
            result = await this.executeSkillRefStep(unknownStep as SkillRefStep, context);
          } else {
            result = {
              stepId: unknownStep.id,
              stepType: 'atomic',
              success: false,
              error: `Unknown step type: ${(unknownStep as any).type}`,
              executionTimeMs: Date.now() - startTime,
            };
          }
      }
    } catch (error: any) {
      const failedStep = step as SkillStep;
      result = {
        stepId: failedStep.id,
        stepType: failedStep.type || 'skill',
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }

    this.emit({
      type: 'step_completed',
      skillId: parentSkillId,
      stepId: step.id,
      data: { success: result.success, error: result.error },
    });

    return result;
  }

  /**
   * 执行原子步骤
   */
  private async executeAtomicStep(
    step: AtomicStep,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();
    const sql = substituteVariables(step.sql, context);

    console.log(`[SkillExecutorV2] Executing atomic step: ${step.id}`);
    console.log(`[SkillExecutorV2] SQL: ${sql.substring(0, 200)}...`);

    try {
      const result = await this.traceProcessor.query(context.traceId, sql);

      if (result.error) {
        if (step.optional) {
          return {
            stepId: step.id,
            stepType: 'atomic',
            success: true,
            data: [],
            executionTimeMs: Date.now() - startTime,
          };
        }
        return {
          stepId: step.id,
          stepType: 'atomic',
          success: false,
          error: result.error,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const data = this.rowsToObjects(result.columns, result.rows);
      console.log(`[SkillExecutorV2] Step ${step.id} returned ${data.length} rows`);

      return {
        stepId: step.id,
        stepType: 'atomic',
        success: true,
        data,
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error: any) {
      if (step.optional) {
        return {
          stepId: step.id,
          stepType: 'atomic',
          success: true,
          data: [],
          executionTimeMs: Date.now() - startTime,
        };
      }
      throw error;
    }
  }

  /**
   * 执行 skill 引用步骤
   */
  private async executeSkillRefStep(
    step: SkillRefStep,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();

    // 构建子 skill 的参数
    const params: Record<string, any> = {};
    if (step.params) {
      for (const [key, value] of Object.entries(step.params)) {
        if (typeof value === 'string' && value.startsWith('${')) {
          params[key] = ExpressionEvaluator.evaluate(value, context);
        } else {
          params[key] = value;
        }
      }
    }

    // 执行子 skill
    const result = await this.execute(
      step.skill,
      context.traceId,
      params,
      { ...context.inherited, ...context.variables }
    );

    return {
      stepId: step.id,
      stepType: 'skill',
      success: result.success,
      data: result,
      error: result.error,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行迭代步骤
   */
  private async executeIteratorStep(
    step: IteratorStep,
    context: SkillExecutionContextV2,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    // 获取数据源
    const source = context.variables[step.source] || context.results[step.source]?.data;
    if (!source || !Array.isArray(source)) {
      return {
        stepId: step.id,
        stepType: 'iterator',
        success: false,
        error: `Iterator source not found or not an array: ${step.source}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    console.log(`[SkillExecutorV2] Iterator step ${step.id}: ${source.length} items`);

    const results: any[] = [];
    const maxItems = step.max_items || 100;  // 性能保护
    const items = source.slice(0, maxItems);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // 构建子 skill 的参数
      const params: Record<string, any> = {};
      if (step.item_params) {
        for (const [key, path] of Object.entries(step.item_params)) {
          params[key] = item[path] ?? path;
        }
      } else {
        // 默认将 item 的所有字段作为参数
        Object.assign(params, item);
      }

      // 设置当前迭代项
      const iterContext = { ...context };
      iterContext.currentItem = item;
      iterContext.currentItemIndex = i;

      // 执行子 skill
      const itemResult = await this.execute(
        step.item_skill,
        context.traceId,
        params,
        { ...context.inherited, ...context.variables, item }
      );

      if (itemResult.success) {
        results.push({
          itemIndex: i,
          item,
          result: itemResult,
        });
      }
    }

    return {
      stepId: step.id,
      stepType: 'iterator',
      success: true,
      data: results,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行并行步骤
   */
  private async executeParallelStep(
    step: ParallelStep,
    context: SkillExecutionContextV2,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    const promises = step.steps.map(subStep =>
      this.executeStep(subStep, context, parentSkillId)
    );

    const results = await Promise.all(promises);
    const allSuccess = results.every(r => r.success);

    // 将结果存入 context
    const data: Record<string, any> = {};
    for (let i = 0; i < step.steps.length; i++) {
      const subStep = step.steps[i];
      data[subStep.id] = results[i].data;
      context.results[subStep.id] = results[i];
    }

    return {
      stepId: step.id,
      stepType: 'parallel',
      success: allSuccess,
      data,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行诊断步骤
   */
  private async executeDiagnosticStep(
    step: DiagnosticStep,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();
    const diagnostics: DiagnosticResult[] = [];

    // 收集输入数据
    const inputs: Record<string, any> = {};
    for (const inputName of step.inputs) {
      inputs[inputName] = context.variables[inputName] || context.results[inputName]?.data;
    }

    // 评估规则
    for (const rule of step.rules) {
      const conditionResult = ExpressionEvaluator.evaluateCondition(rule.condition, context);

      if (conditionResult) {
        const confidence = typeof rule.confidence === 'number'
          ? rule.confidence
          : rule.confidence === 'high' ? 0.9 : rule.confidence === 'medium' ? 0.7 : 0.5;

        // Substitute variables in diagnosis message
        const diagnosis = ExpressionEvaluator.evaluate(rule.diagnosis, context);

        diagnostics.push({
          id: `${step.id}_${diagnostics.length}`,
          diagnosis,
          confidence,
          severity: confidence >= 0.8 ? 'critical' : confidence >= 0.6 ? 'warning' : 'info',
          suggestions: rule.suggestions,
          source: 'rule',
        });
      }
    }

    // 如果没有匹配的规则且配置了 AI 辅助，调用 AI
    if (diagnostics.length === 0 && step.ai_assist && step.fallback && this.aiService) {
      const aiResult = await this.callAI(step.fallback.prompt, context);
      if (aiResult) {
        diagnostics.push({
          id: `${step.id}_ai`,
          diagnosis: aiResult,
          confidence: 0.6,
          severity: 'info',
          source: 'ai',
        });
      }
    }

    return {
      stepId: step.id,
      stepType: 'diagnostic',
      success: true,
      data: { diagnostics, inputs },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行 AI 决策步骤
   */
  private async executeAIDecisionStep(
    step: AIDecisionStep,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();

    if (!this.aiService) {
      return {
        stepId: step.id,
        stepType: 'ai_decision',
        success: false,
        error: 'AI service not available',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const prompt = ExpressionEvaluator.evaluate(step.prompt, context);

    this.emit({
      type: 'ai_thinking',
      skillId: '',
      stepId: step.id,
      data: { prompt },
    });

    const response = await this.callAI(prompt, context);

    this.emit({
      type: 'ai_response',
      skillId: '',
      stepId: step.id,
      data: { response },
    });

    return {
      stepId: step.id,
      stepType: 'ai_decision',
      success: true,
      data: { decision: response },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行 AI 总结步骤
   */
  private async executeAISummaryStep(
    step: AISummaryStep,
    context: SkillExecutionContextV2
  ): Promise<StepResult> {
    const startTime = Date.now();

    if (!this.aiService) {
      return {
        stepId: step.id,
        stepType: 'ai_summary',
        success: false,
        error: 'AI service not available',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const prompt = ExpressionEvaluator.evaluate(step.prompt, context);

    this.emit({
      type: 'ai_thinking',
      skillId: '',
      stepId: step.id,
      data: { prompt },
    });

    const response = await this.callAI(prompt, context);

    this.emit({
      type: 'ai_response',
      skillId: '',
      stepId: step.id,
      data: { response },
    });

    return {
      stepId: step.id,
      stepType: 'ai_summary',
      success: true,
      data: { summary: response },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行条件步骤
   */
  private async executeConditionalStep(
    step: ConditionalStep,
    context: SkillExecutionContextV2,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    // 评估条件
    for (const condition of step.conditions) {
      if (ExpressionEvaluator.evaluateCondition(condition.when, context)) {
        if (typeof condition.then === 'string') {
          // skill 引用
          return this.executeSkillRefStep({
            id: step.id,
            skill: condition.then,
          }, context);
        } else {
          // 内联步骤
          return this.executeStep(condition.then, context, parentSkillId);
        }
      }
    }

    // 默认分支
    if (step.else) {
      if (typeof step.else === 'string') {
        return this.executeSkillRefStep({
          id: step.id,
          skill: step.else,
        }, context);
      } else {
        return this.executeStep(step.else, context, parentSkillId);
      }
    }

    return {
      stepId: step.id,
      stepType: 'conditional',
      success: true,
      data: null,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 调用 AI 服务
   */
  private async callAI(prompt: string, context: SkillExecutionContextV2): Promise<string> {
    if (!this.aiService) {
      return '';
    }

    try {
      // TODO: 实现实际的 AI 调用
      const response = await this.aiService.chat(prompt);
      return response;
    } catch (error: any) {
      console.error('[SkillExecutorV2] AI call failed:', error.message);
      return '';
    }
  }

  /**
   * 判断步骤是否需要展示
   */
  private shouldDisplay(step: SkillStep): boolean {
    if (!('display' in step)) return false;
    const display = step.display;
    if (display === false) return false;
    if (display === true) return true;
    if (typeof display === 'object') {
      return display.show !== false && display.level !== 'none';
    }
    return false;
  }

  /**
   * 获取步骤的展示配置
   */
  private getDisplayConfig(step: SkillStep): DisplayConfig | undefined {
    if (!('display' in step)) return undefined;
    const display = step.display;
    if (typeof display === 'boolean') {
      return display ? { show: true, level: 'summary' } : undefined;
    }
    return display;
  }

  /**
   * 创建展示结果
   */
  private createDisplayResult(
    stepId: string,
    title: string,
    stepResult: StepResult,
    displayConfig?: DisplayConfig,
    sql?: string
  ): DisplayResult {
    const config = displayConfig || { level: 'summary', format: 'table' };
    const data = stepResult.data;

    // 根据数据类型确定展示格式
    let displayData: DisplayResult['data'];

    if (Array.isArray(data) && data.length > 0) {
      // 检查是否是 iterator 结果（包含 itemIndex, item, result）
      if (this.isIteratorResult(data)) {
        displayData = this.flattenIteratorResults(data, stepResult.stepType === 'iterator');
      } else {
        // 普通数组 - 转换为表格格式
        const firstItem = data[0];
        if (typeof firstItem === 'object' && firstItem !== null) {
          const columns = Object.keys(firstItem);
          const rows = data.map(row => columns.map(col => this.formatCellValue(row[col])));
          displayData = { columns, rows };
        } else {
          // 简单数组
          displayData = { columns: ['value'], rows: data.map(v => [this.formatCellValue(v)]) };
        }
      }
    } else if (typeof data === 'string') {
      displayData = { text: data };
    } else if (data === null || data === undefined) {
      displayData = { text: '无数据' };
    } else if (typeof data === 'object') {
      // 单个对象 - 转换为键值对表格
      const columns = ['属性', '值'];
      const rows = Object.entries(data).map(([key, value]) => [key, this.formatCellValue(value)]);
      displayData = { columns, rows };
    } else {
      displayData = { text: String(data) };
    }

    return {
      stepId,
      title: config.title || title,
      level: config.level || 'summary',
      layer: config.layer,         // 新增：返回分层层级
      format: config.format || 'table',
      data: displayData,
      highlight: config.highlight,
      sql,  // 保存原始 SQL
    };
  }

  /**
   * 检查数据是否是迭代器结果
   */
  private isIteratorResult(data: any[]): boolean {
    if (data.length === 0) return false;
    const first = data[0];
    return typeof first === 'object' && first !== null &&
           'itemIndex' in first && 'item' in first && 'result' in first;
  }

  /**
   * 将迭代器结果展平为可显示的表格
   */
  private flattenIteratorResults(data: any[], _isIterator: boolean): DisplayResult['data'] {
    if (data.length === 0) {
      return { text: '无迭代结果' };
    }

    // 从 item 中提取关键字段用于显示
    const firstItem = data[0].item;
    const itemKeys = Object.keys(firstItem).filter(key => {
      // 过滤掉太长的字段（如 ts_str 可以保留，但很长的 JSON 字段不要）
      const value = firstItem[key];
      if (typeof value === 'string' && value.length > 200) return false;
      if (typeof value === 'object' && value !== null) return false;
      return true;
    }).slice(0, 6); // 最多显示 6 列

    // 添加一个"状态"列
    const columns = ['#', ...itemKeys, '分析状态'];
    const rows = data.map((iterItem, idx) => {
      const row: (string | number)[] = [idx + 1];
      for (const key of itemKeys) {
        row.push(this.formatCellValue(iterItem.item[key]));
      }
      // 添加状态
      row.push(iterItem.result?.success ? '✓ 完成' : '✗ 失败');
      return row;
    });

    // 提取可展开的详细数据 - 使用 displayResults 而不是 sections
    const expandableData = data.map((iterItem, idx) => ({
      item: iterItem.item,
      result: {
        success: iterItem.result?.success ?? false,
        // 将 displayResults 转换为 sections 格式
        sections: this.convertDisplayResultsToSections(iterItem.result?.displayResults || []),
        error: iterItem.result?.error,
      },
    }));

    // 生成汇总报告
    const summary = this.generateIteratorSummary(data, expandableData);

    return { columns, rows, expandableData, summary };
  }

  /**
   * 生成迭代器结果的汇总报告
   */
  private generateIteratorSummary(
    data: any[],
    expandableData: Array<{ item: Record<string, any>; result: { success: boolean; sections?: Record<string, any>; error?: string } }>
  ): { title: string; content: string } | undefined {
    if (data.length === 0) return undefined;

    const successCount = expandableData.filter(d => d.result.success).length;
    const failCount = data.length - successCount;

    // 尝试从 sections 中提取关键指标生成汇总
    const summaryLines: string[] = [];
    summaryLines.push(`**掉帧分析汇总**`);
    summaryLines.push('');
    summaryLines.push(`共分析 ${data.length} 个掉帧帧，成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}。`);
    summaryLines.push('');

    // 收集所有帧的关键发现
    const keyFindings: string[] = [];
    for (const { item, result } of expandableData) {
      if (!result.success || !result.sections) continue;

      const frameId = item.frame_id || item.id || '?';
      const jankType = item.jank_type || 'Unknown';
      const durMs = item.dur_ms || 0;

      // 从各个 section 中提取关键信息
      const frameFindings: string[] = [];

      // 主线程耗时操作
      const mainSlices = result.sections.main_slices || result.sections['主线程耗时操作'];
      if (mainSlices?.data && mainSlices.data.length > 0) {
        const topSlice = mainSlices.data[0];
        frameFindings.push(`主线程 "${topSlice.name}" 耗时 ${topSlice.total_ms}ms`);
      }

      // CPU 频率变化时间线
      const freqTimeline = result.sections.freq_timeline || result.sections['主线程操作CPU频率变化'];
      if (freqTimeline?.data && freqTimeline.data.length > 0) {
        const topFreq = freqTimeline.data[0];
        if (topFreq.freq_timeline && topFreq.state_count > 2) {
          frameFindings.push(`${topFreq.slice_name}(${topFreq.total_dur_ms}ms): ${topFreq.freq_timeline}`);
        }
      }

      // 大小核占比
      const coreAnalysis = result.sections.core_analysis || result.sections['大小核分析'];
      if (coreAnalysis?.data && coreAnalysis.data.length > 0) {
        const mainCore = coreAnalysis.data[0];
        if (mainCore.big_core_pct !== undefined) {
          frameFindings.push(`大核占比 ${mainCore.big_core_pct}%`);
        }
      }

      // 四大象限
      const quadrant = result.sections.quadrant || result.sections['四象限分析'];
      if (quadrant?.data && quadrant.data.length > 0) {
        const q = quadrant.data[0];
        if (q.q3_runnable_ms > 5) {
          frameFindings.push(`Runnable 等待 ${q.q3_runnable_ms}ms`);
        }
      }

      // Binder 调用
      const binder = result.sections.binder_analysis || result.sections['Binder 调用'];
      if (binder?.data && binder.data.length > 0) {
        const topBinder = binder.data[0];
        if (topBinder.total_ms > 5) {
          frameFindings.push(`Binder 调用耗时 ${topBinder.total_ms}ms`);
        }
      }

      // 诊断结果
      const diagnosis = result.sections.frame_diagnosis || result.sections['帧诊断'];
      if (diagnosis?.diagnostics && diagnosis.diagnostics.length > 0) {
        const diag = diagnosis.diagnostics[0];
        if (diag.message) {
          frameFindings.push(`诊断: ${diag.message}`);
        }
      }

      if (frameFindings.length > 0) {
        keyFindings.push(`**帧 #${frameId}** (${jankType}, ${durMs.toFixed(1)}ms): ${frameFindings.join(', ')}`);
      }
    }

    if (keyFindings.length > 0) {
      summaryLines.push('**关键发现：**');
      summaryLines.push(...keyFindings.slice(0, 10)); // 最多显示 10 个帧的发现
      if (keyFindings.length > 10) {
        summaryLines.push(`... (还有 ${keyFindings.length - 10} 个帧)`);
      }
      summaryLines.push('');
    }

    summaryLines.push('---');
    summaryLines.push('*点击每行可展开查看详细分析*');

    return {
      title: '掉帧帧详细分析',
      content: summaryLines.join('\n'),
    };
  }

  /**
   * 将 displayResults 转换为 sections 格式（用于 iterator 结果）
   */
  private convertDisplayResultsToSections(displayResults: Array<{
    stepId: string;
    title: string;
    data: any;
  }>): Record<string, any> {
    const sections: Record<string, any> = {};
    for (const dr of displayResults) {
      // 从 displayResult 的 data 字段中提取实际数据
      const drData = dr.data;
      const dataRows = drData?.rows || [];
      const dataColumns = drData?.columns || [];

      // 将 rows 转换为对象数组（像 adapter 中的 rowsToObjects）
      const objects = dataRows.map((row: any[]) => {
        const obj: Record<string, any> = {};
        dataColumns.forEach((col: string, idx: number) => {
          obj[col] = row[idx];
        });
        return obj;
      });

      sections[dr.stepId] = {
        title: dr.title,
        data: objects,
      };
    }
    return sections;
  }

  /**
   * 格式化单元格值用于显示
   */
  private formatCellValue(value: any): string | number {
    if (value === null || value === undefined) {
      return '-';
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'string') {
      // 截断过长的字符串
      if (value.length > 100) {
        return value.substring(0, 97) + '...';
      }
      return value;
    }
    if (typeof value === 'boolean') {
      return value ? '是' : '否';
    }
    if (typeof value === 'object') {
      // 对象/数组简化显示
      const str = JSON.stringify(value);
      if (str.length > 50) {
        return str.substring(0, 47) + '...';
      }
      return str;
    }
    return String(value);
  }

  /**
   * 将行数组转换为对象数组
   */
  private rowsToObjects(columns: string[], rows: any[][]): Record<string, any>[] {
    return rows.map(row => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }
}

// =============================================================================
// 工厂函数
// =============================================================================

export function createSkillExecutorV2(
  traceProcessor: any,
  aiService?: any,
  eventEmitter?: (event: SkillEvent) => void
): SkillExecutorV2 {
  return new SkillExecutorV2(traceProcessor, aiService, eventEmitter);
}
