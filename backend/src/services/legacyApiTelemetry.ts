import type { Request } from 'express';
import crypto from 'crypto';

type PathCounters = {
  count: number;
  lastSeenAt: number;
  methods: Map<string, number>;
};

type CallerCounters = {
  count: number;
  lastSeenAt: number;
  lastPath: string;
};

type AuthSubjectCounters = {
  count: number;
  lastSeenAt: number;
  lastPath: string;
};

const MAX_CALLERS = 200;
const MAX_AUTH_SUBJECTS = 500;
const pathStats = new Map<string, PathCounters>();
const callerStats = new Map<string, CallerCounters>();
const authSubjectStats = new Map<string, AuthSubjectCounters>();
let totalLegacyRequests = 0;

function sanitizeLabel(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/\s+/g, ' ').slice(0, 180);
}

function getRequestPath(req: Request): string {
  const original = String(req.originalUrl || req.url || '');
  const noQuery = original.split('?')[0] || '/';
  return noQuery;
}

function getCallerLabel(req: Request): string {
  const origin = sanitizeLabel(req.header('origin'), 'no-origin');
  const ua = sanitizeLabel(req.header('user-agent'), 'unknown-ua');
  return `${origin} | ${ua}`;
}

type MaybeAuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

function hashCredentialForLabel(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function getHeaderString(req: Request, name: string): string {
  const value = req.header(name);
  return sanitizeLabel(value, '');
}

function deriveAuthSubject(req: Request): string {
  const userId = sanitizeLabel((req as MaybeAuthenticatedRequest).user?.id, '');
  if (userId) return `user:${userId}`;

  const authHeader = getHeaderString(req, 'authorization');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token) {
      return `bearer:${hashCredentialForLabel(token)}`;
    }
  }

  const apiKey = getHeaderString(req, 'x-api-key');
  if (apiKey) {
    return `api-key:${hashCredentialForLabel(apiKey)}`;
  }

  const ip = sanitizeLabel(req.ip, '');
  if (ip) return `ip:${ip}`;

  return 'anonymous';
}

export function recordLegacyApiUsage(req: Request): void {
  totalLegacyRequests += 1;
  const now = Date.now();
  const method = sanitizeLabel(req.method, 'GET').toUpperCase();
  const requestPath = getRequestPath(req);
  const pathKey = `${method} ${requestPath}`;

  const pathCounter = pathStats.get(pathKey) ?? {
    count: 0,
    lastSeenAt: now,
    methods: new Map<string, number>(),
  };
  pathCounter.count += 1;
  pathCounter.lastSeenAt = now;
  pathCounter.methods.set(method, (pathCounter.methods.get(method) ?? 0) + 1);
  pathStats.set(pathKey, pathCounter);

  const callerKey = getCallerLabel(req);
  const callerCounter = callerStats.get(callerKey);
  if (callerCounter) {
    callerCounter.count += 1;
    callerCounter.lastSeenAt = now;
    callerCounter.lastPath = requestPath;
    return;
  }

  if (callerStats.size >= MAX_CALLERS) {
    // Continue updating auth-subject even after caller cardinality cap is reached.
  } else {
    callerStats.set(callerKey, {
      count: 1,
      lastSeenAt: now,
      lastPath: requestPath,
    });
  }

  const authSubject = deriveAuthSubject(req);
  const authCounter = authSubjectStats.get(authSubject);
  if (authCounter) {
    authCounter.count += 1;
    authCounter.lastSeenAt = now;
    authCounter.lastPath = requestPath;
    return;
  }

  if (authSubjectStats.size >= MAX_AUTH_SUBJECTS) {
    return;
  }

  authSubjectStats.set(authSubject, {
    count: 1,
    lastSeenAt: now,
    lastPath: requestPath,
  });
}

export function getLegacyApiUsageSnapshot(limit = 20): {
  totalLegacyRequests: number;
  trackedPathCount: number;
  trackedCallerCount: number;
  trackedAuthSubjectCount: number;
  topPaths: Array<{
    key: string;
    count: number;
    methods: Record<string, number>;
    lastSeenAt: string;
  }>;
  topCallers: Array<{
    caller: string;
    count: number;
    lastPath: string;
    lastSeenAt: string;
  }>;
  topAuthSubjects: Array<{
    authSubject: string;
    count: number;
    lastPath: string;
    lastSeenAt: string;
  }>;
} {
  const boundedLimit = Math.max(1, Math.min(100, limit));

  const topPaths = Array.from(pathStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, boundedLimit)
    .map(([key, value]) => ({
      key,
      count: value.count,
      methods: Object.fromEntries(value.methods.entries()),
      lastSeenAt: new Date(value.lastSeenAt).toISOString(),
    }));

  const topCallers = Array.from(callerStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, boundedLimit)
    .map(([caller, value]) => ({
      caller,
      count: value.count,
      lastPath: value.lastPath,
      lastSeenAt: new Date(value.lastSeenAt).toISOString(),
    }));

  const topAuthSubjects = Array.from(authSubjectStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, boundedLimit)
    .map(([authSubject, value]) => ({
      authSubject,
      count: value.count,
      lastPath: value.lastPath,
      lastSeenAt: new Date(value.lastSeenAt).toISOString(),
    }));

  return {
    totalLegacyRequests,
    trackedPathCount: pathStats.size,
    trackedCallerCount: callerStats.size,
    trackedAuthSubjectCount: authSubjectStats.size,
    topPaths,
    topCallers,
    topAuthSubjects,
  };
}

export function resetLegacyApiUsageTelemetryForTests(): void {
  totalLegacyRequests = 0;
  pathStats.clear();
  callerStats.clear();
  authSubjectStats.clear();
}
