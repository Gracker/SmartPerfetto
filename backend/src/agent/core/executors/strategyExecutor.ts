/**
 * Strategy Executor
 *
 * Executes a matched StagedAnalysisStrategy as a deterministic multi-stage pipeline.
 * Owns the stage loop, builds tasks from templates, runs them, extracts intervals,
 * and checks early-stop conditions.
 *
 * Includes:
 * - Phase 2: Error boundaries around extractIntervals/shouldStop with degradation
 * - Phase 3: stage_transition SSE events and skillParams type validation
 */

import { Finding } from '../../types';
import {
  AgentTask,
  AgentResponse,
  createTaskId,
} from '../../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  StageTaskTemplate,
  StrategyExecutionState,
  FocusInterval,
  DirectSkillTask,
  intervalHelpers,
} from '../../strategies';
import { AnalysisExecutor } from './analysisExecutor';
import { DirectSkillExecutor } from './directSkillExecutor';
import {
  AnalysisServices,
  ExecutionContext,
  ExecutorResult,
  ProgressEmitter,
  concludeDecision,
} from '../orchestratorTypes';
import { executeTaskGraph, emitDataEnvelopes } from '../taskGraphExecutor';
import { synthesizeFeedback } from '../feedbackSynthesizer';
import type { DataEnvelope } from '../../../types/dataContract';

export class StrategyExecutor implements AnalysisExecutor {
  constructor(
    private strategy: StagedAnalysisStrategy,
    private services: AnalysisServices
  ) {}

  async execute(ctx: ExecutionContext, emitter: ProgressEmitter): Promise<ExecutorResult> {
    const allFindings: Finding[] = [];
    let stagedConfidence = 0.5;
    let informationGaps: string[] = [];
    let stopReason: string | null = null;
    let rounds = 0;

    // Phase 1 Fix: Use prebuilt intervals from follow-up resolution if available
    // This allows drill-down queries to skip discovery stages
    const prebuiltIntervals = ctx.options.prebuiltIntervals || [];
    const hasPrebuiltContext = prebuiltIntervals.length > 0;

    if (hasPrebuiltContext) {
      emitter.log(`[FollowUp] Using ${prebuiltIntervals.length} pre-built interval(s) from follow-up resolution`);
    }

    const state: StrategyExecutionState = {
      strategyId: this.strategy.id,
      currentStageIndex: 0,
      focusIntervals: prebuiltIntervals,
      confidence: hasPrebuiltContext ? 0.7 : 0.5, // Higher starting confidence for drill-down
    };

    // Deferred L2 frame tables that will be emitted after L4 per-frame analysis
    // so that expandableData is already assembled when the table first renders in the UI.
    const deferredExpandableTables: DataEnvelope[] = [];

    // Determine which stages will actually run (for accurate progress reporting)
    const stagesToRun = this.strategy.stages.filter(stage => {
      if (!hasPrebuiltContext) return true;
      const isDiscoveryStage = !!stage.extractIntervals;
      const allTasksGlobal = stage.tasks.every(t => t.scope === 'global');
      return !(isDiscoveryStage && allTasksGlobal);
    });
    const effectiveTotalStages = stagesToRun.length;

    emitter.log(`Executing strategy: ${this.strategy.name} (${effectiveTotalStages}/${this.strategy.stages.length} stages${hasPrebuiltContext ? ', follow-up mode' : ''})`);

    for (let i = 0; i < this.strategy.stages.length; i++) {
      const stage = this.strategy.stages[i];
      state.currentStageIndex = i;

      // =========================================================================
      // Follow-Up Optimization: Skip discovery stages when we have prebuilt context
      // =========================================================================
      // Discovery stages (with extractIntervals) produce focus intervals.
      // If we already have prebuilt intervals from follow-up resolution,
      // these stages would just regenerate what we already have.
      const isDiscoveryStage = !!stage.extractIntervals;
      const allTasksGlobal = stage.tasks.every(t => t.scope === 'global');

      if (hasPrebuiltContext && isDiscoveryStage && allTasksGlobal) {
        emitter.log(`[FollowUp] Skipping discovery stage "${stage.name}" - already have ${state.focusIntervals.length} pre-built interval(s)`);
        emitter.emitUpdate('stage_transition', {
          stageIndex: i,
          totalStages: this.strategy.stages.length,
          stageName: stage.name,
          intervalCount: state.focusIntervals.length,
          skipped: true,
          skipReason: 'Using pre-built intervals from follow-up',
        });
        continue;
      }

      rounds++;

      // Phase 3: Emit stage_transition event
      emitter.emitUpdate('stage_transition', {
        stageIndex: i,
        totalStages: this.strategy.stages.length,
        stageName: stage.name,
        intervalCount: state.focusIntervals.length,
      });

      // 1. Emit progress with template interpolation
      // Use rounds (actual executed stage count) for consistent numbering
      const progressMessage = stage.progressMessageTemplate
        .replace('{{stageIndex}}', String(rounds))
        .replace('{{totalStages}}', String(effectiveTotalStages));

      emitter.emitUpdate('progress', {
        phase: 'round_start',
        round: rounds,
        maxRounds: effectiveTotalStages,
        message: progressMessage,
      });

      // 2. Build tasks from stage templates (split by execution mode)
      const { agentTasks, directSkillTasks } = this.buildStageTasksSplit(
        stage, state.focusIntervals, ctx, emitter
      );

      if (agentTasks.length === 0 && directSkillTasks.length === 0) {
        stopReason = `No tasks generated for strategy stage: ${stage.name}`;
        break;
      }

      if (agentTasks.length > 0) {
        emitter.emitUpdate('progress', {
          phase: 'tasks_dispatched',
          taskCount: agentTasks.length,
          agents: agentTasks.map(t => t.targetAgentId),
          message: `派发 ${agentTasks.length} 个 Agent 任务`,
        });
      }

      // 3. Execute both agent tasks and direct skill tasks in parallel
      const [agentResponses, directResponses] = await Promise.all([
        agentTasks.length > 0
          ? executeTaskGraph(agentTasks, this.services.messageBus, emitter, this.services.circuitBreaker)
          : Promise.resolve([]),
        directSkillTasks.length > 0
          ? this.executeDirectSkillTasks(directSkillTasks, ctx, emitter)
          : Promise.resolve([]),
      ]);
      const responses = [...agentResponses, ...directResponses];

      // Defer frame tables that need expandableData until after per-frame analysis completes.
      // This avoids rendering a non-expandable table first (which cannot be "patched" later due to frontend dedupe).
      const { responsesForEmit, deferred } = this.deferExpandableFrameTables(stage, responses);
      deferredExpandableTables.push(...deferred);

      // If this stage is a per-frame direct-skill stage, assemble expandableData into deferred tables and emit them.
      // We intentionally suppress emitting per-frame direct skill envelopes as standalone tables (noise).
      if (stage.name === 'frame_analysis' && deferredExpandableTables.length > 0 && directSkillTasks.length > 0) {
        const merged = this.attachExpandableDataToDeferredTables(
          deferredExpandableTables,
          directSkillTasks,
          directResponses
        );
        if (merged.length > 0) {
          emitter.log(`Emitting ${merged.length} merged expandable table(s)`);
          emitter.emitUpdate('data', merged);
        }
        // Clear so we don't re-emit if a future stage exists.
        deferredExpandableTables.length = 0;
        // Still emit any agent envelopes from this stage (rare; typically none).
        if (agentResponses.length > 0) {
          emitDataEnvelopes(agentResponses, emitter);
        }
      } else {
        emitDataEnvelopes(responsesForEmit, emitter);
      }

      const synthesis = await synthesizeFeedback(responses, ctx.sharedContext, this.services.modelRouter, emitter, this.services.messageBus);
      const agentCount = agentResponses.length;
      const directCount = directResponses.length;
      const synthesisMessage = agentCount > 0 && directCount > 0
        ? `综合 ${agentCount} 个 Agent + ${directCount} 个 Skill 结果`
        : directCount > 0
          ? `综合 ${directCount} 个 Skill 执行结果`
          : `综合 ${agentCount} 个 Agent 反馈`;
      emitter.emitUpdate('progress', {
        phase: 'synthesis_complete',
        confirmedFindings: synthesis.confirmedFindings.length,
        updatedHypotheses: synthesis.updatedHypotheses.length,
        message: synthesisMessage,
      });

      informationGaps = synthesis.informationGaps;
      allFindings.push(...synthesis.newFindings);

      if (synthesis.newFindings.length > 0) {
        emitter.emitUpdate('finding', {
          round: rounds,
          findings: synthesis.newFindings,
        });
      }

      // Update confidence from successful responses
      const confidences = responses
        .filter(r => r.success)
        .map(r => r.confidence)
        .filter(c => typeof c === 'number');
      if (confidences.length > 0) {
        const avg = confidences.reduce((s, c) => s + c, 0) / confidences.length;
        stagedConfidence = Math.max(stagedConfidence, avg);
      }
      state.confidence = stagedConfidence;

      // 4. Phase 2: Extract focus intervals with error boundary
      if (stage.extractIntervals) {
        try {
          state.focusIntervals = stage.extractIntervals(responses, intervalHelpers);

          if (state.focusIntervals.length > 0) {
            ctx.sharedContext.focusedTimeRange = {
              start: state.focusIntervals[0].startTs,
              end: state.focusIntervals[0].endTs,
            };
            emitter.emitUpdate('progress', {
              phase: 'progress',
              message: `已定位 ${state.focusIntervals.length} 个分析区间`,
            });
          }
        } catch (error: any) {
          emitter.log(`extractIntervals failed: ${error.message}, continuing with empty intervals`);
          emitter.emitUpdate('degraded', {
            module: 'strategyExecutor.extractIntervals',
            fallback: 'empty intervals, subsequent per_interval stages will be skipped',
            error: error.message,
          });
          state.focusIntervals = [];
        }
      }

      // 5. Phase 2: Check early stop with error boundary
      if (stage.shouldStop) {
        try {
          const stopResult = stage.shouldStop(state.focusIntervals);
          if (stopResult.stop) {
            stopReason = stopResult.reason;
            break;
          }
        } catch (error: any) {
          emitter.log(`shouldStop failed: ${error.message}, continuing`);
          emitter.emitUpdate('degraded', {
            module: 'strategyExecutor.shouldStop',
            fallback: 'continuing to next stage',
            error: error.message,
          });
        }
      }
    }

    // If all stages completed without early stop
    if (!stopReason) {
      stopReason = `Strategy ${this.strategy.name} completed`;
    }

    // If we deferred expandable tables but never reached the stage that binds L4 results,
    // emit them as-is so the user still sees the frame list.
    if (deferredExpandableTables.length > 0) {
      emitter.log(`Emitting ${deferredExpandableTables.length} deferred table(s) without expandableData (no bind stage reached)`);
      emitter.emitUpdate('data', deferredExpandableTables);
    }

    return {
      findings: allFindings,
      lastStrategy: concludeDecision(stagedConfidence, stopReason),
      confidence: stagedConfidence,
      informationGaps,
      rounds,
      stopReason,
    };
  }

  private deferExpandableFrameTables(
    stage: StageDefinition,
    responses: AgentResponse[]
  ): { responsesForEmit: AgentResponse[]; deferred: DataEnvelope[] } {
    // Only defer in the stage that produces the frame list (Stage 1 in scrolling strategy).
    // Keep it strategy-agnostic by checking for the known stepId and list layer.
    if (stage.name !== 'session_overview') {
      return { responsesForEmit: responses, deferred: [] };
    }

    const deferred: DataEnvelope[] = [];

    const responsesForEmit = responses.map((response) => {
      if (!response.toolResults || response.toolResults.length === 0) return response;

      const toolResults = response.toolResults.map((tr) => {
        const envelopes = tr.dataEnvelopes || [];
        if (envelopes.length === 0) return tr;

        const kept: DataEnvelope[] = [];
        for (const env of envelopes) {
          const stepId = env.meta?.stepId;
          const layer = env.display?.layer;
          const format = env.display?.format;

          // get_app_jank_frames is the L2 frame list table that should be expandable.
          // We defer it until per-frame analysis results are available.
          if (stepId === 'get_app_jank_frames' && layer === 'list' && (format === 'table' || !format)) {
            deferred.push(env);
            continue;
          }
          kept.push(env);
        }

        return {
          ...tr,
          dataEnvelopes: kept.length > 0 ? kept : undefined,
        };
      });

      return {
        ...response,
        toolResults,
      };
    });

    return { responsesForEmit, deferred };
  }

  private attachExpandableDataToDeferredTables(
    tables: DataEnvelope[],
    tasks: DirectSkillTask[],
    responses: AgentResponse[]
  ): DataEnvelope[] {
    if (tables.length === 0 || tasks.length === 0 || responses.length === 0) return [];

    // Build per-table lookup: (sessionId, frameId) -> rowIndex
    const tableInfos = tables.map((env) => {
      const payload = env.data as any;
      const columns: string[] = Array.isArray(payload?.columns) ? payload.columns : [];
      const rows: any[][] = Array.isArray(payload?.rows) ? payload.rows : [];

      const colIndex = new Map<string, number>();
      columns.forEach((c, idx) => colIndex.set(c, idx));

      const frameIdIdx = colIndex.get('frame_id');
      const sessionIdIdx = colIndex.get('session_id');
      const startTsIdx = colIndex.get('start_ts');

      const items: Array<Record<string, any>> = rows.map((row) => {
        const obj: Record<string, any> = {};
        columns.forEach((c, idx) => {
          obj[c] = row[idx];
        });
        return obj;
      });

      const keyToRowIndex = new Map<string, number>();
      for (let i = 0; i < items.length; i++) {
        const frameId = frameIdIdx !== undefined ? items[i][columns[frameIdIdx]] : items[i].frame_id;
        const sessionId = sessionIdIdx !== undefined ? items[i][columns[sessionIdIdx]] : items[i].session_id;
        const startTs = startTsIdx !== undefined ? items[i][columns[startTsIdx]] : items[i].start_ts;

        // Prefer strongest key (session+frame), but also store fallbacks to be robust
        // when some tables omit session_id.
        if (sessionId !== undefined && frameId !== undefined) {
          keyToRowIndex.set(`sf:${String(sessionId)}:${String(frameId)}`, i);
        }
        if (frameId !== undefined) {
          keyToRowIndex.set(`f:${String(frameId)}`, i);
        }
        if (startTs !== undefined) {
          keyToRowIndex.set(`ts:${String(startTs)}`, i);
        }
      }

      return {
        env,
        columns,
        rows,
        items,
        keyToRowIndex,
      };
    });

    // Merge all tables into one lookup to route frame results.
    const globalKeyToTable = new Map<string, { tableIdx: number; rowIdx: number }>();
    tableInfos.forEach((ti, tableIdx) => {
      for (const [key, rowIdx] of ti.keyToRowIndex.entries()) {
        if (!globalKeyToTable.has(key)) {
          globalKeyToTable.set(key, { tableIdx, rowIdx });
        }
      }
    });

    // Initialize expandableData arrays per table (fully populated so type contract stays simple).
    const perTableExpandable: Array<any[]> = tableInfos.map((ti) =>
      ti.items.map((item) => ({
        item,
        result: {
          success: false,
          sections: {},
          error: 'No frame analysis result bound',
        },
      }))
    );

    // Bind each per-frame response into the corresponding row.
    const count = Math.min(tasks.length, responses.length);
    for (let i = 0; i < count; i++) {
      const interval = tasks[i].interval;
      const sessionId = interval.metadata?.sessionId ?? interval.metadata?.session_id;
      const frameId = interval.metadata?.frameId ?? interval.metadata?.frame_id ?? interval.id;
      const startTs = interval.startTs;

      const candidateKeys = [
        (sessionId !== undefined && frameId !== undefined) ? `sf:${String(sessionId)}:${String(frameId)}` : '',
        (frameId !== undefined) ? `f:${String(frameId)}` : '',
        startTs ? `ts:${String(startTs)}` : '',
      ].filter(Boolean);
      if (candidateKeys.length === 0) continue;

      const location = candidateKeys
        .map((k) => globalKeyToTable.get(k))
        .find((v) => v !== undefined);
      if (!location) continue;

      const resp = responses[i];
      const toolResult = resp.toolResults?.[0];
      const rawResults = (toolResult?.data || {}) as Record<string, any>;

      const sections = this.rawResultsToSections(rawResults, resp.findings || toolResult?.findings);

      perTableExpandable[location.tableIdx][location.rowIdx] = {
        item: tableInfos[location.tableIdx].items[location.rowIdx],
        result: {
          success: resp.success,
          sections,
          error: toolResult?.error,
        },
      };
    }

    // Attach expandableData to table payloads.
    for (let i = 0; i < tableInfos.length; i++) {
      const payload = tableInfos[i].env.data as any;
      payload.expandableData = perTableExpandable[i];
    }

    return tableInfos.map((ti) => ti.env);
  }

  private rawResultsToSections(
    rawResults: Record<string, any>,
    findings?: Finding[]
  ): Record<string, any> {
    const sections: Record<string, any> = {};

    // Always include diagnostics/findings if present.
    if (findings && findings.length > 0) {
      sections.findings = {
        title: '诊断要点',
        data: findings.map((f) => ({
          severity: f.severity,
          title: f.title,
          description: f.description || '',
          source: f.source || '',
        })),
      };
    }

    for (const [stepId, stepResult] of Object.entries(rawResults || {})) {
      if (!stepResult || typeof stepResult !== 'object') continue;

      const title = (stepResult.display && stepResult.display.title) ? String(stepResult.display.title) : stepId;
      const data = (stepResult as any).data;

      // Common table-like shape: {columns, rows}
      if (data && typeof data === 'object' && Array.isArray((data as any).columns) && Array.isArray((data as any).rows)) {
        const cols: string[] = (data as any).columns;
        const rows: any[][] = (data as any).rows;
        const objects = rows.map((row) => {
          const obj: Record<string, any> = {};
          cols.forEach((c, idx) => {
            obj[c] = row[idx];
          });
          return obj;
        });
        if (objects.length > 0) {
          sections[stepId] = { title, data: objects };
        }
        continue;
      }

      // Already an array of objects.
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
        sections[stepId] = { title, data };
        continue;
      }

      // Fallback: wrap scalar/object as single-row table.
      if (data !== undefined && data !== null) {
        sections[stepId] = {
          title,
          data: [
            typeof data === 'object' ? data : { value: data },
          ],
        };
      }
    }

    return sections;
  }

  /**
   * Phase 3: Validate skillParams types against optional schema in template.
   */
  private validateSkillParams(template: StageTaskTemplate, emitter: ProgressEmitter): void {
    const schema = (template as any).skillParamsSchema as Record<string, string> | undefined;
    if (!schema || !template.skillParams) return;

    for (const [key, expectedType] of Object.entries(schema)) {
      const value = template.skillParams[key];
      if (value === undefined) continue;
      const actualType = typeof value;
      if (actualType !== expectedType) {
        emitter.log(`skillParam "${key}" type mismatch: expected ${expectedType}, got ${actualType} (value: ${value})`);
      }
    }
  }

  /**
   * Split stage templates into agent tasks and direct skill tasks.
   * Templates with executionMode: 'direct_skill' produce DirectSkillTask[],
   * all others produce AgentTask[] via existing buildStageTasks logic.
   */
  private buildStageTasksSplit(
    stage: StageDefinition,
    focusIntervals: FocusInterval[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): { agentTasks: AgentTask[]; directSkillTasks: DirectSkillTask[] } {
    const agentTemplates: StageTaskTemplate[] = [];
    const directTemplates: StageTaskTemplate[] = [];

    for (const template of stage.tasks) {
      this.validateSkillParams(template, emitter);
      if (template.executionMode === 'direct_skill') {
        directTemplates.push(template);
      } else {
        agentTemplates.push(template);
      }
    }

    // Build agent tasks from agent templates (existing logic)
    const agentTasks = this.buildStageTasksFromTemplates(
      agentTemplates, focusIntervals, ctx
    );

    // Build direct skill tasks from direct templates
    const directSkillTasks: DirectSkillTask[] = [];
    for (const template of directTemplates) {
      const scopes = template.scope === 'global'
        ? [{ interval: { id: 0, processName: '', startTs: '0', endTs: '0', priority: 0 } as FocusInterval, scopeLabel: '全局' }]
        : focusIntervals.map(interval => ({
            interval,
            scopeLabel: interval.label || `区间${interval.id}`,
          }));

      for (const { interval, scopeLabel } of scopes) {
        directSkillTasks.push({ template, interval, scopeLabel });
      }
    }

    return { agentTasks, directSkillTasks };
  }

  /**
   * Build AgentTask[] from a subset of templates (factored out from buildStageTasks).
   */
  private buildStageTasksFromTemplates(
    templates: StageTaskTemplate[],
    focusIntervals: FocusInterval[],
    ctx: ExecutionContext
  ): AgentTask[] {
    if (templates.length === 0) return [];

    const hypothesis = Array.from(ctx.sharedContext.hypotheses.values())
      .find(h => h.status === 'proposed' || h.status === 'investigating');
    const relevantFindings = ctx.sharedContext.confirmedFindings.slice(-5);
    const intentSummary = { primaryGoal: ctx.intent.primaryGoal, aspects: ctx.intent.aspects };

    const tasks: AgentTask[] = [];

    for (const template of templates) {
      const scopes = template.scope === 'global'
        ? [{ scopeLabel: '全局' as string }]
        : focusIntervals.map(interval => ({
            scopeLabel: interval.label || `区间${interval.id}`,
            timeRange: { start: interval.startTs, end: interval.endTs },
            packageName: interval.processName,
          }));

      for (const scope of scopes) {
        const description = template.descriptionTemplate
          .replace('{{scopeLabel}}', scope.scopeLabel);

        tasks.push({
          id: createTaskId(),
          description,
          targetAgentId: template.agentId,
          priority: template.priority || 5,
          context: {
            query: ctx.query,
            intent: intentSummary,
            hypothesis,
            domain: template.domain,
            ...('timeRange' in scope && { timeRange: scope.timeRange }),
            evidenceNeeded: template.evidenceNeeded || [],
            relevantFindings,
            additionalData: {
              traceProcessorService: ctx.options.traceProcessorService,
              packageName: ('packageName' in scope ? scope.packageName : undefined) || ctx.options.packageName,
              scopeLabel: scope.scopeLabel,
              ...(template.skillParams && { skillParams: template.skillParams }),
              ...(template.focusTools && { focusTools: template.focusTools }),
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });
      }
    }

    return tasks;
  }

  /**
   * Execute direct skill tasks via DirectSkillExecutor.
   * Lazily creates the executor from context options.
   */
  private async executeDirectSkillTasks(
    tasks: DirectSkillTask[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): Promise<AgentResponse[]> {
    const executor = new DirectSkillExecutor(
      ctx.options.traceProcessorService,
      this.services.modelRouter,  // Used as aiService for ai_assist steps
      ctx.traceId
    );
    return executor.executeTasks(tasks, emitter);
  }
}
