import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ErrorResponse } from '../types';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    subscription: string;
  };
}

const API_KEY_ENV = 'SMARTPERFETTO_API_KEY';
const USAGE_WINDOW_MS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_WINDOW_MS || '', 10) || 24 * 60 * 60 * 1000;
const MAX_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_REQUESTS || '', 10);
const MAX_TRACE_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS || '', 10);

const usageTracker = new Map<string, { resetAt: number; total: number; trace: number }>();

const getProvidedApiKey = (req: Request): string | undefined => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
    return headerKey.trim();
  }
  return undefined;
};

const safeEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const hashApiKey = (apiKey: string): string =>
  crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8);

/**
 * Authentication middleware - API key based (optional for dev)
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const configuredKey = process.env[API_KEY_ENV];
  if (!configuredKey) {
    // No auth configured: use mock user
    req.user = {
      id: 'dev-user-123',
      email: 'dev@example.com',
      subscription: 'pro',
    };
    next();
    return;
  }

  const providedKey = getProvidedApiKey(req);
  if (!providedKey || !safeEquals(providedKey, configuredKey)) {
    const error: ErrorResponse = {
      error: 'Unauthorized',
      details: 'Invalid or missing API key',
    };
    res.status(401).json(error);
    return;
  }

  req.user = {
    id: `api-key-${hashApiKey(providedKey)}`,
    email: '',
    subscription: 'pro',
  };
  next();
};

/**
 * Usage check middleware - in-memory rate limiting (optional)
 */
export const checkUsage = (isTraceAnalysis: boolean = false) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const hasTotalLimit = Number.isFinite(MAX_REQUESTS);
    const hasTraceLimit = Number.isFinite(MAX_TRACE_REQUESTS);

    if (!hasTotalLimit && !hasTraceLimit) {
      next();
      return;
    }

    const apiKey = getProvidedApiKey(req);
    const identity = req.user?.id
      || (apiKey ? `api-key-${hashApiKey(apiKey)}` : undefined)
      || req.ip
      || 'anonymous';

    const now = Date.now();
    const entry = usageTracker.get(identity);
    const record = entry && entry.resetAt > now
      ? entry
      : { resetAt: now + USAGE_WINDOW_MS, total: 0, trace: 0 };

    record.total += 1;
    if (isTraceAnalysis) {
      record.trace += 1;
    }

    usageTracker.set(identity, record);

    if (hasTotalLimit && record.total > MAX_REQUESTS) {
      const error: ErrorResponse = {
        error: 'Usage limit exceeded',
        details: `Exceeded max requests (${MAX_REQUESTS}) in current window`,
      };
      res.status(429).json(error);
      return;
    }

    if (isTraceAnalysis && hasTraceLimit && record.trace > MAX_TRACE_REQUESTS) {
      const error: ErrorResponse = {
        error: 'Trace analysis limit exceeded',
        details: `Exceeded max trace analyses (${MAX_TRACE_REQUESTS}) in current window`,
      };
      res.status(429).json(error);
      return;
    }

    next();
  };
};

export type { AuthenticatedRequest };
