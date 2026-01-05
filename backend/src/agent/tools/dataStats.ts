import { Tool, ToolContext, ToolResult, ToolDefinition } from '../types';

interface DataStatsParams {
  data: any[];
  field: string;
  groupBy?: string;
}

interface StatsSummary {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  median: number;
  stddev: number;
}

interface DataStatsResult {
  overall: StatsSummary;
  byGroup?: Record<string, StatsSummary>;
  outliers?: any[];
}

const definition: ToolDefinition = {
  name: 'calculate_stats',
  description: 'Calculate statistical summaries for a numeric field in the data. Can optionally group by another field.',
  category: 'data',
  parameters: [
    { name: 'data', type: 'array', required: true, description: 'Array of data objects to analyze' },
    { name: 'field', type: 'string', required: true, description: 'The numeric field to calculate statistics for' },
    { name: 'groupBy', type: 'string', required: false, description: 'Optional field to group statistics by' },
  ],
  returns: {
    type: 'DataStatsResult',
    description: 'Statistical summary including count, sum, avg, min, max, median, stddev',
  },
};

function calculateStats(values: number[]): StatsSummary {
  if (values.length === 0) {
    return { count: 0, sum: 0, avg: 0, min: 0, max: 0, median: 0, stddev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / count;
  const min = sorted[0];
  const max = sorted[count - 1];
  const median = count % 2 === 0 
    ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2 
    : sorted[Math.floor(count / 2)];
  
  const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / count;
  const stddev = Math.sqrt(variance);

  return { count, sum, avg, min, max, median, stddev };
}

function detectOutliers(values: number[], data: any[], field: string): any[] {
  if (values.length < 4) return [];
  
  const sorted = [...values].sort((a, b) => a - b);
  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Idx];
  const q3 = sorted[q3Idx];
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  return data.filter(item => {
    const value = item[field];
    return typeof value === 'number' && (value < lowerBound || value > upperBound);
  });
}

export const dataStatsTool: Tool<DataStatsParams, DataStatsResult> = {
  definition,

  validate(params: DataStatsParams) {
    const errors: string[] = [];
    if (!Array.isArray(params.data)) {
      errors.push('data must be an array');
    }
    if (!params.field || typeof params.field !== 'string') {
      errors.push('field must be a non-empty string');
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(params: DataStatsParams, context: ToolContext): Promise<ToolResult<DataStatsResult>> {
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

      const { data, field, groupBy } = params;
      const values = data
        .map(item => item[field])
        .filter(v => typeof v === 'number' && !isNaN(v));

      const result: DataStatsResult = {
        overall: calculateStats(values),
        outliers: detectOutliers(values, data, field),
      };

      if (groupBy) {
        result.byGroup = {};
        const groups = new Map<string, number[]>();
        
        for (const item of data) {
          const groupKey = String(item[groupBy] ?? 'unknown');
          const value = item[field];
          if (typeof value === 'number' && !isNaN(value)) {
            if (!groups.has(groupKey)) {
              groups.set(groupKey, []);
            }
            groups.get(groupKey)!.push(value);
          }
        }

        for (const [key, groupValues] of groups) {
          result.byGroup[key] = calculateStats(groupValues);
        }
      }

      return {
        success: true,
        data: result,
        executionTimeMs: Date.now() - startTime,
        metadata: {
          totalItems: data.length,
          numericValues: values.length,
          groupCount: result.byGroup ? Object.keys(result.byGroup).length : 0,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  },
};
