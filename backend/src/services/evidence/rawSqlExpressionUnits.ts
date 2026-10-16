// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {RawSqlDirectProjectionAnalysis, RawSqlUnitExpression} from './rawSqlDirectProjection';
import {claimUnitFor} from '../../utils/claimUnits';
import {exactNumber, type Rational} from '../../utils/exactDecimal';

type Quantity = {kind: 'duration' | 'time_point' | 'count'; unit: string};
type NativeColumn = {readonly name: string; readonly type: string};
const canonical = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
const TIME_UNITS = ['ns', 'us', 'ms', 's'] as const;
export const RAW_SQL_EXPRESSION_UNIT_POLICY = Object.freeze({
  rule: 'native_schema_quantity_expression@1',
  timeUnits: Object.freeze(TIME_UNITS.map(unit => Object.freeze({unit, ...claimUnitFor(unit)!}))),
  countUnit: 'count',
});

/** Resolves representation units only; no authority, native identity or clocks are issued here. */
export function resolveRawSqlExpressionUnits(analysis: RawSqlDirectProjectionAnalysis,
  outputColumns: readonly string[], schema: readonly NativeColumn[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  if (!analysis.pureRead || !analysis.relation || !analysis.unitExpressions?.length || !outputColumns.length ||
      new Set(outputColumns.map(canonical)).size !== outputColumns.length ||
      new Set(schema.map(column => canonical(column.name))).size !== schema.length) return result;
  const columns = new Map(schema.map(column => [canonical(column.name), column]));
  const relation = analysis.relation.alias ?? analysis.relation.name;
  const qualifierMatches = (qualifier?: string) => qualifier === undefined || canonical(qualifier) === relation;
  const literal = (expression: RawSqlUnitExpression): Rational | undefined => {
    if (expression.kind !== 'literal') return undefined;
    const value = expression.value.startsWith('.') ? `0${expression.value}` : expression.value;
    return exactNumber(value.replace(/\.(?=[eE]|$)/, ''));
  };
  const quantity = (expression: RawSqlUnitExpression): Quantity | undefined => {
    if (expression.kind === 'column') {
      if (!qualifierMatches(expression.qualifier)) return undefined;
      const type = columns.get(canonical(expression.column))?.type;
      return type === 'DURATION' ? {kind: 'duration', unit: 'ns'}
        : type === 'TIMESTAMP' ? {kind: 'time_point', unit: 'ns'} : undefined;
    }
    if (expression.kind === 'function') {
      if (expression.name === 'count') return {kind: 'count', unit: 'count'};
      if (!['sum', 'avg', 'min', 'max'].includes(expression.name) || !expression.args.length) return undefined;
      const operands = expression.args.map(quantity);
      if (expression.args.length === 1) {
        const operand = operands[0];
        // A sum/mean of absolute timestamps is not a duration.
        return operand && (operand.kind !== 'time_point' || ['min', 'max'].includes(expression.name)) ? operand : undefined;
      }
      if (!['min', 'max'].includes(expression.name)) return undefined;
      const first = operands.find(operand => operand !== undefined);
      if (!first) return undefined;
      // A clipping bound is explicitly compared in the native timestamp scale.
      // The literal alone never gets a unit or a clock.
      return operands.every((operand, index) => operand
        ? operand.kind === first.kind && operand.unit === first.unit
        : first.kind === 'time_point' && literal(expression.args[index]) !== undefined) ? first : undefined;
    }
    if (expression.kind !== 'binary') return undefined;
    const left = quantity(expression.left), right = quantity(expression.right);
    if (['+', '-'].includes(expression.operator) && left && right && left.unit === right.unit) {
      if (left.kind === 'duration' && right.kind === 'duration') return left;
      if (left.kind === 'time_point' && right.kind === 'duration') return left;
      if (expression.operator === '+' && left.kind === 'duration' && right.kind === 'time_point') return right;
      if (expression.operator === '-' && left.kind === 'time_point' && right.kind === 'time_point')
        return {kind: 'duration', unit: left.unit};
    }
    const operand = left ?? (expression.operator === '*' ? right : undefined);
    const factor = left ? literal(expression.right) : literal(expression.left);
    if (!operand || operand.kind !== 'duration' || !factor || factor.numerator <= 0n ||
        !['*', '/'].includes(expression.operator)) return undefined;
    const sourceUnit = claimUnitFor(operand.unit)!;
    const numerator = sourceUnit.numerator * (expression.operator === '/' ? factor.numerator : factor.denominator);
    const denominator = sourceUnit.denominator * (expression.operator === '/' ? factor.denominator : factor.numerator);
    const unit = TIME_UNITS.find(unit => {
      const target = claimUnitFor(unit)!;
      return target.numerator * denominator === numerator * target.denominator;
    });
    return unit ? {kind: 'duration', unit} : undefined;
  };
  let index = 0;
  for (const projection of analysis.unitExpressions) {
    const expression = projection.expression;
    if (expression.kind === 'star') {
      if (!qualifierMatches(expression.qualifier)) return Object.create(null);
      for (const column of schema) {
        if (outputColumns[index++] !== column.name) return Object.create(null);
        if (column.type === 'DURATION') result[column.name] = 'ns';
      }
      continue;
    }
    const output = outputColumns[index++];
    if (output === undefined || (projection.alias !== undefined && projection.alias !== output)) return Object.create(null);
    const source = expression.kind === 'column' ? columns.get(canonical(expression.column)) : undefined;
    if (expression.kind === 'column' && (!source || !qualifierMatches(expression.qualifier) ||
        output !== (projection.alias ?? source.name))) return Object.create(null);
    // Computed fields require an explicit output slot. A response name is never parsed as a unit.
    if (expression.kind !== 'column' && projection.alias === undefined) continue;
    const resolved = quantity(expression);
    if (resolved && resolved.kind !== 'time_point') result[output] = resolved.unit;
  }
  return index === outputColumns.length ? result : Object.create(null);
}
