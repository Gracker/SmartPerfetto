// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';

export type AssistantSessionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'quota_exceeded';

export interface ManagedAssistantSession {
  sessionId: string;
  status: AssistantSessionStatus;
  createdAt: number;
  lastActivityAt: number;
  sseClients: express.Response[];
  error?: string;
}

export interface SessionCleanupOptions<T extends ManagedAssistantSession> {
  terminalMaxIdleMs: number;
  nonTerminalMaxIdleMs: number;
  now?: number;
  shouldCleanup?: (
    sessionId: string,
    session: T,
    context: {
      now: number;
      idleMs: number;
      isTerminal: boolean;
      isAbandonedNonTerminal: boolean;
    },
  ) => boolean;
  onCleanup?: (sessionId: string, session: T) => void;
}

/**
 * Thin application service for assistant session lifecycle and in-memory state.
 * Routes/controllers should avoid direct Map manipulation.
 */
export class AssistantApplicationService<T extends ManagedAssistantSession> {
  private readonly sessions = new Map<string, T>();

  getSession(sessionId: string): T | undefined {
    return this.sessions.get(sessionId);
  }

  setSession(sessionId: string, session: T): void {
    this.sessions.set(sessionId, session);
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  entries(): IterableIterator<[string, T]> {
    return this.sessions.entries();
  }

  touchSession(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastActivityAt = Date.now();
    return session;
  }

  addSseClient(sessionId: string, client: express.Response): T | undefined {
    const session = this.touchSession(sessionId);
    if (!session) return undefined;
    session.sseClients.push(client);
    return session;
  }

  removeSseClient(sessionId: string, client: express.Response): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const idx = session.sseClients.indexOf(client);
    if (idx !== -1) {
      session.sseClients.splice(idx, 1);
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  markSessionFailed(sessionId: string, errorMessage: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'failed';
    session.error = errorMessage;
    session.lastActivityAt = Date.now();
    return session;
  }

  cleanupIdleSessions(options: SessionCleanupOptions<T>): string[] {
    const now = options.now ?? Date.now();
    const removed: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const idle = now - (session.lastActivityAt || session.createdAt);
      const isTerminal =
        session.status === 'completed' ||
        session.status === 'failed' ||
        session.status === 'cancelled' ||
        session.status === 'quota_exceeded';
      const isAbandonedNonTerminal =
        (session.status === 'pending' ||
          session.status === 'running' ||
          session.status === 'awaiting_user') &&
        session.sseClients.length === 0;

      if (
        (isTerminal && idle > options.terminalMaxIdleMs) ||
        (isAbandonedNonTerminal && idle > options.nonTerminalMaxIdleMs)
      ) {
        if (options.shouldCleanup?.(sessionId, session, {
          now,
          idleMs: idle,
          isTerminal,
          isAbandonedNonTerminal,
        }) === false) {
          continue;
        }
        options.onCleanup?.(sessionId, session);
        this.sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }

    return removed;
  }
}
