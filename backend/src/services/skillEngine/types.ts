/**
 * Skill Engine Type Definitions
 *
 * 支持：
 * - Skill 可组合（composite）
 * - Skill 可迭代（iterator）
 * - AI 协作（ai_decision, ai_summary）
 * - 诊断推理（diagnostic）
 * - 展示控制（display）
 */

// =============================================================================
// 基础类型
// =============================================================================

export type SkillType = 'atomic' | 'composite' | 'iterator' | 'diagnostic' | 'ai_decision' | 'ai_summary' | 'conditional';

export type DisplayLevel = 'none' | 'debug' | 'detail' | 'summary' | 'key';

export type DisplayFormat = 'table' | 'chart' | 'text' | 'timeline' | 'summary';

/**
 * Display Layer - 控制结果在 UI 中的层级展示
 *
 * 语义说明：
 * - overview: 顶层概览指标（如 FPS、掉帧率）
 * - list: 列表级数据（如滑动会话列表、启动事件列表）
 * - session: 会话级详情（如单个滑动会话的详细数据）
 * - deep: 深度分析数据（如帧级分析、调用栈）
 */
export type DisplayLayer = 'overview' | 'list' | 'session' | 'deep';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

// =============================================================================
// 输入/输出定义
// =============================================================================

export interface SkillInput {
  name: string;
  type: 'string' | 'number' | 'timestamp' | 'duration' | 'array' | 'object';
  required: boolean;
  default?: any;
  description?: string;
}

export interface SkillOutput {
  name: string;
  type: 'string' | 'number' | 'timestamp' | 'duration' | 'array' | 'object';
  description?: string;
}

// =============================================================================
// 展示控制
// =============================================================================

export interface DisplayConfig {
  show?: boolean;
  level?: DisplayLevel;
  layer?: DisplayLayer;         // 分层展示层级
  title?: string;
  format?: DisplayFormat;
  columns?: string[];           // 指定展示哪些列
  aggregate?: boolean;          // 是否汇总迭代结果
  highlight?: HighlightRule[];  // 高亮规则
  expandable?: boolean;         // 是否支持展开查看详细分析（用于 L2 列表关联 L4 deep 数据）
  metadataFields?: string[];    // 提取到元数据的字段（这些字段从列表移到标题显示）
  hidden_columns?: string[];    // 隐藏的列（保留数据但不显示）
}

export interface HighlightRule {
  condition: string;  // 表达式，如 "diagnosis == 'CPU密集'"
  color?: string;
  icon?: string;
}

// =============================================================================
// 诊断规则
// =============================================================================

export interface DiagnosticRule {
  condition: string;          // 条件表达式
  diagnosis: string;          // 诊断结论
  confidence: number | ConfidenceLevel;  // 置信度
  suggestions?: string[];     // 优化建议
  evidence_fields?: string[]; // 证据字段
}

export interface DiagnosticFallback {
  type: 'ai_decision';
  prompt: string;
}

// =============================================================================
// Step 类型
// =============================================================================

/**
 * 原子步骤 - 执行单个 SQL
 */
export interface AtomicStep {
  id: string;
  type: 'atomic';
  name?: string;
  description?: string;
  sql: string;
  display?: DisplayConfig | boolean;
  save_as?: string;
  optional?: boolean;
  on_empty?: string;
  condition?: string;  // 执行条件，不满足时跳过此步骤
  synthesize?: boolean; // 标记此步骤数据用于最终总结
}

/**
 * Skill 引用步骤 - 调用另一个 skill
 */
export interface SkillRefStep {
  id: string;
  type?: 'skill';  // 默认类型
  skill: string;   // 引用的 skill id
  name?: string;
  params?: Record<string, any>;  // 传递给子 skill 的参数
  display?: DisplayConfig | boolean;
  save_as?: string;
}

/**
 * 迭代步骤 - 对每个元素执行 skill
 */
export interface IteratorStep {
  id: string;
  type: 'iterator';
  name?: string;
  source: string;       // 数据源（之前步骤的 save_as）
  item_skill: string;   // 对每个元素执行的 skill
  item_params?: Record<string, string>;  // 从 item 映射到 skill 参数
  display?: DisplayConfig | boolean;
  save_as?: string;
  max_items?: number;   // 最大迭代数量（性能保护）
  synthesize?: boolean; // 标记此步骤数据用于最终总结
}

/**
 * 并行步骤 - 并行执行多个步骤
 */
export interface ParallelStep {
  id: string;
  type: 'parallel';
  name?: string;
  steps: (AtomicStep | SkillRefStep)[];
  display?: DisplayConfig | boolean;
  save_as?: string;
}

/**
 * 诊断步骤 - 根据规则推理
 */
export interface DiagnosticStep {
  id: string;
  type: 'diagnostic';
  name?: string;
  inputs: string[];           // 输入数据源
  rules: DiagnosticRule[];    // 诊断规则
  ai_assist?: boolean;        // 是否让 AI 参与
  fallback?: DiagnosticFallback;  // 规则无法确定时的回退
  display?: DisplayConfig | boolean;
  save_as?: string;
}

/**
 * AI 决策步骤 - 让 AI 做出判断
 */
export interface AIDecisionStep {
  id: string;
  type: 'ai_decision';
  name?: string;
  prompt: string;             // 提示词模板
  inputs?: string[];          // 输入数据源
  output_schema?: Record<string, any>;  // 期望的输出结构
  display?: DisplayConfig | boolean;
  save_as?: string;
}

/**
 * AI 总结步骤 - 让 AI 生成总结
 */
export interface AISummaryStep {
  id: string;
  type: 'ai_summary';
  name?: string;
  prompt: string;
  inputs?: string[];
  display?: DisplayConfig | boolean;
  save_as?: string;
}

/**
 * 条件步骤 - 根据条件选择执行
 */
export interface ConditionalStep {
  id: string;
  type: 'conditional';
  name?: string;
  conditions: {
    when: string;             // 条件表达式
    then: string | SkillStep; // skill id 或内联步骤
  }[];
  else?: string | SkillStep;  // 默认分支
  display?: DisplayConfig | boolean;
  save_as?: string;
}

// 所有步骤类型的联合
export type SkillStep =
  | AtomicStep
  | SkillRefStep
  | IteratorStep
  | ParallelStep
  | DiagnosticStep
  | AIDecisionStep
  | AISummaryStep
  | ConditionalStep;

// =============================================================================
// Skill 定义
// =============================================================================

export interface SkillMeta {
  display_name: string;
  description: string;
  icon?: string;
  tags?: string[];
  author?: string;
  version?: string;
}

export interface SkillTriggers {
  keywords?: {
    zh?: string[];
    en?: string[];
  } | string[];
  patterns?: string[];
  // 自动触发条件（基于 trace 内容）
  auto_detect?: {
    required_tables?: string[];
    conditions?: string[];
  };
}

export interface SkillPrerequisites {
  required_tables?: string[];
  optional_tables?: string[];
  modules?: string[];
}

export interface SkillOutputConfig {
  display?: DisplayConfig;
  fields?: {
    name: string;
    label?: string;
    type?: string;
  }[];
}

export interface SkillDefinition {
  name: string;
  version: string;
  type: SkillType;           // 'atomic' | 'composite' | 'iterator' | 'diagnostic'
  category?: string;
  priority?: string;

  meta: SkillMeta;
  triggers?: SkillTriggers;
  prerequisites?: SkillPrerequisites;

  // 输入参数
  inputs?: SkillInput[];

  // 上下文依赖（从父 skill 继承）
  context?: string[];

  // 执行步骤（composite/iterator/diagnostic 使用）
  steps?: SkillStep[];

  // 原子 skill 的 SQL（atomic 使用）
  sql?: string;

  // 诊断规则（diagnostic 使用）
  rules?: DiagnosticRule[];

  // 输出配置
  output?: SkillOutputConfig;

  // 阈值定义（用于诊断）
  thresholds?: Record<string, {
    unit?: string;
    levels: Record<string, { min?: number; max?: number; label?: string }>;
  }>;

  // ==========================================================================
  // Module Expert System fields (Phase 1 - Cross-Domain Expert System)
  // ==========================================================================

  /**
   * Module metadata - identifies this skill as a module expert
   * When present, this skill can be invoked by cross-domain experts
   */
  module?: ModuleMetadata;

  /**
   * Dialogue interface - how cross-domain experts interact with this module
   * Defines capabilities (questions it can answer), findings schemas, and suggestions
   */
  dialogue?: DialogueInterface;
}

// =============================================================================
// 执行上下文
// =============================================================================

export interface SkillExecutionContext {
  traceId: string;
  packageName?: string;
  vendor?: string;

  // 当前 skill 的输入参数
  params: Record<string, any>;

  // 从父 skill 继承的上下文
  inherited: Record<string, any>;

  // 各步骤的执行结果
  results: Record<string, StepResult>;

  // 保存的变量（save_as）
  variables: Record<string, any>;

  // 当前迭代项（iterator 中使用）
  currentItem?: any;
  currentItemIndex?: number;
}

export interface StepResult {
  stepId: string;
  stepType: SkillType | 'skill' | 'parallel';
  success: boolean;
  data?: any;
  error?: string;
  executionTimeMs: number;
  display?: DisplayConfig;
}

// =============================================================================
// 执行结果
// =============================================================================

export interface SkillExecutionResult {
  skillId: string;
  skillName: string;
  success: boolean;

  // 需要展示的结果（按 display 配置过滤）
  displayResults: DisplayResult[];

  // 诊断结论
  diagnostics: DiagnosticResult[];

  // AI 生成的总结
  aiSummary?: string;

  // 原始结果（用于调试）
  rawResults?: Record<string, StepResult>;

  executionTimeMs: number;
  error?: string;
}

export interface DisplayResult {
  stepId: string;
  title: string;
  level: DisplayLevel;
  layer?: DisplayLayer;         // 分层展示层级
  format: DisplayFormat;
  data: {
    columns?: string[];
    rows?: any[][];
    text?: string;
    chart?: any;
    // 可展开行数据：每行的详细内容（用于 iterator 类型的结果展示）
    expandableData?: Array<{
      // 原始 item 数据
      item: Record<string, any>;
      // 详细分析结果（包含所有子步骤的结果）
      result: {
        success: boolean;
        sections?: Record<string, any>;
        error?: string;
      };
    }>;
    // 汇总报告（用于 iterator 结果的整体分析）
    summary?: {
      title: string;
      content: string;
    };
  };
  highlight?: HighlightRule[];
  /** 原始 SQL 查询（用于 HTML 报告生成） */
  sql?: string;
  /** 是否支持展开查看详细分析（用于 L2 列表关联 L4 deep 数据） */
  expandable?: boolean;
  /** 提取到元数据的字段（这些字段从列表移到标题显示） */
  metadataFields?: string[];
  /** 隐藏的列（保留数据但不显示） */
  hidden_columns?: string[];
}

export interface DiagnosticResult {
  id: string;
  diagnosis: string;
  confidence: number;
  severity: 'info' | 'warning' | 'critical';
  evidence?: Record<string, any>;
  suggestions?: string[];
  source: 'rule' | 'ai';
}

// =============================================================================
// 事件（用于前端实时展示）
// =============================================================================

export type SkillEventType =
  | 'skill_started'
  | 'step_started'
  | 'step_completed'
  | 'display_result'
  | 'diagnostic_found'
  | 'ai_thinking'
  | 'ai_response'
  | 'skill_completed'
  | 'skill_error';

export interface SkillEvent {
  type: SkillEventType;
  timestamp: number;
  skillId: string;
  stepId?: string;
  data?: any;
}

export interface DisplayResultEvent extends SkillEvent {
  type: 'display_result';
  data: DisplayResult;
}

export interface DiagnosticEvent extends SkillEvent {
  type: 'diagnostic_found';
  data: DiagnosticResult;
}

export interface AIThinkingEvent extends SkillEvent {
  type: 'ai_thinking';
  data: {
    prompt: string;
    context?: string;
  };
}

export interface AIResponseEvent extends SkillEvent {
  type: 'ai_response';
  data: {
    response: string;
    tokens?: number;
  };
}

// =============================================================================
// Vendor Types
// =============================================================================

export type VendorType = 'oppo' | 'vivo' | 'xiaomi' | 'honor' | 'transsion' | 'mtk' | 'qualcomm' | 'samsung' | 'aosp' | 'unknown';

export interface VendorDetectionResult {
  vendor: VendorType;
  confidence: ConfidenceLevel;
  matchedPatterns?: string[];
}

// =============================================================================
// Module Expert Types (Phase 1 - Cross-Domain Expert System)
// =============================================================================

/**
 * Module layer in the Android architecture stack
 */
export type ModuleLayer = 'app' | 'framework' | 'kernel' | 'hardware';

/**
 * Module metadata - identifies which layer and component this skill belongs to
 */
export interface ModuleMetadata {
  /** Architecture layer */
  layer: ModuleLayer;
  /** Component name (e.g., "AMS", "Scheduler", "CPU") */
  component: string;
  /** Sub-components this module covers */
  subsystems?: string[];
  /** Related modules that may be consulted */
  relatedModules?: string[];
}

/**
 * Dialogue capability - a question type this module can answer
 */
export interface DialogueCapability {
  /** Unique capability ID */
  id: string;
  /** Question template with placeholders */
  questionTemplate: string;
  /** Required parameters for this question */
  requiredParams: string[];
  /** Optional parameters */
  optionalParams?: string[];
  /** Description of what this capability analyzes */
  description?: string;
}

/**
 * Finding schema - structured finding output format
 */
export interface FindingSchema {
  /** Finding type ID */
  id: string;
  /** Severity level */
  severity: 'info' | 'warning' | 'critical';
  /** Title template with placeholders */
  titleTemplate: string;
  /** Description template */
  descriptionTemplate?: string;
  /** Fields to include as evidence */
  evidenceFields?: string[];
}

/**
 * Suggestion schema - suggests next analysis steps
 */
export interface SuggestionSchema {
  /** Suggestion ID */
  id: string;
  /** Condition expression to trigger this suggestion */
  condition: string;
  /** Target module to consult */
  targetModule: string;
  /** Question template for the target module */
  questionTemplate: string;
  /** Parameter mapping from current results to target params */
  paramsMapping?: Record<string, string>;
  /** Priority (lower = higher priority) */
  priority?: number;
}

/**
 * Dialogue interface - how cross-domain experts interact with this module
 */
export interface DialogueInterface {
  /** Questions this module can answer */
  capabilities?: DialogueCapability[];
  /** Structured findings this module produces */
  findingsSchema?: FindingSchema[];
  /** Suggestions for follow-up analysis */
  suggestionsSchema?: SuggestionSchema[];
}

// =============================================================================
// Loaded Skill
// =============================================================================

/**
 * Loaded Skill - unified format for both atomic and composite skills
 */
export interface LoadedSkill {
  id: string;
  definition: SkillDefinition;
  filePath: string;
}

/**
 * Simplified Skill Result - for compatibility with adapters
 */
export interface SimplifiedSkillResult {
  skillId: string;
  skillName: string;
  success: boolean;
  sections: Record<string, any>;
  diagnostics: DiagnosticResult[];
  summary: string;
  executionTimeMs: number;
  displayResults?: DisplayResult[];
  aiSummary?: string;
}

