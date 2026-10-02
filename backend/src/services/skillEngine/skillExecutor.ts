// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
  PipelineStep,
  SkillExecutionContext,
  SkillExecutionResult,
  StepResult,
  DisplayResult,
  DiagnosticResult,
  DisplayConfig,
  SkillEvent,
  SynthesizeConfig,
} from './types';
import { validateSkillInputs } from './skillValidator';
import {
  EXPRESSION_GLOBALS, SKILL_PLACEHOLDER, decodeIdentifier, extractRootVariables, identifierMatches, isBindableName,
  ownDataValue, parseEvidenceField, readEvidenceField, routePlaceholder, wholePlaceholderBody,
} from './expressionUtils';
import { injectFragmentCtes } from './skillFragments';
import {
  absentPlaceholderSql, boundSqlPlaceholderPaths, readPlaceholderBody, sqlCodeText, sqlIdentifier, sqlLiteral,
  sqlStringLiteralText, substituteSqlPlaceholders,
} from './sqlTemplate';
import { EXACT_UPID_TOKEN, getExactProcessScopeSupport, sqlScopeDeclarationError, selectProcessScopeSql, type ScopedSqlSource } from './processScopeSql';
import { assertEffectiveProcessScope, type EffectiveProcessScope } from '../processIdentity/effectiveProcessScope';
import { sqlScopeEvidence, resultScopeProvenance, resultScopeLimitations } from './scopeEvidence';
import { SYNTHESIZE_SUMMARY_STEP_ID, exposedStepResult, hasMeaningfulData, selectReferencedSkillStep, selectedStepResult } from './referencedSkillStep';
import {attachInvestigationEvidence, investigationCaptureFields, validateInvestigationEvidenceDeclarations} from '../evidence/investigationEvidenceLedger';
import {attachEvidenceTable, captureEvidenceTable, capturedEvidenceTable, evidenceTableFor, evidenceCaptureHash,
  type CapturedFieldSemantics} from '../evidence/evidenceCapture';
import { scopeMetadata, mergeScopeProvenance, identityForScopeEvidence, scopeProvenanceForFields, type EvidenceScopeMetadata, type EvidenceScopeProvenanceV1 } from '../../types/identityContract';
import logger from '../../utils/logger';
import { parseLlmJson } from '../../utils/llmJson';
import { redactObjectForLLM, redactTextForLLM } from '../../utils/llmPrivacy';
import { getPipelineDocService } from '../pipelineDocService';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  PinInstruction,
} from '../pipelineSkillLoader';
import { TEACHING_DEFAULTS, TEACHING_LIMITS } from '../../config/teaching.config';
import {
  parseCandidates,
  parseFeatures,
  transformPinInstruction,
  validateActiveProcesses,
  validateConfidence,
  type PinInstructionResponse,
  type RawPinInstruction,
  type SkillStepResult,
  type TeachingContentResponse,
} from '../../types/teaching.types';
import {
  DataEnvelope,
  DataEnvelopeMeta,
  DataEnvelopeTraceSide,
  ColumnDefinition,
  displayResultToEnvelope,
} from '../../types/dataContract';
import {
  formatDisplayContractIssue,
  sanitizeDisplayConfigForRuntime,
} from './displayContractValidator';
import { IdentityGate, type IdentityGateResult } from '../processIdentity/identityGate';
import { buildIdentityResolutionFromProcessGate } from '../processIdentity/identityContractMapper';
import type { IdentityResolutionV1, IdentityTraceSide } from '../../types/identityContract';
import type {
  ProcessIdentityCandidate,
  ProcessIdentityResolution,
  ProcessIdentityTarget,
} from '../processIdentity/types';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from '../traceProcessorCancellation';
import {
  AiDisabledError,
  assertAiFeatureEnabled,
  getAiCapabilityPolicy,
  isAiFeatureEnabled,
} from '../aiCapabilityPolicy';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {
  currentRunManifestAttributionSink,
  resolveRunManifestAttributionSink,
} from '../selfEvolution/runManifestLifecycle';
import {fingerprintSkillDefinition} from '../selfEvolution/skillFingerprint';

// =============================================================================
// Layered Result Types
// =============================================================================

import { DisplayLayer } from './types';
import { isObservedStepResult, isOptionalStep, isQueryOrSkillResult, nonObservedStepState, type StepExecutionState } from './stepExecutionState';

/**
 * Synthesize Data - 标记为 synthesize 的步骤数据
 * 用于最终总结时的数据聚合
 */
export interface SynthesizeData extends EvidenceScopeMetadata, StepExecutionState {
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
 * - diagnosis: 诊断结论与根因证据
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
    /** 诊断层 - 根因/结论证据 */
    diagnosis?: Record<string, StepResult>;
  };
  defaultExpanded: DisplayLayer[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
  /** Raw step results, including hidden/no-layer steps. */
  stepResults?: StepResult[];
  scopeProvenance?: EvidenceScopeProvenanceV1;
  scopeLimitations?: string[];
  partial?: boolean;
  /** YAML 中标记为 synthesize: true 的步骤数据，用于最终总结 */
  synthesizeData?: SynthesizeData[];
}

/** Diagnostic evidence bounds (string code points, keys per row): evidence reaches LLM payloads. */
const EVIDENCE_STRING_MAX_CHARS = 256;
const EVIDENCE_MAX_KEYS = 64;

/**
 * evidence 值的有界投影：行集只留行数和首行，行只留一层标量字段，长字符串截断。
 * 只读自有数据属性（不执行 getter），不递归：嵌套值只留占位，深层或循环的值都是固定大小。
 */
function boundEvidenceValue(value: unknown): unknown {
  if (!Array.isArray(value)) return boundEvidenceRow(value);
  return value.length === 0
    ? { _rowCount: 0 }
    : { _rowCount: value.length, _firstRow: boundEvidenceRow(ownDataValue(value, '0')) };
}

function boundEvidenceRow(value: unknown): unknown {
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  if (!value || typeof value !== 'object') return truncateEvidenceString(value);
  return Object.fromEntries(Object.keys(value).slice(0, EVIDENCE_MAX_KEYS).map(key => {
    const field = ownDataValue(value, key);
    return [key, Array.isArray(field) ? `[Array(${field.length})]`
      : field && typeof field === 'object' ? '[Object]' : truncateEvidenceString(field)];
  }));
}

function truncateEvidenceString(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= EVIDENCE_STRING_MAX_CHARS) return value;
  const codePoints = Array.from(value);
  return codePoints.length > EVIDENCE_STRING_MAX_CHARS
    ? `${codePoints.slice(0, EVIDENCE_STRING_MAX_CHARS).join('')}…`
    : value;
}

function getSkillExecutionSignal(inherited: Record<string, any> | undefined): AbortSignal | undefined {
  const signal = inherited?.signal;
  if (
    signal &&
    typeof signal === 'object' &&
    typeof (signal as AbortSignal).aborted === 'boolean' &&
    typeof (signal as AbortSignal).addEventListener === 'function'
  ) {
    return signal as AbortSignal;
  }
  return undefined;
}

function mergeInheritedWithSignal(
  inherited: Record<string, any>,
  signal?: AbortSignal,
): Record<string, any> {
  return signal ? { ...inherited, signal } : inherited;
}

/**
 * 将 YAML 中的 layer 值规范化为语义名称
 */
export function normalizeLayer(layer: string | undefined): DisplayLayer | undefined {
  if (!layer) return undefined;
  // 只接受语义名称
  if (['overview', 'list', 'session', 'deep', 'diagnosis'].includes(layer)) {
    return layer as DisplayLayer;
  }
  return undefined;
}

// =============================================================================
// 表达式求值器
// =============================================================================

/** The innermost scope that binds a root name, and the raw value it holds there. */
type RootBinding =
  | { source: 'item' | 'variable' | 'param' | 'inherited'; value: any }
  // `result` is the step the value comes from; a failed Skill reference has none.
  | { source: 'result'; value: any; result?: StepResult };

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
    // 整串是一个 ${...}（不是 "${a} + ${b}" 这样的模板）时求它的值；路径还是 JS 由 routePlaceholder 决定
    const wholeBody = wholePlaceholderBody(expression);
    if (wholeBody !== undefined) {
      const route = routePlaceholder(wholeBody, true);
      if (route.kind === 'js') return this.evaluateJsExpression(route.expression, context);
      const value = this.resolvePath(route.path, context);
      if (value !== undefined && value !== null) return value;
      // A whole placeholder is a path only with a default: try number, boolean, then string
      const defaultPart = route.defaultValue ?? '';
      if (/^\d+(\.\d+)?$/.test(defaultPart)) return parseFloat(defaultPart);
      if (defaultPart === 'true') return true;
      if (defaultPart === 'false') return false;
      return defaultPart;
    }

    // 否则逐个替换 ${...}：路径走 resolvePath，其余走 JS 表达式求值（例如: a * 16.7, foo?.bar, arr.find(...)）
    const asText = (value: unknown) => typeof value === 'object' ? JSON.stringify(value) : String(value);
    const result = expression.replace(SKILL_PLACEHOLDER, (_match, inner) => {
      const route = routePlaceholder(String(inner ?? ''), false);
      if (route.kind === 'path') {
        const value = this.resolvePath(route.path, context);
        return value === undefined || value === null ? route.defaultValue ?? '' : asText(value);
      }
      // 嵌入的 JS：求值和转成文本的任何异常都替换为空串
      try {
        const value = this.evaluateJsExpression(route.expression, context);
        return value === undefined || value === null ? '' : asText(value);
      } catch {
        logger.debug('ExpressionEvaluator', `Failed to evaluate embedded JS: ${route.expression}`);
        return '';
      }
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
      // 构建作用域对象。标准全局（parseFloat、Math…）和保留字不绑定；其余名字按 Skill 作用域解析，
      // 未找到的也显式注入 undefined，避免 ReferenceError（例如 expr: "package"）
      const scope: Record<string, any> = {};

      for (const varName of this.scopeCandidates(expr)) {
        if (!isBindableName(varName) || EXPRESSION_GLOBALS.has(varName)) continue;
        const binding = this.resolveRootBinding(varName, context);
        scope[varName] = binding?.source === 'result' || binding?.source === 'variable'
          ? this.wrapAsDataScope(binding.value)
          : binding?.value;
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
   * 从表达式中提取根变量名，用于绑定求值作用域
   * "performance_summary.data[0]?.app_jank_rate > 10" => ["performance_summary"]
   * "jank_stats.data.find(j => j.jank_type)" => ["jank_stats", "j"]
   *
   * 结果必须是表达式可能读到的根名的超集：漏掉一个就是 ReferenceError，规则静默不触发；
   * 多出来的名字（字面量里的词、对象键、关键字）只会被跳过或绑定为 undefined。所以这里
   * 不剥离字面量，只排除属性名（`.x`、`?.x`，但 `...x` 是展开的根名）；哪些名字不绑定
   * 由求值时决定。extractRootVariables 求精确（校验与 evidence 引用用），不能用来绑定作用域。
   */
  private static scopeCandidates(expr: string): string[] {
    const varNames = new Set<string>();
    for (const match of identifierMatches(expr)) {
      const before = expr.substring(0, match.index).trimEnd();
      if (!before.endsWith('.') || before.endsWith('...')) varNames.add(decodeIdentifier(match[0]));
    }

    return Array.from(varNames);
  }

  /**
   * Unwrap SkillExecutionResult-like objects from referenced skills.
   * A bound value can still hold a nested Skill result (a child step that is
   * itself a Skill reference), while most YAML expressions expect plain row
   * arrays at `.data`; it unwraps to the step a save_as of it would bind.
   */
  private static unwrapSkillResultData(value: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const selected = selectReferencedSkillStep(value);
    if (selected) return selected.data;

    const maybeSkillResult = value as Record<string, any>;

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
   * Resolve a root name, innermost scope first (order documented in
   * docs/reference/skill-system.md, 解析优先级): iteration item, save_as, step
   * result, input, inherited. Every name reader resolves here, so a calling
   * Skill's value never stands in for this Skill's own binding. A `null`
   * save_as counts as bound: a step that ran without observing a result stops here.
   */
  static resolveRootBinding(name: string, context: SkillExecutionContext): RootBinding | undefined {
    const item = context.currentItem;
    if (item) {
      if (name === 'item') return { source: 'item', value: item };
      if (typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, name) && item[name] !== undefined) {
        return { source: 'item', value: item[name] };
      }
    }
    if (context.variables[name] !== undefined) return { source: 'variable', value: context.variables[name] };
    const result = context.results[name];
    if (result) {
      const step = exposedStepResult(result);
      return { source: 'result', value: step?.data, result: step };
    }
    if (context.params?.[name] !== undefined) return { source: 'param', value: context.params[name] };
    if (context.inherited?.[name] !== undefined) return { source: 'inherited', value: context.inherited[name] };
    return undefined;
  }

  /** What `name.data` reads in a rule expression; undefined when the name is unbound. */
  static readDataView(name: string, context: SkillExecutionContext): unknown {
    const binding = this.resolveRootBinding(name, context);
    if (!binding) return undefined;
    return binding.source === 'result' || binding.source === 'variable'
      ? this.unwrapSkillResultData(binding.value)
      : (binding.value as any)?.data;
  }

  /** The value a root name holds, without the `.data` wrapper expressions see. */
  static resolveRootValue(name: string, context: SkillExecutionContext): any {
    return this.resolveRootBinding(name, context)?.value;
  }

  /**
   * 解析路径引用，支持深层嵌套和数组索引
   * 例如: "step1.data[0].field" 或 "performance_summary.data[0].app_jank_rate"
   */
  static resolvePath(path: string, context: SkillExecutionContext): any {
    // 解析路径为 token 数组，支持 . 分隔和 [n] 数组索引
    const tokens = this.parsePath(path);
    if (tokens.length === 0) return undefined;

    const binding = this.resolveRootBinding(tokens[0], context);
    if (!binding) return undefined;

    // 步骤结果包装成 { data } 以支持 ${step.data[0].name}；save_as 变量只在路径写了
    // .data 时包装，否则直接访问数组元素，如 ${main_slices[0].name}
    let value: any = binding.source === 'result' || (binding.source === 'variable' && tokens[1] === 'data')
      ? this.wrapAsDataScope(binding.value)
      : binding.value;

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
  return substituteSqlPlaceholders(sql, (placeholder) => {
    const {match, path: actualPath} = placeholder;
    if (actualPath === '__process_scope' || actualPath.startsWith('__process_scope.')) {
      if (match !== EXACT_UPID_TOKEN) throw new Error('Unsupported reserved process scope binding');
      const scope = context.processScope;
      if (!scope) throw new Error('Reserved process scope binding requires an issued process scope');
      assertEffectiveProcessScope(scope, context.traceId, scope.traceSide);
      return scope.mode === 'exact_upid' ? String(scope.upid) : 'NULL';
    }
    const value = ExpressionEvaluator.resolvePath(actualPath, context);

    // 缺省值：显式 |default（作者写的 SQL 文本，原样插入），否则字符串内 ''、其它位置 NULL
    if (value === undefined || value === null) return absentPlaceholderSql(placeholder);

    // 字符串常量内部：转义单引号；GLOB/LIKE 模式字面量里值的通配符按字面匹配
    if (placeholder.context === 'string') return sqlStringLiteralText(value, placeholder);

    if (Array.isArray(value)) {
      if (value.length === 0) return '';
      // save_as 存储的是行数组 [{col: val, ...}, ...]。
      // 当下游 SQL 用 SELECT * FROM ${variable} 引用时，需要转为 inline CTE。
      if (value[0] !== null && typeof value[0] === 'object') return arrayToInlineCte(value);
      return value.map(sqlLiteral).join(', ');
    }

    // 代码位置只接受数字或 SQL 字面量列表，其它文本会成为调用方写的 SQL
    return sqlCodeText(value, placeholder);
  });
}

/**
 * Convert a save_as row array to an inline SQLite CTE.
 * [{a: 1, b: 'x'}, {a: 2, b: 'y'}]  →  (SELECT 1 as "a", 'x' as "b" UNION ALL SELECT 2, 'y')
 */
function arrayToInlineCte(rows: Record<string, unknown>[]): string {
  const columns = Object.keys(rows[0]);
  const selects = rows.map((row, i) => {
    const values = columns.map((col) => sqlLiteral(row[col]));
    // First row includes column aliases; subsequent rows omit them
    if (i === 0) {
      return `SELECT ${values.map((v, j) => `${v} as ${sqlIdentifier(columns[j])}`).join(', ')}`;
    }
    return `SELECT ${values.join(', ')}`;
  });
  return `(${selects.join(' UNION ALL ')})`;
}

/**
 * A display title's placeholders as plain text. An unset value takes its
 * `|default`, or stays visible, as localized titles do.
 */
function substituteDisplayText(text: string, context: SkillExecutionContext): string {
  return text.replace(SKILL_PLACEHOLDER, (match: string, body: string) => {
    const {path: actualPath, defaultValue} = readPlaceholderBody(body);
    const value = ExpressionEvaluator.resolvePath(actualPath, context);
    if (value === undefined || value === null) return defaultValue ?? match;
    return String(value);
  });
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
    processed.title = substituteDisplayText(processed.title, context);
  }

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
          // Q4a (IO-block) + Q4b (voluntary sleep) both contribute to Q4 total
          else if (quadrant.includes('Q4')) mainThread.q4 = (mainThread.q4 || 0) + percentage;
        } else if (quadrant.includes('RenderThread')) {
          if (quadrant.includes('Q1')) renderThread.q1 = percentage;
          else if (quadrant.includes('Q2')) renderThread.q2 = percentage;
          else if (quadrant.includes('Q3')) renderThread.q3 = percentage;
          else if (quadrant.includes('Q4')) renderThread.q4 = (renderThread.q4 || 0) + percentage;
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

function firstNonEmptyFrameIdentifier(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function deepFrameEntryKey(item: any, fallbackIndex: number): string {
  const identity = firstNonEmptyFrameIdentifier(item?.frame_identity_key);
  if (identity) return `frame_${encodeURIComponent(identity)}`;
  const legacyIdentity = firstNonEmptyFrameIdentifier(
    item?.frame_id,
    item?.frame_index,
    fallbackIndex,
  );
  return `frame_${legacyIdentity ?? fallbackIndex}`;
}

function frameDisplayIdentifier(item: any, fallbackIndex: number): string {
  return firstNonEmptyFrameIdentifier(item?.frame_id, item?.frame_index, fallbackIndex)
    ?? String(fallbackIndex);
}

function organizeByLayer(steps: StepResult[]): LayeredResult['layers'] {
  const layers: LayeredResult['layers'] = {
    overview: {},
    list: {},
    session: {},
    deep: {},
    diagnosis: {},
  };

  for (const step of steps) {
    const rawLayer = step.display?.layer;
    if (!rawLayer) {
      continue;
    }

    // 规范化 layer 名称为语义名称（overview/list/session/deep/diagnosis）
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
      case 'diagnosis':
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

              const frameId = deepFrameEntryKey(item, i);
              const frameDisplayId = frameDisplayIdentifier(item, i);
              const sessionId = `session_${item.session_id ?? 0}`;

              if (!deepLayer[sessionId]) {
                deepLayer[sessionId] = {};
              }

              // Transform displayResults into format expected by frontend
              const displayResults = iterItem.result?.displayResults || [];
              const transformedData = transformDeepFrameAnalysis(displayResults);

              const frameStepResult: StepResult = {
                ...scopeMetadata(resultScopeProvenance(iterItem.result)),
                stepId: frameId,
                stepType: 'atomic',
                success: iterItem.result?.success ?? false,
                data: transformedData,
                executionTimeMs: iterItem.result?.executionTimeMs || 0,
                display: {
                  title: `帧 #${frameDisplayId} - ${item.jank_type || 'Unknown'}`,
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

                const frameId = deepFrameEntryKey(item, i);
                const frameDisplayId = frameDisplayIdentifier(item, i);
                const sessionId = `session_${item.session_id ?? 0}`;

                if (!deepLayer[sessionId]) {
                  deepLayer[sessionId] = {};
                }

                const frameStepResult: StepResult = {
                  ...scopeMetadata(resultScopeProvenance(normalizedStep)),
                  sql: normalizedStep.sql,
                  stepId: frameId,
                  stepType: 'atomic',
                  success: normalizedStep.success,
                  data: [item],
                  executionTimeMs: normalizedStep.executionTimeMs / normalizedStep.data.length,
                  display: {
                    title: `帧 #${frameDisplayId} - ${item.jank_type || 'Unknown'}`,
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
  private fragmentRegistry: Map<string, string> = new Map();
  private identityGate = new IdentityGate();
  private processIdentityCache: Map<string, ProcessIdentityResolution> = new Map();
  private runManifestAttributionSink?: RunManifestAttributionSink;

  constructor(
    traceProcessor: any,
    aiService?: any,
    eventEmitter?: (event: SkillEvent) => void,
    runManifestAttributionSink?: RunManifestAttributionSink,
  ) {
    this.traceProcessor = traceProcessor;
    this.aiService = aiService;
    this.eventEmitter = eventEmitter;
    this.skillRegistry = new Map();
    this.runManifestAttributionSink = runManifestAttributionSink;
  }

  setRunManifestAttributionSink(
    sink: RunManifestAttributionSink | undefined,
  ): void {
    this.runManifestAttributionSink = sink;
  }

  private queryTraceProcessor(
    traceId: string,
    sql: string,
    options: Record<string, any> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    const queryOptions = {
      ...options,
      ...(signal ? { signal } : {}),
    };
    const query = Object.keys(queryOptions).length > 0
      ? this.traceProcessor.query(traceId, sql, queryOptions)
      : this.traceProcessor.query(traceId, sql);
    return query;
  }

  /**
   * Set the SQL fragment registry (loaded by SkillRegistry).
   * Fragments are reusable CTE definitions injected into step SQL at runtime.
   */
  setFragmentRegistry(cache: Map<string, string>): void {
    this.fragmentRegistry = cache;
  }

  /**
   * Inject SQL fragment CTEs into a step's SQL query.
   *
   * Fragment files contain bare CTE definitions (no WITH keyword), e.g.:
   *   target_threads AS (SELECT ...)
   *
   * Injection rules:
   * - If the SQL starts with WITH: insert fragments after WITH, before existing CTEs
   * - Otherwise: wrap as WITH <fragments>\n<sql>
   */
  private injectSqlFragments(
    sql: string,
    fragmentPaths: string[],
    context: SkillExecutionContext,
  ): string {
    const fragmentCteBodies: string[] = [];

    for (const fragPath of fragmentPaths) {
      const content = this.fragmentRegistry.get(fragPath);
      if (!content) {
        logger.warn('SkillExecutor', `Fragment not found: ${fragPath}, skipping`);
        continue;
      }
      // Apply variable substitution to the fragment content
      const substituted = substituteVariables(content, context);
      fragmentCteBodies.push(substituted);
    }

    return injectFragmentCtes(sql, fragmentCteBodies);
  }

  /**
   * 注册 skill
   */
  registerSkill(skill: SkillDefinition): void {
    validateInvestigationEvidenceDeclarations(skill);
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

  replaceRegisteredSkills(skills: SkillDefinition[]): void {
    this.skillRegistry.clear();
    this.registerSkills(skills);
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

  private resolveTraceSide(inherited: Record<string, any>): IdentityTraceSide {
    const value = inherited.__traceSide;
    return value === 'current' || value === 'reference' || value === 'unknown'
      ? value
      : 'current';
  }

  private buildIdentityCacheKey(traceId: string, target: ProcessIdentityTarget): string {
    return JSON.stringify({
      traceId,
      requestedName: target.requestedName || '',
      threadName: target.threadName || '',
      upid: target.upid ?? null,
      pid: target.pid ?? null,
      startTs: target.startTs ?? null,
      endTs: target.endTs ?? null,
    });
  }

  private buildAiDisabledStepResult(
    stepId: string,
    stepType: StepResult['stepType'],
    startTime: number,
  ): StepResult | null {
    const policy = getAiCapabilityPolicy();
    if (isAiFeatureEnabled('llm_skill_step', policy)) {
      return null;
    }
    const error = new AiDisabledError('llm_skill_step', policy);
    return {
      stepId,
      stepType,
      success: false,
      error: error.message,
      code: error.code,
      data: {
        code: error.code,
        feature: error.feature,
      },
      executionTimeMs: Date.now() - startTime,
    };
  }

  private toNumber(value: any): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private splitSources(...values: Array<any>): string[] {
    const sources = new Set<string>();
    for (const value of values) {
      if (typeof value !== 'string') continue;
      for (const part of value.split(',')) {
        const s = part.trim();
        if (s) sources.add(s);
      }
    }
    return Array.from(sources);
  }

  private rowToIdentityCandidate(row: Record<string, any>): ProcessIdentityCandidate {
    return {
      rank: this.toNumber(row.rank) ?? 0,
      confidenceScore: this.toNumber(row.confidence_score) ?? 0,
      rawStatus: row.identity_status ? String(row.identity_status) : undefined,
      canonicalPackageName: row.canonical_package_name ? String(row.canonical_package_name) : undefined,
      recommendedProcessNameParam: row.recommended_process_name_param ? String(row.recommended_process_name_param) : undefined,
      upid: this.toNumber(row.upid),
      pid: this.toNumber(row.pid),
      processName: row.process_name ? String(row.process_name) : undefined,
      metadataProcessName: row.metadata_process_name ? String(row.metadata_process_name) : undefined,
      packageName: row.package_name ? String(row.package_name) : undefined,
      cmdline: row.cmdline ? String(row.cmdline) : undefined,
      targetMatchSources: row.target_match_sources ? String(row.target_match_sources) : undefined,
      supportingSources: row.supporting_sources ? String(row.supporting_sources) : undefined,
      identityWarning: row.identity_warning ? String(row.identity_warning) : undefined,
      threadUtid: this.toNumber(row.thread_utid),
      threadTid: this.toNumber(row.thread_tid),
      threadName: row.thread_name ? String(row.thread_name) : undefined,
      threadRole: row.thread_role === 'app_main' || row.thread_role === 'render_thread'
        ? row.thread_role
        : this.toNumber(row.thread_utid) !== undefined ? 'unknown' : undefined,
      threadTargetMatched: this.toNumber(row.thread_target_matched) === 1,
    };
  }

  private hasExactProcessIdTarget(
    target: ProcessIdentityTarget,
    candidate: ProcessIdentityCandidate | undefined,
  ): boolean {
    if (!candidate) return false;
    const sources = new Set(this.splitSources(candidate.targetMatchSources));
    return Boolean(target.upid !== undefined && candidate.upid === target.upid && sources.has('upid'));
  }

  private hasExactProcessNameTarget(
    target: ProcessIdentityTarget,
    candidate: ProcessIdentityCandidate | undefined,
  ): boolean {
    const requestedName = target.requestedName?.trim();
    if (!requestedName || !candidate) return false;
    return [
      candidate.processName,
      candidate.metadataProcessName,
      candidate.cmdline,
      candidate.recommendedProcessNameParam,
    ].some(value => value === requestedName);
  }

  private identityQualityWarnings(
    candidate: ProcessIdentityCandidate | undefined,
    candidates: ProcessIdentityCandidate[],
    target: ProcessIdentityTarget,
  ): string[] {
    if (!candidate) return [];
    const warnings = new Set<string>();
    const warning = candidate.identityWarning && candidate.identityWarning !== 'ok'
      ? candidate.identityWarning
      : undefined;
    if (warning) warnings.add(warning);

    const targetSources = new Set(this.splitSources(candidate.targetMatchSources));
    const hasProcessTarget = Boolean(
      target.requestedName ||
      target.upid !== undefined ||
      target.pid !== undefined,
    );
    const hasExactProcessId = this.hasExactProcessIdTarget(target, candidate);
    const processLevelSources = Array.from(targetSources)
      .filter(source => source !== 'thread.name');

    if (target.threadName && !hasProcessTarget) {
      warnings.add('thread-only identity target is not enough to verify a unique process');
    }
    if (processLevelSources.length === 0) {
      warnings.add('identity candidate has no process-level target match source');
    }
    if (candidate.rawStatus === 'probable' && !hasExactProcessId) {
      warnings.add('probable identity match requires additional confirmation before parameter rewrite');
    }

    const closeCandidates = candidates.filter(item =>
      item !== candidate &&
      item.confidenceScore > 0 &&
      candidate.confidenceScore - item.confidenceScore < 20);
    const exactRequestedProcess = this.hasExactProcessNameTarget(target, candidate);
    const closeExactRequestedProcess = closeCandidates.some(item =>
      this.hasExactProcessNameTarget(target, item));
    if (closeCandidates.length > 0 && (!exactRequestedProcess || closeExactRequestedProcess)) {
      warnings.add('multiple close process identity candidates require manual confirmation');
    }
    return Array.from(warnings);
  }

  private normalizeIdentityStatus(
    candidate: ProcessIdentityCandidate | undefined,
    candidates: ProcessIdentityCandidate[],
    target: ProcessIdentityTarget,
  ): ProcessIdentityResolution['status'] {
    if (!candidate) return 'not_found';
    if (candidate.confidenceScore <= 0) return 'not_found';
    const qualityWarnings = this.identityQualityWarnings(candidate, candidates, target);
    const hasExactProcessId = this.hasExactProcessIdTarget(target, candidate);
    if (qualityWarnings.length === 0 &&
      (
        (candidate.rawStatus === 'confirmed' && candidate.confidenceScore >= 80) ||
        (hasExactProcessId && candidate.confidenceScore >= 50)
      )
    ) {
      return 'verified';
    }
    return 'ambiguous';
  }

  private async resolveProcessIdentityForGate(
    traceId: string,
    target: ProcessIdentityTarget,
    inherited: Record<string, any>,
  ): Promise<ProcessIdentityResolution> {
    const cacheKey = this.buildIdentityCacheKey(traceId, target);
    const cached = this.processIdentityCache.get(cacheKey);
    if (cached) return cached;

    const params: Record<string, any> = {
      max_rows: 10,
    };
    if (target.requestedName) {
      params.package = target.requestedName;
      params.process_name = target.requestedName;
    }
    if (target.threadName) params.thread_name = target.threadName;
    if (target.upid !== undefined) params.upid = target.upid;
    if (target.pid !== undefined) params.pid = target.pid;
    if (target.startTs !== undefined) params.start_ts = target.startTs;
    if (target.endTs !== undefined) params.end_ts = target.endTs;

    let resolution: ProcessIdentityResolution;
    try {
      let verifiedTarget = target;
      if (target.pid !== undefined && target.upid === undefined) {
        if (!Number.isSafeInteger(target.pid) || target.pid <= 0) throw new Error('Invalid PID selector');
        // Check the entire trace's process table before the ranked resolver can
        // truncate candidates or let activity choose between reused OS PIDs.
        const lookup = await this.queryTraceProcessor(traceId,
          `SELECT COUNT(DISTINCT upid) AS process_count, MIN(upid) AS unique_upid FROM process WHERE pid = ${target.pid}`,
          {}, inherited.signal);
        if (lookup.error) throw new Error(lookup.error);
        if (!Array.isArray(lookup.rows) || lookup.rows.length !== 1) throw new Error('PID uniqueness query returned incomplete facts');
        const row = lookup.rows[0];
        const facts = Array.isArray(row)
          ? Object.fromEntries((lookup.columns || []).map((column: string, index: number) => [column, row[index]]))
          : row;
        const count = this.toNumber(facts?.process_count);
        const upid = this.toNumber(facts?.unique_upid);
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error('PID uniqueness count is unavailable');
        if (count !== 1) {
          return {status: count === 0 ? 'not_found' : 'ambiguous', requestedName: target.requestedName,
            upids: [], confidenceScore: 0, candidates: [], evidenceSources: ['process.pid'],
            warnings: [`PID ${target.pid} maps to ${count} UPIDs in this trace; select an explicit UPID.`]};
        }
        if (upid === undefined || !Number.isSafeInteger(upid) || upid <= 0) throw new Error('PID uniqueness query returned an invalid UPID');
        verifiedTarget = {...target, upid};
        params.upid = upid;
      }
      const result = await this.execute(
        'process_identity_resolver',
        traceId,
        params,
        { ...inherited, __skipIdentityGate: true },
      );

      if (!result.success) {
        resolution = {
          status: 'unresolved',
          requestedName: target.requestedName,
          upids: [],
          confidenceScore: 0,
          evidenceSources: [],
          warnings: [],
          candidates: [],
          resolverError: result.error || 'process_identity_resolver failed',
        };
      } else {
        const rows = Array.isArray(result.rawResults?.root?.data)
          ? result.rawResults.root.data as Record<string, any>[]
          : [];
        const candidates = rows.map(row => this.rowToIdentityCandidate(row))
          .filter(candidate => verifiedTarget.upid === undefined || candidate.upid === verifiedTarget.upid);
        const top = candidates[0];
        const qualityWarnings = this.identityQualityWarnings(top, candidates, verifiedTarget);
        const status = this.normalizeIdentityStatus(top, candidates, verifiedTarget);
        resolution = {
          status,
          requestedName: target.requestedName,
          canonicalPackageName: top?.canonicalPackageName,
          recommendedProcessNameParam: top?.recommendedProcessNameParam,
          upids: top?.upid !== undefined && status === 'verified'
            ? [top.upid] : [],
          confidenceScore: top?.confidenceScore ?? 0,
          rawStatus: top?.rawStatus,
          evidenceSources: this.splitSources(top?.targetMatchSources, top?.supportingSources,
            verifiedTarget !== target ? 'process.pid_unique_upid' : undefined),
          warnings: qualityWarnings,
          candidates,
        };
      }
    } catch (error: any) {
      rethrowIfTraceProcessorQueryCancelled(error);
      resolution = {
        status: 'unresolved',
        requestedName: target.requestedName,
        upids: [],
        confidenceScore: 0,
        evidenceSources: [],
        warnings: [],
        candidates: [],
        resolverError: error?.message || 'process_identity_resolver threw',
      };
    }

    if (!resolution.resolverError) {
      this.processIdentityCache.set(cacheKey, resolution);
    }
    return resolution;
  }

  private async applyIdentityGate(
    skill: SkillDefinition,
    traceId: string,
    params: Record<string, any>,
    inherited: Record<string, any>,
    processScope?: EffectiveProcessScope,
  ): Promise<IdentityGateResult> {
    return this.identityGate.apply({
      traceId,
      traceSide: processScope?.traceSide ?? this.resolveTraceSide(inherited),
      processScope,
      skill,
      params,
      inherited,
      resolve: (target) => this.resolveProcessIdentityForGate(traceId, target, inherited),
    });
  }

  private buildIdentityBlockedResult(
    skillId: string,
    skill: SkillDefinition,
    traceId: string,
    traceSide: IdentityTraceSide,
    startTime: number,
    gate: IdentityGateResult,
  ): SkillExecutionResult {
    const error = gate.error || `Process identity gate blocked skill: ${skillId}`;
    const identityResolution = buildIdentityResolutionFromProcessGate({
      traceId,
      traceSide,
      target: gate.target,
      resolution: gate.resolution,
      ...(gate.config.policy === 'required' && !gate.resolution
        ? { statusOverride: 'missing' as const, warnings: [error] }
        : {}),
    });
    return {
      skillId,
      skillName: skill.meta.display_name,
      success: false,
      displayResults: [{
        stepId: 'process_identity_gate',
        title: 'Process identity gate blocked',
        level: 'detail',
        layer: 'diagnosis',
        format: 'text',
        data: {
          text: error,
        },
      }],
      diagnostics: [{
        id: 'process_identity_gate_blocked',
        diagnosis: error,
        confidence: 1,
        severity: 'critical',
        evidence: {
          target: gate.target,
          resolution: gate.resolution,
          policy: gate.config.policy,
        },
        suggestions: [
          '先确认目标应用身份；如果候选进程不唯一，请使用用户明确包名、线程名或 UPID 重新运行。',
          '报告中使用 canonicalPackageName，旧 Skill 参数使用 recommendedProcessNameParam。',
        ],
        source: 'rule',
      }],
      ...(identityResolution ? { identityResolution } : {}),
      executionTimeMs: Date.now() - startTime,
      error,
    };
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
  private async resolveAvailableModules(
    traceId: string,
    modules: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const available: string[] = [];
    for (const module of modules) {
      throwIfTraceProcessorQueryCancelled(signal);
      try {
        const includeResult = await this.queryTraceProcessor(
          traceId,
          `INCLUDE PERFETTO MODULE ${module};`,
          {
            priority: 'p2',
            suppressErrorLog: true,
          },
          signal,
        );
        if ((includeResult as any)?.error) {
          logger.debug('SkillExecutor', `Prerequisite module not available: ${module}`);
          continue;
        }
        available.push(module);
      } catch (error) {
        rethrowIfTraceProcessorQueryCancelled(error);
        logger.debug('SkillExecutor', `Prerequisite module not available: ${module}`);
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

  private exactScopeAdmissionError(skill: SkillDefinition): string | undefined {
    const support = getExactProcessScopeSupport(skill, this.skillRegistry, this.fragmentRegistry);
    if (support.supported) return undefined;
    const alternatives = [...this.skillRegistry.values()]
      .filter(candidate => candidate.type === 'atomic' && candidate.name !== 'process_identity_resolver' &&
        (candidate.process_scope?.role === 'target' || candidate.steps?.some(step =>
          'process_scope' in step && step.process_scope?.role === 'target')) &&
        getExactProcessScopeSupport(candidate, this.skillRegistry, this.fragmentRegistry).supported)
      .map(candidate => candidate.name).sort();
    return `Exact UPID scope is unsupported: ${support.reason}. ` +
      (alternatives.length ? `Use a supported exact Skill: ${alternatives.join(', ')}.` :
        'Use execute_sql with an explicit verified process.upid equality on the target relation.');
  }

  async prepareInvocation(
    skillId: string, traceId: string, params: Record<string, any> = {},
    inherited: Record<string, any> = {}, processScope?: EffectiveProcessScope,
  ): Promise<IdentityGateResult> {
    const skill = this.skillRegistry.get(skillId);
    if (!skill) return { allowed: false, params, inherited, config: { policy: 'none' }, error: `Skill not found: ${skillId}` };
    const gate = await this.applyIdentityGate(skill, traceId, params, inherited, processScope);
    if (gate.allowed && gate.processScope?.mode === 'exact_upid') {
      const scopeError = this.exactScopeAdmissionError(skill);
      if (scopeError) { gate.allowed = false; gate.error = scopeError; }
    }
    return gate;
  }

  /** Root atomic SQL and nested SQL use the same scope and fragment checks. */
  private prepareSql(source: ScopedSqlSource, context: SkillExecutionContext): string {
    const usesRuntimeScope = [source.sql || '', ...(source.sql_fragments || []).map(path => this.fragmentRegistry.get(path) || '')]
      .some(sql => boundSqlPlaceholderPaths(sql).some(path => /^__process_scope\b/.test(path)));
    if (usesRuntimeScope) {
      if (!context.processScope) throw new Error('Reserved process scope binding requires an issued process scope');
      assertEffectiveProcessScope(context.processScope, context.traceId, context.processScope.traceSide);
    }
    if (context.processScope?.mode === 'exact_upid' || usesRuntimeScope) {
      const reason = sqlScopeDeclarationError(source, this.fragmentRegistry);
      if (reason) throw new Error(`Exact UPID scope is unsupported: ${reason}`);
    }
    let sql = substituteVariables(source.sql || '', context);
    if (source.sql_fragments?.length) sql = this.injectSqlFragments(sql, source.sql_fragments, context);
    return this.buildSqlWithModuleIncludes(sql, context);
  }


  /**
   * 执行 skill
   */
  async execute(
    skillId: string,
    traceId: string,
    params: Record<string, any> = {},
    inherited: Record<string, any> = {},
    processScope?: EffectiveProcessScope,
  ): Promise<SkillExecutionResult> {
    const inheritedSink = inherited.__runManifestAttributionSink as
      | RunManifestAttributionSink
      | undefined;
    const sink = resolveRunManifestAttributionSink(
      this.runManifestAttributionSink,
      inheritedSink,
      currentRunManifestAttributionSink(),
    );
    const skill = this.skillRegistry.get(skillId);
    if (!skill) {
      sink?.recordUnknownSkillInvocation(skillId);
      return this.executeInternal(skillId, traceId, params, inherited, processScope);
    }
    const invocationId = sink?.startSkillInvocation({
      skillId,
      version: skill.version,
      contentFingerprint: fingerprintSkillDefinition(
        skill,
        this.fragmentRegistry,
      ),
    });
    try {
      const result = await this.executeInternal(
        skillId,
        traceId,
        params,
        inherited,
        processScope,
      );
      if (sink && invocationId) {
        sink.finishSkillInvocation(invocationId, {
          success: result.success,
          empty: result.success && this.isEmptySkillExecutionResult(result),
        });
      }
      return result;
    } catch (error) {
      if (sink && invocationId) {
        sink.finishSkillInvocation(invocationId, {
          success: false,
          empty: false,
        });
      }
      throw error;
    }
  }

  private isEmptySkillExecutionResult(result: SkillExecutionResult): boolean {
    if ((result.displayResults?.length ?? 0) > 0) return false;
    if ((result.diagnostics?.length ?? 0) > 0) return false;
    if ((result.synthesizeData?.length ?? 0) > 0) return false;
    if (typeof result.aiSummary === 'string' && result.aiSummary.trim()) {
      return false;
    }
    const rawResults = Object.values(result.rawResults ?? {});
    return rawResults.every(entry => {
      if (!entry || typeof entry !== 'object') return true;
      const data = (entry as {data?: unknown}).data;
      return !hasMeaningfulData(data);
    });
  }

  private async executeInternal(
    skillId: string,
    traceId: string,
    params: Record<string, any>,
    inherited: Record<string, any>,
    processScope?: EffectiveProcessScope,
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const signal = getSkillExecutionSignal(inherited);
    throwIfTraceProcessorQueryCancelled(signal);
    const traceSide = processScope?.traceSide ?? this.resolveTraceSide(inherited);

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

    const gate = await this.prepareInvocation(skillId, traceId, params, inherited, processScope);
    if (!gate.allowed) {
      this.emit({
        type: 'skill_error',
        skillId,
        data: { error: gate.error },
      });
      return this.buildIdentityBlockedResult(skillId, skill, traceId, traceSide, startTime, gate);
    }
    const identityResolution = buildIdentityResolutionFromProcessGate({
      traceId,
      traceSide,
      target: gate.target,
      resolution: gate.resolution,
    });
    if (identityResolution && gate.processScope?.identityRefId) identityResolution.identityRefId = gate.processScope.identityRefId;

    // Validate and coerce input parameters against skill.inputs declarations
    const validated = validateSkillInputs(skillId, skill.inputs, gate.params);
    for (const w of validated.warnings) {
      logger.warn('SkillExecutor', `[${skillId}] ${w.paramName}: ${w.message}`);
    }
    if (validated.errors.length > 0) {
      const msg = validated.errors.map(e => `${e.paramName}: ${e.message}`).join('; ');
      logger.error('SkillExecutor', `[${skillId}] Input validation failed: ${msg}`);
      return {
        skillId,
        skillName: skill.meta.display_name,
        success: false,
        displayResults: [],
        diagnostics: [],
        ...(identityResolution ? { identityResolution } : {}),
        executionTimeMs: Date.now() - startTime,
        error: `Input validation failed: ${msg}`,
      };
    }

    const prerequisiteModules = this.resolvePrerequisiteModules(skill.prerequisites?.modules);
    let moduleIncludes = prerequisiteModules;

    // 仅注入可用模块，避免未知模块导致整条 SQL 失败
    if (prerequisiteModules.length > 0) {
      moduleIncludes = await this.resolveAvailableModules(traceId, prerequisiteModules, signal);
    }

    // 创建执行上下文 (use validated.params with coerced types and defaults)
    const context: SkillExecutionContext = {
      traceId,
      signal,
      params: validated.params,
      inherited: gate.inherited,
      processScope: gate.processScope,
      results: {},
      variables: {},
      variableScopes: {},
      variableSteps: {},
      moduleIncludes,
    }

    // 检查表依赖
    const prereqCheck = await this.checkPrerequisites(skill, traceId, signal);
    if (!prereqCheck.success) {
      return {
        skillId,
        skillName: skill.meta.display_name,
        success: false,
        displayResults: [],
        diagnostics: [],
        ...(identityResolution ? { identityResolution } : {}),
        executionTimeMs: Date.now() - startTime,
        error: `Skipped: ${prereqCheck.error}`,
      };
    }

    try {
      const displayResults: DisplayResult[] = [];
      const diagnostics: DiagnosticResult[] = [];
      const synthesizeData: SynthesizeData[] = [];
      let aiSummary: string | undefined;
      let stepExecutionError: string | undefined;


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
                ...(identityResolution ? { identityResolution } : {}),
                executionTimeMs: Date.now() - startTime,
                error: atomicResult.error,
                rawResults: { root: atomicResult },
                scopeProvenance: atomicResult.scopeProvenance,
                scopeLimitations: resultScopeLimitations(atomicResult),
                partial: atomicResult.code === 'exact_scope_unavailable',
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
                ...(identityResolution ? { identityResolution } : {}),
                executionTimeMs: Date.now() - startTime,
                error: 'No SQL or steps defined for atomic skill',
              };
            }
            const stepExec = await this.executeStepBasedSkill(skill, skillId, context, displayResults, diagnostics, synthesizeData);
            aiSummary = stepExec.aiSummary;
            stepExecutionError = stepExec.error;
          }
          break;

        case 'composite':
        case 'deep':
        case 'iterator':
        case 'diagnostic':
        case 'ai_decision':
        case 'ai_summary':
        case 'pipeline':
          {
            if (!skill.steps || skill.steps.length === 0) {
              return {
                skillId,
                skillName: skill.meta.display_name,
                success: false,
                displayResults: [],
                diagnostics: [],
                ...(identityResolution ? { identityResolution } : {}),
                executionTimeMs: Date.now() - startTime,
                error: `No steps defined for skill: ${skillId}`,
              };
            }
            const stepExec = await this.executeStepBasedSkill(skill, skillId, context, displayResults, diagnostics, synthesizeData);
            aiSummary = stepExec.aiSummary;
            stepExecutionError = stepExec.error;
          }
          break;

        case 'pipeline_definition':
        case 'comparison':
          return {
            skillId,
            skillName: skill.meta.display_name,
            success: false,
            displayResults: [],
            diagnostics: [],
            ...(identityResolution ? { identityResolution } : {}),
            executionTimeMs: Date.now() - startTime,
            error: `Skill type '${skill.type}' is metadata-only and not executable by the single-trace SkillExecutor: ${skillId}`,
          };
      }

      if (stepExecutionError) {
        this.emit({
          type: 'skill_error',
          skillId,
          data: { error: stepExecutionError },
        });
        return {
          skillId,
          skillName: skill.meta.display_name,
          success: false,
          displayResults,
          diagnostics,
          rawResults: context.results,
          scopeProvenance: mergeScopeProvenance(Object.values(context.results).map(resultScopeProvenance)),
          scopeLimitations: resultScopeLimitations({ rawResults: context.results }),
          partial: resultScopeLimitations({ rawResults: context.results }).length > 0,
          ...(identityResolution ? { identityResolution } : {}),
          executionTimeMs: Date.now() - startTime,
          error: stepExecutionError,
        };
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
        scopeProvenance: mergeScopeProvenance(Object.values(context.results).map(resultScopeProvenance)),
        scopeLimitations: resultScopeLimitations({ rawResults: context.results }),
        partial: resultScopeLimitations({ rawResults: context.results }).length > 0,
        ...(identityResolution ? { identityResolution } : {}),
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error: any) {
      rethrowIfTraceProcessorQueryCancelled(error);
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
        ...(identityResolution ? { identityResolution } : {}),
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Record a step that ran, the same way on both execution paths: its result
   * under its id, then its declared `save_as`. A result is recorded when it
   * succeeded, was skipped by its condition, found its exact scope unavailable,
   * or is a failed query or Skill result (a conditional returns its branch's
   * result); failed results of other step types are not recorded.
   */
  private recordStepResult(step: SkillStep, stepResult: StepResult, context: SkillExecutionContext): void {
    if (stepResult.success || stepResult.code === 'condition_not_met' || isQueryOrSkillResult(stepResult)) {
      context.results[step.id] = stepResult;
    }
    this.bindSaveAs(step, stepResult, context);
  }

  /**
   * Bind a step's declared `save_as` once the step ran. A successful step binds
   * its selected data; a Skill reference with `save_from` binds exactly that
   * child step. When the step did not succeed, or the named child step observed
   * nothing (failed, skipped, optional query error, absent), the variable is
   * `null`: lookup stops there, so neither another step's rows nor an input, an
   * earlier or an inherited value can be read in its place. A genuinely empty
   * result, and an optional step that was skipped or whose query errored, bind
   * `[]`. The binding carries the scope of the one result it names, never the
   * reference step's aggregate over its child steps. A step skipped by its
   * condition did not run, so it never replaces a binding an earlier step of
   * this Skill made: alternative steps can declare one name under exclusive
   * conditions.
   */
  private bindSaveAs(step: SkillStep, stepResult: StepResult, context: SkillExecutionContext): void {
    if (!('save_as' in step) || !step.save_as) return;
    if (stepResult.code === 'condition_not_met' && Object.prototype.hasOwnProperty.call(context.variables, step.save_as)) return;
    // Only a reference step that ran has child steps to select from.
    const saveFrom = 'save_from' in step && stepResult.stepType === 'skill' && stepResult.code !== 'condition_not_met'
      ? step.save_from : undefined;
    const source = saveFrom
      ? this.namedChildStepResult(stepResult, saveFrom)
      : stepResult.success ? selectedStepResult(stepResult) : stepResult;
    const observed = stepResult.success && source !== undefined && (!saveFrom || isObservedStepResult(source));
    context.variables[step.save_as] = observed ? source.data ?? null : null;
    if (context.variableScopes) context.variableScopes[step.save_as] = resultScopeProvenance(source);
    if (context.variableSteps) context.variableSteps[step.save_as] = step.id;
  }

  /**
   * The step whose result a source name reads right now, resolved as the reader
   * resolves it: the step that made the save_as binding, or the step of that id.
   * Undefined for an input, an inherited value, or an unknown name. An iterator's
   * results bind back to this step, resolved just before the iterator runs.
   */
  private boundSourceStepId(source: string, context: SkillExecutionContext): string | undefined {
    const binding = ExpressionEvaluator.resolveRootBinding(source, context);
    if (binding?.source === 'variable') return context.variableSteps?.[source];
    return binding?.source === 'result' ? source : undefined;
  }

  /**
   * A step as layered output shows it. A Skill reference shows the child step
   * it exposes, data and scope alike, as a read by id or a default save_as sees
   * it. A failed reference shows its own failure with no child rows or scope;
   * when the step is optional the failure is an optional error, as for an
   * optional query, and does not fail the Skill. Only the display changes: the
   * execution result, and the Skill-level scope built from it, are untouched.
   */
  private layerStepResult(step: SkillStep, stepResult: StepResult): StepResult {
    if (stepResult.stepType !== 'skill') return stepResult;
    const { stepId, executionTimeMs, error, code, skippedCondition } = stepResult;
    const exposed = exposedStepResult(stepResult);
    // The exposed child step carries its own stepType; the entry stays a reference.
    if (exposed) return { ...exposed, stepId, stepType: 'skill', executionTimeMs };
    const failure = { stepId, stepType: 'skill', data: [], error, executionTimeMs } as const;
    return isOptionalStep(step)
      ? { ...failure, success: true, code: 'optional_query_error' }
      : { ...failure, success: false, code, skippedCondition };
  }

  /**
   * The scope of the binding an input name resolves to. A bound variable carries
   * only its own scope, even when it holds no data, never that of a same-named
   * step result; inputs and inherited values carry none.
   */
  private inputScopeProvenance(name: string, context: SkillExecutionContext): EvidenceScopeProvenanceV1 | undefined {
    const binding = ExpressionEvaluator.resolveRootBinding(name, context);
    if (binding?.source === 'variable') return context.variableScopes?.[name];
    if (binding?.source === 'result') return resultScopeProvenance(binding.result);
    return undefined;
  }

  /** The named child step's result, whatever its outcome; undefined when no such step ran. */
  private namedChildStepResult(stepResult: StepResult, stepId: string): StepResult | undefined {
    const named = (stepResult.data as any)?.rawResults?.[stepId];
    return named && typeof named === 'object' ? named as StepResult : undefined;
  }

  /**
   * Execute a step-based skill (composite/deep/iterator/diagnostic, and legacy atomic skills without root-level `sql`).
   * Mutates `context.results` / `context.variables` and appends into `displayResults` / `diagnostics` / `synthesizeData`.
   */
  private async executeStepBasedSkill(
    skill: SkillDefinition,
    skillId: string,
    context: SkillExecutionContext,
    displayResults: DisplayResult[],
    diagnostics: DiagnosticResult[],
    synthesizeData: SynthesizeData[]
  ): Promise<{ aiSummary?: string; error?: string }> {
    let aiSummary: string | undefined;

    if (!skill.steps) {
      return { aiSummary };
    }

    for (const step of skill.steps) {
      throwIfTraceProcessorQueryCancelled(context.signal);
      const iteratorSourceStepId = step.type === 'iterator' ? this.boundSourceStepId(step.source, context) : undefined;
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

        synthesizeData.push(this.createSynthesizeData(step, stepResult, displayConfig, config));
      }

      this.recordStepResult(step, stepResult, context);

      if (stepResult.success) {
        // 收集需要展示的结果
        if (this.shouldDisplay(step)) {
          // Substitute template variables (e.g., ${startup_id}) in display config
          const rawDisplay = this.getDisplayConfig(step);
          const processedDisplay = rawDisplay ? processDisplayConfig(rawDisplay, context) : undefined;
          displayResults.push(this.createDisplayResult(
            step.id,
            ('name' in step ? step.name : step.id) || step.id,
            stepResult,
            processedDisplay,
            ('sql' in step ? (step as AtomicStep).sql : undefined)
          ));
        }

        // Iterator 结果绑回源列表：将 expandableData 绑定到 source step 的 DisplayResult
        if (iteratorSourceStepId) {
          const sourceDisplayResult = displayResults.find(dr => dr.stepId === iteratorSourceStepId);
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
      } else {
        if (stepResult.code === 'exact_scope_unavailable') {
          displayResults.push(this.createDisplayResult(step.id, ('name' in step ? step.name : undefined) || step.id,
            { ...stepResult, data: { text: stepResult.error } }, this.getDisplayConfig(step)));
          continue;
        }
        if (stepResult.code === 'condition_not_met') continue;
        if (isQueryOrSkillResult(stepResult)) {
          if (!isOptionalStep(step)) {
            return {
              aiSummary,
              error: stepResult.error || `Required step failed: ${step.id}`,
            };
          }
        }
      }
    }

    // Batch-to-expandable binding: bind batch step row data as expandableData for list steps.
    // This avoids N+1 iterator queries by reusing a single batch SQL result.
    this.applyExpandableBindSources(skill.steps!, context, displayResults);

    return { aiSummary };
  }

  /**
   * The batch rows a step's expandableBindSource names, with the scope of that
   * binding (the one result it holds); undefined when the binding has no rows.
   */
  private expandableBindRows(step: SkillStep, context: SkillExecutionContext):
    { rows: Record<string, any>[]; scope?: EvidenceScopeProvenanceV1 } | undefined {
    const bindSource = this.getDisplayConfig(step)?.expandableBindSource;
    if (!bindSource) return undefined;
    const rows = context.variables[bindSource];
    return Array.isArray(rows) && rows.length > 0 ? { rows, scope: context.variableScopes?.[bindSource] } : undefined;
  }

  /**
   * Apply expandableBindSource declarations: bind each declared batch as
   * expandableData on the declaring step's DisplayResult.
   */
  private applyExpandableBindSources(
    steps: SkillStep[],
    context: SkillExecutionContext,
    displayResults: DisplayResult[]
  ): void {
    for (const step of steps) {
      const source = this.expandableBindRows(step, context);
      if (!source) continue;
      const targetDisplayResult = displayResults.find(dr => dr.stepId === step.id);
      if (!targetDisplayResult?.data?.rows?.length || !targetDisplayResult.data.columns?.length) continue;

      targetDisplayResult.data.expandableData = this.buildExpandableFromBatch(
        targetDisplayResult.data.rows,
        targetDisplayResult.data.columns,
        source.rows, undefined, source.scope,
      );
    }
  }

  /**
   * Build expandableData by matching batch source rows to target list rows.
   *
   * Matching strategy: both datasets are ordered by (session_id, frame_start), so
   * we match by frame_index when available, falling back to start_ts, then positional index.
   *
   * Accepts two data shapes:
   * - Columnar: targetRows (any[][]) + targetColumns (string[]) — from executeStepBasedSkill DisplayResults
   * - Object array: targetObjects (Record<string, any>[]) — from executeCompositeSkill StepResults
   */
  private buildExpandableFromBatch(
    targetRows: any[][] | null,
    targetColumns: string[] | null,
    sourceData: Record<string, any>[],
    targetObjects?: Record<string, any>[],
    sourceProvenance?: EvidenceScopeProvenanceV1,
  ): NonNullable<DisplayResult['data']['expandableData']> {
    const isColumnar = targetRows != null && targetColumns != null;
    const rowCount = isColumnar ? targetRows.length : (targetObjects?.length ?? 0);

    // Build lookup maps lazily — only construct the map if its matching column exists
    const frameIndexCol = isColumnar ? targetColumns.indexOf('frame_index') : -1;
    const hasFrameIndex = isColumnar ? frameIndexCol >= 0 : targetObjects?.some(o => o.frame_index != null);
    const sessionIdCol = isColumnar ? targetColumns.indexOf('session_id') : -1;
    const hasSessionId = isColumnar ? sessionIdCol >= 0 : targetObjects?.some(o => o.session_id != null);
    const processNameCol = isColumnar ? targetColumns.indexOf('process_name') : -1;
    const startTsCol = isColumnar ? targetColumns.indexOf('start_ts') : -1;
    const hasStartTs = isColumnar ? startTsCol >= 0 : targetObjects?.some(o => o.start_ts != null);

    let sourceByFrameIndex: Map<number, Record<string, any>> | undefined;
    let sourceBySessionKey: Map<string, Record<string, any>> | undefined;
    let sourceByStartTs: Map<string, Record<string, any>> | undefined;

    if (hasFrameIndex) {
      sourceByFrameIndex = new Map();
      for (const row of sourceData) {
        if (row.frame_index != null) sourceByFrameIndex.set(Number(row.frame_index), row);
      }
    }
    // Composite key: process_name + session_id (for session-level expandable)
    if (hasSessionId && !sourceByFrameIndex) {
      sourceBySessionKey = new Map();
      for (const row of sourceData) {
        if (row.session_id != null) {
          const key = `${row.process_name ?? ''}::${row.session_id}`;
          sourceBySessionKey.set(key, row);
        }
      }
    }
    if (hasStartTs && !sourceByFrameIndex && !sourceBySessionKey) {
      sourceByStartTs = new Map();
      for (const row of sourceData) {
        if (row.start_ts != null) sourceByStartTs.set(String(row.start_ts), row);
      }
    }

    const expandableData: NonNullable<DisplayResult['data']['expandableData']> = [];

    for (let i = 0; i < rowCount; i++) {
      // Get matching keys without constructing the full item yet
      let frameIndexVal: any;
      let sessionIdVal: any;
      let processNameVal: any;
      let startTsVal: any;
      if (isColumnar) {
        const row = targetRows[i];
        if (frameIndexCol >= 0) frameIndexVal = row[frameIndexCol];
        if (sessionIdCol >= 0) sessionIdVal = row[sessionIdCol];
        if (processNameCol >= 0) processNameVal = row[processNameCol];
        if (startTsCol >= 0) startTsVal = row[startTsCol];
      } else {
        const obj = targetObjects![i];
        frameIndexVal = obj.frame_index;
        sessionIdVal = obj.session_id;
        processNameVal = obj.process_name;
        startTsVal = obj.start_ts;
      }

      // Find matching source row: frame_index → session_key → start_ts → positional
      let matched: Record<string, any> | undefined;
      if (sourceByFrameIndex && frameIndexVal != null) {
        matched = sourceByFrameIndex.get(Number(frameIndexVal));
      }
      if (!matched && sourceBySessionKey && sessionIdVal != null) {
        const key = `${processNameVal ?? ''}::${sessionIdVal}`;
        matched = sourceBySessionKey.get(key);
      }
      if (!matched && sourceByStartTs && startTsVal != null) {
        matched = sourceByStartTs.get(String(startTsVal));
      }
      if (!matched && !sourceByFrameIndex && !sourceBySessionKey && !sourceByStartTs && i < sourceData.length) {
        matched = sourceData[i];
      }

      if (!matched) {
        // Push undefined for unmatched rows — front-end checks truthiness per entry
        expandableData.push(undefined as any);
        continue;
      }

      // Reconstruct item object only for matched rows
      let item: Record<string, any>;
      if (isColumnar) {
        item = {};
        for (let c = 0; c < targetColumns.length; c++) {
          item[targetColumns[c]] = targetRows[i][c];
        }
      } else {
        item = { ...targetObjects![i] };
      }

      expandableData.push({
        item,
        result: { success: true, sections: this.groupBatchRowIntoSections(matched, sourceProvenance),
          scopeProvenance: sourceProvenance },
      });
    }

    return expandableData;
  }

  /**
   * Group a batch row into named sections for the expandable UI.
   * Uses a declarative registry for JSON columns + imperative handlers for scalar fields.
   */
  private groupBatchRowIntoSections(row: Record<string, any>, provenance?: EvidenceScopeProvenanceV1): Record<string, any> {
    const sections: Record<string, any> = {};

    // ── Declarative JSON column registry ─────────────────────────────────
    // Each entry maps a JSON column name → { key, title, transform }.
    // The transform receives the parsed array and returns formatted data rows.
    const jsonSectionRegistry: Array<{
      column: string;
      key: string;
      title: string;
      transform: (items: any[]) => Record<string, any>[];
    }> = [
      // --- Per-frame sections (from batch_frame_root_cause) ---
      {
        column: 'cpu_freq_clusters_json',
        key: 'CPU 频率',
        title: 'CPU 频率 (Prime / Big / Little)',
        transform: (items) => items.map((c: any) => ({
          核心类型: c.core_type,
          平均频率: (c.avg_mhz / 1000).toFixed(2) + 'GHz',
          最高频率: (c.max_mhz / 1000).toFixed(2) + 'GHz',
          最低频率: (c.min_mhz / 1000).toFixed(2) + 'GHz',
        })),
      },
      {
        column: 'freq_timeline_json',
        key: 'CPU 频率变化',
        title: '各 CPU 频率变化时间线',
        transform: (items) => items.map((e: any) => ({
          相对时间: e.relative_ms + 'ms',
          CPU: e.cpu,
          核心类型: e.core_type,
          频率: e.freq_ghz + 'GHz',
          变化: e.change === 'up' ? '↑升频' : e.change === 'down' ? '↓降频' : '初始',
        })),
      },
      {
        column: 'main_slices_json',
        key: '主线程耗时操作',
        title: '主线程耗时操作 (Top 8)',
        transform: (items) => items.map((s: any) => ({
          操作: s.name, 总耗时: s.total_ms + 'ms', 次数: s.count, 最大耗时: s.max_ms + 'ms',
        })),
      },
      {
        column: 'render_slices_json',
        key: 'RenderThread 耗时操作',
        title: 'RenderThread 耗时操作 (Top 8)',
        transform: (items) => items.map((s: any) => ({
          操作: s.name, 总耗时: s.total_ms + 'ms', 次数: s.count, 最大耗时: s.max_ms + 'ms',
        })),
      },
      {
        column: 'binder_calls_json',
        key: 'Binder 调用详情',
        title: 'Binder 调用（按耗时降序）',
        transform: (items) => items.map((b: any) => ({
          目标进程: b.server, 调用次数: b.count, 总耗时: b.dur_ms + 'ms', 最大耗时: b.max_ms + 'ms',
        })),
      },
      {
        column: 'gc_events_json',
        key: 'GC 事件详情',
        title: 'GC 事件（按类型聚合）',
        transform: (items) => items.map((g: any) => ({
          类型: g.gc_type, 次数: g.count, 总耗时: g.total_ms + 'ms', 帧重叠: g.overlap_ms + 'ms',
        })),
      },
      {
        column: 'lock_contention_json',
        key: '锁竞争详情',
        title: '锁竞争（按等待时间降序）',
        transform: (items) => items.map((l: any) => ({
          阻塞方法: l.method, 阻塞线程: l.blocker, 等待: l.wait_ms + 'ms',
          主线程阻塞: l.main_blocked ? '是' : '否',
        })),
      },
      {
        column: 'input_events_json',
        key: 'Input 事件详情',
        title: 'Input 事件（按 App 处理耗时降序）',
        transform: (items) => items.map((e: any) => ({
          动作: e.action,
          窗口: e.channel,
          App处理: e.handling_ms + 'ms',
          分发: e.dispatch_ms + 'ms',
          ACK: e.ack_ms + 'ms',
          总延迟: e.total_ms + 'ms',
          Input到Present: e.e2e_ms == null ? 'n/a' : e.e2e_ms + 'ms',
          推测帧: e.speculative ? '是' : '否',
        })),
      },
      {
        column: 'input_slices_json',
        key: 'Input 阶段 Slice',
        title: 'Input 阶段 Slice（帧窗口重叠）',
        transform: (items) => items.map((s: any) => ({
          阶段: s.stage,
          重叠: s.overlap_ms + 'ms',
          次数: s.count,
          最大耗时: s.max_ms + 'ms',
        })),
      },
      // --- Per-session sections (from session_stats_batch) ---
      {
        column: 'quadrant_json',
        key: '四象限分布',
        title: '滑动区间四象限分布 (Q1大核运行/Q2小核运行/Q3调度等待/Q4a不可中断等待/Q4b休眠)',
        transform: (items) => items.map((q: any) => ({
          线程: q.thread,
          'Q1 大核%': q.q1_big_pct + '%',
          'Q2 小核%': q.q2_little_pct + '%',
          'Q3 调度%': q.q3_runnable_pct + '%',
          'Q4a 不可中断等待%': q.q4a_io_pct + '%',
          'Q4b 休眠%': q.q4b_sleep_pct + '%',
          '总时间': q.total_ms + 'ms',
        })),
      },
      {
        column: 'cpu_freq_json',
        key: 'CPU 频率统计',
        title: '滑动区间 CPU 频率',
        transform: (items) => items.map((f: any) => ({
          核心类型: f.core_type,
          核心数: f.num_cores,
          '均频(MHz)': f.avg_freq_mhz,
          '最高频(MHz)': f.max_freq_mhz,
          '最低频(MHz)': f.min_freq_mhz,
        })),
      },
      {
        column: 'core_affinity_json',
        key: '大小核分布',
        title: '滑动区间关键线程大小核分布',
        transform: (items) => items.map((a: any) => ({
          线程: a.thread_name,
          核心类型: a.core_type,
          '运行时间(ms)': a.run_ms,
          '占比%': a.pct + '%',
        })),
      },
    ];

    // ── Scalar field sections (per-frame only) ───────────────────────────

    // Section: Root cause diagnosis
    const diagnosisFields = ['reason_code', 'primary_cause', 'confidence', 'top_slice_name', 'top_slice_ms'];
    const diagnosisData: Record<string, any> = {};
    for (const f of diagnosisFields) {
      if (row[f] != null) diagnosisData[f] = row[f];
    }
    if (Object.keys(diagnosisData).length > 0) {
      sections['根因诊断'] = { title: '根因诊断', data: [diagnosisData] };
    }

    // Section: MainThread quadrant (scalar fields)
    const mainFields = ['main_q1_pct', 'main_q2_pct', 'main_q3_pct', 'main_q4a_pct', 'main_q4b_pct'];
    const mainData: Record<string, any> = {};
    let hasMainData = false;
    for (const f of mainFields) {
      if (row[f] != null) { mainData[f.replace('main_', '').replace('_pct', '%')] = row[f] + '%'; hasMainData = true; }
    }
    if (hasMainData) {
      sections['主线程四象限'] = { title: '主线程四象限 (Q1大核运行/Q2小核运行/Q3调度等待/Q4a不可中断等待/Q4b锁等待)', data: [mainData] };
    }

    // Section: RenderThread quadrant (scalar fields)
    const renderFields = ['render_q1_pct', 'render_q2_pct', 'render_q3_pct', 'render_q4a_pct', 'render_q4b_pct'];
    const renderData: Record<string, any> = {};
    let hasRenderData = false;
    for (const f of renderFields) {
      if (row[f] != null) { renderData[f.replace('render_', 'RT_').replace('_pct', '%')] = row[f] + '%'; hasRenderData = true; }
    }
    if (hasRenderData) {
      sections['渲染线程四象限'] = { title: '渲染线程四象限 (Q1大核运行/Q2小核运行/Q3调度等待/Q4a不可中断等待/Q4b锁等待)', data: [renderData] };
    }

    // Section: CPU frequency fallback (scalar, when cpu_freq_clusters_json is absent)
    if (!row['cpu_freq_clusters_json'] || row['cpu_freq_clusters_json'] === '[]') {
      const cpuData: Record<string, any> = {};
      let hasCpuData = false;
      for (const f of ['big_avg_freq_mhz', 'big_max_freq_mhz', 'ramp_ms']) {
        if (row[f] != null) { cpuData[f] = row[f]; hasCpuData = true; }
      }
      if (hasCpuData) {
        sections['CPU 频率'] = { title: 'CPU 频率', data: [cpuData] };
      }
    }

    // Section: Top Slice CPU mix
    const cpuMixFields = ['top_slice_little_pct', 'top_slice_big_pct', 'top_slice_runnable_pct'];
    const cpuMixData: Record<string, any> = {};
    let hasCpuMix = false;
    for (const f of cpuMixFields) {
      if (row[f] != null && Number(row[f]) > 0) {
        cpuMixData[f.replace('top_slice_', '')] = row[f] + '%';
        hasCpuMix = true;
      }
    }
    if (hasCpuMix) {
      sections['关键操作 CPU 分布'] = { title: '关键操作 CPU 分布 (大核/小核/Runnable)', data: [cpuMixData] };
    }

    // Section: Input pipeline evidence
    const inputFields = [
      'input_event_count',
      'input_move_count',
      'input_handling_ms',
      'input_handling_total_ms',
      'input_dispatch_ms',
      'input_e2e_ms',
      'input_slice_ms',
      'input_stage',
      'input_speculative_events',
    ];
    const inputData: Record<string, any> = {};
    let hasInputData = false;
    for (const f of inputFields) {
      const value = row[f];
      if (value != null && value !== '' && Number(value) !== 0) {
        inputData[f] = f.endsWith('_ms') ? value + 'ms' : value;
        hasInputData = true;
      }
    }
    if (hasInputData) {
      sections['Input 管线'] = { title: 'Input 管线证据', data: [inputData] };
    }

    // Section: GPU / Shader
    const gpuFields = ['gpu_fence_ms', 'gpu_fence_total_ms', 'shader_count', 'shader_ms'];
    const gpuData: Record<string, any> = {};
    let hasGpu = false;
    for (const f of gpuFields) {
      if (row[f] != null && Number(row[f]) > 0) { gpuData[f] = row[f]; hasGpu = true; }
    }
    if (hasGpu) {
      sections['GPU / Shader'] = { title: 'GPU / Shader', data: [gpuData] };
    }

    // Section: Interference factors (Binder + GC)
    const interferenceData: Record<string, any> = {};
    let hasInterference = false;
    if (row['binder_overlap_ms'] != null && Number(row['binder_overlap_ms']) > 0) {
      interferenceData['binder_overlap_ms'] = row['binder_overlap_ms'];
      hasInterference = true;
    }
    if (row['gc_overlap_ms'] != null && Number(row['gc_overlap_ms']) > 0) {
      interferenceData['gc_overlap_ms'] = row['gc_overlap_ms'];
      hasInterference = true;
    }
    if (row['gc_count'] != null && Number(row['gc_count']) > 0) {
      interferenceData['gc_count'] = row['gc_count'];
      hasInterference = true;
    }
    if (hasInterference) {
      sections['干扰因素'] = { title: '干扰因素 (Binder/GC)', data: [interferenceData] };
    }

    // Section: Frame budget reference
    if (row['frame_budget_ms'] != null) {
      sections['帧预算'] = { title: '帧预算参考', data: [{ frame_budget_ms: row['frame_budget_ms'] + 'ms' }] };
    }

    // ── Apply JSON column registry ───────────────────────────────────────
    for (const entry of jsonSectionRegistry) {
      const items = this.parseJsonColumn(row, entry.column);
      if (items.length > 0) {
        sections[entry.key] = { title: entry.title, data: entry.transform(items),
          ...scopeMetadata(scopeProvenanceForFields(provenance, [entry.column])) };
      }
    }

    for (const section of Object.values(sections)) {
      if (!section.scopeProvenance) Object.assign(section, scopeMetadata(scopeProvenanceForFields(provenance,
        Object.keys(section.data?.[0] || {})) || provenance));
    }
    return sections;
  }

  /** Safely parse a JSON string column from a batch row. */
  private parseJsonColumn(row: Record<string, any>, columnName: string): any[] {
    const raw = row[columnName];
    if (!raw || raw === '[]') return [];
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Execute composite skill and return layered results
   * This is an alternative execution path that organizes output by layers (overview/list/session/deep)
   */
  async executeCompositeSkill(
    skill: SkillDefinition,
    inputs: Record<string, any>,
    context: Partial<SkillExecutionContext>,
    processScope?: EffectiveProcessScope,
  ): Promise<LayeredResult> {
    const signal = context.signal || getSkillExecutionSignal(context.inherited);
    throwIfTraceProcessorQueryCancelled(signal);

    // Validate input
    if (!skill) {
      throw new Error('Skill definition is required');
    }

    if (!skill.steps || skill.steps.length === 0) {
      return {
        layers: {
          overview: {}, list: {}, session: {}, deep: {}, diagnosis: {},
        },
        defaultExpanded: ['overview', 'list'],
        stepResults: [],
        metadata: {
          skillName: skill.name,
          version: skill.version || '1.0.0',
          executedAt: new Date().toISOString()
        }
      };
    }

    const traceId = context.traceId || '';
    const gate = await this.applyIdentityGate(skill, traceId, inputs, context.inherited || {}, processScope);
    if (gate.allowed && gate.processScope?.mode === 'exact_upid') {
      const scopeError = this.exactScopeAdmissionError(skill);
      if (scopeError) { gate.allowed = false; gate.error = scopeError; }
    }
    if (!gate.allowed) {
      throw new Error(gate.error || `Process identity gate blocked skill: ${skill.name}`);
    }

    const prerequisiteModules = this.resolvePrerequisiteModules(skill.prerequisites?.modules);
    const validated = validateSkillInputs(skill.name, skill.inputs, gate.params);
    for (const w of validated.warnings) {
      logger.warn('SkillExecutor', `[${skill.name}] ${w.paramName}: ${w.message}`);
    }
    if (validated.errors.length > 0) {
      const msg = validated.errors.map(e => `${e.paramName}: ${e.message}`).join('; ');
      logger.error('SkillExecutor', `[${skill.name}] Input validation failed: ${msg}`);
      throw new Error(`Input validation failed: ${msg}`);
    }

    // Create execution context
    const execContext: SkillExecutionContext = {
      traceId,
      signal,
      params: validated.params,
      inherited: gate.inherited,
      processScope: gate.processScope,
      results: {},
      variables: {},
      variableScopes: {},
      variableSteps: {},
      moduleIncludes: prerequisiteModules,
    };

    if (execContext.traceId && prerequisiteModules.length > 0) {
      execContext.moduleIncludes = await this.resolveAvailableModules(
        execContext.traceId,
        prerequisiteModules,
        signal,
      );
    }

    // Execute all steps and collect synthesize-marked data
    const stepResults: StepResult[] = [];
    const synthesizeData: SynthesizeData[] = [];

    if (skill.steps) {
      for (const step of skill.steps) {
        throwIfTraceProcessorQueryCancelled(execContext.signal);
        const iteratorSourceStepId = step.type === 'iterator' ? this.boundSourceStepId(step.source, execContext) : undefined;
        const stepResult = await this.executeStep(step, execContext, skill.name);
        const shown = this.layerStepResult(step, stepResult);

        this.recordStepResult(step, stepResult, execContext);

        // IMPORTANT: Add display config from step definition to stepResult
        // This is needed for organizeByLayer to correctly place results in layers
        // Process display config with template variable substitution (e.g., ${frame_id})
        if ('display' in step && typeof step.display === 'object') {
          shown.display = processDisplayConfig(step.display, execContext);
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

          synthesizeData.push(this.createSynthesizeData(step, stepResult, displayConfig, config));
        }

        stepResults.push(shown);

        // Iterator 结果绑回源列表：将 expandableData 绑定到 source step 的 StepResult，
        // 这样 convertDisplayResultsToSections 可以在源步骤的 data 上找到 expandableData。
        // 此路径中 iterator 的 data 是原始 [{itemIndex, item, result}, ...]
        if (iteratorSourceStepId) {
          const sourceResult = stepResults.find(sr => sr.stepId === iteratorSourceStepId);
          if (sourceResult?.data && shown.success && Array.isArray(shown.data)) {
            (sourceResult.data as any).expandableData = this.iteratorExpandableData(shown.data);
          }
        }
      }
    }

    // Batch-to-expandable binding for executeCompositeSkill path (object-array variant)
    if (skill.steps) {
      for (const step of skill.steps) {
        const source = this.expandableBindRows(step, execContext);
        if (!source) continue;
        const targetResult = stepResults.find(sr => sr.stepId === step.id);
        if (!targetResult?.data || !Array.isArray(targetResult.data) || targetResult.data.length === 0) continue;
        if (typeof targetResult.data[0] !== 'object' || targetResult.data[0] === null) continue;

        const expandableData = this.buildExpandableFromBatch(null, null, source.rows, targetResult.data, source.scope);
        (targetResult.data as any).expandableData = expandableData;
      }
    }

    // Return layered structure
    try {
      const layers = organizeByLayer(stepResults);

      const scopeLimitations = resultScopeLimitations({ rawResults: execContext.results });
      const result: LayeredResult = {
        layers,
        defaultExpanded: ['overview', 'list'],
        metadata: {
          skillName: skill.name,
          version: skill.version || '1.0.0',
          executedAt: new Date().toISOString()
        },
        stepResults,
        // From what ran, as on the execute path; a display entry shows only part of a reference.
        scopeProvenance: mergeScopeProvenance(Object.values(execContext.results).map(resultScopeProvenance)),
        scopeLimitations,
        partial: scopeLimitations.length > 0,
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
  private sqlEvidenceFields(
    skill: SkillDefinition | undefined, stepId: string, display: DisplayConfig | undefined, sql: string): Record<string, CapturedFieldSemantics> {
    const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
    if (skill) {
      const origin: CapturedFieldSemantics['origin'] = {kind: 'skill_literal', skillId: skill.name, stepId,
        definitionFingerprint: fingerprintSkillDefinition(skill, this.fragmentRegistry), selectedSqlHash: evidenceCaptureHash(sql)};
      for (const column of display?.columns || []) {
        if (column && typeof column === 'object' && typeof column.name === 'string' &&
            typeof column.unit === 'string' && ['ns', 'us', 'ms', 's'].includes(column.unit)) {
          fields[column.name] = {origin, unit: column.unit};
        }
      }
    }
    return fields;
  }

  private async executeAtomicSkill(
    skill: SkillDefinition,
    context: SkillExecutionContext
  ): Promise<StepResult> {
    const startTime = Date.now();
    throwIfTraceProcessorQueryCancelled(context.signal);

    if (!skill.sql) {
      return {
        stepId: 'root',
        stepType: 'atomic',
        success: false,
        error: 'No SQL defined for atomic skill',
        executionTimeMs: Date.now() - startTime,
      };
    }

    const source = selectProcessScopeSql(skill, context.processScope?.mode === 'exact_upid');
    if (context.processScope?.mode === 'exact_upid' && source.process_scope?.exact_unavailable) {
      return { stepId: 'root', stepType: 'atomic', success: false, code: 'exact_scope_unavailable',
        error: source.process_scope.exact_unavailable, executionTimeMs: 0,
        ...sqlScopeEvidence(source, context, 'root', undefined, true) };
    }
    const sql = this.prepareSql(source, context);
    const evidenceFields = this.sqlEvidenceFields(skill, 'root', skill.output?.display, sql);

    try {
      const result = await this.queryTraceProcessor(context.traceId, sql, {}, context.signal);

      if (result.error) {
        return {
          stepId: 'root',
          stepType: 'atomic',
          success: false,
          error: result.error,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const stepResult: StepResult = {
        stepId: 'root',
        stepType: 'atomic',
        success: true,
        data: this.rowsToObjects(result.columns, result.rows),
        executionTimeMs: Date.now() - startTime,
        display: skill.output?.display ? processDisplayConfig(skill.output.display, context) : undefined,
        sql, ...sqlScopeEvidence(source, context, 'root', this.rowsToObjects(result.columns, result.rows)),
      };
      const definitionFingerprint = skill.investigation_evidence ? fingerprintSkillDefinition(skill, this.fragmentRegistry) : undefined;
      const selectedSqlHash = evidenceCaptureHash(sql);
      const witness = captureEvidenceTable(result, {...evidenceFields, ...(definitionFingerprint
        ? investigationCaptureFields(skill.investigation_evidence,
          {kind: 'skill_literal', skillId: skill.name, stepId: 'root', definitionFingerprint, selectedSqlHash}) : {})});
      if (skill.investigation_evidence && definitionFingerprint) attachInvestigationEvidence(witness, {
        declaration: skill.investigation_evidence, skillId: skill.name, stepId: 'root', traceId: context.traceId,
        definitionFingerprint, selectedSqlHash,
      });
      attachEvidenceTable(stepResult, witness);
      return stepResult;

    } catch (error: any) {
      rethrowIfTraceProcessorQueryCancelled(error);
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
    throwIfTraceProcessorQueryCancelled(context.signal);

    // 检查步骤的条件限制
    if ('condition' in step && typeof (step as any).condition === 'string') {
      const conditionStr = (step as any).condition;
      const conditionResult = ExpressionEvaluator.evaluateCondition(conditionStr, context);
      if (!conditionResult) {
        const isOptional = Boolean((step as any).optional);
        this.emit({
          type: 'step_completed',
          skillId: parentSkillId,
          stepId: step.id,
          data: { skipped: true, reason: 'condition_not_met', optional: isOptional },
        });
        return {
          stepId: step.id,
          stepType: step.type ?? 'skill',
          success: isOptional,
          data: isOptional ? [] : undefined,
          error: isOptional ? undefined : 'Condition not met',
          code: 'condition_not_met',
          skippedCondition: conditionStr,
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
          result = await this.executeAtomicStep(step, context, parentSkillId);
          break;

        case 'iterator':
          result = await this.executeIteratorStep(step, context);
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

        case 'pipeline':
          result = await this.executePipelineStep(step, context);
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
      rethrowIfTraceProcessorQueryCancelled(error);
      const failedStep = step as SkillStep;
      const aiDisabledError = error instanceof AiDisabledError ? error : null;
      result = {
        stepId: failedStep.id,
        stepType: failedStep.type || 'skill',
        success: false,
        error: error.message,
        code: aiDisabledError?.code,
        data: aiDisabledError
          ? { code: aiDisabledError.code, feature: aiDisabledError.feature }
          : undefined,
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (!result.scopeProvenance && ['diagnostic', 'ai_decision', 'ai_summary'].includes(step.type || '')) {
      const inputNames = 'inputs' in step && Array.isArray(step.inputs) ? step.inputs : [];
      const provenance = mergeScopeProvenance(inputNames.map(name => this.inputScopeProvenance(name, context)));
      Object.assign(result, scopeMetadata(provenance));
      if (Array.isArray(result.data?.diagnostics)) result.data.diagnostics = result.data.diagnostics.map((diagnostic: any) =>
        ({ ...diagnostic, ...scopeMetadata(provenance) }));
    }
    this.emit({
      type: 'step_completed',
      skillId: parentSkillId,
      stepId: step.id,
      data: { success: result.success, error: result.error, code: result.code },
    });

    return result;
  }

  /**
   * 执行原子步骤
   */
  private async executeAtomicStep(
    step: AtomicStep,
    context: SkillExecutionContext,
    parentSkillId?: string,
  ): Promise<StepResult> {
    const startTime = Date.now();
    throwIfTraceProcessorQueryCancelled(context.signal);
    const source = selectProcessScopeSql(step, context.processScope?.mode === 'exact_upid');
    if (context.processScope?.mode === 'exact_upid' && source.process_scope?.exact_unavailable) {
      return { stepId: step.id, stepType: 'atomic', success: false, code: 'exact_scope_unavailable',
        error: source.process_scope.exact_unavailable, executionTimeMs: 0,
        ...sqlScopeEvidence(source, context, step.id, undefined, true) };
    }
    const sql = this.prepareSql(source, context);
    const evidenceFields = this.sqlEvidenceFields(parentSkillId ? this.skillRegistry.get(parentSkillId) : undefined,
      step.id, this.getDisplayConfig(step), sql);

    try {
      const result = await this.queryTraceProcessor(context.traceId, sql, {}, context.signal);

      if (result.error) {
        if (step.optional) {
          return {
            stepId: step.id,
            stepType: 'atomic',
            success: true,
            data: [],
            error: result.error,
            sql, ...sqlScopeEvidence({ ...source, process_scope: source.process_scope && { ...source.process_scope, exact_unavailable: result.error } }, context, step.id, undefined, true),
            code: 'optional_query_error',
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

      const stepResult: StepResult = {
        stepId: step.id,
        stepType: 'atomic',
        success: true,
        data,
        sql, ...sqlScopeEvidence(source, context, step.id, data),
        ...(
          data.length === 0 && step.on_empty
            ? { emptyMessage: step.on_empty }
            : {}
        ),
        executionTimeMs: Date.now() - startTime,
      };
      const parentSkill = parentSkillId ? this.skillRegistry.get(parentSkillId) : undefined;
      const definitionFingerprint = parentSkill && step.investigation_evidence ? fingerprintSkillDefinition(parentSkill, this.fragmentRegistry) : undefined;
      const selectedSqlHash = evidenceCaptureHash(sql);
      const witness = captureEvidenceTable(result, {...evidenceFields, ...(parentSkill && definitionFingerprint
        ? investigationCaptureFields(step.investigation_evidence,
          {kind: 'skill_literal', skillId: parentSkill.name, stepId: step.id, definitionFingerprint, selectedSqlHash}) : {})});
      if (parentSkill && definitionFingerprint && step.investigation_evidence) attachInvestigationEvidence(witness, {
        declaration: step.investigation_evidence, skillId: parentSkill.name, stepId: step.id, traceId: context.traceId,
        definitionFingerprint, selectedSqlHash,
      });
      attachEvidenceTable(stepResult, witness);
      return stepResult;

    } catch (error: any) {
      rethrowIfTraceProcessorQueryCancelled(error);
      if (step.optional) {
        return {
          stepId: step.id,
          stepType: 'atomic',
          success: true,
          data: [],
          error: error.message,
          sql, ...sqlScopeEvidence({ ...source, process_scope: source.process_scope && { ...source.process_scope, exact_unavailable: error.message } }, context, step.id, undefined, true),
          code: 'optional_query_error',
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
    traceId: string,
    signal?: AbortSignal,
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

      const result = await this.queryTraceProcessor(traceId, query, {}, signal);
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
      rethrowIfTraceProcessorQueryCancelled(e);
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
      mergeInheritedWithSignal(
        { ...context.inherited, ...context.variables },
        context.signal,
      ),
      context.processScope,
    );

    return {
      stepId: step.id,
      stepType: 'skill',
      success: result.success,
      data: result,
      ...scopeMetadata(resultScopeProvenance(result)),
      scopeLimitations: resultScopeLimitations(result),
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
    const source = this.resolveStepResultFromSource(step.source, context)?.data;
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
            // resolveRootBinding exposes `item` and its fields ahead of every other scope.
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

      // 执行子 skill
      const itemResult = await this.execute(
        itemSkillName,
        context.traceId,
        params,
        mergeInheritedWithSignal({ ...context.inherited, ...context.variables, item }, context.signal),
        context.processScope,
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
      ...scopeMetadata(mergeScopeProvenance(results.map(item => resultScopeProvenance(item.result)))),
      scopeLimitations: results.flatMap(item => resultScopeLimitations(item.result)),
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
      ...scopeMetadata(mergeScopeProvenance(results.map(resultScopeProvenance))),
      scopeLimitations: results.flatMap(resultScopeLimitations),
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

    // 收集输入数据：与规则 condition/diagnosis 读到的是同一个绑定
    const inputs: Record<string, any> = {};
    for (const inputName of step.inputs) {
      inputs[inputName] = ExpressionEvaluator.resolveRootValue(inputName, context);
    }
    const inputNames: ReadonlySet<string> = new Set(step.inputs);

    // 评估规则
    for (const rule of step.rules) {
      const conditionResult = ExpressionEvaluator.evaluateCondition(rule.condition, context);

      if (conditionResult) {
        const confidence = typeof rule.confidence === 'number'
          ? rule.confidence
          : rule.confidence === 'high' ? 0.9 : rule.confidence === 'medium' ? 0.7 : 0.5;
        const severityFromRule = rule.severity === 'critical' || rule.severity === 'warning' || rule.severity === 'info'
          ? rule.severity
          : undefined;

        // Substitute variables in diagnosis message
        const diagnosis = ExpressionEvaluator.evaluate(rule.diagnosis, context);

        // 收集 evidence 数据
        const evidence = this.collectDiagnosticEvidence(rule, inputs, inputNames, context);

        // Evaluate suggestions templates (e.g., "${root_cause.data[0].secondary_info}")
        const evaluatedSuggestions = rule.suggestions?.map((s: string) =>
          typeof s === 'string' ? ExpressionEvaluator.evaluate(s, context) : s
        );

        diagnostics.push({
          id: `${step.id}_${diagnostics.length}`,
          diagnosis,
          confidence,
          severity: severityFromRule ?? (confidence >= 0.8 ? 'critical' : confidence >= 0.6 ? 'warning' : 'info'),
          suggestions: evaluatedSuggestions,
          evidence,
          source: 'rule',
        });
      }
    }

    // 如果没有匹配的规则且配置了 AI 辅助，调用 AI
    if (diagnostics.length === 0 && step.ai_assist && step.fallback && this.aiService) {
      const disabledResult = this.buildAiDisabledStepResult(step.id, 'diagnostic', startTime);
      if (disabledResult) {
        return disabledResult;
      }
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
   * 收集诊断结论的数据依据：rule.evidence_fields 加上 condition 引用的数据源。
   * evidence field 是 condition 方言的只读子集（parseEvidenceField），从 condition
   * 里 `x.data` 的同一个值读起，只能读本 diagnostic step 声明的 inputs；它不经
   * JS 求值，不会调用函数或写数据。每个值都经 boundEvidenceValue 截断：evidence
   * 会进 _diagnostics artifact、CLI JSON 和 LLM payload。
   */
  private collectDiagnosticEvidence(
    rule: any,
    inputs: Record<string, any>,
    inputNames: ReadonlySet<string>,
    context: SkillExecutionContext,
  ): Record<string, any> {
    const evidence: Record<string, any> = {};

    // 1. 如果规则定义了 evidence_fields，使用它们
    if (Array.isArray(rule.evidence_fields)) {
      for (const field of rule.evidence_fields) {
        const path = parseEvidenceField(String(field));
        if (!path || !inputNames.has(path.root)) continue;
        this.recordEvidence(evidence, field, () =>
          readEvidenceField(path, ExpressionEvaluator.readDataView(path.root, context)));
      }
    }

    // 2. condition 读到的数据源样本（行数 + 首行），不是规则命中的那一行；读的是 condition 里
    //    这个 input 的同一个值，无论写成 `x.data`、`x?.data` 还是 `x?.["data"]`
    const conditionSources = SkillExecutor.conditionRoots(String(rule.condition ?? '')).filter(name => inputNames.has(name));
    for (const source of conditionSources) {
      this.recordEvidence(evidence, source, () => {
        const sourceData = ExpressionEvaluator.readDataView(source, context);
        return sourceData && typeof sourceData === 'object' ? sourceData : undefined;
      });
    }

    // 3. 添加时间戳用于 Perfetto 跳转
    this.recordEvidence(evidence, '_perfettoTs', () => this.findTimestampField(inputs, conditionSources));

    return Object.keys(evidence).length > 0 ? evidence : undefined as any;
  }

  /** Root names per authored condition string; the extraction compiles once per identifier. */
  private static readonly conditionRootCache = new Map<string, readonly string[]>();

  private static conditionRoots(condition: string): readonly string[] {
    let roots = SkillExecutor.conditionRootCache.get(condition);
    if (!roots) {
      roots = extractRootVariables(condition);
      SkillExecutor.conditionRootCache.set(condition, roots);
    }
    return roots;
  }

  /**
   * 记录一条 evidence 的有界投影；读取或投影失败只丢这一条，不影响诊断本身。
   */
  private recordEvidence(evidence: Record<string, any>, key: string, read: () => unknown): void {
    try {
      const value = read();
      if (value !== undefined) evidence[key] = boundEvidenceValue(value);
    } catch (error: any) {
      logger.debug('SkillExecutor', `Evidence ${key} failed: ${error?.message}`);
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
        const firstRow = ownDataValue(data, '0');
        // 常见的时间戳字段名；只读自有的标量数据属性
        const tsFields = ['ts', 'start_ts', 'timestamp', 'begin_ts'];
        for (const field of tsFields) {
          const ts = ownDataValue(firstRow, field);
          if (typeof ts === 'number' || typeof ts === 'bigint' || (typeof ts === 'string' && ts !== '')) {
            return String(ts);
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

    const disabledResult = this.buildAiDisabledStepResult(step.id, 'ai_decision', startTime);
    if (disabledResult) {
      return disabledResult;
    }

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

    const disabledResult = this.buildAiDisabledStepResult(step.id, 'ai_summary', startTime);
    if (disabledResult) {
      return disabledResult;
    }

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
   * 执行 pipeline 步骤
   *
   * 将渲染管线检测结果聚合为教学内容 + Pin 指令，作为 SkillEngine 一等步骤类型输出。
   */
  private async executePipelineStep(
    step: PipelineStep,
    context: SkillExecutionContext
  ): Promise<StepResult> {
    const startTime = Date.now();

    try {
      await ensurePipelineSkillsInitialized();
      const defaultSelection = pipelineSkillLoader.getDefaultSelection();

      const pipelineSource = step.pipeline_source || 'pipeline_result';
      const activeProcessesSource = step.active_processes_source || 'active_rendering_processes';
      const traceRequirementsSource = step.trace_requirements_source || 'trace_requirements';

      const pipelineRow = this.resolveFirstObjectRowFromSource(pipelineSource, context);
      const explicitPipelineIdRaw = typeof step.pipeline_id === 'string' && step.pipeline_id.trim().length > 0
        ? ExpressionEvaluator.evaluate(step.pipeline_id, context)
        : undefined;
      const explicitPipelineId =
        explicitPipelineIdRaw !== undefined && explicitPipelineIdRaw !== null
          ? String(explicitPipelineIdRaw).trim()
          : '';
      const primaryPipelineId = (
        explicitPipelineId ||
        String(pipelineRow?.primary_pipeline_id ?? '').trim() ||
        defaultSelection.pipelineId
      );
      const primaryConfidence = validateConfidence(
        pipelineRow?.primary_confidence,
        TEACHING_DEFAULTS.confidence
      );
      const candidatesList = pipelineRow?.candidates_list || '';
      const primaryRenderingTypeId = String(
        pipelineRow?.primary_rendering_type_id ||
        pipelineSkillLoader.getPipelineCatalogEntry(primaryPipelineId)?.rendering_type_id ||
        defaultSelection.renderingTypeId
      );
      const renderingTypeCandidatesList = pipelineRow?.rendering_type_candidates_list || '';
      const relatedRenderingTypeCandidatesList =
        pipelineRow?.related_rendering_type_candidates_list || '';
      const featuresList = pipelineRow?.features_list || '';
      const docPath = String(pipelineRow?.doc_path || defaultSelection.docPath);

      const candidates = candidatesList
        ? parseCandidates(candidatesList, TEACHING_LIMITS.maxCandidates)
        : [{ id: primaryPipelineId, confidence: primaryConfidence }];
      const renderingTypeCandidates = renderingTypeCandidatesList
        ? parseCandidates(renderingTypeCandidatesList, TEACHING_LIMITS.maxCandidates)
        : [{ id: primaryRenderingTypeId, confidence: primaryConfidence }];
      const relatedRenderingTypes = pipelineSkillLoader.resolveRelatedRenderingTypes(
        parseCandidates(
          relatedRenderingTypeCandidatesList,
          TEACHING_LIMITS.maxCandidates,
        ),
      );
      const features = parseFeatures(featuresList);

      const traceRequirementsMissing = this.extractTraceRequirementHints(
        this.resolveFirstObjectRowFromSource(traceRequirementsSource, context)
      );

      const activeRenderingProcesses = validateActiveProcesses(
        this.resolveStepResultFromSource(activeProcessesSource, context)
      );

      const mdTeaching = getPipelineDocService().getTeachingContent(primaryPipelineId);
      const teachingContent: TeachingContentResponse | null = mdTeaching
        ? {
            title: mdTeaching.title,
            summary: mdTeaching.summary,
            mermaidBlocks: mdTeaching.mermaidBlocks,
            threadRoles: mdTeaching.threadRoles,
            keySlices: mdTeaching.keySlices,
            docPath: mdTeaching.docPath,
          }
        : null;

      const basePinInstructions = pipelineSkillLoader
        .getAutoPinInstructions(primaryPipelineId)
        .slice(0, TEACHING_LIMITS.maxPinInstructions);
      const smartFilterConfigs = pipelineSkillLoader.getSmartFilterConfigs(primaryPipelineId);

      const pinInstructions: PinInstructionResponse[] = basePinInstructions.map((inst: PinInstruction) => {
        const hasSmartFilter = inst.smart_filter?.enabled ?? smartFilterConfigs.has(inst.pattern);
        const rawInstruction: RawPinInstruction = {
          pattern: inst.pattern,
          match_by: inst.match_by,
          priority: inst.priority,
          reason: inst.reason,
          expand: inst.expand,
          main_thread_only: inst.main_thread_only,
          smart_filter: hasSmartFilter
            ? (inst.smart_filter || { enabled: true })
            : undefined,
        };

        const transformed = transformPinInstruction(rawInstruction, activeRenderingProcesses);
        if (transformed.smartPin && !transformed.skipPin) {
          transformed.reason = `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`;
        }
        return transformed;
      });

      return {
        stepId: step.id,
        stepType: 'pipeline',
        success: true,
        data: {
          detection: {
            detected: !!pipelineRow || !!explicitPipelineId,
            primaryPipelineId,
            primaryRenderingTypeId,
            primaryConfidence,
            candidates,
            renderingTypeCandidates,
            relatedRenderingTypes,
            features,
            traceRequirementsMissing,
          },
          teachingContent,
          pinInstructions,
          activeRenderingProcesses,
          docPath,
        },
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      rethrowIfTraceProcessorQueryCancelled(error);
      return {
        stepId: step.id,
        stepType: 'pipeline',
        success: false,
        error: error?.message || 'Pipeline step execution failed',
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private resolveStepResultFromSource(
    source: string,
    context: SkillExecutionContext
  ): SkillStepResult | undefined {
    // A source names one of this Skill's own steps: its save_as binding, else its result.
    const binding = ExpressionEvaluator.resolveRootBinding(source, context);
    if (binding?.source === 'variable') return { data: binding.value };
    return binding?.source === 'result' ? binding.result : undefined;
  }

  private resolveFirstObjectRowFromSource(
    source: string,
    context: SkillExecutionContext
  ): Record<string, any> | null {
    const sourceResult = this.resolveStepResultFromSource(source, context);
    const sourceData = sourceResult?.data;
    if (Array.isArray(sourceData)) {
      const row = sourceData.find((item) => item && typeof item === 'object' && !Array.isArray(item));
      return row ? (row as Record<string, any>) : null;
    }
    if (sourceData && typeof sourceData === 'object' && !Array.isArray(sourceData)) {
      return sourceData as Record<string, any>;
    }
    return null;
  }

  private extractTraceRequirementHints(row: Record<string, any> | null): string[] {
    if (!row) return [];
    const hints: string[] = [];
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) hints.push(trimmed);
    }
    return hints;
  }

  /**
   * 调用 AI 服务
   */
  private async callAI(prompt: string, _context: SkillExecutionContext, taskType: string = 'general'): Promise<string> {
    if (!this.aiService) {
      return '';
    }

    assertAiFeatureEnabled('llm_skill_step');
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
      if (error instanceof AiDisabledError) {
        throw error;
      }
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
      const value = ExpressionEvaluator.resolveRootValue(inputName, context);

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
    const rawConfig = displayConfig || { level: 'summary', format: 'table' };
    const { config, issues } = sanitizeDisplayConfigForRuntime(rawConfig, {
      stepId,
      defaultLevel: 'detail',
      defaultLayer: 'list',
      defaultFormat: 'table',
    });
    for (const issue of issues) {
      logger.warn('SkillExecutor', `Sanitized invalid runtime display config: ${formatDisplayContractIssue(issue)}`);
    }

    // Skill 引用步骤返回的是嵌套 SkillExecutionResult，展示时需要先解包到真实数据。
    const selected = selectedStepResult(stepResult);
    const data = selected.data;

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
    } else if (Array.isArray(data)) {
      // 检查是否是 iterator 结果（包含 itemIndex, item, result）
      if (data.length > 0 && this.isIteratorResult(data)) {
        displayData = this.flattenIteratorResults(data, stepResult.stepType === 'iterator', columnDefinitions);
      } else {
        const configuredColumns = Array.isArray(columnDefinitions)
          ? columnDefinitions
            .map((d: any) => d?.name)
            .filter((name: any, idx: number, arr: any[]) =>
              typeof name === 'string' &&
              name.length > 0 &&
              arr.indexOf(name) === idx
            )
          : [];
        const firstItem = data[0];
        if (typeof firstItem === 'object' && firstItem !== null) {
          // If display.columns is provided, project data to configured columns only.
          // This keeps UI tables concise and avoids leaking internal helper fields.
          const columns = configuredColumns.length > 0 ? configuredColumns : Object.keys(firstItem);
          const rows = data.map(row => columns.map(col => this.formatCellValue(row[col])));
          displayData = { columns, rows };
        } else if (data.length === 0) {
          displayData = { columns: configuredColumns, rows: [] };
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

    const executionState = this.stepExecutionState(stepResult, data);
    const skipped = executionState.executionStatus === 'skipped';
    const displayResult: DisplayResult = {
      stepId,
      title: config.title || title,
      level: config.level || 'summary',
      layer: config.layer,         // 分层展示层级
      format: config.format || 'table',
      data: displayData,
      ...scopeMetadata(resultScopeProvenance(selected)),
      ...executionState,
      highlight: config.highlight,
      // A skipped step never ran its query; showing the authored SQL would imply it did.
      sql: skipped ? undefined : selected.sql || sql,
      expandable: config.expandable,           // 是否支持展开查看详细分析
      metadataFields: config.metadataFields,   // 提取到元数据的字段
      hidden_columns: config.hidden_columns,   // 隐藏的列
      columnDefinitions,                       // 完整的列定义（包含 hidden 等属性）
      collapsible: config.collapsible,         // 是否可折叠
      defaultCollapsed: config.defaultCollapsed, // 是否默认折叠
    };
    const witness = evidenceTableFor(selected);
    const table = witness && capturedEvidenceTable(witness);
    const directMapping = Array.isArray(data) && selected.data === data && table &&
      Array.isArray(displayData.rows) && displayData.rows.length === table.rows.length &&
      Array.isArray(displayData.columns) && displayData.columns.every((column: string) => table.columns.includes(column));
    attachEvidenceTable(displayResult, directMapping && witness ? witness :
      captureEvidenceTable(undefined, {}, skipped ? 'execution_skipped' : 'display_transformation_unmapped'));
    return displayResult;
  }

  private stepExecutionState(stepResult: StepResult, data: unknown): StepExecutionState {
    return nonObservedStepState(stepResult) ?? {
      executionStatus: Array.isArray(data) && data.length === 0 ? 'empty' : 'observed',
      executionMessage: stepResult.emptyMessage,
      executionError: stepResult.error,
    };
  }

  /** Carry a raw atomic table to its synthesize view without serializing authority. */
  private createSynthesizeData(step: SkillStep, stepResult: StepResult, display: DisplayConfig,
    config: SynthesizeConfig | undefined): SynthesizeData {
    const entry: SynthesizeData = {
      stepId: step.id,
      stepName: ('name' in step ? step.name : step.id) || step.id,
      stepType: typeof step.type === 'string' ? step.type : 'skill',
      layer: display.layer,
      data: stepResult.data,
      ...scopeMetadata(resultScopeProvenance(stepResult)),
      success: stepResult.success,
      // A failed step has no execution state beyond success=false and its error.
      ...(stepResult.success ? this.stepExecutionState(stepResult, stepResult.data) : nonObservedStepState(stepResult)),
      config,
    };
    // Only this atomic execution object can identify its original table. Nested
    // skill wrappers, iterator flattening and summaries have no such mapping.
    const witness = evidenceTableFor(stepResult);
    if (stepResult.success && stepResult.stepType === 'atomic' && witness) attachEvidenceTable(entry, witness);
    return entry;
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

    // A condition-skipped step has no rows to summarize; it is not an empty result.
    const keyRoleItems = synthesizeData.filter(item =>
      item?.success === true &&
      item.executionStatus !== 'skipped' &&
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

      // Handle columnar format: { columns: string[], rows: any[][] }
      // This is the DataEnvelope v2.0 format returned by trace_processor_shell.
      if (
        data.columns && Array.isArray(data.columns) &&
        Array.isArray(data.rows) && data.rows.length > 0
      ) {
        const row: Record<string, any> = {};
        const cols = data.columns as string[];
        const firstRow = data.rows[0] as any[];
        for (let i = 0; i < cols.length && i < firstRow.length; i++) {
          row[cols[i]] = firstRow[i];
        }
        return row;
      }

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
      ...scopeMetadata(mergeScopeProvenance(synthesizeData.filter(item => item.success).map(resultScopeProvenance))),
      stepId: SYNTHESIZE_SUMMARY_STEP_ID,
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
   * 将 SkillExecutionResult 转换为 DataEnvelope 数组
   *
   * 用于 v2.0 数据契约，统一 SSE 事件格式
   */
  public static toDataEnvelopes(
    result: SkillExecutionResult,
    columnDefinitions?: Record<string, Partial<ColumnDefinition>[]>,
    provenance?: { traceId?: string; traceSide?: DataEnvelopeTraceSide; paneSide?: DataEnvelopeMeta['paneSide'] },
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
      return SkillExecutor.attachTraceProvenanceToEnvelope(
        SkillExecutor.attachIdentityResolutionToEnvelope(
          displayResultToEnvelope(drForEnvelope as any, result.skillId, explicitColumns),
          result.identityResolution,
        ),
        provenance,
      );
    });
  }

  public static attachTraceProvenanceToEnvelope(
    envelope: DataEnvelope,
    provenance?: { traceId?: string; traceSide?: DataEnvelopeTraceSide; paneSide?: DataEnvelopeMeta['paneSide'] },
  ): DataEnvelope {
    if (!provenance?.traceId && !provenance?.traceSide && !provenance?.paneSide) return envelope;
    return {
      ...envelope,
      meta: {
        ...envelope.meta,
        ...(provenance.traceId && !envelope.meta.traceId ? { traceId: provenance.traceId } : {}),
        ...(provenance.traceSide && !envelope.meta.traceSide ? { traceSide: provenance.traceSide } : {}),
        ...(provenance.paneSide && !envelope.meta.paneSide ? { paneSide: provenance.paneSide } : {}),
      },
    };
  }

  public static attachIdentityResolutionToEnvelope(
    envelope: DataEnvelope,
    identityResolution?: IdentityResolutionV1,
  ): DataEnvelope {
    identityResolution = identityForScopeEvidence(envelope.meta.scopeProvenance, identityResolution);
    if (!identityResolution) return envelope;
    const traceSide = identityResolution.target.traceSide === 'current' || identityResolution.target.traceSide === 'reference'
      ? identityResolution.target.traceSide
      : undefined;
    return {
      ...envelope,
      meta: {
        ...envelope.meta,
        ...(!envelope.meta.traceId ? { traceId: identityResolution.target.traceId } : {}),
        ...(traceSide && !envelope.meta.traceSide ? { traceSide } : {}),
        identityRefId: identityResolution.identityRefId,
        identityStatus: identityResolution.status,
        identityWarnings: identityResolution.warnings,
        identityResolution,
      },
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
  /** One expandable entry per iterated item: the item and its Skill result as sections. */
  private iteratorExpandableData(data: any[]): NonNullable<DisplayResult['data']['expandableData']> {
    return data.map((iterItem) => ({
      item: iterItem.item,
      result: {
        success: iterItem.result?.success ?? false,
        sections: this.convertDisplayResultsToSections(iterItem.result?.displayResults || []),
        scopeProvenance: resultScopeProvenance(iterItem.result),
        error: iterItem.result?.error,
      },
    }));
  }

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

      const expandableData = this.iteratorExpandableData(data);

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
    const expandableData = data.map(iterItem => ({
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
    scopeProvenance?: EvidenceScopeProvenanceV1;
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
        ...scopeMetadata(dr.scopeProvenance),
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

export function createSkillExecutor(
  traceProcessor: any,
  aiService?: any,
  eventEmitter?: (event: SkillEvent) => void
): SkillExecutor {
  return new SkillExecutor(traceProcessor, aiService, eventEmitter);
}
