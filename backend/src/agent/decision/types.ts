/**
 * Decision Tree Types
 *
 * 定义决策树的核心类型，用于实现专家级分析的条件分支逻辑
 */

import { ArchitectureInfo } from '../detectors';

/**
 * 决策节点类型
 */
export type DecisionNodeType = 'CHECK' | 'ACTION' | 'BRANCH' | 'CONCLUDE';

/**
 * 问题分类
 */
export type ProblemCategory = 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';

/**
 * 问题组件
 */
export type ProblemComponent =
  | 'RENDER_THREAD'      // App 的 RenderThread
  | 'MAIN_THREAD'        // App 的主线程
  | 'CHOREOGRAPHER'      // Choreographer 调度
  | 'SURFACE_FLINGER'    // SurfaceFlinger 合成
  | 'BINDER'             // Binder 调用
  | 'VSYNC'              // VSync 信号
  | 'INPUT'              // 输入处理
  | 'CPU_SCHEDULING'     // CPU 调度
  | 'GPU'                // GPU 渲染
  | 'MEMORY'             // 内存/GC
  | 'IO'                 // IO 操作
  | 'THERMAL'            // 温度限制
  | 'UNKNOWN';

/**
 * 检查条件定义
 */
export interface CheckCondition {
  /** 条件描述 (用于日志/调试) */
  description: string;
  /** 需要执行的 Skill 获取数据 */
  skill?: string;
  /** Skill 参数 */
  skillParams?: Record<string, any>;
  /** 使用之前的结果 (不需要执行新的 Skill) */
  useResultFrom?: string;
  /** 评估函数：根据 Skill 结果返回 true/false */
  evaluate: (result: any, context: DecisionContext) => boolean;
}

/**
 * 执行动作定义
 */
export interface ActionDefinition {
  /** 动作描述 */
  description: string;
  /** 要执行的 Skill */
  skill: string;
  /** Skill 参数 */
  params?: Record<string, any>;
  /** 结果存储的 key (用于后续引用) */
  resultKey?: string;
}

/**
 * 结论定义
 */
export interface ConclusionDefinition {
  /** 问题分类 */
  category: ProblemCategory;
  /** 问题组件 */
  component: ProblemComponent;
  /** 结论摘要模板 (支持变量替换) */
  summaryTemplate: string;
  /** 置信度 */
  confidence: number;
  /** 建议的下一步分析 */
  suggestedNextSteps?: string[];
}

/**
 * 决策节点定义
 */
export interface DecisionNode {
  /** 节点唯一 ID */
  id: string;
  /** 节点类型 */
  type: DecisionNodeType;
  /** 节点名称 (用于日志) */
  name: string;

  /** CHECK 类型的条件 */
  check?: CheckCondition;

  /** ACTION 类型的动作 */
  action?: ActionDefinition;

  /** BRANCH 类型的多条件分支 */
  branches?: {
    condition: CheckCondition;
    next: string;
  }[];

  /** CONCLUDE 类型的结论 */
  conclusion?: ConclusionDefinition;

  /** 下一个节点 (用于 CHECK 和 ACTION) */
  next?: {
    /** 条件为 true 时的下一节点 (CHECK 类型) */
    true?: string;
    /** 条件为 false 时的下一节点 (CHECK 类型) */
    false?: string;
    /** 默认下一节点 (ACTION 类型) */
    default?: string;
  };
}

/**
 * 决策树定义
 */
export interface DecisionTree {
  /** 决策树 ID */
  id: string;
  /** 决策树名称 */
  name: string;
  /** 决策树描述 */
  description: string;
  /** 适用的分析类型 */
  analysisType: 'scrolling' | 'launch' | 'memory' | 'anr' | 'general';
  /** 入口节点 ID */
  entryNode: string;
  /** 所有节点 */
  nodes: DecisionNode[];
}

/**
 * 决策上下文
 */
export interface DecisionContext {
  /** 会话 ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** 检测到的架构信息 */
  architecture?: ArchitectureInfo;
  /** TraceProcessorService */
  traceProcessorService: any;
  /** 之前执行的结果 (key -> result) */
  previousResults: Map<string, any>;
  /** 当前分析的时间范围 (string for precision-safe ns timestamps) */
  timeRange?: { start: number | string; end: number | string };
  /** 目标包名 */
  packageName?: string;
}

/**
 * 节点执行结果
 */
export interface NodeExecutionResult {
  /** 节点 ID */
  nodeId: string;
  /** 节点类型 */
  nodeType: DecisionNodeType;
  /** 执行是否成功 */
  success: boolean;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** 条件检查结果 (CHECK 类型) */
  conditionResult?: boolean;
  /** 动作执行结果 (ACTION 类型) */
  actionResult?: any;
  /** 结论 (CONCLUDE 类型) */
  conclusion?: ConclusionDefinition;
  /** 下一个节点 ID */
  nextNodeId?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 决策树执行结果
 */
export interface DecisionTreeExecutionResult {
  /** 决策树 ID */
  treeId: string;
  /** 执行是否成功 */
  success: boolean;
  /** 总执行耗时 (ms) */
  totalDurationMs: number;
  /** 执行路径 (节点 ID 列表) */
  executionPath: string[];
  /** 每个节点的执行结果 */
  nodeResults: NodeExecutionResult[];
  /** 最终结论 */
  conclusion?: ConclusionDefinition;
  /** 收集的所有数据 */
  collectedData: Map<string, any>;
  /** 错误信息 */
  error?: string;
}

/**
 * 决策树执行器配置
 */
export interface DecisionTreeExecutorConfig {
  /** 最大执行节点数 (防止无限循环) */
  maxNodes: number;
  /** 单节点超时时间 (ms) */
  nodeTimeoutMs: number;
  /** 是否启用详细日志 */
  verbose: boolean;
}
