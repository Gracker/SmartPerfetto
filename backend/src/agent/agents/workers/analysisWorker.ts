/**
 * SmartPerfetto Analysis Worker Agent
 *
 * 桥接层，负责：
 * 1. 将 Pipeline 阶段委托给现有的 Skill 系统执行
 * 2. 转换结果格式为统一的 Finding 结构
 * 3. 不重复实现分析逻辑，复用 YAML Skills
 *
 * 架构位置：
 *   MasterOrchestrator
 *        ↓
 *   PipelineExecutor
 *        ↓
 *   AnalysisWorker (本文件 - 桥接层)
 *        ↓
 *   SkillInvokerTool → SkillAnalysisAdapter → YAML Skills
 */

import { EventEmitter } from 'events';
import {
  PipelineStage,
  SubAgentContext,
  SubAgentResult,
  Finding,
} from '../../types';
import { StageExecutor } from '../../core/pipelineExecutor';
import { ModelRouter } from '../../core/modelRouter';
import { skillInvokerTool, getSkillIdForSceneType } from '../../tools/skillInvoker';
import { SynthesizeConfig } from '../../../services/skillEngine/skillExecutor';

/**
 * 根因类型名称映射（全局常量，避免重复定义）
 */
const CAUSE_NAMES: Record<string, string> = {
  'main_bottleneck': '主线程瓶颈',
  'render_bottleneck': '渲染线程瓶颈',
  'cpu_contention': 'CPU 资源争抢',
  'blocking': '阻塞等待',
  'render_wait': '渲染等待',
  'small_core': '小核运行',
  'freq_limit': '频率受限',
  'binder_call': 'Binder 调用',
  'lock_contention': '锁竞争',
  'unknown': '未知原因',
};

/**
 * Intent 到 Skill 的映射规则
 */
const INTENT_TO_SKILLS: Record<string, string[]> = {
  // 性能问题关键词 -> 对应的 Skills
  // NOTE: janky_frame_analysis removed - scrolling_analysis already provides comprehensive jank detection
  '卡顿': ['scrolling_analysis'],
  'jank': ['scrolling_analysis'],
  '滑动': ['scrolling_analysis'],
  'scroll': ['scrolling_analysis'],
  '掉帧': ['scrolling_analysis'],
  'frame': ['scrolling_analysis'],
  '启动': ['startup_analysis'],
  'startup': ['startup_analysis'],
  'launch': ['startup_analysis'],
  '响应': ['click_response_analysis'],
  'click': ['click_response_analysis'],
  'tap': ['click_response_analysis'],
  'cpu': ['cpu_analysis'],
  '内存': ['memory_analysis'],
  'memory': ['memory_analysis'],
  'anr': ['anr_analysis'],
  'binder': ['binder_analysis'],
  '场景': ['scene_reconstruction'],
  'scene': ['scene_reconstruction'],
};

/**
 * 默认分析 Skills（当无法匹配时使用）
 */
const DEFAULT_SKILLS = ['scrolling_analysis', 'scene_reconstruction'];

/**
 * 分析 Worker - 桥接 Pipeline 和 Skill 系统
 */
export class AnalysisWorker extends EventEmitter implements StageExecutor {
  private modelRouter: ModelRouter;

  // 去重：跟踪已 emit 过 skill_data 的 skill（session 级别）
  private emittedSkillIds: Set<string> = new Set();
  private currentSessionId: string | null = null;

  // 收集 layers 数据用于 HTML 报告生成
  // 结构: { overview: {...}, list: {...}, deep: {...} }
  private collectedLayers: {
    overview: Record<string, any>;
    list: Record<string, any>;
    deep: Record<string, any>;
  } = { overview: {}, list: {}, deep: {} };

  constructor(modelRouter: ModelRouter) {
    super();
    this.modelRouter = modelRouter;
  }

  /**
   * 重置会话状态（新分析开始时调用）
   */
  resetForNewSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.emittedSkillIds.clear();
    // 重置收集的 layers 数据
    this.collectedLayers = { overview: {}, list: {}, deep: {} };
    console.log(`[AnalysisWorker] Reset for new session: ${sessionId}`);
  }

  /**
   * 执行阶段（实现 StageExecutor 接口）
   *
   * 架构原则：
   * - 只有 'execute' 阶段返回 layer 数据（overview/list/deep）
   * - 'refine' 和 'conclude' 阶段不返回 layer 数据，避免 HTML 报告重复
   * - findings 可以在多个阶段返回（会被去重显示）
   */
  async execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult> {
    const startTime = Date.now();

    try {
      this.emit('start', { stage: stage.id });

      let findings: Finding[] = [];

      switch (stage.id) {
        case 'execute':
          findings = await this.executeAnalysis(context);
          break;
        case 'refine':
          findings = await this.refineAnalysis(context);
          break;
        case 'conclude':
          findings = await this.synthesizeConclusion(context);
          break;
        default:
          findings = await this.executeAnalysis(context);
      }

      this.emit('complete', { stage: stage.id, findingsCount: findings.length });

      // 关键修复：只有 'execute' 阶段返回 layer 数据
      // 其他阶段（refine/conclude）不返回，避免 HTML 报告重复显示同样的数据
      const shouldReturnLayerData = stage.id === 'execute';

      // 检查是否有收集到的 layers 数据
      const hasCollectedData =
        Object.keys(this.collectedLayers.overview).length > 0 ||
        Object.keys(this.collectedLayers.list).length > 0 ||
        Object.keys(this.collectedLayers.deep).length > 0;

      console.log(`[AnalysisWorker.execute] Stage: ${stage.id}, shouldReturnLayerData: ${shouldReturnLayerData}, hasCollectedData: ${hasCollectedData}`);

      return {
        agentId: `worker-${stage.id}`,
        success: true,
        findings,
        suggestions: this.extractSuggestions(findings),
        confidence: findings.length > 0 ? 0.7 : 0.3,
        executionTimeMs: Date.now() - startTime,
        // 只有 execute 阶段返回 layer 数据，避免 HTML 报告重复
        data: (shouldReturnLayerData && hasCollectedData) ? {
          overview: this.collectedLayers.overview,
          list: this.collectedLayers.list,
          deep: this.collectedLayers.deep,
        } : undefined,
      };
    } catch (error: any) {
      this.emit('error', { stage: stage.id, error: error.message });

      return {
        agentId: `worker-${stage.id}`,
        success: false,
        findings: [],
        suggestions: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * 执行主分析 - 通过 Skill 系统
   */
  private async executeAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // 1. 确定要执行的 Skills
    const { skillIds, selectionReason } = this.determineSkillsWithReason(context);
    console.log(`[AnalysisWorker] Determined skills: ${skillIds.join(', ')}`);

    // emit worker_thought：Skill 选择理由
    this.emit('worker_thought', {
      agent: 'AnalysisWorker',
      skillId: skillIds.join(', '),
      step: 'skill_selection',
      reasoning: selectionReason,
      data: {
        selectedSkills: skillIds,
        intent: context.intent?.primaryGoal,
      },
    });

    // 2. 检查是否有 traceProcessorService
    if (!context.traceProcessorService || !context.traceId) {
      console.warn('[AnalysisWorker] No traceProcessorService or traceId, falling back to LLM analysis');
      console.warn(`[AnalysisWorker] Context keys: ${Object.keys(context).join(', ')}`);
      console.warn(`[AnalysisWorker] traceId: ${context.traceId}, hasService: ${!!context.traceProcessorService}`);
      return this.fallbackToLLMAnalysis(context);
    }

    console.log(`[AnalysisWorker] Using Skill system with traceId: ${context.traceId}`);

    // 3. 依次调用 Skills
    for (const skillId of skillIds) {
      try {
        const skillFindings = await this.invokeSkill(skillId, context);
        findings.push(...skillFindings);
      } catch (error: any) {
        console.error(`[AnalysisWorker] Skill ${skillId} failed:`, error.message);
        // 继续尝试其他 skills
      }
    }

    // 4. 如果所有 Skills 都失败了，降级到 LLM 分析
    if (findings.length === 0) {
      return this.fallbackToLLMAnalysis(context);
    }

    return findings;
  }

  /**
   * 调用单个 Skill 并转换结果
   */
  private async invokeSkill(skillId: string, context: SubAgentContext): Promise<Finding[]> {
    const toolContext = {
      traceProcessorService: context.traceProcessorService,
      traceId: context.traceId,
    };

    // 检查是否已经处理过这个 skill（会话级别去重）
    const skillKey = `${context.sessionId || 'default'}:${skillId}`;
    const isAlreadyProcessed = this.emittedSkillIds.has(skillKey);

    if (isAlreadyProcessed) {
      console.log(`[AnalysisWorker.invokeSkill] SKIPPING duplicate skill: ${skillId} (already processed in this session)`);
      // 仍然返回 findings（可能需要用于评估），但不重复 emit skill_data
    }

    // emit worker_thought 事件：正在执行 skill
    this.emit('worker_thought', {
      agent: 'AnalysisWorker',
      skillId,
      step: isAlreadyProcessed ? 'reusing_cached' : 'invoking',
      reasoning: isAlreadyProcessed
        ? `跳过重复执行 ${skillId}，使用缓存结果`
        : `开始执行 ${skillId} 分析`,
    });

    console.log(`[AnalysisWorker.invokeSkill] Invoking skill: ${skillId}`);
    const result = await skillInvokerTool.execute({ skillId }, toolContext);

    console.log(`[AnalysisWorker.invokeSkill] Skill ${skillId} result:`, {
      success: result.success,
      hasData: !!result.data,
      error: result.error,
    });

    if (!result.success || !result.data) {
      console.log(`[AnalysisWorker.invokeSkill] Skill ${skillId} failed or no data`);
      return [];
    }

    // 发出层级数据事件，供前端展示
    // 架构原则：Backend 只做数据规范化，不做显示格式化
    const skillData = result.data;

    const layerData = skillData?.data || {};
    const hasOverview = !!layerData.overview;
    const hasList = !!layerData.list;
    const hasDeep = !!layerData.deep;

    console.log(`[AnalysisWorker.invokeSkill] skillData structure:`, {
      hasSkillData: !!skillData,
      hasNestedData: !!layerData,
      dataKeys: Object.keys(layerData),
      hasOverview, hasList, hasDeep,
      overviewKeys: layerData.overview ? Object.keys(layerData.overview) : [],
      listKeys: layerData.list ? Object.keys(layerData.list) : [],
      deepKeys: layerData.deep ? Object.keys(layerData.deep) : [],
    });

    if (skillData?.data) {
      const layers: Record<string, any> = {};

      // 规范化 overview 数据（保持 StepResult 结构）
      if (layerData.overview) {
        const normalized = this.normalizeLayerData(layerData.overview);
        layers.overview = normalized;
        console.log(`[AnalysisWorker.invokeSkill] Normalized overview:`, {
          inputKeys: Object.keys(layerData.overview),
          outputKeys: Object.keys(normalized),
        });
      }

      // 规范化 list 数据
      if (layerData.list) {
        const normalized = this.normalizeLayerData(layerData.list);
        layers.list = normalized;
        console.log(`[AnalysisWorker.invokeSkill] Normalized list:`, {
          inputKeys: Object.keys(layerData.list),
          outputKeys: Object.keys(normalized),
        });
      }

      // 规范化 deep 数据（保持嵌套结构：sessionId -> frameId -> frameData）
      if (layerData.deep) {
        const normalized = this.normalizeDeepData(layerData.deep);
        layers.deep = normalized;
        const sessionIds = Object.keys(normalized);
        const frameCountPerSession = sessionIds.map(sid =>
          `${sid}: ${Object.keys(normalized[sid] || {}).length} frames`
        );
        console.log(`[AnalysisWorker.invokeSkill] Normalized deep:`, {
          inputSessionIds: Object.keys(layerData.deep),
          outputSessionIds: sessionIds,
          frameCountPerSession,
        });
      }

      // 只有当有层级数据时才发出事件
      const overviewCount = Object.keys(layers.overview || {}).length;
      const listCount = Object.keys(layers.list || {}).length;
      const deepCount = Object.keys(layers.deep || {}).length;
      const hasLayerData = overviewCount > 0 || listCount > 0 || deepCount > 0;

      console.log(`[AnalysisWorker.invokeSkill] Layer data check:`, {
        overviewCount, listCount, deepCount, hasLayerData,
      });

      if (hasLayerData) {
        // 收集 layers 数据用于 HTML 报告（无论是否重复都要收集）
        // 使用 skillId 作为前缀避免覆盖
        if (layers.overview) {
          Object.assign(this.collectedLayers.overview, layers.overview);
        }
        if (layers.list) {
          Object.assign(this.collectedLayers.list, layers.list);
        }
        if (layers.deep) {
          // Deep 层是嵌套结构，需要合并而不是覆盖
          for (const [sessionId, frames] of Object.entries(layers.deep)) {
            if (!this.collectedLayers.deep[sessionId]) {
              this.collectedLayers.deep[sessionId] = {};
            }
            Object.assign(this.collectedLayers.deep[sessionId], frames as object);
          }
        }
        console.log(`[AnalysisWorker.invokeSkill] Collected layers for HTML report:`, {
          overviewKeys: Object.keys(this.collectedLayers.overview),
          listKeys: Object.keys(this.collectedLayers.list),
          deepKeys: Object.keys(this.collectedLayers.deep),
        });

        // 去重检查：只在首次处理时 emit skill_data
        if (!isAlreadyProcessed) {
          console.log(`[AnalysisWorker.invokeSkill] EMITTING skill_data event for ${skillId}`);
          this.emit('skill_data', {
            skillId,
            skillName: skillData.skillName || skillId,
            layers,
            diagnostics: skillData.diagnostics || [],
          });
          // 标记为已处理
          this.emittedSkillIds.add(skillKey);
          console.log(`[AnalysisWorker.invokeSkill] skill_data event emitted successfully, marked as processed`);

          // emit worker_thought：完成分析
          this.emit('worker_thought', {
            agent: 'AnalysisWorker',
            skillId,
            step: 'completed',
            reasoning: `${skillId} 分析完成`,
            data: {
              overviewCount,
              listCount,
              deepCount,
              diagnosticsCount: skillData.diagnostics?.length || 0,
            },
          });
        } else {
          console.log(`[AnalysisWorker.invokeSkill] SKIPPING duplicate skill_data emit for ${skillId}`);
        }
      } else {
        console.log(`[AnalysisWorker.invokeSkill] NO DATA to emit for ${skillId} - layers are empty`);
      }
    } else {
      console.log(`[AnalysisWorker.invokeSkill] skillData.data is undefined for ${skillId}`);
    }

    // 转换 Skill 结果为 Finding 格式
    return this.convertSkillResultToFindings(skillId, result.data);
  }

  /**
   * 规范化层级数据结构
   *
   * 架构原则：
   * - Backend 只负责数据结构规范化，不做显示格式化
   * - 保持原始数据完整性，由 Frontend 决定如何展示
   * - 使用统一的 StepResult 格式：{ stepId, data, display, ... }
   *
   * @param layerData 来自 Skill 系统的层级数据 (stepId -> StepResult)
   * @returns 规范化后的数据，保持 StepResult 结构
   */
  private normalizeLayerData(layerData: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = {};

    console.log(`[normalizeLayerData] Processing ${Object.keys(layerData).length} entries`);

    for (const [stepId, stepResult] of Object.entries(layerData)) {
      console.log(`[normalizeLayerData] Processing step: ${stepId}`, {
        hasStepResult: !!stepResult,
        stepResultType: typeof stepResult,
        isArray: Array.isArray(stepResult),
        hasData: !!stepResult?.data,
        dataIsArray: Array.isArray(stepResult?.data),
        dataLength: Array.isArray(stepResult?.data) ? stepResult.data.length : 'N/A',
        stepResultKeys: stepResult ? Object.keys(stepResult) : [],
      });

      if (!stepResult || typeof stepResult !== 'object') {
        console.log(`[normalizeLayerData] Skipping ${stepId}: invalid stepResult`);
        continue;
      }

      // 提取数据数组
      let dataArray: any[] = [];
      if (Array.isArray(stepResult.data)) {
        dataArray = stepResult.data;
      } else if (Array.isArray(stepResult)) {
        dataArray = stepResult;
      }

      if (dataArray.length === 0) {
        console.log(`[normalizeLayerData] Skipping ${stepId}: empty dataArray`);
        continue;
      }

      // 保持 StepResult 结构，只做必要的规范化
      normalized[stepId] = {
        stepId,
        data: dataArray,
        display: stepResult.display || { title: stepId },
        // 保留原始元数据
        ...(stepResult.executionTimeMs && { executionTimeMs: stepResult.executionTimeMs }),
      };

      console.log(`[normalizeLayerData] Added ${stepId} with ${dataArray.length} rows`);
    }

    console.log(`[normalizeLayerData] Normalized ${Object.keys(normalized).length} entries`);
    return normalized;
  }

  /**
   * 规范化 deep 层帧级数据
   *
   * deep 数据结构特殊：{ sessionId: { frameId: StepResult } }
   * 每个 StepResult.data 包含 { diagnosis_summary, full_analysis }
   *
   * 架构原则：
   * - 保持嵌套结构：{ sessionId: { frameId: frameData } }
   * - list 层的 SessionList 期望 deepData[sessionId][frameId] 的格式
   * - 保留完整的分析数据和诊断信息
   * - 不做显示格式化（列名翻译等由 Frontend 处理）
   */
  private normalizeDeepData(deepData: Record<string, Record<string, any>>): Record<string, Record<string, any>> {
    const normalized: Record<string, Record<string, any>> = {};

    for (const [sessionId, frames] of Object.entries(deepData)) {
      if (!frames || typeof frames !== 'object') continue;

      // 保持嵌套结构: normalized[sessionId][frameId]
      normalized[sessionId] = {};

      for (const [frameId, stepResult] of Object.entries(frames)) {
        if (!stepResult || typeof stepResult !== 'object') continue;

        const item = (stepResult as any).item || {};
        const data = stepResult.data || {};

        // 规范化的帧数据结构，保持在嵌套位置
        // 保留原始字段名以匹配前端 deep 层帧分析组件的期望
        normalized[sessionId][frameId] = {
          stepId: `${sessionId}_${frameId}`,
          // 帧基础信息（来自 item）
          item: {
            frame_id: item.frame_id || frameId,
            session_id: item.session_id || sessionId,
            jank_type: item.jank_type,
            dur_ms: item.dur_ms,
            start_ts: item.start_ts,
            end_ts: item.end_ts,
          },
          // 保留原始 data 结构，前端期望 data.diagnosis_summary 和 data.full_analysis
          data: {
            diagnosis_summary: data.diagnosis_summary || null,
            full_analysis: data.full_analysis || null,
          },
          // 显示配置
          display: stepResult.display || {
            title: `Frame ${item.frame_id || frameId}`,
            layer: 'deep',  // 使用语义名称
          },
        };
      }
    }

    return normalized;
  }

  /**
   * 将 Skill 结果转换为 Finding 格式
   *
   * 架构原则：
   * - 【关键】早期收集所有需要用于 synthesize 的数据
   * - 从 overview/list/deep 各层提取关键指标
   * - 对 deep 层帧级数据进行聚类分析，找出共性问题
   * - 生成结构化的 synthesize finding，供最终总结使用
   */
  private convertSkillResultToFindings(skillId: string, skillResult: any): Finding[] {
    const findings: Finding[] = [];
    const baseCategory = skillId.replace('_analysis', '');

    // 1. 从诊断信息创建 Findings
    if (skillResult.diagnostics && Array.isArray(skillResult.diagnostics)) {
      for (const diag of skillResult.diagnostics) {
        findings.push({
          id: `${skillId}-${diag.id}`,
          category: baseCategory,
          severity: this.mapSeverity(diag.severity),
          title: diag.message,
          description: diag.message,
          evidence: [diag],
        });
      }
    }

    // 2. 【核心增强】从层级数据中提取关键 Findings
    // 这些 findings 让评估系统能够"看到"分析的丰富性
    const layerFindings = this.extractFindingsFromLayerData(skillId, skillResult);
    findings.push(...layerFindings);

    // 3. 收集 synthesize 所需的所有关键数据
    const synthesizeData = this.collectSynthesizeData(skillId, skillResult);
    if (synthesizeData) {
      findings.push(synthesizeData);
    }

    // 4. 如果没有任何有价值的数据，但有 AI 摘要
    if (findings.length === 0 && skillResult.aiSummary) {
      findings.push({
        id: `${skillId}-ai-summary`,
        category: baseCategory,
        severity: 'info',
        title: `${skillResult.skillName || skillId} 分析结果`,
        description: skillResult.aiSummary,
        evidence: [],
      });
    }

    console.log(`[convertSkillResultToFindings] Generated ${findings.length} findings for ${skillId}`);
    return findings;
  }

  /**
   * 【核心增强】从层级数据中提取关键 Findings
   *
   * 架构原则：
   * - 从 overview/list/deep 各层提取关键指标
   * - 每个层级生成对应的 findings，让评估系统感知分析的完整性
   * - 使用不同的 category 来表示不同的分析方面
   */
  private extractFindingsFromLayerData(skillId: string, skillResult: any): Finding[] {
    const findings: Finding[] = [];
    const layerData = skillResult.data;

    if (!layerData) {
      return findings;
    }

    const baseCategory = skillId.replace('_analysis', '');

    // === Overview 层：提取性能概览和根因分析 ===
    if (layerData.overview) {
      // 1. 性能汇总 (performance_summary)
      const perfSummary = layerData.overview.performance_summary?.data?.[0];
      if (perfSummary) {
        const jankRate = perfSummary.jank_rate || 0;
        const severity = jankRate > 10 ? 'warning' : jankRate > 5 ? 'info' : 'info';
        findings.push({
          id: `${skillId}-perf-summary`,
          category: baseCategory,
          type: 'performance',
          severity,
          title: `帧性能汇总: ${perfSummary.total_frames || 0} 帧, 掉帧率 ${jankRate}%`,
          description: `平均 FPS: ${perfSummary.actual_fps || 'N/A'}, ` +
                      `平均帧耗时: ${perfSummary.avg_frame_dur_ms || 'N/A'}ms, ` +
                      `评级: ${perfSummary.rating || '未知'}`,
          evidence: [perfSummary],
          details: { layer: 'overview', stepId: 'performance_summary' },
        });
      }

      // 2. 根因分类 (root_cause_classification)
      const rootCause = layerData.overview.root_cause_classification?.data?.[0];
      if (rootCause) {
        const severity = rootCause.problem_category === 'APP' ? 'high' :
                        rootCause.problem_category === 'SYSTEM' ? 'medium' : 'low';
        findings.push({
          id: `${skillId}-root-cause`,
          category: baseCategory,
          type: 'root_cause',
          severity,
          title: `根因分类: ${rootCause.problem_category} - ${rootCause.problem_component}`,
          description: rootCause.root_cause_summary || '根因分析已完成',
          confidence: rootCause.confidence,
          evidence: [rootCause],
          details: {
            layer: 'overview',
            stepId: 'root_cause_classification',
            suggestion: rootCause.suggestion,
          },
        });
      }

      // 3. 掉帧类型统计 (jank_type_stats)
      const jankStats = layerData.overview.jank_type_stats?.data;
      if (jankStats && Array.isArray(jankStats) && jankStats.length > 0) {
        const topJankType = jankStats[0];
        findings.push({
          id: `${skillId}-jank-distribution`,
          category: baseCategory,
          type: 'distribution',
          severity: 'info',
          title: `掉帧类型分布: 主要为 ${topJankType.jank_type} (${topJankType.count} 次)`,
          description: `责任归属: ${topJankType.responsibility}, ` +
                      `共 ${jankStats.length} 种掉帧类型`,
          evidence: jankStats.slice(0, 5),
          details: { layer: 'overview', stepId: 'jank_type_stats' },
        });
      }
    }

    // === List 层：提取滑动区间分析 ===
    if (layerData.list) {
      // 4. 滑动区间 (scroll_sessions)
      const sessions = layerData.list.scroll_sessions?.data;
      if (sessions && Array.isArray(sessions) && sessions.length > 0) {
        const avgFps = sessions.reduce((sum: number, s: any) => sum + (s.session_fps || 0), 0) / sessions.length;
        findings.push({
          id: `${skillId}-scroll-sessions`,
          category: baseCategory,
          type: 'session_analysis',
          severity: 'info',
          title: `检测到 ${sessions.length} 个滑动区间, 平均 FPS ${avgFps.toFixed(1)}`,
          description: `总帧数: ${sessions.reduce((sum: number, s: any) => sum + (s.frame_count || 0), 0)}, ` +
                      `总时长: ${sessions.reduce((sum: number, s: any) => sum + (s.duration_ms || 0), 0).toFixed(0)}ms`,
          evidence: sessions.slice(0, 3),
          details: { layer: 'list', stepId: 'scroll_sessions' },
        });
      }

      // 5. 掉帧帧列表 (get_app_jank_frames)
      const jankFrames = layerData.list.get_app_jank_frames?.data;
      if (jankFrames && Array.isArray(jankFrames) && jankFrames.length > 0) {
        const appJankCount = jankFrames.filter((f: any) => f.jank_responsibility === 'APP').length;
        const sfJankCount = jankFrames.filter((f: any) => f.jank_responsibility === 'SF').length;
        findings.push({
          id: `${skillId}-jank-frames`,
          category: baseCategory,
          type: 'frame_list',
          severity: jankFrames.length > 10 ? 'warning' : 'info',
          title: `检测到 ${jankFrames.length} 个掉帧, APP侧 ${appJankCount} 个, SF侧 ${sfJankCount} 个`,
          description: `最大跳过 VSync: ${Math.max(...jankFrames.map((f: any) => f.vsync_missed || 0))}`,
          evidence: jankFrames.slice(0, 5),
          details: { layer: 'list', stepId: 'get_app_jank_frames' },
        });
      }
    }

    // === Deep 层：提取逐帧详细分析 ===
    if (layerData.deep && typeof layerData.deep === 'object') {
      const sessionIds = Object.keys(layerData.deep);
      let totalFramesAnalyzed = 0;
      const causeCounts: Record<string, number> = {};

      for (const sessionId of sessionIds) {
        const frames = layerData.deep[sessionId];
        if (frames && typeof frames === 'object') {
          const frameIds = Object.keys(frames);
          totalFramesAnalyzed += frameIds.length;

          // 统计根因分布
          for (const frameId of frameIds) {
            const frameData = frames[frameId];
            const causeType = frameData?.data?.diagnosis_summary?.cause_type || 'unknown';
            causeCounts[causeType] = (causeCounts[causeType] || 0) + 1;
          }
        }
      }

      if (totalFramesAnalyzed > 0) {
        const topCause = Object.entries(causeCounts)
          .sort((a, b) => b[1] - a[1])[0];
        const causeName = CAUSE_NAMES[topCause?.[0]] || topCause?.[0] || '未知';

        findings.push({
          id: `${skillId}-deep-analysis`,
          category: baseCategory,
          type: 'deep_analysis',
          severity: 'info',
          title: `完成 ${totalFramesAnalyzed} 帧的详细分析, 主要根因: ${causeName}`,
          description: `覆盖 ${sessionIds.length} 个滑动区间, ` +
                      `根因分布: ${Object.entries(causeCounts)
                        .slice(0, 3)
                        .map(([k, v]) => `${CAUSE_NAMES[k] || k}: ${v}`)
                        .join(', ')}`,
          evidence: [{ causeCounts, totalFramesAnalyzed, sessionCount: sessionIds.length }],
          details: { layer: 'deep', stepId: 'analyze_jank_frames' },
        });
      }
    }

    console.log(`[extractFindingsFromLayerData] Extracted ${findings.length} findings from layer data for ${skillId}`);
    return findings;
  }

  /**
   * 【核心】收集 Synthesize 所需的关键数据
   *
   * 架构原则（方案 1 - YAML-based）：
   * - 使用 Skill YAML 中标记为 synthesize: true 的步骤数据
   * - YAML 标记使配置集中在 Skill 定义中，更易维护
   */
  private collectSynthesizeData(skillId: string, skillResult: any): Finding | null {
    // 使用 YAML 标记的 synthesize 数据
    const yamlSynthesizeData = skillResult.data?.synthesizeData;
    if (yamlSynthesizeData && Array.isArray(yamlSynthesizeData) && yamlSynthesizeData.length > 0) {
      console.log(`[collectSynthesizeData] Using YAML-marked synthesize data: ${yamlSynthesizeData.length} items`);
      return this.buildSynthesizeFindingFromYAMLData(skillId, skillResult, yamlSynthesizeData);
    }

    // 没有 synthesize 数据，返回 null
    console.log(`[collectSynthesizeData] No YAML synthesize data for skill: ${skillId}`);
    return null;
  }

  /**
   * 从 YAML 标记的 synthesize 数据构建 Finding
   *
   * 架构原则（方案 1）：
   * - 数据来自 Skill YAML 中 synthesize: true 标记的步骤
   * - 自动提取并结构化关键指标
   * - 对帧级数据进行聚类分析
   */
  /**
   * 配置驱动的 Synthesize 数据处理
   *
   * 架构原则：
   * - 读取 YAML 中定义的 synthesize config
   * - 根据 role (overview/list/clusters/conclusion) 分别处理
   * - 使用 fields/groupBy/insights 配置自动提取数据
   * - 向后兼容：没有 config 的旧格式数据使用自动检测逻辑
   */
  private buildSynthesizeFindingFromYAMLData(
    skillId: string,
    skillResult: any,
    synthesizeItems: Array<{ stepId: string; stepName?: string; stepType: string; layer?: string; data: any; success: boolean; config?: SynthesizeConfig }>
  ): Finding | null {
    const synthesize: {
      overview: Array<{ label: string; value: string }>;
      distributions: Array<{ title: string; data: Record<string, number> }>;
      rootCauseClusters: Record<string, any>;
      keyInsights: string[];
    } = {
      overview: [],
      distributions: [],
      rootCauseClusters: {},
      keyInsights: [],
    };

    for (const item of synthesizeItems) {
      if (!item.success || !item.data) continue;

      const dataArray = Array.isArray(item.data) ? item.data : [item.data];
      const config = item.config;

      // 如果有 config，使用配置驱动的处理
      if (config && config.role) {
        switch (config.role) {
          case 'overview':
            this.processOverviewConfig(synthesize, config, dataArray[0] || {});
            break;
          case 'list':
            this.processListConfig(synthesize, config, dataArray);
            break;
          case 'clusters':
            this.processClustersConfig(synthesize, config, dataArray, item.stepType);
            break;
          case 'conclusion':
            this.processConclusionConfig(synthesize, config, dataArray[0] || {});
            break;
        }
      } else {
        // 向后兼容：没有 config 的旧格式，使用自动检测
        this.processLegacyItem(synthesize, item.stepId, dataArray);
      }
    }

    // 检查是否有有意义的数据
    const hasData = synthesize.overview.length > 0
      || synthesize.distributions.length > 0
      || Object.keys(synthesize.rootCauseClusters).length > 0
      || synthesize.keyInsights.length > 0;

    if (!hasData) {
      console.log(`[buildSynthesizeFindingFromYAMLData] No meaningful data for ${skillId}`);
      return null;
    }

    // 生成描述文本（使用新的数据结构）
    const description = this.buildSynthesizeDescriptionV2(synthesize, skillResult);

    return {
      id: `${skillId}-synthesize`,
      category: skillId.replace('_analysis', ''),
      type: 'synthesize',
      severity: synthesize.keyInsights.length > 2 ? 'warning' : 'info',
      title: `${skillResult.skillName || skillId} 综合分析`,
      description,
      evidence: [],
      details: {
        synthesize,
        source: 'yaml-config',  // 标记数据来源为配置驱动
      },
    };
  }

  // =========================================================================
  // 配置驱动的处理方法
  // =========================================================================

  /**
   * 处理 overview 角色的配置
   * 从数据中提取字段并应用格式化
   */
  private processOverviewConfig(
    synthesize: { overview: Array<{ label: string; value: string }>; distributions: any[]; rootCauseClusters: any; keyInsights: string[] },
    config: SynthesizeConfig,
    data: Record<string, any>
  ): void {
    // 处理 fields 配置
    for (const field of config.fields || []) {
      const value = data[field.key];
      if (value !== undefined && value !== null) {
        // 将当前字段值作为 {{value}} 可用，同时保留其他字段供模板使用
        const dataWithValue = { ...data, value };
        const displayValue = field.format
          ? this.interpolateTemplate(field.format, dataWithValue)
          : String(value);
        synthesize.overview.push({
          label: field.label,
          value: displayValue,
        });
      }
    }

    // 处理 insights 配置
    for (const insight of config.insights || []) {
      if (!insight.condition || this.evaluateCondition(insight.condition, data)) {
        const text = this.interpolateTemplate(insight.template, data);
        if (text && text.trim()) {
          synthesize.keyInsights.push(text);
        }
      }
    }
  }

  /**
   * 处理 list 角色的配置
   * 对列表数据按指定字段进行分组统计
   */
  private processListConfig(
    synthesize: { overview: any[]; distributions: Array<{ title: string; data: Record<string, number> }>; rootCauseClusters: any; keyInsights: string[] },
    config: SynthesizeConfig,
    dataArray: any[]
  ): void {
    // 处理 groupBy 配置
    for (const groupConfig of config.groupBy || []) {
      const grouped: Record<string, number> = {};
      for (const item of dataArray) {
        const key = item[groupConfig.field] || 'unknown';
        grouped[key] = (grouped[key] || 0) + 1;
      }
      if (Object.keys(grouped).length > 0) {
        synthesize.distributions.push({
          title: groupConfig.title,
          data: grouped,
        });
      }
    }
  }

  /**
   * 处理 clusters 角色的配置
   * 对迭代器结果进行根因聚类
   */
  private processClustersConfig(
    synthesize: { overview: any[]; distributions: any[]; rootCauseClusters: Record<string, any>; keyInsights: string[] },
    config: SynthesizeConfig,
    dataArray: any[],
    stepType: string
  ): void {
    // 检查是否是 iterator 类型的结果
    if (stepType === 'iterator' && dataArray.length > 0 && dataArray[0].item && dataArray[0].result) {
      const clustering = this.clusterFrameRootCausesFromIterator(dataArray);
      if (clustering) {
        synthesize.rootCauseClusters = clustering.clusters;

        // 生成聚类洞察
        const sortedClusters = Object.entries(clustering.clusters)
          .sort((a, b) => (b[1] as any).count - (a[1] as any).count);

        if (sortedClusters.length > 0) {
          const [topCause, topData] = sortedClusters[0];
          const topPercentage = clustering.totalFrames > 0
            ? Math.round(((topData as any).count / clustering.totalFrames) * 100)
            : 0;

          synthesize.keyInsights.push(
            `${topPercentage}% 的掉帧由「${CAUSE_NAMES[topCause] || topCause}」导致`
          );

          // 第二大原因
          if (sortedClusters.length > 1) {
            const [secondCause, secondData] = sortedClusters[1];
            const secondPercentage = clustering.totalFrames > 0
              ? Math.round(((secondData as any).count / clustering.totalFrames) * 100)
              : 0;
            if (secondPercentage >= 20) {
              synthesize.keyInsights.push(
                `${secondPercentage}% 由「${CAUSE_NAMES[secondCause] || secondCause}」导致`
              );
            }
          }
        }
      }
    }
  }

  /**
   * 处理 conclusion 角色的配置
   */
  private processConclusionConfig(
    synthesize: { overview: any[]; distributions: any[]; rootCauseClusters: any; keyInsights: string[] },
    config: SynthesizeConfig,
    data: Record<string, any>
  ): void {
    // 处理 insights 配置
    for (const insight of config.insights || []) {
      if (!insight.condition || this.evaluateCondition(insight.condition, data)) {
        const text = this.interpolateTemplate(insight.template, data);
        if (text && text.trim() && !text.includes('undefined') && !text.includes('null')) {
          synthesize.keyInsights.push(text);
        }
      }
    }
  }

  /**
   * 处理旧格式的 synthesize: true（向后兼容）
   */
  private processLegacyItem(
    synthesize: { overview: Array<{ label: string; value: string }>; distributions: Array<{ title: string; data: Record<string, number> }>; rootCauseClusters: any; keyInsights: string[] },
    stepId: string,
    dataArray: any[]
  ): void {
    // 自动检测数据类型并处理
    const data = dataArray[0] || {};

    // 如果是对象且有数值字段，添加到 overview
    if (typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number' || (typeof value === 'string' && !isNaN(parseFloat(value)))) {
          synthesize.overview.push({
            label: this.formatFieldLabel(key),
            value: String(value),
          });
        }
      }
    }

    // 如果是数组，尝试生成分布统计
    if (dataArray.length > 1) {
      const firstItem = dataArray[0];
      if (typeof firstItem === 'object') {
        // 查找可用于分组的字段
        const groupableFields = Object.keys(firstItem).filter(k =>
          typeof firstItem[k] === 'string' && !k.includes('id') && !k.includes('ts')
        );
        for (const field of groupableFields.slice(0, 2)) {
          const grouped: Record<string, number> = {};
          for (const item of dataArray) {
            const key = item[field] || 'unknown';
            grouped[key] = (grouped[key] || 0) + 1;
          }
          if (Object.keys(grouped).length > 1 && Object.keys(grouped).length < 20) {
            synthesize.distributions.push({
              title: `${this.formatFieldLabel(field)}分布`,
              data: grouped,
            });
          }
        }
      }
    }
  }

  // =========================================================================
  // 辅助方法
  // =========================================================================

  /**
   * 模板插值：将 {{field}} 替换为实际值
   */
  private interpolateTemplate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = data[key];
      if (value === undefined || value === null) return match;
      return String(value);
    });
  }

  /**
   * 条件求值：支持简单的比较表达式
   * 格式: "field > value" 或 "field < value" 或 "field == value"
   */
  private evaluateCondition(condition: string, data: Record<string, any>): boolean {
    const match = condition.match(/^(\w+)\s*(>|<|>=|<=|==|!=)\s*(.+)$/);
    if (!match) return true; // 无法解析时默认为 true

    const [, field, operator, rawValue] = match;
    const fieldValue = data[field];
    if (fieldValue === undefined || fieldValue === null) return false;

    const compareValue = isNaN(Number(rawValue)) ? rawValue.trim() : Number(rawValue);
    const numFieldValue = typeof fieldValue === 'number' ? fieldValue : parseFloat(fieldValue);

    switch (operator) {
      case '>': return numFieldValue > (compareValue as number);
      case '<': return numFieldValue < (compareValue as number);
      case '>=': return numFieldValue >= (compareValue as number);
      case '<=': return numFieldValue <= (compareValue as number);
      case '==': return String(fieldValue) === String(compareValue);
      case '!=': return String(fieldValue) !== String(compareValue);
      default: return true;
    }
  }

  /**
   * 构建 Synthesize 描述文本 V2（配置驱动版本）
   * 注：不要在描述中重复标题，因为 renderFinding 已经单独显示了 title
   */
  private buildSynthesizeDescriptionV2(
    synthesize: { overview: Array<{ label: string; value: string }>; distributions: Array<{ title: string; data: Record<string, number> }>; rootCauseClusters: Record<string, any>; keyInsights: string[] },
    _skillResult: any
  ): string {
    let description = '';

    // 1. 渲染 overview 指标
    if (synthesize.overview.length > 0) {
      description += `### 📊 概览指标\n`;
      description += `| 指标 | 数值 |\n|------|------|\n`;
      for (const { label, value } of synthesize.overview) {
        description += `| ${label} | ${value} |\n`;
      }
      description += '\n';
    }

    // 2. 渲染分布统计
    for (const dist of synthesize.distributions) {
      const entries = Object.entries(dist.data).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) continue;

      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      description += `### 📈 ${dist.title}\n`;
      description += `| 类别 | 数量 | 占比 |\n|------|------|------|\n`;
      for (const [category, count] of entries) {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
        description += `| ${category} | ${count} | ${pct}% |\n`;
      }
      description += '\n';
    }

    // 3. 渲染根因聚类
    if (Object.keys(synthesize.rootCauseClusters).length > 0) {
      description += `### 🔍 根因分析\n`;
      const sortedClusters = Object.entries(synthesize.rootCauseClusters)
        .sort((a, b) => (b[1] as any).count - (a[1] as any).count);
      const totalClustered = sortedClusters.reduce((sum, [, d]) => sum + (d as any).count, 0);

      description += `| 根因类型 | 数量 | 占比 | 说明 |\n|----------|------|------|------|\n`;
      for (const [cause, data] of sortedClusters.slice(0, 5)) {
        const d = data as any;
        const pct = totalClustered > 0 ? ((d.count / totalClustered) * 100).toFixed(1) : '0';
        const causeName = CAUSE_NAMES[cause] || this.formatFieldLabel(cause);
        const primaryCause = d.causes?.[0] ? this.truncateText(d.causes[0], 35) : '-';
        description += `| ${causeName} | ${d.count} | ${pct}% | ${primaryCause} |\n`;
      }
      description += '\n';

      // 显示受影响的帧 ID
      const topCluster = sortedClusters[0];
      if (topCluster) {
        const [, topData] = topCluster;
        const frames = (topData as any).frames || [];
        if (frames.length > 0) {
          const displayFrames = frames.slice(0, 10);
          description += `**受影响帧**: ${displayFrames.join(', ')}`;
          if (frames.length > 10) {
            description += ` 等 ${frames.length} 帧`;
          }
          description += '\n\n';
        }
      }
    }

    // 4. 渲染关键发现
    if (synthesize.keyInsights.length > 0) {
      description += `### 🎯 关键发现\n`;
      for (const insight of synthesize.keyInsights) {
        description += `> ${insight}\n`;
      }
    }

    return description;
  }

  /**
   * 从 Iterator 结果聚类帧级根因
   */
  private clusterFrameRootCausesFromIterator(
    iteratorResults: Array<{ itemIndex: number; item: any; result: any }>
  ): { clusters: Record<string, any>; totalFrames: number } | null {
    const clusters: Record<string, { count: number; causes: string[]; frames: string[] }> = {};
    let totalFrames = 0;

    for (const { item, result } of iteratorResults) {
      if (!result?.displayResults) continue;
      totalFrames++;

      // 从 displayResults 中提取 frame_diagnosis
      const diagResult = result.displayResults.find((dr: any) =>
        dr.stepId === 'frame_diagnosis' || dr.stepId === 'diagnosis'
      );

      if (!diagResult?.data?.diagnostics?.[0]) continue;

      const diag = diagResult.data.diagnostics[0];
      const causeType = diag.cause_type || 'unknown';
      const primaryCause = diag.primary_cause || diag.diagnosis || '';

      if (!clusters[causeType]) {
        clusters[causeType] = { count: 0, causes: [], frames: [] };
      }

      clusters[causeType].count++;
      clusters[causeType].frames.push(item.frame_id || item.frame_index || '?');
      if (primaryCause && !clusters[causeType].causes.includes(primaryCause)) {
        clusters[causeType].causes.push(primaryCause);
      }
    }

    if (totalFrames === 0) return null;

    return { clusters, totalFrames };
  }

  /**
   * 格式化字段标签（snake_case -> 可读中文/英文）
   */
  private formatFieldLabel(key: string): string {
    const labels: Record<string, string> = {
      totalFrames: '总帧数',
      total_frames: '总帧数',
      jankFrames: '掉帧数',
      janky_frames: '掉帧数',
      jankRate: '掉帧率',
      jank_rate: '掉帧率',
      avgFps: '平均 FPS',
      avg_fps: '平均 FPS',
      appJank: 'App 侧掉帧',
      app_jank: 'App 侧掉帧',
      sfJank: 'SF 侧掉帧',
      sf_jank: 'SF 侧掉帧',
      durationMs: '持续时间',
      duration_ms: '持续时间',
      jank_responsibility: '责任归属',
      jank_type: '掉帧类型',
      cause_type: '根因类型',
      // 通用标签
      count: '数量',
      total: '总计',
      average: '平均值',
      max: '最大值',
      min: '最小值',
    };
    return labels[key] || key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim();
  }

  /**
   * 截断文本，超过指定长度时添加省略号
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * 确定要执行的 Skills（带选择理由）
   */
  private determineSkillsWithReason(context: SubAgentContext): { skillIds: string[]; selectionReason: string } {
    const { intent, plan } = context;
    const skills = new Set<string>();
    const matchedKeywords: string[] = [];

    // 1. 从 intent 的 primaryGoal 匹配
    if (intent?.primaryGoal) {
      const goal = intent.primaryGoal.toLowerCase();
      for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
        if (goal.includes(keyword)) {
          skillList.forEach(s => skills.add(s));
          matchedKeywords.push(`intent:${keyword}`);
        }
      }
    }

    // 2. 从 intent 的 aspects 匹配
    if (intent?.aspects) {
      for (const aspect of intent.aspects) {
        const lowerAspect = aspect.toLowerCase();
        for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
          if (lowerAspect.includes(keyword)) {
            skillList.forEach(s => skills.add(s));
            matchedKeywords.push(`aspect:${keyword}`);
          }
        }
      }
    }

    // 3. 从 plan 的 tasks 匹配
    if (plan?.tasks) {
      for (const task of plan.tasks) {
        const objective = task.objective.toLowerCase();
        for (const [keyword, skillList] of Object.entries(INTENT_TO_SKILLS)) {
          if (objective.includes(keyword)) {
            skillList.forEach(s => skills.add(s));
            matchedKeywords.push(`task:${keyword}`);
          }
        }
      }
    }

    // 4. 如果没有匹配到任何 skill，使用默认
    let selectionReason: string;
    if (skills.size === 0) {
      DEFAULT_SKILLS.forEach(s => skills.add(s));
      selectionReason = `未匹配到特定关键词，使用默认分析 Skills: ${DEFAULT_SKILLS.join(', ')}`;
    } else {
      selectionReason = `基于关键词 [${matchedKeywords.join(', ')}] 选择 Skills: ${Array.from(skills).join(', ')}`;
    }

    return { skillIds: Array.from(skills), selectionReason };
  }

  /**
   * 映射严重程度
   */
  private mapSeverity(severity: string): 'info' | 'warning' | 'critical' {
    const lower = severity?.toLowerCase() || '';
    if (lower.includes('critical') || lower.includes('error') || lower.includes('severe')) {
      return 'critical';
    }
    if (lower.includes('warning') || lower.includes('warn')) {
      return 'warning';
    }
    return 'info';
  }

  /**
   * 降级到 LLM 分析（当 Skill 系统不可用时）
   */
  private async fallbackToLLMAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const primaryGoal = context.intent?.primaryGoal || '性能分析';

    const prompt = `你是 Android 性能分析专家。用户询问: "${primaryGoal}"

基于用户的问题，生成一个分析结果。由于无法访问实际的 trace 数据，请提供通用的分析指导。

以 JSON 格式回复:
{
  "title": "分析结果标题",
  "description": "详细描述和建议",
  "severity": "info"
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return [{
          id: 'llm-analysis',
          category: 'analysis',
          title: parsed.title || '分析结果',
          description: parsed.description || '请确保 trace 数据已正确加载',
          severity: (parsed.severity as 'info' | 'warning' | 'critical') || 'info',
          evidence: [],
        }];
      }
    } catch (error) {
      // 静默失败
    }

    return [{
      id: 'fallback',
      category: 'system',
      title: '分析进行中',
      description: `正在分析: ${primaryGoal}。请确保 trace 数据已正确加载。`,
      severity: 'info',
      evidence: [],
    }];
  }

  /**
   * 优化分析 - 基于之前的结果深化
   */
  private async refineAnalysis(context: SubAgentContext): Promise<Finding[]> {
    const previousResults = context.previousResults || [];
    const existingFindings: Finding[] = [];

    for (const result of previousResults) {
      if (result.findings) {
        existingFindings.push(...result.findings);
      }
    }

    // 如果已有发现，保持现有结果
    if (existingFindings.length > 0) {
      return existingFindings;
    }

    // 否则重新执行分析
    return this.executeAnalysis(context);
  }

  /**
   * 综合结论 - 去重并合并所有发现
   */
  private async synthesizeConclusion(context: SubAgentContext): Promise<Finding[]> {
    const previousResults = context.previousResults || [];
    const allFindings: Finding[] = [];

    for (const result of previousResults) {
      if (result.findings) {
        allFindings.push(...result.findings);
      }
    }

    // 去重
    const seen = new Set<string>();
    return allFindings.filter(f => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  }

  /**
   * 从 Findings 提取建议
   */
  private extractSuggestions(findings: Finding[]): string[] {
    const suggestions: string[] = [];

    for (const finding of findings) {
      if (finding.severity === 'critical') {
        suggestions.push(`[严重] ${finding.title}`);
      } else if (finding.severity === 'warning') {
        suggestions.push(`[警告] ${finding.title}`);
      }
    }

    if (suggestions.length === 0 && findings.length > 0) {
      suggestions.push('查看详细分析结果');
    }

    return suggestions.slice(0, 5); // 最多 5 条
  }
}

export default AnalysisWorker;
