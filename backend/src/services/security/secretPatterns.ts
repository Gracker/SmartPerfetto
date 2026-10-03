// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import {decodeHTML, decodeHTMLAttribute} from 'entities';

/**
 * The one credential detector for source, knowledge and question text. It
 * marks credential values only, never their keys or the code around them, and
 * a redaction keeps every line break, so line numbers and identifiers an
 * analysis reads stay intact.
 *
 * Detection follows the text's syntax and never stops at a fixed window or
 * length: whatever an explicit credential context assigns is read to its real
 * end, and a value that never ends is withheld to the end of the text.
 *
 * - Code is tokenized per language (string literals with their quoting,
 *   escapes, raw and multi-line forms; character and regular-expression
 *   literals; comments). In code a secret can only be a string literal. After
 *   a credential-named key every string literal of the assigned expression is
 *   withheld, except a literal that is exactly one variable reference, a
 *   credential name a subscript or an environment lookup reads
 *   (`getenv("API_TOKEN")`) and the type name of a `typeof` check. Keys reach
 *   their values across whitespace and comments, as a target list or
 *   destructuring pattern, as a call argument or a member access
 *   (`.password = …`, `builder().password(…)`), and as a C macro. Every
 *   literal of a credential getter's body is withheld.
 * - A config value is read to its end the way the format reads it before it
 *   is judged; config text is also read as data.
 * - Markup is scanned as tags, attributes, text and CDATA: a credential-named
 *   attribute or element, or an element a `name`/`key` attribute or plist
 *   `<key>` names as one, has its value withheld.
 * - Literal contents are read as data, comments and plain text as prose.
 *
 * Keyed rules (credential key, `Bearer`/`Basic`, known token prefix, JWT, PEM
 * private key) run independently; the keyless random-blob rule is a heuristic
 * with known misses and never exempts what a keyed rule found.
 *
 * Public artifacts keep the broad legacy rules on top
 * (`redactSecretsForPublicArtifact`), where over-redaction costs nothing.
 */

export type CredentialSyntax = 'code' | 'config' | 'markup' | 'text';

type Language =
  | 'c' | 'cpp' | 'java' | 'kotlin' | 'go' | 'rust' | 'swift' | 'js' | 'python' | 'groovy' | 'dart'
  | 'shell' | 'dotenv' | 'make' | 'cmake' | 'yaml' | 'properties' | 'ini' | 'toml' | 'xml' | 'text';

/**
 * How a reader takes a lone carriage return (one not before a line feed): as
 * a line break, or as a character of whatever it stands in (a shell word, a
 * make value, a Go string), white space where it stands between tokens.
 */
type LoneCarriageReturn = 'line-break' | 'character';

/** One way a format's readers read it. */
interface FormatReading {
  readonly language: Language;
  readonly loneCarriageReturn: LoneCarriageReturn;
}

export interface CredentialContext {
  readonly syntax: CredentialSyntax;
  /** The format's language, that of its first reading. */
  readonly language: Language;
  /** Every way the format's readers read it; what any of them reads as a credential is withheld. */
  readonly readings: readonly FormatReading[];
}

/**
 * A context and the language one of its readings reads it in; `keyless`
 * false leaves out the keyless random-blob heuristic (owner text).
 */
type LanguageContext = Pick<CredentialContext, 'syntax' | 'language'> & {readonly keyless?: boolean};

function credentialContext(syntax: CredentialSyntax, ...readings: Array<[Language, LoneCarriageReturn]>): CredentialContext {
  return Object.freeze({
    syntax,
    language: readings[0][0],
    readings: Object.freeze(readings.map(([language, loneCarriageReturn]) => Object.freeze({language, loneCarriageReturn}))),
  });
}

/** Prose, questions and model output: no file syntax is known. */
export const TEXT_CREDENTIAL_CONTEXT: CredentialContext = credentialContext('text', ['text', 'line-break']);

// Each file type with the readers that read it. A lone carriage return ends a
// line for the C family, Java, Kotlin, Swift, JavaScript, Python, Groovy,
// Dart, YAML, Java properties, configparser reading a file, TOML (which allows
// it nowhere) and XML. It is a character for a shell, make, CMake (white space between
// arguments, text in quotes, part of a comment) and Go and Rust (kept in a
// string, part of a comment). Where readers disagree every reading counts:
// dotenv libraries split `.env` lines at it and read values their own way, a
// shell sourcing the file does neither; configparser reading a string keeps
// it; protoc, the AIDL compiler and the Android init and SELinux policy
// tokenizers take it for white space. Generic `.conf` and `.cfg` files are
// often configparser's, so they are also read as INI.
const CONTEXT_BY_EXTENSION: Readonly<Record<string, CredentialContext>> = (() => {
  const table: Record<string, CredentialContext> = {};
  const add = (extensions: string[], context: CredentialContext) => {
    for (const extension of extensions) table[extension] = context;
  };
  add(['.c', '.h', '.m'], credentialContext('code', ['c', 'line-break']));
  add(['.aidl', '.proto'], credentialContext('code', ['c', 'line-break'], ['c', 'character']));
  add(['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.mm'], credentialContext('code', ['cpp', 'line-break']));
  add(['.java'], credentialContext('code', ['java', 'line-break']));
  add(['.kt', '.kts'], credentialContext('code', ['kotlin', 'line-break']));
  add(['.go', '.bp'], credentialContext('code', ['go', 'character']));
  add(['.rs'], credentialContext('code', ['rust', 'character']));
  add(['.swift'], credentialContext('code', ['swift', 'line-break']));
  add(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], credentialContext('code', ['js', 'line-break']));
  add(['.py'], credentialContext('code', ['python', 'line-break']));
  add(['.gradle'], credentialContext('code', ['groovy', 'line-break']));
  add(['.dart'], credentialContext('code', ['dart', 'line-break']));
  add(['.sh', '.bash', '.zsh'], credentialContext('config', ['shell', 'character']));
  add(['.env'], credentialContext('config', ['shell', 'character'], ['dotenv', 'line-break']));
  add(['.mk'], credentialContext('config', ['make', 'character']));
  add(['.cmake'], credentialContext('config', ['cmake', 'character']));
  add(['.yaml', '.yml'], credentialContext('config', ['yaml', 'line-break']));
  add(['.properties', '.prop'], credentialContext('config', ['properties', 'line-break']));
  add(['.conf', '.cfg'], credentialContext('config', ['properties', 'line-break'], ['ini', 'line-break'], ['ini', 'character']));
  add(['.rc', '.te'], credentialContext('config', ['properties', 'line-break'], ['properties', 'character']));
  add(['.ini'], credentialContext('config', ['ini', 'line-break'], ['ini', 'character']));
  add(['.toml'], credentialContext('config', ['toml', 'line-break']));
  add(['.xml', '.plist'], credentialContext('markup', ['xml', 'line-break']));
  return table;
})();

// Files a build system names in full rather than by extension.
const CONTEXT_BY_NAME: Readonly<Record<string, CredentialContext>> = {
  'makefile': CONTEXT_BY_EXTENSION['.mk'],
  'gnumakefile': CONTEXT_BY_EXTENSION['.mk'],
  'cmakelists.txt': CONTEXT_BY_EXTENSION['.cmake'],
};

export function credentialContextForPath(filePath: string | undefined): CredentialContext {
  if (!filePath) return TEXT_CREDENTIAL_CONTEXT;
  const base = path.basename(filePath);
  if (/^\.env(?:\.|$)/i.test(base)) return CONTEXT_BY_EXTENSION['.env'];
  return CONTEXT_BY_NAME[base.toLowerCase()] ?? CONTEXT_BY_EXTENSION[path.extname(base).toLowerCase()]
    ?? TEXT_CREDENTIAL_CONTEXT;
}

// A key names a credential when, with quotes and separators removed and
// lowercased, it ends in one of these: `api_key`, `apiKey`, `X-Api-Key`,
// `--password`, `setPassword` and `GITHUB_TOKEN` all qualify, and every
// literal they are given is withheld. `credentials` (fetch options), a bare
// `key` and the plural `tokens` (lexer output) are too common to count.
const CREDENTIAL_KEY_SUFFIXES = [
  'secret', 'password', 'passwd', 'passphrase', 'pwd', 'apikey', 'accesskey', 'secretkey',
  'privatekey', 'signingkey', 'clientsecret', 'authkey', 'encryptionkey', 'masterkey',
  'secrets', 'passwords', 'passwds', 'apikeys', 'privatekeys',
] as const;
// Tokens a domain names that are not credentials: Android and Perfetto frame,
// window and binder tokens, lexer and parser tokens, model stream tokens, and
// lease, lock and cancellation tokens. Any other key ending in `token`
// (`authToken`, `GITHUB_TOKEN`, a bare `token`) names a credential, and so
// does a domain's token an authentication word qualifies (`AUTH_PURPOSE`).
const DOMAIN_TOKEN_SUFFIXES = [
  'frametoken', 'windowtoken', 'activitytoken', 'bindertoken', 'layertoken', 'displaytoken', 'surfacetoken', 'inputtoken',
  'focustoken', 'transitiontoken', 'vsynctoken', 'tasktoken',
  'nexttoken', 'prevtoken', 'previoustoken', 'lookaheadtoken', 'starttoken', 'endtoken', 'eoftoken', 'lexertoken',
  'parsertoken', 'sqltoken', 'syntaxtoken', 'typetoken', 'keywordtoken', 'identifiertoken', 'stringtoken', 'numbertoken',
  'operatortoken', 'ignoretoken', 'prooftoken',
  'answertoken', 'drafttoken', 'streamtoken', 'outputtoken', 'stoptoken', 'eostoken', 'bostoken', 'padtoken', 'unktoken',
  'specialtoken',
  'leasetoken', 'fencetoken', 'locktoken', 'ownertoken', 'synctoken', 'cancellationtoken', 'canceltoken', 'aborttoken',
  'continuationtoken', 'pagetoken', 'idempotencytoken',
] as const;

// A word that gives a domain's token an authentication purpose
// (`authInputToken`, `accessPageToken`, `SESSION_SYNC_TOKEN`, `otpInputToken`,
// `resetPageToken`). Judged per word, so `map` in `mapInputToken` is not `api`
// and `accessibility` is not `access`; a key written as one word
// (`authinputtoken`) is one word here.
const AUTH_PURPOSE = new RegExp(String.raw`auth|access(?!ib)|refresh|session|bearer|csrf|xsrf|jwt|oidc|saml|login|logon|signin|signon|` +
  String.raw`cred|security|secret|passw|passphrase|passcode|recover|verif|invite|magic|` +
  String.raw`^(?:api|sso|pwd|otp|totp|hotp|mfa|2fa|reset)|(?:api|sso|pwd|otp|mfa|2fa)$`);
// Two words that name a purpose together: `signIn`, `log_in`, `pass_word`.
const AUTH_COMPOUND = /^(?:sign(?:in|on)|log(?:in|on)|pass(?:word|wd|phrase|code))$/;

/** A key's words, lowercased: `authInputToken`, `AUTH_INPUT_TOKEN` and `auth-input-token` are `auth input token`. */
function keyWords(key: string): string[] {
  // Lookaheads only, so a long run of capitals stays linear.
  return key.replace(/[a-z\d](?=[A-Z])|[A-Z](?=[A-Z][a-z])/g, '$& ').toLowerCase().split(/[^a-z\d]+/)
    .filter(word => word.length > 0);
}

/**
 * `strong`: the key names a credential, and every literal it is given is
 * withheld. `weak`: it names a domain's token (`DOMAIN_TOKEN_SUFFIXES`) and no
 * word of it an authentication purpose, so a value it is given is withheld
 * only when it looks like a credential (`credentialShaped`).
 */
type KeyStrength = 'strong' | 'weak';

function keyStrength(key: string): KeyStrength | undefined {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return undefined;
  if (CREDENTIAL_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'strong';
  if (!normalized.endsWith('token')) return undefined;
  if (!DOMAIN_TOKEN_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'strong';
  const words = keyWords(key);
  const purpose = words.some((word, index) => AUTH_PURPOSE.test(word) || AUTH_COMPOUND.test(word + (words[index + 1] ?? '')));
  return purpose ? 'strong' : 'weak';
}

/**
 * A key written as words (`API Key`, `db password`) names a credential when
 * the phrase does or its last word does, and as strongly as the stronger:
 * `frame token` is as strong as a bare `token`.
 */
function phraseStrength(key: string): KeyStrength | undefined {
  const words = key.trim().split(/\s+/);
  return words.length > 1 ? stronger(keyStrength(key), keyStrength(words[words.length - 1])) : keyStrength(key);
}

export function isCredentialKey(key: string): boolean {
  return phraseStrength(key) !== undefined;
}

/** The stronger of two strengths. */
function stronger(left: KeyStrength | undefined, right: KeyStrength | undefined): KeyStrength | undefined {
  return left === 'strong' || right === 'strong' ? 'strong' : left ?? right;
}

export interface CredentialSpan {
  start: number;
  end: number;
}

/** `target.push(...source)` without the engine's argument-count limit. */
function append<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}

// The last line end found: readers that ask again from further along one long
// line (every key a shell line holds) search it once.
let lastLineEnd: {readonly text: string; readonly from: number; readonly at: number} | undefined;

function lineEndFrom(text: string, index: number): number {
  if (lastLineEnd?.text === text && index >= lastLineEnd.from && index <= lastLineEnd.at) return lastLineEnd.at;
  const newline = text.indexOf('\n', index);
  const at = newline < 0 ? text.length : newline;
  lastLineEnd = {text, from: index, at};
  return at;
}

/** Where a sticky pattern matching at `index` ends, or undefined. */
function stickyAt(pattern: RegExp, text: string, index: number): number | undefined {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match ? index + match[0].length : undefined;
}

function oddBackslashesAtEnd(value: string): boolean {
  let count = 0;
  while (count < value.length && value[value.length - 1 - count] === '\\') count++;
  return count % 2 === 1;
}

// ---------------------------------------------------------------------------
// Tokens

/**
 * `character` (`'x'`) and `regex` (`/"/`) literals are read only so a quote
 * inside them does not open a string; neither holds a secret.
 */
type TokenKind = 'literal' | 'character' | 'regex' | 'comment';
type Interpolation = 'none' | 'dollar' | 'js' | 'python' | 'shell' | 'spring';

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  /**
   * Exclusive. An unterminated literal ends where its reader stopped: a
   * single-line one at its first unescaped line break, any other at the end
   * of the text.
   */
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly terminated: boolean;
  /** How the literal interpolates, for the "exactly one reference" exemption. */
  readonly interpolation: Interpolation;
}

interface QuotedOptions {
  readonly escapes: boolean;
  readonly multiline: boolean;
  readonly interpolation: Interpolation;
  /** YAML single quotes write a quote as two quotes. */
  readonly doubledQuote?: boolean;
}

interface QuotedOpening {
  readonly quote: string;
  readonly options: QuotedOptions;
}

interface TokenRule {
  /** Sticky: matches the opening at the scan position. */
  readonly open: RegExp;
  /** Offered only where an expression can start: a JS regular expression, a Groovy slashy string. */
  readonly expressionStart?: boolean;
  /** Offered only where this holds: a shell comment starts a word (`${#array[@]}`, `a\ #b` have none). */
  readonly after?: (text: string, index: number) => boolean;
  /** A quoted literal, read on the shared literal stack with its quote, escapes and interpolation. */
  readonly quoted?: (open: RegExpExecArray) => QuotedOpening;
  /** Any other token, read whole. */
  readonly read?: (text: string, start: number, open: RegExpExecArray) => Token | undefined;
}

function stickyMatch(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** A literal frame on the reader's stack: its quote and, inside an interpolation, the code there. */
interface LiteralFrame {
  readonly quote: string;
  readonly options: QuotedOptions;
  /** Bracket depth of the interpolation the reader is in; 0 in the literal's own text. */
  depth: number;
  /** The interpolation's expression state, for `/`; set while `depth > 0`. */
  state?: ExpressionState;
}

/**
 * The token a language rule opens at `index` inside an interpolation: a frame
 * for a nested literal, or a whole token (comment, raw string, character,
 * regular expression).
 */
function openNested(text: string, index: number, rules: readonly TokenRule[], state: ExpressionState):
  {frame: LiteralFrame; contentStart: number} | {token: Token} | undefined {
  for (const rule of rules) {
    if (rule.expressionStart && !state.expressionCanStart()) continue;
    if (rule.after && !rule.after(text, index)) continue;
    const open = stickyMatch(rule.open, text, index);
    if (!open) continue;
    if (rule.quoted) {
      const opening = rule.quoted(open);
      return {frame: {quote: opening.quote, options: opening.options, depth: 0}, contentStart: index + open[0].length};
    }
    const token = rule.read!(text, index, open);
    if (token) return {token};
  }
  return undefined;
}

/**
 * A quoted literal read up to `limit`: its quote closes it, `\` escapes when
 * `escapes` (an escaped line break continues a single-line literal), and an
 * interpolation (`${…}`, `$(…)`, an f-string `{…}`) holds code, read with the
 * language's own `rules` and the same expression state as top-level code
 * (keywords, control conditions) so a quote there does not close the literal.
 * Nested literals are kept on an explicit stack, so any depth reads in one
 * pass; a nested single-line literal a line break leaves open ends there.
 */
function readQuoted(text: string, start: number, openLength: number, opening: QuotedOpening,
  rules: readonly TokenRule[] = [], limit = text.length): Token {
  const contentStart = start + openLength;
  const frames: LiteralFrame[] = [{quote: opening.quote, options: opening.options, depth: 0}];
  // A nested literal ended at `index`: an operand in the interpolation around it.
  const endNested = (index: number) => {
    frames.pop();
    frames[frames.length - 1].state?.operand(index);
  };
  let index = contentStart;
  for (; index < limit; index++) {
    const frame = frames[frames.length - 1];
    const char = text[index];
    // A single-line literal ends at a raw line break, inside an interpolation
    // too (malformed or excerpted code); the parent then reads the same break.
    if (char === '\n' && !frame.options.multiline) {
      if (frames.length === 1) break;
      endNested(index);
      index--;
      continue;
    }
    if (frame.depth > 0) {
      if (/\s/.test(char)) continue;
      const state = frame.state!;
      const nested = openNested(text, index, rules, state);
      if (nested && 'frame' in nested) {
        frames.push(nested.frame);
        index = nested.contentStart - 1;
        continue;
      }
      if (nested) {
        index = Math.max(index, nested.token.end - 1);
        state.token(nested.token);
        continue;
      }
      if (char === '{' || char === '(' || char === '[') frame.depth++;
      else if (char === '}' || char === ')' || char === ']') frame.depth--;
      if (frame.depth > 0) state.character(char, index);
      else frame.state = undefined;
      continue;
    }
    if (frame.options.escapes && char === '\\') { index++; continue; }
    if (frame.options.doubledQuote && char === frame.quote && text[index + 1] === frame.quote) { index++; continue; }
    if (text.startsWith(frame.quote, index) && index + frame.quote.length <= limit) {
      if (frames.length === 1) {
        return {kind: 'literal', start, end: index + frame.quote.length, contentStart, contentEnd: index, terminated: true,
          interpolation: opening.options.interpolation};
      }
      index += frame.quote.length - 1;
      endNested(index);
      continue;
    }
    const interpolation = frame.options.interpolation;
    if (interpolation === 'python' && char === '{') {
      if (text[index + 1] === '{') { index++; continue; } // `{{` is a literal brace
      frame.depth = 1;
      frame.state = new ExpressionState(text);
      continue;
    }
    const dollarOpens = interpolation === 'js' || interpolation === 'dollar' || interpolation === 'shell';
    if (dollarOpens && char === '$' && (text[index + 1] === '{' || (interpolation === 'shell' && text[index + 1] === '('))) {
      frame.depth = 1;
      frame.state = new ExpressionState(text);
      index++;
    }
  }
  const end = Math.min(index, limit);
  return {kind: 'literal', start, end, contentStart, contentEnd: end, terminated: false,
    interpolation: opening.options.interpolation};
}

function readUntil(text: string, start: number, openLength: number, close: string, kind: TokenKind): Token {
  const contentStart = start + openLength;
  const closeAt = text.indexOf(close, contentStart);
  const terminated = closeAt >= 0;
  const contentEnd = terminated ? closeAt : text.length;
  return {kind, start, end: terminated ? closeAt + close.length : text.length, contentStart, contentEnd, terminated,
    interpolation: 'none'};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, character => `\\${character}`);
}

const lineComment = (marker: string, after?: (text: string, index: number) => boolean): TokenRule => ({
  open: new RegExp(escapeRegExp(marker), 'y'),
  after,
  read: (text, start) => {
    const end = lineEndFrom(text, start);
    return {kind: 'comment', start, end, contentStart: start + marker.length, contentEnd: end, terminated: true,
      interpolation: 'none'};
  },
});
const blockComment: TokenRule = {open: /\/\*/y, read: (text, start) => readUntil(text, start, 2, '*/', 'comment')};
const charLiteral: TokenRule = {
  open: /'(?:\\(?:u\{?[0-9A-Fa-f]{1,6}\}?|x[0-9A-Fa-f]{1,2}|[^\n])|[^'\\\n])'/y,
  read: (_text, start, open) => ({kind: 'character', start, end: start + open[0].length, contentStart: start + 1,
    contentEnd: start + open[0].length - 1, terminated: true, interpolation: 'none'}),
};
const quoted = (quote: string, options: QuotedOptions, prefix = ''): TokenRule => ({
  open: new RegExp(`${prefix}${escapeRegExp(quote)}`, 'y'),
  quoted: () => ({quote, options}),
});
const cppRawString: TokenRule = {
  // The standard limits the delimiter to 16 characters.
  open: /(?:u8|u|U|L)?R"([^()\\\s"]{0,16})\(/y,
  read: (text, start, open) => readUntil(text, start, open[0].length, `)${open[1]}"`, 'literal'),
};
const rustRawString: TokenRule = {
  open: /b?r(#*)"/y,
  read: (text, start, open) => readUntil(text, start, open[0].length, `"${open[1]}`, 'literal'),
};
const swiftRawString: TokenRule = {
  open: /(?<!#)(#+)("""|")/y,
  read: (text, start, open) => readUntil(text, start, open[0].length, `${open[2]}${open[1]}`, 'literal'),
};
// CMake's bracket argument and bracket comment: `[[…]]`, `[=[…]=]`, `#[[…]]`.
const cmakeBracketArgument: TokenRule = {
  open: /\[(=*)\[/y,
  read: (text, start, open) => readUntil(text, start, open[0].length, `]${open[1]}]`, 'literal'),
};
const cmakeBracketComment: TokenRule = {
  open: /#\[(=*)\[/y,
  read: (text, start, open) => readUntil(text, start, open[0].length, `]${open[1]}]`, 'comment'),
};
const pythonString: TokenRule = {
  open: /([rRbBuUfF]{0,2})("""|'''|"|')/y,
  quoted: open => {
    const prefix = open[1].toLowerCase();
    return {quote: open[2], options: {
      escapes: !prefix.includes('r'),
      multiline: open[2].length === 3,
      interpolation: prefix.includes('f') ? 'python' : 'none',
    }};
  },
};
/** A JS regular-expression literal. */
const jsRegex: TokenRule = {
  open: /\/(?![/*])/y,
  expressionStart: true,
  read: (text, start) => {
    let inClass = false;
    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];
      if (char === '\n') return undefined;
      if (char === '\\') { index++; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        const flags = /^[a-z]*/.exec(text.slice(index + 1, index + 9))![0];
        return {kind: 'regex', start, end: index + 1 + flags.length, contentStart: start + 1, contentEnd: index,
          terminated: true, interpolation: 'none'};
      }
    }
    return undefined;
  },
};
/** Groovy's slashy (`/…/`) and dollar-slashy (`$/…/$`) strings. */
const groovySlashy: TokenRule = {
  open: /\/(?![/*])/y,
  expressionStart: true,
  quoted: () => ({quote: '/', options: {escapes: true, multiline: true, interpolation: 'dollar'}}),
};
const groovyDollarSlashy: TokenRule = {
  open: /\$\//y,
  quoted: () => ({quote: '/$', options: {escapes: false, multiline: true, interpolation: 'dollar'}}),
};

const ESCAPED: QuotedOptions = {escapes: true, multiline: false, interpolation: 'none'};
// What ends an unquoted shell word: a metacharacter, that is a blank (a space
// or a tab), a line feed or one of `;&|()<>`. Nothing else is white space to a
// shell: a carriage return, a vertical tab or a no-break space is part of the word.
const SHELL_WORD_END = /[ \t\n;&|()<>]/;
/** Whether a shell word starts at `index`: at the start, or after a metacharacter (`SHELL_WORD_END`) no `\` escapes. */
function startsShellWord(text: string, index: number): boolean {
  if (index === 0) return true;
  if (!SHELL_WORD_END.test(text[index - 1])) return false;
  let backslashes = 0;
  while (index - 2 - backslashes >= 0 && text[index - 2 - backslashes] === '\\') backslashes++;
  return backslashes % 2 === 0;
}
const C_COMMENTS = [lineComment('//'), blockComment];
const HASH_COMMENT = lineComment('#');
const RAW_DART = (quote: string, multiline: boolean): TokenRule =>
  quoted(quote, {escapes: false, multiline, interpolation: 'none'}, 'r');

/** Ordered: the first rule that opens at a position reads the token. Markup has its own scanner. */
const TOKEN_RULES: Readonly<Record<Language, readonly TokenRule[]>> = {
  c: [...C_COMMENTS, charLiteral, quoted('"', ESCAPED)],
  cpp: [...C_COMMENTS, cppRawString, charLiteral, quoted('"', ESCAPED, '(?:u8|u|U|L)?')],
  java: [...C_COMMENTS, quoted('"""', {escapes: true, multiline: true, interpolation: 'none'}), charLiteral, quoted('"', ESCAPED)],
  kotlin: [...C_COMMENTS, quoted('"""', {escapes: false, multiline: true, interpolation: 'dollar'}), charLiteral,
    quoted('"', {escapes: true, multiline: false, interpolation: 'dollar'})],
  go: [...C_COMMENTS, charLiteral, quoted('`', {escapes: false, multiline: true, interpolation: 'none'}), quoted('"', ESCAPED)],
  rust: [...C_COMMENTS, rustRawString, charLiteral, quoted('"', {escapes: true, multiline: true, interpolation: 'none'}, 'b?')],
  swift: [...C_COMMENTS, swiftRawString, quoted('"""', {escapes: true, multiline: true, interpolation: 'none'}),
    quoted('"', ESCAPED)],
  js: [...C_COMMENTS, quoted('`', {escapes: true, multiline: true, interpolation: 'js'}), quoted('"', ESCAPED),
    quoted('\'', ESCAPED), jsRegex],
  python: [HASH_COMMENT, pythonString],
  groovy: [...C_COMMENTS, quoted('"""', {escapes: true, multiline: true, interpolation: 'dollar'}),
    quoted('\'\'\'', {escapes: true, multiline: true, interpolation: 'none'}),
    quoted('"', {escapes: true, multiline: false, interpolation: 'dollar'}), quoted('\'', ESCAPED),
    groovyDollarSlashy, groovySlashy],
  dart: [...C_COMMENTS, RAW_DART('"""', true), RAW_DART('\'\'\'', true), RAW_DART('"', false), RAW_DART('\'', false),
    quoted('"""', {escapes: true, multiline: true, interpolation: 'dollar'}),
    quoted('\'\'\'', {escapes: true, multiline: true, interpolation: 'dollar'}),
    quoted('"', {escapes: true, multiline: false, interpolation: 'dollar'}),
    quoted('\'', {escapes: true, multiline: false, interpolation: 'dollar'})],
  // Make has no quoting: a quote is an ordinary character passed on to the shell.
  make: [HASH_COMMENT],
  cmake: [cmakeBracketComment, HASH_COMMENT, cmakeBracketArgument,
    quoted('"', {escapes: true, multiline: true, interpolation: 'dollar'})],
  // `$'…'` takes escapes (`\'` does not close it); `'…'` does not.
  shell: [lineComment('#', startsShellWord), quoted('"', {escapes: true, multiline: true, interpolation: 'shell'}),
    quoted('\'', {escapes: true, multiline: true, interpolation: 'none'}, '\\$'),
    quoted('\'', {escapes: false, multiline: true, interpolation: 'none'})],
  // dotenv quotes only a whole value (`dotenvValue`); a `#` starts a comment line.
  dotenv: [lineComment('#')],
  yaml: [HASH_COMMENT, quoted('"', {escapes: true, multiline: true, interpolation: 'spring'}),
    quoted('\'', {escapes: false, multiline: true, interpolation: 'spring', doubledQuote: true})],
  properties: [lineComment('#'), lineComment('!')],
  ini: [lineComment('#'), lineComment(';'), quoted('"', ESCAPED)],
  toml: [HASH_COMMENT, quoted('"""', {escapes: true, multiline: true, interpolation: 'none'}),
    quoted('\'\'\'', {escapes: false, multiline: true, interpolation: 'none'}), quoted('"', ESCAPED),
    quoted('\'', {escapes: false, multiline: false, interpolation: 'none'})],
  xml: [],
  text: [],
};

/** Config formats whose comments start a line; a `#` inside a value is data. */
const LINE_START_COMMENTS = new Set<Language>(['properties', 'ini', 'dotenv']);
const OPENING_CHARACTER = /["'`/#!;$[bBrRuUfFL]/;
// A `/` starts a regular expression (a Groovy slashy string) only where an expression can start.
const REGEX_ALLOWED_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'instanceof', 'yield', 'await', 'default']);
// `if (…) /re/`: a regular expression may start after a control statement's condition.
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

const PAREN = 1;
const SQUARE = 2;
const BRACE = 3;
const BRACKET_CODE: Readonly<Record<string, number>> = {'(': PAREN, '[': SQUARE, '{': BRACE};

/**
 * What a `/` depends on: whether an expression can start where it stands, so
 * it opens a regular expression (or a Groovy slashy string) rather than
 * divides. Top-level code and every interpolation keep one, fed each
 * significant character and token: the last one, the identifier it ends
 * (`return /re/`), and open brackets, a `(` recording whether it holds a
 * control statement's condition (`if (…) /re/`).
 */
class ExpressionState {
  last = '';
  lastAt = -1;
  readonly brackets: Array<{readonly at: number; readonly control: boolean}> = [];
  private wordStart = -1;
  private wordEnd = -1;
  private wordAfterDot = false;
  private previousWord = '';
  private afterControlCondition = false;

  constructor(private readonly text: string) {}

  /** A significant character; for a closing bracket, where the bracket it closes opened. */
  character(char: string, index: number): number | undefined {
    this.afterControlCondition = false;
    let opened: number | undefined;
    if (/[\w$]/.test(char)) {
      if (this.wordEnd !== index) {
        this.previousWord = this.word();
        this.wordStart = index;
        this.wordAfterDot = this.last === '.';
      }
      this.wordEnd = index + 1;
    } else if (char === '(' || char === '[' || char === '{') {
      const word = char === '(' ? this.word() : '';
      this.brackets.push({at: index, control: CONTROL_KEYWORDS.has(word) || (word === 'await' && this.previousWord === 'for')});
    } else if (char === ')' || char === ']' || char === '}') {
      const bracket = this.brackets.pop();
      opened = bracket?.at;
      this.afterControlCondition = char === ')' && bracket?.control === true;
    }
    this.last = char;
    this.lastAt = index;
    return opened;
  }

  /** A token read whole; a comment changes nothing. */
  token(token: Token): void {
    if (token.kind !== 'comment') this.operand(token.end - 1);
  }

  /** An operand (a literal, a regular expression) ended at `index`. */
  operand(index: number): void {
    this.last = this.text[index];
    this.lastAt = index;
    this.afterControlCondition = false;
  }

  expressionCanStart(): boolean {
    if (this.lastAt < 0 || REGEX_ALLOWED_AFTER.test(this.last)) return true;
    if (this.last === ')') return this.afterControlCondition;
    if (this.last === '.') return this.text.startsWith('...', this.lastAt - 2);
    return REGEX_KEYWORDS.has(this.word());
  }

  /** The identifier the last significant character ends, unless a `.` comes before it. */
  private word(): string {
    return this.wordEnd === this.lastAt + 1 && this.wordEnd > 0 && !this.wordAfterDot
      ? this.text.slice(this.wordStart, this.wordEnd) : '';
  }
}

/** Code read once: its tokens and, in code syntax, where its brackets open and close. */
interface CodeScan {
  readonly tokens: Token[];
  /** For each position, where the innermost bracket around it opens, or -1. */
  readonly enclosingOpen: Int32Array;
  /** For each opening bracket, the position of its match, or -1. */
  readonly closeOf: Int32Array;
}

/** The kind of the innermost bracket around `position`: 0, `PAREN`, `SQUARE` or `BRACE`. */
function enclosingBracket(text: string, scan: CodeScan, position: number): number {
  const open = scan.enclosingOpen[position];
  return open < 0 ? 0 : BRACKET_CODE[text[open]];
}

function tokenize(text: string, context: LanguageContext): CodeScan {
  const rules = TOKEN_RULES[context.language];
  const tracksBrackets = context.syntax === 'code';
  const enclosingOpen = new Int32Array(tracksBrackets ? text.length : 0).fill(-1);
  const closeOf = new Int32Array(tracksBrackets ? text.length : 0).fill(-1);
  const tokens: Token[] = [];
  if (rules.length === 0) return {tokens, enclosingOpen, closeOf};
  const state = new ExpressionState(text);
  let lineHasContent = false;
  const innermost = () => state.brackets.length > 0 ? state.brackets[state.brackets.length - 1].at : -1;
  const significant = (char: string, index: number) => {
    if (/\s/.test(char)) return;
    const opened = state.character(char, index);
    if (opened !== undefined && tracksBrackets) closeOf[opened] = index;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (tracksBrackets) enclosingOpen[index] = innermost();
    if (char === '\n') { lineHasContent = false; continue; }
    const startsLine = !lineHasContent;
    if (!/\s/.test(char)) lineHasContent = true;
    if (!OPENING_CHARACTER.test(char)) { significant(char, index); continue; }
    // A string prefix (`b"…"`, `R"(…)"`) never starts inside an identifier.
    if (/[bBrRuUfFL]/.test(char) && index > 0 && /[\w$]/.test(text[index - 1])) { significant(char, index); continue; }
    if (LINE_START_COMMENTS.has(context.language) && (char === '#' || char === '!' || char === ';') && !startsLine) {
      significant(char, index);
      continue;
    }
    let read: Token | undefined;
    for (const rule of rules) {
      if (rule.expressionStart && !state.expressionCanStart()) continue;
      if (rule.after && !rule.after(text, index)) continue;
      const open = stickyMatch(rule.open, text, index);
      if (!open) continue;
      read = rule.quoted ? readQuoted(text, index, open[0].length, rule.quoted(open), rules) : rule.read!(text, index, open);
      if (read) break;
    }
    if (!read) { significant(char, index); continue; }
    tokens.push(read);
    if (tracksBrackets) enclosingOpen.fill(innermost(), read.start, read.end);
    state.token(read);
    index = Math.max(index, read.end - 1);
  }
  return {tokens, enclosingOpen, closeOf};
}

function tokenAt(tokens: readonly Token[], index: number): Token | undefined {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const token = tokens[middle];
    if (index < token.start) high = middle - 1;
    else if (index >= token.end) low = middle + 1;
    else return token;
  }
  return undefined;
}

/** The index of the first token ending after `index`. */
function firstTokenFrom(tokens: readonly Token[], index: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle].end <= index) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The literal tokens starting in [start, end). */
function literalsWithin(tokens: readonly Token[], start: number, end: number): Token[] {
  const literals: Token[] = [];
  for (let index = firstTokenFrom(tokens, start); index < tokens.length && tokens[index].start < end; index++) {
    if (tokens[index].kind === 'literal' && tokens[index].start >= start) literals.push(tokens[index]);
  }
  return literals;
}

/** The first position at or after `index` that is neither whitespace nor inside a comment. */
function nextSignificant(text: string, index: number, tokens: readonly Token[]): number {
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    const token = tokenAt(tokens, index);
    if (token?.kind !== 'comment') break;
    index = token.end;
  }
  return index;
}

/** The last position before `index` that is neither whitespace nor inside a comment, or -1. */
function previousSignificant(text: string, index: number, tokens: readonly Token[]): number {
  let at = index - 1;
  while (at >= 0) {
    if (/\s/.test(text[at])) { at--; continue; }
    const token = tokenAt(tokens, at);
    if (token?.kind !== 'comment') return at;
    at = token.start - 1;
  }
  return -1;
}

/** The identifier ending at `end` (exclusive), if `end - 1` is one's last character. */
function wordEndingAt(text: string, end: number): string {
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------
// Keyed values in code

// A literal whose whole content is one variable reference is a reference, not
// a secret. Anything else (an escaped `$`, a doubled brace, a default value, a
// format spec beyond the standard ones, an expression) is withheld.
const IDENTIFIER_PATH = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
const SHELL_NAME = String.raw`[A-Za-z_]\w*`;
const SHELL_REFERENCE = String.raw`\$${SHELL_NAME}|\$\{${SHELL_NAME}\}`;
const PYTHON_FORMAT_SPEC = String.raw`(?::(?:[^{}]?[<>=^])?[+\- ]?z?#?0?\d*[_,]?(?:\.\d+)?[bcdeEfFgGnosxX%]?)?`;
const PURE_REFERENCE: Readonly<Record<Interpolation, RegExp | undefined>> = {
  none: undefined,
  js: new RegExp(String.raw`^\$\{\s*${IDENTIFIER_PATH}\s*\}$`),
  dollar: new RegExp(String.raw`^(?:\$[A-Za-z_]\w*|\$\{\s*${IDENTIFIER_PATH}\s*\})$`),
  python: new RegExp(String.raw`^\{\s*${IDENTIFIER_PATH}\s*(?:![rsa])?${PYTHON_FORMAT_SPEC}\}$`),
  // `$A`, `${A}`, or `${A:-$B}`: a default that is itself a reference.
  shell: new RegExp(String.raw`^(?:${SHELL_REFERENCE}|\$\{${SHELL_NAME}:?[-=+?](?:${SHELL_REFERENCE})?\})$`),
  spring: /^\$\{[A-Za-z_][\w.-]*\}$/,
};

// `$A`, `${A}`, `${a.b}`, or a default that is empty or itself a reference
// (shell `${A:-$B}`, `${A:-}`; Spring `${a.b:}`, `${a:${b}}`).
const ANY_REFERENCE =
  /^[-:+=?]?(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_][\w.-]*(?:(?::[-=+?]?|[-=+?])(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_][\w.-]*\})?)?\})$/;
// A config placeholder: `${A}`, with a default that is empty or another placeholder.
// A format that does not interpolate (`.properties`) reads a bare `$abc` literally.
const CONFIG_PLACEHOLDER = /^\$\{[A-Za-z_][\w.-]*(?:(?::[-=+?]?|[-=+?])(?:\$\{[A-Za-z_][\w.-]*\})?)?\}$/;
// Inside an unquoted value a `${…}` reference is one unit.
const REFERENCE_INNER_STOP = /[\s'"`;,&#<>)\]]/;

// The last text whose parentheses were matched, and for each `(` in it the
// index of its `)` on the same line, or -1.
let matchedParentheses: {readonly text: string; readonly close: Int32Array} | undefined;

function parenthesisCloses(text: string): Int32Array {
  if (matchedParentheses?.text === text) return matchedParentheses.close;
  const close = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') open.length = 0;
    else if (char === '(') open.push(index);
    else if (char === ')' && open.length > 0) close[open.pop()!] = index;
  }
  matchedParentheses = {text, close};
  return close;
}

/**
 * Where a command substitution or make function (`$(cat key.txt)`,
 * `$(shell …)`, `$(DB_PASSWORD)`) starting at `at` ends, its parentheses
 * balanced on one line before `end`; undefined when it does not close there.
 * It names where a value comes from; it is not one. The parentheses of a text
 * are matched once, however many values on a long line ask.
 */
function commandEnd(text: string, at: number, end: number): number | undefined {
  if (text[at] !== '$' || text[at + 1] !== '(') return undefined;
  const close = parenthesisCloses(text)[at + 1];
  return close >= 0 && close < end ? close + 1 : undefined;
}

/** Whether `value` is exactly one command substitution or make function. */
function wholeCommand(value: string): boolean {
  if (value[0] !== '$' || value[1] !== '(') return false;
  // Scanned here: matching a value's own parentheses would evict the text's.
  let depth = 0;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (char === '\n') return false;
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index + 1 === value.length;
  }
  return false;
}

function literalIsPureReference(text: string, token: Token): boolean {
  const pattern = PURE_REFERENCE[token.interpolation];
  return pattern !== undefined && pattern.test(text.slice(token.contentStart, token.contentEnd));
}

/** A literal whose content is shaped like a key: `"api_key"`, `"KEYSTORE_PASSWORD"`, `"API Key"`. */
const KEY_SHAPED = /^[A-Za-z_$@][\w$.@-]*(?:[ \t]+[A-Za-z_$@][\w$.@-]*){0,2}$/;
// Calls that read a value by name: environment and system properties,
// preferences, bundles and intents, JSON objects, query parameters and headers,
// and a map's `.get`.
const NAME_LOOKUP = new RegExp(String.raw`(?:(?:^|[^\w$])(?:getenv|getEnv|getenvb|getProperty|getSystemProperty|` +
  String.raw`getString|getStringExtra|getStringSet|optString|getQueryParameter|getHeader|getParameter|getSharedPreferences)` +
  String.raw`|\.get)$`);

/**
 * The two places a literal names where a value comes from instead of being
 * one: a subscript key (`json["access_token"]`), and a credential's name a
 * lookup reads (`getenv("API_TOKEN")`, `prefs.getString("auth_token", …)`).
 */
function namesAValue(text: string, token: Token, tokens: readonly Token[]): boolean {
  if (!KEY_SHAPED.test(text.slice(token.contentStart, token.contentEnd))) return false;
  const before = previousSignificant(text, token.start, tokens);
  if (before < 0) return false;
  const after = text[nextSignificant(text, token.end, tokens)];
  if (text[before] === '[') {
    const subscripted = previousSignificant(text, before, tokens);
    return after === ']' && subscripted >= 0 && /[\w$)\]]/.test(text[subscripted]);
  }
  // A call's name cannot prove it reads by name; a literal that itself names a
  // credential (`getenv("API_TOKEN")`, `prefs.getString("auth_token", …)`) is
  // a name either way, and not a secret.
  if (text[before] !== '(' || (after !== ',' && after !== ')')) return false;
  if (!isCredentialKey(text.slice(token.contentStart, token.contentEnd))) return false;
  const nameEnd = previousSignificant(text, before, tokens) + 1;
  return NAME_LOOKUP.test(text.slice(Math.max(0, nameEnd - 32), nameEnd));
}

const TYPE_NAMES = new Set(['string', 'number', 'boolean', 'object', 'function', 'undefined', 'symbol', 'bigint']);
// Keywords after which an operand starts: `return typeof x === "string"`.
const OPERAND_KEYWORDS = new Set(['return', 'throw', 'case', 'yield']);
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const TYPEOF = /typeof(?![\w$])/y;

/**
 * Whether an operand of `==`/`===` can start at `at`: nothing before it binds
 * tighter than an equality (`a + typeof x === …` compares `a + typeof x`).
 */
function startsEqualityOperand(text: string, at: number, tokens: readonly Token[]): boolean {
  const before = previousSignificant(text, at, tokens);
  if (before < 0) return true;
  const char = text[before];
  if ('([{,;}?&|^'.includes(char)) return true;
  if (char === ':') return text[before - 1] !== ':';
  // An assignment, not a comparison; or an arrow (`=>`).
  if (char === '=') return !/[=!<>]/.test(text[before - 1] ?? '');
  if (char === '>') return text[before - 1] === '=';
  return OPERAND_KEYWORDS.has(wordEndingAt(text, before + 1));
}

/** Whether an operand of `==`/`===` ends at `at`: nothing after it binds tighter than an equality. */
function endsEqualityOperand(text: string, at: number, tokens: readonly Token[]): boolean {
  const next = nextSignificant(text, at, tokens);
  if (next >= text.length) return true;
  const char = text[next];
  if (')]},;&|^'.includes(char)) return true;
  if (char === '?') return text[next + 1] !== '.';
  if (char === ':') return text[next + 1] !== ':';
  return text.startsWith('==', next) || text.startsWith('!=', next);
}

/** The bracket a closing bracket at `close` closes, or -1. */
function openerOf(text: string, close: number, scan: CodeScan): number {
  const open = scan.enclosingOpen[close];
  return open >= 0 && scan.closeOf[open] === close && text[open] === (text[close] === ')' ? '(' : '[') ? open : -1;
}

/**
 * A member chain (`req.headers['x']`, `a?.b()`, `(x)`): a name or a bracketed
 * expression, then any `.name`, `?.name`, `[…]` and `(…)`. Where the one
 * ending at `last` (inclusive) starts, or -1.
 */
function chainStart(text: string, last: number, scan: CodeScan): number {
  for (let at = last; at >= 0;) {
    const char = text[at];
    let start: number;
    if (char === ')' || char === ']') {
      start = openerOf(text, at, scan);
      if (start < 0) return -1;
    } else if (/[\w$]/.test(char)) {
      start = at;
      while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
      if (!/[A-Za-z_$]/.test(text[start])) return -1;
    } else {
      return -1;
    }
    // What the chain goes on from: a member access (`a.b`, `a?.b`, `a?.[k]`),
    // or a callee or subscripted value right before a bracket.
    const access = text[start - 1] === '.' ? (text[start - 2] === '?' ? start - 3 : start - 2) : -1;
    const previous = access >= 0 ? access : (text[start] === '(' || text[start] === '[') ? start - 1 : -1;
    if (previous < 0 || !/[\w$)\]]/.test(text[previous] ?? '')) return access >= 0 ? -1 : start;
    at = previous;
  }
  return -1;
}

/** Where a member chain starting at `at` ends (exclusive), or -1. */
function chainEnd(text: string, at: number, scan: CodeScan): number {
  const bracketEnd = (open: number) => (text[open] === '(' || text[open] === '[') && scan.closeOf[open] > open
    ? scan.closeOf[open] + 1 : -1;
  let end = stickyAt(IDENTIFIER, text, at) ?? bracketEnd(at);
  while (end >= 0) {
    const access = text.startsWith('?.', end) ? end + 2 : text[end] === '.' ? end + 1 : -1;
    const next = access >= 0 ? stickyAt(IDENTIFIER, text, access) ?? (text[end] === '?' ? bracketEnd(access) : -1)
      : bracketEnd(end);
    if (next < 0) return end;
    end = next;
  }
  return -1;
}

/**
 * Whether the operand ending at `end` (exclusive) is a whole `typeof <chain>`,
 * in parentheses or not: `typeof x`, `typeof req.headers['x']`, `typeof (x)`,
 * `(typeof x)`.
 */
function typeofOperandEndingAt(text: string, end: number, scan: CodeScan): boolean {
  const {tokens} = scan;
  const last = previousSignificant(text, end, tokens);
  const start = last < 0 ? -1 : chainStart(text, last, scan);
  if (start < 0) return false;
  const keyword = previousSignificant(text, start, tokens);
  if (wordEndingAt(text, keyword + 1) === 'typeof') return startsEqualityOperand(text, keyword + 1 - 'typeof'.length, tokens);
  if (text[start] !== '(' || scan.closeOf[start] !== last) return false;
  const innerStart = chainStart(text, previousSignificant(text, last, tokens), scan);
  if (innerStart < 0) return false;
  const innerKeyword = previousSignificant(text, innerStart, tokens);
  return wordEndingAt(text, innerKeyword + 1) === 'typeof'
    && previousSignificant(text, innerKeyword + 1 - 'typeof'.length, tokens) === start && startsEqualityOperand(text, start, tokens);
}

/** Where a whole `typeof <chain>` operand starting at `at` ends, in parentheses or not, or -1. */
function typeofOperandFrom(text: string, at: number, scan: CodeScan): number {
  const {tokens} = scan;
  const closes: number[] = [];
  while (text[at] === '(' && scan.closeOf[at] > at) {
    closes.push(scan.closeOf[at]);
    at = nextSignificant(text, at + 1, tokens);
  }
  const keywordEnd = stickyAt(TYPEOF, text, at);
  let end = keywordEnd === undefined ? -1 : chainEnd(text, nextSignificant(text, keywordEnd, tokens), scan);
  // Each enclosing parenthesis must close right after what it holds.
  for (let index = closes.length - 1; index >= 0 && end >= 0; index--) {
    end = nextSignificant(text, end, tokens) === closes[index] ? closes[index] + 1 : -1;
  }
  return end;
}

/**
 * A type name a `typeof` check compares (`typeof token === 'string'`,
 * `'object' !== typeof req.headers['x']`): a type, not a value. The literal
 * must be one whole operand of the equality and `typeof` applied to a member
 * chain the whole other one. Any other compared literal can be the credential
 * a getter returns (`return candidate === "…" ? candidate : null`,
 * `(typeof x, x) === "string"`). Only code knows its brackets, and only code
 * compares.
 */
function comparedLiteral(text: string, token: Token, scan: CodeScan): boolean {
  if (scan.closeOf.length === 0 || !TYPE_NAMES.has(text.slice(token.contentStart, token.contentEnd))) return false;
  const {tokens} = scan;
  const before = previousSignificant(text, token.start, tokens);
  if (before > 0 && text[before] === '=' && /[=!]/.test(text[before - 1])) {
    const operator = text[before - 2] === '=' || text[before - 2] === '!' ? before - 2 : before - 1;
    return endsEqualityOperand(text, token.end, tokens) && typeofOperandEndingAt(text, operator, scan);
  }
  const after = nextSignificant(text, token.end, tokens);
  if (!text.startsWith('==', after) && !text.startsWith('!=', after)) return false;
  if (!startsEqualityOperand(text, token.start, tokens)) return false;
  const operandEnd = typeofOperandFrom(text, nextSignificant(text, after + (text[after + 2] === '=' ? 3 : 2), tokens), scan);
  return operandEnd >= 0 && endsEqualityOperand(text, operandEnd, tokens);
}

/**
 * A literal in an expression assigned to a credential key: its content, or,
 * unterminated, everything to its end. A literal that names where the value
 * comes from (`namesAValue`), a `typeof` check's type name and a lone punctuation
 * mark (`','`) are not values; every other fixed literal is. A weak key's
 * literal must also look like a credential.
 */
function keyedLiteralSpan(text: string, token: Token, scan: CodeScan,
  strength: KeyStrength = 'strong'): CredentialSpan | undefined {
  if (strength === 'weak' && !credentialShaped(text.slice(token.contentStart, token.terminated ? token.contentEnd : token.end))) {
    return undefined;
  }
  if (!token.terminated) return {start: token.contentStart, end: token.end};
  const content = text.slice(token.contentStart, token.contentEnd);
  if (!/[\p{L}\p{N}]/u.test(content) && content.trim().length < 4) return undefined;
  if (namesAValue(text, token, scan.tokens) || comparedLiteral(text, token, scan)) return undefined;
  return literalIsPureReference(text, token) ? undefined : {start: token.contentStart, end: token.contentEnd};
}

// An expression goes on past a line break that a binary operator, an open
// bracket, a member access, Kotlin's infix `to` or a property accessor
// (`get() = …`) leaves unfinished, on either side.
const CONTINUES_AFTER = /[+\-*/%=&|^<>?:,.([{\\]$/;
const CONTINUES_BEFORE = /^(?:[.+\-*/%&|^<>?:=]|\?\?|(?:get|set)\s*\()/;
const ENTRY_NAME = /[A-Za-z_$@][\w$.@-]*/y;
const ENTRY_SEPARATOR = /:=|=>|=(?![=>])|:(?![:=])/y;

/**
 * After a `,`: whether a new declarator, argument or entry with its own name
 * starts (`other = …`, `user: …`, `"user" to …`), which ends the value.
 * Anything else (`"b"` in `password = "a", "b"`) continues it as a tuple.
 */
function startsNewEntry(text: string, index: number, tokens: readonly Token[]): boolean {
  const at = nextSignificant(text, index, tokens);
  const token = tokenAt(tokens, at);
  const nameEnd = token?.kind === 'literal' && token.start === at ? token.end : stickyAt(ENTRY_NAME, text, at);
  if (nameEnd === undefined) return false;
  const separatorAt = nextSignificant(text, nameEnd, tokens);
  return stickyAt(ENTRY_SEPARATOR, text, separatorAt) !== undefined
    || (separatorAt > nameEnd && /^to\s/.test(text.slice(separatorAt, separatorAt + 3)));
}

/**
 * The literals of the expression a value starts at `start`, up to the first
 * `;`, a closing bracket at depth zero, a `,` before a new entry, or a line
 * break that leaves nothing unfinished. Literals and comments are skipped
 * whole. The state starts from the separator before `start`, so an
 * expression starting inside another one never reads past it.
 */
function assignedLiterals(text: string, start: number, tokens: readonly Token[]): {end: number; literals: Token[]} {
  const literals: Token[] = [];
  let depth = 0;
  let lastAt = previousSignificant(text, start, tokens);
  // The next significant position after a run of line breaks, found once for the whole run.
  let knownNext = -1;
  for (let index = start; index < text.length; index++) {
    const token = tokenAt(tokens, index);
    if (token) {
      if (token.kind === 'literal') literals.push(token);
      if (token.kind !== 'comment') lastAt = token.end - 1;
      index = token.end - 1;
      continue;
    }
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') { if (depth === 0) return {end: index, literals}; depth--; }
    else if (depth === 0 && char === ';') return {end: index, literals};
    else if (depth === 0 && char === ',' && startsNewEntry(text, index + 1, tokens)) return {end: index, literals};
    else if (depth === 0 && char === '\n') {
      const last = lastAt < 0 ? '' : text[lastAt];
      const infixTo = last === 'o' && /(?:^|[^\w$])to$/.test(text.slice(Math.max(0, lastAt - 2), lastAt + 1));
      if (knownNext <= index) knownNext = nextSignificant(text, index + 1, tokens);
      if (!CONTINUES_AFTER.test(last) && !infixTo && !CONTINUES_BEFORE.test(text.slice(knownNext, knownNext + 8))) {
        return {end: index, literals};
      }
    }
    if (!/\s/.test(char)) lastAt = index;
  }
  return {end: text.length, literals};
}

// A key's separator: `=` or a compound assignment, `:`, `:=`, `=>`, or `(`
// for a credential-named call; never part of `==`, `!=`, `<=`, `>=`, `::`.
// An identifier key starts only at a token boundary, which keeps a long run
// of word characters linear; `-D` is a compiler definition. A key may start
// at a member access no name precedes: a C designated initializer
// (`{.password = …}`), a call's result (`builder().password(…)`), a safe call
// (`user?.password = …`).
const CODE_KEY = /(?<![\w$@.-])(?:-D|\.(?=[A-Za-z_$]))?[A-Za-z_$@][\w$.-]*/g;
const CODE_SEPARATOR = /:=|=>|(?:\?\?|\|\||&&|[+\-*/%&|^])?=(?![=>])|:(?![:=])|\(/y;
const LITERAL_SEPARATOR = /:=|=>|=(?![=>])|:(?![:=])/y;
const SUBSCRIPT_ASSIGNMENT = /:=|(?:\?\?|\|\||&&|[+\-*/%&|^])?=(?![=>])/y;

// Keywords that declare a type the next name names (`class AccessToken(…)`,
// `type Token = …`), so the name is not assigned. A contextual keyword, one
// the language also takes as a name, declares only with the name on its own
// line: `type\npassword = …` assigns `password`. A language without the
// keyword (Java's `type`) has a type of that name, and a member named like
// one (`obj.class`, `Foo::class`) is not one.
const TYPE_DECLARATION: Partial<Record<Language, {readonly reserved: readonly string[]; readonly contextual: readonly string[]}>> = {
  c: {reserved: ['struct', 'union', 'enum'], contextual: []},
  cpp: {reserved: ['class', 'struct', 'union', 'enum', 'namespace'], contextual: []},
  java: {reserved: ['class', 'interface', 'enum'], contextual: ['record']},
  kotlin: {reserved: ['class', 'interface', 'object', 'typealias'], contextual: []},
  go: {reserved: ['type'], contextual: []},
  rust: {reserved: ['struct', 'enum', 'trait', 'type', 'impl', 'mod'], contextual: ['union']},
  swift: {reserved: ['class', 'struct', 'enum', 'protocol', 'typealias', 'extension'], contextual: ['actor']},
  js: {reserved: ['class', 'enum'], contextual: ['type', 'interface', 'namespace']},
  python: {reserved: ['class'], contextual: ['type']},
  groovy: {reserved: ['class', 'interface', 'enum'], contextual: ['trait']},
  dart: {reserved: ['class', 'enum'], contextual: ['mixin', 'typedef', 'extension']},
};

/** Whether the key at `keyAt` is the name a type declaration declares. */
function declaresType(text: string, keyAt: number, language: Language, tokens: readonly Token[]): boolean {
  const declaration = TYPE_DECLARATION[language];
  if (!declaration) return false;
  const before = previousSignificant(text, keyAt, tokens);
  const keyword = wordEndingAt(text, before + 1);
  const reserved = declaration.reserved.includes(keyword);
  if (!reserved && !declaration.contextual.includes(keyword)) return false;
  // A member named like the keyword (`obj.class`, `Foo::class`) declares nothing.
  const qualifier = previousSignificant(text, before + 1 - keyword.length, tokens);
  if (text[qualifier] === '.' || (text[qualifier] === ':' && text[qualifier - 1] === ':')) return false;
  return reserved || !text.slice(before + 1, keyAt).includes('\n');
}

/** Where the value of an identifier key starts, through whitespace and comments, or undefined. */
function identifierKeyValue(text: string, keyAt: number, keyEnd: number, context: LanguageContext,
  tokens: readonly Token[]): number | undefined {
  if (declaresType(text, keyAt, context.language, tokens)) return undefined;
  let at = nextSignificant(text, keyEnd, tokens);
  // TypeScript's optional and definite markers: `password?: string`, `password!: string`
  if ((text[at] === '?' || text[at] === '!') && text[at + 1] === ':') at++;
  const separatorEnd = stickyAt(CODE_SEPARATOR, text, at);
  if (separatorEnd !== undefined) return separatorEnd;
  // A C++ brace initializer: `std::string password{"…"}`
  if (text[at] === '{' && (context.language === 'cpp' || context.language === 'c')) return at + 1;
  const spaced = at > keyEnd && !text.slice(keyEnd, at).includes('\n');
  // Kotlin's infix `to` and property delegation (`val password by lazy { … }`)
  if (spaced && /^to\s/.test(text.slice(at, at + 3))) return at + 2;
  if (spaced && context.language === 'kotlin' && /^by\s/.test(text.slice(at, at + 3))) return at + 2;
  // Groovy calls a method without parentheses: `storePassword "…"`
  if (spaced && context.language === 'groovy' && tokenAt(tokens, at)?.kind === 'literal') return at;
  return undefined;
}

const LIST_ASSIGNMENT = /:=|(?:\?\?|\|\||&&|[+\-*/%&|^])?=(?![=>])/y;
const LIST_CHARACTER = /[\w$.,:*&?<>[\])}]/;

/** The first position after a type annotation that starts at `from` (bracketed groups skipped whole). */
function afterTypeAnnotation(text: string, from: number, scan: CodeScan): number {
  let at = from;
  while (at < text.length) {
    at = nextSignificant(text, at, scan.tokens);
    const char = text[at];
    if ((char === '{' || char === '(' || char === '[') && scan.closeOf[at] > at) { at = scan.closeOf[at] + 1; continue; }
    if (char === '=' && text[at + 1] === '>') { at += 2; continue; } // a function type
    if (char !== undefined && /[\w$.<>|&?,'"]/.test(char)) { at++; continue; }
    break;
  }
  return at;
}

/**
 * Whether a `{` opens a destructuring pattern rather than a block or an object
 * literal: it, or a pattern it is an element of, is assigned
 * (`const {a: password} = …`, `[{password}] = …`). Each bracket is judged once.
 */
function destructuringPatterns(text: string, scan: CodeScan): (open: number) => boolean {
  const verdicts = new Map<number, boolean>();
  return open => {
    const chain: number[] = [];
    let verdict: boolean | undefined;
    for (let at = open; verdict === undefined;) {
      verdict = verdicts.get(at);
      if (verdict !== undefined) break;
      chain.push(at);
      const close = scan.closeOf[at];
      let next = close < 0 ? text.length : nextSignificant(text, close + 1, scan.tokens);
      // A type annotation between a pattern and its value: `const {a}: Creds = …`.
      if (text[next] === ':' && text[next + 1] !== ':') next = afterTypeAnnotation(text, next + 1, scan);
      if (close >= 0 && text[next] === '=' && text[next + 1] !== '=' && text[next + 1] !== '>') verdict = true;
      else if (close < 0 || !/[,\])}]/.test(text[next] ?? '') || scan.enclosingOpen[at] < 0) verdict = false;
      else at = scan.enclosingOpen[at];
    }
    for (const at of chain) verdicts.set(at, verdict);
    return verdict;
  };
}

/**
 * A key that takes part in an assignment through a target list, a
 * destructuring pattern or a declared type (`user, password = …`,
 * `const [user, password] = …`, `val (user, password) = …`,
 * `var password string = …`): where that assignment's value starts, and
 * where the scan stopped. A line break ends the statement unless a `,`, an
 * open `(`/`[` or an open destructuring `{` leaves it unfinished; any other
 * `{` there is a block.
 */
function listAssignment(text: string, from: number, scan: CodeScan, isPattern: (open: number) => boolean):
  {valueStart?: number; stop: number} {
  let passed = '';
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '\n' && passed !== ',') {
      const bracket = enclosingBracket(text, scan, index);
      if (bracket !== PAREN && bracket !== SQUARE && !(bracket === BRACE && isPattern(scan.enclosingOpen[index]))) break;
    }
    if (/\s/.test(char)) { index++; continue; }
    const token = tokenAt(scan.tokens, index);
    if (token) {
      if (token.kind !== 'comment') break;
      index = token.end;
      continue;
    }
    const assignment = stickyAt(LIST_ASSIGNMENT, text, index);
    if (assignment !== undefined) return {valueStart: passed ? assignment : undefined, stop: index};
    if (!LIST_CHARACTER.test(char)) break;
    passed = char;
    index++;
  }
  return {stop: index};
}

/**
 * Where the value of a credential-named string key starts, or undefined. A
 * key of words (`"API Key"`) is one only as a map entry's or a subscript's:
 * as a call's argument such a string is a message (`fail("Invalid API key", …)`).
 */
function literalKeyValue(text: string, token: Token, context: LanguageContext, scan: CodeScan, words: boolean): number | undefined {
  const before = previousSignificant(text, token.start, scan.tokens);
  const beforeChar = before < 0 ? '' : text[before];
  const at = nextSignificant(text, token.end, scan.tokens);
  // A subscript key: `obj["password"] = …`
  if (beforeChar === '[' && text[at] === ']') {
    return stickyAt(SUBSCRIPT_ASSIGNMENT, text, nextSignificant(text, at + 1, scan.tokens));
  }
  // An argument: `put("password", …)`, or a Groovy command's: `buildConfigField "String", "API_KEY", "…"`
  if (text[at] === ',') {
    if (words) return undefined;
    const enclosing = enclosingBracket(text, scan, token.start);
    return enclosing === PAREN || (context.language === 'groovy' && enclosing !== SQUARE) ? at + 1 : undefined;
  }
  // An entry separator; across a line break only for an object key, after
  // `{` or `,`: `cond ? "a"\n: "b"` is a ternary.
  const gap = text.slice(token.end, at);
  if (gap.includes('\n') && beforeChar !== '{' && beforeChar !== ',') return undefined;
  const separatorEnd = stickyAt(LITERAL_SEPARATOR, text, at);
  if (separatorEnd !== undefined) return separatorEnd;
  if (gap.length > 0 && !gap.includes('\n') && /^to\s/.test(text.slice(at, at + 3))) return at + 2;
  return undefined;
}

// What may stand between a getter's parameters and its body on the same line:
// a declared return type (`: String?`, `-> str`, `: Promise<string>`) and
// qualifiers (`const`, `override`, `throws IOException`, `noexcept`), Rust
// lifetimes (`-> &'static str`) included.
const RETURN_TYPE_CHARACTER = /[\w$.<>?[\],*&|:']/;

/**
 * Whether the line break at `newline` ends a logical line of code: it is not
 * inside a literal, not inside a bracket, and no `\` outside a token splices
 * it to the next line.
 */
function endsLogicalLine(text: string, newline: number, scan: CodeScan): boolean {
  if (tokenAt(scan.tokens, newline) || scan.enclosingOpen[newline] >= 0) return false;
  const splice = text[newline - 1] === '\r' ? newline - 2 : newline - 1;
  return !(splice >= 0 && text[splice] === '\\' && !tokenAt(scan.tokens, splice)
    && oddBackslashesAtEnd(text.slice(text.lastIndexOf('\n', splice) + 1, splice + 1)));
}

/** A Python line's indentation in columns: a tab moves to the next multiple of eight, a form feed starts over. */
function pythonIndent(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === ' ') column++;
    else if (char === '\t') column = column - (column % 8) + 8;
    else if (char === '\f') column = 0;
    else break;
  }
  return column;
}

/**
 * A Python block: from `from` to the first later logical line with code on it
 * indented no deeper than `indent`. A blank or comment-only line ends nothing,
 * and a line a multi-line string, a bracket or a `\` continues belongs to the
 * line before it, however it is indented.
 */
function pythonBlockEnd(text: string, from: number, indent: number, scan: CodeScan): number {
  for (let newline = text.indexOf('\n', from); newline >= 0;) {
    const lineStart = newline + 1;
    const next = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, next < 0 ? text.length : next);
    const code = line.search(/\S/);
    if (code >= 0 && tokenAt(scan.tokens, lineStart + code)?.kind !== 'comment' && endsLogicalLine(text, newline, scan)
      && pythonIndent(line) <= indent) return lineStart;
    newline = next;
  }
  return text.length;
}

/** The `:` that ends a Python definition's header after `from`, or undefined: on its logical line, outside tokens and brackets. */
function pythonHeaderColon(text: string, from: number, scan: CodeScan): number | undefined {
  for (let at = from; at < text.length;) {
    const token = tokenAt(scan.tokens, at);
    if (token) { at = token.end; continue; }
    const char = text[at];
    if (char === ':') return at;
    if (char === '\n' && endsLogicalLine(text, at, scan)) return undefined;
    at = (char === '(' || char === '[' || char === '{') && scan.closeOf[at] > at ? scan.closeOf[at] + 1 : at + 1;
  }
  return undefined;
}

// What makes `name(…)` a definition rather than a call: the keyword before it,
// or in C-family languages a declared return type (`String getPassword()`);
// a modifier right before the name is a constructor's.
const DEFINITION_KEYWORD: Partial<Record<Language, string>> = {kotlin: 'fun', go: 'func', rust: 'fn', swift: 'func', python: 'def'};
const JS_METHOD_PREFIX = new Set(['function', 'get', 'static', 'async', 'public', 'private', 'protected', 'override', 'readonly']);
const NOT_A_RETURN_TYPE = new Set(['return', 'new', 'throw', 'else', 'case', 'await', 'yield', 'typeof', 'delete', 'in', 'of',
  'do', 'class', 'struct', 'interface', 'enum', 'object', 'record', 'extends', 'implements', 'import', 'package', 'public',
  'private', 'protected', 'internal', 'static', 'final', 'abstract', 'override', 'virtual', 'inline', 'constexpr',
  'explicit', 'synchronized', 'native', 'default']);

function definesFunction(text: string, before: number, previousWord: string, language: Language, scan: CodeScan): boolean {
  if (previousWord === 'get') return true; // an accessor: `get password()`
  const keyword = DEFINITION_KEYWORD[language];
  // Go's method receiver: `func (s *Store) getPassword()`.
  if (language === 'go' && before >= 0 && text[before] === ')') {
    const open = scan.enclosingOpen[before];
    return open >= 0 && wordEndingAt(text, previousSignificant(text, open, scan.tokens) + 1) === 'func';
  }
  if (keyword) return previousWord === keyword;
  if (before < 0) return false;
  if (language === 'js') {
    // A generator: `function* getPassword()`, `*getPassword() { … }` in a class.
    if (text[before] === '*') {
      const star = previousSignificant(text, before, scan.tokens);
      return star < 0 || /[{};,]/.test(text[star]) || wordEndingAt(text, star + 1) === 'function';
    }
    // A method in a class or an object literal: `apiKey() { … }`, `static apiKey() { … }`.
    return JS_METHOD_PREFIX.has(previousWord) || /[{};,]/.test(text[before]);
  }
  // A qualified C++ name: `std::string Store::getPassword() const`.
  let at = before;
  while (at > 0 && text[at] === ':' && text[at - 1] === ':') {
    const qualifier = previousSignificant(text, at - 1, scan.tokens);
    const word = wordEndingAt(text, qualifier + 1);
    if (!word) return false;
    at = previousSignificant(text, qualifier + 1 - word.length, scan.tokens);
  }
  if (at < 0) return false;
  const word = wordEndingAt(text, at + 1);
  if (/[\w$]/.test(text[at])) return !NOT_A_RETURN_TYPE.has(word);
  return /[>*&\]]/.test(text[at]);
}

// A getter's name: `get` and a credential (`getPassword`, `get_api_key`,
// `GET_API_KEY`), or the credential's own name (`password()`, `apiKey()`,
// `accessToken()`), also when it reads as a verb too (`refreshToken()`). A
// verb before the credential (`listApiKeys`, `readMasterKey`, `csrfTokenFor…`)
// computes or reads one, and its literals are names, SQL and encodings. A bare
// `token()` is a lexer's or a model stream's as often as not, and `pwd()` the
// working directory's; `getToken()` is a getter.
const GETTER_NAME = /^(?:[Gg]et[A-Z_\d]|GET_)/;
const CREDENTIAL_NOUNS = new Set<string>([...CREDENTIAL_KEY_SUFFIXES.filter(suffix => suffix !== 'pwd'), 'apisecret', 'appsecret',
  'accesstoken', 'authtoken', 'refreshtoken', 'idtoken', 'sessiontoken', 'bearertoken', 'apitoken', 'oauthtoken',
  'authenticationtoken', 'authorizationtoken', 'securitytoken', 'csrftoken', 'xsrftoken']);

// A preposition ends the noun a getter gets: `getSessionFromToken` gets a
// session, `getEncryptionKeyFromPassword` a key.
const NOUN_END = new Set(['from', 'by', 'for', 'with', 'of', 'via', 'using']);

/** Whether a definition named `name` (a credential key) is a getter of a credential by its name. */
function getterNamed(name: string): boolean {
  if (CREDENTIAL_NOUNS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
  if (!GETTER_NAME.test(name)) return false;
  const noun = keyWords(name).slice(1);
  const end = noun.findIndex(word => NOUN_END.has(word));
  return end < 0 || (end > 0 && keyStrength(noun.slice(0, end).join('_')) !== undefined);
}

/**
 * A credential getter's body: a definition with a getter's name
 * (`getPassword()`, `get_api_key(self)`, `apiKey()`, a Python `@property def
 * password(self)`) or a JS `get password()` accessor, with a block body
 * (`{ return "…" }`), an expression body (`= "…"`, Dart's `=> "…"`) or a
 * Python block. Every literal of a block body is withheld: what a getter
 * returns can come from any of them, through any local name, alias or
 * expression, and its other literals (messages, names) are the price of not
 * tracing that. A call (`getPassword()` and whatever follows it) has no body.
 * `parenAt` opens the parameters.
 */
function getterBody(text: string, keyAt: number, key: string, parenAt: number, context: LanguageContext,
  scan: CodeScan): {literals: Token[]; end: number} | {valueStart: number} | undefined {
  const before = previousSignificant(text, keyAt, scan.tokens);
  const previousWord = wordEndingAt(text, before + 1);
  // A member path (`agent.token(…)`) is a call; only a Kotlin extension
  // (`fun String.getPassword()`) defines one under its receiver's name.
  if (key.includes('.') && !(context.language === 'kotlin' && previousWord === 'fun')) return undefined;
  const name = key.slice(key.lastIndexOf('.') + 1);
  if (previousWord !== 'get' && !getterNamed(name)) return undefined;
  if (!definesFunction(text, before, previousWord, context.language, scan)) return undefined;
  const close = scan.closeOf[parenAt];
  if (close < 0) return undefined;
  let at = close + 1;
  if (context.language === 'python') {
    const colon = pythonHeaderColon(text, at, scan);
    if (colon === undefined) return undefined;
    const indent = pythonIndent(text.slice(text.lastIndexOf('\n', keyAt) + 1, keyAt));
    const end = pythonBlockEnd(text, colon, indent, scan);
    return {literals: literalsWithin(scan.tokens, colon + 1, end), end};
  }
  let first = true;
  for (;;) {
    while (text[at] === ' ' || text[at] === '\t') at++;
    const token = tokenAt(scan.tokens, at);
    if (token?.kind === 'comment' && token.start === at) { at = token.end; continue; }
    // Only a body, a return type, a qualifier or a line break follows a definition's parameters;
    // anything else makes it a call: `getToken().let {`, `getToken() ?: x`, `getToken(), {…}`.
    if (first && at < text.length && text[at] !== '\n' && text[at] !== '\r' && !/[{:=(\w$-]/.test(text[at])) return undefined;
    first = false;
    // Go's result list: `func getPassword() (string, error) {`
    if (text[at] === '(' && scan.closeOf[at] > at) { at = scan.closeOf[at] + 1; continue; }
    if (text.startsWith('->', at)) { at += 2; continue; }
    if (at < text.length && RETURN_TYPE_CHARACTER.test(text[at])) { at++; continue; }
    break;
  }
  // The body may start on a later line: `String getPassword()\n{`, `fun getPassword(): String\n    = "…"`.
  const body = nextSignificant(text, at, scan.tokens);
  if (text.startsWith('=>', body)) return {valueStart: body + 2};
  if (text[body] === '=' && text[body + 1] !== '=') return {valueStart: body + 1};
  if (text[body] !== '{') return undefined;
  const end = scan.closeOf[body] < 0 ? text.length : scan.closeOf[body];
  return {literals: literalsWithin(scan.tokens, body + 1, end), end};
}

// C and C++ directives, read in the spliced text (`logicalText`), where a
// directive is one line; a comment counts as a space.

/** Whether only spaces and comments stand between the start of a line and `at`. */
function startsDirectiveLine(text: string, at: number, tokens: readonly Token[]): boolean {
  for (let index = at - 1; index >= 0;) {
    const char = text[index];
    if (char === '\n') return true;
    if (/[ \t\r\f\v]/.test(char)) { index--; continue; }
    const token = tokenAt(tokens, index);
    if (token?.kind !== 'comment') return false;
    index = token.start - 1;
  }
  return true;
}

/** The first position from `at` past spaces and comments within a directive. */
function skipDirectiveBlanks(text: string, at: number, tokens: readonly Token[]): number {
  while (at < text.length) {
    if (/[ \t\f\v]/.test(text[at])) { at++; continue; }
    const token = tokenAt(tokens, at);
    if (token?.kind !== 'comment' || token.start !== at) break;
    at = token.end;
  }
  return at;
}

/** Where the directive containing `at` ends: the first line break outside a token. */
function directiveEnd(text: string, at: number, tokens: readonly Token[]): number {
  while (at < text.length) {
    const token = tokenAt(tokens, at);
    if (token) { at = Math.max(at + 1, token.end); continue; }
    if (text[at] === '\n') return at;
    at++;
  }
  return text.length;
}

const DEFINE = /define(?![\w$])/y;
const MACRO_NAME = /[A-Za-z_]\w*/y;

/**
 * The literals a credential-named macro expands to, withheld like an assigned
 * value: `#define PASSWORD "…"`, the same with comments between its words,
 * and a function-like macro named like a getter (`#define
 * GET_PASSWORD() "…"`, see `getterNamed`), whose parameters follow its name
 * with no space.
 */
function macroValueSpans(text: string, scan: CodeScan): CredentialSpan[] {
  const {tokens} = scan;
  const spans: CredentialSpan[] = [];
  for (const hash of text.matchAll(/#/g)) {
    const at = hash.index!;
    if (tokenAt(tokens, at) || !startsDirectiveLine(text, at, tokens)) continue;
    const defineEnd = stickyAt(DEFINE, text, skipDirectiveBlanks(text, at + 1, tokens));
    if (defineEnd === undefined) continue;
    const nameAt = skipDirectiveBlanks(text, defineEnd, tokens);
    const nameEnd = stickyAt(MACRO_NAME, text, nameAt);
    if (nameEnd === undefined || nameAt === defineEnd) continue;
    const name = text.slice(nameAt, nameEnd);
    const strength = keyStrength(name);
    const functionLike = text[nameEnd] === '(';
    if (!strength || (functionLike && !getterNamed(name))) continue;
    let valueStart = nameEnd;
    if (functionLike) valueStart = scan.closeOf[nameEnd] < 0 ? nameEnd + 1 : scan.closeOf[nameEnd] + 1;
    for (const token of literalsWithin(tokens, valueStart, directiveEnd(text, valueStart, tokens))) {
      const span = keyedLiteralSpan(text, token, scan, strength);
      if (span) spans.push(span);
    }
  }
  return spans;
}

function codeKeyedSpans(text: string, context: LanguageContext, scan: CodeScan): CredentialSpan[] {
  const {tokens} = scan;
  const isPattern = destructuringPatterns(text, scan);
  const valueStarts: Array<{readonly start: number; strength: KeyStrength}> = [];
  const bodyLiterals: Array<{readonly token: Token; readonly strength: KeyStrength}> = [];
  // A key inside a target list already scanned meets the same assignment, at
  // the strongest strength of its keys; a getter inside a body already read at
  // its strength or stronger adds nothing.
  let listScannedUntil = -1;
  let lastList: {readonly start: number; strength: KeyStrength} | undefined;
  const bodyReadUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  for (const match of text.matchAll(CODE_KEY)) {
    const keyAt = match.index!;
    const strength = keyStrength(match[0]);
    if (!strength || tokenAt(tokens, keyAt)) continue;
    const keyEnd = keyAt + match[0].length;
    const direct = identifierKeyValue(text, keyAt, keyEnd, context, tokens);
    if (direct !== undefined) {
      valueStarts.push({start: direct, strength});
      const covered = keyAt < bodyReadUntil.strong || (strength === 'weak' && keyAt < bodyReadUntil.weak);
      if (text[direct - 1] === '(' && !covered) {
        const body = getterBody(text, keyAt, match[0], direct - 1, context, scan);
        if (body && 'valueStart' in body) valueStarts.push({start: body.valueStart, strength});
        else if (body) {
          for (const token of body.literals) bodyLiterals.push({token, strength});
          bodyReadUntil.weak = Math.max(bodyReadUntil.weak, body.end);
          if (strength === 'strong') bodyReadUntil.strong = Math.max(bodyReadUntil.strong, body.end);
        }
      }
    }
    if (keyEnd >= listScannedUntil) {
      const list = listAssignment(text, keyEnd, scan, isPattern);
      listScannedUntil = list.stop;
      lastList = list.valueStart === undefined ? undefined : {start: list.valueStart, strength};
      if (lastList) valueStarts.push(lastList);
    } else if (lastList && strength === 'strong') {
      lastList.strength = 'strong';
    }
  }
  for (const token of tokens) {
    if (token.kind !== 'literal' || !token.terminated) continue;
    const content = text.slice(token.contentStart, token.contentEnd);
    const strength = KEY_SHAPED.test(content) ? phraseStrength(content) : undefined;
    if (!strength) continue;
    const valueStart = literalKeyValue(text, token, context, scan, /\s/.test(content));
    if (valueStart !== undefined) valueStarts.push({start: valueStart, strength});
  }
  valueStarts.sort((left, right) => left.start - right.start);
  const spans: CredentialSpan[] = [];
  // Each strength is read in its own pass, so a weak key's value never hides a
  // strong one's. Within a pass a value starting inside one already read is
  // part of it; skipping it keeps a long chain of assignments linear.
  for (const strength of ['strong', 'weak'] as const) {
    let coveredUntil = -1;
    for (const valueStart of valueStarts) {
      if (valueStart.strength !== strength || valueStart.start < coveredUntil) continue;
      const {end, literals} = assignedLiterals(text, valueStart.start, tokens);
      coveredUntil = end;
      for (const token of literals) bodyLiterals.push({token, strength});
    }
  }
  for (const {token, strength} of bodyLiterals) {
    const span = keyedLiteralSpan(text, token, scan, strength);
    if (span) spans.push(span);
  }
  if (context.language === 'c' || context.language === 'cpp') append(spans, macroValueSpans(text, scan));
  return spans;
}

// ---------------------------------------------------------------------------
// Config values: read whole, the way the format reads them, then judged

// A key at the start of a line, after an optional YAML sequence marker (`- `).
// The white space around a key is a space or a tab, and a form feed as Java
// properties read it. A key is one word: a properties key ends at the first
// white space (`password\tsecret=value`).
const CONFIG_KEY = /^([ \t\f]*(?:-[ \t]+)*)(?:export[ \t]+)?(["']?)([A-Za-z_$@][\w$.@/-]*)\2[ \t\f]*(?:[:=]|[ \t\f](?=\S))[ \t\f]*/gm;
// A key of two or three words before a `:` or `=`, where a key may hold
// spaces: a YAML key (`API Key: …`), a quoted one (`"API Key" = …`); the same
// groups as `CONFIG_KEY`.
const PHRASE_KEY = /^([ \t]*(?:-[ \t]+)*)(["']?)((?:[A-Za-z_$@][\w$.@/-]*[ \t]+){1,2}[A-Za-z_$@][\w$.@/-]*)\2[ \t]*[:=][ \t]*/gm;
// An INI option as configparser reads it: everything on its line before the
// first `=` or `:`, spaces included (`db password = …`); the same groups as `CONFIG_KEY`.
const INI_KEY = /^([ \t]*)()([^\s=:#;[][^=:\n]*?)[ \t]*[=:][ \t]*/gm;

/** The key forms each config language reads, in the order a line's candidates are tried. */
const CONFIG_KEYS: Partial<Record<Language, readonly RegExp[]>> = {
  yaml: [CONFIG_KEY, PHRASE_KEY],
  toml: [CONFIG_KEY, PHRASE_KEY],
  ini: [INI_KEY, CONFIG_KEY],
};
// A make assignment (`NAME = …`, `:=`, `::=`, `:::=`, `?=`, `+=`, `!=`), after
// `export`, `override` or `private`; the same groups as `CONFIG_KEY`.
const MAKE_ASSIGNMENT = /^([ \t]*)(?:(?:export|override|private)[ \t]+)*()([A-Za-z_][\w.-]*)[ \t]*(?::{1,3}=|[?+!]?=)[ \t]*/gm;
// A multi-line make variable: `define NAME` up to the `endef` that closes it.
// Definitions nest, and a line that starts with a tab is a recipe's, never a
// directive.
const MAKE_DEFINE = /^(?!\t)[ \t]*(?:(?:export|override|private)[ \t]+)*define[ \t]+([A-Za-z_][\w.-]*)[^\n]*/gm;
const MAKE_DEFINE_LINE = /^(?!\t)[ \t]*(?:(?:export|override|private)[ \t]+)*define(?![\w.-])/;
const MAKE_ENDEF_LINE = /^(?!\t)[ \t]*endef(?![\w.-])/;
const YAML_BLOCK_HEADER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

/**
 * A config value's parts and where reading it stopped, whether or not any
 * part is withheld: a key inside the region read is part of the value.
 */
interface ConfigValue {
  readonly spans: CredentialSpan[];
  readonly end: number;
  /** The value as its format reads it, when no span holds it whole (a YAML block's lines joined or folded). */
  readonly reads?: readonly string[];
}

/**
 * The lines of a YAML plain scalar after `from`: each non-blank line indented
 * deeper than `indent`, trimmed and without its comment (white space then
 * `#`); `end` is where the first shallower line starts.
 */
function deeperLines(text: string, from: number, indent: number): ConfigValue {
  const spans: CredentialSpan[] = [];
  for (let newline = text.indexOf('\n', from); newline >= 0;) {
    const lineStart = newline + 1;
    const next = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, next < 0 ? text.length : next).replace(/\r$/, '');
    const content = line.trim();
    if (content && /^[ \t]*/.exec(line)![0].length <= indent) return {spans, end: lineStart};
    if (content && !content.startsWith('#')) {
      const comment = /[ \t]#/.exec(content);
      const kept = comment ? content.slice(0, comment.index).trimEnd() : content;
      const start = lineStart + line.indexOf(content);
      spans.push({start, end: start + kept.length});
    }
    newline = next;
  }
  return {spans, end: text.length};
}

// One YAML node property: an anchor `&name` or a tag (`!!str`, `!<tag:…>`, `!local`, `!`).
const YAML_PROPERTY = /(?:&[^\s,[\]{}]+|!<[^>\s]*>|![^\s,[\]{}]*)(?=[ \t\r\n]|$)/y;

/** Past the YAML node properties at `at` and the blanks after each. */
function pastYamlProperties(text: string, at: number): number {
  for (;;) {
    const end = stickyAt(YAML_PROPERTY, text, at);
    if (end === undefined) return at;
    at = end;
    while (text[at] === ' ' || text[at] === '\t') at++;
  }
}

/**
 * Where a YAML value starts after its key: read on past node properties, a
 * comment, the rest of an empty line, blank lines and comment lines, in any
 * order and over any number of lines (`password:⏎  # note⏎  &a⏎  !!str⏎  |-`),
 * to the first other text. That text starts the value when it is indented
 * deeper than the key; otherwise (the next key, or the end) the value is the
 * key's own line.
 */
function yamlValueStart(text: string, valueStart: number, keyIndent: number): number {
  const ownLine = pastYamlProperties(text, valueStart);
  let at = ownLine;
  for (;;) {
    at = pastYamlProperties(text, at);
    const lineEnd = lineEndFrom(text, at);
    const rest = text.slice(at, lineEnd).trim();
    if (rest && !rest.startsWith('#')) return at;
    if (lineEnd >= text.length) return ownLine;
    // The next line with text other than a comment.
    let lineStart = lineEnd + 1;
    for (;;) {
      const nextEnd = lineEndFrom(text, lineStart);
      const line = text.slice(lineStart, nextEnd);
      const content = line.trim();
      if (content && !content.startsWith('#')) break;
      if (nextEnd >= text.length) return ownLine;
      lineStart = nextEnd + 1;
    }
    const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEndFrom(text, lineStart)))![0].length;
    if (indent <= keyIndent) return ownLine;
    at = lineStart + indent;
  }
}

/**
 * Lines of a YAML flow scalar (plain or quoted) as YAML folds them: one line
 * break between two lines is a space, k empty lines between them k line
 * breaks. In a double-quoted scalar a `\` at a line end escapes the break, and
 * parsers disagree on empty lines after it: the YAML spec keeps each as a line
 * break, the `yaml` package folds them like an unescaped break with one fewer,
 * js-yaml drops them. Each reading is returned, the same ones once.
 */
function foldedLines(text: string, lines: readonly CredentialSpan[], escapedBreaks = false): string[] {
  const readings: string[][] = [[], [], []];
  lines.forEach((line, index) => {
    if (index > 0) {
      const previous = lines[index - 1];
      let breaks = 0;
      for (let at = previous.end; at < line.start; at++) if (text[at] === '\n') breaks++;
      let slashes = 0;
      while (slashes < previous.end - previous.start && text[previous.end - 1 - slashes] === '\\') slashes++;
      if (escapedBreaks && slashes % 2 === 1) {
        const empty = breaks - 1;
        for (const reading of readings) reading[reading.length - 1] = reading[reading.length - 1].slice(0, -1);
        readings[0].push('\n'.repeat(empty));
        readings[1].push(empty === 0 ? '' : empty === 1 ? ' ' : '\n'.repeat(empty - 1));
        readings[2].push('');
      } else {
        for (const reading of readings) reading.push(breaks > 1 ? '\n'.repeat(breaks - 1) : ' ');
      }
    }
    const content = text.slice(line.start, line.end);
    for (const reading of readings) reading.push(content);
  });
  return [...new Set(readings.map(reading => reading.join('')))];
}

/**
 * A YAML block scalar after its header (`|`, `>`, with chomping and
 * indentation indicators): every line indented deeper than its key, `#`
 * lines included (inside a block they are text), and its value as YAML reads
 * it. The block's indentation is the key's plus the header's indicator, or
 * else the first non-empty line's; a line keeps what it has beyond it, a
 * blank line the white space beyond it, and the block ends at a non-empty
 * line indented less. `|` keeps the lines apart. `>` joins two lines of text
 * by a space, or by the empty lines between them, and keeps the line breaks
 * around a line that starts with white space.
 */
function yamlBlockScalar(text: string, valueStart: number, keyIndent: number, header: string): ConfigValue {
  const spans: CredentialSpan[] = [];
  // The block's lines as YAML reads them, '' for an empty one.
  const lines: string[] = [];
  const indicator = /[1-9]/.exec(header);
  let blockIndent = indicator ? keyIndent + Number(indicator[0]) : -1;
  let reading = true;
  let end = text.length;
  for (let newline = text.indexOf('\n', valueStart); newline >= 0;) {
    const lineStart = newline + 1;
    const next = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, next < 0 ? text.length : next).replace(/\r$/, '');
    const content = line.trim();
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (content && indent <= keyIndent) {
      end = lineStart;
      break;
    }
    if (content) {
      const start = lineStart + line.indexOf(content);
      spans.push({start, end: start + content.length});
      if (blockIndent < 0) blockIndent = indent;
      // Less indented than the block: YAML's block has ended; what follows is still withheld.
      if (indent < blockIndent) reading = false;
      if (reading) lines.push(line.slice(blockIndent));
    } else if (reading) {
      lines.push(blockIndent >= 0 && line.length > blockIndent ? line.slice(blockIndent) : '');
    }
    newline = next;
  }
  // White space on the lines after the last text is chomped like an empty line
  // by some parsers and kept by others (js-yaml keeps it where `yaml` does not).
  let lastText = lines.length;
  while (lastText > 0 && !/\S/.test(lines[lastText - 1])) lastText--;
  const reads = [blockRead(lines, header.startsWith('|')), blockRead(lines.slice(0, lastText), header.startsWith('|'))];
  return {spans, end, reads: [...new Set(reads)]};
}

/**
 * A YAML block's lines joined: `|` keeps them apart; `>` joins two lines of
 * text by a space, or by the empty lines between them, and keeps the line
 * breaks around a line that starts with white space. Line breaks that only
 * chomping or leading empty lines add are left out.
 */
function blockRead(lines: readonly string[], literal: boolean): string {
  let read: string;
  if (literal) {
    read = lines.join('\n');
  } else {
    const parts: string[] = [];
    let breaks = 0;
    let previousSpaced = false;
    for (const line of lines) {
      if (line === '') {
        breaks++;
        continue;
      }
      const spaced = line[0] === ' ' || line[0] === '\t';
      if (parts.length > 0) parts.push(!previousSpaced && !spaced ? (breaks > 0 ? '\n'.repeat(breaks) : ' ') : '\n'.repeat(breaks + 1));
      parts.push(line);
      previousSpaced = spaced;
      breaks = 0;
    }
    read = parts.join('');
  }
  let first = 0;
  let last = read.length;
  while (first < last && read[first] === '\n') first++;
  while (last > first && read[last - 1] === '\n') last--;
  return read.slice(first, last);
}

/**
 * One shell word: its quoted literals and unquoted runs up to an unquoted
 * metacharacter (`SHELL_WORD_END`), without the parts that are references,
 * and, when it holds none, its value as the shell reads it (`shellWordRead`).
 */
function shellWord(text: string, valueStart: number, tokens: readonly Token[]): ConfigValue {
  const parts: Array<{span: CredentialSpan; reference: boolean; token?: Token}> = [];
  let index = valueStart;
  // Past the line a `$(` was found unclosed on, the next `$(` is read again; before it, as characters.
  let unclosedUntil = valueStart;
  const opensCommand = (at: number) => at >= unclosedUntil && text[at] === '$' && text[at + 1] === '(';
  while (index < text.length && !SHELL_WORD_END.test(text[index])) {
    const token = tokenAt(tokens, index);
    if (token && token.start === index && token.kind === 'literal') {
      const reference = literalIsPureReference(text, token);
      parts.push({span: {start: token.contentStart, end: token.terminated ? token.contentEnd : token.end}, reference, token});
      index = token.end;
      continue;
    }
    // A command substitution (`$(cat key.txt)`, `` `cat key.txt` ``) says where a value comes from.
    const command = opensCommand(index) ? commandEnd(text, index, text.length)
      : text[index] === '`' ? text.indexOf('`', index + 1) + 1 || undefined : undefined;
    if (command !== undefined) {
      parts.push({span: {start: index, end: command}, reference: true});
      index = command;
      continue;
    }
    if (opensCommand(index)) unclosedUntil = lineEndFrom(text, index);
    // An escaped character, a space or a line break included, stays in the word.
    let end = index;
    while (end < text.length && !SHELL_WORD_END.test(text[end]) && !/["'`]/.test(text[end])
      && (end === index || !(opensCommand(end) || (text[end] === '$' && text[end + 1] === '\'')))) {
      end += text[end] === '\\' ? 2 : 1;
    }
    end = Math.min(end, text.length);
    if (end === index) break;
    parts.push({span: {start: index, end}, reference: PURE_REFERENCE.shell!.test(text.slice(index, end))});
    index = end;
  }
  const spans = parts.filter(part => !part.reference && part.span.end > part.span.start).map(part => part.span);
  if (parts.some(part => part.reference) || spans.length === 0) return {spans, end: index};
  return {spans, end: index, reads: shellWordReads(text, parts)};
}

/**
 * A shell word's value as shells read it, its quotes removed: single quotes
 * as written; in double quotes a `\` escapes only `$`, `` ` ``, `"`, `\`
 * and a line feed; unquoted, a `\` escapes the next character, a line feed
 * by dropping it (before a CRLF it escapes the carriage return); `$'…'`
 * decoded (`ansiCQuoted`), where bash ends that string at a NUL it decodes
 * and zsh keeps it.
 */
function shellWordReads(text: string, parts: ReadonlyArray<{span: CredentialSpan; token?: Token}>): string[] {
  // Each part's reading by bash and by zsh; the `$` of `$"…"` comes off the one before.
  const read: string[] = [];
  const zsh: string[] = [];
  for (const [index, {span, token}] of parts.entries()) {
    const content = text.slice(span.start, span.end);
    const quote = token ? text[token.contentStart - 1] : undefined;
    // `$"…"`: an unescaped `$` right before a double quote is not part of the value.
    const previous = parts[index - 1];
    const dollar = quote === '"' && previous !== undefined && !previous.token
      && /(?:^|[^\\])(?:\\\\)*\$$/.test(text.slice(previous.span.start, previous.span.end));
    if (dollar) {
      read[read.length - 1] = read[read.length - 1].slice(0, -1);
      zsh[zsh.length - 1] = zsh[zsh.length - 1].slice(0, -1);
    }
    let part: string;
    if (quote === '\'' && text[token!.start] === '$') {
      part = ansiCQuoted(content);
      const nul = part.indexOf('\0');
      zsh.push(part);
      read.push(nul < 0 ? part : part.slice(0, nul));
      continue;
    }
    if (quote === '\'') {
      part = content;
    } else if (quote === '"') {
      part = content.replace(/\\([$`"\\\n])/g, (_escape, character: string) => character === '\n' ? '' : character);
    } else {
      part = content.replace(/\\([\s\S])/g, (_escape, character: string) => character === '\n' ? '' : character);
    }
    read.push(part);
    zsh.push(part);
  }
  return [...new Set([read.join(''), zsh.join('')])];
}

// bash's `$'…'` escapes: a C escape, an octal, hex or Unicode code, `\cX` a
// control character; any other `\` stays.
const ANSI_C_ESCAPE = /\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|c([\s\S])|([\s\S]))/g;
const ANSI_C_CHARACTER: Readonly<Record<string, string>> = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '\'': '\'', '"': '"', '?': '?',
};

/** The value of bash's `$'…'` quoting from its content. */
function ansiCQuoted(content: string): string {
  return content.replace(ANSI_C_ESCAPE, (escape, octal, hex, unicode, wide, control, character) => {
    const code = octal !== undefined ? parseInt(octal, 8) : parseInt(hex ?? unicode ?? wide ?? '', 16);
    if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f);
    if (character !== undefined) return ANSI_C_CHARACTER[character] ?? escape;
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}

// A shell word that assigns or passes a credential, anywhere a word starts:
// `NAME=…`, `NAME+=…` and `NAME[i]=…` (after `export`, `declare -x`,
// `readonly`, `local`, another assignment or a command), an array
// `NAME=(…)`, and a long option `--name=…` or `--name …`.
const SHELL_ASSIGNMENT = /(?<![\w$@.-])(?:([A-Za-z_]\w*)(?:\[[^\]\n]{0,256}\])?\+?=|(--[A-Za-z][\w.-]*)(=|[ \t]+))/g;

/** Every credential a shell word assigns or passes (`SHELL_ASSIGNMENT`), each value one shell word. */
function shellKeyedSpans(text: string, scan: CodeScan, sink: DataSink): CredentialSpan[] {
  const {tokens} = scan;
  const spans: CredentialSpan[] = [];
  const readUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  for (const match of text.matchAll(SHELL_ASSIGNMENT)) {
    const at = match.index!;
    const strength = keyStrength(match[1] ?? match[2]);
    if (!strength || at < readUntil[strength] || tokenAt(tokens, at) || !startsShellWord(text, at)) continue;
    const valueStart = at + match[0].length;
    // `--password -v`: an option, not its value.
    if (match[3] !== undefined && match[3] !== '=' && (text[valueStart] === '-' || SHELL_WORD_END.test(text[valueStart] ?? ';'))) continue;
    const value = match[1] !== undefined && text[valueStart] === '(' ? shellArray(text, valueStart, tokens) : shellWord(text, valueStart, tokens);
    const judged = judgedValue(text, value, 'shell', strength);
    readUntil.weak = Math.max(readUntil.weak, value.end);
    if (strength === 'strong') readUntil.strong = Math.max(readUntil.strong, value.end);
    append(spans, judged.spans);
    if (judged.reads) append(sink.reads, judged.reads);
  }
  return spans;
}

/** A shell array `(…)`: every word in it, to its `)`. */
function shellArray(text: string, open: number, tokens: readonly Token[]): ConfigValue {
  const spans: CredentialSpan[] = [];
  const reads: string[] = [];
  let index = open + 1;
  while (index < text.length && text[index] !== ')') {
    if (/[ \t\n]/.test(text[index]) || (text[index] === '\\' && text[index + 1] === '\n')) {
      index += text[index] === '\\' ? 2 : 1;
      continue;
    }
    const word = shellWord(text, index, tokens);
    append(spans, word.spans);
    if (word.reads) append(reads, word.reads);
    index = word.end > index ? word.end : index + 1;
  }
  return {spans, end: Math.min(index + 1, text.length), reads};
}

const CONFIG_REFERENCE: Partial<Record<Language, RegExp>> = {
  dotenv: CONFIG_PLACEHOLDER,
  yaml: CONFIG_PLACEHOLDER,
  properties: CONFIG_PLACEHOLDER,
  ini: CONFIG_PLACEHOLDER,
  toml: CONFIG_PLACEHOLDER,
  // `${NAME}`; `$(NAME)` and functions such as `$(shell cat key.txt)` are `wholeCommand`.
  make: /^\$\{[^{}]*\}$/,
};

/** A config value judged as one: a reference is kept, and a weak key's must look like a credential. */
function judgedValue(text: string, value: ConfigValue, language: Language, strength: KeyStrength): ConfigValue {
  const logical = value.spans.map(span => text.slice(span.start, span.end)).join('');
  const kept = !logical || CONFIG_REFERENCE[language]?.test(logical) || (language === 'make' && wholeCommand(logical))
    || (strength === 'weak' && !credentialShaped(logical));
  return kept ? {spans: [], end: value.end} : value;
}

/** A config value read whole the way its format reads it, and judged as one (`judgedValue`). */
function configValue(text: string, valueStart: number, keyIndent: number, language: Language,
  scan: CodeScan, strength: KeyStrength): ConfigValue {
  const {tokens} = scan;
  const judged = (value: ConfigValue) => judgedValue(text, value, language, strength);
  if (language === 'dotenv') return judged(dotenvValue(text, valueStart));
  if (language === 'ini') return iniValue(text, valueStart, keyIndent, scan, strength, judged);
  if (language === 'yaml') valueStart = yamlValueStart(text, valueStart, keyIndent);
  const literal = tokenAt(tokens, valueStart);
  if (literal && literal.kind === 'literal' && literal.start === valueStart) {
    const span = keyedLiteralSpan(text, literal, scan, strength);
    let reads: string[] | undefined;
    // A quoted YAML scalar folds its line breaks like a plain one.
    if (span && language === 'yaml' && text.slice(span.start, span.end).includes('\n')) {
      reads = foldedLines(text, spanLineValues(text, span), text[literal.start] === '"');
    } else if (span && language === 'toml') {
      reads = [tomlStringRead(text, literal)];
    }
    return {spans: span ? [span] : [], end: literal.end, reads};
  }
  const lineEnd = lineEndFrom(text, valueStart);
  let line = text.slice(valueStart, lineEnd).replace(/\r$/, '');
  if (language === 'yaml') {
    const header = line.replace(/[ \t]+#.*$/, '').trimEnd();
    if (YAML_BLOCK_HEADER.test(header)) return judged(yamlBlockScalar(text, valueStart, keyIndent, header));
    line = line.replace(/[ \t]+#.*$/, '');
  } else if (language === 'toml') {
    line = line.replace(/[ \t]+[#;].*$/, '');
  } else if (language === 'make') {
    line = line.replace(/(?<!\\)#.*$/, '');
  }
  const first = line.trimEnd();
  const spans: CredentialSpan[] = first ? [{start: valueStart, end: valueStart + first.length}] : [];
  if (language === 'properties' && first.includes('\\')) return judged({spans, end: lineEnd, reads: [decodedPropertiesEscapes(first)]});
  let end = lineEnd;
  // A YAML plain scalar goes on over deeper-indented lines, folded.
  if (language === 'yaml' && first) {
    const rest = deeperLines(text, valueStart, keyIndent);
    append(spans, rest.spans);
    end = rest.end;
    if (spans.length > 1) return judged({spans, end, reads: foldedLines(text, spans)});
  }
  return judged({spans, end});
}

// python-dotenv's escapes: in double quotes `\\ \' \" \a \b \f \n \r \t \v`, in single quotes `\\ \'`.
const PYTHON_DOTENV_ESCAPED: Readonly<Record<string, string>> = {a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v'};

/**
 * A dotenv value as dotenv libraries read it. A quoted one (to the same
 * quote, a `\` before it not closing it, across lines) counts only when
 * white space and a `#` comment at most follow it on its line; in double
 * quotes node's dotenv expands `\n` and `\r`, python-dotenv its C escapes.
 * Otherwise node's dotenv reads the line to its first `#`, without outer
 * quotes the same on both ends, and python-dotenv an unquoted value to white
 * space and `#` (one it cannot read, it skips).
 */
function dotenvValue(text: string, valueStart: number): ConfigValue {
  const lineEnd = lineEndFrom(text, valueStart);
  const quote = text[valueStart];
  if (quote === '"' || quote === '\'' || quote === '`') {
    let close = valueStart + 1;
    while (close < text.length && text[close] !== quote) close += text[close] === '\\' && text[close + 1] === quote ? 2 : 1;
    const closeLineEnd = close < text.length ? lineEndFrom(text, close) : text.length;
    if (close < text.length && /^\s*(?:#.*)?$/.test(text.slice(close + 1, closeLineEnd).replace(/\r$/, ''))) {
      const content = text.slice(valueStart + 1, close);
      const reads = quote === '"'
        ? [content.replace(/\\n/g, '\n').replace(/\\r/g, '\r'),
          content.replace(/\\([\\'"abfnrtv])/g, (_escape, character: string) => PYTHON_DOTENV_ESCAPED[character] ?? character)]
        : quote === '\'' ? [content.replace(/\\([\\'])/g, '$1')] : [];
      return {spans: [{start: valueStart + 1, end: close}], end: closeLineEnd, reads};
    }
  }
  const line = text.slice(valueStart, lineEnd).replace(/\r$/, '');
  const atHash = line.replace(/#.*$/, '').trimEnd();
  const unquoted = /^(['"`])([\s\S]*)\1$/.exec(atHash);
  const nodeRead = !unquoted ? atHash
    : unquoted[1] === '"' ? unquoted[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r') : unquoted[2];
  // python-dotenv reads no value that starts with a quote here.
  const value = quote === '"' || quote === '\'' ? atHash : line.replace(/\s+#.*$/, '').trimEnd();
  return {spans: value ? [{start: valueStart, end: valueStart + value.length}] : [], end: lineEnd,
    reads: nodeRead !== value ? [nodeRead] : undefined};
}

/**
 * An INI value, read every way INI readers read it, each judged, and what any
 * of them withholds withheld. Python's configparser takes no inline comment:
 * its value is the rest of the key's line, then every following line indented
 * deeper than the key, a blank line between them kept and a whole-line `#` or
 * `;` comment skipped, joined by line feeds. A reader that takes an inline
 * comment ends the first line at white space and `;` or `#`; one that strips
 * quotes reads a quoted first value without them.
 */
function iniValue(text: string, valueStart: number, keyIndent: number, scan: CodeScan, strength: KeyStrength,
  judged: (value: ConfigValue) => ConfigValue): ConfigValue {
  const firstEnd = lineEndFrom(text, valueStart);
  // Each line of the value from where it starts, without its line break: the
  // first from the value, the others from their first non-blank character;
  // undefined for a blank line between two.
  const lines: Array<{readonly start: number; readonly text: string} | undefined> =
    [{start: valueStart, text: text.slice(valueStart, firstEnd).replace(/\r$/, '')}];
  let blanks = 0;
  let end = firstEnd;
  for (let lineStart = firstEnd + 1; lineStart <= text.length && firstEnd < text.length;) {
    const lineEnd = lineEndFrom(text, lineStart);
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    const content = line.trim();
    if (!content) {
      blanks++;
    } else if (content[0] !== '#' && content[0] !== ';') {
      const indent = line.search(/\S/);
      if (indent <= keyIndent) break;
      for (; blanks > 0; blanks--) lines.push(undefined);
      lines.push({start: lineStart + indent, text: line.slice(indent)});
      end = lineEnd;
    }
    lineStart = lineEnd + 1;
  }
  const reading = (inlineComments: boolean): ConfigValue => {
    const spans: CredentialSpan[] = [];
    const read: string[] = [];
    for (const line of lines) {
      const content = !line ? '' : (inlineComments ? line.text.replace(/[ \t]+[#;].*$/, '') : line.text).trimEnd();
      if (line && content) spans.push({start: line.start, end: line.start + content.length});
      read.push(content);
    }
    return judged({spans, end, reads: [read.join('\n')]});
  };
  const readings = [reading(false), reading(true)];
  const literal = tokenAt(scan.tokens, valueStart);
  if (literal?.kind === 'literal' && literal.start === valueStart) {
    const span = keyedLiteralSpan(text, literal, scan, strength);
    if (span) readings.push(judged({spans: [span], end}));
  }
  return {
    spans: mergedSpans(readings.flatMap(value => value.spans)),
    end,
    reads: readings.flatMap(value => value.reads ?? []),
  };
}

/**
 * A Java properties value as `Properties.load` reads it (its lines already
 * joined, `logicalText`): `\t`, `\n`, `\f`, `\r` and `\uXXXX` decoded, any
 * other escaped character as itself (`\b` is `b`, `\x41` is `x41`).
 */
function decodedPropertiesEscapes(value: string): string {
  return value.replace(/\\(?:u([0-9A-Fa-f]{4})|([\s\S]))/g, (_escape, unicode, character) =>
    unicode ? String.fromCharCode(parseInt(unicode, 16)) : ({t: '\t', n: '\n', f: '\f', r: '\r'})[character as string] ?? character);
}

/**
 * A TOML string as TOML reads it. A multi-line string drops a line break
 * right after its opening quotes. A basic string decodes its escapes, and in a
 * multi-line one a `\` that ends a line goes with the white space and line
 * breaks after it. A literal string is as written.
 */
function tomlStringRead(text: string, token: Token): string {
  const quote = text.slice(token.start, token.contentStart);
  let content = text.slice(token.contentStart, token.contentEnd);
  if (quote.length === 3) content = content.replace(/^\r?\n/, '');
  if (quote[0] === "'") return content;
  return content.replace(/\\(?:([ \t]*(?:\r\n|\n)[ \t\r\n]*)|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|([\s\S]))/g,
    (escape, lineEnd, unicode, wide, hex, character) => {
      if (lineEnd !== undefined) return quote.length === 3 ? '' : escape;
      const code = parseInt(unicode ?? wide ?? hex ?? '', 16);
      if (character === undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
      return ({b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b'})[character as string] ?? character;
    });
}

/** Where the body of a `define` that starts after `from` ends: the line of the `endef` that closes it. */
function makeDefineEnd(text: string, from: number): number {
  let depth = 1;
  for (let lineStart = from; lineStart < text.length;) {
    const lineEnd = lineEndFrom(text, lineStart);
    const line = text.slice(lineStart, lineEnd);
    if (MAKE_ENDEF_LINE.test(line) && --depth === 0) return lineStart;
    if (MAKE_DEFINE_LINE.test(line)) depth++;
    lineStart = lineEnd + 1;
  }
  return text.length;
}

/** The body of each credential-named make `define` up to its `endef`: every non-blank line. */
function makeDefineSpans(text: string, scan: CodeScan): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  // A definition inside a body already read at its strength or stronger is part of it.
  const readUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  for (const match of text.matchAll(MAKE_DEFINE)) {
    const strength = keyStrength(match[1]);
    if (!strength || match.index! < readUntil[strength] || tokenAt(scan.tokens, match.index! + match[0].indexOf('define'))) continue;
    const bodyStart = match.index! + match[0].length;
    const end = makeDefineEnd(text, lineEndFrom(text, bodyStart) + 1);
    readUntil.weak = Math.max(readUntil.weak, end);
    if (strength === 'strong') readUntil.strong = Math.max(readUntil.strong, end);
    const lines: CredentialSpan[] = [];
    for (let lineStart = bodyStart; lineStart < end;) {
      const lineEnd = Math.min(lineEndFrom(text, lineStart), end);
      const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
      const content = line.trim();
      if (content) {
        const start = lineStart + line.indexOf(content);
        lines.push({start, end: start + content.length});
      }
      lineStart = lineEnd + 1;
    }
    append(spans, judgedValue(text, {spans: lines, end}, 'make', strength).spans);
  }
  return spans;
}

// CMake's `set(NAME value…)` and `set(ENV{NAME} value…)`, its command name in
// any case. Its options take the end of the call only: a last `PARENT_SCOPE`,
// or `CACHE <type> <docstring> [FORCE]`. An unquoted argument runs to
// whitespace or one of `()"#`; a parenthesis inside the call is an argument of
// its own, and only the call's own `)` ends it.
const CMAKE_SET = /(?<![\w$.-])set[ \t]*\(/gi;
const CMAKE_ARGUMENT_STOP = /[\s()"#]/;
const CMAKE_REFERENCE = /^\$(?:ENV)?\{[^{}]*\}$/;
const CMAKE_CACHE_TYPES = new Set(['BOOL', 'FILEPATH', 'PATH', 'STRING', 'INTERNAL']);

/**
 * A CMake argument as CMake reads it. A bracket argument is as written, but
 * for a line break right after its opening. Elsewhere `\t`, `\n` and `\r`
 * are decoded and any other escaped character is itself, except that in
 * quotes `\;` stays as written and a `\` before a line break continues it.
 */
function cmakeArgumentRead(text: string, start: number, end: number, token?: Token): string {
  if (token && text[token.start] === '[') return text.slice(token.contentStart, token.contentEnd).replace(/^\r?\n/, '');
  const quoted = token !== undefined;
  const content = quoted ? text.slice(token.contentStart, token.contentEnd) : text.slice(start, end);
  return content.replace(/\\(\r\n|[\s\S])/g, (escape, character: string) => {
    if (character === '\n' || character === '\r\n') return '';
    if (character === ';') return quoted ? escape : ';';
    return ({t: '\t', n: '\n', r: '\r'})[character] ?? character;
  });
}

function cmakeSetSpans(text: string, scan: CodeScan, sink: DataSink): CredentialSpan[] {
  const {tokens} = scan;
  const spans: CredentialSpan[] = [];
  // A `set(` inside the arguments of one already read at its strength or
  // stronger adds nothing; skipping it keeps unclosed calls linear.
  const readUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  const argumentEnd = (at: number) => {
    let end = at;
    while (end < text.length && !CMAKE_ARGUMENT_STOP.test(text[end])) end++;
    return end;
  };
  for (const match of text.matchAll(CMAKE_SET)) {
    if (tokenAt(tokens, match.index!)) continue;
    let at = nextSignificant(text, match.index! + match[0].length, tokens);
    const nameToken = tokenAt(tokens, at);
    const quoted = nameToken?.kind === 'literal' && nameToken.start === at;
    const nameEnd = quoted ? nameToken.end : argumentEnd(at);
    const name = quoted ? text.slice(nameToken.contentStart, nameToken.contentEnd) : text.slice(at, nameEnd);
    const strength = keyStrength(/^ENV\{(.*)\}$/.exec(name)?.[1] ?? name);
    if (!strength || match.index! < readUntil[strength]) continue;
    // The call's arguments, its inner parentheses among them.
    const items: Array<{readonly start: number; readonly end: number; readonly token?: Token; readonly paren?: boolean}> = [];
    let depth = 0;
    for (at = nameEnd; ;) {
      at = nextSignificant(text, at, tokens);
      if (at >= text.length || (text[at] === ')' && depth === 0)) break;
      if (text[at] === '(' || text[at] === ')') {
        depth += text[at] === '(' ? 1 : -1;
        items.push({start: at, end: at + 1, paren: true});
        at++;
        continue;
      }
      const token = tokenAt(tokens, at);
      if (token?.kind === 'literal' && token.start === at) {
        items.push({start: at, end: token.end, token});
        at = token.end;
        continue;
      }
      const end = argumentEnd(at);
      if (end === at) { at++; continue; }
      items.push({start: at, end});
      at = end;
    }
    const option = (index: number) => {
      const item = items[index];
      return item && !item.token && !item.paren ? text.slice(item.start, item.end) : undefined;
    };
    let values = items.length;
    if (option(values - 1) === 'PARENT_SCOPE') {
      values--;
    } else {
      const force = option(values - 1) === 'FORCE' ? 1 : 0;
      const cache = values - force - 3;
      if (option(cache) === 'CACHE' && CMAKE_CACHE_TYPES.has(option(cache + 1) ?? '')) values = cache;
    }
    // Several values are one CMake list, read with `;` between them, each as CMake reads it.
    const list: string[] = [];
    for (const item of items.slice(0, values)) {
      // A parenthesis inside the call is an element of the list (`abcd(EFGH)` is `abcd;(;EFGH;)`).
      if (item.paren) { list.push(text[item.start]); continue; }
      if (item.token) {
        const span = keyedLiteralSpan(text, item.token, scan, strength);
        if (span) {
          spans.push(span);
          list.push(cmakeArgumentRead(text, item.start, item.end, item.token));
        }
        continue;
      }
      const argument = text.slice(item.start, item.end);
      if (!CMAKE_REFERENCE.test(argument) && (strength === 'strong' || credentialShaped(argument))) {
        spans.push({start: item.start, end: item.end});
        list.push(cmakeArgumentRead(text, item.start, item.end));
      }
    }
    if (list.some(element => element !== '(' && element !== ')')) sink.reads.push(list.join(';'));
    readUntil.weak = Math.max(readUntil.weak, at);
    if (strength === 'strong') readUntil.strong = Math.max(readUntil.strong, at);
  }
  return spans;
}

function configKeyedSpans(text: string, context: LanguageContext, scan: CodeScan, sink: DataSink): CredentialSpan[] {
  if (context.language === 'cmake') return cmakeSetSpans(text, scan, sink);
  if (context.language === 'shell') return shellKeyedSpans(text, scan, sink);
  const spans: CredentialSpan[] = [];
  // A key inside a value already read is part of that value: skipping it
  // keeps nested continuations linear. A region a weak key read is read again
  // for a strong key in it.
  const readUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  // Every key form the language reads, in text order; at one position the first form is tried first.
  const forms = context.language === 'make' ? [MAKE_ASSIGNMENT] : CONFIG_KEYS[context.language] ?? [CONFIG_KEY];
  const matches = forms.flatMap((form, order) => [...text.matchAll(form)].map(match => ({match, order})))
    .sort((left, right) => left.match.index! - right.match.index! || left.order - right.order)
    .map(({match}) => match);
  for (const match of matches) {
    const strength = phraseStrength(match[3]);
    if (!strength || match.index! < readUntil[strength]) continue;
    if (tokenAt(scan.tokens, match.index! + match[0].indexOf(match[3]))?.kind === 'comment') continue;
    const value = configValue(text, match.index! + match[0].length, match[1].length, context.language, scan, strength);
    readUntil.weak = Math.max(readUntil.weak, value.end);
    if (strength === 'strong') readUntil.strong = Math.max(readUntil.strong, value.end);
    append(spans, value.spans);
    if (value.reads) append(sink.reads, value.reads);
  }
  if (context.language === 'make') append(spans, makeDefineSpans(text, scan));
  return spans;
}

// ---------------------------------------------------------------------------
// Data and prose: literal contents, comments, config, markup text and plain text

// `key = value`, `key: value`, `key(value)`, with any whitespace (line breaks
// included) before the value; a key may be a flag (`--password=…`) or up to
// three words (`API Key: …`, `"Private Key": …`). A flag or
// an all-caps key may also take a quoted value after spaces (`--password "x"`,
// SQL's `PASSWORD 'x'`), and a long flag an unquoted one (`--password x`)
// that is not another flag; after a prose word ("the error token "ERROR"") a
// quote is not a value. `endsInDanglingCredentialPrefix` holds owner text for
// exactly this grammar, with the same value reader.
const DATA_KEY =
  /(?<![\w$@.-])(\\?["']?(?:--?)?(?:[A-Za-z][\w$.-]*[ \t]+){0,2}[A-Za-z_$@][\w$.-]*\\?["']?)(?:[ \t]*(?<![:=!<>])(?::=|=>|[:=](?![:=>]))|\((?=\s*\\?["'`]))\s*/g;
// A quoted key with a line break before its separator (`"password"⏎:⏎ value`);
// on one line `DATA_KEY` reads it.
const QUOTED_DATA_KEY =
  /(?<![\w$@.-])(\\?["'](?:[A-Za-z][\w$.-]*[ \t]+){0,2}[A-Za-z_$@][\w$.-]*\\?["'])[ \t]*(?:\r?\n|\r)\s*(?<![:=!<>])(?::=|=>|[:=](?![:=>]))\s*/g;
const SPACED_DATA_KEY = /(?<![\w$@.-])(--?[A-Za-z][\w-]*|[A-Z][A-Z0-9_]*)[ \t]+(?=\\?["'])/g;
const FLAG_DATA_KEY = /(?<![\w$@.-])(--[A-Za-z][\w-]*)[ \t]+(?=[^\s"'\\-]|\\[^\n\r"'])/g;

interface DataKey {
  readonly keyAt: number;
  readonly key: string;
  readonly valueAt: number;
  /** Given by `=`, `:=`, `=>` or as a flag's argument; after `:` it may be a label's text. */
  readonly assigned: boolean;
}

/** Every key form in [start, end), in text order: each key with where its value starts. */
function dataKeys(text: string, start: number, end: number): DataKey[] {
  const segment = text.slice(start, end);
  const keys: DataKey[] = [];
  const add = (match: RegExpMatchArray, assigned: boolean) => {
    // Words before the last are part of the key only when together they name a
    // credential the last word does not (`API Key`); otherwise the key, and the
    // pair it starts, begins at its last word as for any key.
    let key = match[1];
    let keyAt = start + match.index!;
    const last = key.search(/\S+$/);
    if (last > 0 && (keyStrength(key.slice(last)) !== undefined || keyStrength(key) === undefined)) {
      keyAt += last;
      key = key.slice(last);
    }
    keys.push({keyAt, key, valueAt: start + match.index! + match[0].length, assigned});
  };
  for (const match of segment.matchAll(DATA_KEY)) add(match, match[0].slice(match[1].length).includes('='));
  for (const match of segment.matchAll(QUOTED_DATA_KEY)) add(match, match[0].slice(match[1].length).includes('='));
  for (const match of segment.matchAll(SPACED_DATA_KEY)) add(match, true);
  for (const match of segment.matchAll(FLAG_DATA_KEY)) add(match, true);
  return keys.sort((left, right) => left.keyAt - right.keyAt);
}
const DATA_VALUE_STOP = /[\s'"`;,&#<>)\]}]/;

/**
 * Whether an unquoted data value ends at `index`: at white space or a
 * delimiter. A lone carriage return is a character where the text is read
 * with it as one (`LoneCarriageReturn`); where it is a line break the
 * reading has none left.
 */
function endsDataValue(text: string, index: number): boolean {
  const char = text[index];
  return DATA_VALUE_STOP.test(char) && (char !== '\r' || text[index + 1] === '\n');
}
const STRUCTURE_STOP = /[\s,:=[\]{}"'`]/;
const FORMAT_PLACEHOLDER = /^(?:%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[a-zA-Z@]|\{\w*\}|<\w+>)$/;
const MEMBER_PATH_OR_CALL = /^[A-Za-z_$@][\w$]*(?:(?:\.|::|->|\?\.|!!\.)[A-Za-z_$][\w$]*)*(?:\(|\[|$)/;
const DATA_QUOTE = /^(?:\\(["'])|("""|\'\'\'|["'`]))/;

interface DataQuote {
  /** The quoted characters, or for an unclosed quote everything it would have held. */
  readonly span: CredentialSpan;
  readonly closed: boolean;
  /** Where reading stopped: past the closing quote, or where the open quote ends. */
  readonly next: number;
  /** The quote is still open at `end`: later text could extend it. */
  readonly pending: boolean;
}

/**
 * The quoted value starting at `at`, read by the tokenizer's quote reader with
 * escapes up to `end`: `"…"`, `'…'`, a backtick or triple quote across lines,
 * or, inside data, an escaped quote (`\"…\"`). An unclosed single-line quote
 * ends at its first unescaped line break, any other at `end`.
 */
function readDataQuote(text: string, at: number, end: number): DataQuote | undefined {
  const opening = DATA_QUOTE.exec(text.slice(at, at + 3));
  if (!opening) return undefined;
  if (opening[1]) {
    // Up to the escaped close, the line break or `end`, whichever comes first:
    // a search past them would be repeated for every key on a long line.
    let index = at + 2;
    for (; index < end && text[index] !== '\n'; index++) {
      if (text[index] === '\\' && text[index + 1] === opening[1] && index + 2 <= end) {
        return {span: {start: at + 2, end: index}, closed: true, next: index + 2, pending: false};
      }
    }
    return {span: {start: at + 2, end: index}, closed: false, next: index, pending: index === end};
  }
  const quote = opening[2];
  const multiline = quote.length === 3 || quote === '`';
  const token = readQuoted(text, at, quote.length, {quote, options: {escapes: true, multiline, interpolation: 'none'}}, [], end);
  return {span: {start: token.contentStart, end: token.contentEnd}, closed: token.terminated, next: token.end,
    pending: !token.terminated && token.end === end};
}

interface DataValue {
  readonly spans: CredentialSpan[];
  readonly next: number;
  /** Reading reached `end` inside a quote or structure: later text could extend the value. */
  readonly pending: boolean;
  /** Kept as code (a command, an expression), which can hold keys of its own; a reference holds none. */
  readonly code?: boolean;
}

/** In prose a short word or a code expression after "token:" is not a secret. */
function proseValue(value: string): boolean {
  if (value.length < 8 || /==|!=|&&|\|\||<=|>=/.test(value)) return false;
  // A name from code: a member path or a call, or a camelCase, snake_case or `$` name. A plain
  // lowercase word is a value (`correcthorsebatterystaple`).
  return !(MEMBER_PATH_OR_CALL.test(value) && (/[.(\[]/.test(value) || (!/\d/.test(value) && /[A-Z_$]/.test(value))));
}

/** A `[…]` or `{…}` value: every quoted string and scalar in it, to its matching close or `end`. */
function structuredValue(text: string, at: number, end: number, prose: boolean): DataValue {
  const spans: CredentialSpan[] = [];
  let depth = 0;
  let index = at;
  while (index < end) {
    const char = text[index];
    if (char === '[' || char === '{') { depth++; index++; continue; }
    if (char === ']' || char === '}') {
      index++;
      if (--depth === 0) return {spans, next: index, pending: false};
      continue;
    }
    const quote = readDataQuote(text, index, end);
    if (quote) {
      if (/\S/.test(text.slice(quote.span.start, quote.span.end))) spans.push(quote.span);
      if (quote.pending) return {spans, next: quote.next, pending: true};
      index = Math.max(quote.next, index + 1);
      continue;
    }
    if (/[\s,:=]/.test(char)) { index++; continue; }
    let scalarEnd = index + 1;
    while (scalarEnd < end && !STRUCTURE_STOP.test(text[scalarEnd])) scalarEnd++;
    const scalar = text.slice(index, scalarEnd);
    if (!prose || proseValue(scalar)) spans.push({start: index, end: scalarEnd});
    index = scalarEnd;
  }
  return {spans, next: end, pending: true};
}

/**
 * The value after a credential key in data or prose, read to its end: a
 * quote whole (an unclosed one to its end), a structure to its close, or an
 * unquoted scalar. A reference, a format placeholder, a YAML block header and
 * a sentence ("Invalid token: expected 'true'") are not values.
 */
function readDataValue(text: string, at: number, end: number, prose: boolean, assigned = false): DataValue | undefined {
  const quote = readDataQuote(text, at, end);
  if (quote) {
    const value = text.slice(quote.span.start, quote.span.end);
    const withheld = /\S/.test(value) && (!quote.closed || (!ANY_REFERENCE.test(value) && !FORMAT_PLACEHOLDER.test(value)));
    return {spans: withheld ? [quote.span] : [], next: quote.next, pending: quote.pending};
  }
  if (text[at] === '[' || text[at] === '{') return structuredValue(text, at, end, prose);
  let valueEnd = at;
  // A `${` already found unclosed up to here: another inside it is too, which keeps a run of them linear.
  let unclosedUntil = at;
  while (valueEnd < end) {
    const char = text[valueEnd];
    if (char === '$' && text[valueEnd + 1] === '{' && valueEnd >= unclosedUntil) {
      let close = valueEnd + 2;
      while (close < end && text[close] !== '}' && !REFERENCE_INNER_STOP.test(text[close])) close++;
      if (close < end && text[close] === '}') { valueEnd = close + 1; continue; }
      unclosedUntil = close;
    }
    if (char === '$' && text[valueEnd + 1] === '(') {
      const close = commandEnd(text, valueEnd, end);
      if (close !== undefined) { valueEnd = close; continue; }
    }
    // A line continuation (`\` at a line end) is syntax, not part of the value;
    // any other `\` keeps the character after it in the value (`correcthorse\ battery`).
    if (char === '\\') {
      const next = text[valueEnd + 1];
      if (valueEnd + 1 >= end || next === '\n' || (next === '\r' && text[valueEnd + 2] === '\n')) break;
      valueEnd += 2;
      continue;
    }
    if (endsDataValue(text, valueEnd)) break;
    valueEnd++;
  }
  // In prose a period that ends the sentence is not part of the value.
  if (prose && valueEnd - 1 > at && text[valueEnd - 1] === '.' && (valueEnd >= end || /\s/.test(text[valueEnd]))) valueEnd--;
  const value = text.slice(at, valueEnd);
  if (!value) return undefined;
  // Not a value; a key inside it is not a key either.
  const kept: DataValue = {spans: [], next: valueEnd, pending: false};
  if (ANY_REFERENCE.test(value) || FORMAT_PLACEHOLDER.test(value) || YAML_BLOCK_HEADER.test(value)) return kept;
  if (wholeCommand(value)) return {...kept, code: true};
  // After a label (`token: expected format`) one word and more words are a sentence; an assigned word is a value.
  if (!assigned && /^[A-Za-z]+$/.test(value) && /^[ \t]+[^\s&;,]/.test(text.slice(valueEnd, Math.min(end, valueEnd + 3)))) return kept;
  if (prose && !proseValue(value)) return {...kept, code: true};
  return {spans: [{start: at, end: valueEnd}], next: valueEnd, pending: false};
}

/** Key-value pairs inside data (literal contents, config, attribute values) or prose (comments, text). */
type CredentialDataKey = DataKey & {readonly strength: KeyStrength};

/**
 * The credential keys in [start, end), and where a key there starts a new
 * pair: a credential key, or any key given a value by `=`, `:=`, `=>` or as a
 * flag (`user=bob`). A label (`provider:` in `secret:provider:test`) is not one.
 */
function credentialDataKeys(text: string, start: number, end: number): {keys: CredentialDataKey[]; boundaries: number[]} {
  const keys: CredentialDataKey[] = [];
  const boundaries: number[] = [];
  for (const key of dataKeys(text, start, end)) {
    const strength = phraseStrength(key.key);
    if (strength) keys.push({...key, strength});
    if (strength || key.assigned) boundaries.push(key.keyAt);
  }
  return {keys, boundaries};
}

/**
 * Where a value read up to the next key ends without what separates it from
 * that key: blanks, an escaped blank, and `:;,&|` (`abcdef123456:`,
 * `abcdef123456\ `).
 */
function beforeSeparator(text: string, start: number, end: number): number {
  let at = end;
  while (at > start) {
    const char = text[at - 1];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      at--;
      if (at > start && text[at - 1] === '\\') at--;
    } else if (':;,&|'.includes(char)) {
      at--;
    } else {
      break;
    }
  }
  return at;
}

/**
 * Where the values read so far reach, by the strength of their keys, and what
 * is registered for the keys inside them. A key inside a value read at its
 * strength or stronger is part of that value (`--password=prefix\ password=x`,
 * `password="a token=b"`) and is not read again, which keeps a long run of
 * keys linear. What follows such a key is registered as its value twice: to
 * the end of the value it is in, and up to the next key in that value that
 * starts a pair (`user=` included), so `token=abcdef123456` inside a password is
 * withheld where it recurs alone however many keys follow it, and as the data
 * reader reads it on its own (`"the token=abc12345 is old"`: `abc12345`). A
 * value read for a key has its part up to the next key inside it registered
 * too. What a weak key's value holds is read again for a strong key in it.
 */
class KeyCoverage {
  private readonly readUntil: Record<KeyStrength, number> = {strong: -1, weak: -1};
  private readonly valueEnd: Record<KeyStrength, number> = {strong: -1, weak: -1};

  /** `boundaries`: where each key that starts a pair starts, sorted. */
  constructor(private readonly text: string, private readonly keys: readonly CredentialDataKey[],
    private readonly boundaries: readonly number[], private readonly registered: CredentialSpan[]) {}

  /** Whether `keys[index]` is inside a value already read; if so, what follows it there is registered. */
  holds(index: number): boolean {
    const {keyAt, valueAt, strength} = this.keys[index];
    if (keyAt >= this.readUntil[strength]) return false;
    const end = this.valueEnd[strength];
    if (valueAt < end) {
      this.registered.push({start: valueAt, end});
      this.registerOwnValue(index, end, true);
    }
    return true;
  }

  /** The value of `keys[index]` read up to `next`, `spans` the parts of it withheld. */
  read(index: number, next: number, spans: readonly CredentialSpan[]): void {
    let end = -1;
    for (const span of spans) end = Math.max(end, span.end);
    if (end >= 0) this.registerOwnValue(index, end, false);
    const covered = this.keys[index].strength === 'strong' ? ['strong', 'weak'] as const : ['weak'] as const;
    for (const strength of covered) {
      this.readUntil[strength] = Math.max(this.readUntil[strength], next);
      this.valueEnd[strength] = Math.max(this.valueEnd[strength], end);
    }
  }

  /**
   * The value of `keys[index]` as the data reader reads it on its own, up to
   * the next key that starts a pair before `end` without what separates the
   * two. A key inside another value gets it even when no key follows
   * (`"the token=abc12345 is old"`: `abc12345`); a value read for its own key
   * already is that reading unless a key follows inside it.
   */
  private registerOwnValue(index: number, end: number, inside: boolean): void {
    const {valueAt, assigned} = this.keys[index];
    let low = 0;
    let high = this.boundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.boundaries[middle] < valueAt) low = middle + 1;
      else high = middle;
    }
    const bounded = low < this.boundaries.length && this.boundaries[low] < end;
    if (!bounded && !inside) return;
    const limit = bounded ? this.boundaries[low] : end;
    for (const span of readDataValue(this.text, valueAt, limit, false, assigned)?.spans ?? []) {
      const spanEnd = bounded && span.end === limit ? beforeSeparator(this.text, span.start, span.end) : span.end;
      if (spanEnd > span.start) this.registered.push({start: span.start, end: spanEnd});
    }
  }
}

/**
 * The values `keys[from]` and the keys after it up to `end` are given, each
 * read whole the way the data reader reads it (a quote or structure to its
 * close, an unquoted value to its end, escapes included), a command not at all
 * (its own keys come next).
 */
function heldValues(text: string, keys: readonly CredentialDataKey[], boundaries: readonly number[], from: number,
  end: number, registered: CredentialSpan[]): void {
  const covered = new KeyCoverage(text, keys, boundaries, registered);
  for (let index = from; index < keys.length && keys[index].keyAt < end; index++) {
    const {valueAt, strength, assigned} = keys[index];
    if (covered.holds(index) || text.startsWith('$(', valueAt)) continue;
    // A command's arguments are data, not prose: `--password=alphaBeta` is a value.
    const held = readDataValue(text, valueAt, end, false, assigned);
    if (!held) continue;
    const spans = strength === 'weak' ? held.spans.filter(span => credentialShaped(text.slice(span.start, span.end))) : held.spans;
    append(registered, spans);
    covered.read(index, held.next, spans);
  }
}

/**
 * What the data reader finds besides the spans it returns: a command or
 * expression withheld whole because it holds a credential key (withheld where
 * it stands, but not itself a credential), and the values its keys are given
 * (credentials to withhold wherever they recur).
 */
interface DataSink {
  readonly held: CredentialSpan[];
  readonly values: CredentialSpan[];
  /** Values as their format reads them where no span of the text holds them (`ConfigValue.reads`, a CMake list). */
  readonly reads: string[];
}

function dataKeyedSpans(text: string, start: number, end: number, prose: boolean, sink: DataSink): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  const {keys, boundaries} = credentialDataKeys(text, start, end);
  const covered = new KeyCoverage(text, keys, boundaries, sink.values);
  for (let index = 0; index < keys.length; index++) {
    const {valueAt, strength, assigned} = keys[index];
    if (covered.holds(index)) continue;
    const value = readDataValue(text, valueAt, end, prose, assigned);
    if (!value) continue;
    let next = index + 1;
    while (next < keys.length && keys[next].keyAt < valueAt) next++;
    if (value.code && next < keys.length && keys[next].keyAt < value.next) {
      // A value kept as code (a command, an expression) holds another
      // credential key (`$(tool --password=…)`): withheld whole, or that key's
      // own value would be kept with it. The values its keys are given are
      // what recurs elsewhere; the command around them is not a credential.
      sink.held.push({start: valueAt, end: value.next});
      heldValues(text, keys, boundaries, next, value.next, sink.values);
      covered.read(index, value.next, []);
    } else {
      const found = strength === 'weak' ? value.spans.filter(span => credentialShaped(text.slice(span.start, span.end))) : value.spans;
      append(spans, found);
      covered.read(index, value.next, found);
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Markup: tags, attributes, text and CDATA

interface MarkupScan {
  readonly spans: CredentialSpan[];
  /** Withheld values as markup reads them, where that differs from how they are written. */
  readonly reads: string[];
  /**
   * The text markup reads (comments dropped, CDATA unwrapped, tags removed)
   * and each withheld element's text in it.
   */
  readonly textView: {readonly text: string; readonly spans: CredentialSpan[]};
  /** Attribute values and CDATA, read as data. */
  readonly dataRegions: Array<readonly [number, number]>;
  /** Element text and comments, read as prose. */
  readonly proseRegions: Array<readonly [number, number]>;
}

interface MarkupAttribute {
  readonly name: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** Where the value is read as data: to its end, or to a `<` in it, where the markup after is scanned anyway. */
  readonly dataEnd: number;
}

const TAG_NAME = /[A-Za-z_][\w:.-]*/y;
const ATTRIBUTE_NAME = /[^\s=<>"'/]+/y;
// Attributes that name an element (`<string name="api_key">`, `<entry key="password">`)
// and the attributes that then hold its value (`<property name="password" value="…"/>`,
// `<meta-data android:name="…API_KEY" android:value="…"/>`).
const NAME_ATTRIBUTES = new Set(['name', 'key', 'id', 'android:name']);
const VALUE_ATTRIBUTES = new Set(['value', 'android:value']);
// `@string/maps_key`, `?attr/x`, `@android:string/x`: a resource reference.
const RESOURCE_REFERENCE = /^[@?](?:\+?[\w.]+:)?(?:[\w.]+\/)?[\w.]+$/;

/**
 * Where the next of some characters stands, for a scan that asks from
 * positions that only grow: an answer holds until the position passes it, so
 * each stretch of text is searched once. -1 for none.
 */
class NextOccurrence {
  private from = -1;
  private at = -1;

  constructor(private readonly text: string, private readonly characters: RegExp) {}

  after(from: number): number {
    if (from < this.from || (this.at >= 0 && from > this.at) || (this.at < 0 && this.from < 0)) {
      this.at = -1;
      for (let index = from; index < this.text.length; index++) {
        if (this.characters.test(this.text[index])) { this.at = index; break; }
      }
    }
    this.from = from;
    return this.at;
  }
}

/** What a markup scan asks for again and again, found once per stretch of text. */
interface MarkupSearch {
  readonly doubleQuote: NextOccurrence;
  readonly singleQuote: NextOccurrence;
  readonly lineFeed: NextOccurrence;
  readonly tagOpen: NextOccurrence;
  /** What ends an unquoted attribute value: ASCII white space or `>`. */
  readonly unquotedEnd: NextOccurrence;
}

/**
 * A tag's attributes from `from` to its `>`. An attribute value's quote runs
 * to the same quote, in `inline` text on its line, and an unquoted value to
 * ASCII white space or `>`, as HTML reads them; a `<` or in `inline` text a
 * line break inside a value or between attributes still ends a malformed tag,
 * so scanning goes on there.
 */
function readTag(text: string, from: number, inline: boolean, search: MarkupSearch):
  {attributes: MarkupAttribute[]; end: number; selfClosing: boolean; terminated: boolean} {
  const attributes: MarkupAttribute[] = [];
  const space = (char: string | undefined) => char === ' ' || char === '\t' || (!inline && char !== undefined && /\s/.test(char));
  // `at` or, when there is none before `end`, `end`.
  const before = (at: number, end: number) => at >= 0 && at < end ? at : end;
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '>') return {attributes, end: index + 1, selfClosing: text[index - 1] === '/', terminated: true};
    if (char === '<' || (inline && char === '\n')) return {attributes, end: index, selfClosing: false, terminated: false};
    const nameEnd = stickyAt(ATTRIBUTE_NAME, text, index);
    if (nameEnd === undefined) { index++; continue; }
    const name = text.slice(index, nameEnd);
    let at = nameEnd;
    while (space(text[at])) at++;
    if (text[at] !== '=') { index = nameEnd; continue; }
    at++;
    while (space(text[at])) at++;
    const quote = text[at];
    let valueStart = at;
    let valueEnd: number;
    if (quote === '"' || quote === '\'') {
      valueStart = at + 1;
      valueEnd = before((quote === '"' ? search.doubleQuote : search.singleQuote).after(valueStart), text.length);
      if (inline) valueEnd = before(search.lineFeed.after(valueStart), valueEnd);
      index = text[valueEnd] === quote ? valueEnd + 1 : valueEnd;
    } else {
      valueEnd = before(search.unquotedEnd.after(valueStart), text.length);
      index = valueEnd;
    }
    // A `<` inside the value ends the malformed tag there.
    const tagEnd = before(search.tagOpen.after(valueStart), valueEnd);
    attributes.push({name, valueStart, valueEnd, dataEnd: tagEnd});
    index = Math.min(index, tagEnd);
  }
  return {attributes, end: text.length, selfClosing: false, terminated: false};
}

/**
 * Markup, scanned in one pass. A credential-named attribute has its value
 * withheld; an element that a credential names (by its own name, a
 * `name`/`key` attribute or a preceding plist `<key>`) has its `value`
 * attribute and its whole content withheld, to its closing tag. In a markup
 * file an element that never closes is withheld to the end of the text; in
 * `inline` text (prose, model output) only an element closed on its own line
 * counts, so stray `<` in prose cannot reach past a line.
 */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', newline + 1)) starts.push(newline + 1);
  return starts;
}

/** The index of the line `position` is on. */
function lineOf(lineStarts: readonly number[], position: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * An element's text as markup reads it: comments dropped, CDATA sections
 * unwrapped, tags removed (references are decoded with every registered value).
 */
function elementText(content: string): string {
  return content.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<[^>]*>?/g, (_markup, cdata) => cdata ?? '');
}

function scanMarkup(text: string, inline: boolean): MarkupScan {
  const spans: CredentialSpan[] = [];
  const reads: string[] = [];
  const search: MarkupSearch = {
    doubleQuote: new NextOccurrence(text, /"/),
    singleQuote: new NextOccurrence(text, /'/),
    lineFeed: new NextOccurrence(text, /\n/),
    tagOpen: new NextOccurrence(text, /</),
    unquotedEnd: new NextOccurrence(text, /[\t\n\f\r >]/),
  };
  // The text markup reads, built once, and each withheld element's text in
  // it: an outer element's text holds the inner's, so they register like
  // nested values (`registrationSpans`), in linear total length.
  const textParts: string[] = [];
  let textLength = 0;
  const addText = (start: number, end: number) => {
    if (end <= start) return;
    textParts.push(text.slice(start, end));
    textLength += end - start;
  };
  const textSpans: CredentialSpan[] = [];
  const withholdContent = (start: number, end: number, textAt: number) => {
    spans.push({start, end});
    textSpans.push({start: textAt, end: textLength});
  };
  const dataRegions: Array<readonly [number, number]> = [];
  const proseRegions: Array<readonly [number, number]> = [];
  const open: Array<{readonly name: string; readonly credential: KeyStrength | undefined; readonly contentStart: number;
    readonly textAt: number; readonly startTagsBefore: number}> = [];
  // Start tags read so far: an element whose content has one holds child elements.
  let startTags = 0;
  // The positions in `open` of each element name, for a closing tag.
  const openByName = new Map<string, number[]>();
  // Where each line starts, so an inline element's lines compare in log time.
  const lineStarts = inline ? lineStartsOf(text) : [];
  let plistValueNext: KeyStrength | undefined;
  // Where the last tag, comment or CDATA section began: a `<key>` with markup inside is not a plist key.
  let lastMarkupAt = -1;
  let index = 0;
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    const textEnd = lt < 0 ? text.length : lt;
    if (textEnd > index) proseRegions.push([index, textEnd]);
    addText(index, textEnd);
    if (lt < 0) break;
    const previousMarkupAt = lastMarkupAt;
    lastMarkupAt = lt;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      proseRegions.push([lt + 4, close < 0 ? text.length : close]);
      index = close < 0 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      dataRegions.push([lt + 9, close < 0 ? text.length : close]);
      addText(lt + 9, close < 0 ? text.length : close);
      index = close < 0 ? text.length : close + 3;
      continue;
    }
    const closing = text[lt + 1] === '/';
    const nameStart = lt + (closing ? 2 : 1);
    const nameEnd = stickyAt(TAG_NAME, text, nameStart);
    if (nameEnd === undefined) { // a `<` in text: `a < b`
      proseRegions.push([lt, lt + 1]);
      addText(lt, lt + 1);
      index = lt + 1;
      continue;
    }
    const name = text.slice(nameStart, nameEnd);
    const tag = readTag(text, nameEnd, inline, search);
    for (const attribute of tag.attributes) dataRegions.push([attribute.valueStart, attribute.dataEnd]);
    if (closing) {
      const positions = openByName.get(name);
      if (positions && positions.length > 0) {
        const at = positions[positions.length - 1];
        for (const element of open.splice(at).reverse()) {
          openByName.get(element.name)!.pop();
          // A weak key's element is withheld when its text looks like a credential; one with
          // child elements holds structure, not a token, and its children are judged by their
          // own names. Judging only childless elements reads each stretch of text once.
          if (element.credential && (!inline || lineOf(lineStarts, element.contentStart) === lineOf(lineStarts, lt))
            && (element.credential === 'strong'
              || (startTags === element.startTagsBefore && credentialShaped(elementText(text.slice(element.contentStart, lt)))))) {
            withholdContent(element.contentStart, lt, element.textAt);
          }
          if (element.name === 'key' && !element.credential) {
            plistValueNext = previousMarkupAt < element.contentStart
              ? keyStrength(text.slice(element.contentStart, lt).trim()) : undefined;
          }
        }
      }
      index = tag.end;
      continue;
    }
    let credential = stronger(plistValueNext, keyStrength(name));
    for (const attribute of tag.attributes) {
      if (NAME_ATTRIBUTES.has(attribute.name)) credential = stronger(credential, keyStrength(text.slice(attribute.valueStart, attribute.valueEnd)));
    }
    plistValueNext = undefined;
    for (const attribute of tag.attributes) {
      const value = text.slice(attribute.valueStart, attribute.valueEnd);
      if (!/\S/.test(value) || ANY_REFERENCE.test(value) || RESOURCE_REFERENCE.test(value)) continue;
      const strength = stronger(keyStrength(attribute.name), VALUE_ATTRIBUTES.has(attribute.name) ? credential : undefined);
      if (strength === 'strong' || (strength === 'weak' && credentialShaped(value))) {
        spans.push({start: attribute.valueStart, end: attribute.valueEnd});
        // XML reads an attribute's tab and line breaks (a CRLF as one) as spaces, before its
        // references; a value with a `<` in it is not XML.
        if (!inline && attribute.dataEnd === attribute.valueEnd && /[\t\n\r]/.test(value)) {
          reads.push(value.replace(/\r\n|[\t\n\r]/g, ' '));
        }
      }
    }
    if (tag.terminated && !tag.selfClosing && !name.startsWith('?') && !name.startsWith('!')) {
      const positions = openByName.get(name) ?? [];
      positions.push(open.length);
      openByName.set(name, positions);
      open.push({name, credential, contentStart: tag.end, textAt: textLength, startTagsBefore: ++startTags});
    }
    index = tag.end;
  }
  if (!inline) {
    for (const element of open) if (element.credential) withholdContent(element.contentStart, text.length, element.textAt);
  }
  return {spans, reads, textView: {text: textParts.join(''), spans: textSpans}, dataRegions, proseRegions};
}

// ---------------------------------------------------------------------------
// Tokens with a recognizable shape

const KNOWN_TOKEN = new RegExp([
  String.raw`sk-proj-[A-Za-z0-9_-]{16,}`, String.raw`sk-[A-Za-z0-9_-]{16,}`, String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`github_pat_[A-Za-z0-9_]{20,}`, String.raw`AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`,
  String.raw`A[KS]IA[0-9A-Z]{16}`, String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}`, String.raw`glpat-[A-Za-z0-9_-]{20,}`,
].map(token => `\\b(${token})`).join('|'), 'g');
const BEARER_TOKEN = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g;
// HTTP Basic credentials: base64 of `user:password`.
const BASIC_CREDENTIAL = /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g;
const JSON_WEB_TOKEN = /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END_ALL = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

function isBasicCredential(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, 'base64').toString('latin1');
  return decoded.includes(':') && /^[\x20-\x7e]+$/.test(decoded);
}

function shapedTokenSpans(text: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  for (const pattern of [KNOWN_TOKEN, BEARER_TOKEN, JSON_WEB_TOKEN, BASIC_CREDENTIAL]) {
    for (const match of text.matchAll(pattern)) {
      const value = match.slice(1).find(group => group !== undefined)!;
      if (pattern === BASIC_CREDENTIAL && !isBasicCredential(value)) continue;
      const start = match.index! + match[0].indexOf(value);
      spans.push({start, end: start + value.length});
    }
  }
  // A private key's body to its END line or, unterminated, the end of the
  // text; BEGIN and END lines are paired in one pass.
  const ends = [...text.matchAll(PRIVATE_KEY_END_ALL)].map(match => match.index!);
  let endIndex = 0;
  let coveredUntil = -1;
  for (const begin of text.matchAll(PRIVATE_KEY_BEGIN)) {
    const bodyStart = begin.index! + begin[0].length;
    if (bodyStart <= coveredUntil) continue;
    while (endIndex < ends.length && ends[endIndex] < bodyStart) endIndex++;
    const bodyEnd = endIndex < ends.length ? ends[endIndex] : text.length;
    if (/\S/.test(text.slice(bodyStart, bodyEnd))) spans.push({start: bodyStart, end: bodyEnd});
    coveredUntil = bodyEnd;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Keyless random blobs (heuristic)

const BLOB = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_PATH_DATA = /^(?:[A-Za-z]?\d+)+[A-Za-z]?$/;
// Itanium C++ (`_ZN…`) and Rust v0 (`_RNv…`) mangled symbols are names a
// native stack shows; they look random but are what an analysis reads.
const MANGLED_SYMBOL = /^_[ZR][A-Za-z0-9_]/;

/**
 * Words joined into a name. Measured on 4727 identifiers of 32+ characters from
 * three source trees against random strings: identifiers have long word-like
 * letter segments and at most two digit runs; random strings have short,
 * vowel-poor segments and scattered digits.
 */
function identifierLike(value: string): boolean {
  if (value.includes('+')) return false;
  if ((value.match(/\d+/g) ?? []).length > 2) return false;
  const segments = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  if (segments.length === 0) return false;
  const meanLength = segments.reduce((total, segment) => total + segment.length, 0) / segments.length;
  const wordShare = segments.filter(segment => segment.length >= 2 && /[aeiouy]/i.test(segment)).length / segments.length;
  return meanLength >= 3.2 && wordShare >= 0.6;
}

// A device serial or build id (`AY8CUT4B27009707`) and a short model or
// version code (`v19sv`, `sm8550`, `arm64`): trace and benchmark file names
// carry them, and a path or name around them is still a name.
const SERIAL = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,20}$/;
const SHORT_CODE = /^[a-z]{1,4}\d{1,4}[a-z]{0,4}$/;
// A short commit or content id in a file name: `2026-03-08_RSS_6b7f3e7`.
const SHORT_HEX_ID = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,12}$/;

/**
 * A word of a name. With `codes` (the keyless heuristic reading a path or
 * file name), a device serial or a short model code is one too; a value a
 * weak key is given is judged without them.
 */
function nameWordLike(segment: string, codes = false): boolean {
  return segment === '' || identifierLike(segment) || /^[a-z0-9]{1,4}$/.test(segment) || /^[A-Z0-9]{1,4}$/.test(segment)
    || /^v?\d{1,4}$/.test(segment) || /^[A-Za-z0-9]{1,12}(?:_[A-Za-z0-9]{1,12})+$/.test(segment)
    || (codes && (SERIAL.test(segment) || SHORT_CODE.test(segment) || SHORT_HEX_ID.test(segment)))
    || (/^[a-z]{1,16}$/.test(segment) && (segment.match(/[aeiouy]/g) ?? []).length / segment.length >= 0.3);
}

/** Words, numbers and short codes joined by `-` or `_`: `run-20260425-101445`, `launch-aosp-heavy-iter1`. */
function joinedNameLike(value: string, codes = false): boolean {
  return /[_-]/.test(value) && value.split(/[_-]+/).every(part => part === '' || /^\d+$/.test(part)
    || /^[a-z]{2,16}\d{1,3}$/.test(part) || nameWordLike(part, codes));
}

function pathSegmentLike(raw: string, codes = false): boolean {
  const segment = raw.replace(/^[@+]+/, '');
  return nameWordLike(segment, codes) || joinedNameLike(segment, codes);
}

/** Judged on its characters; base64 padding is not evidence either way. */
function randomLike(padded: string): boolean {
  const value = padded.replace(/=+$/, '');
  if (/^[0-9a-fA-F]+$/.test(value)) return true; // hashes and hex keys alike, before any shape exemption
  if (MANGLED_SYMBOL.test(value)) return false;
  // A constant's name: `CONFIG_SOC_I2S_SUPPORTS_PLL_F160M`. Random keys with no lowercase letter carry no `_`.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false;
  if ((value.match(/[A-Za-z0-9]/g) ?? []).length / value.length < 0.75) return false;
  if (NUMERIC_PATH_DATA.test(value) && /[A-Za-z]\d/.test(value) && !/[a-z]/.test(value)) return false; // SVG path data
  if (value.includes('/') && value.split('/').every(segment => pathSegmentLike(segment, true))) return false;
  // `WP62-02131232314454-launch-aosp-heavy-iter1-20260419`: words, numbers and short codes.
  if (joinedNameLike(value, true)) return false;
  if ((/[A-Z]/.test(value) && /[a-z]/.test(value)) || /[_-]/.test(value)) return !identifierLike(value);
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (!letters) return true;
  const vowelShare = (letters.match(/[aeiouy]/gi) ?? []).length / letters.length;
  return vowelShare < 0.3 || (value.match(/\d/g) ?? []).length / value.length > 0.25
    || (value.match(/\d+/g) ?? []).length > 2;
}

/**
 * A value a weak key (`frameToken`) holds as a credential: one token of eight
 * or more characters that is not a number (a frame or vsync id, a counter, a
 * time), a name, a label, a constant or a path, and has digits or mixed case,
 * or looks random.
 */
function credentialShaped(raw: string): boolean {
  const value = raw.trim();
  if (value.length < 8 || /\s/.test(value) || /^\d+$/.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value) && /\d/.test(value) && /[a-f]/i.test(value)) return true; // hex
  if (/^[a-z]+$/.test(value)) return (value.match(/[aeiouy]/g) ?? []).length / value.length < 0.25;
  if (identifierLike(value) || joinedNameLike(value) || /^[A-Z]+(?:_[A-Z0-9]+)*$/.test(value)) return false;
  if (value.includes('/') && value.split('/').every(segment => pathSegmentLike(segment))) return false;
  return /\d/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value)) || randomLike(value);
}

function insideUrl(text: string, start: number): boolean {
  let tokenStart = start;
  // Full-width and CJK punctuation end a token as a space does (`原文链接：https://…`).
  while (tokenStart > 0 && start - tokenStart < 2048 && !/[\s"'`<>()\u3000-\u303f\uff00-\uffef]/.test(text[tokenStart - 1])) tokenStart--;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(tokenStart, start + 1));
}

// Hex of a hash's length named as one right before it: `commit f39ca35…`,
// `"sha256": "1199…"`, `HEAD: 70ae1e…`.
const HASH_NAMED = /(?:^|[^\w-])(?:sha(?:1|224|256|384|512)?|md5|hash|digest|checksum|commit|revision|rev|head|integrity|etag|tree|parent|object)\b[^\n\w]{0,8}$/i;
const HASH_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);

function randomBlobSpans(text: string, regions: ReadonlyArray<readonly [number, number]>): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  for (const [regionStart, regionEnd] of regions) {
    if (regionEnd - regionStart < 32) continue;
    for (const match of text.slice(regionStart, regionEnd).matchAll(BLOB)) {
      let value = match[0];
      // `NAME=` is an assignment; base64 padding keeps the length a multiple of four.
      if (/=$/.test(value) && value.length % 4 !== 0) value = value.replace(/=+$/, '');
      if (value.length < 32) continue;
      const start = regionStart + match.index!;
      const end = start + value.length;
      const before = text[start - 1];
      const after = text[end];
      if ((before && /[\w$]/.test(before)) || (after && /[\w$]/.test(after))) continue;
      if (UUID.test(value) || insideUrl(text, start)) continue;
      if (/^[0-9a-f]+$/i.test(value) && HASH_LENGTHS.has(value.length)
        && HASH_NAMED.test(text.slice(Math.max(0, start - 48), start))) continue;
      if (randomLike(value)) spans.push({start, end});
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Logical text: the lines a language joins before it reads tokens

interface LogicalText {
  readonly text: string;
  /** Where each character came from in the original text; -1 for one the joining inserted. */
  readonly origin: Int32Array;
  /** The original ranges the joining removed or replaced, in order. */
  readonly removed: ReadonlyArray<readonly [number, number]>;
}

const LINE_JOINING = new Set<Language>(['c', 'cpp', 'shell', 'properties', 'make']);

/**
 * The text a language reads after joining lines at a `\` before a line break.
 * C and C++ splice anywhere, inside names and literals too (translation phase
 * 2); a `.properties` logical line drops the pair with the next line's leading
 * whitespace; make replaces it, with the whitespace around, by one space. A
 * shell removes it except inside single quotes, comments and quoted
 * here-documents: every pair is removed here, and the text is also read as
 * written (`scanCredentials`), so a line the shell keeps apart (after a
 * comment, `# a\⏎PASSWORD=…`) keeps its own value. No shell is lexed.
 * Undefined when nothing joins.
 */
function logicalText(text: string, language: Language): LogicalText | undefined {
  if (!LINE_JOINING.has(language) || !/\\\r?\n/.test(text)) return undefined;
  const parts: string[] = [];
  const origin = new Int32Array(text.length);
  const removed: Array<readonly [number, number]> = [];
  let length = 0;
  let copied = 0;
  // Drops [from, to) of the original text, inserting `insert` if given.
  const drop = (from: number, to: number, insert?: string) => {
    parts.push(text.slice(copied, from));
    for (let index = copied; index < from; index++) origin[length++] = index;
    if (insert !== undefined) {
      parts.push(insert);
      origin[length++] = -1;
    }
    if (to > from) removed.push([from, to]);
    copied = to;
  };
  const breakAfter = (backslash: number) => text[backslash + 1] === '\n' ? backslash + 2
    : text[backslash + 1] === '\r' && text[backslash + 2] === '\n' ? backslash + 3 : -1;
  if (language === 'c' || language === 'cpp' || language === 'shell') {
    for (let index = text.indexOf('\\'); index >= 0; index = text.indexOf('\\', index + 1)) {
      const next = breakAfter(index);
      if (next < 0) continue;
      drop(index, next);
      index = next - 1;
    }
  } else {
    // `.properties` and make: a line ending in an odd number of backslashes, not a comment line.
    let lineStart = 0;
    let continued = false;
    while (lineStart <= text.length) {
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline < 0 ? text.length : newline;
      const content = text.slice(lineStart, lineEnd).replace(/\r$/, '');
      const comment: boolean = !continued && (language === 'properties' ? /^[ \t\f]*[#!]/ : /^[ \t]*#/).test(content);
      continued = newline >= 0 && !comment && oddBackslashesAtEnd(content);
      if (continued) {
        const backslash = lineStart + content.length - 1;
        let next = newline + 1;
        while (next < text.length && /[ \t\f]/.test(text[next])) next++;
        let from = backslash;
        if (language === 'make') while (from > Math.max(lineStart, copied) && /[ \t]/.test(text[from - 1])) from--;
        drop(from, next, language === 'make' ? ' ' : undefined);
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
  }
  if (copied === 0 && parts.length === 0) return undefined;
  drop(text.length, text.length);
  return {text: parts.join(''), origin: origin.subarray(0, length), removed};
}

/** `spans` without the ranges the joining removed: a `\` and line break stay as they are written. */
function withoutRemoved(spans: readonly CredentialSpan[], removed: ReadonlyArray<readonly [number, number]>): CredentialSpan[] {
  const pieces: CredentialSpan[] = [];
  let next = 0;
  for (const span of spans) {
    let start = span.start;
    while (next < removed.length && removed[next][1] <= start) next++;
    for (let index = next; index < removed.length && removed[index][0] < span.end; index++) {
      if (removed[index][0] > start) pieces.push({start, end: removed[index][0]});
      start = Math.max(start, removed[index][1]);
    }
    if (start < span.end) pieces.push({start, end: span.end});
  }
  return pieces;
}

/**
 * Spans of a logical text as spans of the original, split wherever the
 * joining removed or inserted characters: the `\` and line break stay, and
 * each line keeps its own placeholder.
 */
function originalSpans(spans: readonly CredentialSpan[], origin: Int32Array): CredentialSpan[] {
  const mapped: CredentialSpan[] = [];
  for (const span of spans) {
    let start = -1;
    let previous = -1;
    for (let index = span.start; index <= span.end; index++) {
      const at = index < span.end ? origin[index] : -1;
      if (at >= 0 && start >= 0 && at === previous + 1) { previous = at; continue; }
      if (start >= 0) mapped.push({start, end: previous + 1});
      start = at;
      previous = at;
    }
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Public surface

/** Credential value spans, sorted and merged; a span may cross line breaks. */
export function findCredentialSpans(text: string, context: CredentialContext = TEXT_CREDENTIAL_CONTEXT): CredentialSpan[] {
  return scanCredentials(text, context).spans;
}

/**
 * One reading of a text: what is withheld where it stands (`spans`, sorted
 * and merged), and the credentials a guard withholds wherever they recur
 * (`values`): what was found, and the values a command withheld whole holds,
 * but not the command.
 */
interface Reading {
  readonly text: string;
  readonly spans: CredentialSpan[];
  readonly values: readonly CredentialSpan[];
  readonly reads: readonly string[];
  /** Texts derived from this one (markup's text view), each with the values to register in it. */
  readonly views: ReadonlyArray<{readonly text: string; readonly spans: readonly CredentialSpan[]}>;
}

/** Credential spans of the original text, and the credentials to register, each with the text it was read in. */
interface CredentialScan {
  readonly spans: CredentialSpan[];
  readonly registered: ReadonlyArray<{
    readonly text: string;
    readonly spans: readonly CredentialSpan[];
    readonly reads: readonly string[];
  }>;
}

/**
 * `text` with each lone carriage return (a line break on its own, as old Mac
 * files and YAML read it) turned into a line feed. One character for one, so
 * every position stays that of the original, which is what is replaced.
 */
function withLineFeeds(text: string): string {
  return text.includes('\r') ? text.replace(/\r(?!\n)/g, '\n') : text;
}

/** `text` read by each of its format's readers (`CredentialContext.readings`): every span, every credential. */
function scanCredentials(text: string, context: CredentialContext, keyless = true): CredentialScan {
  const scans = context.readings.map(reading =>
    scanReading(text, {syntax: context.syntax, language: reading.language, keyless}, reading.loneCarriageReturn));
  if (scans.length === 1) return scans[0];
  return {
    spans: mergedSpans(scans.flatMap(scan => scan.spans)),
    registered: scans.flatMap(scan => scan.registered),
  };
}

/**
 * One reader's reading. Where it takes a lone carriage return for a line
 * break the text is read with each one as a line feed; spans are positions of
 * the original, and a value written across such a break is also registered as
 * written (with its carriage returns). YAML's readers disagree too (the `yaml`
 * package keeps it as a character), but that reading is not followed: it takes
 * a whole document for one value, which would recur where it is written and
 * withhold the document's structure.
 */
function scanReading(text: string, context: LanguageContext, loneCarriageReturn: LoneCarriageReturn): CredentialScan {
  if (loneCarriageReturn === 'character') return scanLines(text, context);
  const lines = withLineFeeds(text);
  const scan = scanLines(lines, context);
  if (lines === text) return scan;
  const asWritten = scan.registered
    .filter(entry => entry.text === lines)
    .map(entry => ({text, spans: entry.spans, reads: []}));
  return {spans: scan.spans, registered: [...scan.registered, ...asWritten]};
}

function scanLines(text: string, context: LanguageContext): CredentialScan {
  const view = logicalText(text, context.language);
  if (!view) {
    const reading = spansIn(text, context);
    return {spans: reading.spans, registered: [{text, spans: registrationSpans(reading.values), reads: reading.reads},
      ...registeredViews(reading)]};
  }
  const joined = spansIn(view.text, context);
  const spans = originalSpans(joined.spans, view.origin);
  // As the language reads them, and as they are written, line by line.
  const values = registrationSpans(joined.values);
  const registered = [
    {text: view.text, spans: values, reads: joined.reads},
    {text, spans: originalSpans(values, view.origin), reads: []},
    ...registeredViews(joined),
  ];
  if (context.language !== 'shell') return {spans, registered};
  // A shell joins lines only outside quotes and comments; read as written
  // too, a line it keeps apart keeps its own value.
  const written = spansIn(text, context);
  return {
    spans: withoutRemoved(mergedSpans([...written.spans, ...spans]), view.removed),
    registered: [...registered, {text, spans: registrationSpans(written.values), reads: written.reads}],
  };
}

/** What a reading's derived texts register (`Reading.views`). */
function registeredViews(reading: Reading): CredentialScan['registered'] {
  return reading.views.map(view => ({text: view.text, spans: registrationSpans(view.spans), reads: []}));
}

/** Sorted, with overlapping spans merged. */
function mergedSpans(spans: CredentialSpan[]): CredentialSpan[] {
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: CredentialSpan[] = [];
  for (const span of spans) {
    if (span.end <= span.start) continue;
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({...span});
  }
  return merged;
}

/** Credential spans of `text` read in `context`, sorted and merged, and the values found only to register. */
function spansIn(text: string, context: LanguageContext): Reading {
  const scan = tokenize(text, context);
  const {tokens} = scan;
  const spans: CredentialSpan[] = shapedTokenSpans(text);
  const sink: DataSink = {held: [], values: [], reads: []};
  const views: Array<Reading['views'][number]> = [];
  // Where a keyless secret can be: in code only a string literal; in markup an
  // attribute value or text; in config and text any token.
  let blobRegions: ReadonlyArray<readonly [number, number]> = [[0, text.length]];
  if (context.syntax === 'code') {
    append(spans, codeKeyedSpans(text, context, scan));
    blobRegions = tokens.filter(token => token.kind === 'literal').map(token => [token.contentStart, token.contentEnd] as const);
  } else if (context.syntax === 'config') {
    append(spans, configKeyedSpans(text, context, scan, sink));
    append(spans, dataKeyedSpans(text, 0, text.length, false, sink));
    // A TOML string withheld anywhere (an array's item, an inline table's value) as TOML reads it.
    if (context.language === 'toml') append(sink.reads, withheldLiterals(tokens, mergedSpans([...spans, ...sink.held])).map(token => tomlStringRead(text, token)));
  } else if (context.syntax === 'markup') {
    const markup = scanMarkup(text, false);
    append(spans, markup.spans);
    append(sink.reads, markup.reads);
    views.push(markup.textView);
    for (const [start, end] of markup.dataRegions) append(spans, dataKeyedSpans(text, start, end, false, sink));
    for (const [start, end] of markup.proseRegions) append(spans, dataKeyedSpans(text, start, end, true, sink));
    blobRegions = [...markup.dataRegions, ...markup.proseRegions];
  } else {
    const markup = scanMarkup(text, true);
    append(spans, markup.spans);
    append(sink.reads, markup.reads);
    views.push(markup.textView);
    append(spans, dataKeyedSpans(text, 0, text.length, true, sink));
  }
  for (const token of tokens) {
    if ((token.kind !== 'literal' && token.kind !== 'comment') || token.contentEnd - token.contentStart < 3) continue;
    append(spans, dataKeyedSpans(text, token.contentStart, token.contentEnd, token.kind === 'comment', sink));
  }
  if (context.keyless !== false) append(spans, randomBlobSpans(text, blobRegions));
  return {text, spans: mergedSpans([...spans, ...sink.held]), values: [...spans, ...sink.values], reads: sink.reads, views};
}

/** The string literals any of `spans` (sorted and merged) overlaps, in one pass over both. */
function withheldLiterals(tokens: readonly Token[], spans: readonly CredentialSpan[]): Token[] {
  const withheld: Token[] = [];
  let next = 0;
  for (const token of tokens) {
    if (token.kind !== 'literal') continue;
    while (next < spans.length && spans[next].end <= token.contentStart) next++;
    if (next < spans.length && spans[next].start < Math.max(token.contentEnd, token.contentStart + 1)) withheld.push(token);
  }
  return withheld;
}

export const REDACTED_SECRET = '[REDACTED_SECRET]';
const INTERNAL_URL = /https?:\/\/[a-z0-9.-]+\.(?:internal|corp|local)\/[\w/-]+/gi;

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

/** The text of each line a span covers, without its surrounding whitespace. */
function spanLineValues(text: string, span: CredentialSpan): Array<{start: number; end: number}> {
  const values: Array<{start: number; end: number}> = [];
  let lineStart = span.start;
  while (lineStart < span.end) {
    let lineEnd = lineStart;
    // A lone carriage return ends a line too (`withLineFeeds`).
    while (lineEnd < span.end && text[lineEnd] !== '\n' && (text[lineEnd] !== '\r' || text[lineEnd + 1] === '\n')) lineEnd++;
    const line = text.slice(lineStart, lineEnd);
    const content = line.trim();
    if (content) {
      const start = lineStart + line.indexOf(content);
      values.push({start, end: start + content.length});
    }
    lineStart = lineEnd + 1;
  }
  return values;
}

/** Each line part a span covers becomes one placeholder; line breaks and indentation stay. */
function replaceSpans(text: string, spans: readonly CredentialSpan[]): string {
  let output = '';
  let at = 0;
  for (const span of spans) {
    for (const value of spanLineValues(text, span)) {
      output += text.slice(at, value.start) + REDACTED_SECRET;
      at = value.end;
    }
  }
  return output + text.slice(at);
}

/**
 * A source file as a provider may see it: redacted whole in its own syntax
 * (`credentialContextForPath`), before any window or chunk is cut from it.
 */
export function redactSourceFile(content: string, relativePath: string): RedactionResult {
  return redactSecrets(content, credentialContextForPath(relativePath));
}

/** Model-facing text: credential values and internal URLs replaced; keys, lines and code kept. */
export function redactSecrets(text: string, context: CredentialContext = TEXT_CREDENTIAL_CONTEXT): RedactionResult {
  const spans = findCredentialSpans(text, context);
  // Text redacted before (a stored chunk read again) changes nothing and counts nothing.
  let redactedCount = spans.filter(span => spanLineValues(text, span)
    .some(value => text.slice(value.start, value.end) !== REDACTED_SECRET)).length;
  const redacted = replaceSpans(text, spans).replace(INTERNAL_URL, () => {
    redactedCount++;
    return REDACTED_SECRET;
  });
  return {text: redacted, redactedCount};
}

/**
 * Values long enough for a guard to withhold by value wherever they appear
 * later, one per line of a multi-line value. A shorter value would match
 * unrelated text, so it is redacted only where it is found.
 */
export const MIN_GUARDED_CREDENTIAL_CHARS = 8;

// A character reference as XML reads it: a numeric one as its code point
// (leading zeros allowed, no HTML remapping of 0x80–0x9F), or one of the
// five named ones. HTML's reading is the `entities` package's.
const XML_REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos));/g;
const XML_NAMED_REFERENCE: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decodedXmlReferences(credential: string): string {
  return credential.replace(XML_REFERENCE, (reference, decimal, hex, name) => {
    if (name) return XML_NAMED_REFERENCE[name];
    const code = decimal !== undefined ? parseInt(decimal, 10) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : reference;
  });
}

// A string escape as C-family languages, JSON and YAML double quotes read it;
// a `\` before a line break continues the string without one (JavaScript,
// Python, Swift, a Java text block).
const STRING_ESCAPE = /\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(\r\n|[\s\S]))/g;
const ESCAPED_CHARACTER: Readonly<Record<string, string>> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', a: '\x07', e: '\x1b', N: '\x85', _: '\xa0', L: ' ', P: ' ',
};

function decodedEscapes(credential: string): string {
  return credential.replace(STRING_ESCAPE, (escape, hex, braced, unicode, wide, character) => {
    const code = parseInt(hex ?? braced ?? unicode ?? wide ?? '', 16);
    if (character === undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    if (character === '\n' || character === '\r' || character === '\r\n') return '';
    return ESCAPED_CHARACTER[character] ?? character;
  });
}


/** A URL's percent escapes read as UTF-8, or byte by byte where they are not UTF-8. */
function decodedPercents(credential: string): string {
  try {
    return decodeURIComponent(credential.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return credential.replace(/%([0-9A-Fa-f]{2})/g, (_escape, byte) => String.fromCharCode(parseInt(byte, 16)));
  }
}

function guardedValues(values: Set<string>, text: string, spans: readonly CredentialSpan[], read: readonly string[]): void {
  const keep = (form: string) => {
    if (form.length >= MIN_GUARDED_CREDENTIAL_CHARS) values.add(form);
  };
  const add = (credential: string) => {
    if (credential.length < MIN_GUARDED_CREDENTIAL_CHARS || credential === REDACTED_SECRET) return;
    // As readers take its line breaks: as written, every carriage return dropped (a Go raw
    // string), and each CRLF or lone CR as a line feed (XML, YAML, a dotenv file).
    const breaks = credential.includes('\r')
      ? [credential, credential.replace(/\r/g, ''), credential.replace(/\r\n?/g, '\n')] : [credential];
    for (const form of breaks) {
      keep(form);
      // As escapes read it too: a shell keeps the character after `\` (`correcthorse\ battery` is
      // `correcthorse battery`, `\ hunter2long` is ` hunter2long`), a string decodes it (`\t`, `A`),
      // and a quote doubled in a single-quoted YAML or SQL string is one.
      if (form.includes('\\')) {
        const unescaped = form.replace(/\\(.)/g, '$1');
        const decoded = decodedEscapes(form);
        for (const decodedForm of [unescaped, unescaped.trim(), decoded, decoded.trim()]) keep(decodedForm);
      }
      if (form.includes("''")) keep(form.replace(/''/g, "'"));
      // As markup reads its character references, XML, HTML text and HTML attributes each their
      // own way (`&amp;`, `&#0064;`, HTML's `&copy;` and `&#128;`, an attribute's `&not` before a
      // letter kept), and a URL its percent escapes (`%40`).
      if (form.includes('&')) {
        keep(decodedXmlReferences(form));
        keep(decodeHTML(form));
        keep(decodeHTMLAttribute(form));
      }
      if (/%[0-9A-Fa-f]{2}/.test(form)) keep(decodedPercents(form));
    }
  };
  for (const span of spans) {
    const lines = spanLineValues(text, span);
    for (const value of lines) add(text.slice(value.start, value.end));
    // Whole as well, however short its lines.
    if (lines.length > 1) add(text.slice(lines[0].start, lines[lines.length - 1].end));
  }
  for (const credential of read) add(credential);
}

/**
 * The spans whose text a guard registers so that every credential found is
 * withheld whole wherever it recurs, in total linear in the text however deep
 * values nest (`<pwd>` thousands deep). A value holding no long one is
 * registered whole. Of one that does, each long inner value is registered on
 * its own, and the text between them with the first and last characters of
 * the long values around it, so a recurrence of the whole is covered by
 * overlapping parts each long enough to register (`abc ghp_…AAAA def`:
 * `abc ghp_AAAA`, the token, `AAAAAAAA def`). That text alone is not
 * registered: a recurrence only counts next to the credential it belongs to.
 */
function registrationSpans(spans: readonly CredentialSpan[]): CredentialSpan[] {
  const anchor = MIN_GUARDED_CREDENTIAL_CHARS;
  const nodes = spans.filter(span => span.end > span.start)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .map(span => ({span, children: [] as CredentialSpan[]}));
  const open: typeof nodes = [];
  for (const node of nodes) {
    while (open.length > 0 && open[open.length - 1].span.end < node.span.end) open.pop();
    open[open.length - 1]?.children.push(node.span);
    open.push(node);
  }
  const result: CredentialSpan[] = [];
  for (const {span, children} of nodes) {
    const long = children.filter(child => child.end - child.start >= anchor);
    if (long.length === 0) {
      result.push(span);
      continue;
    }
    // `at` is where the long values read so far end; past the first, a long value ends there.
    let at = span.start;
    for (const child of long) {
      if (child.start > at) result.push({start: at === span.start ? at : at - anchor, end: child.start + anchor});
      at = Math.max(at, child.end);
    }
    if (at < span.end) result.push({start: at - anchor, end: span.end});
  }
  return result;
}

// What may stand between the parts of one value: quotes, escapes, line
// breaks and indentation, and the `+` that concatenates literals.
const VALUE_JOINER = /^[\s"'`\\+]*$/;

/**
 * Values whose parts are found apart (`hunter2"long"`, `"hunter2" + "long"`,
 * `"hunt\⏎er2long"` as written), whole: as written, from the first part to
 * the last, and as read, the parts joined. Parts a quote, an escape, a `+` or
 * a line break separates are one value; a long run of them is still one. A
 * format that joins its parts otherwise (a YAML block, a CMake list) reports
 * its own reading (`Reading.reads`).
 */
function joinedValues(text: string, spans: readonly CredentialSpan[]): {spans: CredentialSpan[]; read: string[]} {
  const parts = mergedSpans([...spans]);
  const result = {spans: [] as CredentialSpan[], read: [] as string[]};
  for (let first = 0; first < parts.length;) {
    let last = first;
    while (last + 1 < parts.length && VALUE_JOINER.test(text.slice(parts[last].end, parts[last + 1].start))) last++;
    if (last > first) {
      result.spans.push({start: parts[first].start, end: parts[last].end});
      result.read.push(parts.slice(first, last + 1).map(part => text.slice(part.start, part.end)).join(''));
    }
    first = last + 1;
  }
  return result;
}

/**
 * Each credential's values as the language reads them (`"hunt\⏎er2long"`
 * is `hunter2long`) and as they are written, line by line, the passwords a
 * command withheld whole holds among them.
 */
function scanValues(scan: CredentialScan): string[] {
  const values = new Set<string>();
  for (const {text, spans, reads} of scan.registered) {
    const joined = joinedValues(text, spans);
    guardedValues(values, text, [...spans, ...joined.spans], [...joined.read, ...reads]);
  }
  return [...values];
}

/**
 * The credentials an owner guard registers from `text`: what the keyed rules
 * find, as written and as read. The keyless random-blob heuristic is for
 * model-facing text (`redactSecrets`); owner text keeps commit hashes and ids.
 */
export function credentialValues(text: string, context: CredentialContext = TEXT_CREDENTIAL_CONTEXT): string[] {
  return scanValues(scanCredentials(text, context, false));
}

/** Orders strings by their UTF-16 code units read from the end. */
function compareReversed(left: string, right: string): number {
  const common = Math.min(left.length, right.length);
  for (let index = 1; index <= common; index++) {
    const difference = left.charCodeAt(left.length - index) - right.charCodeAt(right.length - index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * For every position of `text`, the length of the longest of `values` that
 * starts there (0 for none): an Aho-Corasick automaton over the reversed
 * values, run over the reversed text, sees each match end where the value
 * starts. Its trie is built from the values in sorted order, so each node's
 * children are created in code-unit order, then numbered breadth first so
 * that they lie together: following an edge is a binary search, in time
 * bounded whatever the code units (a hash table can be made to collide).
 */
function longestValueStartingAt(text: string, values: readonly string[]): Uint32Array {
  const sorted = values.filter(value => value.length > 0).sort(compareReversed);
  let size = 1;
  let longestValue = 0;
  for (const value of sorted) {
    size += value.length;
    longestValue = Math.max(longestValue, value.length);
  }
  // The trie as built: each node's code unit, children in a linked list, and whether a value ends there.
  const builtUnit = new Uint16Array(size);
  const builtEnds = new Uint8Array(size);
  const firstChild = new Int32Array(size).fill(-1);
  const lastChild = new Int32Array(size).fill(-1);
  const nextSibling = new Int32Array(size).fill(-1);
  const path = new Int32Array(longestValue + 1);
  let built = 1;
  let previous = '';
  for (const value of sorted) {
    // The path the previous value took is shared up to their common suffix.
    let common = 0;
    while (common < value.length && common < previous.length
      && value.charCodeAt(value.length - 1 - common) === previous.charCodeAt(previous.length - 1 - common)) common++;
    for (let depth = common; depth < value.length; depth++) {
      const parent = path[depth];
      const child = built++;
      builtUnit[child] = value.charCodeAt(value.length - 1 - depth);
      if (lastChild[parent] < 0) firstChild[parent] = child;
      else nextSibling[lastChild[parent]] = child;
      lastChild[parent] = child;
      path[depth + 1] = child;
    }
    builtEnds[path[value.length]] = 1;
    previous = value;
  }
  // Numbered breadth first: the children of node n are nodes childStart[n] up to childStart[n] + childCount[n].
  const unit = new Uint16Array(built);
  const terminal = new Uint8Array(built);
  const depth = new Int32Array(built);
  const childStart = new Int32Array(built);
  const childCount = new Int32Array(built);
  const order = new Int32Array(built);
  let numbered = 1;
  for (let node = 0; node < numbered; node++) {
    const original = order[node];
    unit[node] = builtUnit[original];
    terminal[node] = builtEnds[original];
    childStart[node] = numbered;
    for (let child = firstChild[original]; child >= 0; child = nextSibling[child]) {
      depth[numbered] = depth[node] + 1;
      order[numbered++] = child;
    }
    childCount[node] = numbered - childStart[node];
  }
  const edge = (node: number, code: number): number => {
    let low = childStart[node];
    let high = low + childCount[node] - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (unit[middle] === code) return middle;
      if (unit[middle] < code) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  };
  // Failure links, and the deepest terminal on each node's failure chain, breadth first.
  const fail = new Int32Array(built);
  const deepestTerminal = new Int32Array(built).fill(-1);
  for (let node = 0; node < built; node++) {
    if (node > 0) deepestTerminal[node] = terminal[fail[node]] ? fail[node] : deepestTerminal[fail[node]];
    for (let child = childStart[node]; child < childStart[node] + childCount[node]; child++) {
      if (node === 0) continue;
      let state = fail[node];
      let next = edge(state, unit[child]);
      while (next === -1 && state !== 0) {
        state = fail[state];
        next = edge(state, unit[child]);
      }
      fail[child] = next === -1 ? 0 : next;
    }
  }
  const longest = new Uint32Array(text.length);
  let state = 0;
  for (let index = text.length - 1; index >= 0; index--) {
    const code = text.charCodeAt(index);
    let next = edge(state, code);
    while (next === -1 && state !== 0) {
      state = fail[state];
      next = edge(state, code);
    }
    state = next === -1 ? 0 : next;
    const match = terminal[state] ? state : deepestTerminal[state];
    if (match > 0) longest[index] = depth[match];
  }
  return longest;
}

/** Every occurrence of any of `values`, the longest at each position. */
function valueSpans(text: string, values: readonly string[]): CredentialSpan[] {
  const longest = longestValueStartingAt(text, values);
  const spans: CredentialSpan[] = [];
  // Every position a value starts at, an occurrence inside another's included
  // (`abcdefghijk` holds `abcdefgh` and `defghijk`), overlapping ones merged.
  for (let index = 0; index < text.length; index++) {
    if (longest[index] === 0) continue;
    const end = index + longest[index];
    const last = spans[spans.length - 1];
    if (last && index <= last.end) last.end = Math.max(last.end, end);
    else spans.push({start: index, end});
  }
  return spans;
}

/**
 * `spans` without the syntax between two parts of one value found where it
 * stands (the quotes and `+` of `"hunter2" + "long"`, a line break), which a
 * value registered as written also covers there.
 */
function withoutJoinersBetween(text: string, spans: readonly CredentialSpan[], found: readonly CredentialSpan[]): CredentialSpan[] {
  const gaps: CredentialSpan[] = [];
  for (let index = 1; index < found.length; index++) {
    const gap = {start: found[index - 1].end, end: found[index].start};
    if (VALUE_JOINER.test(text.slice(gap.start, gap.end))) gaps.push(gap);
  }
  const result: CredentialSpan[] = [];
  let gapIndex = 0;
  for (const span of spans) {
    let at = span.start;
    while (gapIndex < gaps.length && gaps[gapIndex].end <= at) gapIndex++;
    for (let index = gapIndex; index < gaps.length && gaps[index].start < span.end; index++) {
      if (gaps[index].start > at) result.push({start: at, end: gaps[index].start});
      at = Math.max(at, gaps[index].end);
    }
    if (at < span.end) result.push({start: at, end: span.end});
  }
  return result;
}

/** Owner text: found credentials redacted where they are, and long ones wherever they recur. */
export function redactCredentialsInText(text: string, context: CredentialContext = TEXT_CREDENTIAL_CONTEXT): string {
  // Keyed rules only, as for `credentialValues`.
  const scan = scanCredentials(text, context, false);
  if (scan.spans.length === 0) return text;
  // A value recurs in the text as it is written, so it is found there, with
  // what was found where it stands, before anything is replaced.
  const values = scanValues(scan);
  if (values.length === 0) return replaceSpans(text, scan.spans);
  const recurring = withoutJoinersBetween(text, valueSpans(text, values), scan.spans);
  return replaceSpans(text, mergedSpans([...scan.spans, ...recurring]));
}

const HOLD_SCAN_CHARS = 64 * 1024;
const ENDS_WITH_KEY =
  /(?<![\w$@.-])(\\?["'`]?(?:--?)?(?:[A-Za-z][\w$.-]*[ \t]+){0,2}[A-Za-z_$@][\w$.-]*\\?["'`]?)(?:[ \t]*(?<![:=!<>])(?::=|=>|[:=](?![:=>]))|\()?\s*$/;

// Owner text that ends in a quoted key, white space and line breaks included,
// and at most its separator (`QUOTED_DATA_KEY`).
const ENDS_WITH_QUOTED_KEY =
  /(?<![\w$@.-])(\\?["'`](?:[A-Za-z][\w$.-]*[ \t]+){0,2}[A-Za-z_$@][\w$.-]*\\?["'`])\s*(?:(?<![:=!<>])(?::=|=>|[:=](?![:=>]))\s*)?$/;

/**
 * Whether owner text ending here could still become a credential the text
 * grammar recognizes once later text arrives, judged by that grammar and its
 * value reader: it ends in a credential key, its separator or call
 * parenthesis (whitespace after them included), `Bearer` or `Basic`; a value
 * after such a key is still open (a quote, an escaped line break inside one,
 * or a structure, read to the end of the text); or a private key block has not
 * ended. The owner stream holds text while this is true.
 */
export function endsInDanglingCredentialPrefix(text: string): boolean {
  const scanned = withLineFeeds(text.slice(-HOLD_SCAN_CHARS));
  if (/\b(?:Bearer|Basic)$/.test(scanned.trimEnd())) return true;
  for (const pattern of [ENDS_WITH_KEY, ENDS_WITH_QUOTED_KEY]) {
    const key = pattern.exec(scanned);
    if (key && isCredentialKey(key[1])) return true;
  }
  let coveredUntil = 0;
  for (const {keyAt, key, valueAt, assigned} of dataKeys(scanned, 0, scanned.length)) {
    if (keyAt < coveredUntil || !isCredentialKey(key)) continue;
    const value = readDataValue(scanned, valueAt, scanned.length, true, assigned);
    if (value?.pending) return true;
    if (value) coveredUntil = value.next;
  }
  const begins = [...scanned.matchAll(PRIVATE_KEY_BEGIN)];
  const lastBegin = begins[begins.length - 1];
  return lastBegin !== undefined && !PRIVATE_KEY_END.test(scanned.slice(lastBegin.index!));
}

const PUBLIC_ARTIFACT_SECRET_PATTERNS: readonly RegExp[] = [
  /(api[_-]?key|secret|password|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  /\b(api[_-]?key|secret|password|token)\s*[:=]\s*(?!['"])([^\s'";,]{8,})/gi,
  /https?:\/\/[a-z0-9.-]+\.(?:internal|corp|local)\/[\w/-]+/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * Data leaving the local boundary (contribution bundles, issue drafts): the
 * precise detector, then the broad legacy rules, since over-redaction costs
 * nothing there.
 */
export function redactSecretsForPublicArtifact(text: string): RedactionResult {
  const precise = redactSecrets(text);
  let output = precise.text;
  let redactedCount = precise.redactedCount;
  for (const pattern of PUBLIC_ARTIFACT_SECRET_PATTERNS) {
    output = output.replace(pattern, () => {
      redactedCount++;
      return REDACTED_SECRET;
    });
  }
  return {text: output, redactedCount};
}
