// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Nothing outside `/api` serves user data.
 *
 * `authenticate` and the keyless-mode Host (DNS-rebinding) check are mounted on
 * `/api`, so an app-level route anywhere else skips them, and trace ownership
 * with them. Until 2026-10 `index.ts` mounted `express.static(<backend>/uploads)`
 * at `/uploads` whenever NODE_ENV was `development` — the default — so every
 * source deployment served uploaded traces to any caller, including a
 * rebinding page that `/api` rejects. Uploaded traces are downloaded through
 * `GET /api/traces/:id/file`.
 *
 * `index.ts` listens and starts workers when imported, so this checks the
 * source instead of booting the app: app-level routes outside `/api` are an
 * explicit list, and every static root or app-level `sendFile` target must
 * evaluate, from literals and `__dirname` alone, to a path under
 * `backend/public`.
 */

import * as fs from 'fs';
import * as path from 'path';

import {describe, expect, it} from '@jest/globals';
import * as ts from 'typescript';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
const PUBLIC_ROOT = path.join(BACKEND_ROOT, 'public');
const INDEX_FILE = path.join(SRC_ROOT, 'index.ts');

/** App-level paths outside `/api`: a health probe and the shipped asset pages. */
const PUBLIC_APP_PATHS = ['/health', '/assistant-shell', '/admin-control-plane'];

const ROUTE_METHODS = ['use', 'get', 'post', 'put', 'patch', 'delete', 'all'];

function productionSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', '__mocks__'].includes(entry.name)) {
        productionSourceFiles(entryPath, out);
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(entryPath);
    }
  }
  return out;
}

function parseSource(fileName: string, text = fs.readFileSync(fileName, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => forEachNode(child, visit));
}

/** `<receiver>.<name>(...)`; any receiver when none is given. */
function isMethodCall(node: ts.Node, names: string[], receiver?: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const {expression, name} = node.expression;
  return names.includes(name.text)
    && (receiver === undefined || (ts.isIdentifier(expression) && expression.text === receiver));
}

/** `import serveStatic from 'serve-static'` or `import {static} from 'express'`. */
function importsStaticHandler(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return false;
  const specifier = node.moduleSpecifier.text;
  if (specifier === 'serve-static') return true;
  const bindings = node.importClause?.namedBindings;
  return specifier === 'express' && !!bindings && ts.isNamedImports(bindings)
    && bindings.elements.some(element => (element.propertyName ?? element.name).text === 'static');
}

interface EvaluationScope {
  dir: string;
  initializers: Map<string, ts.Expression>;
}

/** Same-file `const` initializers, so `express.static(dir)` can be followed. */
function evaluationScope(sourceFile: ts.SourceFile): EvaluationScope {
  const initializers = new Map<string, ts.Expression>();
  forEachNode(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const)) {
      initializers.set(node.name.text, node.initializer);
    }
  });
  return {dir: path.dirname(sourceFile.fileName), initializers};
}

/**
 * Evaluates `path.resolve|join(__dirname, '<literal>'...)`, following const
 * identifiers. Anything else returns null: a path this cannot prove is a
 * path the test must reject.
 */
function evaluatePath(
  expression: ts.Expression | undefined,
  scope: EvaluationScope,
  seen = new Set<string>(),
): string | null {
  if (!expression) return null;
  if (ts.isParenthesizedExpression(expression)) return evaluatePath(expression.expression, scope, seen);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    if (expression.text === '__dirname') return scope.dir;
    if (seen.has(expression.text)) return null;
    seen.add(expression.text);
    return evaluatePath(scope.initializers.get(expression.text), scope, seen);
  }
  if (isMethodCall(expression, ['resolve', 'join'], 'path')) {
    const parts = expression.arguments.map(argument => evaluatePath(argument, scope, seen));
    if (parts.some(part => part === null)) return null;
    const joined = path.join(...(parts as string[]));
    return path.isAbsolute(joined) ? joined : null;
  }
  return null;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function location(node: ts.Node, sourceFile: ts.SourceFile): string {
  const {line} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(BACKEND_ROOT, sourceFile.fileName)}:${line + 1}`;
}

/** `<static root or sendFile target>` per location, null when not provable. */
function servedPaths(sourceFile: ts.SourceFile, methods: string[]): Array<[string, string | null]> {
  const scope = evaluationScope(sourceFile);
  const served: Array<[string, string | null]> = [];
  forEachNode(sourceFile, node => {
    if (isMethodCall(node, methods)) {
      served.push([location(node, sourceFile), evaluatePath(node.arguments[0], scope)]);
    } else if (importsStaticHandler(node)) {
      served.push([location(node, sourceFile), null]);
    }
  });
  return served;
}

function outsidePublic(served: Array<[string, string | null]>): string[] {
  return served
    .filter(([, target]) => target === null || !isWithin(PUBLIC_ROOT, target))
    .map(([where, target]) => `${where} -> ${target ?? '<not statically provable>'}`);
}

describe('Web routes outside /api', () => {
  const indexSource = parseSource(INDEX_FILE);
  const staticRoots = productionSourceFiles(SRC_ROOT).flatMap(fileName => {
    const text = fs.readFileSync(fileName, 'utf8');
    return text.includes('static') ? servedPaths(parseSource(fileName, text), ['static']) : [];
  });

  it('does not serve /uploads/<file> or any other unlisted path without authentication', () => {
    const paths = new Set<string>();
    forEachNode(indexSource, node => {
      if (isMethodCall(node, ROUTE_METHODS, 'app')
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        paths.add(node.arguments[0].text);
      }
    });
    const outsideApi = [...paths].filter(route => route !== '/api' && !route.startsWith('/api/'));
    expect(outsideApi.sort()).toEqual([...PUBLIC_APP_PATHS].sort());
  });

  it('serves static directories only under backend/public', () => {
    // Guards the scan itself: an empty result would pass the check below.
    expect(staticRoots.map(([, root]) => root)).toEqual(expect.arrayContaining(
      ['assistant-shell', 'admin-control-plane'].map(dir => path.join(PUBLIC_ROOT, dir))));
    expect(outsidePublic(staticRoots)).toEqual([]);
  });

  it('sends app-level files only from backend/public', () => {
    // Router handlers sit behind their /api guards and choose files per
    // request; the app-level handlers in index.ts have neither.
    const targets = servedPaths(indexSource, ['sendFile']);
    expect(targets.length).toBeGreaterThan(0);
    expect(outsidePublic(targets)).toEqual([]);
  });
});
