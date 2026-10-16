// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {describe, expect, it} from '@jest/globals';
import * as ts from 'typescript';

import {rowObject} from '../traceProcessorRowUtils';

describe('rowObject', () => {
  it.each([
    ['a scalar', 'main'],
    ['NULL', null],
    ['an object', {nested: 1}],
  ])('keeps a column named __proto__ holding %s as an own data key', (_label, value) => {
    const row = rowObject(['id', '__proto__'], [1, value]);

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toEqual(value);
    expect(Object.keys(row)).toEqual(['id', '__proto__']);
    expect(row.hasOwnProperty('id')).toBe(true);
  });

  it('lets a later duplicate column win and leaves missing cells undefined', () => {
    expect(rowObject(['id', 'id', 'name'], [1, 2])).toEqual({id: 2, name: undefined});
  });
});

// Writing a column-named key onto `{}` runs the inherited __proto__ setter, so
// a column aliased `__proto__` in model-written SQL is dropped (or, as NULL,
// strips the object's prototype). Build such objects with rowObject,
// Object.fromEntries or a Map. The scan reads the syntax tree: a computed-key
// write onto a local initialised to `{}` whose key mentions a column name. It
// is a heuristic tripwire, not a proof: it tracks names per file without
// scopes, so an aliased object or a key computed elsewhere can escape it.
function columnKeyedWrites(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ||
      ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node;
  const isEmptyObject = (node: ts.Expression | undefined) => {
    const inner = node && unwrap(node);
    return !!inner && ts.isObjectLiteralExpression(inner) && inner.properties.length === 0;
  };
  const mentionsColumn = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && /col/i.test(node.text)) || node.getChildren(source).some(mentionsColumn);
  const plainObjects = new Set<string>();
  const writes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isEmptyObject(node.initializer)) {
      plainObjects.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left) && isEmptyObject(node.right)) plainObjects.add(node.left.text);
      const target = node.left;
      if (ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression) &&
          plainObjects.has(target.expression.text) && !ts.isStringLiteralLike(target.argumentExpression) &&
          mentionsColumn(target.argumentExpression)) {
        writes.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

describe('column-keyed object builders', () => {
  const srcRoot = path.resolve(__dirname, '../..');
  const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

  it('recognizes the write shape it guards against', () => {
    for (const snippet of [
      'const obj: Record<string, any> = {}; columns.forEach((col, i) => { obj[col] = row[i]; });',
      'let item; item = {}; for (let c = 0; c < targetColumns.length; c++) item[targetColumns[c]] = rows[c];',
      'const out = {}; for (let i = 0; i < cols.length; i++) out[String(cols[i])] = row[i];',
      'const preview = {}; preview[full.columns[i]] = null;',
      'const out = {} as Record<string, unknown>; out[column] = row[i];',
      'const out = ({} satisfies Record<string, unknown>); out[column] = row[i];',
    ]) {
      expect(columnKeyedWrites('snippet.ts', snippet)).toHaveLength(1);
    }
    for (const snippet of [
      'const row = Object.create(null); row[column] = value;',
      'const out = {}; out[key] = value;',
      'const out = {}; out["column"] = value;',
      'return rowObject(columns, row);',
    ]) {
      expect(columnKeyedWrites('snippet.ts', snippet)).toEqual([]);
    }
  });

  it('are absent from backend sources', () => {
    const writes = sourceFiles(srcRoot).flatMap(file =>
      columnKeyedWrites(path.relative(srcRoot, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')));
    expect(writes).toEqual([]);
  });
});
