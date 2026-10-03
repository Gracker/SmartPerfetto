// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Expression Utilities
 *
 * The vocabulary Skill expressions share between the runtime evaluator
 * (skillExecutor's ExpressionEvaluator) and load-time validation, the
 * root-name extraction validation uses, and diagnostic evidence fields.
 */

/**
 * Standard ECMAScript globals a Skill expression may use. A listed name always
 * means the language global: the evaluator never binds it to a Skill value
 * (the Perfetto-Skills runtime likewise reads `Boolean(...)` as the builtin),
 * and the validator does not ask for it to be declared. Every other name is
 * read from the Skill scopes, and is `undefined` when none binds it; host
 * globals (`process`, `console`, `window`) are therefore not reachable by
 * name. This is the expression language's vocabulary, not a sandbox:
 * expressions run through `new Function`.
 */
export const EXPRESSION_GLOBALS: ReadonlySet<string> = new Set([
  'Infinity', 'NaN', 'undefined',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'Array', 'BigInt', 'Boolean', 'Date', 'Error', 'Intl', 'JSON', 'Map', 'Math',
  'Number', 'Object', 'RegExp', 'Set', 'String', 'Symbol',
]);

/** Words a sloppy-mode `new Function(name, …)` rejects as a parameter name. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

/** Reserved words that are values, so what follows them is an operator. */
const VALUE_WORDS: ReadonlySet<string> = new Set(['false', 'null', 'super', 'this', 'true']);

/** Contextual keywords: legal variable names that also act as keywords (`x of y`, `await p`). */
export const CONTEXTUAL_KEYWORDS: ReadonlySet<string> = new Set(['async', 'await', 'let', 'of', 'static', 'yield']);

/**
 * The Skill placeholders ExpressionEvaluator.evaluate substitutes. A text that
 * is one whole `${…}` (with no `${` inside) holds a single expression;
 * otherwise each `${…}` runs to its first `}`.
 */
const WHOLE_SKILL_PLACEHOLDER = /^\$\{(.+)\}$/s;
export const SKILL_PLACEHOLDER = /\$\{([^}]+)\}/g;

const PATH_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[[0-9]+\])*`;
const SIMPLE_PATH = new RegExp(`^${PATH_SOURCE}$`);
const PATH_WITH_DEFAULT = new RegExp(String.raw`^(${PATH_SOURCE})\|([^|].*)$`);

/** A placeholder path read through scopes (`step.data[0].field`), not a JS expression. */
function isSimplePath(path: string): boolean {
  return SIMPLE_PATH.test(path.trim());
}

/** The `path|default` form of a placeholder, or null when it is not one. */
function parsePathWithDefault(raw: string): {actualPath: string; defaultValue: string} | null {
  const match = raw.trim().match(PATH_WITH_DEFAULT);
  return match ? {actualPath: match[1].trim(), defaultValue: match[2].trim()} : null;
}

/** How the evaluator reads a placeholder body: a path through scopes, or JavaScript. */
type PlaceholderRoute =
  | {kind: 'path'; path: string; defaultValue?: string}
  | {kind: 'js'; expression: string};

/** The body of `text` when it is one whole `${…}` placeholder, not a template of several. */
export function wholePlaceholderBody(text: string): string | undefined {
  const match = text.match(WHOLE_SKILL_PLACEHOLDER);
  return match && !match[1].includes('${') ? match[1] : undefined;
}

/**
 * Routes a placeholder body as ExpressionEvaluator.evaluate does, and as
 * validation must read it: `path|default`, and a simple path embedded in
 * text, resolve through scopes; a whole placeholder without a default, and
 * anything that is not a path, are JavaScript.
 */
export function routePlaceholder(inner: string, whole: boolean): PlaceholderRoute {
  const withDefault = parsePathWithDefault(inner);
  if (withDefault) return {kind: 'path', path: withDefault.actualPath, defaultValue: withDefault.defaultValue};
  const body = inner.trim();
  return !whole && isSimplePath(body) ? {kind: 'path', path: body} : {kind: 'js', expression: body};
}

const ID_ESCAPE = String.raw`\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})`;
const ID_PART = String.raw`[\p{ID_Continue}$\u200C\u200D]`;
/** A JS IdentifierName, Unicode letters and `\u` escapes included; use with the `u` flag. */
const IDENTIFIER_SOURCE = String.raw`(?:[\p{ID_Start}$_]|${ID_ESCAPE})(?:${ID_PART}|${ID_ESCAPE})*`;
const IDENTIFIER_AT = new RegExp(IDENTIFIER_SOURCE, 'uy');
// Not inside a longer identifier, nor right after an escape's backslash.
const IDENTIFIER_SCAN = new RegExp(String.raw`(?<![\p{ID_Continue}$\u200C\u200D\\])${IDENTIFIER_SOURCE}`, 'gu');
const DECODED_IDENTIFIER = new RegExp(String.raw`^[\p{ID_Start}$_]${ID_PART}*$`, 'u');

/** Every identifier written in `text`, property names and words inside literals included. */
export function identifierMatches(text: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  IDENTIFIER_SCAN.lastIndex = 0;
  for (let match; (match = IDENTIFIER_SCAN.exec(text)) !== null;) matches.push(match);
  return matches;
}

/**
 * The name an identifier spells, with its `\u` escapes decoded. An escape
 * beyond U+10FFFF (legal in a comment or `String.raw`) stays as written, which
 * no binding can name.
 */
export function decodeIdentifier(raw: string): string {
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/g,
    (escape, braced: string | undefined, fixed: string | undefined) => {
      const codePoint = parseInt(braced ?? fixed!, 16);
      return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : escape;
    });
}

/**
 * Whether an expression can read `name` as a variable, and so whether it can be
 * bound as a `new Function` parameter: a decoded identifier that is not a
 * reserved word. An escape in a literal (`"0"`) decodes to no such name.
 */
export function isBindableName(name: string): boolean {
  return DECODED_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * `start` is a word's source offset and `property` marks a word written after
 * `.`/`?.`; `flags` is a regex literal's flags span, which an identifier scan
 * sees as a name. A literal's `text` is only its kind's first character.
 */
type Token = {kind: 'word' | 'literal' | 'punct'; text: string; start?: number; property?: boolean; flags?: [number, number]};

const REGEX_FLAG = /[\w$]/;
const DIGIT = /[0-9]/;
// Every character that ends a line, and so a `//` comment or a regex literal.
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
// Longest first; `?.` before a digit is a conditional followed by a number.
const MULTI_PUNCT = ['...', '=>', '?.', '++', '--'];
/** Words whose parenthesized head is a statement head, so `if (x) /re/` starts a regex. */
const CONTROL_WORDS: ReadonlySet<string> = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);

function skipQuoted(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote) return i + 1;
  }
  return src.length;
}

/** The end of the regex literal at `start`, and where its flags begin. */
function skipRegex(src: string, start: number): {end: number; flagsStart: number} {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      const flagsStart = ++i;
      while (i < src.length && REGEX_FLAG.test(src[i])) i++;
      return {end: i, flagsStart};
    } else if (LINE_TERMINATOR.test(c)) return {end: i, flagsStart: i};
  }
  return {end: src.length, flagsStart: src.length};
}

/**
 * Whether the last token ends an operand, so that `/` divides rather than
 * starting a regex. Without parsing, a `}` (object literal or block) and a
 * contextual keyword (`of`, `yield`, `await`, … or a variable of that name)
 * leave it undecided: `maybe`.
 */
type OperandEnd = 'yes' | 'no' | 'maybe';

interface LexState {
  i: number;
  tokens: Token[];
  /** For each open bracket, what its closer ends: a call/group or index an operand, a control head none. */
  closers: OperandEnd[];
  endsOperand: OperandEnd;
}

/**
 * Lex from `state` until the end, returning false, or until a `/` that could
 * be either a regex or a division, returning true with `state.i` on it.
 * Template literals hold no `${…}` code here: extraction substitutes every
 * `${…}` first, as evaluateCondition does.
 */
function lexUntilAmbiguous(src: string, state: LexState): boolean {
  const {tokens, closers} = state;
  const push = (token: Token, ends: OperandEnd) => { tokens.push(token); state.endsOperand = ends; };

  while (state.i < src.length) {
    const i = state.i;
    const c = src[i];
    if (/\s/.test(c)) { state.i++; continue; }
    if (src.startsWith('//', i)) {
      const end = src.slice(i).search(LINE_TERMINATOR);
      state.i = end < 0 ? src.length : i + end;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      state.i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/') {
      if (state.endsOperand === 'maybe') return true;
      if (state.endsOperand === 'no') {
        const {end, flagsStart} = skipRegex(src, i);
        state.i = end;
        push({kind: 'literal', text: '/', flags: [flagsStart, end]}, 'yes');
        continue;
      }
    }
    if (c === '\'' || c === '"' || c === '`') { state.i = skipQuoted(src, i); push({kind: 'literal', text: c}, 'yes'); continue; }
    IDENTIFIER_AT.lastIndex = i;
    const identifier = IDENTIFIER_AT.exec(src)?.[0];
    if (identifier) {
      const word = decodeIdentifier(identifier);
      const prev = tokens[tokens.length - 1]?.text;
      state.i += identifier.length;
      // A property name (`obj.return`) is an operand whatever the word.
      if (prev === '.' || prev === '?.') push({kind: 'word', text: word, start: i, property: true}, 'yes');
      else if (CONTEXTUAL_KEYWORDS.has(word)) push({kind: 'word', text: word, start: i}, 'maybe');
      else push({kind: 'word', text: word, start: i}, RESERVED_WORDS.has(word) && !VALUE_WORDS.has(word) ? 'no' : 'yes');
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      state.i = j;
      push({kind: 'literal', text: '0'}, 'yes');
      continue;
    }
    const multi = MULTI_PUNCT.find(p => src.startsWith(p, i) && !(p === '?.' && DIGIT.test(src[i + 2] ?? '')));
    if (multi) {
      state.i += multi.length;
      // Postfix `x++ / y` still ends an operand; prefix `++x` leaves the state as it was.
      push({kind: 'punct', text: multi}, multi === '++' || multi === '--' ? state.endsOperand : 'no');
      continue;
    }
    state.i++;
    const prev = tokens[tokens.length - 1];
    if (c === '(') closers.push(prev?.kind === 'word' && !prev.property && CONTROL_WORDS.has(prev.text) ? 'no' : 'yes');
    else if (c === '[') closers.push('yes');
    else if (c === '{') closers.push('maybe');
    const closed = c === ')' || c === ']' || c === '}' ? closers.pop() : undefined;
    push({kind: 'punct', text: c}, closed ?? 'no');
  }
  return false;
}

/** At most this many lexings per condition; beyond it extraction falls back to the coarse scan. */
const MAX_LEXINGS = 64;

/**
 * Every token list `src` lexes to when each undecided `/` is read both as a
 * regex and as a division, or undefined beyond {@link MAX_LEXINGS}.
 */
function lexings(src: string): Token[][] | undefined {
  const done: Token[][] = [];
  const pending: LexState[] = [{i: 0, tokens: [], closers: [], endsOperand: 'no'}];
  while (pending.length > 0) {
    const state = pending.pop()!;
    if (!lexUntilAmbiguous(src, state)) { done.push(state.tokens); continue; }
    if (done.length + pending.length + 2 > MAX_LEXINGS) return undefined;
    for (const endsOperand of ['yes', 'no'] as const) {
      pending.push({...state, tokens: [...state.tokens], closers: [...state.closers], endsOperand});
    }
  }
  return done;
}

/** Index of the opener matching the closer at `close`, scanning backward. */
function matchingOpener(tokens: Token[], close: number): number {
  const pairs: Record<string, string> = {')': '(', ']': '[', '}': '{'};
  const stack: string[] = [];
  for (let i = close; i >= 0; i--) {
    const text = tokens[i].text;
    if (tokens[i].kind !== 'punct') continue;
    if (pairs[text]) stack.push(pairs[text]);
    else if (text === '(' || text === '[' || text === '{') {
      if (stack.pop() !== text) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The innermost bracket open at `index`, or undefined at top level. */
function enclosingOpener(tokens: Token[], index: number): string | undefined {
  let closed = 0;
  for (let i = index - 1; i >= 0; i--) {
    const {kind, text} = tokens[i];
    if (kind !== 'punct') continue;
    if (text === ')' || text === ']' || text === '}') closed++;
    else if (text === '(' || text === '[' || text === '{') {
      if (closed === 0) return text;
      closed--;
    }
  }
  return undefined;
}

/**
 * Index just past the body of an arrow function starting at `start`: the `,`,
 * `;` or closer it does not enclose, or the `:` of a conditional it did not
 * open. A block body ends the same way, since only those can follow its `}` in
 * a condition that compiles.
 */
function arrowBodyEndIndex(tokens: Token[], start: number): number {
  let depth = 0;
  let conditionals = 0;
  for (let i = start; i < tokens.length; i++) {
    const {kind, text} = tokens[i];
    if (kind !== 'punct') continue;
    if (text === '(' || text === '[' || text === '{') depth++;
    else if (text === ')' || text === ']' || text === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth > 0) continue;
    else if (text === ',' || text === ';') return i;
    else if (text === '?') {
      if (tokens[i + 1]?.text === '?') i++; // `??`
      else conditionals++;
    } else if (text === ':') {
      if (conditionals === 0) return i;
      conditionals--;
    }
  }
  return tokens.length;
}

/** A name an arrow function binds, over the tokens where it hides an outer name of that name. */
type ParameterScope = {name: string; from: number; to: number};

/**
 * The parameters each arrow function in `tokens` declares, scoped to its
 * parameter list and body: binding positions including destructuring targets,
 * but not destructuring keys (`{key: name}`), nor what a default (`= value`)
 * or a computed key (`{[key]: name}`) reads.
 */
function arrowParameterScopes(tokens: Token[]): ParameterScope[] {
  const scopes: ParameterScope[] = [];
  tokens.forEach((token, i) => {
    if (token.text !== '=>') return;
    const head = tokens[i - 1];
    if (head?.kind === 'word') { scopes.push({name: head.text, from: i - 1, to: arrowBodyEndIndex(tokens, i + 1)}); return; }
    const open = head?.text === ')' ? matchingOpener(tokens, i - 1) : -1;
    if (open < 0) return;
    const to = arrowBodyEndIndex(tokens, i + 1);
    const openers: string[] = [];
    // While set, words are reads: a default until its `,` or the bracket around it
    // closes, a computed key until its own `]` closes.
    let read: {depth: number; computedKey: boolean} | undefined;
    for (let j = open + 1; j < i - 1; j++) {
      const {kind, text} = tokens[j];
      const prev = tokens[j - 1].text;
      if (kind === 'punct' && (text === '(' || text === '[' || text === '{')) {
        if (!read && text === '[' && openers[openers.length - 1] === '{' && (prev === '{' || prev === ',')) {
          read = {depth: openers.length, computedKey: true};
        }
        openers.push(text);
      } else if (kind === 'punct' && (text === ')' || text === ']' || text === '}')) {
        openers.pop();
        if (read && (read.computedKey ? openers.length === read.depth : openers.length < read.depth)) read = undefined;
      } else if (text === '=' && !read) read = {depth: openers.length, computedKey: false};
      else if (text === ',' && read && !read.computedKey && openers.length === read.depth) read = undefined;
      else if (kind === 'word' && !read && tokens[j + 1]?.text !== ':') scopes.push({name: text, from: open, to});
    }
  });
  return scopes;
}

/** A name a scope could bind: not a reserved word, not a language global. */
const isScopeName = (name: string) => isBindableName(name) && !EXPRESSION_GLOBALS.has(name);

/** A root name a Skill expression reads. */
interface RootRead {
  name: string;
  /** Where it is written: its offset in the expression, inside a `${…}` placeholder too. */
  at: number;
  /**
   * The member read right after the name in a lexed reading: a property name,
   * `[` for an index, or none. A placeholder routed as a path records none,
   * since that path is no member read; the coarse fallback records none.
   */
  access?: string;
}

/**
 * The reads of an expression, and whether they are exact: every lexing the
 * engine confirmed, and no scope but an arrow function with an expression
 * body. Otherwise the reads are a guess that may name a local or a word in a
 * literal.
 */
export interface RootReads {
  reads: RootRead[];
  exact: boolean;
}

/** Words that declare a local other than an arrow parameter. */
const LOCAL_DECLARATIONS: ReadonlySet<string> = new Set(['catch', 'class', 'const', 'function', 'let', 'var']);

/**
 * Whether a lexing opens a scope root reads do not model: a declaration, or a
 * block after `)` or `=>` (a function, method or accessor body, a control
 * block, an arrow's block body), where statements and labels may name locals.
 */
const hasUnmodeledScope = (tokens: Token[]) => tokens.some((token, i) =>
  (token.kind === 'word' && !token.property && LOCAL_DECLARATIONS.has(token.text))
  || (token.kind === 'punct' && token.text === '{' && (tokens[i - 1]?.text === ')' || tokens[i - 1]?.text === '=>')));

/** Root names one lexing of a condition reads: no property, static key, or arrow parameter in its scope. */
function rootsOfLexing(tokens: Token[]): RootRead[] {
  const scopes = arrowParameterScopes(tokens);
  const reads: RootRead[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== 'word' || token.property || !isScopeName(token.text)) return;
    if (scopes.some(scope => scope.name === token.text && i >= scope.from && i < scope.to)) return;
    const prev = tokens[i - 1]?.text;
    if (tokens[i + 1]?.text === ':' && (prev === '{' || prev === ',') && enclosingOpener(tokens, i) === '{') return;
    const next = tokens[i + 1]?.text;
    const after = tokens[i + 2];
    const access = (next === '.' || next === '?.') && after?.kind === 'word' ? after.text
      : next === '[' || (next === '?.' && after?.text === '[') ? '[' : undefined;
    reads.push({name: token.text, at: token.start!, access});
  });
  return reads;
}

/** The engine compiles once per identifier; a longer condition gets the coarse scan. */
const MAX_PROBED_IDENTIFIERS = 1000;

/** Whether the engine compiles `body` as a function body, without running it. */
function compiles(body: string): boolean {
  try {
    new Function(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Offsets of the identifiers the engine reads as code in `code`, or undefined
 * when the condition does not compile or is too long to probe. Each identifier
 * is probed by appending `#`: a string, template text, regex or comment stays
 * valid with it, while in code an identifier followed by `#` is always a
 * syntax error.
 */
function engineCodeIdentifiers(code: string, identifiers: RegExpExecArray[]): Set<number> | undefined {
  if (identifiers.length > MAX_PROBED_IDENTIFIERS || !compiles(`return ${code}`)) return undefined;
  const inCode = new Set<number>();
  for (const {index, 0: text} of identifiers) {
    const end = index + text.length;
    if (!compiles(`return ${code.slice(0, end)}#${code.slice(end)}`)) inCode.add(index);
  }
  return inCode;
}

/**
 * Whether a lexing reads as code exactly the identifiers the engine does: a
 * misread regex, string or comment boundary always moves some identifier
 * across it. Regex flags are the one code-side identifier a lexing does not
 * hold as a word.
 */
function agreesWithEngine(tokens: Token[], identifiers: RegExpExecArray[], inCode: Set<number>): boolean {
  const words = new Set(tokens.filter(token => token.kind === 'word').map(token => token.start));
  const flags = tokens.flatMap(token => token.flags ? [token.flags] : []);
  return identifiers.every(({index}) => words.has(index)
    ? inCode.has(index)
    : !inCode.has(index) || flags.some(([from, to]) => index >= from && index < to));
}

/**
 * The conservative reading when the engine cannot confirm a lexing: ASCII
 * identifiers outside naively paired quotes, not written after `.`. Words in
 * regexes, templates and comments read as roots, and a misread quote pair can
 * hide the names between its quotes.
 */
function coarseRootScan(code: string): RootRead[] {
  // Same length, so offsets stay those of `code`.
  const stripped = code.replace(/'[^']*'|"[^"]*"/g, literal => '""'.padEnd(literal.length));
  return [...stripped.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g)]
    .filter(match => !stripped.slice(0, match.index).trim().endsWith('.') && isScopeName(match[0]))
    .map(match => ({name: match[0], at: match.index}));
}

/**
 * The root reads of `text`. Skill placeholders are read and substituted first,
 * as ExpressionEvaluator.evaluate does (also inside quotes), routed by
 * {@link routePlaceholder}: a path reads its root, anything else is JS. Outside placeholders, `text` is
 * JS for an expression and prose for a template.
 */
function readsOf(text: string, prose: boolean): RootReads {
  const reads: RootRead[] = [];
  let exact = true;
  // `at` is where the placeholder's `${` starts; each read keeps its own offset
  // in `text`, so two reads of one name in one placeholder stay apart.
  const readPlaceholder = (inner: string, at: number, whole: boolean) => {
    const bodyAt = at + 2 + inner.length - inner.trimStart().length;
    const route = routePlaceholder(inner, whole);
    if (route.kind === 'path') {
      reads.push({name: route.path.split(/[.[]/)[0], at: bodyAt});
      return;
    }
    const innerReads = readsOf(route.expression, false);
    exact &&= innerReads.exact;
    for (const read of innerReads.reads) reads.push({...read, at: bodyAt + read.at});
  };
  const wholeBody = wholePlaceholderBody(text);
  if (wholeBody !== undefined) {
    readPlaceholder(wholeBody, 0, true);
  } else {
    // A value of the same length keeps every offset that of `text`.
    const code = text.replace(SKILL_PLACEHOLDER, (placeholder: string, inner: string, at: number) => {
      readPlaceholder(inner, at, false);
      return ' 0'.padEnd(placeholder.length);
    });
    if (!prose) {
      const identifiers = identifierMatches(code);
      const inCode = engineCodeIdentifiers(code, identifiers);
      const confirmed = inCode && lexings(code)?.filter(tokens => agreesWithEngine(tokens, identifiers, inCode));
      if (confirmed?.length) {
        reads.push(...confirmed.flatMap(rootsOfLexing));
        exact &&= !confirmed.some(hasUnmodeledScope);
      } else {
        reads.push(...coarseRootScan(code));
        exact = false;
      }
    }
  }
  // Readings the engine confirmed may share an occurrence; keep the first.
  const unique = new Map<string, RootRead>();
  for (const read of reads) {
    const key = `${read.at}:${read.name}`;
    if (!unique.has(key)) unique.set(key, read);
  }
  return {reads: [...unique.values()].sort((a, b) => a.at - b.at), exact};
}

/**
 * Every root read of a Skill condition, in the order written. In the JS,
 * literals, comments, property names, static object keys (`{k: v}`), arrow
 * parameters within their function, reserved words and
 * {@link EXPRESSION_GLOBALS} are not roots; contextual keywords are, since
 * they may be names.
 *
 * Where only parsing could tell a regex from a division, every reading is
 * lexed, and only readings the engine confirms identifier by identifier count;
 * their reads are combined. When the condition does not compile, or no reading
 * is confirmed, {@link coarseRootScan} answers instead and the reads are not
 * exact.
 *
 * The evaluator does not use this: its scope must bind a superset of the
 * names an expression may read, so it scans candidates without lexing.
 */
export function rootReads(expr: string): RootReads {
  return readsOf(expr, false);
}

/** The root reads of a diagnosis or suggestion template: its placeholders; the text around them is prose. */
export function templateRootReads(template: string): RootReads {
  return readsOf(template, true);
}

/**
 * Root names a Skill condition reads ({@link rootReads}), each once, in the
 * order first written: for load-time validation, and for the inputs a fired
 * diagnostic rule cites as evidence.
 */
export function extractRootVariables(expr: string): string[] {
  return [...new Set(rootReads(expr).reads.map(read => read.name))];
}

// =============================================================================
// Diagnostic evidence fields
// =============================================================================

type EvidenceLiteral = string | number | boolean | null;
type EvidenceOperator = '===' | '!==' | '==' | '!=' | '>=' | '<=' | '>' | '<';

export type EvidenceAccess =
  | {kind: 'property'; name: string}
  | {kind: 'index'; index: number}
  | {kind: 'find' | 'filter'; column: string; operator: EvidenceOperator; literal: EvidenceLiteral};

/** A parsed evidence field: `root.data` followed by read-only accesses. */
export interface EvidenceFieldPath {
  root: string;
  accesses: EvidenceAccess[];
}

const IDENT = '[a-zA-Z_][a-zA-Z0-9_]*';
const LITERAL = `-?\\d+(?:\\.\\d+)?|'[^'\\\\]*'|"[^"\\\\]*"|true|false|null`;
const EVIDENCE_ROOT = new RegExp(`^\\s*(${IDENT})\\s*\\??\\.\\s*data(?![\\w$])`);
const EVIDENCE_PREDICATE = new RegExp(
  `^\\??\\.\\s*(find|filter)\\s*\\(\\s*(${IDENT})\\s*=>\\s*\\2\\s*\\.\\s*(${IDENT})\\s*`
  + `(===|!==|==|!=|>=|<=|>|<)\\s*(${LITERAL})\\s*\\)`);
const EVIDENCE_INDEX = /^(?:\?\.)?\[\s*(\d+)\s*\]/;
const EVIDENCE_PROPERTY = new RegExp(`^\\??\\.\\s*(${IDENT})(?![\\w$])`);
/** Inherited members a property access must never reach. */
const EVIDENCE_FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses a diagnostic `evidence_fields` entry. The grammar is the read-only
 * part of the condition dialect the Skills use: `name.data` (or `name?.data`)
 * followed by `.column`, `[n]`, `.length` and `.find(r => r.column OP literal)`
 * / `.filter(...)`, each optionally with `?.`. Anything else, including a call
 * or an assignment, is not an evidence field.
 */
export function parseEvidenceField(field: string): EvidenceFieldPath | undefined {
  const root = field.match(EVIDENCE_ROOT);
  if (!root) return undefined;
  const accesses: EvidenceAccess[] = [];
  let rest = field.slice(root[0].length).trim();
  while (rest) {
    let match: RegExpMatchArray | null;
    if ((match = rest.match(EVIDENCE_PREDICATE))) {
      if (EVIDENCE_FORBIDDEN_PROPERTIES.has(match[3])) return undefined;
      accesses.push({kind: match[1] as 'find' | 'filter', column: match[3],
        operator: match[4] as EvidenceOperator, literal: parseEvidenceLiteral(match[5])});
    } else if ((match = rest.match(EVIDENCE_INDEX))) {
      accesses.push({kind: 'index', index: Number(match[1])});
    } else if ((match = rest.match(EVIDENCE_PROPERTY)) && !EVIDENCE_FORBIDDEN_PROPERTIES.has(match[1])) {
      accesses.push({kind: 'property', name: match[1]});
    } else {
      return undefined;
    }
    rest = rest.slice(match[0].length).trim();
  }
  return {root: root[1], accesses};
}

export function parseEvidenceLiteral(text: string): EvidenceLiteral {
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === 'null') return null;
  if (text.startsWith("'") || text.startsWith('"')) return text.slice(1, -1);
  return Number(text);
}

/**
 * Reads an evidence field from `data`, the value `root.data` holds. It walks
 * plain data only: every read is an own data property (no getter, nothing
 * inherited, no function value), `find`/`filter` iterate the rows by index
 * instead of calling the array's methods, and a predicate compares scalars
 * only, so no conversion runs. Every access is null-safe.
 */
export function readEvidenceField(path: EvidenceFieldPath, data: unknown): unknown {
  let value = data;
  for (const access of path.accesses) {
    if (value === null || value === undefined) return undefined;
    switch (access.kind) {
      case 'index':
        value = Array.isArray(value) ? ownDataValue(value, String(access.index)) : undefined;
        break;
      case 'property':
        value = typeof value === 'string' && access.name === 'length'
          ? value.length
          : ownDataValue(value, access.name);
        break;
      default: {
        if (!Array.isArray(value)) return undefined;
        const rows: unknown[] = [];
        for (let index = 0; index < value.length && !(access.kind === 'find' && rows.length > 0); index++) {
          const row = ownDataValue(value, String(index));
          if (matchesEvidencePredicate(ownDataValue(row, access.column), access.operator, access.literal)) rows.push(row);
        }
        value = access.kind === 'find' ? rows[0] : rows;
      }
    }
  }
  return value;
}

/** An own data property that is not a function; undefined otherwise. Never runs a getter. */
export function ownDataValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value !== 'function' ? descriptor.value : undefined;
}

/** Compares a scalar column with the literal; an object, array or missing value never matches. */
function matchesEvidencePredicate(left: unknown, operator: EvidenceOperator, right: EvidenceLiteral): boolean {
  if (left !== null && typeof left === 'object') return false;
  if (left === undefined || typeof left === 'function' || typeof left === 'symbol') return false;
  const l = left as string | number | boolean | bigint | null;
  const r = right as any;
  switch (operator) {
    case '===': return l === right;
    case '!==': return l !== right;
    case '==': return l == right;
    case '!=': return l != right;
    case '>=': return (l as any) >= r;
    case '<=': return (l as any) <= r;
    case '>': return (l as any) > r;
    case '<': return (l as any) < r;
  }
}
