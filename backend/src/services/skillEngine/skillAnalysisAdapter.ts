/**
 * Skill Analysis Adapter
 *
 * Integrates SkillExecutor with the orchestrator.
 * Provides intent detection, skill execution, and result conversion.
 */

import { TraceProcessorService } from '../traceProcessorService';
import { SkillExecutor, createSkillExecutor, LayeredResult } from './skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized, getSkillsDir } from './skillLoader';
import { SkillDefinition, SkillEvent, DisplayLevel, DisplayLayer } from './types';
import { smartSummaryGenerator } from './smartSummaryGenerator';
import { answerGenerator, GeneratedAnswer } from './answerGenerator';
import { SkillEventCollector, createEventCollector, EventSummary, ProgressInfo } from './eventCollector';

// =============================================================================
// Types
// =============================================================================

export interface SkillAnalysisRequest {
  traceId: string;
  skillId?: string;
  question?: string;
  packageName?: string;
  params?: Record<string, any>;  // Custom skill parameters
}

export interface SkillAnalysisResponse {
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

  // Display results
  displayResults?: Array<{
    stepId: string;
    title: string;
    level: DisplayLevel;
    format: string;
    data: any;
    columnDefinitions?: Array<Record<string, any>>;
  }>;
  aiSummary?: string;

  /** 直接回答用户问题的自然语言 */
  directAnswer?: string;
  /** 回答的问题类型 */
  questionType?: string;
  /** 回答置信度 */
  answerConfidence?: 'high' | 'medium' | 'low';

  /** 分层结果（overview/list/session/deep）- 用于交互式分层视图 */
  layeredResult?: LayeredResult;

  /** 执行事件列表（用于前端进度展示） */
  executionEvents?: SkillEvent[];
  /** 事件摘要 */
  eventSummary?: EventSummary;
}

export interface SkillListItem {
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
  defaultExpanded: DisplayLayer[];
  metadata: LayeredResult['metadata'];
}

// =============================================================================
// Skill Analysis Adapter
// =============================================================================

export class SkillAnalysisAdapter {
  private traceProcessor: TraceProcessorService;
  private executor: SkillExecutor;
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
    this.executor = createSkillExecutor(
      traceProcessor,
      undefined,  // AI service 稍后注入
      eventHandler
    );
  }

  /**
   * 设置 AI 服务（用于 ai_decision 和 ai_summary 步骤）
   */
  setAIService(aiService: any): void {
    // SkillExecutor 需要支持 setAIService 方法
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

    await ensureSkillRegistryInitialized();

    // 将所有 skills 注册到 executor
    const skills = skillRegistry.getAllSkills();
    this.executor.registerSkills(skills);

    this.initialized = true;
    console.log(`[SkillAnalysisAdapter] Initialized with ${skills.length} skills`);
  }

  /**
   * 从自然语言问题检测意图
   * 返回匹配的 skill ID 或 null
   */
  detectIntent(question: string): string | null {
    const skill = skillRegistry.findMatchingSkill(question);
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
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%miui%' OR LOWER(name) LIKE '%hyperos%' OR LOWER(name) LIKE '%xiaomi%')
            ) THEN 'xiaomi'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%oppo%' OR LOWER(name) LIKE '%coloros%' OR LOWER(name) LIKE '%oplus%')
            ) THEN 'oppo'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%vivo%' OR LOWER(name) LIKE '%originos%' OR LOWER(name) LIKE '%funtouch%' OR LOWER(name) LIKE '%bbk%')
            ) THEN 'vivo'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%honor%' OR LOWER(name) LIKE '%magicos%' OR LOWER(name) LIKE '%huawei%')
            ) THEN 'honor'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%samsung%' OR LOWER(name) LIKE '%oneui%' OR LOWER(name) LIKE '%sec.%' OR LOWER(name) LIKE '%galaxy%')
            ) THEN 'samsung'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%pixel%' OR LOWER(name) LIKE '%tensor%' OR LOWER(name) LIKE '%google%')
            ) THEN 'pixel'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%qualcomm%' OR LOWER(name) LIKE '%qcom%' OR LOWER(name) LIKE '%snapdragon%' OR LOWER(name) LIKE '%adreno%')
            ) THEN 'qualcomm'
            WHEN EXISTS(
              SELECT 1 FROM slice
              WHERE name IS NOT NULL
                AND (LOWER(name) LIKE '%mediatek%' OR LOWER(name) LIKE '%mtk%' OR LOWER(name) LIKE '%dimensity%' OR LOWER(name) LIKE '%helio%')
            ) THEN 'mtk'
            ELSE 'aosp'
          END as vendor
      `);

      if (result.rows && result.rows.length > 0) {
        const detectedVendor = String(result.rows[0][0] || 'aosp');
        return {
          vendor: detectedVendor,
          confidence: detectedVendor === 'aosp' ? 0.5 : 0.8,
        };
      }
    } catch (error) {
      console.warn('[SkillAnalysisAdapter] Vendor detection failed:', error);
    }

    return { vendor: 'aosp', confidence: 0.5 };
  }

  /**
   * 检测 skill 是否使用分层输出（overview/list/session/deep）
   */
  private hasLayeredOutput(skill: SkillDefinition): boolean {
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
  async analyze(request: SkillAnalysisRequest): Promise<SkillAnalysisResponse> {
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
    const skill = skillRegistry.getSkill(targetSkillId);
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

    // 构建参数 - 合并 request.params 和 packageName
    const params: Record<string, any> = {
      ...request.params,  // 先展开用户提供的参数
    };
    if (packageName) {
      params.package = packageName;  // packageName 会覆盖 params.package (如果有)
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
    console.log(`[SkillAnalysisAdapter] Skill ${targetSkillId} has layered output:`, useLayeredOutput);

    let result: any;
    let layeredResult: LayeredResult | undefined;

    if (useLayeredOutput) {
      // 使用分层输出模式（executeCompositeSkill）
      console.log('[SkillAnalysisAdapter] Using layered output mode for skill', targetSkillId);
      try {
        layeredResult = await (this.executor as any).executeCompositeSkill(
          skill,
          params,
          { traceId, vendor: vendorResult.vendor }
        );
        console.log('[SkillAnalysisAdapter] executeCompositeSkill completed. layeredResult:', JSON.stringify({
          hasLayers: !!layeredResult?.layers,
          layerKeys: layeredResult?.layers ? Object.keys(layeredResult.layers) : [],
          overviewCount: layeredResult?.layers?.overview ? Object.keys(layeredResult.layers.overview).length : 0,
          listCount: layeredResult?.layers?.list ? Object.keys(layeredResult.layers.list).length : 0,
          sessionCount: layeredResult?.layers?.session ? Object.keys(layeredResult.layers.session).length : 0,
          deepSessionCount: layeredResult?.layers?.deep ? Object.keys(layeredResult.layers.deep).length : 0,
          hasMetadata: !!layeredResult?.metadata,
        }, null, 2));

        // 将 LayeredResult 转换为 displayResults 格式
        console.log('[SkillAnalysisAdapter] Calling convertLayeredResultToDisplayResults...');
        const displayResults = this.convertLayeredResultToDisplayResults(layeredResult!);
        console.log('[SkillAnalysisAdapter] convertLayeredResultToDisplayResults completed with', displayResults.length, 'items');

        result = {
          success: true,
          displayResults,
          diagnostics: [],
          executionTimeMs: 0,
        };
      } catch (error) {
        console.error('[SkillAnalysisAdapter] executeCompositeSkill failed:', error);
        throw error;
      }
    } else {
      // 使用传统输出模式（execute）
      console.log('[SkillAnalysisAdapter] Using traditional output mode for skill', targetSkillId);
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
    console.log('[SkillAnalysisAdapter] displayResults count:', result.displayResults.length);
    console.log('[SkillAnalysisAdapter] displayResults:', JSON.stringify(result.displayResults.map((dr: any) => ({
      stepId: dr.stepId,
      title: dr.title,
      hasData: !!dr.data,
      dataKeys: dr.data ? Object.keys(dr.data) : [],
    })), null, 2));

    const sections = this.convertDisplayResultsToSections(result.displayResults);

    console.log('[SkillAnalysisAdapter] sections count:', Object.keys(sections).length);
    console.log('[SkillAnalysisAdapter] sections keys:', Object.keys(sections));
    console.log('[SkillAnalysisAdapter] result.success:', result.success);

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
   * 用于处理分层输出模式（overview/list/session/deep）
   */
  private convertLayeredResultToDisplayResults(layeredResult: LayeredResult): Array<{
    stepId: string;
    title: string;
    level: DisplayLevel;
    format: string;
    data: any;
    columnDefinitions?: Array<Record<string, any>>;
    sql?: string;
  }> {
    console.log('[convertLayeredResultToDisplayResults] Starting conversion. Input:', JSON.stringify({
      hasOverview: !!layeredResult?.layers?.overview,
      hasList: !!layeredResult?.layers?.list,
      hasSession: !!layeredResult?.layers?.session,
      hasDeep: !!layeredResult?.layers?.deep,
    }, null, 2));

    const displayResults: Array<{
      stepId: string;
      title: string;
      level: DisplayLevel;
      format: string;
      data: any;
      columnDefinitions?: Array<Record<string, any>>;
      sql?: string;
    }> = [];

    // 处理 overview 和 list 层（直接是 stepId -> StepResult 的映射）
    for (const layerKey of ['overview', 'list'] as const) {
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

        const normalizedData = this.extractLayerStepData(stepResult as any);
        const columnDefinitions = this.extractColumnDefinitions(stepResult as any);
        const dr = {
          stepId,
          title: stepResult.display?.title || stepId,
          level: stepResult.display?.level || 'detail',
          format: stepResult.display?.format || 'table',
          data: normalizedData,
          columnDefinitions,
        };
        console.log(`[convertLayeredResultToDisplayResults] Adding ${layerKey} item:`, JSON.stringify({
          stepId,
          hasData: !!dr.data,
          dataType: Array.isArray(dr.data) ? 'array' : typeof dr.data,
          dataLength: Array.isArray(dr.data) ? dr.data.length : 'N/A',
          hasColumnDefinitions: Array.isArray(dr.columnDefinitions) && dr.columnDefinitions.length > 0,
        }));
        displayResults.push(dr);
      }
    }

    // 处理 session 层（按 session_id 组织）
    const sessionLayer = layeredResult.layers.session;
    if (sessionLayer) {
      console.log(`[convertLayeredResultToDisplayResults] Processing session layer with ${Object.keys(sessionLayer).length} sessions`);
      for (const [sessionId, sessionSteps] of Object.entries(sessionLayer)) {
        console.log(`[convertLayeredResultToDisplayResults] Processing session ${sessionId} with ${Object.keys(sessionSteps).length} steps`);
        for (const [stepId, stepResult] of Object.entries(sessionSteps)) {
          if (!stepResult.display?.show && stepResult.display?.show !== undefined) continue;
          if (stepResult.display?.level === 'none') continue;

          const normalizedData = this.extractLayerStepData(stepResult as any);
          const columnDefinitions = this.extractColumnDefinitions(stepResult as any);
          displayResults.push({
            stepId: `${sessionId}_${stepId}`,
            title: stepResult.display?.title || `[${sessionId}] ${stepId}`,
            level: stepResult.display?.level || 'detail',
            format: stepResult.display?.format || 'table',
            data: normalizedData,
            columnDefinitions,
          });
        }
      }
    }

    // 处理 deep 层（按 session_id -> frame_id 组织）
    const deepLayer = layeredResult.layers.deep;
    if (deepLayer) {
      console.log(`[convertLayeredResultToDisplayResults] Processing deep layer with ${Object.keys(deepLayer).length} sessions`);
      for (const [sessionId, frames] of Object.entries(deepLayer)) {
        console.log(`[convertLayeredResultToDisplayResults] Processing deep session ${sessionId} with ${Object.keys(frames).length} frames`);
        for (const [frameId, stepResult] of Object.entries(frames)) {
          if (!stepResult.display?.show && stepResult.display?.show !== undefined) continue;
          if (stepResult.display?.level === 'none') continue;

          const normalizedData = this.extractLayerStepData(stepResult as any);
          const columnDefinitions = this.extractColumnDefinitions(stepResult as any);
          const dr = {
            stepId: `${sessionId}_${frameId}`,
            title: stepResult.display?.title || `[${sessionId}] ${frameId}`,
            level: stepResult.display?.level || 'detail',
            format: stepResult.display?.format || 'table',
            data: normalizedData,
            columnDefinitions,
          };
          console.log(`[convertLayeredResultToDisplayResults] Adding deep frame:`, JSON.stringify({
            stepId: dr.stepId,
            title: dr.title,
            hasData: !!dr.data,
            dataType: Array.isArray(dr.data) ? 'array' : typeof dr.data,
            dataLength: Array.isArray(dr.data) ? dr.data.length : 'N/A',
            hasColumnDefinitions: Array.isArray(dr.columnDefinitions) && dr.columnDefinitions.length > 0,
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
      columnDefinitions?: Array<Record<string, any>>;
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
      const data = result.data ?? {};

      console.log(`[convertDisplayResultsToSections] Processing ${result.stepId}:`, JSON.stringify({
        hasData: !!data,
        dataType: typeof data,
        dataIsArray: Array.isArray(data),
        dataHasRows: !!data?.rows,
        dataHasText: !!data?.text,
        dataLength: Array.isArray(data) ? data.length : 'N/A',
        dataSample: Array.isArray(data) && data.length > 0 ? data[0] : data,
      }, null, 2));

      // 处理不同类型的 data 格式
      let sectionData: any;
      let rowCount: number;
      let columns: string[] | undefined;
      const columnDefinitions = Array.isArray(result.columnDefinitions)
        ? result.columnDefinitions
        : undefined;

      // 0. 诊断数据格式 {diagnostics, inputs} - 保持原样
      if (data.diagnostics && Array.isArray(data.diagnostics)) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using diagnostic format`);
        // 保持诊断结构，前端需要这个格式
        sectionData = data;
        rowCount = data.diagnostics.length;
      }
      // 1. 标准 {columns, rows} 格式
      else if (data.rows && Array.isArray(data.rows)) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using {columns, rows} format`);
        sectionData = this.rowsToObjects(data.columns, data.rows);
        rowCount = data.rows.length;
        columns = Array.isArray(data.columns) && data.columns.length > 0
          ? data.columns
          : columnDefinitions?.map((d: any) => d.name).filter((name: any) => typeof name === 'string');
      }
      // 2. 文本格式
      else if (data.text) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using text format`);
        sectionData = [{ text: data.text }];
        rowCount = 1;
      }
      // 3. 对象数组格式（直接来自 SQL 查询）
      else if (Array.isArray(data)) {
        console.log(`[convertDisplayResultsToSections] ${result.stepId}: Using array format, length=${data.length}`);
        sectionData = data;
        rowCount = data.length;
        // 优先使用 display.columns 定义列顺序；否则从首行推导
        if (columnDefinitions && columnDefinitions.length > 0) {
          columns = columnDefinitions
            .map((d: any) => d?.name)
            .filter((name: any) => typeof name === 'string' && name.length > 0);
        } else if (data.length > 0 && typeof data[0] === 'object') {
          columns = Object.keys(data[0]);
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
        columnDefinitions,
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
      if (data.expandableData) {
        section.expandableData = data.expandableData;
        console.log(`[convertDisplayResultsToSections] Step ${result.stepId} has expandableData with ${data.expandableData.length} items`);
      }
      if (data.summary) {
        section.summary = data.summary;
      }

      sections[result.stepId] = section;
    }

    console.log('[convertDisplayResultsToSections] Output sections count:', Object.keys(sections).length);
    console.log('[convertDisplayResultsToSections] Output sections keys:', Object.keys(sections));

    return sections;
  }

  /**
   * 从分层 StepResult 提取可展示数据。
   * 对 skill 引用步骤进行解包，避免把嵌套 SkillExecutionResult 直接透传到展示层。
   */
  private extractLayerStepData(stepResult: any): any {
    if (!stepResult || typeof stepResult !== 'object') {
      return {};
    }

    if (stepResult.stepType !== 'skill') {
      return stepResult.data ?? {};
    }

    const nested = stepResult.data;
    if (!nested || typeof nested !== 'object') {
      return stepResult.data ?? {};
    }

    if (Object.prototype.hasOwnProperty.call(nested, 'data')) {
      return (nested as any).data ?? {};
    }

    const rawResults = (nested as any).rawResults;
    if (rawResults && typeof rawResults === 'object') {
      if ((rawResults as any).root?.data !== undefined) {
        return (rawResults as any).root.data ?? {};
      }
      for (const step of Object.values(rawResults as Record<string, any>)) {
        if (step && typeof step === 'object' && Object.prototype.hasOwnProperty.call(step, 'data')) {
          return (step as any).data ?? {};
        }
      }
    }

    const nestedDisplayResults = Array.isArray((nested as any).displayResults)
      ? (nested as any).displayResults
      : [];
    const firstTabular = nestedDisplayResults.find((dr: any) =>
      dr?.data && typeof dr.data === 'object' && Array.isArray(dr.data.rows)
    );
    if (firstTabular?.data) {
      return firstTabular.data;
    }

    return stepResult.data ?? {};
  }

  /**
   * 从 StepResult.display.columns 中提取列定义（含 type/format/unit/clickAction）。
   */
  private extractColumnDefinitions(stepResult: any): Array<Record<string, any>> | undefined {
    const columns = stepResult?.display?.columns;
    if (!Array.isArray(columns)) {
      return undefined;
    }

    const columnDefinitions = columns
      .map((col: any) => {
        if (typeof col === 'string') {
          return { name: col };
        }
        if (col && typeof col === 'object' && typeof col.name === 'string') {
          return { ...col };
        }
        return null;
      })
      .filter((col: any) => !!col);

    return columnDefinitions.length > 0 ? columnDefinitions : undefined;
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
  async listSkills(): Promise<SkillListItem[]> {
    await this.ensureInitialized();

    const skills = skillRegistry.getAllSkills();

    return skills.map((skill: SkillDefinition) => {
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
  async getSkillDetail(skillId: string): Promise<SkillDefinition | null> {
    await this.ensureInitialized();
    return skillRegistry.getSkill(skillId) || null;
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

let adapterInstance: SkillAnalysisAdapter | null = null;

export function getSkillAnalysisAdapter(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapter {
  if (!adapterInstance) {
    adapterInstance = new SkillAnalysisAdapter(traceProcessor, eventHandler);
  }
  return adapterInstance;
}

export function createSkillAnalysisAdapter(
  traceProcessor: TraceProcessorService,
  eventHandler?: (event: SkillEvent) => void
): SkillAnalysisAdapter {
  return new SkillAnalysisAdapter(traceProcessor, eventHandler);
}
