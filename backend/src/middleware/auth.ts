import { Request, Response, NextFunction } from 'express';
import AuthService from '../services/authService';
import { ErrorResponse } from '../types';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    subscription: string;
  };
}

const authService = new AuthService();

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // Skip authentication in development
  if (process.env.NODE_ENV === 'development') {
    // Add a mock user for development
    req.user = {
      id: 'dev-user-123',
      email: 'dev@example.com',
      subscription: 'pro', // Give pro access in development
    };
    next();
    return;
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const error: ErrorResponse = {
        error: 'No token provided',
        details: 'Please provide a valid JWT token',
      };
      res.status(401).json(error);
      return;
    }

    const token = authHeader.substring(7);
    const decoded = await authService.verifyToken(token);

    req.user = {
      id: decoded.userId,
      email: decoded.email,
      subscription: decoded.subscription,
    };

    next();
  } catch (error) {
    const errorResponse: ErrorResponse = {
      error: 'Invalid token',
      details: 'Please provide a valid JWT token',
    };
    res.status(401).json(errorResponse);
  }
};

export const checkUsage = (isTraceAnalysis: boolean = false) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    // Skip usage check in development
    if (process.env.NODE_ENV === 'development') {
      next();
      return;
    }

    try {
      if (!req.user) {
        const error: ErrorResponse = {
          error: 'User not authenticated',
        };
        res.status(401).json(error);
        return;
      }

      const canProceed = await authService.checkAndUpdateUsage(req.user.id, isTraceAnalysis);

      if (!canProceed) {
        const error: ErrorResponse = {
          error: 'Usage limit exceeded',
          details: isTraceAnalysis
            ? 'You have reached your monthly limit of 5 trace analyses. Please upgrade to Pro plan for unlimited analyses.'
            : 'You have reached your monthly limit of 100 SQL generations. Please upgrade to Pro plan for unlimited generations.',
        };
        res.status(429).json(error);
        return;
      }

      next();
    } catch (error) {
      const errorResponse: ErrorResponse = {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };
};

export type { AuthenticatedRequest };