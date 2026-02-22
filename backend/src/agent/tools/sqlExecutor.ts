import { Tool, ToolContext, ToolResult, ToolDefinition } from '../types';
import { SQLValidator } from './sqlValidator';

interface SQLExecutorParams {
  sql: string;
}

interface SQLExecutorResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
}

const definition: ToolDefinition = {
  name: 'execute_sql',
  description: 'Execute a Perfetto SQL query against the loaded trace. Returns query results as columns and rows.',
  category: 'sql',
  parameters: [
    {
      name: 'sql',
      type: 'string',
      required: true,
      description: 'The SQL query to execute. Must be valid Perfetto SQL syntax.',
    },
  ],
  returns: {
    type: 'SQLExecutorResult',
    description: 'Query results with columns array and rows array of arrays',
  },
};

const DEFAULT_MAX_ROWS = Number.parseInt(process.env.AGENT_SQL_MAX_ROWS || '', 10) || 1000;
const TABLE_CACHE_TTL_MS = Number.parseInt(process.env.AGENT_SQL_TABLE_CACHE_TTL_MS || '', 10) || 5 * 60 * 1000;

const tableWhitelistCache = new Map<string, { tables: string[]; expiresAt: number }>();

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getMaxRowsFromContext(context: ToolContext): number {
  const candidate = (context as any)?.additionalContext?.maxRows;
  if (isFinitePositiveNumber(candidate)) {
    return Math.max(1, Math.floor(candidate));
  }
  return DEFAULT_MAX_ROWS;
}

async function queryTablesViaService(context: ToolContext): Promise<string[] | null> {
  if (!context.traceProcessorService || !context.traceId) {
    return null;
  }

  const cache = tableWhitelistCache.get(context.traceId);
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.tables;
  }

  const result = await context.traceProcessorService.query(
    context.traceId,
    "SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name"
  );
  const tables = Array.isArray(result?.rows)
    ? result.rows
      .map((row: any[]) => String(row?.[0] || '').trim())
      .filter((name: string) => name.length > 0)
    : [];

  tableWhitelistCache.set(context.traceId, {
    tables,
    expiresAt: now + TABLE_CACHE_TTL_MS,
  });

  return tables;
}

async function queryTablesViaProcessor(context: ToolContext): Promise<string[] | null> {
  if (!context.traceProcessor) {
    return null;
  }

  const result = await context.traceProcessor.query(
    "SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name"
  );
  return Array.isArray(result?.rows)
    ? result.rows
      .map((row: any[]) => String(row?.[0] || '').trim())
      .filter((name: string) => name.length > 0)
    : [];
}

async function resolveAllowedTables(context: ToolContext): Promise<string[]> {
  try {
    const fromService = await queryTablesViaService(context);
    if (fromService && fromService.length > 0) {
      return fromService;
    }
  } catch {
    // Best-effort only; fallback below.
  }

  try {
    const fromProcessor = await queryTablesViaProcessor(context);
    if (fromProcessor && fromProcessor.length > 0) {
      return fromProcessor;
    }
  } catch {
    // Ignore and continue with empty whitelist.
  }

  return [];
}

export const sqlExecutorTool: Tool<SQLExecutorParams, SQLExecutorResult> = {
  definition,

  validate(params: SQLExecutorParams) {
    const errors: string[] = [];
    if (!params.sql || typeof params.sql !== 'string') {
      errors.push('sql parameter is required and must be a string');
    }
    if (params.sql && params.sql.trim().length === 0) {
      errors.push('sql parameter cannot be empty');
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(params: SQLExecutorParams, context: ToolContext): Promise<ToolResult<SQLExecutorResult>> {
    const startTime = Date.now();
    
    try {
      const validation = this.validate?.(params);
      if (validation && !validation.valid) {
        return {
          success: false,
          error: validation.errors.join('; '),
          executionTimeMs: Date.now() - startTime,
        };
      }

      const maxRows = getMaxRowsFromContext(context);
      const validator = new SQLValidator({ maxRows });
      const sqlWithLimit = validator.ensureLimit(params.sql, maxRows);
      const allowedTables = await resolveAllowedTables(context);
      const sqlValidation = validator.validate(
        sqlWithLimit,
        allowedTables.length > 0 ? { maxRows, allowedTables } : { maxRows }
      );

      if (!sqlValidation.valid) {
        return {
          success: false,
          error: `SQL validation failed: ${sqlValidation.errors.map(e => e.message).join('; ')}`,
          executionTimeMs: Date.now() - startTime,
          metadata: {
            validationErrors: sqlValidation.errors.map(e => e.code),
            validationWarnings: sqlValidation.warnings.map(w => w.code),
          },
        };
      }

      let result;
      
      if (context.traceProcessorService && context.traceId) {
        result = await context.traceProcessorService.query(context.traceId, sqlWithLimit);
      } else if (context.traceProcessor) {
        result = await context.traceProcessor.query(sqlWithLimit);
      } else {
        return {
          success: false,
          error: 'TraceProcessor or TraceProcessorService not available in context',
          executionTimeMs: Date.now() - startTime,
        };
      }

      const rawRows = Array.isArray(result.rows) ? result.rows : [];
      const clippedRows = rawRows.slice(0, maxRows);
      const rowsClipped = rawRows.length > maxRows;
      
      return {
        success: true,
        data: {
          columns: result.columns || [],
          rows: clippedRows,
          rowCount: clippedRows.length,
        },
        executionTimeMs: Date.now() - startTime,
        metadata: {
          sqlLength: params.sql.length,
          executedSqlLength: sqlWithLimit.length,
          sqlAutoLimited: sqlWithLimit !== params.sql,
          maxRows,
          rowsClipped,
          rawRowCount: rawRows.length,
          allowedTableCount: allowedTables.length,
          validationWarnings: sqlValidation.warnings.map(w => ({
            code: w.code,
            message: w.message,
          })),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'SQL execution failed',
        executionTimeMs: Date.now() - startTime,
      };
    }
  },
};
