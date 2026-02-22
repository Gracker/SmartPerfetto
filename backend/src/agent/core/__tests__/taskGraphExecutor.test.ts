import { describe, it, expect, jest } from '@jest/globals';
import { executeTaskGraph } from '../taskGraphExecutor';
import type { AgentTask, AgentResponse } from '../../types/agentProtocol';
import type { ProgressEmitter } from '../orchestratorTypes';

function createEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function createTask(id: string, deps: string[] = []): AgentTask {
  return {
    id,
    description: id,
    targetAgentId: 'frame_agent',
    priority: 1,
    context: { query: 'q' },
    dependencies: deps,
    createdAt: Date.now(),
  };
}

function toResponse(task: AgentTask): AgentResponse {
  return {
    agentId: task.targetAgentId,
    taskId: task.id,
    success: true,
    findings: [],
    confidence: 0.8,
    executionTimeMs: 10,
  };
}

describe('taskGraphExecutor', () => {
  it('dispatches tasks in dependency order', async () => {
    const tasks = [createTask('task-a'), createTask('task-b', ['task-a'])];
    const batches: string[][] = [];
    const messageBus = {
      dispatchTasksParallel: jest.fn(async (batch: AgentTask[]) => {
        batches.push(batch.map(t => t.id));
        return batch.map(toResponse);
      }),
    };
    const emitter = createEmitter();

    const responses = await executeTaskGraph(tasks, messageBus as any, emitter);

    expect(responses.map(r => r.taskId)).toEqual(['task-a', 'task-b']);
    expect(batches).toEqual([['task-a'], ['task-b']]);
  });

  it('falls back to dispatching remaining tasks when dependency graph stalls', async () => {
    const stalledTask = createTask('task-stalled', ['missing-dependency']);
    const messageBus = {
      dispatchTasksParallel: jest.fn(async (batch: AgentTask[]) => batch.map(toResponse)),
    };
    const emitter = createEmitter();

    const responses = await executeTaskGraph([stalledTask], messageBus as any, emitter);

    expect(responses).toHaveLength(1);
    expect(responses[0].taskId).toBe('task-stalled');
    expect((emitter.emitUpdate as jest.Mock).mock.calls.some(
      ([type, payload]) => type === 'progress' && (payload as any)?.phase === 'task_graph_stalled'
    )).toBe(true);
  });
});
