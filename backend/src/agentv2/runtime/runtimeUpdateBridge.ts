import type { ProgressEmitter } from '../../agent/core/orchestratorTypes';
import type { StreamingUpdate } from '../../agent/types';
import { InterventionController } from '../../agent/core/interventionController';

export class RuntimeUpdateBridge {
  constructor(
    private readonly emitRuntimeUpdate: (update: StreamingUpdate) => void
  ) {}

  emit(update: StreamingUpdate): void {
    this.emitRuntimeUpdate(update);
  }

  createEmitter(): ProgressEmitter {
    return {
      emitUpdate: (type, content) => {
        this.emitRuntimeUpdate({
          type,
          content,
          timestamp: Date.now(),
        } as StreamingUpdate);
      },
      log: (message: string) => {
        this.emitRuntimeUpdate({
          type: 'progress',
          content: {
            phase: 'runtime_planning',
            message,
          },
          timestamp: Date.now(),
        } as StreamingUpdate);
      },
    };
  }

  bindInterventionForwarding(controller: InterventionController): void {
    controller.on('intervention_required', (intervention: any) => {
      this.emitRuntimeUpdate({
        type: 'intervention_required',
        content: {
          interventionId: intervention.id,
          type: intervention.type,
          options: intervention.options.map((option: any) => ({
            id: option.id,
            label: option.label,
            description: option.description,
            action: option.action,
            recommended: option.recommended,
          })),
          context: {
            confidence: intervention.context.confidence,
            elapsedTimeMs: intervention.context.elapsedTimeMs,
            roundsCompleted: intervention.context.roundsCompleted || 0,
            progressSummary: intervention.context.progressSummary || '',
            triggerReason: intervention.context.triggerReason || '',
            findingsCount: intervention.context.currentFindings?.length || 0,
          },
          timeout: intervention.timeout || 60000,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });

    controller.on('intervention_resolved', (data: any) => {
      this.emitRuntimeUpdate({
        type: 'intervention_resolved',
        content: {
          interventionId: data.interventionId,
          action: data.action,
          sessionId: data.sessionId,
          directive: data.directive,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });

    controller.on('intervention_timeout', (data: any) => {
      this.emitRuntimeUpdate({
        type: 'intervention_timeout',
        content: {
          interventionId: data.interventionId,
          sessionId: data.sessionId,
          defaultAction: data.defaultAction,
          timeoutMs: data.timeoutMs,
        },
        timestamp: Date.now(),
      } as StreamingUpdate);
    });
  }
}
