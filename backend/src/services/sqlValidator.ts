import { PERFETTO_TABLES_SCHEMA } from '../data/perfettoSchema';

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

interface TableReference {
  table: string;
  alias?: string;
  columns: string[];
}

export class SQLValidator {
  private knownTables: Set<string> = new Set();
  private tableColumns: Map<string, string[]> = new Map();

  constructor() {
    this.parseSchema();
  }

  private parseSchema(): void {
    // Extract table definitions from schema
    const tableRegex = /### (\w+)\n-\s+(\w+):\s+\w+.*?\n/gm;
    const matches = Array.from(PERFETTO_TABLES_SCHEMA.matchAll(tableRegex));

    this.knownTables = new Set(matches.map(m => m[1].toLowerCase()));
    this.tableColumns = new Map();

    // Parse columns for each table (simplified)
    matches.forEach(match => {
      const tableName = match[1].toLowerCase();
      const tableSection = PERFETTO_TABLES_SCHEMA.split(`### ${tableName}`)[1]?.split('\n###')[0];
      if (tableSection) {
        const columnLines = tableSection.match(/-\s+(\w+):/g) || [];
        const columns = columnLines.map(line => line.match(/-\s+(\w+):/)?.[1]).filter(Boolean) as string[];
        this.tableColumns.set(tableName, columns);
      }
    });
  }

  public validateSQL(sql: string): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: []
    };

    // Convert to lowercase for parsing
    const sqlLower = sql.toLowerCase();

    // 1. Check for invalid SQL syntax patterns
    if (sqlLower.includes('limit offset')) {
      result.errors.push('LIMIT OFFSET syntax is not supported in Perfetto SQL');
      result.isValid = false;
    }

    // 2. Check for standard SQL features not in Perfetto
    if (sqlLower.includes('group concat') || sqlLower.includes('string_agg')) {
      result.errors.push('String aggregation functions like GROUP_CONCAT or STRING_AGG are not supported');
      result.isValid = false;
    }

    // 3. Check for suboptimal patterns
    if (sqlLower.includes('where ') && !sqlLower.includes('table_with_filter')) {
      result.warnings.push('Consider using TABLE_WITH_FILTER() instead of WHERE for better performance');
    }

    // 4. Extract and validate table references
    const tables = this.extractTables(sql);
    tables.forEach(tableRef => {
      if (!this.knownTables.has(tableRef.table.toLowerCase())) {
        if (!tableRef.table.includes('(')) { // Not a table function
          result.errors.push(`Unknown table: ${tableRef.table}`);
          result.isValid = false;

          // Suggest similar tables
          const similar = this.findSimilarTables(tableRef.table);
          if (similar.length > 0) {
            result.suggestions.push(`Did you mean: ${similar.join(', ')}?`);
          }
        }
      }
    });

    // 5. Validate JOIN conditions
    this.validateJoins(sql, result);

    // 6. Check for common Perfetto SQL anti-patterns
    this.checkAntiPatterns(sql, result);

    return result;
  }

  private extractTables(sql: string): TableReference[] {
    const tables: TableReference[] = [];

    // Regex to match table references in FROM and JOIN clauses
    const fromRegex = /(?:from|join)\s+([a-z_][a-z0-9_]*)\s*(?:as\s+([a-z_][a-z0-9_]*))?\s*(?:where|join|group|order|$)/gi;
    const matches = Array.from(sql.matchAll(fromRegex));

    matches.forEach(match => {
      tables.push({
        table: match[1],
        alias: match[2],
        columns: []
      });
    });

    return tables;
  }

  private validateJoins(sql: string, result: ValidationResult): void {
    // Check for proper ON conditions with foreign keys
    const joinRegex = /join\s+(\w+)\s+on\s+([^;\n]+)/gi;
    const matches = Array.from(sql.matchAll(joinRegex));

    matches.forEach(match => {
      const onClause = match[2].toLowerCase();

      // Check if join is using known foreign key relationships
      if (!onClause.includes('track_id') &&
          !onClause.includes('utid') &&
          !onClause.includes('upid') &&
          !onClause.includes('id') &&
          !onClause.includes('parent_id')) {
        result.warnings.push(`JOIN condition might not use proper foreign key: ${match[1]}`);
        result.suggestions.push(`Consider joining on foreign keys: track_id, utid, upid`);
      }
    });
  }

  private checkAntiPatterns(sql: string, result: ValidationResult): void {
    // Pattern 1: Using SELECT *
    if (sql.match(/select\s+\*\s+from/i)) {
      result.warnings.push('SELECT * can be slow in Perfetto SQL');
      result.suggestions.push('Specify only the columns you need');
    }

    // Pattern 2: Missing timestamp conversions
    if (sql.includes('.ts') && !sql.includes('/ 1e')) {
      result.warnings.push('Timestamps are in nanoseconds, consider converting to seconds or milliseconds');
      result.suggestions.push('Use ts / 1e9 for seconds or ts / 1e6 for milliseconds');
    }

    // Pattern 3: Duration in nanoseconds
    if (sql.includes('.dur') && !sql.includes('/ 1e')) {
      result.warnings.push('Durations are in nanoseconds, consider converting to milliseconds');
      result.suggestions.push('Use dur / 1e6 for milliseconds');
    }

    // Pattern 4: Using string comparisons for IDs
    if (sql.match(/where\s+\w+\s*=\s*['"]/i)) {
      result.warnings.push('ID fields should be compared as numbers, not strings');
      result.suggestions.push('Remove quotes around numeric ID comparisons');
    }
  }

  private findSimilarTables(table: string): string[] {
    const tableLower = table.toLowerCase();
    const similar: string[] = [];

    for (const knownTable of this.knownTables) {
      // Simple Levenshtein distance
      if (this.isSimilar(tableLower, knownTable, 2)) {
        similar.push(knownTable);
      }
    }

    return similar.slice(0, 3); // Return top 3 suggestions
  }

  private isSimilar(a: string, b: string, maxDistance: number): boolean {
    if (Math.abs(a.length - b.length) > maxDistance) return false;

    let distance = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) distance++;
      if (distance > maxDistance) return false;
    }

    return true;
  }

  public suggestCorrection(sql: string): string {
    const validation = this.validateSQL(sql);

    if (validation.isValid) {
      return sql;
    }

    let corrected = sql;

    // Apply common corrections
    for (const error of validation.errors) {
      if (error.includes('Unknown table')) {
        const match = error.match(/Unknown table: (\w+)/);
        if (match) {
          const tableName = match[1];
          const suggestion = this.findSimilarTables(tableName)[0];
          if (suggestion) {
            corrected = corrected.replace(new RegExp(tableName, 'g'), suggestion);
          }
        }
      }
    }

    return corrected;
  }
}

export default SQLValidator;