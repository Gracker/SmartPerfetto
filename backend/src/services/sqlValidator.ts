// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {getPerfettoStdlibSymbolIndex} from './perfettoStdlibScanner';
import {extractExternalTableReferences} from './sqlStdlibDependencyAnalyzer';

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Static checks for Perfetto SQL before it is executed. Table names are
 * checked against the generated stdlib symbol index of the pinned trace
 * processor (built-in tables and stdlib modules), plus the query's own CTEs
 * and CREATE statements; execution against a real trace remains the proof.
 */
export class SQLValidator {
  public validateSQL(sql: string): ValidationResult {
    const result: ValidationResult = {isValid: true, errors: [], warnings: []};
    const sqlLower = sql.toLowerCase();

    if (sqlLower.includes('limit offset')) {
      result.errors.push('LIMIT OFFSET syntax is not supported in Perfetto SQL');
    }
    if (sqlLower.includes('string_agg')) {
      result.errors.push('STRING_AGG is not supported; use GROUP_CONCAT');
    }

    const index = getPerfettoStdlibSymbolIndex();
    if (index.source === 'empty') {
      result.warnings.push('Perfetto stdlib symbol index unavailable; table names were not checked');
    } else {
      for (const table of extractExternalTableReferences(sql)) {
        if (!index.builtins.has(table) && !index.tableToModule.has(table)) {
          result.errors.push(`Unknown table: ${table}`);
        }
      }
    }

    if (/select\s+\*\s+from/i.test(sql)) {
      result.warnings.push('SELECT * can be slow in Perfetto SQL; select only the needed columns');
    }

    result.isValid = result.errors.length === 0;
    return result;
  }
}
