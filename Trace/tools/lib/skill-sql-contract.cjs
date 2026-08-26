// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const crypto = require('node:crypto');

function sqlSha256(sql) {
  return crypto.createHash('sha256').update(String(sql)).digest('hex');
}

function displayColumns(display) {
  if (!display || display === false || !Array.isArray(display.columns)) return [];
  return [...new Set(display.columns
    .map((column) => column?.name)
    .filter((name) => typeof name === 'string' && name.trim() !== ''))];
}

function maskSqlLiteralsAndComments(sql) {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        out += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < sql.length) {
        out += '  ';
        index += 2;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += ' ';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out += '  ';
            index += 2;
            continue;
          }
          out += ' ';
          index += 1;
          break;
        }
        out += sql[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function projectedColumns(sql) {
  const masked = maskSqlLiteralsAndComments(String(sql));
  let depth = 0;
  let selectEnd = -1;
  let fromStart = -1;
  for (let index = 0; index < masked.length;) {
    const char = masked[index];
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const match = masked.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      const word = match[0];
      const upper = word.toUpperCase();
      if (selectEnd < 0 && upper === 'SELECT') selectEnd = index + word.length;
      else if (selectEnd >= 0 && upper === 'FROM') {
        fromStart = index;
        break;
      }
      index += word.length;
      continue;
    }
    index += 1;
  }
  if (selectEnd < 0) return [];
  const end = fromStart >= 0 ? fromStart : masked.length;
  const projectionMasked = masked.slice(selectEnd, end);
  const projectionSource = String(sql).slice(selectEnd, end);
  const expressions = [];
  let expressionStart = 0;
  depth = 0;
  for (let index = 0; index <= projectionMasked.length; index += 1) {
    const char = projectionMasked[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if ((char === ',' && depth === 0) || index === projectionMasked.length) {
      expressions.push(projectionSource.slice(expressionStart, index).trim());
      expressionStart = index + 1;
    }
  }
  const reserved = new Set(['ASC', 'DESC', 'END', 'NULL', 'TRUE', 'FALSE']);
  return [...new Set(expressions.map((expression) => {
    const asAlias = expression.match(/\bAS\s+["`\[]?([A-Za-z_][A-Za-z0-9_$]*)["`\]]?\s*$/i);
    if (asAlias) return asAlias[1];
    const identifier = expression.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_$]*)\s*$/);
    if (identifier) return identifier[1];
    const bareAlias = expression.match(/\s+([A-Za-z_][A-Za-z0-9_$]*)\s*$/);
    if (bareAlias && !reserved.has(bareAlias[1].toUpperCase())) return bareAlias[1];
    return null;
  }).filter(Boolean))];
}

function resultColumns(sql, display) {
  const declared = displayColumns(display);
  return declared.length > 0 ? declared : projectedColumns(sql);
}

function isReadOnlySql(sql) {
  const withoutComments = String(sql).replace(/--.*$/gm, '').trim();
  const withoutIncludes = withoutComments.replace(
    /^(?:INCLUDE\s+PERFETTO\s+MODULE\s+[^;]+;\s*)+/i,
    '',
  );
  if (!/^(SELECT|WITH)\b/i.test(withoutIncludes)) return false;
  return !/\b(?:ALTER|ATTACH|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REPLACE|UPDATE|VACUUM)\b/i
    .test(withoutIncludes);
}

function collectStepSql(steps) {
  const sqlSteps = [];
  const topLevelSqlIndexes = new Set();
  const visit = (step, topLevelIndex) => {
    if (!step || typeof step !== 'object') return;
    if (typeof step.sql === 'string' && step.sql.trim() !== '') {
      sqlSteps.push({
        id: step.id,
        sql: step.sql,
        condition: typeof step.condition === 'string' ? step.condition : null,
        topLevelIndex,
        requiredColumns: resultColumns(step.sql, step.display),
      });
      topLevelSqlIndexes.add(topLevelIndex);
    }
    for (const child of Array.isArray(step.steps) ? step.steps : []) visit(child, topLevelIndex);
    for (const condition of Array.isArray(step.conditions) ? step.conditions : []) {
      if (condition?.then && typeof condition.then === 'object') visit(condition.then, topLevelIndex);
    }
    if (step.else && typeof step.else === 'object') visit(step.else, topLevelIndex);
  };
  steps.forEach((step, index) => visit(step, index));
  return {sqlSteps, topLevelSqlIndexes};
}

function referencedSqlVariables(sql) {
  return [...String(sql).matchAll(/\$\{([^}]+)\}/g)].map((match) => {
    const expression = match[1].trim();
    return expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(?:\.|\[|\?)|(?:\|[^}]*$)|$)/)?.[1]
      ?? null;
  });
}

function producedVariablesBefore(steps, topLevelIndex) {
  const names = new Set();
  for (const step of steps.slice(0, topLevelIndex)) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.id === 'string' && step.id) names.add(step.id);
    if (typeof step.save_as === 'string' && step.save_as) names.add(step.save_as);
  }
  return names;
}

function skillSqlContract(definition) {
  const steps = Array.isArray(definition?.steps) ? definition.steps : [];
  const hasRootSql = typeof definition?.sql === 'string' && definition.sql.trim() !== '';
  const {sqlSteps, topLevelSqlIndexes} = collectStepSql(steps);
  const inputNames = new Set(
    (Array.isArray(definition?.inputs) ? definition.inputs : [])
      .map((input) => input?.name)
      .filter(Boolean),
  );
  const canForceProbe = (step) => {
    const availableNames = producedVariablesBefore(steps, step.topLevelIndex);
    return isReadOnlySql(step.sql)
      && referencedSqlVariables(step.sql).every((name) =>
        name !== null && (inputNames.has(name) || availableNames.has(name)));
  };
  const stepSqlIds = sqlSteps.map((step) => step.id).filter(Boolean);
  const sqlIds = [...(hasRootSql ? ['root'] : []), ...stepSqlIds];
  const sqlSourceSteps = [
    ...(hasRootSql ? [{
      id: 'root',
      sha256: sqlSha256(definition.sql),
      requiredColumns: resultColumns(definition.sql, definition.display),
    }] : []),
    ...sqlSteps.map((step) => ({
      id: step.id,
      sha256: sqlSha256(step.sql),
      requiredColumns: step.requiredColumns,
    })),
  ];
  const declaredModules = [...new Set(
    (Array.isArray(definition?.prerequisites?.modules)
      ? definition.prerequisites.modules
      : [])
      .filter((moduleName) => typeof moduleName === 'string' && moduleName.trim() !== ''),
  )].sort();
  const forcedSqlStepIds = sqlSteps
      .filter((step) => step.condition && canForceProbe(step))
      .map((step) => step.id)
      .filter(Boolean);
  const conditionOnlySqlStepIds = sqlSteps
      .filter((step) => step.condition && !canForceProbe(step))
      .map((step) => step.id)
      .filter(Boolean);
  const lastSqlTopLevelIndex = topLevelSqlIndexes.size > 0
    ? Math.max(...topLevelSqlIndexes)
    : -1;
  return {
    hasRootSql,
    hasStepSql: sqlSteps.length > 0,
    steps,
    sqlSteps,
    sqlIds,
    sqlSourceSteps,
    declaredModules,
    forcedSqlStepIds,
    conditionOnlySqlStepIds,
    lastSqlTopLevelIndex,
  };
}

module.exports = {isReadOnlySql, skillSqlContract};
