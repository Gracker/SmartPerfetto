// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Request, Response } from 'express';
import { sendRouteFailure } from '../middleware/routeFailure';
import EnhancedAIService from '../services/enhancedAIService';
import { GenerateSqlRequest, GenerateSqlResponse, ErrorResponse } from '../types';

class SqlController {
  private aiService: EnhancedAIService;

  constructor() {
    this.aiService = new EnhancedAIService();
  }

  generateSql = async (req: Request, res: Response) => {
    try {
      const { query, context }: GenerateSqlRequest = req.body;

      if (!query || typeof query !== 'string') {
        const error: ErrorResponse = {
          error: 'Invalid request',
          details: 'Query is required and must be a string',
        };
        return res.status(400).json(error);
      }

      // Limit query length
      if (query.length > 1000) {
        const error: ErrorResponse = {
          error: 'Query too long',
          details: 'Query must be less than 1000 characters',
        };
        return res.status(400).json(error);
      }

      const generated = await this.aiService.generatePerfettoSQL({
        query,
        context,
      });
      const result: GenerateSqlResponse = {
        sql: generated.sql,
        explanation: generated.explanation,
        examples: [
          ...generated.validation.warnings,
          ...generated.validation.suggestions,
        ],
      };

      res.json(result);
    } catch (error) {
      sendRouteFailure(res, {
        code: 'sql_generation_failed',
        error: 'Internal server error',
        logLabel: '[SqlController] Error generating SQL',
      }, error);
    }
  };

  // Endpoint to get available Perfetto tables and their schema
  getTablesSchema = async (_req: Request, res: Response) => {
    try {
      const tables = [
        {
          name: 'slice',
          description: 'Represents time intervals of operations',
          columns: [
            { name: 'id', type: 'INTEGER', description: 'Unique identifier' },
            { name: 'type', type: 'STRING', description: 'Type of slice (slice, instant, counter)' },
            { name: 'name', type: 'STRING', description: 'Human-readable name' },
            { name: 'ts', type: 'LONG', description: 'Start timestamp in nanoseconds' },
            { name: 'dur', type: 'LONG', description: 'Duration in nanoseconds' },
            { name: 'track_id', type: 'LONG', description: 'Reference to track' },
          ],
        },
        {
          name: 'thread',
          description: 'Thread information',
          columns: [
            { name: 'utid', type: 'INTEGER', description: 'Unique thread identifier' },
            { name: 'tid', type: 'INTEGER', description: 'Thread ID' },
            { name: 'name', type: 'STRING', description: 'Thread name' },
            { name: 'pid', type: 'INTEGER', description: 'Process ID' },
          ],
        },
        {
          name: 'process',
          description: 'Process information',
          columns: [
            { name: 'upid', type: 'INTEGER', description: 'Unique process identifier' },
            { name: 'pid', type: 'INTEGER', description: 'Process ID' },
            { name: 'name', type: 'STRING', description: 'Process name' },
            { name: 'uid', type: 'INTEGER', description: 'User ID' },
          ],
        },
        {
          name: 'counter',
          description: 'Time-series counter data',
          columns: [
            { name: 'id', type: 'INTEGER', description: 'Unique identifier' },
            { name: 'ts', type: 'LONG', description: 'Timestamp in nanoseconds' },
            { name: 'value', type: 'DOUBLE', description: 'Counter value' },
            { name: 'track_id', type: 'LONG', description: 'Reference to track' },
          ],
        },
        {
          name: 'ftrace_event',
          description: 'Kernel ftrace events',
          columns: [
            { name: 'id', type: 'INTEGER', description: 'Unique identifier' },
            { name: 'ts', type: 'LONG', description: 'Timestamp in nanoseconds' },
            { name: 'name', type: 'STRING', description: 'Event name' },
            { name: 'cpu', type: 'INTEGER', description: 'CPU number' },
          ],
        },
      ];

      res.json({ tables });
    } catch (error) {
      sendRouteFailure(res, {
        code: 'sql_schema_failed',
        error: 'Internal server error',
        logLabel: '[SqlController] Error fetching tables schema',
      }, error);
    }
  };
}

export default SqlController;
