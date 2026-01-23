/**
 * SmartPerfetto Session Store
 *
 * 会话存储管理器，负责：
 * 1. 管理分析会话的生命周期
 * 2. 存储会话元数据
 * 3. 提供会话查询和恢复功能
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  SessionInfo,
  AgentPhase,
  Intent,
  AnalysisPlan,
} from '../types';

// 默认会话存储目录
const DEFAULT_SESSION_DIR = path.join(process.cwd(), 'agent-sessions');

// 会话保留时间（默认 7 天）
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionStoreConfig {
  sessionDir?: string;
  retentionMs?: number;
  maxActiveSessions?: number;
}

export interface SessionData extends SessionInfo {
  intent?: Intent;
  plan?: AnalysisPlan;
  startTime: number;
  endTime?: number;
  metadata: Record<string, any>;
}

/**
 * 会话存储实现
 */
export class SessionStore extends EventEmitter {
  private config: Required<SessionStoreConfig>;
  private sessionDir: string;
  private activeSessions: Map<string, SessionData>;

  constructor(config: SessionStoreConfig = {}) {
    super();
    this.config = {
      sessionDir: config.sessionDir || DEFAULT_SESSION_DIR,
      retentionMs: config.retentionMs || DEFAULT_RETENTION_MS,
      maxActiveSessions: config.maxActiveSessions || 100,
    };
    this.sessionDir = this.config.sessionDir;
    this.activeSessions = new Map();
    this.ensureDirectory();
  }

  // ==========================================================================
  // 会话创建
  // ==========================================================================

  /**
   * 创建新会话
   */
  async createSession(traceId: string, query: string): Promise<SessionData> {
    const sessionId = this.generateSessionId();
    const now = Date.now();

    const session: SessionData = {
      sessionId,
      traceId,
      query,
      phase: AgentPhase.IDLE,
      createdAt: now,
      updatedAt: now,
      startTime: now,
      canResume: false,
      metadata: {},
    };

    // 添加到活动会话
    this.activeSessions.set(sessionId, session);

    // 持久化
    await this.saveSession(session);

    // 清理过多的活动会话
    await this.cleanupExcessSessions();

    this.emit('sessionCreated', session);
    return session;
  }

  /**
   * 生成会话 ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `session_${timestamp}_${random}`;
  }

  // ==========================================================================
  // 会话更新
  // ==========================================================================

  /**
   * 更新会话状态
   */
  async updatePhase(sessionId: string, phase: AgentPhase): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.phase = phase;
    session.updatedAt = Date.now();
    session.canResume = this.isResumablePhase(phase);

    if (phase === 'completed' || phase === 'failed') {
      session.endTime = Date.now();
    }

    await this.saveSession(session);
    this.emit('sessionUpdated', session);
  }

  /**
   * 更新会话意图
   */
  async updateIntent(sessionId: string, intent: Intent): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.intent = intent;
    session.updatedAt = Date.now();

    await this.saveSession(session);
    this.emit('intentUpdated', { sessionId, intent });
  }

  /**
   * 更新会话计划
   */
  async updatePlan(sessionId: string, plan: AnalysisPlan): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.plan = plan;
    session.updatedAt = Date.now();

    await this.saveSession(session);
    this.emit('planUpdated', { sessionId, plan });
  }

  /**
   * 设置会话错误
   */
  async setError(sessionId: string, error: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.error = error;
    session.phase = AgentPhase.FAILED;
    session.updatedAt = Date.now();
    session.endTime = Date.now();

    await this.saveSession(session);
    this.emit('sessionFailed', { sessionId, error });
  }

  /**
   * 设置检查点 ID
   */
  async setCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.lastCheckpointId = checkpointId;
    session.canResume = true;
    session.updatedAt = Date.now();

    await this.saveSession(session);
    this.emit('checkpointSet', { sessionId, checkpointId });
  }

  /**
   * 更新会话元数据
   */
  async updateMetadata(sessionId: string, metadata: Record<string, any>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.metadata = { ...session.metadata, ...metadata };
    session.updatedAt = Date.now();

    await this.saveSession(session);
  }

  // ==========================================================================
  // 会话查询
  // ==========================================================================

  /**
   * 获取会话
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    // 先从活动会话查找
    if (this.activeSessions.has(sessionId)) {
      return this.activeSessions.get(sessionId)!;
    }

    // 从磁盘加载
    return this.loadSession(sessionId);
  }

  /**
   * 获取会话信息（简化版）
   */
  async getSessionInfo(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    return {
      sessionId: session.sessionId,
      traceId: session.traceId,
      query: session.query,
      phase: session.phase,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      canResume: session.canResume,
      lastCheckpointId: session.lastCheckpointId,
      error: session.error,
    };
  }

  /**
   * 列出所有会话
   */
  async listSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];

    try {
      const files = await fs.promises.readdir(this.sessionDir);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const session = await this.loadSession(file.replace('.json', ''));
          if (session) {
            sessions.push({
              sessionId: session.sessionId,
              traceId: session.traceId,
              query: session.query,
              phase: session.phase,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              canResume: session.canResume,
              lastCheckpointId: session.lastCheckpointId,
              error: session.error,
            });
          }
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    // 按更新时间排序
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  /**
   * 列出可恢复的会话
   */
  async listRecoverableSessions(): Promise<SessionInfo[]> {
    const sessions = await this.listSessions();
    return sessions.filter(s => s.canResume);
  }

  /**
   * 按 trace ID 查找会话
   */
  async findByTraceId(traceId: string): Promise<SessionInfo[]> {
    const sessions = await this.listSessions();
    return sessions.filter(s => s.traceId === traceId);
  }

  /**
   * 按状态查找会话
   */
  async findByPhase(phase: AgentPhase): Promise<SessionInfo[]> {
    const sessions = await this.listSessions();
    return sessions.filter(s => s.phase === phase);
  }

  // ==========================================================================
  // 会话删除
  // ==========================================================================

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    // 从活动会话移除
    this.activeSessions.delete(sessionId);

    // 删除磁盘文件
    const filePath = this.getSessionPath(sessionId);
    try {
      await fs.promises.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    this.emit('sessionDeleted', { sessionId });
  }

  /**
   * 清理过期会话
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    const sessions = await this.listSessions();

    for (const session of sessions) {
      const age = now - session.updatedAt;
      const isExpired = age > this.config.retentionMs;
      const isTerminal = session.phase === 'completed' || session.phase === 'failed';

      // 只清理已结束且过期的会话
      if (isTerminal && isExpired) {
        await this.deleteSession(session.sessionId);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * 清理超过限制的活动会话
   */
  private async cleanupExcessSessions(): Promise<void> {
    if (this.activeSessions.size <= this.config.maxActiveSessions) {
      return;
    }

    // 按更新时间排序
    const sessions = Array.from(this.activeSessions.entries())
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);

    // 删除最旧的会话
    const toRemove = sessions.length - this.config.maxActiveSessions;
    for (let i = 0; i < toRemove; i++) {
      const [sessionId, session] = sessions[i];
      // 只移除已结束的会话
      if (session.phase === 'completed' || session.phase === 'failed') {
        this.activeSessions.delete(sessionId);
      }
    }
  }

  // ==========================================================================
  // 持久化
  // ==========================================================================

  /**
   * 保存会话到磁盘
   */
  private async saveSession(session: SessionData): Promise<void> {
    const filePath = this.getSessionPath(session.sessionId);
    await fs.promises.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');

    // 更新活动会话缓存
    this.activeSessions.set(session.sessionId, session);
  }

  /**
   * 从磁盘加载会话
   */
  private async loadSession(sessionId: string): Promise<SessionData | null> {
    const filePath = this.getSessionPath(sessionId);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const session = JSON.parse(content) as SessionData;

      // 添加到活动会话缓存
      this.activeSessions.set(sessionId, session);

      return session;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 判断阶段是否可恢复
   */
  private isResumablePhase(phase: AgentPhase): boolean {
    return !['idle', 'completed', 'failed'].includes(phase);
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    totalSessions: number;
    activeSessions: number;
    byPhase: Record<AgentPhase, number>;
    resumable: number;
  }> {
    const sessions = await this.listSessions();

    const byPhase: Record<AgentPhase, number> = {
      idle: 0,
      planning: 0,
      executing: 0,
      evaluating: 0,
      refining: 0,
      awaiting_user: 0,
      completed: 0,
      failed: 0,
    };

    let resumable = 0;

    for (const session of sessions) {
      byPhase[session.phase]++;
      if (session.canResume) {
        resumable++;
      }
    }

    return {
      totalSessions: sessions.length,
      activeSessions: this.activeSessions.size,
      byPhase,
      resumable,
    };
  }

  /**
   * 关闭存储（持久化所有活动会话）
   */
  async close(): Promise<void> {
    for (const session of this.activeSessions.values()) {
      await this.saveSession(session);
    }
    this.activeSessions.clear();
    this.emit('closed');
  }
}

export default SessionStore;
