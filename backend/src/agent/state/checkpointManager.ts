// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Checkpoint Manager
 *
 * 检查点管理器，负责：
 * 1. 创建和保存检查点
 * 2. 恢复检查点
 * 3. 清理过期检查点
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Checkpoint,
  StageResult,
  Finding,
  AgentPhase,
  SerializedAgentState,
  Intent,
  AnalysisPlan,
  ExpertResult,
} from '../types';

// 默认检查点目录
const defaultCheckpointDir = () => path.join(process.cwd(), 'agent-checkpoints');

// 检查点保留时间（默认 24 小时）
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CheckpointManagerConfig {
  checkpointDir?: string;
  retentionMs?: number;
  maxCheckpointsPerSession?: number;
}

/**
 * 检查点管理器实现
 */
export class CheckpointManager {
  private config: Required<CheckpointManagerConfig>;
  private checkpointDir: string;

  constructor(config: CheckpointManagerConfig = {}) {
    this.config = {
      checkpointDir: config.checkpointDir || defaultCheckpointDir(),
      retentionMs: config.retentionMs || DEFAULT_RETENTION_MS,
      maxCheckpointsPerSession: config.maxCheckpointsPerSession || 10,
    };
    this.checkpointDir = this.config.checkpointDir;
    this.ensureDirectory();
  }

  // ==========================================================================
  // 检查点创建
  // ==========================================================================

  /**
   * 创建检查点
   */
  async createCheckpoint(
    sessionId: string,
    stageId: string,
    phase: AgentPhase,
    stageResults: StageResult[],
    findings: Finding[],
    additionalState?: Partial<SerializedAgentState>
  ): Promise<Checkpoint> {
    const checkpointId = this.generateCheckpointId(sessionId, stageId);

    const checkpoint: Checkpoint = {
      id: checkpointId,
      stageId,
      timestamp: Date.now(),
      phase,
      agentState: {
        query: additionalState?.query || '',
        traceId: additionalState?.traceId || '',
        intent: additionalState?.intent,
        plan: additionalState?.plan,
        expertResults: additionalState?.expertResults || [],
        iterationCount: additionalState?.iterationCount || 0,
        metadata: additionalState?.metadata || {},
      },
      stageResults,
      findings,
      canResume: true,
    };

    // 保存到磁盘
    await this.saveCheckpoint(sessionId, checkpoint);

    // 清理旧检查点
    await this.cleanupOldCheckpoints(sessionId);

    return checkpoint;
  }

  /**
   * 保存检查点到磁盘
   */
  private async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    this.ensureDirectory(sessionDir);

    const filePath = path.join(sessionDir, `${checkpoint.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  /**
   * 生成检查点 ID
   */
  private generateCheckpointId(sessionId: string, stageId: string): string {
    return `${sessionId}_${stageId}_${Date.now()}`;
  }

  // ==========================================================================
  // 检查点恢复
  // ==========================================================================

  /**
   * 加载检查点
   */
  async loadCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint | null> {
    const sessionDir = this.getSessionDir(sessionId);
    const filePath = path.join(sessionDir, `${checkpointId}.json`);

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as Checkpoint;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 获取会话的最新检查点
   */
  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const checkpoints = await this.listCheckpoints(sessionId);

    if (checkpoints.length === 0) {
      return null;
    }

    // 按时间戳排序，返回最新的
    checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    return checkpoints[0];
  }

  /**
   * 列出会话的所有检查点
   */
  async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const sessionDir = this.getSessionDir(sessionId);

    try {
      const files = await fs.promises.readdir(sessionDir);
      const checkpoints: Checkpoint[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.promises.readFile(
            path.join(sessionDir, file),
            'utf-8'
          );
          checkpoints.push(JSON.parse(content));
        }
      }

      return checkpoints;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * 获取检查点对应的阶段结果
   */
  async getStageResults(sessionId: string, checkpointId: string): Promise<StageResult[]> {
    const checkpoint = await this.loadCheckpoint(sessionId, checkpointId);
    return checkpoint?.stageResults || [];
  }

  // ==========================================================================
  // 检查点清理
  // ==========================================================================

  /**
   * 清理旧检查点（保留最新的 N 个）
   */
  private async cleanupOldCheckpoints(sessionId: string): Promise<void> {
    const checkpoints = await this.listCheckpoints(sessionId);

    if (checkpoints.length <= this.config.maxCheckpointsPerSession) {
      return;
    }

    // 按时间戳排序
    checkpoints.sort((a, b) => b.timestamp - a.timestamp);

    // 删除超过限制的检查点
    const toDelete = checkpoints.slice(this.config.maxCheckpointsPerSession);
    for (const checkpoint of toDelete) {
      await this.deleteCheckpoint(sessionId, checkpoint.id);
    }
  }

  /**
   * 删除检查点
   */
  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    const filePath = path.join(sessionDir, `${checkpointId}.json`);

    try {
      await fs.promises.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 清理会话的所有检查点
   */
  async clearSession(sessionId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);

    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 清理过期检查点
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let deletedCount = 0;

    try {
      const sessions = await fs.promises.readdir(this.checkpointDir);

      for (const sessionId of sessions) {
        const checkpoints = await this.listCheckpoints(sessionId);

        for (const checkpoint of checkpoints) {
          if (now - checkpoint.timestamp > this.config.retentionMs) {
            await this.deleteCheckpoint(sessionId, checkpoint.id);
            deletedCount++;
          }
        }

        // 如果会话目录为空，删除它
        const remaining = await this.listCheckpoints(sessionId);
        if (remaining.length === 0) {
          await this.clearSession(sessionId);
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return deletedCount;
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  /**
   * 获取会话目录路径
   */
  private getSessionDir(sessionId: string): string {
    return path.join(this.checkpointDir, sessionId);
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(dir?: string): void {
    const targetDir = dir || this.checkpointDir;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  }

  /**
   * 检查会话是否有可恢复的检查点
   */
  async canResume(sessionId: string): Promise<boolean> {
    const latest = await this.getLatestCheckpoint(sessionId);
    return latest !== null && latest.canResume;
  }

  /**
   * 获取可恢复的会话列表
   */
  async listRecoverableSessions(): Promise<string[]> {
    const sessions: string[] = [];

    try {
      const dirs = await fs.promises.readdir(this.checkpointDir);

      for (const dir of dirs) {
        const canResumeSession = await this.canResume(dir);
        if (canResumeSession) {
          sessions.push(dir);
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return sessions;
  }

  /**
   * 获取检查点统计信息
   */
  async getStats(): Promise<{
    totalSessions: number;
    totalCheckpoints: number;
    oldestCheckpoint: number | null;
    newestCheckpoint: number | null;
  }> {
    let totalCheckpoints = 0;
    let oldestCheckpoint: number | null = null;
    let newestCheckpoint: number | null = null;
    let totalSessions = 0;

    try {
      const sessions = await fs.promises.readdir(this.checkpointDir);
      totalSessions = sessions.length;

      for (const sessionId of sessions) {
        const checkpoints = await this.listCheckpoints(sessionId);
        totalCheckpoints += checkpoints.length;

        for (const checkpoint of checkpoints) {
          if (oldestCheckpoint === null || checkpoint.timestamp < oldestCheckpoint) {
            oldestCheckpoint = checkpoint.timestamp;
          }
          if (newestCheckpoint === null || checkpoint.timestamp > newestCheckpoint) {
            newestCheckpoint = checkpoint.timestamp;
          }
        }
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return {
      totalSessions,
      totalCheckpoints,
      oldestCheckpoint,
      newestCheckpoint,
    };
  }
}

export default CheckpointManager;