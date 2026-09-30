// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SQL Safety Validator
 *
 * Validates SQL queries before execution to ensure safety.
 * This is the security gatekeeper for agent-generated SQL.
 *
 * Validation layers:
 * 1. Syntax check - basic SQL structure
 * 2. Statement type - only SELECT allowed
 * 3. Table whitelist - only approved tables
 * 4. Pattern blocklist - no dangerous patterns
 * 5. Complexity limits - prevent runaway queries
 *
 * Design principles:
 * - Fail closed (reject on uncertainty)
 * - Defense in depth (multiple validation layers)
 * - Clear error messages for debugging
 * - Performance-aware (avoid regex catastrophe)
 */

// =============================================================================
// Types
// =============================================================================

export interface SQLConstraints {
  /** Maximum rows to return (default: 1000) */
  maxRows: number;
  /** Allowed tables (whitelist) */
  allowedTables: string[];
  /** Forbidden SQL patterns (regex) */
  forbiddenPatterns: RegExp[];
  /** Query timeout in milliseconds */
  timeout: number;
  /** Maximum query complexity (joins, subqueries) */
  maxComplexity?: number;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether the query passed validation */
  valid: boolean;
  /** Error message if validation failed */
  reason?: string;
  /** All validation errors (may be multiple) */
  errors: ValidationError[];
  /** Warnings (non-blocking issues) */
  warnings: ValidationWarning[];
  /** Extracted metadata from query */
  metadata?: QueryMetadata;
}

/**
 * Validation error
 */
export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  /** Position in SQL string if applicable */
  position?: number;
}

/**
 * Validation warning (non-blocking)
 */
export interface ValidationWarning {
  code: ValidationWarningCode;
  message: string;
}

/**
 * Error codes for validation failures
 */
export enum ValidationErrorCode {
  EMPTY_QUERY = 'EMPTY_QUERY',
  NOT_SELECT = 'NOT_SELECT',
  MULTIPLE_STATEMENTS = 'MULTIPLE_STATEMENTS',
  FORBIDDEN_PATTERN = 'FORBIDDEN_PATTERN',
  UNKNOWN_TABLE = 'UNKNOWN_TABLE',
  SYNTAX_ERROR = 'SYNTAX_ERROR',
  COMPLEXITY_EXCEEDED = 'COMPLEXITY_EXCEEDED',
  INJECTION_ATTEMPT = 'INJECTION_ATTEMPT',
}

/**
 * Warning codes for non-blocking issues
 */
export enum ValidationWarningCode {
  MISSING_LIMIT = 'MISSING_LIMIT',
  LARGE_LIMIT = 'LARGE_LIMIT',
  MULTIPLE_JOINS = 'MULTIPLE_JOINS',
  FULL_TABLE_SCAN = 'FULL_TABLE_SCAN',
  CARTESIAN_PRODUCT = 'CARTESIAN_PRODUCT',
}

/**
 * Extracted query metadata
 */
export interface QueryMetadata {
  /** Tables referenced in query */
  tables: string[];
  /** Number of JOIN operations */
  joinCount: number;
  /** Whether query has LIMIT clause */
  hasLimit: boolean;
  /** LIMIT value if present */
  limitValue?: number;
  /** Whether query has WHERE clause */
  hasWhere: boolean;
  /** Estimated complexity score */
  complexityScore: number;
}

// =============================================================================
// SQL Validator
// =============================================================================

/**
 * SQL safety validator for agent-generated queries.
 */
export class SQLValidator {
  private defaultConstraints: SQLConstraints;

  constructor(constraints?: Partial<SQLConstraints>) {
    this.defaultConstraints = {
      maxRows: constraints?.maxRows ?? 1000,
      allowedTables: constraints?.allowedTables ?? [],
      forbiddenPatterns: constraints?.forbiddenPatterns ?? getDefaultForbiddenPatterns(),
      timeout: constraints?.timeout ?? 30000,
      maxComplexity: constraints?.maxComplexity ?? 10,
    };
  }

  /**
   * Validate an SQL query against constraints.
   *
   * @param sql - The SQL query to validate
   * @param constraints - Override constraints (optional)
   * @returns Validation result with errors/warnings
   */
  validate(sql: string, constraints?: Partial<SQLConstraints>): ValidationResult {
    const effectiveConstraints: SQLConstraints = {
      ...this.defaultConstraints,
      ...constraints,
    };

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Layer 1: Basic checks
    const basicResult = this.validateBasic(sql);
    errors.push(...basicResult.errors);

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    // Layer 2: Statement type
    const typeResult = this.validateStatementType(sql);
    errors.push(...typeResult.errors);

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    // Layer 3: Forbidden patterns
    const patternResult = this.validateForbiddenPatterns(sql, effectiveConstraints.forbiddenPatterns);
    errors.push(...patternResult.errors);

    // Layer 4: Table whitelist (if specified)
    if (effectiveConstraints.allowedTables.length > 0) {
      const tableResult = this.validateTables(sql, effectiveConstraints.allowedTables);
      errors.push(...tableResult.errors);
      warnings.push(...tableResult.warnings);
    }

    // Layer 5: Complexity and performance
    const metadata = this.extractMetadata(sql);
    const complexityResult = this.validateComplexity(metadata, effectiveConstraints);
    errors.push(...complexityResult.errors);
    warnings.push(...complexityResult.warnings);

    // Check LIMIT
    if (!metadata.hasLimit) {
      warnings.push({
        code: ValidationWarningCode.MISSING_LIMIT,
        message: `Query has no LIMIT clause. Consider adding LIMIT ${effectiveConstraints.maxRows}`,
      });
    } else if (metadata.limitValue && metadata.limitValue > effectiveConstraints.maxRows) {
      warnings.push({
        code: ValidationWarningCode.LARGE_LIMIT,
        message: `LIMIT ${metadata.limitValue} exceeds recommended max ${effectiveConstraints.maxRows}`,
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      metadata,
      reason: errors.length > 0 ? errors[0].message : undefined,
    };
  }

  /**
   * Layer 1: Basic validation.
   */
  private validateBasic(sql: string): { errors: ValidationError[] } {
    const errors: ValidationError[] = [];

    if (!sql || sql.trim().length === 0) {
      errors.push({
        code: ValidationErrorCode.EMPTY_QUERY,
        message: 'SQL query is empty',
      });
      return { errors };
    }

    // Check for multiple statements (semicolon-separated)
    const trimmed = sql.trim();
    const statements = trimmed.split(';').filter(s => s.trim().length > 0);
    if (statements.length > 1) {
      errors.push({
        code: ValidationErrorCode.MULTIPLE_STATEMENTS,
        message: 'Multiple SQL statements are not allowed',
      });
    }

    return { errors };
  }

  /**
   * Layer 2: Statement type validation.
   */
  private validateStatementType(sql: string): { errors: ValidationError[] } {
    const errors: ValidationError[] = [];
    const normalized = sql.trim().toUpperCase();

    // Must start with SELECT (allowing leading whitespace and comments stripped)
    const withoutComments = this.stripComments(normalized);
    if (!withoutComments.startsWith('SELECT')) {
      errors.push({
        code: ValidationErrorCode.NOT_SELECT,
        message: 'Only SELECT queries are allowed',
      });
    }

    // Check for write operations anywhere in query
    const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE'];
    for (const keyword of writeKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(normalized)) {
        errors.push({
          code: ValidationErrorCode.NOT_SELECT,
          message: `Write operation "${keyword}" is not allowed`,
        });
      }
    }

    return { errors };
  }

  /**
   * Layer 3: Forbidden pattern validation.
   */
  private validateForbiddenPatterns(
    sql: string,
    patterns: RegExp[]
  ): { errors: ValidationError[] } {
    const errors: ValidationError[] = [];

    for (const pattern of patterns) {
      if (pattern.test(sql)) {
        // Determine if this is an injection attempt
        const isInjection = pattern.toString().includes('--') ||
          pattern.toString().includes('/*');

        errors.push({
          code: isInjection
            ? ValidationErrorCode.INJECTION_ATTEMPT
            : ValidationErrorCode.FORBIDDEN_PATTERN,
          message: `Forbidden pattern detected: ${pattern.source}`,
        });
      }
    }

    return { errors };
  }

  /**
   * Layer 4: Table whitelist validation.
   */
  private validateTables(
    sql: string,
    allowedTables: string[]
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const referencedTables = this.extractTableNames(sql);
    const allowedSet = new Set(allowedTables.map(t => t.toLowerCase()));

    for (const table of referencedTables) {
      if (!allowedSet.has(table.toLowerCase())) {
        errors.push({
          code: ValidationErrorCode.UNKNOWN_TABLE,
          message: `Table "${table}" is not in the allowed list`,
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Layer 5: Complexity validation.
   */
  private validateComplexity(
    metadata: QueryMetadata,
    constraints: SQLConstraints
  ): { errors: ValidationError[]; warnings: ValidationWarning[] } {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Check complexity score
    if (constraints.maxComplexity && metadata.complexityScore > constraints.maxComplexity) {
      errors.push({
        code: ValidationErrorCode.COMPLEXITY_EXCEEDED,
        message: `Query complexity ${metadata.complexityScore} exceeds limit ${constraints.maxComplexity}`,
      });
    }

    // Warnings for potentially slow queries
    if (metadata.joinCount >= 3) {
      warnings.push({
        code: ValidationWarningCode.MULTIPLE_JOINS,
        message: `Query has ${metadata.joinCount} JOINs, may be slow`,
      });
    }

    if (!metadata.hasWhere && metadata.tables.length === 1) {
      warnings.push({
        code: ValidationWarningCode.FULL_TABLE_SCAN,
        message: 'Query has no WHERE clause, will scan entire table',
      });
    }

    // Detect potential cartesian products
    if (metadata.tables.length > 1 && metadata.joinCount === 0 && !metadata.hasWhere) {
      warnings.push({
        code: ValidationWarningCode.CARTESIAN_PRODUCT,
        message: 'Query may produce cartesian product (multiple tables without JOIN or WHERE)',
      });
    }

    return { errors, warnings };
  }

  /**
   * Extract metadata from SQL query.
   */
  private extractMetadata(sql: string): QueryMetadata {
    const upper = sql.toUpperCase();

    // Extract table names
    const tables = this.extractTableNames(sql);

    // Count JOINs
    const joinMatches = upper.match(/\bJOIN\b/g) || [];
    const joinCount = joinMatches.length;

    // Check for LIMIT
    const limitMatch = upper.match(/\bLIMIT\s+(\d+)/i);
    const hasLimit = limitMatch !== null;
    const limitValue = hasLimit ? parseInt(limitMatch![1], 10) : undefined;

    // Check for WHERE
    const hasWhere = /\bWHERE\b/i.test(upper);

    // Calculate complexity score
    let complexityScore = 1;
    complexityScore += joinCount * 2;
    complexityScore += (upper.match(/\bSUBQUERY\b|\bSELECT\b/g) || []).length - 1; // Subqueries
    complexityScore += (upper.match(/\bUNION\b/g) || []).length * 2;
    complexityScore += (upper.match(/\bGROUP BY\b/g) || []).length;
    complexityScore += (upper.match(/\bORDER BY\b/g) || []).length;

    return {
      tables,
      joinCount,
      hasLimit,
      limitValue,
      hasWhere,
      complexityScore,
    };
  }

  /**
   * Extract table names from SQL query.
   * This is a simplified parser - not 100% accurate but good enough for validation.
   */
  private extractTableNames(sql: string): string[] {
    const tables: Set<string> = new Set();

    // Match FROM clause
    const fromMatch = sql.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi);
    if (fromMatch) {
      for (const match of fromMatch) {
        const tableName = match.replace(/^FROM\s+/i, '').trim();
        if (tableName && !isKeyword(tableName)) {
          tables.add(tableName);
        }
      }
    }

    // Match JOIN clauses
    const joinMatch = sql.match(/\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi);
    if (joinMatch) {
      for (const match of joinMatch) {
        const tableName = match.replace(/^JOIN\s+/i, '').trim();
        if (tableName && !isKeyword(tableName)) {
          tables.add(tableName);
        }
      }
    }

    return Array.from(tables);
  }

  /**
   * Strip SQL comments from query.
   */
  private stripComments(sql: string): string {
    // Remove single-line comments
    let result = sql.replace(/--.*$/gm, '');
    // Remove multi-line comments
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');
    return result.trim();
  }

  /**
   * Add SQL query with automatic LIMIT if missing.
   */
  ensureLimit(sql: string, maxRows: number): string {
    const upper = sql.trim().toUpperCase();
    if (/\bLIMIT\b/i.test(upper)) {
      return sql;
    }

    // Remove trailing semicolon if present
    const trimmed = sql.trim().replace(/;$/, '');
    return `${trimmed} LIMIT ${maxRows}`;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get default forbidden patterns.
 */
function getDefaultForbiddenPatterns(): RegExp[] {
  return [
    // DDL statements
    /\bDROP\b/i,
    /\bCREATE\b/i,
    /\bALTER\b/i,
    /\bTRUNCATE\b/i,

    // DML statements
    /\bINSERT\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bMERGE\b/i,

    // DCL statements
    /\bGRANT\b/i,
    /\bREVOKE\b/i,

    // System commands
    /\bEXEC\b/i,
    /\bEXECUTE\b/i,
    /\bATTACH\b/i,
    /\bDETACH\b/i,

    // Potential injection patterns
    /--/,           // Single-line comment start
    /\/\*/,         // Block comment start
    /;\s*SELECT/i,  // Stacked query attempt
    /'\s*OR\s*'/i,  // Classic OR injection
    /"\s*OR\s*"/i,  // Double quote OR injection
    /UNION\s+ALL\s+SELECT/i,  // Union-based injection (suspicious)
  ];
}

/**
 * Check if a word is a SQL keyword.
 */
function isKeyword(word: string): boolean {
  const keywords = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
    'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'AS',
    'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'OFFSET',
    'HAVING', 'DISTINCT', 'ALL', 'UNION', 'EXCEPT', 'INTERSECT',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'LIKE', 'BETWEEN',
    'EXISTS', 'TRUE', 'FALSE',
  ]);
  return keywords.has(word.toUpperCase());
}
