/**
 * Skill Analysis Adapter v2.0
 *
 * Integrates SkillExecutorV2 with the orchestrator.
 * Provides intent detection, skill execution, and result conversion.
 */

import { TraceProcessorService } from '../traceProcessorService';
import { SkillExecutorV2, createSkillExecutorV2, LayeredResult } from './skillExecutorV2';
import { skillRegistryV2, ensureSkillRegistryV2Initialized, getSkillsDir } from './skillLoaderV2';
import { SkillDefinitionV2, SkillEvent, DisplayLevel } from './types_v2';
import { smartSummaryGenerator } from './smartSummaryGenerator';
import { answerGenerator, GeneratedAnswer } from './answerGenerator';
import { SkillEventCollector, createEventCollector, EventSummary, ProgressInfo } from './eventCollector';

// =============================================================================
// Types
// =============================================================================

export interface SkillAnalysisRequestV2 {
  traceId: string;
  skillId?: string;
  question?: string;
  packageName?: string;
}

export interface SkillAnalysisResponseV2 {
  skillId: string;
  skillName: string;
  success: boolean;
  sections: Record<string, any>;
  diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    suggestions?: string[];
  }>;
  summary: string;
  executionTimeMs: number;
  vendor?: string;

  // v2 新增
  displayResults?: Array<{
    stepId: string;
    title: string;
    level: DisplayLevel;
    format: string;
    data: any;
  }>;
  aiSummary?: string;

  /** 直接回答用户问题的自然语言 */
  directAnswer?: string;
  /** 回答的问题类型 */
  questionType?: string;
  /** 回答置信度 */
  answerConfidence?: 'high' | 'medium' | 'low';

  /** 分层结果（L1/L2/L3/L4）- 用于交互式分层视图 */
  layeredResult?: LayeredResult;

  /** 执行事件列表（用于前端进度展示） */
  executionEvents?: SkillEvent[];
  /** 事件摘要 */
  eventSummary?: EventSummary;
}

export interface SkillListItemV2 {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  keywords: string[];
  tags?: string[];
}

export interface AdaptedResult {
  format: 'layered';
  layers: LayeredResult['layers'];
  defaultExpanded: ('L1' | 'L2' | 'L3' | 'L4')[];
  metadata: LayeredResult['metadata'];
}

// =============================================================================
// Skill Analysis Adapter V2
// =============================================================================

export class SkillAnalysisAdapterV2 {
  private traceProcessor: TraceProcessorService;
  private executor: SkillExecutorV2;
  private initialized = false;
  private eventHandler?: (event: SkillEvent) => void;
  private currentEventCollector?: SkillEventCollector;

  constructor(
    traceProcessor: TraceProcessorService,
    eventHandler?: (event: SkillEvent) => void
  ) {
    this.traceProcessor = traceProcessor;
    this.eventHandler = eventHandler;

    // 创建 executor，传入事件处理器
    this.executor = createSkillExecutorV2(
      traceProcessor,
      undefined,  // AI service 稍后注入
      eventHandler
    );
  }

  /**
   * 设置 AI 服务（用于 ai_decision 和 ai_summary 步骤）
   */
  setAIService(aiService: any): void {
    // SkillExecutorV2 需要支持 setAIService 方法
    (this.executor as any).aiService = aiService;
  }

  /**
   * 设置事件处理器
   */
  setEventHandler(handler: (event: SkillEvent) => void): void {
    this.eventHandler = handler;
    (this.executor as any).eventEmitter = handler;
  }

  /**
   * 确保 skill registry 已初始化
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await ensureSkillRegistryV2Initialized();

    // 将所有 skills 注册到 executor
    const skills = skillRegistryV2.getAllSkills();
    this.executor.registerSkills(skills);

    this.initialized = true;
    console.log(`[SkillAnalysisAdapterV2] Initialized with ${skills.length} skills`);
  }

  /**
   * 从自然语言问题检测意图
   * 返回匹配的 skill ID 或 null
   */
  detectIntent(question: string): string | null {
    const skill = skillRegistryV2.findMatchingSkill(question);
    return skill ? skill.name : null;
  }

  /**
   * 检测厂商（从 trace 数据）
   */
  async detectVendor(traceId: string): Promise<{ vendor: string; confidence: number }> {
    try {
      // 尝试检测厂商特征
      const result = await this.traceProcessor.query(traceId, `
        SELECT
          CASE
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*miui*') THEN 'xiaomi'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*oppo*' OR name GLOB '*color*') THEN 'oppo'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*vivo*') THEN 'vivo'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*huawei*' OR name GLOB '*honor*') THEN 'huawei'
            WHEN EXISTS(SELECT 1 FROM slice WHERE name GLOB '*samsung*' OR name GLOB '*oneui*') THEN 'samsung'
            ELSE 'aosp'
          END as vendor
      `);

      if (result.rows && result.rows.length > 0) {
        return {
          vendor: result.rows[0][0] as string,
          confidence: 0.8,
        };
      }
    } catch (error) {
      console.warn('[SkillAnalysisAdapterV2] Vendor detection failed:', error);
    }

    return { vendor: 'aosp', confidence: 0.5 };
  }

  /**
   * 检测 skill 是否使用分层输出（L1/L2/L3/L4）
   */
  private hasLayeredOutput(skill: SkillDefinitionV2): boolean {
    if (!skill.steps || skill.steps.length === 0) {
      return false;
    }
    // 检查是否有任何 step 定义了 layer 属性
    return skill.steps.some(step =>
      step.display && typeof step.display === 'object' && 'layer' in step.display
    );
  }

  /**
   * 执行 skill 分析
   * 这是主要的入口点
   */
  async analyze(request: SkillAnalysisRequestV2): Promise<SkillAnalysisResponseV2> {
    await this.ensureInitialized();

    const { traceId, skillId, question, packageName } = request;

    // 确定使用哪个 skill
    let targetSkillId = skillId;
    if (!targetSkillId && question) {
      targetSkillId = this.detectIntent(question) || undefined;
    }

    if (!targetSkillId) {
      return {
        skillId: 'unknown',
        skillName: 'Unknown',
        success: false,
        sections: {},
        diagnostics: [{
          id: 'no_skill_match',
          severity: 'warning',
          message: '无法匹配到合适的分析技能',
          suggestions: [
            '尝试使用关键词：启动、滑动、卡顿、内存、CPU、Binder',
            '使用 skillId 参数指定具体的技能',
          ],
        }],
        summary: '无法确定使用哪个分析技能',
        executionTimeMs: 0,
      };
    }

    // 获取 skill 信息
    const skill = skillRegistryV2.getSkill(targetSkillId);
    if (!skill) {
      return {
        skillId: targetSkillId,
        skillName: targetSkillId,
        success: false,
        sections: {},
        diagnostics: [{
          id: 'skill_not_found',
          severity: 'critical',
          message: `技能未找到: ${targetSkillId}`,
        }],
        summary: `技能未找到: ${targetSkillId}`,
        executionTimeMs: 0,
      };
    }

    // 检测厂商
    const vendorResult = await this.detectVendor(traceId);

    // 构建参数
    const params: Record<string, any> = {};
    if (packageName) {
      params.package = packageName;
    }

    // 创建事件收集器
    const eventCollector = createEventCollector();
    const totalSteps = skill.steps?.length || 1;
    eventCollector.start(targetSkillId, totalSteps);

    // 设置事件处理器（同时转发到外部处理器和收集器）
    const combinedHandler = (event: SkillEvent) => {
      eventCollector.addEvent(event);
      if (this.eventHandler) {
        this.eventHandler(event);
      }
    };
    (this.executor as any).eventEmitter = combinedHandler;

    // 检测是否使用分层输出
    const useLayeredOutput = this.hasLayeredOutput(skill);
    console.log(`[SkillAnalysisAdapterV2] Skill ${targetSkillId} has layered output:`, useLayeredOutput);

    let result: any;
    let layeredResult: LayeredResult | undefined;

    if (useLayeredOutput) {
      // 使用分层输出模式（executeCompositeSkill）
      console.log('[SkillAnalysisAdapterV2] Using layered output mode for skill', targetSkillId);
      try {
        layeredResult = await (this.executor as any).executeCompositeSkill(
          skill,
          params,
          { traceId, vendor: vendorResult.vendor }
        );
        console.log('[SkillAnalysisAdapterV2] executeCompositeSkill completed. layeredResult:', JSON.stringify({
          hasLayers: !!layeredResult?.layers,
          layerKeys: layeredResult?.layers ? Object.keys(layeredResult.layers) : [],
          L1Count: layeredResult?.layers?.L1 ? Object.keys(layeredResult.layers.L1).length : 0,
          L2Count: layeredResult?.layers?.L2 ? Object.keys(layeredResult.layers.L2).length : 0,
          L3Count: layeredResult?.layers?.L3 ? Object.keys(layeredResult.layers.L3).length : 0,
          L4SessionCount: layeredResult?.layers?.L4 ? Object.keys(layeredResult.layers.L4).length : 0,
          hasMetadata: !!layeredResult?.metadata,
        }, null, 2));

        // 将 LayeredResult 转换为 displayResults 格式
        console.log('[SkillAnalysisAdapterV2] Calling convertLayeredResultToDisplayResults...');
        const displayResults = this.convertLayeredResultToDisplayResults(layeredResult!);
        console.log('[SkillAnalysisAdapterV2] convertLayeredResultToDisplayResults completed with', displayResults.length, 'items');

        result = {
          success: true,
          displayResults,
          diagnostics: [],
          executionTimeMs: 0,
        };
      } catch (error) {
        console.error('[SkillAnalysisAdapterV2] executeCompositeSkill failed:', error);
        throw error;
      }
    } else {
      // 使用传统输出模式（execute）
      console.log('[SkillAnalysisAdapterV2] Using traditional output mode for skill', targetSkillId);
      result = await this.executor.execute(
        targetSkillId,
        traceId,
        params,
        { vendor: vendorResult.vendor }
      );
    }

    // 收集事件信息
    const executionEvents = eventCollector.getEvents();
    const eventSummary = eventCollector.getSummary();

    // 转换结果格式
    console.log('[SkillAnalysisAdapterV2] displayResults count:', result.displayResults.length);
    console.log('[SkillAnalysisAdapterV2] displayResults:', JSON.stringify(result.displayResults.map((dr: any) => ({
      stepId: dr.stepId,
      title: dr.title,
      hasData: !!dr.data,
      dataKeys: dr.data ? Object.keys(dr.data) : [],
    })), null, 2));

    const sections = this.convertDisplayResultsToSections(result.displayResults);

    console.log('[SkillAnalysisAdapterV2] sections count:', Object.keys(sections).length);
    console.log('[SkillAnalysisAdapterV2] sections keys:', Object.keys(sections));
    console.log('[SkillAnalysisAdapterV2] result.success:', result.success);

    const diagnostics = result.diagnostics.map((d: any) => ({
      id: d.id,
      severity: d.severity,
      message: d.diagnosis,
      suggestions: d.suggestions,
    }));

    // 生成智能摘要（优先使用 AI 摘要，否则使用规则生成）
    let summary: string;
    if (result.aiSummary) {
      summary = result.aiSummary;
    } else {
      const generatedSummary = smartSummaryGenerator.generate({
        skillId: targetSkillId,
        skillName: skill.meta.display_name,
        displayResults: result.displayResults,
        diagnostics: result.diagnostics,
        executionTimeMs: result.executionTimeMs,
      });
      summary = generatedSummary.text;
    }

    // 生成直接回答
    const answer = answerGenerator.generateAnswer({
      originalQuestion: question || '',
      skillId: targetSkillId,
      skillName: skill.meta.display_name,
      success: result.success,
      diagnostics,
      sections,
      executionTimeMs: result.executionTimeMs,
    });

    return {
      skillId: targetSkillId,
      skillName: skill.meta.display_name,
      success: result.success,
      sections,
      diagnostics,
      summary,
      executionTimeMs: result.executionTimeMs,
      vendor: vendorResult.vendor !== 'aosp' ? vendorResult.vendor : undefined,
      displayResults: result.displayResults,
      aiSummary: result.aiSummary,
      directAnswer: answer.answer,
      questionType: answer.questionType,
      answerConfidence: answer.confidence,
      // Include layeredResult for frontend display
      layeredResult,
      // 事件流
      executionEvents,
      eventSummary,
    };
  }

  /**
   * 将 LayeredResult 转换为 displayResults 格式
   * 用于处理分层输出模式（L1/L2/L3/L4）
   */
  private convertLayeredResultToDisplayResults(layeredResult: LayeredResult): Array<{
    stepId: string;
    title: string;
    level: DisplayLevel;
    format: string;
    data: any;
    sql?: string;
  }> {
    console.log('[convertLayeredResultToDisplayResults] Starting conversion. Input:', JSON.stringify({
      hasL1: !!layeredResult?.layers?.L1,
      hasL2: !!layeredResult?.layers?.L2,
      hasL3: !!layeredResult?.layers?.L3,
      hasL4: !!layeredResult?.layers?.L4,
    }, null, 2));

    const displayResults: Array<{
      stepId: string;
      title: string;
      level: DisplayLevel;
      format: string;
      data: any;
      sql?: string;
    }> = [];

    // 处理 L1 和 L2 层（直接是 stepId -> StepResult 的映射）
    for (const layerKey of ['L1', 'L2'] as const) {
      const layer = layeredResult.layers[layerKey];
      if (!layer) {
        console.log(`[convertLayeredResultToDisplayResults] Layer ${layerKey} is empty, skipping`);
        continue;
      }

      console.log(`[convertLayeredResultToDisplayResults] Processing ${layerKey} with ${Object.keys(layer).length} steps`);
      for (const [stepId, stepResult] of Object.entries(layer)) {
        if (!stepResult.display?.show && stepResult.display?.show !== undefined) {
          console.log(`[convertLayeredResultToDisplayResults] Skipping ${stepId} (show=false)`);
          continue;
        }
        if (stepResult.display?.level === 'none') {
          console.log(`[convertLayeredResultToDisplayResults] Skipping ${stepId} (level=none)`);
          continue;
        }

        const dr = {
          stepId,
          title: stepResult.display?.title || stepId,
          level: stepResult.display?.level || 'detail',
          format: stepResult.display?.format || 'table',
          data: stepResult.data || {},
        };
        console.log(`[convertLayeredResultToDisplayResults] Adding ${layerKey} item:`, JSON.stringify({
          stepId,
          hasData: !!dr.data,
          dataType: Array.isArray(dr.data) ? 'array' : typeof dr.data,
          dataLength: Array.isArray(dr.data) ? dr.data.length : 'N/A',
        }));
        displayResults.push(dr);
      }
    }

    // 处理 L3 层（按 session_id 组织）
    const l3 = layeredResult.layers.L3;
    if (l3) {
      console.log(`[convertLayeredResultToDisplayResults] Processing L3 with ${Object.keys(l3).length} sessions`);
      for (const [sessionId, sessionSteps] of Object.entries(l3)) {
        console.log(`[convertLayeredResultToDisplayResults] Processing L3 session ${sessionId} with ${Object.keys(sessionSteps).length} steps`);
        for (const [stepId, stepResult] of Object.entries(sessionSteps)) {
          if (!stepResult.display?.show && stepResult.display?.show !== undefined) continue;
          if (stepResult.display?.level === 'none') continue;

          displayResults.push({
            stepId: `${sessionId}_${stepId}`,
            title: stepResult.display?.title || `[${sessionId}] ${stepId}`,
            level: stepResult.display?.level || 'detail',
            format: stepResult.display?.format || 'table',
            data: stepResult.data || {},
          });
        }
      }
    }

    // 处理 L4 层（按 session_id -> frame_id 组织）
    const l4 = layeredResult.layers.L4;
    if (l4) {
      console.log(`[convertLayeredResultToDisplayResults] Processing L4 with ${Object.keys(l4).length} sessions`);
      for (const [sessionId, frames] of Object.entries(l4)) {
        console.log(`[convertLayeredResultToDisplayResults] Processing L4 session ${sessionId} with ${Object.keys(frames).length} frames`);
        for (const [frameId, stepResult] of Object.entries(frames)) {
          if (!stepResult.display?.show && stepResult.display?.show !== undefined) continue;
          if (stepResult.display?.level === 'none') continue;

          const dr = {
            stepId: `${sessionId}_${frameId}`,
            title: stepResult.display?.title || `[${sessionId}] ${frameId}`,
            level: stepResult.display?.level || 'detail',
            format: stepResult.display?.format || 'table',
            data: stepResult.data || {},
          };
          console.log(`[convertLayeredResultToDisplayResults] Adding L4 frame:`, JSON.stringify({
            stepId: dr.stepId,
            title: dr.title,
            hasData: !!dr.data,
            dataType: Array.isArray(dr.data) ? 'array' : typeof dr.data,
            dataLength: Array.isArray(dr.data) ? dr.data.length : 'N/A',
          }));
          displayResults.push(dr);
        }
      }
    }

    console.log(`[convertLayeredResultToDisplayResults] Completed. Converted to ${displayResults.length} displayResults`);
    return displayResults;
  }

  /**
   * 将 displayResults 转换为 sections 格式（兼容 v1）
   */
  private convertDisplayResultsToSections(
    displayResults: Array<{
      stepId: string;
      title: string;
      level: DisplayLevel;
      format: string;
      data: any;
      sql?: string;  // 新增：原始 SQL
    }>
  ): Record<string, any> {
    const sections: Record<string, any> = {};

    console.log('[convertDisplayResultsToSections] Input displayResults count:', displayResults.length);
    console.log('[convertDisplayResultsToSections] Input displayResults:', JSON.stringify(displayResults.map(dr => ({
      stepId: dr.stepId,
      title: dr.title,
      dataKeys: Object.keys(dr.data || {}),
      hasExpandableData: !!dr.data?.expandableData,
      expandableDataCount: dr.data?.expandableData?.length || 0,
    })), null, 2));

    for (const result of displayResults) {
      console.log(`[convertDisplayResultsToSections] Processing ${result.stepId}:`, JSON.stringify({
        hasData: !!result.data,
        dataType: typeof result.data,
        dataIsArray: Array.isArray(result.data),
        dataHasRows: !!result.data?.rows,
        dataHasText: !!result.data?.text,
        dataLength: Array.isArray(result.data) ? result.data.length : 'N/A',
        dataSample: Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : result.data,
      }, null, 2));

      // 处理不同类型的 data 格式
      let sectionData: any;
      let rowCount: number;
      let columns: string[] | undefined;

      // 1. 标准 {columns, rows} 格式
      if (result.data.rows && Array.isArray(result.data.rows)) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using {columns, rows} format`);
        sectionData = this.rowsToObjects(result.data.columns, result.data.rows);
        rowCount = result.data.rows.length;
        columns = result.data.columns;
      }
      // 2. 文本格式
      else if (result.data.text) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using text format`);
        sectionData = [{ text: result.data.text }];
        rowCount = 1;
      }
      // 3. 对象数组格式（直接来自 SQL 查询）
      else if (Array.isArray(result.data)) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using array format, length=${result.data.length}`);
        sectionData = result.data;
        rowCount = result.data.length;
        // 从第一个对象提取列名
        if (result.data.length > 0 && typeof result.data[0] === 'object') {
          columns = Object.keys(result.data[0]);
          console.log(`[convertDisplayResultsToSections] ${result.stepId}: Extracted columns:`, columns);
        }
      }
      // 4. 其他情况
      else {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Unknown format, using empty array`);
        sectionData = [];
        rowCount = 0;
      }

      const section: any = {
        title: result.title,
        level: result.level,
        format: result.format,
        data: sectionData,
        rowCount,
        columns,
        sql: result.sql,  // 保存 SQL
      };

      console.log(`[convertDisplayResultsToSections] ${result.stepId}: Final sectionData:`, JSON.stringify({
        dataType: typeof sectionData,
        dataLength: Array.isArray(sectionData) ? sectionData.length : 'N/A',
        hasColumns: !!columns,
        columnsCount: columns?.length || 0,
        sampleData: Array.isArray(sectionData) && sectionData.length > 0 ? sectionData[0] : sectionData,
      }, null, 2));

      // 包含可展开数据和汇总（用于 iterator 类型的结果）
      if (result.data.expandableData) {
        section.expandableData = result.data.expandableData;
        console.log(`[convertDisplayResultsToSections] Step ${result.stepId} has expandableData with ${result.data.expandableData.length} items`);
      }
      if (result.data.summary) {
        section.summary = result.data.summary;
      }

      sections[result.stepId] = section;
    }

    console.log('[convertDisplayResultsToSections] Output sections count:', Object.keys(sections).length);
    console.log('[convertDisplayResultsToSections] Output sections keys:', Object.keys(sections));

    return sections;
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

  /**
   * 获取所有可用的 skills 列表
   */
  async listSkills(): Promise<SkillListItemV2[]> {
    await this.ensureInitialized();

    const skills = skillRegistryV2.getAllSkills();

    return skills.map((skill: SkillDefinitionV2) => {
      const triggers = skill.triggers;
      let keywords: string[] = [];

      if (triggers?.keywords) {
        if (Array.isArray(triggers.keywords)) {
          keywords = triggers.keywords;
        } else {
          keywords = [...(triggers.keywords.zh || []), ...(triggers.keywords.en || [])];
        }
      }

      return {
        id: skill.name,
        name: skill.name,
        displayName: skill.meta?.display_name || skill.name,
        description: skill.meta?.description || '',
        type: skill.type,
        keywords,
        tags: skill.meta?.tags,
      };
    });
  }

  /**
   * 获取指定 skill 的详细信息
   */
  async getSkillDetail(skillId: string): Promise<SkillDefinitionV2 | null> {
    await this.ensureInitialized();
    return skillRegistryV2.getSkill(skillId) || null;
  }

  /**
   * Adapt skill result to layered format
   * This method converts LayeredResult to AdaptedResult for API responses
   */
  async adaptSkillResult(result: LayeredResult): Promise<AdaptedResult> {
    // 处理新的分层格式
    return {
      format: 'layered',
      layers: result.layers,
      defaultExpanded: result.defaultExpanded,
      metadata: result.metadata
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let adapterInstanceV2: SkillAnalysisAdapterV2 | null = null;

export function getSkillAnalysisAdapterV2(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapterV2 {
  if (!adapterInstanceV2) {
    adapterInstanceV2 = new SkillAnalysisAdapterV2(traceProcessor, eventHandler);
  }
  return adapterInstanceV2;
}

export function createSkillAnalysisAdapterV2(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapterV2 {
  return new SkillAnalysisAdapterV2(traceProcessor, eventHandler);
}
