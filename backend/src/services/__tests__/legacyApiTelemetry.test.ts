// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Request } from 'express';
import {
  getLegacyApiUsageSnapshot,
  recordLegacyApiUsage,
  resetLegacyApiUsageTelemetryForTests,
} from '../legacyApiTelemetry';

type MockRequestInput = {
  method?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
  ip?: string;
  userId?: string;
};

function createMockRequest(input: MockRequestInput = {}): Request {
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (value) {
      headers.set(key.toLowerCase(), value);
    }
  }

  return {
    method: input.method ?? 'GET',
    originalUrl: input.path ?? '/api/agent/sessions',
    url: input.path ?? '/api/agent/sessions',
    ip: input.ip ?? '127.0.0.1',
    header: (name: string) => headers.get(name.toLowerCase()),
    user: input.userId ? { id: input.userId } : undefined,
  } as unknown as Request;
}

describe('legacyApiTelemetry', () => {
  beforeEach(() => {
    resetLegacyApiUsageTelemetryForTests();
  });

  it('tracks authenticated user id as auth-subject', () => {
    recordLegacyApiUsage(createMockRequest({ userId: 'dev-user-123' }));

    const snapshot = getLegacyApiUsageSnapshot();
    expect(snapshot.totalLegacyRequests).toBe(1);
    expect(snapshot.trackedAuthSubjectCount).toBe(1);
    expect(snapshot.topAuthSubjects[0]?.authSubject).toBe('user:dev-user-123');
  });

  it('hashes bearer token into auth-subject label', () => {
    recordLegacyApiUsage(
      createMockRequest({
        headers: { authorization: 'Bearer super-secret-token' },
      })
    );

    const snapshot = getLegacyApiUsageSnapshot();
    const subject = snapshot.topAuthSubjects[0]?.authSubject ?? '';
    expect(subject.startsWith('bearer:')).toBe(true);
    expect(subject).not.toContain('super-secret-token');
  });

  it('hashes x-api-key into auth-subject label', () => {
    recordLegacyApiUsage(
      createMockRequest({
        headers: { 'x-api-key': 'my-dev-api-key' },
      })
    );

    const snapshot = getLegacyApiUsageSnapshot();
    const subject = snapshot.topAuthSubjects[0]?.authSubject ?? '';
    expect(subject.startsWith('api-key:')).toBe(true);
    expect(subject).not.toContain('my-dev-api-key');
  });

  it('caps the tracked path table while still counting every request', () => {
    for (let i = 0; i < 510; i += 1) {
      recordLegacyApiUsage(createMockRequest({ path: `/api/perfetto-sql/random-${i}` }));
    }
    recordLegacyApiUsage(createMockRequest({ path: '/api/perfetto-sql/random-0' }));

    const snapshot = getLegacyApiUsageSnapshot();
    expect(snapshot.totalLegacyRequests).toBe(511);
    expect(snapshot.trackedPathCount).toBe(500);
    expect(snapshot.topPaths[0]).toMatchObject({ key: 'GET /api/perfetto-sql/random-0', count: 2 });
  });
});
