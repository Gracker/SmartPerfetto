import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { createAgentMessageBus } from '../agentMessageBus';
import type { AgentTask, AgentResponse, SharedAgentContext } from '../../types/agentProtocol';

class MockAgent extends EventEmitter {
  config: { id: string };
  setSharedContext = jest.fn((_context: SharedAgentContext) => {});
  executeTask: any;

  constructor(id: string, handler: (task: AgentTask) => Promise<AgentResponse>) {
    super();
    this.config = { id };
    this.executeTask = jest.fn((task: AgentTask) => handler(task));
  }
}

function createTask(taskId: string, timeout?: number): AgentTask {
  return {
    id: taskId,
    description: `task-${taskId}`,
    targetAgentId: 'frame_agent',
    priority: 1,
    context: { query: 'analyze' },
    dependencies: [],
    timeout,
    createdAt: Date.now(),
  };
}

describe('AgentMessageBus timeout handling', () => {
  it('returns a failed response when a task exceeds explicit timeout', async () => {
    const agent = new MockAgent('frame_agent', async (task) => {
      if (task.id === 'hang') {
        return await new Promise<AgentResponse>(() => {});
      }
      return {
        agentId: 'frame_agent',
        taskId: task.id,
        success: true,
        findings: [],
        confidence: 0.9,
        executionTimeMs: 1,
      };
    });

    const bus = createAgentMessageBus({
      enableLogging: false,
      maxConcurrentTasks: 1,
      messageTimeoutMs: 200,
    });
    bus.registerAgent(agent as any);
    bus.createSharedContext('session-1', 'trace-1');

    const timeoutResponse = await bus.dispatchTask(createTask('hang', 20));
    expect(timeoutResponse.success).toBe(false);
    expect(timeoutResponse.toolResults?.[0]?.error || '').toContain('timed out');

    const followUpResponse = await bus.dispatchTask(createTask('ok', 100));
    expect(followUpResponse.success).toBe(true);
    expect(agent.executeTask).toHaveBeenCalledTimes(2);
  });

  it('falls back to message bus timeout when task.timeout is not set', async () => {
    const agent = new MockAgent(
      'frame_agent',
      async () => await new Promise<AgentResponse>(() => {})
    );

    const bus = createAgentMessageBus({
      enableLogging: false,
      maxConcurrentTasks: 1,
      messageTimeoutMs: 30,
    });
    bus.registerAgent(agent as any);
    bus.createSharedContext('session-2', 'trace-2');

    const response = await bus.dispatchTask(createTask('no-timeout'));
    expect(response.success).toBe(false);
    expect(response.toolResults?.[0]?.error || '').toContain('30ms');
  });
});
