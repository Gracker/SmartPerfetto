import {
  AgentTask,
  createTaskId,
} from '../../../types/agentProtocol';
import {
  StageDefinition,
  StageTaskTemplate,
  FocusInterval,
  DirectSkillTask,
} from '../../../strategies';
import {
  ExecutionContext,
  ProgressEmitter,
} from '../../orchestratorTypes';

export interface StageTaskSplitResult {
  agentTasks: AgentTask[];
  directSkillTasks: DirectSkillTask[];
}

export class StrategyStageTaskBuilder {
  buildStageTasksSplit(
    stage: StageDefinition,
    focusIntervals: FocusInterval[],
    ctx: ExecutionContext,
    emitter: ProgressEmitter
  ): StageTaskSplitResult {
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

    const agentTasks = this.buildStageTasksFromTemplates(
      agentTemplates,
      focusIntervals,
      ctx
    );

    const directSkillTasks: DirectSkillTask[] = [];
    for (const template of directTemplates) {
      const filteredIntervals = template.scope === 'per_interval'
        ? this.filterIntervalsForTemplate(template, focusIntervals, emitter)
        : [];

      const scopes = template.scope === 'global'
        ? [{ interval: { id: 0, processName: '', startTs: '0', endTs: '0', priority: 0 } as FocusInterval, scopeLabel: '全局' }]
        : filteredIntervals.map(interval => ({
            interval,
            scopeLabel: interval.label || `区间${interval.id}`,
          }));

      for (const { interval, scopeLabel } of scopes) {
        directSkillTasks.push({ template, interval, scopeLabel });
      }
    }

    return { agentTasks, directSkillTasks };
  }

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
    const historyContext = ctx.sessionContext?.generatePromptContext(700)?.trim() || '';

    const tasks: AgentTask[] = [];

    for (const template of templates) {
      const filteredIntervals = template.scope === 'per_interval'
        ? this.filterIntervalsForTemplate(template, focusIntervals)
        : [];

      const scopes = template.scope === 'global'
        ? [{ scopeLabel: '全局' as string }]
        : filteredIntervals.map(interval => ({
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
          timeout: template.timeoutMs ?? ctx.options.taskTimeoutMs ?? ctx.config.taskTimeoutMs,
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
              adb: ctx.options.adb,
              adbContext: ctx.options.adbContext,
              scopeLabel: scope.scopeLabel,
              ...(historyContext ? { historyContext } : {}),
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

  private filterIntervalsForTemplate(
    template: StageTaskTemplate,
    intervals: FocusInterval[],
    emitter?: ProgressEmitter
  ): FocusInterval[] {
    if (typeof template.intervalFilter !== 'function') {
      return intervals;
    }

    const filtered: FocusInterval[] = [];
    for (const interval of intervals) {
      try {
        if (template.intervalFilter(interval)) {
          filtered.push(interval);
        }
      } catch (error: any) {
        if (emitter) {
          emitter.log(
            `[StrategyExecutor] intervalFilter failed for template ${template.directSkillId || template.agentId}: ${error?.message || error}`
          );
        }
      }
    }
    return filtered;
  }
}
