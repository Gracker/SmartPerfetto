/**
 * Skill Executor
 *
 * 核心执行引擎，支持：
 * - Skill 组合（composite）
 * - Skill 迭代（iterator）
 * - AI 协作（ai_decision, ai_summary）
 * - 诊断推理（diagnostic）
 * - 展示控制（display）
 */

import {
  SkillDefinition,
  SkillStep,
  AtomicStep,
  SkillRefStep,
  IteratorStep,
  ParallelStep,
  DiagnosticStep,
  AIDecisionStep,
  AISummaryStep,
  ConditionalStep,
  SkillExecutionContext,
  SkillExecutionResult,
  StepResult,
  DisplayResult,
  DiagnosticResult,
  DisplayConfig,
  DisplayLevel,
  SkillEvent,
  SynthesizeConfig,
} from './types';
import logger from '../../utils/logger';
import { parseLlmJson } from '../../utils/llmJson';
import { redactObjectForLLM, redactTextForLLM } from '../../utils/llmPrivacy';
import {
  DataEnvelope,
  ColumnDefinition,
  createDataEnvelope,
  buildColumnDefinitions,
  displayResultToEnvelope,
  layeredResultToEnvelopes,
} from '../../types/dataContract';

// =============================================================================
// Layered Result Types
// =============================================================================

import { DisplayLayer } from './types';

/**
 * Synthesize Data - 标记为 synthesize 的步骤数据
 * 用于最终总结时的数据聚合
 */
export interface SynthesizeData {
  /** 步骤 ID */
  stepId: string;
  /** 步骤名称 */
  stepName?: string;
  /** 步骤类型 */
  stepType: string;
  /** 数据层级 */
  layer?: string;
  /** 步骤数据 */
  data: any;
  /** 执行是否成功 */
  success: boolean;
  /** YAML 中定义的 synthesize 配置（数据驱动）*/
  config?: SynthesizeConfig;
}

/**
 * 分层结果结构
 *
 * 语义层级：
 * - overview: 顶层概览（聚合指标如 FPS、掉帧率）
 * - list: 列表数据（会话/事件列表）
 * - session: 会话详情（单个会话的详情）
 * - deep: 深度分析（帧级/调用级分析）
 */
export interface LayeredResult {
  layers: {
    /** 概览层 - 聚合指标（如 FPS、掉帧率） */
    overview?: Record<string, StepResult>;
    /** 列表层 - 会话/事件列表 */
    list?: Record<string, StepResult>;
    /** 会话层 - 单个会话的详情 */
    session?: Record<string, Record<string, StepResult>>;
    /** 深度层 - 帧级/调用级分析 */
    deep?: Record<string, Record<string, StepResult>>;
  };
  defaultExpanded: DisplayLayer[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
  /** YAML 中标记为 synthesize: true 的步骤数据，用于最终总结 */
  synthesizeData?: SynthesizeData[];
}

/**
 * 将 YAML 中的 layer 值规范化为语义名称
 */
export function normalizeLayer(layer: string | undefined): DisplayLayer | undefined {
  if (!layer) return undefined;
  // 只接受语义名称
  if (['overview', 'list', 'session', 'deep'].includes(layer)) {
    return layer as DisplayLayer;
  }
  return undefined;
}

// =============================================================================
// 表达式求值器
// =============================================================================

class ExpressionEvaluator {
  private static warnedConditionMessages = new Set<string>();

  private static warnConditionOnce(reason: string, condition: string, extra?: string): void {
    const key = `${reason}::${condition}`;
    if (this.warnedConditionMessages.has(key)) return;
    this.warnedConditionMessages.add(key);
    logger.warn(
      'ExpressionEvaluator',
      `${reason}: ${condition}${extra ? ` (${extra})` : ''}`
    );
  }

  /**
   * 在上下文中求值表达式
   * 支持：${variable}、${step.field}、比较运算符等
   */
  static evaluate(expression: string, context: SkillExecutionContext): any {
    const parsePathWithDefault = (raw: string): { actualPath: string; defaultValue: string } | null => {
      const m = raw.trim().match(
        /^([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[[0-9]+\])*)\|([^|].*)$/
      );
      if (!m) return null;
      return { actualPath: m[1].trim(), defaultValue: m[2].trim() };
    };

    // 检查是否是完整的 ${...} 表达式（整个字符串被包裹）
    const fullExprMatch = expression.match(/^\$\{(.+)\}$/s);
    // 如果内部还包含 ${...}，说明这是一个模板串（如 "${a} + ${b}"），不要当成单个 JS 表达式执行
    if (fullExprMatch && !fullExprMatch[1].includes('${')) {
      const innerExpr = fullExprMatch[1].trim();
      // Support ${varName|defaultValue} syntax for full expressions
      const defaultSyntax = parsePathWithDefault(innerExpr);
      if (defaultSyntax) {
        const value = this.resolvePath(defaultSyntax.actualPath, context);
        if (value !== undefined && value !== null) return value;
        const defaultPart = defaultSyntax.defaultValue;
        // Parse default: try number, boolean, then string
        if (/^\d+(\.\d+)?$/.test(defaultPart)) return parseFloat(defaultPart);
        if (defaultPart === 'true') return true;
        if (defaultPart === 'false') return false;
        return defaultPart;
      }
      // 这是一个 JavaScript 表达式，需要完整求值
      return this.evaluateJsExpression(innerExpr, context);
    }

    // 否则，做变量替换（支持嵌入的 JavaScript 表达式）
    let result = expression;

    // 替换 ${xxx} 格式的变量
    // 简单路径走 resolvePath；复杂表达式走 JS 表达式求值（例如: a * 16.7, foo?.bar, arr.find(...)）
    const isSimplePath = (path: string): boolean => {
      const p = path.trim();
      // 仅允许：标识符 + ".prop" + "[0]" 组合（不支持 ?. / 函数调用 / 算术运算等）
      return /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[[0-9]+\])*$/.test(p);
    };

    result = result.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const rawPath = String(path ?? '').trim();

      // Support ${varName|defaultValue} syntax
      const defaultSyntax = parsePathWithDefault(rawPath);
      const actualPath = defaultSyntax?.actualPath ?? rawPath;
      const defaultValue = defaultSyntax?.defaultValue;

      // 复杂表达式：使用完整的 JS 表达式求值
      if (!isSimplePath(actualPath)) {
        try {
          const value = this.evaluateJsExpression(actualPath, context);
          if (value === undefined || value === null) {
            return defaultValue !== undefined ? defaultValue : '';
          }
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value);
        } catch (e) {
          logger.debug('ExpressionEvaluator', `Failed to evaluate embedded JS: ${actualPath}`);
          return defaultValue !== undefined ? defaultValue : '';
        }
      }

      // 简单路径：使用 resolvePath
      const value = this.resolvePath(actualPath, context);
      if (value === undefined || value === null) {
        return defaultValue !== undefined ? defaultValue : '';
      }
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
  private static evaluateJsExpression(
    expr: string,
    context: SkillExecutionContext,
    options?: { suppressErrorLog?: boolean }
  ): any {
    try {
      // 从表达式中提取根变量名
      const rootVarNames = this.extractRootVariables(expr);

      // 构建作用域对象
      const scope: Record<string, any> = {};

      for (const varName of rootVarNames) {
        // 从步骤结果中获取
        if (context.results[varName]) {
          scope[varName] = this.wrapAsDataScope(context.results[varName].data);
        }
        // 从变量中获取
        else if (context.variables[varName] !== undefined) {
          scope[varName] = this.wrapAsDataScope(context.variables[varName]);
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
        // 未找到时也显式注入 undefined，避免 ReferenceError（例如 expr: "package" 或 "frame_ts"）
        else {
          scope[varName] = undefined;
        }
      }

      // Debug log removed for cleaner output

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
      if (!options?.suppressErrorLog) {
        logger.debug('ExpressionEvaluator', `JS expression failed: ${expr} (${e.message})`);
      }
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
   * Unwrap SkillExecutionResult-like objects from referenced skills.
   * save_as on `skill:` steps stores nested result objects, while most YAML
   * expressions expect plain row arrays at `.data`.
   */
  private static unwrapSkillResultData(value: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const maybeSkillResult = value as Record<string, any>;
    // Full SkillExecutionResult from a referenced skill step.
    // Prefer explicit `data` if present; otherwise fallback to raw step outputs.
    if (Object.prototype.hasOwnProperty.call(maybeSkillResult, 'rawResults')) {
      if (Object.prototype.hasOwnProperty.call(maybeSkillResult, 'data')) {
        return maybeSkillResult.data;
      }

      const raw = maybeSkillResult.rawResults;
      if (raw && typeof raw === 'object') {
        const rootStepData = (raw as any)?.root?.data;
        if (rootStepData !== undefined) {
          return rootStepData;
        }
        for (const step of Object.values(raw as Record<string, any>)) {
          if (step && typeof step === 'object' && Object.prototype.hasOwnProperty.call(step, 'data')) {
            return (step as any).data;
          }
        }
      }
    }

    // StepResult-like object.
    if (
      Object.prototype.hasOwnProperty.call(maybeSkillResult, 'success') &&
      Object.prototype.hasOwnProperty.call(maybeSkillResult, 'data')
    ) {
      return maybeSkillResult.data;
    }

    return value;
  }

  /**
   * Wrap values for `.data[...]` access pattern used by skill conditions.
   */
  private static wrapAsDataScope(value: any): { data: any } {
    return { data: this.unwrapSkillResultData(value) };
  }

  /**
   * 解析路径引用，支持深层嵌套和数组索引
   * 例如: "step1.data[0].field" 或 "performance_summary.data[0].app_jank_rate"
   */
  static resolvePath(path: string, context: SkillExecutionContext): any {
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
        value = this.wrapAsDataScope(context.variables[rootKey]);
      } else {
        // 直接访问数组元素，如 ${main_slices[0].name}
        value = context.variables[rootKey];
      }
    }
    // 5. 步骤结果 - 返回包装对象以支持 .data[0].field 访问
    else if (context.results[rootKey]) {
      // 返回包含 data 属性的对象，这样 ${main_slices.data[0].name} 才能正确解析
      value = this.wrapAsDataScope(context.results[rootKey].data);
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
   * 条件表达式始终作为 JavaScript 表达式求值（不需要 ${} 包裹）
   * 例如: environment.data[0]?.frame_data_status === 'available'
   */
  static evaluateCondition(condition: string, context: SkillExecutionContext): boolean {
    try {
      // 允许 condition 中混用 ${...} 模板（如 "${vsync_missed} >= 3" 或 "cpu.data[0] > ${frame_dur} ...")
      // 先做模板替换/简单表达式求值，再作为 JS 表达式执行。
      let prepared: any = condition;
      if (typeof condition === 'string' && condition.includes('${')) {
        prepared = this.evaluate(condition, context);
      }

      // evaluate 可能直接返回 boolean/number（例如 "3 >= 1"）
      if (prepared === undefined || prepared === null) {
        return false;
      }
      if (typeof prepared === 'boolean') {
        return prepared;
      }
      if (typeof prepared === 'number') {
        return prepared !== 0;
      }
      if (typeof prepared !== 'string') {
        return Boolean(prepared);
      }

      const expr = prepared.trim();
      if (!expr) return false;
      if (expr.includes('${')) {
        // 未替换完的模板通常意味着上游数据缺失，不作为告警噪声输出。
        logger.debug('ExpressionEvaluator', `Condition still contains template placeholders: ${expr}`);
        return false;
      }

      // 条件表达式作为 JavaScript 表达式求值
      const result = this.evaluateJsExpression(expr, context, { suppressErrorLog: true });

      // 如果求值失败（返回 undefined），默认为 false
      if (result === undefined) {
        return false;
      }

      return Boolean(result);
    } catch (e: any) {
      this.warnConditionOnce('Condition evaluation failed', condition, e.message);
      return false;
    }
  }
}

// =============================================================================
// SQL 变量替换
// =============================================================================

function substituteVariables(sql: string, context: SkillExecutionContext): string {
  let result = sql;

  // 判断 offset 位置是否处于 SQL 单引号字符串常量内部（用于决定缺省值是 '' 还是 NULL）
  // 注：这里只做轻量扫描，足够覆盖 skill SQL 模板中常见的 '${package}*' / '%${name}%' 等模式。
  const isInsideSingleQuotes = (s: string, offset: number): boolean => {
    let inSingle = false;
    for (let i = 0; i < offset; i++) {
      const ch = s[i];
      if (ch !== '\'') continue;

      // SQL 中单引号转义使用 ''（两个单引号）。
      if (inSingle && s[i + 1] === '\'') {
        i++; // skip escaped quote
        continue;
      }
      inSingle = !inSingle;
    }
    return inSingle;
  };

  // 替换所有 ${xxx} 格式的变量（支持 ${varName|defaultValue} 语法）
  result = result.replace(/\$\{([^}]+)\}/g, (match, path, offset, full) => {
    const rawPath = String(path ?? '').trim();
    const insideQuotes = typeof offset === 'number' && typeof full === 'string'
      ? isInsideSingleQuotes(full, offset)
      : false;

    // Support ${varName|defaultValue} syntax
    const pipeIndex = rawPath.indexOf('|');
    const actualPath = pipeIndex >= 0 ? rawPath.substring(0, pipeIndex).trim() : rawPath;
    const explicitDefault = pipeIndex >= 0 ? rawPath.substring(pipeIndex + 1).trim() : undefined;

    const value = ExpressionEvaluator.resolvePath(actualPath, context);

    // 缺省值优先级：
    // 1. 显式 |default 值
    // 2. 字符串常量内部：用 ''
    // 3. 其它位置：用 NULL
    if (value === undefined || value === null) {
      if (explicitDefault !== undefined) return explicitDefault;
      if (insideQuotes) return '';
      return 'NULL';
    }

    // 如果值被插入到单引号字符串中，必须转义单引号，避免 SQL 解析错误
    if (insideQuotes && typeof value === 'string') {
      return value.replace(/'/g, '\'\'');
    }

    return String(value);
  });

  return result;
}

// =============================================================================
// Display 配置处理（支持模板变量替换）
// =============================================================================

/**
 * 处理 display 配置，对字符串值进行模板变量替换
 * 支持 ${variable} 格式的变量替换
 */
function processDisplayConfig(
  display: any,
  context: SkillExecutionContext
): DisplayConfig {
  const processed: DisplayConfig = { ...display };

  // 处理 title 字段（字符串类型）
  if (processed.title && typeof processed.title === 'string') {
    processed.title = substituteVariables(processed.title, context);
  }

  // 如果未来需要处理其他字符串字段（如 description），可以在这里添加
  // if (processed.description && typeof processed.description === 'string') {
  //   processed.description = substituteVariables(processed.description, context);
  // }

  return processed;
}

// =============================================================================
// Layer Organization Functions
// =============================================================================

/**
 * Transform deep layer frame analysis results from displayResults format to frontend-expected format.
 *
 * This function is a generic data pass-through that:
 * 1. Maps step IDs to output property names (e.g., 'quadrant_analysis' → 'quadrants')
 * 2. Converts table format { columns, rows } to object array
 * 3. Passes through data without field-level transformations
 *
 * Field naming is the responsibility of the Skill YAML, not this function.
 * The Skill YAML should output data with field names that match frontend expectations.
 */
function transformDeepFrameAnalysis(displayResults: any[]): { diagnosis_summary: string; full_analysis: any } {
  logger.debug('SkillExecutor', `transformDeepFrameAnalysis: ${displayResults.length} steps [${displayResults.map(dr => dr.stepId).join(', ')}]`);

  const fullAnalysis: any = {
    quadrants: { main_thread: {}, render_thread: {} },
    binder_calls: [],
    cpu_frequency: { big_avg_mhz: 0, little_avg_mhz: 0 },
    main_thread_slices: [],
    render_thread_slices: [],
    cpu_freq_timeline: [],
    lock_contentions: [],
  };
  let diagnosisSummary = '';

  // Step ID to output property mapping
  // This configuration defines which step output goes to which analysis property
  const stepIdMapping: Record<string, string> = {
    'binder_calls': 'binder_calls',
    'binder_data': 'binder_calls',
    'main_thread_slices': 'main_thread_slices',
    'main_slices': 'main_thread_slices',
    'render_thread_slices': 'render_thread_slices',
    'render_slices': 'render_thread_slices',
    'cpu_freq_timeline': 'cpu_freq_timeline',
    'freq_timeline': 'cpu_freq_timeline',
    'lock_contention': 'lock_contentions',
    'lock_data': 'lock_contentions',
  };

  for (const dr of displayResults) {
    const stepId = dr.stepId;
    const rawData = dr.data;

    // Handle both array data and table format { columns, rows }
    let dataArray: any[] = [];
    if (Array.isArray(rawData)) {
      dataArray = rawData;
    } else if (rawData?.rows && rawData?.columns) {
      // Convert table format to object array (generic transformation)
      dataArray = rawData.rows.map((row: any[]) => {
        const obj: any = {};
        rawData.columns.forEach((col: string, idx: number) => {
          obj[col] = row[idx];
        });
        return obj;
      });
    }

    // Handle diagnostic step specially (extracts diagnosis text)
    if (stepId === 'frame_diagnosis') {
      const diagnostics = rawData?.diagnostics || [];
      if (Array.isArray(diagnostics) && diagnostics.length > 0) {
        diagnosisSummary = diagnostics
          .filter((d: any) => d.diagnosis)
          .map((d: any) => d.diagnosis)
          .join('; ');
        logger.debug('SkillExecutor', `frame_diagnosis: ${diagnostics.length} diagnostics`);
      }
      continue;
    }

    // Handle root_cause_summary step - extract primary_cause as diagnosis
    // stepId is 'root_cause_summary' (from skill step id), not 'root_cause' (save_as variable name)
    if (stepId === 'root_cause_summary') {
      // Extract primary_cause as the main diagnosis
      if (dataArray.length > 0) {
        const rootCause = dataArray[0];
        if (rootCause?.primary_cause) {
          // Use root_cause as primary diagnosis (more reliable than frame_diagnosis rules)
          diagnosisSummary = rootCause.primary_cause;
          if (rootCause.secondary_info) {
            diagnosisSummary += ` (${rootCause.secondary_info})`;
          }
        }
      }
      continue;
    }

    // Handle cpu_freq_analysis specially (converts rows to single object)
    if (stepId === 'cpu_freq_analysis' || stepId === 'freq_data') {
      const bigCore = dataArray.find((d: any) => d.core_type === 'big');
      const littleCore = dataArray.find((d: any) => d.core_type === 'little');
      fullAnalysis.cpu_frequency = {
        big_avg_mhz: bigCore?.avg_freq_mhz || 0,
        little_avg_mhz: littleCore?.avg_freq_mhz || 0,
      };
      continue;
    }

    // Handle quadrant_analysis specially - convert flat array to nested object
    // Input format: [{ quadrant: "MainThread Q1_大核运行", dur_ms, percentage }, ...]
    // Output format: { main_thread: { q1, q2, q3, q4 }, render_thread: { q1, q2, q3, q4 } }
    if (stepId === 'quadrant_analysis' || stepId === 'quadrant_data') {
      const mainThread: Record<string, number> = { q1: 0, q2: 0, q3: 0, q4: 0 };
      const renderThread: Record<string, number> = { q1: 0, q2: 0, q3: 0, q4: 0 };

      for (const item of dataArray) {
        const quadrant = item.quadrant || item.name || '';
        const percentage = item.percentage || 0;

        // Parse quadrant name: "MainThread Q1_大核运行" -> thread=MainThread, q=1
        if (quadrant.includes('MainThread')) {
          if (quadrant.includes('Q1')) mainThread.q1 = percentage;
          else if (quadrant.includes('Q2')) mainThread.q2 = percentage;
          else if (quadrant.includes('Q3')) mainThread.q3 = percentage;
          else if (quadrant.includes('Q4')) mainThread.q4 = percentage;
        } else if (quadrant.includes('RenderThread')) {
          if (quadrant.includes('Q1')) renderThread.q1 = percentage;
          else if (quadrant.includes('Q2')) renderThread.q2 = percentage;
          else if (quadrant.includes('Q3')) renderThread.q3 = percentage;
          else if (quadrant.includes('Q4')) renderThread.q4 = percentage;
        }
      }

      fullAnalysis.quadrants = {
        main_thread: mainThread,
        render_thread: renderThread,
      };
      continue;
    }

    // Generic pass-through: map step ID to property and assign data directly
    const outputProperty = stepIdMapping[stepId];
    if (outputProperty && dataArray.length > 0) {
      // Map field names to match what renderDeepFrameAnalysis expects
      if (outputProperty === 'binder_calls') {
        // Skill outputs: interface, count, dur_ms, max_ms, sync_count
        // Renderer expects: server_process, call_count, total_ms, max_ms
        fullAnalysis[outputProperty] = dataArray.map((item: any) => ({
          server_process: item.interface || item.server_process || '',
          call_count: item.count || item.call_count || 0,
          total_ms: item.dur_ms || item.total_ms || 0,
          max_ms: item.max_ms || 0,
          sync_count: item.sync_count || 0,
        }));
      } else if (outputProperty === 'main_thread_slices' || outputProperty === 'render_thread_slices') {
        // Skill outputs: name, dur_ms, count, max_ms, ts
        // Renderer expects: name, total_ms, count, max_ms
        fullAnalysis[outputProperty] = dataArray.map((item: any) => ({
          name: item.name || '',
          total_ms: item.dur_ms || item.total_ms || 0,
          count: item.count || 1,
          max_ms: item.max_ms || 0,
          ts: item.ts,
        }));
      } else {
        fullAnalysis[outputProperty] = dataArray;
      }
    }
  }

  return {
    diagnosis_summary: diagnosisSummary || '暂无明显问题',
    full_analysis: fullAnalysis,
  };
}

function organizeByLayer(steps: StepResult[]): LayeredResult['layers'] {
  const layers: LayeredResult['layers'] = {
    overview: {},
    list: {},
    session: {},
    deep: {},
  };

  for (const step of steps) {
    const rawLayer = step.display?.layer;
    if (!rawLayer) {
      continue;
    }

    // 规范化 layer 名称为语义名称（overview/list/session/deep）
    const layer = normalizeLayer(rawLayer) || rawLayer as DisplayLayer;

    // Ensure failed steps have empty array data for consistent handling
    const normalizedStep: StepResult = step.success ? step : {
      ...step,
      data: [],  // Default to empty array for failed steps
      error: step.error,
    };

    switch (layer) {
      case 'overview':
      case 'list':
        const targetLayer = layers[layer];
        if (targetLayer) {
          targetLayer[normalizedStep.stepId] = normalizedStep;
        }
        break;
      case 'session':
        // session 数据需要按 session_id 组织
        const sessionLayer = layers.session;
        if (sessionLayer) {
          const sessionId = extractSessionId(normalizedStep);
          if (!sessionLayer[sessionId]) {
            sessionLayer[sessionId] = {};
          }
          sessionLayer[sessionId][normalizedStep.stepId] = normalizedStep;
        }
        break;
      case 'deep':
        // deep 数据需要按 session_id 和 frame_id 组织
        const deepLayer = layers.deep;
        if (deepLayer) {
          // 特殊处理 iterator 结果：每个迭代项都是单独的 deep 条目
          if (normalizedStep.stepType === 'iterator' && Array.isArray(normalizedStep.data)) {
            logger.debug('SkillExecutor', `organizeByLayer: iterator step ${normalizedStep.stepId} with ${normalizedStep.data.length} items`);

            // Iterator 返回 { itemIndex, item, result }[] 数组
            for (let i = 0; i < normalizedStep.data.length; i++) {
              const iterItem: any = normalizedStep.data[i];

              const item: any = iterItem?.item;
              if (!item) {
                console.warn(`[organizeByLayer] Iterator item ${i} has no item data, skipping`);
                continue;
              }

              const frameId = `frame_${item.frame_id || item.frame_index || i}`;
              const sessionId = `session_${item.session_id ?? 0}`;

              if (!deepLayer[sessionId]) {
                deepLayer[sessionId] = {};
              }

              // Transform displayResults into format expected by frontend
              const displayResults = iterItem.result?.displayResults || [];
              const transformedData = transformDeepFrameAnalysis(displayResults);

              const frameStepResult: StepResult = {
                stepId: frameId,
                stepType: 'atomic',
                success: iterItem.result?.success ?? false,
                data: transformedData,
                executionTimeMs: iterItem.result?.executionTimeMs || 0,
                display: {
                  title: `帧 #${item.frame_id || item.frame_index || i} - ${item.jank_type || 'Unknown'}`,
                  level: 'key',
                  layer: 'deep',
                  format: 'table',
                },
              };

              (frameStepResult as any).item = item;

              deepLayer[sessionId][frameId] = frameStepResult;
            }
            logger.debug('SkillExecutor', `organizeByLayer: deep layer sessions: [${Object.keys(deepLayer).join(', ')}]`);
          } else if (normalizedStep.stepType === 'atomic' && Array.isArray(normalizedStep.data) && normalizedStep.data.length > 0) {
            // 检查是否是帧列表数据（如 get_app_jank_frames）
            // 如果 data 是数组且每个元素都有 frame_id 或 frame_index，展开为多个帧
            const firstItem = normalizedStep.data[0];
            const hasFrameId = firstItem && typeof firstItem === 'object' && ('frame_id' in firstItem || 'frame_index' in firstItem);

            if (hasFrameId) {
              // 将每一行作为一个单独的帧条目
              for (let i = 0; i < normalizedStep.data.length; i++) {
                const item: any = normalizedStep.data[i];
                if (!item || typeof item !== 'object') continue;

                const frameId = `frame_${item.frame_id || item.frame_index || i}`;
                const sessionId = `session_${item.session_id ?? 0}`;

                if (!deepLayer[sessionId]) {
                  deepLayer[sessionId] = {};
                }

                const frameStepResult: StepResult = {
                  stepId: frameId,
                  stepType: 'atomic',
                  success: normalizedStep.success,
                  data: [item],
                  executionTimeMs: normalizedStep.executionTimeMs / normalizedStep.data.length,
                  display: {
                    title: `帧 #${item.frame_id || item.frame_index || i} - ${item.jank_type || 'Unknown'}`,
                    level: 'key',
                    layer: 'deep',
                    format: 'table',
                  },
                };

                (frameStepResult as any).item = item;

                deepLayer[sessionId][frameId] = frameStepResult;
              }
            } else {
              // 普通的 deep 步骤（不是帧列表）
              const sessionId = extractSessionId(normalizedStep);
              const frameId = extractFrameId(normalizedStep);
              if (!deepLayer[sessionId]) {
                deepLayer[sessionId] = {};
              }
              deepLayer[sessionId][frameId] = normalizedStep;
            }
          } else {
            // 普通的 deep 步骤
            const sessionId = extractSessionId(normalizedStep);
            const frameId = extractFrameId(normalizedStep);
            if (!deepLayer[sessionId]) {
              deepLayer[sessionId] = {};
            }
            deepLayer[sessionId][frameId] = normalizedStep;
          }
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
  // For non-frame deep steps, use stepId as key to avoid overwriting previous steps.
  if (step.stepId && step.stepId.length > 0) {
    return step.stepId;
  }
  return 'frame_0';
}

// =============================================================================
// Skill Executor
// =============================================================================

export class SkillExecutor {
  private traceProcessor: any;
  private aiService: any;  // AI 服务（用于 ai_decision, ai_summary）
  private skillRegistry: Map<string, SkillDefinition>;
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
  registerSkill(skill: SkillDefinition): void {
    this.skillRegistry.set(skill.name, skill);
  }

  /**
   * 批量注册 skills
   */
  registerSkills(skills: SkillDefinition[]): void {
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
   * Expand prerequisite module aliases to canonical stdlib module ids.
   */
  private resolvePrerequisiteModules(modules?: string[]): string[] {
    if (!Array.isArray(modules) || modules.length === 0) return [];

    const expanded: string[] = [];
    for (const m of modules) {
      switch (m) {
        case 'sched':
          // stdlib/sched/ 下不存在 sched.sql；常用能力在 states/runnable
          expanded.push('sched.states', 'sched.runnable');
          break;
        case 'stack_profile':
          // stdlib/callstacks/stack_profile.sql
          expanded.push('callstacks.stack_profile');
          break;
        case 'android.frames':
          // stdlib/android/frames/ 无 frames.sql；常见能力来自 timeline/jank_type
          expanded.push('android.frames.timeline', 'android.frames.jank_type');
          break;
        case 'android.frames.jank':
          // 实际模块名为 jank_type.sql
          expanded.push('android.frames.jank_type');
          break;
        default:
          expanded.push(m);
      }
    }

    return Array.from(new Set(expanded));
  }

  /**
   * Best-effort probe for prerequisite modules and return only available ones.
   * Note: some trace processor builds treat INCLUDE as statement-scoped, so
   * SQL execution still prepends INCLUDE per-step for determinism.
   */
  private async resolveAvailableModules(traceId: string, modules: string[]): Promise<string[]> {
    const available: string[] = [];
    for (const module of modules) {
      try {
        const includeResult = await this.traceProcessor.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
        if ((includeResult as any)?.error) {
          console.warn(`[SkillExecutor] Module not available: ${module}`);
          continue;
        }
        available.push(module);
      } catch {
        console.warn(`[SkillExecutor] Module not available: ${module}`);
      }
    }
    return available;
  }

  /**
   * Prefix SQL with prerequisite INCLUDE statements.
   */
  private buildSqlWithModuleIncludes(sql: string, context: SkillExecutionContext): string {
    const modules = context.moduleIncludes || [];
    if (modules.length === 0) return sql;
    const prefix = modules.map(module => `INCLUDE PERFETTO MODULE ${module};`).join('\n');
    return `${prefix}\n${sql}`;
  }

  /**
   * 执行 skill
   */
  async execute(
    skillId: string,
    traceId: string,
    params: Record<string, any> = {},
    inherited: Record<string, any> = {}
  ): Promise<SkillExecutionResult> {
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

    const prerequisiteModules = this.resolvePrerequisiteModules(skill.prerequisites?.modules);
    let moduleIncludes = prerequisiteModules;

    // 仅注入可用模块，避免未知模块导致整条 SQL 失败
    if (prerequisiteModules.length > 0) {
      moduleIncludes = await this.resolveAvailableModules(traceId, prerequisiteModules);
    }

    // 创建执行上下文
    const context: SkillExecutionContext = {
      traceId,
      params,
      inherited,
      results: {},
      variables: {},
      moduleIncludes,
    }

    // 检查表依赖
    const prereqCheck = await this.checkPrerequisites(skill, traceId);
    if (!prereqCheck.success) {
      return {
        skillId,
        skillName: skill.meta.display_name,
        success: false,
        displayResults: [],
        diagnostics: [],
        executionTimeMs: Date.now() - startTime,
        error: `Skipped: ${prereqCheck.error}`,
      };
    }

    try {
      const displayResults: DisplayResult[] = [];
      const diagnostics: DiagnosticResult[] = [];
      const synthesizeData: SynthesizeData[] = [];
      let aiSummary: string | undefined;


      // 根据 skill 类型执行
      switch (skill.type) {
        case 'atomic':
          if (skill.sql) {
            const atomicResult = await this.executeAtomicSkill(skill, context);
            // Handle atomic skill errors
            if (!atomicResult.success) {
              this.emit({
                type: 'skill_error',
                skillId,
                data: { error: atomicResult.error },
              });

              return {
                skillId,
                skillName: skill.meta.display_name,
                success: false,
                displayResults: [],
                diagnostics: [],
                executionTimeMs: Date.now() - startTime,
                error: atomicResult.error,
              };
            }
            // Keep parity with step-based execution so referenced atomic skills
            // can expose their payload via rawResults.root.data.
            context.results['root'] = atomicResult;
            if (atomicResult.display) {
              displayResults.push(this.createDisplayResult('root', skill.meta.display_name, atomicResult, skill.output?.display));
            }
          } else {
            // Backward compatibility: some "atomic" skills are authored as step-based YAML.
            // Treat them as composite execution when `sql` is absent but `steps` exist.
            if (!skill.steps || skill.steps.length === 0) {
              return {
                skillId,
                skillName: skill.meta.display_name,
                success: false,
                displayResults: [],
                diagnostics: [],
                executionTimeMs: Date.now() - startTime,
                error: 'No SQL or steps defined for atomic skill',
              };
            }
            const stepExec = await this.executeStepBasedSkill(skill, skillId, context, displayResults, diagnostics, synthesizeData);
            aiSummary = stepExec.aiSummary;
          }
          break;

        case 'composite':
        case 'iterator':
        case 'diagnostic':
          {
            if (!skill.steps || skill.steps.length === 0) {
              return {
                skillId,
                skillName: skill.meta.display_name,
                success: false,
                displayResults: [],
                diagnostics: [],
                executionTimeMs: Date.now() - startTime,
                error: `No steps defined for skill: ${skillId}`,
              };
            }
            const stepExec = await this.executeStepBasedSkill(skill, skillId, context, displayResults, diagnostics, synthesizeData);
            aiSummary = stepExec.aiSummary;
          }
          break;
      }

      // If skills provide data-driven synthesize configs, generate a deterministic
      // "insight summary" DisplayResult so Agents can cite KPIs/insights without LLM.
      // Best-effort and only triggers for config.role === 'overview'.
      const synthesizeSummary = this.buildSynthesizeSummaryDisplayResult(synthesizeData);
      if (synthesizeSummary) {
        displayResults.unshift(synthesizeSummary);
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
        synthesizeData: synthesizeData.length > 0 ? synthesizeData : undefined,
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
   * Execute a step-based skill (composite/iterator/diagnostic, and legacy atomic skills without root-level `sql`).
   * Mutates `context.results` / `context.variables` and appends into `displayResults` / `diagnostics` / `synthesizeData`.
   */
  private extractSaveAsValue(stepResult: StepResult): any {
    // Most steps already store direct row arrays/objects in stepResult.data.
    if (stepResult.stepType !== 'skill') {
      return stepResult.data;
    }

    const nested = stepResult.data as any;
    if (!nested || typeof nested !== 'object') {
      return stepResult.data;
    }

    // Future-proof: if nested result already exposes .data directly, use it.
    if (Object.prototype.hasOwnProperty.call(nested, 'data')) {
      return nested.data;
    }

    // SkillExecutionResult currently exposes payloads via rawResults.
    const rawResults = nested.rawResults;
    if (rawResults && typeof rawResults === 'object') {
      if ((rawResults as any).root?.data !== undefined) {
        return (rawResults as any).root.data;
      }
      for (const step of Object.values(rawResults as Record<string, any>)) {
        if (step && typeof step === 'object' && Object.prototype.hasOwnProperty.call(step, 'data')) {
          return (step as any).data;
        }
      }
    }

    return stepResult.data;
  }

  private async executeStepBasedSkill(
    skill: SkillDefinition,
    skillId: string,
    context: SkillExecutionContext,
    displayResults: DisplayResult[],
    diagnostics: DiagnosticResult[],
    synthesizeData: SynthesizeData[]
  ): Promise<{ aiSummary?: string }> {
    let aiSummary: string | undefined;

    if (!skill.steps) {
      return { aiSummary };
    }

    for (const step of skill.steps) {
      const stepResult = await this.executeStep(step, context, skillId);

      // Collect synthesize-marked data for downstream summarization (execute path parity).
      // Supports:
      // 1) synthesize: true (legacy)
      // 2) synthesize: { role: ..., fields: ... } (data-driven)
      if ('synthesize' in step && (step as any).synthesize) {
        const synthesizeValue = (step as any).synthesize;
        const displayConfig = this.getDisplayConfig(step) || {};

        let config: SynthesizeConfig | undefined;
        if (typeof synthesizeValue === 'object' && synthesizeValue.role) {
          config = synthesizeValue as SynthesizeConfig;
        }

        synthesizeData.push({
          stepId: step.id,
          stepName: ('name' in step ? step.name : step.id) || step.id,
          stepType: typeof (step as any).type === 'string' ? (step as any).type : 'skill',
          layer: (displayConfig as DisplayConfig).layer,
          data: stepResult.data,
          success: stepResult.success,
          config,
        });
      }

      if (stepResult.success) {
        // 保存结果
        context.results[step.id] = stepResult;

        // 如果有 save_as，保存到变量
        if ('save_as' in step && step.save_as) {
          context.variables[step.save_as] = this.extractSaveAsValue(stepResult);
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

        // Iterator 结果绑回源列表：将 expandableData 绑定到 source step 的 DisplayResult
        if ((step as any).type === 'iterator' && 'source' in step && (step as any).source) {
          const sourceName = (step as any).source;
          // source 引用的是 save_as 名称，需要找到对应的 step.id
          const sourceStep = skill.steps!.find((s: any) =>
            s.save_as === sourceName || s.id === sourceName
          );
          const sourceStepId = sourceStep ? sourceStep.id : sourceName;
          const sourceDisplayResult = displayResults.find(dr => dr.stepId === sourceStepId);
          // expandableData 在 DisplayResult.data 中（由 flattenIteratorResults 创建）
          const iteratorDisplayResult = displayResults.find(dr => dr.stepId === step.id);
          if (sourceDisplayResult?.data && iteratorDisplayResult?.data?.expandableData) {
            sourceDisplayResult.data.expandableData = iteratorDisplayResult.data.expandableData;
          }
        }

        // 收集诊断结果
        if ((step as any).type === 'diagnostic' && stepResult.data?.diagnostics) {
          diagnostics.push(...stepResult.data.diagnostics);
        }

        // 收集 AI 总结
        if ((step as any).type === 'ai_summary' && stepResult.data?.summary) {
          aiSummary = stepResult.data.summary;
        }
      }
    }

    return { aiSummary };
  }

  /**
   * Execute composite skill and return layered results
   * This is an alternative execution path that organizes output by layers (overview/list/session/deep)
   */
  async executeCompositeSkill(
    skill: SkillDefinition,
    inputs: Record<string, any>,
    context: Partial<SkillExecutionContext>
  ): Promise<LayeredResult> {
    const startTime = Date.now();

    // Validate input
    if (!skill) {
      throw new Error('Skill definition is required');
    }

    if (!skill.steps || skill.steps.length === 0) {
      return {
        layers: {
          overview: {}, list: {}, session: {}, deep: {},
        },
        defaultExpanded: ['overview', 'list'],
        metadata: {
          skillName: skill.name,
          version: skill.version || '1.0.0',
          executedAt: new Date().toISOString()
        }
      };
    }

    const prerequisiteModules = this.resolvePrerequisiteModules(skill.prerequisites?.modules);

    // Create execution context
    const execContext: SkillExecutionContext = {
      traceId: context.traceId || '',
      params: inputs,
      inherited: context.inherited || {},
      results: {},
      variables: {},
      moduleIncludes: prerequisiteModules,
    };

    if (execContext.traceId && prerequisiteModules.length > 0) {
      execContext.moduleIncludes = await this.resolveAvailableModules(execContext.traceId, prerequisiteModules);
    }

    // Execute all steps and collect synthesize-marked data
    const stepResults: StepResult[] = [];
    const synthesizeData: SynthesizeData[] = [];

    if (skill.steps) {
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i];
        const stepResult = await this.executeStep(step, execContext, skill.name);

        // Save result to context
        if (stepResult.success) {
          execContext.results[step.id] = stepResult;

          // Save to variables if save_as is specified
          if ('save_as' in step && step.save_as) {
            execContext.variables[step.save_as] = this.extractSaveAsValue(stepResult);
          }
        }

        // IMPORTANT: Add display config from step definition to stepResult
        // This is needed for organizeByLayer to correctly place results in layers
        // Process display config with template variable substitution (e.g., ${frame_id})
        if ('display' in step && typeof step.display === 'object') {
          stepResult.display = processDisplayConfig(step.display, execContext);
        }

        // 收集标记为 synthesize 的步骤数据
        // 支持两种格式：
        // 1. synthesize: true (旧格式，向后兼容)
        // 2. synthesize: { role: ..., fields: ... } (新格式，数据驱动)
        if ('synthesize' in step && (step as any).synthesize) {
          const synthesizeValue = (step as any).synthesize;
          const displayConfig = step.display && typeof step.display === 'object' ? step.display : {};

          // 解析 synthesize 配置
          let config: SynthesizeConfig | undefined;
          if (typeof synthesizeValue === 'object' && synthesizeValue.role) {
            // 新格式：完整的配置对象
            config = synthesizeValue as SynthesizeConfig;
          }
          // 旧格式 (synthesize: true) 不设置 config，由 analysisWorker 使用默认处理

          synthesizeData.push({
            stepId: step.id,
            stepName: ('name' in step ? step.name : step.id) || step.id,
            stepType: typeof (step as any).type === 'string' ? (step as any).type : 'skill',
            layer: (displayConfig as DisplayConfig).layer,
            data: stepResult.data,
            success: stepResult.success,
            config,  // 包含 YAML 中定义的配置（如果有）
          });
        }

        stepResults.push(stepResult);
      }
    }

    // Iterator 结果绑回源列表：将 expandableData 绑定到 source step 的 StepResult
    // 这样 convertDisplayResultsToSections 可以在源步骤的 data 上找到 expandableData
    if (skill.steps) {
      for (let i = 0; i < skill.steps.length; i++) {
        const step = skill.steps[i];
        if (step.type === 'iterator' && 'source' in step && (step as any).source) {
          const sourceName = (step as any).source;
          // source 引用的是 save_as 名称，需要找到对应的 step.id
          const sourceStep = skill.steps.find((s: any) =>
            s.save_as === sourceName || s.id === sourceName
          );
          const sourceStepId = sourceStep ? sourceStep.id : sourceName;
          const sourceResult = stepResults.find(sr => sr.stepId === sourceStepId);
          const iteratorResult = stepResults[i];
          // 在 executeCompositeSkill 路径中，iterator 的 data 是原始 [{itemIndex, item, result}, ...]
          // 需要将其转换为 expandableData 格式
          if (sourceResult?.data && iteratorResult?.success && Array.isArray(iteratorResult.data)) {
            const expandableData = iteratorResult.data.map((iterItem: any) => ({
              item: iterItem.item,
              result: {
                success: iterItem.result?.success ?? false,
                sections: this.convertDisplayResultsToSections(iterItem.result?.displayResults || []),
                error: iterItem.result?.error,
              },
            }));
            // 直接在 data 上挂载 expandableData（JS 数组/对象都支持额外属性）
            (sourceResult.data as any).expandableData = expandableData;
          }
        }
      }
    }

    // Return layered structure
    try {
      const layers = organizeByLayer(stepResults);

      const result: LayeredResult = {
        layers,
        defaultExpanded: ['overview', 'list'],
        metadata: {
          skillName: skill.name,
          version: skill.version || '1.0.0',
          executedAt: new Date().toISOString()
        },
        // 添加收集的 synthesize 数据
        synthesizeData: synthesizeData.length > 0 ? synthesizeData : undefined,
      };

      // synthesizeData collected for final summary (debug logging removed)

      return result;
    } catch (error) {
      console.error('[executeCompositeSkill] organizeByLayer failed:', error);
      throw error;
    }
  }

  /**
   * 执行原子 skill（单个 SQL）
   */
  private async executeAtomicSkill(
    skill: SkillDefinition,
    context: SkillExecutionContext
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

    const sql = this.buildSqlWithModuleIncludes(
      substituteVariables(skill.sql, context),
      context
    );

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
        display: skill.output?.display ? processDisplayConfig(skill.output.display, context) : undefined,
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
    context: SkillExecutionContext,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    // 检查步骤的条件限制
    if ('condition' in step && typeof (step as any).condition === 'string') {
      const conditionStr = (step as any).condition;
      const conditionResult = ExpressionEvaluator.evaluateCondition(conditionStr, context);
      if (!conditionResult) {
        this.emit({
          type: 'step_completed',
          skillId: parentSkillId,
          stepId: step.id,
          data: { skipped: true, reason: 'condition_not_met' },
        });
        return {
          stepId: step.id,
          stepType: step.type,
          success: false,
          error: 'Condition not met',
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

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
    context: SkillExecutionContext
  ): Promise<StepResult> {
    const startTime = Date.now();
    const sql = this.buildSqlWithModuleIncludes(
      substituteVariables(step.sql, context),
      context
    );


    try {
      const result = await this.traceProcessor.query(context.traceId, sql);

      // Debug log removed for cleaner output

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
      if (data.length > 0) {
      }

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
   * 检查 prerequisites 条件 (required_tables, optional_tables)
   */
  private async checkPrerequisites(
    skill: SkillDefinition,
    traceId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!skill.prerequisites) return { success: true };

    const { required_tables } = skill.prerequisites;

    if (!required_tables || required_tables.length === 0) {
      return { success: true };
    }

    try {
      // Perfetto trace_processor uses virtual tables that may not appear in sqlite_master.
      // These core tables are ALWAYS present in any valid Perfetto trace:
      const CORE_TABLES = new Set(['thread', 'process', 'slice', 'counter', 'track', 'thread_track', 'counter_track']);

      // Filter out core tables - they're guaranteed to exist
      const tablesToCheck = required_tables.filter(t => !CORE_TABLES.has(t));

      if (tablesToCheck.length === 0) {
        // All required tables are core tables - they always exist
        return { success: true };
      }

      // For non-core tables, query sqlite_master (include views for Perfetto's virtual tables)
      const tableList = tablesToCheck.map(t => `'${t}'`).join(',');
      const query = `
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'view') AND name IN (${tableList})
      `;

      const result = await this.traceProcessor.query(traceId, query);
      const existingTables = new Set<string>();

      // 处理查询结果（兼容多种返回结构）
      if (result) {
        if (result.columns && Array.isArray(result.rows)) {
          const nameIdx = result.columns.indexOf('name');
          if (nameIdx >= 0) {
            for (const row of result.rows) {
              if (Array.isArray(row) && row[nameIdx]) {
                existingTables.add(String(row[nameIdx]));
              } else if (row && typeof row === 'object' && row['name']) {
                existingTables.add(String(row['name']));
              }
            }
          }
        } else if (Array.isArray(result)) {
          result.forEach((row: any) => {
            if (row?.name) {
              existingTables.add(String(row.name));
            }
          });
        }
      }

      // 检查缺少的表 (only check non-core tables)
      const missingTables = tablesToCheck.filter(t => !existingTables.has(t));

      if (missingTables.length > 0) {
        return {
          success: false,
          error: `Trace is missing required tables: ${missingTables.join(', ')}`
        };
      }

      return { success: true };
    } catch (e: any) {
      console.error(`[SkillExecutor] Failed to check prerequisites: ${e.message}`);
      //为了健壮性，查询失败时不阻止执行，可能是 traceProcessor 问题
      return { success: true };
    }
  }

  /**
   * 执行 skill 引用步骤
   */
  private async executeSkillRefStep(
    step: SkillRefStep,
    context: SkillExecutionContext
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
    context: SkillExecutionContext,
    parentSkillId: string
  ): Promise<StepResult> {
    const startTime = Date.now();

    const itemSkillName = typeof (step as any).item_skill === 'string'
      ? String((step as any).item_skill)
      : (typeof (step as any).skill === 'string' ? String((step as any).skill) : '');
    if (!itemSkillName) {
      return {
        stepId: step.id,
        stepType: 'iterator',
        success: false,
        error: `Iterator item_skill is missing: ${step.id}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

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


    const results: any[] = [];
    const maxItems = step.max_items || 100;  // 性能保护
    let items = [...source];

    // Optional iterator filter (best-effort): allows skills to analyze only a subset of items.
    // Example in YAML: filter: "jank_level == 'severe' OR jank_level == 'bad'"
    const filterExprRaw = typeof (step as any).filter === 'string' ? String((step as any).filter).trim() : '';
    if (filterExprRaw) {
      const filterExpr = filterExprRaw
        .replace(/\bOR\b/gi, '||')
        .replace(/\bAND\b/gi, '&&');
      try {
        items = items.filter((item: any) => {
          const itemObj = (item && typeof item === 'object') ? item : {};
          const filterCtx: SkillExecutionContext = {
            ...context,
            // Expose item fields at root-level for convenience in filter expressions.
            inherited: { ...(context.inherited || {}), ...itemObj },
            currentItem: itemObj,
          };
          return ExpressionEvaluator.evaluateCondition(filterExpr, filterCtx);
        });
      } catch {
        // Ignore filter evaluation errors (iterator still runs).
      }
    }

    items = items.slice(0, maxItems);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // 构建子 skill 的参数
      const params: Record<string, any> = {};
      if (step.item_params) {
        for (const [key, path] of Object.entries(step.item_params)) {
          // 仅在字段不存在(=== undefined)时才回退为常量字符串；保留 null（常用于 SQL NULL）
          const v = (item as any)?.[path];
          params[key] = v !== undefined ? v : path;
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
        itemSkillName,
        context.traceId,
        params,
        { ...context.inherited, ...context.variables, item }
      );

      // Always record the per-item result, even if it failed (so UI/Agents can see errors).
      results.push({
        itemIndex: i,
        item,
        result: itemResult,
      });
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
    context: SkillExecutionContext,
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
    context: SkillExecutionContext
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

        // 收集 evidence 数据
        const evidence = this.collectDiagnosticEvidence(rule, context, inputs);

        // Evaluate suggestions templates (e.g., "${root_cause.data[0].secondary_info}")
        const evaluatedSuggestions = rule.suggestions?.map((s: string) =>
          typeof s === 'string' ? ExpressionEvaluator.evaluate(s, context) : s
        );

        diagnostics.push({
          id: `${step.id}_${diagnostics.length}`,
          diagnosis,
          confidence,
          severity: confidence >= 0.8 ? 'critical' : confidence >= 0.6 ? 'warning' : 'info',
          suggestions: evaluatedSuggestions,
          evidence,
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
   * 收集诊断结论的数据依据
   * 从 rule.evidence_fields 或自动从 condition 解析引用的数据源
   */
  private collectDiagnosticEvidence(
    rule: any,
    context: SkillExecutionContext,
    inputs: Record<string, any>
  ): Record<string, any> {
    const evidence: Record<string, any> = {};

    // 1. 如果规则定义了 evidence_fields，使用它们
    if (rule.evidence_fields && Array.isArray(rule.evidence_fields)) {
      for (const field of rule.evidence_fields) {
        const value = this.resolveEvidenceField(field, context, inputs);
        if (value !== undefined) {
          evidence[field] = value;
        }
      }
    }

    // 2. 自动从 condition 中提取数据源引用
    const conditionSources = this.extractDataSources(rule.condition);
    for (const source of conditionSources) {
      // 只提取第一行数据作为 evidence（避免数据过大）
      const sourceData = inputs[source];
      if (sourceData && !evidence[source]) {
        if (Array.isArray(sourceData) && sourceData.length > 0) {
          // 只取第一条记录的关键字段
          const firstRow = sourceData[0];
          evidence[source] = {
            _summary: `共 ${sourceData.length} 条记录`,
            _firstRow: this.extractKeyFields(firstRow),
          };
        } else if (typeof sourceData === 'object') {
          evidence[source] = this.extractKeyFields(sourceData);
        }
      }
    }

    // 3. 添加时间戳用于 Perfetto 跳转
    const tsField = this.findTimestampField(inputs, conditionSources);
    if (tsField) {
      evidence._perfettoTs = tsField;
    }

    return Object.keys(evidence).length > 0 ? evidence : undefined as any;
  }

  /**
   * 从表达式中提取数据源名称
   * 例如: "lock_data.data[0]?.wait_ms > 2" => ["lock_data"]
   */
  private extractDataSources(expression: string): string[] {
    const sources: Set<string> = new Set();
    // 匹配 xxx.data 或 xxx.xxx 形式的数据源引用
    const matches = expression.match(/(\w+)\.data/g);
    if (matches) {
      for (const match of matches) {
        const source = match.replace('.data', '');
        sources.add(source);
      }
    }
    return Array.from(sources);
  }

  /**
   * 解析 evidence_fields 中的字段路径
   * 支持格式: "source.field" 或 "source.data[0].field"
   */
  private resolveEvidenceField(
    field: string,
    context: SkillExecutionContext,
    inputs: Record<string, any>
  ): any {
    try {
      // 尝试从 inputs 中解析
      const parts = field.split('.');
      let value: any = inputs;
      for (const part of parts) {
        if (value === undefined) return undefined;
        // 处理数组索引，如 data[0]
        const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
        if (arrayMatch) {
          value = value[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
        } else {
          value = value[part];
        }
      }
      return value;
    } catch {
      return undefined;
    }
  }

  /**
   * 从对象中提取关键字段（排除大型嵌套对象）
   */
  private extractKeyFields(obj: any): Record<string, any> {
    if (!obj || typeof obj !== 'object') return obj;
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      // 跳过大型数组和深层嵌套对象
      if (Array.isArray(value)) {
        result[key] = `[Array(${value.length})]`;
      } else if (value && typeof value === 'object') {
        // 只保留一层深度
        result[key] = '[Object]';
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 从输入数据中找到时间戳字段用于 Perfetto 跳转
   */
  private findTimestampField(inputs: Record<string, any>, sources: string[]): string | undefined {
    for (const source of sources) {
      const data = inputs[source];
      if (Array.isArray(data) && data.length > 0) {
        const firstRow = data[0];
        // 常见的时间戳字段名
        const tsFields = ['ts', 'start_ts', 'timestamp', 'begin_ts'];
        for (const field of tsFields) {
          if (firstRow[field] !== undefined && firstRow[field] !== null) {
            return String(firstRow[field]);
          }
        }
      }
    }
    return undefined;
  }

  /**
   * 执行 AI 决策步骤
   */
  private async executeAIDecisionStep(
    step: AIDecisionStep,
    context: SkillExecutionContext
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

    const basePrompt = ExpressionEvaluator.evaluate(step.prompt, context);
    const inputsPayloadRaw = this.buildAIInputsPayload(step.inputs, context);
    const inputsPayload = inputsPayloadRaw ? (redactObjectForLLM(inputsPayloadRaw).value as any) : null;
    const promptRaw = this.buildStructuredAIPrompt(basePrompt, inputsPayload, 'decision');
    const prompt = redactTextForLLM(promptRaw).text;

    this.emit({
      type: 'ai_thinking',
      skillId: '',
      stepId: step.id,
      data: { prompt },
    });

    const response = await this.callAI(prompt, context, 'evaluation');
    const normalizedDecision = this.extractStructuredAIField(response, 'decision');

    this.emit({
      type: 'ai_response',
      skillId: '',
      stepId: step.id,
      data: { response: normalizedDecision, rawResponse: response },
    });

    return {
      stepId: step.id,
      stepType: 'ai_decision',
      success: true,
      data: { decision: normalizedDecision },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行 AI 总结步骤
   */
  private async executeAISummaryStep(
    step: AISummaryStep,
    context: SkillExecutionContext
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

    const basePrompt = ExpressionEvaluator.evaluate(step.prompt, context);
    const inputsPayloadRaw = this.buildAIInputsPayload(step.inputs, context);
    const inputsPayload = inputsPayloadRaw ? (redactObjectForLLM(inputsPayloadRaw).value as any) : null;
    const promptRaw = this.buildStructuredAIPrompt(basePrompt, inputsPayload, 'summary');
    const prompt = redactTextForLLM(promptRaw).text;

    this.emit({
      type: 'ai_thinking',
      skillId: '',
      stepId: step.id,
      data: { prompt },
    });

    const response = await this.callAI(prompt, context, 'synthesis');
    const normalizedSummary = this.extractStructuredAIField(response, 'summary');

    this.emit({
      type: 'ai_response',
      skillId: '',
      stepId: step.id,
      data: { response: normalizedSummary, rawResponse: response },
    });

    return {
      stepId: step.id,
      stepType: 'ai_summary',
      success: true,
      data: { summary: normalizedSummary },
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 执行条件步骤
   */
  private async executeConditionalStep(
    step: ConditionalStep,
    context: SkillExecutionContext,
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
  private async callAI(prompt: string, _context: SkillExecutionContext, taskType: any = 'general'): Promise<string> {
    if (!this.aiService) {
      return '';
    }

    const safePrompt = redactTextForLLM(prompt).text;
    try {
      if (typeof this.aiService.chat === 'function') {
        return await this.aiService.chat(safePrompt);
      }
      if (typeof this.aiService.callWithFallback === 'function') {
        const result = await this.aiService.callWithFallback(safePrompt, taskType, { temperature: 0 });
        return result?.response || result?.content || '';
      }
      throw new Error('AI service does not implement chat');
    } catch (error: any) {
      console.error('[SkillExecutor] AI call failed:', error.message);
      return '';
    }
  }

  /**
   * Build a compact, deterministic payload for ai_summary/ai_decision steps.
   *
   * Note: step.inputs uses save_as names (preferred) or step ids.
   * We intentionally sample rows to avoid prompt bloat.
   */
  private buildAIInputsPayload(
    inputs: string[] | undefined,
    context: SkillExecutionContext
  ): Record<string, any> | null {
    if (!inputs || inputs.length === 0) return null;

    const payload: Record<string, any> = {};
    const maxSampleRows = 5;
    const maxColumns = 64;

    for (const inputName of inputs) {
      const value = this.resolveAIInputValue(inputName, context);

      if (value === undefined) {
        payload[inputName] = { missing: true };
        continue;
      }

      if (Array.isArray(value)) {
        const count = value.length;
        const firstRow = count > 0 ? value[0] : undefined;
        const columns =
          firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)
            ? Object.keys(firstRow as Record<string, any>).slice(0, maxColumns)
            : undefined;

        const sample = value.slice(0, Math.min(count, maxSampleRows)).map((row) => {
          if (row && typeof row === 'object') return this.extractKeyFields(row);
          return row;
        });

        payload[inputName] = {
          type: 'array',
          count,
          columns,
          sample,
          truncated: count > maxSampleRows,
        };
        continue;
      }

      if (value && typeof value === 'object') {
        payload[inputName] = {
          type: 'object',
          value: this.extractKeyFields(value),
        };
        continue;
      }

      payload[inputName] = {
        type: typeof value,
        value,
      };
    }

    return payload;
  }

  private resolveAIInputValue(inputName: string, context: SkillExecutionContext): any {
    if (context.variables[inputName] !== undefined) {
      return context.variables[inputName];
    }
    if (context.results[inputName]?.data !== undefined) {
      return context.results[inputName].data;
    }
    if (context.params && context.params[inputName] !== undefined) {
      return context.params[inputName];
    }
    if (context.inherited && context.inherited[inputName] !== undefined) {
      return context.inherited[inputName];
    }
    if (context.currentItem && (context.currentItem as any)[inputName] !== undefined) {
      return (context.currentItem as any)[inputName];
    }
    return undefined;
  }

  private buildStructuredAIPrompt(
    basePrompt: string,
    inputsPayload: Record<string, any> | null,
    mode: 'decision' | 'summary'
  ): string {
    const schema = mode === 'decision'
      ? '{"decision":"string","reasoning":"string","confidence":"high|medium|low","missing_data":["string"]}'
      : '{"summary":"string","key_points":["string"],"confidence":"high|medium|low","missing_data":["string"],"next_steps":["string"]}';
    const inputBlock = inputsPayload
      ? `\n\n[INPUT_DATA_JSON]\n${JSON.stringify(inputsPayload, null, 2)}\n[/INPUT_DATA_JSON]`
      : '';
    const groundingRule = mode === 'decision'
      ? '严格要求：只根据 INPUT_DATA_JSON 中提供的数据做判断；缺数据就明确说明缺口。'
      : '严格要求：只基于 INPUT_DATA_JSON 中的实际数据分析；不要编造数值。若字段不存在/为空，请明确说明无法判断，并给出下一步建议。';

    return `${basePrompt}${inputBlock}\n\n${groundingRule}\n输出要求：只返回一个 JSON 对象，不要输出 markdown、代码块或额外解释。\nJSON Schema: ${schema}`;
  }

  private extractStructuredAIField(
    response: string,
    field: 'decision' | 'summary'
  ): string {
    const fallback = String(response || '').trim();
    if (!fallback) return '';

    try {
      const parsed = parseLlmJson<Record<string, any>>(fallback);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed[field] === 'string' && parsed[field].trim()) {
          return parsed[field].trim();
        }
        if (field === 'decision' && typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) {
          return parsed.reasoning.trim();
        }
      }
    } catch {
      // Fall back to raw response if structured parse fails.
    }

    return fallback;
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
    // Skill 引用步骤返回的是嵌套 SkillExecutionResult，展示时需要先解包到真实数据。
    const data = stepResult.stepType === 'skill'
      ? this.extractSaveAsValue(stepResult)
      : stepResult.data;

    // Extract column definitions from config (runtime data may be ColumnDefinition[] even though type says string[])
    // This happens because skill YAML is loaded dynamically and contains full column definitions
    const columnDefinitions = Array.isArray((config as any).columns)
      ? (config as any).columns.filter((c: any) => typeof c === 'object' && c.name)
      : undefined;

    // 根据数据类型确定展示格式
    let displayData: DisplayResult['data'];

    // Special handling for diagnostic step data - preserve the structure
    // so that transformDeepFrameAnalysis can extract diagnostics
    if (typeof data === 'object' && data !== null && 'diagnostics' in data && Array.isArray(data.diagnostics)) {
      // Preserve diagnostic structure for later extraction
      displayData = data;
    } else if (Array.isArray(data) && data.length > 0) {
      // 检查是否是 iterator 结果（包含 itemIndex, item, result）
      if (this.isIteratorResult(data)) {
        displayData = this.flattenIteratorResults(data, stepResult.stepType === 'iterator', columnDefinitions);
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
      layer: config.layer,         // 分层展示层级
      format: config.format || 'table',
      data: displayData,
      highlight: config.highlight,
      sql,  // 保存原始 SQL
      expandable: config.expandable,           // 是否支持展开查看详细分析
      metadataFields: config.metadataFields,   // 提取到元数据的字段
      hidden_columns: config.hidden_columns,   // 隐藏的列
      columnDefinitions,                       // 完整的列定义（包含 hidden 等属性）
    };
  }

  /**
   * Build a deterministic "insight summary" DisplayResult from synthesize configs.
   *
   * Motivation:
   * - Skills already carry `synthesize:` configs (role/fields/insights)
   * - Agents need compact, citeable KPIs + insights without relying on ai_summary
   *
   * Current scope (v2):
   * - Processes config.role in {'overview', 'conclusion', 'list', 'clusters'}
   * - overview/conclusion: uses first row/object as the KPI row
   * - list/clusters: summarizes group distributions + top items (best-effort)
   */
  private buildSynthesizeSummaryDisplayResult(synthesizeData: SynthesizeData[]): DisplayResult | null {
    if (!Array.isArray(synthesizeData) || synthesizeData.length === 0) return null;

    const keyRoleItems = synthesizeData.filter(item =>
      item?.success === true &&
      item?.config &&
      typeof item.config === 'object' &&
      ['overview', 'conclusion', 'list', 'clusters'].includes(String((item.config as any).role))
    );
    if (keyRoleItems.length === 0) return null;

    const metrics: Array<{
      label: string;
      value: string | number;
      unit?: string;
      severity?: 'info' | 'warning' | 'critical';
    }> = [];
    const insights: string[] = [];

    const resolvePath = (ctx: Record<string, any>, path: string): any => {
      if (!path || !ctx) return undefined;
      if (!path.includes('.')) return ctx[path];
      const parts = path.split('.');
      let cur: any = ctx;
      for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[p];
      }
      return cur;
    };

    const applyTemplate = (template: string, ctx: Record<string, any>): string => {
      const t = String(template || '');
      if (!t.includes('{{')) return t;
      return t.replace(/\{\{\s*([a-zA-Z0-9_\\.]+)\s*\}\}/g, (_m, key) => {
        const v = resolvePath(ctx, String(key || '').trim());
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') {
          try { return JSON.stringify(v); } catch { return String(v); }
        }
        return String(v);
      });
    };

    const evalConditionOnRow = (condition: string, rowCtx: Record<string, any>): boolean => {
      const expr = String(condition || '').trim();
      if (!expr) return true;
      try {
        // YAML-defined expressions are trusted (skill author controlled).
        const fn = new Function('ctx', `with (ctx) { return (${expr}); }`);
        return Boolean(fn(rowCtx));
      } catch {
        return false;
      }
    };

    const isPlainObject = (v: any): v is Record<string, any> => {
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    };

    const toNumber = (v: any): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    const isIteratorData = (data: any): boolean => {
      if (!Array.isArray(data) || data.length === 0) return false;
      const first = data[0];
      return isPlainObject(first) && 'itemIndex' in first && 'item' in first && 'result' in first;
    };

    const collectTemplateKeys = (template: string): string[] => {
      const keys: string[] = [];
      const t = String(template || '');
      const re = /\{\{\s*([a-zA-Z0-9_\\.]+)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        const key = String(m[1] || '').trim();
        if (!key) continue;
        // Only keep root path segment (we don't build nested objects in iterator extraction)
        const root = key.includes('.') ? key.split('.')[0] : key;
        if (root) keys.push(root);
      }
      return keys;
    };

    const resolveFieldFromSkillResult = (skillResult: any, field: string): any => {
      if (!skillResult || !field) return undefined;

      // 1) Prefer diagnostics for common fields
      if (field === 'diagnosis' && Array.isArray(skillResult.diagnostics) && skillResult.diagnostics.length > 0) {
        const d = skillResult.diagnostics[0];
        if (d && typeof d.diagnosis === 'string' && d.diagnosis.trim()) return d.diagnosis;
      }
      if (field === 'confidence' && Array.isArray(skillResult.diagnostics) && skillResult.diagnostics.length > 0) {
        const d = skillResult.diagnostics[0];
        if (d && typeof d.confidence === 'number' && Number.isFinite(d.confidence)) return d.confidence;
      }

      // 2) Search rawResults step outputs for a field match (first row/object only)
      const raw = (skillResult as any).rawResults;
      if (raw && typeof raw === 'object') {
        for (const stepResult of Object.values(raw)) {
          const data = (stepResult as any)?.data;
          if (Array.isArray(data) && data.length > 0) {
            const first = data[0];
            if (isPlainObject(first) && field in first) return (first as any)[field];
          } else if (isPlainObject(data) && field in data) {
            return (data as any)[field];
          }
        }
      }

      return undefined;
    };

    const resolveClusterBy = (clusterBy: any): { field: string; label?: string } | null => {
      if (!clusterBy) return null;
      if (typeof clusterBy === 'string') {
        const field = clusterBy.trim();
        return field ? { field } : null;
      }
      if (typeof clusterBy === 'object') {
        const fieldRaw = (clusterBy as any)?.field;
        const field = typeof fieldRaw === 'string' ? fieldRaw.trim() : '';
        if (!field) return null;
        const labelRaw = (clusterBy as any)?.label;
        const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim() : undefined;
        return { field, label };
      }
      return null;
    };

    const extractRowsForListLikeRole = (data: any, config: SynthesizeConfig): Record<string, any>[] => {
      if (!data) return [];

      // Determine which fields we may need to synthesize summaries.
      const needed = new Set<string>();
      if (config.role === 'clusters') {
        const c = resolveClusterBy(config.clusterBy);
        if (c?.field) needed.add(c.field);
      }
      if (Array.isArray(config.groupBy)) {
        for (const g of config.groupBy) {
          if (g?.field) needed.add(String(g.field));
        }
      }
      if (Array.isArray(config.fields)) {
        for (const f of config.fields) {
          if (f?.key) needed.add(String(f.key));
          if (typeof f?.format === 'string') {
            for (const k of collectTemplateKeys(f.format)) needed.add(k);
          }
        }
      }
      if (Array.isArray(config.insights)) {
        for (const i of config.insights) {
          if (typeof i?.template === 'string') {
            for (const k of collectTemplateKeys(i.template)) needed.add(k);
          }
        }
      }

      // Iterator results: [{ itemIndex, item, result }]
      if (isIteratorData(data)) {
        const rows: Record<string, any>[] = [];
        for (const it of data as any[]) {
          const row: Record<string, any> = isPlainObject(it?.item) ? { ...(it.item as any) } : {};
          // Fill missing fields from nested SkillExecutionResult
          for (const key of needed) {
            if (row[key] !== undefined) continue;
            const v = resolveFieldFromSkillResult(it?.result, key);
            if (v !== undefined) row[key] = v;
          }
          rows.push(row);
        }
        return rows;
      }

      if (Array.isArray(data)) {
        return data.filter(isPlainObject) as Record<string, any>[];
      }
      if (isPlainObject(data)) return [data];
      return [];
    };

    const extractRowObject = (data: any): Record<string, any> | null => {
      if (!data) return null;
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          return first as Record<string, any>;
        }
        return null;
      }
      if (typeof data === 'object' && !Array.isArray(data)) {
        return data as Record<string, any>;
      }
      return null;
    };

    for (const item of keyRoleItems) {
      const config = item.config as SynthesizeConfig;
      const role = (config as any)?.role;

      // list/clusters: summarize distribution + top items, best-effort
      if (role === 'list' || role === 'clusters') {
        const rows = extractRowsForListLikeRole(item.data, config);
        if (rows.length === 0) continue;

        const stepName = item.stepName || item.stepId;
        const itemPrefix = keyRoleItems.length > 1 ? `${stepName}: ` : `${stepName}: `;

        // Group distributions
        const groupBy: Array<{ field: string; title: string }> = [];
        if (role === 'clusters') {
          const c = resolveClusterBy(config.clusterBy);
          if (c?.field) {
            groupBy.push({ field: c.field, title: `聚类(${c.label || c.field})` });
          }
        }
        if (Array.isArray(config.groupBy)) {
          for (const g of config.groupBy) {
            if (!g || typeof g.field !== 'string' || typeof g.title !== 'string') continue;
            groupBy.push({ field: g.field, title: g.title });
          }
        }

        const pickDistributionMode = (): { mode: 'percent' | 'count'; valueKey?: string } => {
          // If rows contain a numeric percent-like field, aggregate percentages (common for breakdown tables).
          const percentKeys = ['percent', 'pct', 'percentage'];
          for (const k of percentKeys) {
            if (rows.some(r => toNumber(r?.[k]) !== null)) {
              return { mode: 'percent', valueKey: k };
            }
          }
          return { mode: 'count' };
        };

        const distMode = pickDistributionMode();

        for (const g of groupBy) {
          const field = g.field;
          const totalCount = rows.length;

          const buckets = new Map<string, { count: number; sum?: number }>();
          for (const r of rows) {
            const rawKey = r?.[field];
            const key = rawKey === undefined || rawKey === null || String(rawKey).trim() === ''
              ? 'unknown'
              : String(rawKey);
            if (!buckets.has(key)) {
              buckets.set(key, { count: 0, sum: 0 });
            }
            const b = buckets.get(key)!;
            b.count += 1;

            if (distMode.mode === 'percent' && distMode.valueKey) {
              const n = toNumber(r?.[distMode.valueKey]);
              if (n !== null) b.sum = (b.sum || 0) + n;
            }
          }

          const entries = Array.from(buckets.entries()).map(([k, v]) => ({ k, ...v }));
          entries.sort((a, b) => {
            if (distMode.mode === 'percent') return (b.sum || 0) - (a.sum || 0);
            return b.count - a.count;
          });

          const top = entries.slice(0, 3);
          const segs: string[] = [];
          for (const e of top) {
            if (distMode.mode === 'percent') {
              segs.push(`${e.k} ${(e.sum || 0).toFixed(1).replace(/\.0$/, '')}%`);
            } else {
              const pct = totalCount > 0 ? Math.round(100 * e.count / totalCount) : 0;
              segs.push(`${e.k} ${e.count} (${pct}%)`);
            }
          }
          if (segs.length > 0) {
            insights.push(`${g.title}: ${segs.join('，')}`);
          }
        }

        // Top items: when fields define a (name,value) mapping
        if (Array.isArray(config.fields) && config.fields.length >= 2) {
          const nameField = config.fields[0];
          const valueField = config.fields[1];
          if (nameField?.key && valueField?.key) {
            const items = rows.slice(0, 3).map(r => {
              const name = r?.[nameField.key];
              const raw = r?.[valueField.key];
              const ctx = { ...(r || {}), value: raw };
              const formatted = valueField.format ? applyTemplate(valueField.format, ctx).trim() : undefined;
              const value = formatted !== undefined && formatted !== null && formatted !== ''
                ? formatted
                : (raw === undefined || raw === null ? '' : String(raw));
              const nameStr = name === undefined || name === null ? '' : String(name);
              const s = nameStr ? `${nameStr}: ${value}` : value;
              return s.length > 90 ? s.slice(0, 90) + '…' : s;
            }).filter(s => typeof s === 'string' && s.trim().length > 0);

            if (items.length > 0) {
              insights.push(`${itemPrefix}Top: ${items.join('；')}`);
            }
          }
        }

        // Optional row-level insights (evaluate on first row only to keep summary compact)
        if (Array.isArray(config.insights) && config.insights.length > 0) {
          const row0 = rows[0];
          if (row0) {
            for (const insight of config.insights) {
              if (!insight || typeof insight.template !== 'string') continue;
              const ok = insight.condition ? evalConditionOnRow(insight.condition, row0) : true;
              if (!ok) continue;
              const rendered = applyTemplate(insight.template, row0).trim();
              if (rendered) insights.push(`${itemPrefix}${rendered}`);
            }
          }
        }

        // Light metric: list size (helps citation and sanity checks)
        metrics.push({
          label: `${stepName} 条目数`,
          value: rows.length,
        });

        continue;
      }

      const row = extractRowObject(item.data);
      if (!row) continue;

      // Fields → metrics
      if (Array.isArray(config.fields)) {
        for (const field of config.fields) {
          if (!field || typeof field.key !== 'string' || typeof field.label !== 'string') continue;
          const raw = row[field.key];
          if (raw === undefined || raw === null) continue;

          const ctx = { ...row, value: raw };
          const formatted = field.format ? applyTemplate(field.format, ctx) : undefined;
          const value = formatted !== undefined && formatted !== null && String(formatted).trim() !== ''
            ? String(formatted)
            : (typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw));

          metrics.push({
            label: field.label,
            value,
          });
        }
      }

      // Insights → short bullet lines
      if (Array.isArray(config.insights)) {
        for (const insight of config.insights) {
          if (!insight || typeof insight.template !== 'string') continue;
          const ok = insight.condition ? evalConditionOnRow(insight.condition, row) : true;
          if (!ok) continue;

          const rendered = applyTemplate(insight.template, row).trim();
          if (!rendered) continue;

          const prefix = keyRoleItems.length > 1
            ? `${item.stepName || item.stepId}: `
            : '';
          insights.push(`${prefix}${rendered}`);
        }
      }
    }

    // Dedupe while preserving order
    const seenMetric = new Set<string>();
    const dedupedMetrics = metrics.filter(m => {
      const k = `${m.label}::${String(m.value)}`;
      if (seenMetric.has(k)) return false;
      seenMetric.add(k);
      return true;
    }).slice(0, 12);

    const seenInsight = new Set<string>();
    const dedupedInsights = insights.filter(s => {
      const k = s.trim();
      if (!k) return false;
      if (seenInsight.has(k)) return false;
      seenInsight.add(k);
      return true;
    }).slice(0, 8);

    if (dedupedMetrics.length === 0 && dedupedInsights.length === 0) return null;

    const content = dedupedInsights.length > 0
      ? dedupedInsights.map(s => `- ${s}`).join('\n')
      : '（无显式洞见，见指标）';

    return {
      stepId: '__synthesize_summary__',
      title: '洞见摘要',
      level: 'key',
      layer: 'overview',
      format: 'summary',
      data: {
        summary: {
          title: '洞见摘要',
          content,
          metrics: dedupedMetrics,
        },
      },
    };
  }

  /**
   * 创建 DataEnvelope (v2.0 数据契约格式)
   *
   * DataEnvelope 是自描述的数据容器，包含:
   * - meta: 数据来源和版本信息
   * - data: 实际数据内容
   * - display: 显示配置（包括列定义）
   *
   * 前端可以根据 display.columns 配置进行通用渲染，无需硬编码字段名。
   */
  private buildDataEnvelope(
    skillId: string,
    stepId: string,
    title: string,
    stepResult: StepResult,
    displayConfig?: DisplayConfig,
    sql?: string
  ): DataEnvelope {
    // First create the DisplayResult using existing logic
    const displayResult = this.createDisplayResult(stepId, title, stepResult, displayConfig, sql);

    // Extract column definitions from config or infer from data
    const explicitColumns = (displayConfig as any)?.columns as Partial<ColumnDefinition>[] | undefined;

    // Build the DataEnvelope
    return displayResultToEnvelope(displayResult, skillId, explicitColumns);
  }

  /**
   * 将 SkillExecutionResult 转换为 DataEnvelope 数组
   *
   * 用于 v2.0 数据契约，统一 SSE 事件格式
   */
  public static toDataEnvelopes(
    result: SkillExecutionResult,
    columnDefinitions?: Record<string, Partial<ColumnDefinition>[]>
  ): DataEnvelope[] {
    return result.displayResults.map(dr => {
      // Prefer external columnDefinitions, fallback to embedded columnDefinitions in DisplayResult
      const explicitColumns = columnDefinitions?.[dr.stepId] ?? dr.columnDefinitions as any;
      // Bridge skillEngine DisplayResult -> dataContract DisplayResult:
      // dataContract expects metadataConfig.fields, while skillEngine uses metadataFields.
      const drAny = dr as any;
      const drForEnvelope = {
        ...drAny,
        metadataConfig: drAny.metadataConfig || (Array.isArray(drAny.metadataFields) ? { fields: drAny.metadataFields } : undefined),
      };
      return displayResultToEnvelope(drForEnvelope as any, result.skillId, explicitColumns);
    });
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
  private flattenIteratorResults(
    data: any[],
    _isIterator: boolean,
    columnDefinitions?: Array<{ name: string }>
  ): DisplayResult['data'] {
    if (data.length === 0) {
      return { text: '无迭代结果' };
    }

    const resolveFieldFromSkillResult = (skillResult: any, field: string): any => {
      if (!skillResult || !field) return undefined;

      // Prefer diagnostics for common fields
      if (Array.isArray(skillResult.diagnostics) && skillResult.diagnostics.length > 0) {
        const d = skillResult.diagnostics[0];
        if (field === 'diagnosis' && d && typeof d.diagnosis === 'string' && d.diagnosis.trim()) {
          return d.diagnosis;
        }
        if (field === 'confidence' && d && typeof d.confidence === 'number' && Number.isFinite(d.confidence)) {
          return d.confidence;
        }
        if (field === 'severity' && d && typeof d.severity === 'string' && d.severity.trim()) {
          return d.severity;
        }
      }

      // Search rawResults step outputs for a field match (first row/object only)
      const raw = (skillResult as any).rawResults;
      if (raw && typeof raw === 'object') {
        for (const stepResult of Object.values(raw)) {
          const stepData = (stepResult as any)?.data;
          if (Array.isArray(stepData) && stepData.length > 0) {
            const first = stepData[0];
            if (first && typeof first === 'object' && !Array.isArray(first) && field in (first as any)) {
              return (first as any)[field];
            }
          } else if (stepData && typeof stepData === 'object' && !Array.isArray(stepData) && field in (stepData as any)) {
            return (stepData as any)[field];
          }
        }
      }

      return undefined;
    };

    const explicitColumns = Array.isArray(columnDefinitions) && columnDefinitions.length > 0
      ? columnDefinitions.map(c => c.name).filter((n: any) => typeof n === 'string' && n.trim().length > 0)
      : [];

    // If step defines explicit columns, prefer them and attempt to extract values
    // from both `item` and nested `result` (SkillExecutionResult).
    if (explicitColumns.length > 0) {
      const columns = explicitColumns;
      const rows = data.map((iterItem) => {
        const item = iterItem.item || {};
        const skillResult = iterItem.result;
        return columns.map((col) => {
          const v = (item && typeof item === 'object' && col in item)
            ? item[col]
            : resolveFieldFromSkillResult(skillResult, col);
          return this.formatCellValue(v);
        });
      });

      const expandableData = data.map((iterItem) => ({
        item: iterItem.item,
        result: {
          success: iterItem.result?.success ?? false,
          sections: this.convertDisplayResultsToSections(iterItem.result?.displayResults || []),
          error: iterItem.result?.error,
        },
      }));

      const summary = this.generateIteratorSummary(data, expandableData);

      return { columns, rows, expandableData, summary };
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

    const firstItem = expandableData[0]?.item || {};
    const isJankLike =
      ('frame_id' in firstItem) ||
      ('jank_type' in firstItem) ||
      ('vsync_missed' in firstItem);
    const isStartupLike =
      ('startup_id' in firstItem) ||
      ('startup_type' in firstItem) ||
      ('ttid_ms' in firstItem) ||
      ('ttfd_ms' in firstItem);

    // Try to extract key indicators from sections to generate a summary.
    // Prefer domain-specific summaries; fall back to a generic iterator summary.
    const summaryLines: string[] = [];

    if (!isJankLike && !isStartupLike) {
      summaryLines.push(`**迭代分析汇总**`);
      summaryLines.push('');
      summaryLines.push(`共分析 ${data.length} 项，成功 ${successCount} 项${failCount > 0 ? `，失败 ${failCount} 项` : ''}。`);
      return {
        title: '汇总报告',
        content: summaryLines.join('\n'),
      };
    }

    if (isStartupLike) {
      summaryLines.push(`**启动事件分析汇总**`);
      summaryLines.push('');
      summaryLines.push(`共分析 ${data.length} 个启动事件，成功 ${successCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}。`);

      // Startup type distribution (best-effort)
      const typeCounts = new Map<string, number>();
      for (const { item } of expandableData) {
        const t = item?.startup_type;
        const k = t === undefined || t === null || String(t).trim() === '' ? 'unknown' : String(t);
        typeCounts.set(k, (typeCounts.get(k) || 0) + 1);
      }
      const typeTop = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (typeTop.length > 0) {
        summaryLines.push('');
        summaryLines.push(`启动类型分布: ${typeTop.map(([k, v]) => `${k} ${v}`).join('，')}`);
      }

      // Top slow startups by dur_ms
      const withDur = expandableData
        .map(({ item }) => ({
          startup_id: item?.startup_id,
          startup_type: item?.startup_type,
          dur_ms: Number(item?.dur_ms),
        }))
        .filter(r => Number.isFinite(r.dur_ms));
      withDur.sort((a, b) => b.dur_ms - a.dur_ms);
      const slowTop = withDur.slice(0, 3);
      if (slowTop.length > 0) {
        summaryLines.push('');
        summaryLines.push('最慢启动:');
        for (const s of slowTop) {
          summaryLines.push(`- startup_id=${s.startup_id ?? '?'} (${s.startup_type ?? 'unknown'}) ${s.dur_ms.toFixed(0)}ms`);
        }
      }

      return {
        title: '汇总报告',
        content: summaryLines.join('\n'),
      };
    }

    // Jank/frame iterator summary (existing behavior)
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
// Module Expert Response Types (Cross-Domain Expert System)
// =============================================================================

import {
  FindingSchema,
  SuggestionSchema,
} from './types';

/**
 * Structured finding extracted from module skill execution
 */
export interface ExtractedFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description?: string;
  evidence: Record<string, any>;
  sourceModule: string;
  confidence: number;
}

/**
 * Structured suggestion for follow-up analysis
 */
export interface ExtractedSuggestion {
  id: string;
  targetModule: string;
  questionTemplate: string;
  params: Record<string, any>;
  priority: number;
  reason: string;
}

/**
 * Complete response from a module skill invocation
 * Used by cross-domain experts to understand module analysis results
 */
export interface ModuleSkillResponse {
  success: boolean;
  data: Record<string, any>;
  findings: ExtractedFinding[];
  suggestions: ExtractedSuggestion[];
  executionTimeMs: number;
  error?: string;
}

/**
 * Extract findings from skill execution results based on findingsSchema
 */
export function extractFindings(
  skillName: string,
  findingsSchema: FindingSchema[] | undefined,
  executionContext: SkillExecutionContext,
  stepResults: Record<string, StepResult>
): ExtractedFinding[] {
  if (!findingsSchema || findingsSchema.length === 0) {
    return [];
  }

  const findings: ExtractedFinding[] = [];

  for (const schema of findingsSchema) {
    // Check if this finding type was detected
    // The condition is implicitly "data exists and has values"
    // More sophisticated rules can be added later
    const evidenceData: Record<string, any> = {};
    let hasEvidence = false;

    // Collect evidence from specified fields
    if (schema.evidenceFields) {
      for (const fieldPath of schema.evidenceFields) {
        const value = resolveFieldPath(fieldPath, executionContext, stepResults);
        if (value !== undefined && value !== null) {
          evidenceData[fieldPath] = value;
          hasEvidence = true;
        }
      }
    }

    // Only create finding if we have evidence
    if (hasEvidence) {
      // Substitute template placeholders
      const title = substituteTemplate(schema.titleTemplate, evidenceData);
      const description = schema.descriptionTemplate
        ? substituteTemplate(schema.descriptionTemplate, evidenceData)
        : undefined;

      findings.push({
        id: `${skillName}_${schema.id}`,
        severity: schema.severity,
        title,
        description,
        evidence: evidenceData,
        sourceModule: skillName,
        confidence: calculateConfidence(evidenceData, schema.evidenceFields),
      });
    }
  }

  return findings;
}

/**
 * Extract suggestions from skill execution results based on suggestionsSchema
 */
export function extractSuggestions(
  skillName: string,
  suggestionsSchema: SuggestionSchema[] | undefined,
  executionContext: SkillExecutionContext,
  stepResults: Record<string, StepResult>
): ExtractedSuggestion[] {
  if (!suggestionsSchema || suggestionsSchema.length === 0) {
    return [];
  }

  const suggestions: ExtractedSuggestion[] = [];

  for (const schema of suggestionsSchema) {
    // Evaluate the condition to see if this suggestion applies
    const conditionMet = evaluateSuggestionCondition(
      schema.condition,
      executionContext,
      stepResults
    );

    if (conditionMet) {
      // Map parameters from current results to target params
      const params: Record<string, any> = {};
      if (schema.paramsMapping) {
        for (const [targetKey, sourcePath] of Object.entries(schema.paramsMapping)) {
          const value = resolveFieldPath(sourcePath, executionContext, stepResults);
          if (value !== undefined) {
            params[targetKey] = value;
          }
        }
      }

      // Substitute template placeholders in question
      const questionTemplate = substituteTemplate(schema.questionTemplate, params);

      suggestions.push({
        id: `${skillName}_${schema.id}`,
        targetModule: schema.targetModule,
        questionTemplate,
        params,
        priority: schema.priority ?? 100,
        reason: `Triggered by condition: ${schema.condition}`,
      });
    }
  }

  // Sort by priority (lower = higher priority)
  suggestions.sort((a, b) => a.priority - b.priority);

  return suggestions;
}

/**
 * Resolve a field path to get its value from context or step results
 * Supports paths like: "step_id.field_name", "params.value", "variables.name"
 */
function resolveFieldPath(
  path: string,
  context: SkillExecutionContext,
  stepResults: Record<string, StepResult>
): any {
  const parts = path.split('.');
  if (parts.length === 0) return undefined;

  const root = parts[0];
  const rest = parts.slice(1);

  let value: any;

  // Try to resolve from different sources
  if (stepResults[root]?.data !== undefined) {
    value = stepResults[root].data;
  } else if (context.variables[root] !== undefined) {
    value = context.variables[root];
  } else if (context.params[root] !== undefined) {
    value = context.params[root];
  } else if (context.inherited[root] !== undefined) {
    value = context.inherited[root];
  } else {
    return undefined;
  }

  // Navigate the rest of the path
  for (const part of rest) {
    if (value === undefined || value === null) return undefined;

    // Handle array index
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      value = value[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
    } else if (Array.isArray(value) && !isNaN(parseInt(part))) {
      value = value[parseInt(part)];
    } else {
      value = value[part];
    }
  }

  return value;
}

/**
 * Substitute template placeholders {field_name} with actual values
 */
function substituteTemplate(
  template: string,
  values: Record<string, any>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null) return `{${key}}`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Evaluate a suggestion condition expression
 * Supports simple comparisons like: "field != value", "field > value"
 */
function evaluateSuggestionCondition(
  condition: string,
  context: SkillExecutionContext,
  stepResults: Record<string, StepResult>
): boolean {
  try {
    // Parse simple conditions: "field operator value"
    const operators = ['!=', '==', '>=', '<=', '>', '<', '===', '!=='];

    for (const op of operators) {
      const parts = condition.split(op).map(s => s.trim());
      if (parts.length === 2) {
        const leftPath = parts[0];
        const rightValue = parts[1];

        const leftValue = resolveFieldPath(leftPath, context, stepResults);

        // Handle quoted string values
        let right: any = rightValue;
        if (rightValue.startsWith('"') && rightValue.endsWith('"')) {
          right = rightValue.slice(1, -1);
        } else if (rightValue.startsWith("'") && rightValue.endsWith("'")) {
          right = rightValue.slice(1, -1);
        } else if (!isNaN(Number(rightValue))) {
          right = Number(rightValue);
        } else if (rightValue === 'true') {
          right = true;
        } else if (rightValue === 'false') {
          right = false;
        } else if (rightValue === 'null' || rightValue === 'undefined') {
          right = null;
        } else {
          // It might be a field path
          right = resolveFieldPath(rightValue, context, stepResults);
        }

        // Perform comparison
        switch (op) {
          case '!=':
          case '!==':
            return leftValue !== right;
          case '==':
          case '===':
            return leftValue === right;
          case '>':
            return leftValue > right;
          case '<':
            return leftValue < right;
          case '>=':
            return leftValue >= right;
          case '<=':
            return leftValue <= right;
        }
      }
    }

    // If no operator found, treat as truthy check
    const value = resolveFieldPath(condition, context, stepResults);
    return Boolean(value);
  } catch (e) {
    console.warn(`[extractSuggestions] Failed to evaluate condition: ${condition}`, e);
    return false;
  }
}

/**
 * Calculate confidence score based on evidence completeness
 */
function calculateConfidence(
  evidence: Record<string, any>,
  expectedFields?: string[]
): number {
  if (!expectedFields || expectedFields.length === 0) {
    return Object.keys(evidence).length > 0 ? 0.7 : 0;
  }

  const foundFields = expectedFields.filter(f => evidence[f] !== undefined);
  return foundFields.length / expectedFields.length;
}

// =============================================================================
// 工厂函数
// =============================================================================

export function createSkillExecutor(
  traceProcessor: any,
  aiService?: any,
  eventEmitter?: (event: SkillEvent) => void
): SkillExecutor {
  return new SkillExecutor(traceProcessor, aiService, eventEmitter);
}
