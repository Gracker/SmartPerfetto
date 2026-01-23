/**
 * SmartPerfetto Agent Message Bus
 *
 * Phase 4.1: Inter-agent communication system
 *
 * The message bus enables:
 * 1. Task dispatch from Master to domain agents
 * 2. Response collection from agents
 * 3. Inter-agent queries (e.g., FrameAgent asks CPUAgent for scheduling data)
 * 4. Broadcast messages (hypothesis updates, evidence found, etc.)
 *
 * Message Flow:
 * Master → dispatch task → Agent → execute → response → Master
 *                              ↓
 *                         query other agent
 *                              ↓
 *                         receive answer
 */

import { EventEmitter } from 'events';
import {
  AgentMessage,
  BroadcastMessage,
  AgentTask,
  AgentResponse,
  InterAgentQuestion,
  SharedAgentContext,
  Hypothesis,
  createMessageId,
  createTaskId,
} from '../types/agentProtocol';
import { Finding } from '../types';
import { BaseAgent } from '../agents/base/baseAgent';

// =============================================================================
// Types
// =============================================================================

/**
 * Message handler function type
 */
export type MessageHandler = (message: AgentMessage) => Promise<void>;

/**
 * Query handler function type
 */
export type QueryHandler = (question: InterAgentQuestion) => Promise<any>;

/**
 * Message bus configuration
 */
export interface MessageBusConfig {
  /** Maximum pending messages per agent */
  maxPendingMessages: number;
  /** Message timeout in ms */
  messageTimeoutMs: number;
  /** Enable message logging */
  enableLogging: boolean;
  /** Maximum concurrent task executions */
  maxConcurrentTasks: number;
}

const DEFAULT_CONFIG: MessageBusConfig = {
  maxPendingMessages: 100,
  messageTimeoutMs: 60000,
  enableLogging: true,
  maxConcurrentTasks: 3,
};

/**
 * Pending message entry
 */
interface PendingMessage {
  message: AgentMessage;
  resolve: (response: any) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Simple semaphore for limiting concurrent tasks
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.waitQueue.length > 0 && this.permits > 0) {
      this.permits--;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  reset(permits: number): void {
    this.permits = permits;
    // Clear the wait queue by rejecting or resolving
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }
}

// =============================================================================
// Agent Message Bus Implementation
// =============================================================================

/**
 * Agent Message Bus
 *
 * Central communication hub for all agents in a session.
 * Handles task dispatch, response collection, and inter-agent queries.
 */
export class AgentMessageBus extends EventEmitter {
  private config: MessageBusConfig;
  private agents: Map<string, BaseAgent> = new Map();
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private messageQueue: AgentMessage[] = [];
  private sharedContext: SharedAgentContext | null = null;
  private isProcessing: boolean = false;
  private taskSemaphore: Semaphore;
  private perAgentSemaphore: Map<string, Semaphore> = new Map();

  constructor(config?: Partial<MessageBusConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.taskSemaphore = new Semaphore(this.config.maxConcurrentTasks);
  }

  // ==========================================================================
  // Agent Registration
  // ==========================================================================

  /**
   * Register an agent with the message bus
   */
  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.config.id, agent);
    this.perAgentSemaphore.set(agent.config.id, new Semaphore(1));
    this.log(`Registered agent: ${agent.config.id}`);

    // Listen to agent events
    agent.on('task_completed', (data) => {
      this.emit('agent_response', data);
    });

    agent.on('task_failed', (data) => {
      this.emit('agent_error', data);
    });
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.removeAllListeners();
      this.agents.delete(agentId);
      this.perAgentSemaphore.delete(agentId);
      this.log(`Unregistered agent: ${agentId}`);
    }
  }

  /**
   * Get registered agent
   */
  getAgent(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all registered agents
   */
  getAllAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  // ==========================================================================
  // Shared Context
  // ==========================================================================

  /**
   * Set shared context for all agents
   */
  setSharedContext(context: SharedAgentContext): void {
    this.sharedContext = context;

    // Update context in all agents
    for (const agent of this.agents.values()) {
      agent.setSharedContext(context);
    }
  }

  /**
   * Get shared context
   */
  getSharedContext(): SharedAgentContext | null {
    return this.sharedContext;
  }

  /**
   * Update hypotheses in shared context
   */
  updateHypothesis(hypothesis: Hypothesis): void {
    if (this.sharedContext) {
      this.sharedContext.hypotheses.set(hypothesis.id, hypothesis);
      this.broadcast({
        type: 'hypothesis_proposed',
        payload: hypothesis,
        from: 'message_bus',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Add confirmed finding to shared context
   */
  addConfirmedFinding(finding: Finding): void {
    if (this.sharedContext) {
      this.sharedContext.confirmedFindings.push(finding);
      this.broadcast({
        type: 'evidence_found',
        payload: finding,
        from: 'message_bus',
        timestamp: Date.now(),
      });
    }
  }

  // ==========================================================================
  // Message Sending
  // ==========================================================================

  /**
   * Send a task to an agent
   */
  async dispatchTask(task: AgentTask): Promise<AgentResponse> {
    const agent = this.agents.get(task.targetAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${task.targetAgentId}`);
    }

    // Ensure shared context exists
    if (!this.sharedContext) {
      throw new Error('Shared context not initialized. Call createSharedContext() first.');
    }

    // Wait for semaphore (proper async concurrency limiting)
    await this.taskSemaphore.acquire();
    const agentSemaphore = this.perAgentSemaphore.get(task.targetAgentId) || new Semaphore(1);
    this.perAgentSemaphore.set(task.targetAgentId, agentSemaphore);
    await agentSemaphore.acquire();
    this.log(`Dispatching task ${task.id} to ${task.targetAgentId}`);

    try {
      this.emit('task_dispatched', { taskId: task.id, agentId: task.targetAgentId });

      // Ensure shared context is set on agent
      agent.setSharedContext(this.sharedContext);

      // Execute task
      const response = await agent.executeTask(task, this.sharedContext);

      // Process response
      this.processAgentResponse(response);

      this.emit('task_completed', { taskId: task.id, agentId: task.targetAgentId, response });

      return response;
    } finally {
      agentSemaphore.release();
      this.taskSemaphore.release();
    }
  }

  /**
   * Dispatch multiple tasks in parallel
   */
  async dispatchTasksParallel(tasks: AgentTask[]): Promise<AgentResponse[]> {
    const promises = tasks.map(task => this.dispatchTask(task));
    return Promise.all(promises);
  }

  /**
   * Send a query from one agent to another
   */
  async query(from: string, to: string, question: InterAgentQuestion): Promise<any> {
    const toAgent = this.agents.get(to);
    if (!toAgent) {
      throw new Error(`Target agent not found: ${to}`);
    }

    const message: AgentMessage = {
      id: createMessageId(),
      type: 'question',
      from,
      to,
      payload: question,
      correlationId: createMessageId(),
      priority: question.priority,
      timestamp: Date.now(),
    };

    this.log(`Query from ${from} to ${to}: ${question.question}`);

    // For now, we create a simple task for the query
    const queryTask: AgentTask = {
      id: createTaskId(),
      description: question.question,
      targetAgentId: to,
      priority: question.priority,
      context: {
        query: question.question,
        additionalData: question.context,
      },
      dependencies: [],
      createdAt: Date.now(),
    };

    const response = await this.dispatchTask(queryTask);
    return response;
  }

  /**
   * Broadcast a message to all agents
   */
  broadcast(message: BroadcastMessage): void {
    this.log(`Broadcasting: ${message.type}`);

    const agentMessage: AgentMessage = {
      id: createMessageId(),
      type: 'broadcast',
      from: message.from,
      to: 'all',
      payload: message,
      priority: 5,
      timestamp: message.timestamp,
    };

    // Emit to all listeners
    this.emit('broadcast', message);
    this.emit(`broadcast:${message.type}`, message.payload);
  }

  // ==========================================================================
  // Response Processing
  // ==========================================================================

  /**
   * Process agent response and update shared context
   */
  private processAgentResponse(response: AgentResponse): void {
    if (!this.sharedContext) return;

    // Add findings to shared context
    for (const finding of response.findings) {
      // Check if finding is critical or high-confidence
      // Use optional chaining and nullish coalescing for safety
      const confidence = finding.confidence ?? 0;
      if (finding.severity === 'critical' || confidence >= 0.8) {
        this.addConfirmedFinding(finding);
      }
    }

    // Process hypothesis updates
    if (response.hypothesisUpdates) {
      for (const update of response.hypothesisUpdates) {
        const hypothesis = this.sharedContext.hypotheses.get(update.hypothesisId);
        if (hypothesis) {
          // Update hypothesis based on action
          switch (update.action) {
            case 'support':
              hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.1);
              if (update.evidence) {
                hypothesis.supportingEvidence.push(update.evidence);
              }
              break;
            case 'contradict':
              hypothesis.confidence = Math.max(0, hypothesis.confidence - 0.2);
              if (update.evidence) {
                hypothesis.contradictingEvidence.push(update.evidence);
              }
              break;
            case 'confirm':
              hypothesis.status = 'confirmed';
              hypothesis.confidence = update.newConfidence || 0.9;
              break;
            case 'reject':
              hypothesis.status = 'rejected';
              hypothesis.confidence = 0;
              break;
            case 'update_confidence':
              if (update.newConfidence !== undefined) {
                hypothesis.confidence = update.newConfidence;
              }
              break;
          }
          hypothesis.updatedAt = Date.now();
          this.sharedContext.hypotheses.set(hypothesis.id, hypothesis);
        }
      }
    }

    // Add to investigation path
    this.sharedContext.investigationPath.push({
      stepNumber: this.sharedContext.investigationPath.length + 1,
      agentId: response.agentId,
      action: 'task_completed',
      timestamp: Date.now(),
      result: response.success ? 'success' : 'failed',
      summary: `Found ${response.findings.length} issues`,
    });

    // Process questions for other agents
    if (response.questionsForAgents && response.questionsForAgents.length > 0) {
      for (const question of response.questionsForAgents) {
        // Queue query for later processing
        this.emit('agent_question', question);
      }
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Create a shared context
   */
  createSharedContext(sessionId: string, traceId: string): SharedAgentContext {
    const context: SharedAgentContext = {
      sessionId,
      traceId,
      hypotheses: new Map(),
      confirmedFindings: [],
      investigationPath: [],
    };

    this.setSharedContext(context);
    return context;
  }

  /**
   * Get investigation summary
   */
  getInvestigationSummary(): string {
    if (!this.sharedContext) {
      return 'No investigation in progress';
    }

    const steps = this.sharedContext.investigationPath
      .map(s => `${s.stepNumber}. [${s.agentId}] ${s.action} - ${s.result}`)
      .join('\n');

    const hypotheses = Array.from(this.sharedContext.hypotheses.values())
      .map(h => `- ${h.description} (${h.status}, confidence: ${h.confidence.toFixed(2)})`)
      .join('\n');

    const findings = this.sharedContext.confirmedFindings
      .map(f => `- [${f.severity}] ${f.title}`)
      .join('\n');

    return `## Investigation Path\n${steps}\n\n## Hypotheses\n${hypotheses}\n\n## Confirmed Findings\n${findings}`;
  }

  /**
   * Reset message bus state
   */
  reset(): void {
    // Clear pending messages
    for (const pending of this.pendingMessages.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Message bus reset'));
    }
    this.pendingMessages.clear();

    // Clear queue
    this.messageQueue = [];

    // Clear shared context
    this.sharedContext = null;

    // Reset semaphore
    this.taskSemaphore.reset(this.config.maxConcurrentTasks);
    for (const sem of this.perAgentSemaphore.values()) {
      sem.reset(1);
    }
    this.isProcessing = false;

    this.log('Message bus reset');
  }

  /**
   * Log message (if enabled)
   */
  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[AgentMessageBus] ${message}`);
    }
  }
}

/**
 * Create an agent message bus
 */
export function createAgentMessageBus(config?: Partial<MessageBusConfig>): AgentMessageBus {
  return new AgentMessageBus(config);
}

export default AgentMessageBus;
