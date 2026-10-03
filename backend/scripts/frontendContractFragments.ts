// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Canonical source→frontend transforms for the analysis quality contracts.
 *
 * The generator and the sync checker both have to reduce a backend contract
 * module to the fragment that belongs in the generated frontend types. They
 * used to hold private copies of those rules, and they drifted: the generator
 * rewrote `SourceUseDecisionV1` to `Record<string, unknown>` (the frontend has
 * no `sourceUseDecision` module) while the checker compared against the
 * untransformed source. The check could then never pass, which left
 * `./scripts/start-dev.sh` failing at its type-sync gate.
 *
 * Both scripts import from here so the two can no longer disagree.
 */

import ts from 'typescript';

type ContractDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

interface ContractFragmentOptions {
  /** Type names written as another type (e.g. backend-only imports as `Record<string, unknown>`). */
  replaceTypes?: Readonly<Record<string, string>>;
  /** Declarations another fragment of the generated module already emits. */
  omit?: readonly string[];
}

const isExported = (declaration: ContractDeclaration): boolean =>
  Boolean(declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));

/** A const's value with `as` / `satisfies` / parentheses stripped. */
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function stringList(node: ts.Expression): string[] | undefined {
  const list = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(list) || !list.elements.every(ts.isStringLiteral)) return undefined;
  return list.elements.map(element => (element as ts.StringLiteral).text);
}

/** The string-literal lists and list tables a type in the module may read with `typeof`. */
function literalConstants(source: ts.SourceFile): {
  lists: Map<string, string[]>;
  tables: Map<string, Map<string, string[]>>;
} {
  const lists = new Map<string, string[]>();
  const tables = new Map<string, Map<string, string[]>>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const list = stringList(declaration.initializer);
      if (list) {
        lists.set(declaration.name.text, list);
        continue;
      }
      const table = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(table)) continue;
      const entries = new Map<string, string[]>();
      for (const property of table.properties) {
        if (!ts.isPropertyAssignment(property)) break;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        const values = key === undefined ? undefined : stringList(property.initializer);
        if (!values) break;
        entries.set(key!, values);
      }
      if (entries.size === table.properties.length) tables.set(declaration.name.text, entries);
    }
  }
  return {lists, tables};
}

const literalUnion = (values: Iterable<string>): string =>
  [...new Set(values)].map(value => `'${value}'`).join(' | ');

const unwrapType = (node: ts.TypeNode): ts.TypeNode =>
  ts.isParenthesizedTypeNode(node) ? unwrapType(node.type) : node;

/**
 * A contract module as it appears in the generated frontend types: its type
 * declarations only (never imports, parsers or runtime code), each kept in its
 * source text. Worked out on the syntax tree, never on text:
 *   - exported declarations, plus the module-private ones they reference
 *     (the frontend compiles with unused-local checks);
 *   - `(typeof LIST)[number]`, `keyof typeof TABLE` and
 *     `typeof TABLE[K][number]` spelled out from the const's string literals,
 *     since the frontend gets no runtime lists; any other `typeof` fails;
 *   - `replaceTypes` references rewritten.
 */
function contractFragment(content: string, options: ContractFragmentOptions = {}): string {
  const source = ts.createSourceFile('contract.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const {lists, tables} = literalConstants(source);
  const omit = new Set(options.omit ?? []);
  const declarations = source.statements.filter(
    (statement): statement is ContractDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && !omit.has(statement.name.text));
  const byName = new Map(declarations.map(declaration => [declaration.name.text, declaration]));

  const included = new Set<ContractDeclaration>();
  const pending = declarations.filter(isExported);
  while (pending.length > 0) {
    const declaration = pending.pop()!;
    if (included.has(declaration)) continue;
    included.add(declaration);
    const visit = (node: ts.Node): void => {
      const name = ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text
        : ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) ? node.expression.text
          : undefined;
      const referenced = name === undefined ? undefined : byName.get(name);
      if (referenced && !included.has(referenced)) pending.push(referenced);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(declaration, visit);
  }

  const known = <T>(map: Map<string, T>, name: string): T => {
    const value = map.get(name);
    if (value === undefined) throw new Error(`${name} is not a declared string list or table`);
    return value;
  };
  const typeQueryName = (node: ts.TypeNode): string | undefined => {
    const inner = unwrapType(node);
    return ts.isTypeQueryNode(inner) && ts.isIdentifier(inner.exprName) ? inner.exprName.text : undefined;
  };

  return declarations.filter(declaration => included.has(declaration)).map(declaration => {
    const start = declaration.getFullStart();
    const edits: Array<{start: number; end: number; text: string}> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIndexedAccessTypeNode(node) && unwrapType(node.indexType).kind === ts.SyntaxKind.NumberKeyword) {
        const object = unwrapType(node.objectType);
        const listName = typeQueryName(object);
        if (listName !== undefined) {
          edits.push({start: node.getStart(source), end: node.end, text: literalUnion(known(lists, listName))});
          return;
        }
        if (ts.isIndexedAccessTypeNode(object)) {
          const tableName = typeQueryName(object.objectType);
          if (tableName !== undefined) {
            edits.push({start: node.getStart(source), end: node.end,
              text: literalUnion([...known(tables, tableName).values()].flat())});
            return;
          }
        }
      }
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword) {
        const tableName = typeQueryName(node.type);
        if (tableName !== undefined) {
          edits.push({start: node.getStart(source), end: node.end, text: literalUnion(known(tables, tableName).keys())});
          return;
        }
      }
      if (ts.isTypeQueryNode(node)) {
        throw new Error(`unsupported type query in ${declaration.name.text}: ${node.getText(source)}`);
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
        && options.replaceTypes?.[node.typeName.text] !== undefined) {
        edits.push({start: node.getStart(source), end: node.end, text: options.replaceTypes[node.typeName.text]});
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(declaration, visit);
    let text = declaration.getFullText(source);
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start);
    }
    return text.trim();
  }).join('\n\n');
}

/**
 * `conclusionContract.ts` as it appears in the generated frontend types.
 *
 * Backend-only imports are dropped and the types they brought in become
 * `Record<string, unknown>`: the frontend never needs their shape, and copying
 * the codebase modules across the boundary would pull source-access contracts
 * into the UI bundle.
 */
export function conclusionContractFragment(content: string): string {
  return contractFragment(content, {replaceTypes: {
    SourceUseDecisionV1: 'Record<string, unknown>',
    SourceReferenceV1: 'Record<string, unknown>',
    SourceClaimBindingV1: 'Record<string, unknown>',
  }});
}

/** Referenced contract types are concatenated into the same generated module. */
export function verbatimContractFragment(content: string): string {
  return contractFragment(content);
}

/**
 * `identityContract.ts` shares `TraceTimestampNs` with the evidence contract,
 * and the generated frontend types concatenate both into one file.
 */
export function identityContractFragment(content: string): string {
  return contractFragment(content, {omit: ['TraceTimestampNs']});
}

/** Per-file SPDX headers are emitted once at the top of the generated file. */
export function externalIssueReportingFragment(content: string): string {
  return content
    .trim()
    .replace(/^\/\/ SPDX-License-Identifier:[^\n]*\n/, '')
    .replace(/^\/\/ Copyright[^\n]*\n/, '')
    .replace(/^\/\/ This file[^\n]*\n\n/, '');
}

/** `criticalPathContract.ts` in the generated frontend types; its id unions are spelled out. */
export function criticalPathContractFragment(content: string): string {
  return contractFragment(content);
}

/**
 * The contract modules the generated frontend types carry, each with the
 * transform that produces its fragment. The generator emits these and the sync
 * check compares them: one list, so the two cannot disagree on what is
 * generated from where.
 */
export const FRONTEND_CONTRACT_SOURCES = {
  conclusion: {path: 'backend/src/agent/core/conclusionContract.ts', fragment: conclusionContractFragment},
  evidence: {path: 'backend/src/types/evidenceContract.ts', fragment: verbatimContractFragment},
  claimVerification: {path: 'backend/src/types/claimVerification.ts', fragment: verbatimContractFragment},
  identity: {path: 'backend/src/types/identityContract.ts', fragment: identityContractFragment},
  externalIssueReporting: {path: 'backend/src/types/externalIssueReporting.ts', fragment: externalIssueReportingFragment},
  criticalPath: {path: 'backend/src/types/criticalPathContract.ts', fragment: criticalPathContractFragment},
} as const satisfies Record<string, {path: string; fragment: (content: string) => string}>;

export type FrontendContractSourceName = keyof typeof FRONTEND_CONTRACT_SOURCES;

/** Every contract module's raw source, read from `projectRoot`. */
export function readFrontendContractSources(
  projectRoot: string,
  readFile: (filePath: string) => string,
): Record<FrontendContractSourceName, string> {
  return Object.fromEntries(Object.entries(FRONTEND_CONTRACT_SOURCES).map(([name, source]) =>
    [name, readFile(`${projectRoot}/${source.path}`)])) as Record<FrontendContractSourceName, string>;
}

/** Every contract module's generated fragment. */
export function frontendContractFragments(
  sources: Record<FrontendContractSourceName, string>,
): Record<FrontendContractSourceName, string> {
  return Object.fromEntries(Object.entries(FRONTEND_CONTRACT_SOURCES).map(([name, source]) =>
    [name, source.fragment(sources[name as FrontendContractSourceName])])) as Record<FrontendContractSourceName, string>;
}

/** Sources needed by the serialized fields on AnalysisCompletedEvent. */
export const ANALYSIS_COMPLETED_PUBLIC_TYPE_PATHS = [
  'types/analysisDelivery.ts',
  'types/sceneTimeline.ts',
  'types/analysisInvestigationAssessment.ts',
  'services/evidence/investigationEvidenceLedger.ts',
  'services/evidence/evidenceCapture.ts',
  'agentRuntime/analysisTurnIntent.ts',
  'agentRuntime/runtimeKinds.ts',
  'agentRuntime/intentTransport.ts',
  'agentv3/types.ts',
  'services/codebase/sourceUseDecision.ts',
  'services/codebase/sourceClaimVerifier.ts',
  'services/codebase/sourceCitations.ts',
] as const;

/** Only reachable type declarations cross the boundary, never runtime code. */
export function analysisCompletedPublicTypeFragment(eventContent: string, contents: readonly string[]): string {
  const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const constants = new Map<string, ts.Expression>();
  for (const content of contents) {
    const source = ts.createSourceFile('public-contract.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        declarations.set(statement.name.text, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const literalType = (expression: ts.Expression, seen = new Set<string>()): ts.TypeNode => {
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return literalType(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      const initializer = constants.get(expression.text);
      if (!initializer || seen.has(expression.text)) throw new Error(`Unresolved public type constant: ${expression.text}`);
      return literalType(initializer, new Set([...seen, expression.text]));
    }
    if (ts.isStringLiteral(expression)) return ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(expression.text));
    if (ts.isNumericLiteral(expression)) return ts.factory.createLiteralTypeNode(ts.factory.createNumericLiteral(expression.text));
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return ts.factory.createLiteralTypeNode(ts.factory.createTrue());
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return ts.factory.createLiteralTypeNode(ts.factory.createFalse());
    if (ts.isArrayLiteralExpression(expression)) return ts.factory.createTupleTypeNode(expression.elements.map(element => literalType(element, seen)));
    throw new Error('Public type queries must reference literal constants');
  };
  const constantType = (name: ts.EntityName): ts.TypeNode => {
    if (!ts.isIdentifier(name) || !constants.has(name.text)) throw new Error('Unresolved public type query');
    return literalType(constants.get(name.text)!);
  };
  const pending: string[] = [];
  const eventSource = ts.createSourceFile('dataContract.ts', eventContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const event = eventSource.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'AnalysisCompletedEvent');
  if (!event) throw new Error('Missing AnalysisCompletedEvent public contract');
  const collectRoots = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && node.qualifier && ts.isIdentifier(node.qualifier) && declarations.has(node.qualifier.text)) {
      pending.push(node.qualifier.text);
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && declarations.has(node.typeName.text)) {
      pending.push(node.typeName.text);
    }
    ts.forEachChild(node, collectRoots);
  };
  collectRoots(event);
  const emitted = new Set<string>();
  const parts: string[] = [];
  const printer = ts.createPrinter({newLine: ts.NewLineKind.LineFeed});
  for (let index = 0; index < pending.length; index++) {
    const name = pending[index];
    if (emitted.has(name)) continue;
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Missing public type declaration: ${name}`);
    emitted.add(name);
    const transformed = ts.transform(declaration, [context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isIndexedAccessTypeNode(node) && ts.isTypeQueryNode(node.objectType) &&
          node.indexType.kind === ts.SyntaxKind.NumberKeyword) {
          const tuple = constantType(node.objectType.exprName);
          if (!ts.isTupleTypeNode(tuple)) throw new Error('Public numeric type index requires a literal tuple');
          return ts.factory.createUnionTypeNode(tuple.elements as readonly ts.TypeNode[]);
        }
        if (ts.isTypeQueryNode(node)) return constantType(node.exprName);
        const referencedName = ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) ? node.typeName.text
          : ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
        if (referencedName && declarations.has(referencedName)) pending.push(referencedName);
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as typeof root;
    }]);
    parts.push(printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], declaration.getSourceFile()).trim());
    transformed.dispose();
  }
  return parts.join('\n\n');
}

/** Exact event transform shared by generation and sync checking. */
export function analysisCompletedContractFragment(content: string): string {
  const start = content.indexOf('export interface AnalysisCompletedFinding {');
  const end = content.indexOf('/**\n * Union type for all SSE events', start);
  if (start < 0 || end < 0) throw new Error('Unable to extract AnalysisCompletedEvent from backend data contract');
  return content.slice(start, end).trim()
    .replace(/import\('\.\.\/agent\/core\/conclusionContract'\)\.ConclusionContract/g, 'ConclusionContract')
    .replace(/import\('\.\/evidenceContract'\)\.ClaimSupportV1/g, 'ClaimSupportV1')
    .replace(/import\('\.\/claimVerification'\)\.ClaimVerificationResult/g, 'ClaimVerificationResult')
    .replace(/import\('\.\/identityContract'\)\.IdentityResolutionV1/g, 'IdentityResolutionV1')
    .replace(/import\('\.\.\/agent\/core\/orchestratorTypes'\)\.QuickRunReceipt/g, 'QuickRunReceipt')
    .replace(/import\('\.\.\/agent\/scene\/types'\)\.SmartScenePreviewPayload/g, 'Record<string, unknown>')
    .replace(/import\('\.\.\/assistant\/contracts\/assistantResultContract'\)\.AssistantResultContract/g, 'Record<string, unknown>')
    .replace(/import\('\.\.\/agentRuntime\/analysisTurnIntent'\)\.AnalysisTurnIntent/g, 'AnalysisTurnIntent')
    .replace(/import\('\.\/analysisDelivery'\)\.(AnalysisCompletion|AnalysisOutputOrigin|AnalysisRuntimeAppendix|FinalReportAssessment|AnalysisDeliveryAssurance)/g, '$1')
    .replace(/import\('\.\/analysisInvestigationAssessment'\)\.FinalInvestigationAssessment/g, 'FinalInvestigationAssessment')
    .replace(/import\('\.\.\/services\/codebase\/sourceUseDecision'\)\.SourceUseDecisionV1/g, 'SourceUseDecisionV1')
    .replace(/import\('\.\.\/services\/codebase\/sourceClaimVerifier'\)\.(StoredSourceClaimVerificationResult|SourceClaimVerificationResult)/g, '$1')
    .replace(/Omit<\s*import\('\.\.\/agentv3\/sessionStateSnapshot'\)\.ComparisonReportSection,\s*'html'\s*>\s*&\s*\{html\?: string\}/g, 'Record<string, unknown>');
}
