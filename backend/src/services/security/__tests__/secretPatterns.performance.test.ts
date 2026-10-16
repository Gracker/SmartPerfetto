// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {
  credentialContextForPath,
  endsInDanglingCredentialPrefix,
  redactSecrets,
} from '../secretPatterns';

const redact = (file: string, text: string) => redactSecrets(text, credentialContextForPath(file)).text;

describe('time that grows with the input, not its square', () => {
  const timed = (text: string, file: string) => {
    const started = Date.now();
    const output = redact(file, text);
    return {ms: Date.now() - started, output};
  };
  it.each([
    ['nested returns', (n: number) => `function getPassword() { ${'return (() => { '.repeat(n)}return "hunter2long";${'})();'.repeat(n)}}`, 'a.js'],
    ['continuation line breaks', (n: number) => `const password = "hunter2long" + ${'\n'.repeat(n * 16)}"secondSecret456";`, 'a.js'],
    ['deep inline nesting', (n: number) => `${'<password>'.repeat(n * 4)}hunter2long${'</password>'.repeat(n * 4)}`, 'notes.md'],
    ['a weak properties continuation', (n: number) => 'frametoken=label\\\n'.repeat(n) + 'password=hunter2long', 'a.properties'],
    ['a weak shell word continuation', (n: number) => 'FRAME_TOKEN=label\\\n'.repeat(n) + ' PASSWORD=hunter2long', 'a.sh'],
    ['chained assignments returned by name', (n: number) => `function getPassword(flag) {\n  const p0 = ${Array.from({length: n / 4}, (_, i) => `(p${i + 1} = `).join('')}"hunter2long"${')'.repeat(n / 4)};\n${Array.from({length: n / 4 + 1}, (_, i) => `  if (flag === ${i}) return p${i};\n`).join('')}}`, 'a.js'],
  ] as const)('%s', (_label, build, file) => {
    for (const n of [4000, 16000]) {
      const {ms, output} = timed(build(n), file);
      expect(output).not.toContain('hunter2long');
      expect(ms).toBeLessThan(5_000);
    }
  });
});

describe('time on pathological input', () => {
  // Catastrophic backtracking or a quadratic scan takes seconds to minutes on
  // a megabyte; the bound is loose so a loaded machine does not fail it.
  const megabyte = 1 << 20;
  it.each([
    ['word characters', 'a'.repeat(megabyte)],
    ['assignments', 'token=abc'.repeat(megabyte / 9)],
    ['quotes', '"'.repeat(megabyte)],
    ['backticks', '`'.repeat(megabyte)],
    ['open interpolations', '${'.repeat(megabyte / 2)],
    ['nested interpolation quotes', '`${"\\"'.repeat(megabyte / 6)],
    ['an unterminated private key', `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(megabyte)}`],
    ['repeated unclosed private keys', '-----BEGIN PRIVATE KEY-----\n'.repeat(megabyte / 28)],
    ['nested parentheses', `password = f(${'('.repeat(megabyte / 2)}`],
    ['comment slashes', '/'.repeat(megabyte)],
    ['hash runs', `a=${'#'.repeat(megabyte)}`],
    ['dangling keys', 'password =\n'.repeat(megabyte / 11)],
    ['data keys without spaces', 'password='.repeat(megabyte / 9)],
    ['flag keys', '--password=x '.repeat(megabyte / 13)],
    ['target lists', 'token token, '.repeat(megabyte / 13)],
    ['open structures', '"password": ['.repeat(megabyte / 14)],
    ['dollar braces', `password=${'${'.repeat(megabyte / 2)}`],
    ['escaped data quotes', 'password=\\"'.repeat(megabyte / 11)],
    ['macro continuations', '#define PASSWORD \\\n'.repeat(megabyte / 19)],
    ['open tags', '<a b="'.repeat(megabyte / 6)],
    ['credential elements', '<password>'.repeat(megabyte / 10)],
    ['continuation line breaks', `const password = "a" + ${'\n'.repeat(megabyte)}"b";`],
    ['deep inline nesting', `${'<password>'.repeat(megabyte / 22)}x${'</password>'.repeat(megabyte / 22)}`],
    ['an uppercase run', 'A'.repeat(megabyte)],
    ['a dash run', '-a'.repeat(megabyte / 2)],
    ['getter calls', 'getToken('.repeat(megabyte / 9)],
    ['getter definitions', 'getToken() { '.repeat(megabyte / 13)],
    ['python definitions', 'def get_password():\n'.repeat(megabyte / 20)],
    ['interpolated comments', '`${ /* " */ '.repeat(megabyte / 12)],
    ['plist keys', '<key>'.repeat(megabyte / 5)],
    ['bracket line breaks', '[password\n'.repeat(megabyte / 10)],
    ['nested returns', `function getPassword() { ${'return (() => { '.repeat(megabyte / 40)}"x"${'})();'.repeat(megabyte / 40)}}`],
    ['pattern line breaks', 'const {a: password\n'.repeat(megabyte / 20)],
    ['interpolated keywords', '`${ (() => { return /"}/.test(v); })() }`;\n'.repeat(megabyte / 50)],
    ['swift hashes', '#'.repeat(megabyte)],
    ['directive comments', '#define /**/ '.repeat(megabyte / 13)],
    ['directive splices', '# \\\n'.repeat(megabyte / 4)],
    ['member keys', '.password'.repeat(megabyte / 9)],
    ['typeof chains', 'x === "string" === '.repeat(megabyte / 18)],
    ['domain key capitals', `${'A'.repeat(megabyte)}_FRAME_TOKEN=1`],
    ['python continued lines', `def get_password():\n${'x = (\n'.repeat(megabyte / 6)}`],
    ['weak properties continuation', 'frametoken=label\\\n'.repeat(megabyte / 18)],
    ['typeof parentheses', `password = "string" === ${'('.repeat(megabyte / 2)}typeof a${')'.repeat(megabyte / 2)}`],
    ['line splices', 'a\\\n'.repeat(megabyte / 3)],
    ['unclosed cmake sets', 'set(PASSWORD '.repeat(megabyte / 13)],
    ['unended make defines', 'define PASSWORD\n'.repeat(megabyte / 16)],
    ['quoted splices', '"a\\\n\'b\\\n'.repeat(megabyte / 8)],
    ['unclosed commands', `password=${'$('.repeat(megabyte / 2)}`],
    ['shell contexts', '"$(`${'.repeat(megabyte / 5)],
    ['heredoc lines', '<<EOF\n'.repeat(megabyte / 6)],
    ['cmake parentheses', `set(PASSWORD ${'('.repeat(megabyte)}`],
    ['nested defines', 'define PASSWORD\ndefine X\n'.repeat(megabyte / 26)],
    ['shell ansi-c words', "password=$'a'".repeat(megabyte / 13)],
    ['shell unclosed arrays', 'PASSWORDS=('.repeat(megabyte / 11)],
    ['shell assignments on one line', 'a=1 password=x '.repeat(megabyte / 15)],
    ['dotenv quotes with more after them', "PASSWORD='abc'def\n".repeat(megabyte / 18)],
    ['ini continuations across comments', 'password = a\n    b ;c\n# d\n'.repeat(megabyte / 25)],
    ['toml line-ending backslashes', `password = """${'abc\\\n   '.repeat(megabyte / 10)}"""`],
    ['nested weak elements', `${'<frameToken>'.repeat(megabyte / 25)}x${'</frameToken>'.repeat(megabyte / 25)}`],
    ['unclosed credential attributes', '<a password="'.repeat(megabyte / 13)],
  ])('%s', (_label, text) => {
    for (const file of ['a.js', 'a.c', 'a.kt', 'a.py', 'a.swift', 'a.properties', 'a.yaml', 'a.sh', 'a.mk', 'a.cmake', 'a.xml', 'notes.md']) {
      const started = Date.now();
      redactSecrets(text, credentialContextForPath(file));
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    // Readings the files above do not take (dotenv, INI, TOML, a carriage return as a
    // character in code), on an eighth of the input: a square still takes seconds there.
    for (const file of ['.env', 'a.ini', 'a.toml', 'a.go', 'a.proto']) {
      const started = Date.now();
      redactSecrets(text.slice(0, megabyte / 8), credentialContextForPath(file));
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    const started = Date.now();
    endsInDanglingCredentialPrefix(text);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
