// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import * as dotenv from 'dotenv';
import * as jsyaml from 'js-yaml';
import * as YAML from 'yaml';

import {
  credentialContextForPath,
  credentialValues,
  endsInDanglingCredentialPrefix,
  findCredentialSpans,
  redactCredentialsInText,
  redactSecrets,
  redactSecretsForPublicArtifact,
} from '../secretPatterns';

const R = '[REDACTED_SECRET]';
const redact = (file: string, text: string) => redactSecrets(text, credentialContextForPath(file)).text;

describe('keeps code an analysis reads', () => {
  it.each([
    ['Main.kt', 'val token = mAttachInfo.mWindowToken'],
    ['Main.kt', 'password = getPasswordFromStore()'],
    ['Main.kt', 'authToken: StringBuilder'],
    ['Main.java', 'token = authToken2;'],
    ['Main.kt', 'val clientSecret = BuildConfig.CLIENT_SECRET'],
    ['Main.kt', 'class MediumLoadBetweenFramesGeckoViewActivity : BaseActivity()'],
    ['Test.cc', 'TEST(ArrowDeserializerTest, RoundTripInt32SparseNullPopcountUntilFinalization) {'],
    ['parser.cc', 'case FtraceEvent::kKgslAdrenoCmdbatchQueuedFieldNumber: {'],
    ['parser.cc', 'if (token.token_type == sql_token::kVariable &&'],
    ['net.ts', "fetch(url, {credentials: 'same-origin'})"],
    ['Ble.kt', 'val UUID = "0000180d-0000-1000-8000-00805f9b34fb"'],
    ['Jni.kt', 'Log.d(TAG, "dev/perfetto/sdk/PerfettoTrackEventExtra")'],
    ['a.cc', '#include "src/trace_processor/importers/i2c/i2c_tracker.h"'],
    ['a.cc', 'Query("select DEMANGLE(\'_ZN3art6Thread14CreateCallbackEPv\')")'],
    ['json.h', 'base::ErrStatus("Invalid token: expected \'true\' but got \'%.*s\'", x)'],
    ['err.cc', 'base::ErrStatus("Failed to get access token: %s", x)'],
    ['layout.xml', 'android:id="@+id/btn_light_load_between_frames"'],
    ['strings.xml', '<string name="app_name">FriendsCircle</string>'],
    ['Main.c', "char password = 'x';"],
    ['notes.md', 'the token = newToken assignment'],
    ['Main.kt', 'if (token == null) return'],
    ['Main.kt', 'val tokenizer = Tokenizer()'],
    ['Main.kt', 'fun setPassword(value: String) { this.value = value }'],
    ['Constants.java', 'String[] E = {"[emoji_02_sad]", "[emoji_02_secret]", "[emoji_02_shocked]"};'],
    ['a.ts', "const token = raw.split(',', 1)[0]?.trim();"],
    ['a.ts', "const h = {\n  Authorization: `Bearer ${this.apiKey}`,\n  'x-api-key': this.apiKey,\n};"],
    ['grammar.c', '/* 13 */ "typetoken",\n/* 14 */ "typename",'],
    ['heap.cc', 'env.push_back("HEAPPROFD_TESTING_RUN_LIFETIME_ARG1=" + std::to_string(fd));'],
    ['grammar.c', '// (byte: root_start==UINT32_MAX && root_end==0; token: first_tok==UINT32_MAX)'],
    ['a.js', 'if (ready) /"password=12345678"/.test(input);'],
    ['form.ts', "const field = isOpenAi\n  ? 'openaiApiKey'\n  : 'apiKey';"],
    ['a.js', 'const field = cond ? "password"\n  : "username";'],
    ['a.kt', 'class AccessToken(val value: String) { override fun toString() = "AccessToken(...)" }'],
    ['a.cc', 'struct Token { const char* name = "x"; };'],
    ['a.ts', 'interface ApiToken { kind: "bearer" | "basic" }'],
    ['a.py', 'for token in tokens:\n    print("visible")'],
    ['a.js', 'if (token) { x = "visible"; }'],
    ['a.kt', 'when (x) { "token", "password" -> 1 }'],
    ['a.js', 'const SENSITIVE = ["token", "password", "secret"];'],
    ['a.js', 'return password\nconst label = "visible"'],
    ['a.c', '#define TOKEN_TYPE_STRING 1'],
      ['main.dart', "print('token: $value');"],
    ['layout.xml', '<EditText android:id="@+id/password" android:inputType="textPassword" />'],
    ['layout.xml', '<TextView android:text="@string/password_hint" app:apiKey="@string/maps_key" />'],
    ['Info.plist', '<key>CFBundleName</key>\n<string>App</string>'],
    ['notes.md', 'Replace <token> with your token.'],
    ['notes.md', 'The token: {see below}'],
    ['notes.md', 'Basic information about the app'],
    ['notes.md', 'the next significant token. `*out_pos` is updated'],
    ['notes.md', 'the grammar defines an error token "ERROR".'],
    ['a.sh', 'if [ "$token" = "$expected" ]; then'],
    ['a.js', 'function f() {\n  return password\n  const label = "visible"\n}'],
    ['a.kt', 'getToken().let { log("visible") }'],
    ['a.kt', 'val t = getToken() ?: fallback("visible")'],
    ['a.kt', 'if (getToken() == null) { log("visible") }'],
    ['a.py', 'if get_password() == "x":\n    print("visible")'],
    ['A.java', 'String getTokenizerName() { return "visible"; }'],
    ['a.ts', 'export function getCsrfToken(): string | undefined {\n  return typeof token === \'string\' ? token : undefined;\n}'],
    ['notes.md', 'the password field must be at least eight characters'],
    ['notes.md', 'const passwordValidator = validatePassword(input);'],
    ['notes.md', 'password=short'],
    ['a.js', 'const o = {password\n, label: "visible"};'],
    ['a.js', 'if (ready) {\n  password\n}\nconst label = "visible";'],
    ['a.kt', 'apiKey(context) { log("visible") }'],
    ['A.java', 'public ApiKey(String value) {\n    this.value = value;\n    log("visible");\n}'],
    ['a.ts', 'class A {\n  validatePassword(input: string) {\n    return "Too short";\n  }\n}'],
      ['a.ts', 'class A {\n  listApiKeys(context: Ctx) {\n    return db.prepare(`SELECT * FROM api_keys`).all();\n  }\n}'],
    ['a.ts', 'function readMasterKey(dir: string) {\n  return decode(read(dir), \'base64\');\n}'],
    ['a.ts', 'const stream = {\n  token(text: string) { emit({type: \'answer_token\', text}); },\n};'],
    ['a.ts', 'agent.reset(2), {...agent.token(\'d\', 2), id: \'9\'};'],
  ])('%s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });
});

describe('keeps a value that is a reference or names where the value comes from', () => {
  it.each([
    ['build.sh', 'export KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-$keystore_password}"'],
    ['build.sh', 'export DB_PASSWORD="$DB_PASS"'],
    ['Main.kt', 'val token = "$accessToken"'],
    ['Main.kt', 'val token = "${session.token}"'],
    ['a.js', 'const token = `${prefix}`'],
    ['a.py', 'password = f"{user.password}"'],
    ['main.dart', "final token = '$sessionToken';"],
    ['app.yaml', 'password: ${DB_PASSWORD}'],
    ['a.yaml', 'password: ${DB_PASSWORD}\ntoken: ${API_TOKEN:-}'],
    ['app.properties', 'db.password=${DB_PASSWORD}'],
    ['a.cc', 'std::string access_token = (*json_result)["access_token"].AsString();'],
    ['a.js', 'const password = getenv("API_TOKEN");'],
    ['a.js', 'const password = json["access_token"];'],
    ['a.py', 'password = os.environ.get("DB_PASSWORD")'],
    ['a.kt', 'val token = prefs.getString("auth_token", null)'],
    ['a.kt', 'val password = intent.getStringExtra("password")'],
    ['a.js', 'const token = params.get("token");'],
  ])('%s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });
});

describe('withholds the value of a credential-named key and keeps the key', () => {
  it.each([
    ['Main.kt', 'mWindowToken = "a1b2c3d4e5f6"', `mWindowToken = "${R}"`],
    ['Main.kt', 'val password = "abc123"', `val password = "${R}"`],
    ['Main.kt', 'val password = "mypassword"', `val password = "${R}"`],
    ['a.js', 'const password = "mysecret";', `const password = "${R}";`],
    ['a.js', 'const password = "密碼";', `const password = "${R}";`],
    ['Main.kt', 'val api_key = "zz"', `val api_key = "${R}"`],
    ['Main.kt', 'private_key = "k3y"', `private_key = "${R}"`],
    ['Main.kt', 'myExtremelyLongPrivateServiceAccessToken =\n"abcdefghijklmnop"', `myExtremelyLongPrivateServiceAccessToken =\n"${R}"`],
    ['Main.kt', 'val password: String = "shortSecret123"', `val password: String = "${R}"`],
    ['a.ts', 'const password: string = "shortSecret123";', `const password: string = "${R}";`],
    ['a.js', 'const password = "don\'t123";', `const password = "${R}";`],
    ['A.java', 'String password = "$abc123";', `String password = "${R}";`],
    ['a.js', 'const password = "abc123${suffix}";', `const password = "${R}";`],
    ['a.js', 'const token = `sk${rest}abc`', `const token = \`${R}\``],
    ['a.js', 'const password = `\\${fixedSecret}`;', `const password = \`${R}\`;`],
    ['a.js', 'const password = `${"shortSecret123"}`;', `const password = \`${R}\`;`],
    ['Main.kt', 'val authToken = "Bearer ${session.token}"', `val authToken = "${R}"`],
    ['Main.kt', 'val password = "\\$fixedSecret"', `val password = "${R}"`],
    ['a.py', 'password = f"{user}:secret123"', `password = f"${R}"`],
    ['a.py', 'password = f"{{fixedSecret123}}"', `password = f"${R}"`],
    ['a.py', 'password = f"{user:fixedSecret123}"', `password = f"${R}"`],
    ['a.py', 'password = """fixedSecret123"""', `password = """${R}"""`],
    ['Main.kt', 'val password = """fixedSecret123"""', `val password = """${R}"""`],
    ['A.java', 'String password = """\nfixedSecret123\n""";', `String password = """\n${R}\n""";`],
    ['Main.kt', 'val password = BuildConfig.PASSWORD ?: "default123"', `val password = BuildConfig.PASSWORD ?: "${R}"`],
    ['Conv.kt', 'storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "123456"', `storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "${R}"`],
    ['a.js', 'const password = hash("mysecret");', `const password = hash("${R}");`],
    ['a.js', 'const password = {value: "mysecret"};', `const password = {value: "${R}"};`],
    ['a.py', 'password = ("mysecret")', `password = ("${R}")`],
    ['a.js', 'const password = factory("mypassword");', `const password = factory("${R}");`],
    ['Main.kt', 'builder.setPassword("hunter2")', `builder.setPassword("${R}")`],
    ['Main.kt', 'val headers = mapOf("password" to "hunter2")', `val headers = mapOf("password" to "${R}")`],
    ['Main.kt', 'val x = mapOf("api_key" to "abc", "user" to "u")', `val x = mapOf("api_key" to "${R}", "user" to "u")`],
    ['Main.java', 'map.put("api_key", "abc");', `map.put("api_key", "${R}");`],
    ['a.js', 'obj["password"] = "shortSecret123";', `obj["password"] = "${R}";`],
    ['a.go', 'password := "hunter2"', `password := "${R}"`],
    ['a.cc', 'const char* kApiKey = R"(raw-secret-1)";', `const char* kApiKey = R"(${R})";`],
    ['build.gradle', 'storePassword "android123"', `storePassword "${R}"`],
    ['main.dart', "const apiKey = 'abc123secret';", `const apiKey = '${R}';`],
    ['main.dart', "final password = r'raw$secret';", `final password = r'${R}';`],
    ['main.dart', 'final apiToken = """\nmultiLineSecret\n""";', `final apiToken = """\n${R}\n""";`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('reaches a credential-named value wherever the syntax puts it', () => {
  it.each([
    // a regular expression after a control condition, read as a token
    ['a.js', 'if                 (ready) /"/.test(input); const password = "shortSecret123";', `if                 (ready) /"/.test(input); const password = "${R}";`],
    ['a.js', 'if /*comment*/ (ready) /"/.test(input); const password = "shortSecret123";', `if /*comment*/ (ready) /"/.test(input); const password = "${R}";`],
    ['a.js', 'if (ready) /"/.test(input); const password = "shortSecret123";', `if (ready) /"/.test(input); const password = "${R}";`],
    ['a.js', 'for await (const x of y) /"/.test(x); const password = "shortSecret123";', `for await (const x of y) /"/.test(x); const password = "${R}";`],
    ['a.js', 'export default /"/; const password = "shortSecret123";', `export default /"/; const password = "${R}";`],
    ['a.js', 'const password = /"/.source + "shortSecret123";', `const password = /"/.source + "${R}";`],
    // separators through comments and any number of line breaks
    ['a.js', 'const password /* the db password */ = "hunter2long";', `const password /* the db password */ = "${R}";`],
    ['a.js', 'const password\n\n= "shortSecret123";', `const password\n\n= "${R}";`],
    ['a.js', `const password${' '.repeat(40)}= "shortSecret123";`, `const password${' '.repeat(40)}= "${R}";`],
    ['a.js', 'password += "suffixSecret";', `password += "${R}";`],
    ['a.js', 'password ??= "fallbackSecret";', `password ??= "${R}";`],
    ['a.js', 'const config = {"password"\n: "shortSecret123"};', `const config = {"password"\n: "${R}"};`],
    ['a.py', 'config = {\n    "password"\n    : "shortSecret123"}', `config = {\n    "password"\n    : "${R}"}`],
    ['a.js', 'put(/* key */ "password", "hunter2long");', `put(/* key */ "password", "${R}");`],
    ['a.js', `obj["password"]${' '.repeat(40)}="shortSecret123";`, `obj["password"]${' '.repeat(40)}="${R}";`],
    ['a.js', 'obj["password"]\n  = "shortSecret123";', `obj["password"]\n  = "${R}";`],
    // an expression goes on past line breaks it leaves unfinished
    ['a.js', 'const password = someValue +\n "shortSecret123";', `const password = someValue +\n "${R}";`],
    ['a.js', `const password = a\n${' '.repeat(80)}+ "shortSecret123";`, `const password = a\n${' '.repeat(80)}+ "${R}";`],
    ['a.js', 'const password = a\n\n+ "shortSecret123";', `const password = a\n\n+ "${R}";`],
    ['a.js', 'const password = a // why\n  + "shortSecret123";', `const password = a // why\n  + "${R}";`],
    ['a.kt', 'val password = "a" to\n  "shortSecret123"', `val password = "${R}" to\n  "${R}"`],
    // a long key is read from its tail
    ['a.js', `const ${'x'.repeat(200)}Password = "shortSecret123";`, `const ${'x'.repeat(200)}Password = "${R}";`],
    // target lists, destructuring, declared types and tuples
    ['a.py', 'user, password = "admin", "hunter2long"', `user, password = "${R}", "${R}"`],
    ['a.go', 'password, user := "hunter2long", "admin"', `password, user := "${R}", "${R}"`],
    ['a.js', 'const [user, password] = ["admin", "hunter2long"];', `const [user, password] = ["${R}", "${R}"];`],
    ['a.kt', 'val (user, password) = Pair("admin", "hunter2long")', `val (user, password) = Pair("${R}", "${R}")`],
    ['a.kt', 'val (user: String, password: String) = Pair("admin", "hunter2long")', `val (user: String, password: String) = Pair("${R}", "${R}")`],
    ['a.go', 'var password string = "hunter2long"', `var password string = "${R}"`],
    ['a.c', 'static const char kPassword[] = "hunter2long";', `static const char kPassword[] = "${R}";`],
    ['a.py', 'password = "first", "secondSecret"', `password = "${R}", "${R}"`],
    ['a.ts', 'class A { password?: string = "hunter2long"; }', `class A { password?: string = "${R}"; }`],
    ['a.js', 'const password = "a", label = "visible";', `const password = "${R}", label = "visible";`],
    ['a.kt', 'login(password = "hunter2long", user = "admin")', `login(password = "${R}", user = "admin")`],
    // a credential name as any call argument, and Groovy's commands
    ['build.gradle', 'buildConfigField "String", "API_KEY", "\\"abc123secret\\""', `buildConfigField "String", "API_KEY", "${R}"`],
    ['build.gradle.kts', 'buildConfigField("String", "API_KEY", "\\"abc123secret\\"")', `buildConfigField("String", "API_KEY", "${R}")`],
    ['A.java', 'System.setProperty("javax.net.ssl.trustStorePassword", "changeit");', `System.setProperty("javax.net.ssl.trustStorePassword", "${R}");`],
    // C macros, brace initializers and compiler definitions
    ['a.h', '#define DB_PASSWORD "hunter2long"', `#define DB_PASSWORD "${R}"`],
    ['a.h', '#define API_KEY \\\n  "abc123secret"', `#define API_KEY \\\n  "${R}"`],
    ['a.cc', 'std::string password{"hunter2long"};', `std::string password{"${R}"};`],
    ['a.cmake', 'add_definitions(-DAPI_KEY="abc123secret")', `add_definitions(-DAPI_KEY="${R}")`],
    ['Android.mk', 'LOCAL_CFLAGS += -DAPI_KEY=\\"abc123secret\\"', `LOCAL_CFLAGS += -DAPI_KEY=\\"${R}\\"`],
    // a string key of any length, and a target list across line breaks
    ['a.js', `const config = {"${'a'.repeat(140)}password": "hunter2long"};`, `const config = {"${'a'.repeat(140)}password": "${R}"};`],
    ['a.js', `obj["${'a'.repeat(140)}password"] = "hunter2long";`, `obj["${'a'.repeat(140)}password"] = "${R}";`],
    ['a.js', 'const [password\n] = ["hunter2long"];', `const [password\n] = ["${R}"];`],
    ['a.js', 'const [password, other\n] = ["hunter2long", "value"];', `const [password, other\n] = ["${R}", "${R}"];`],
    // an interpolation holds code, read with the language's own tokens
    ['a.js', 'const label = `${ /* " */ value }`; const password /*gap*/ = "hunter2long";', `const label = \`\${ /* " */ value }\`; const password /*gap*/ = "${R}";`],
    ['a.js', 'const label = `${/"/.test(x)}`; const password = "hunter2long";', `const label = \`\${/"/.test(x)}\`; const password = "${R}";`],
    ['main.dart', 'final label = \'${r"hello\\"}\'; final password /*gap*/ = "hunter2long";', `final label = '\${r"hello\\"}'; final password /*gap*/ = "${R}";`],
    ['a.kt', 'val label = "${map["key"] /* " */}"; val password = "hunter2long"', `val label = "\${map["key"] /* " */}"; val password = "${R}"`],
    ['a.sh', 'PASSWORD="${#arr[@]}secretValue"', `PASSWORD="${R}"`],
    ['a.kt', 'val authToken = if (type == "bearer") header else "fallbackSecret"', `val authToken = if (type == "${R}") header else "${R}"`],
    ['a.kt', 'val authToken = prefs.getString("auth_token", "fallbackSecret")', `val authToken = prefs.getString("auth_token", "${R}")`],
    // object destructuring across line breaks, with a type annotation or nested in another pattern
    ['a.js', 'const {0: password\n} = ["hunter2long"];', `const {0: password\n} = ["${R}"];`],
    ['a.js', 'const {0: password /*gap*/\n} = ["hunter2long"];', `const {0: password /*gap*/\n} = ["${R}"];`],
    ['a.js', 'const {a: {0: password\n}} = {a: ["hunter2long"]};', `const {a: {0: password\n}} = {a: ["${R}"]};`],
    ['a.js', '[{0: password\n}] = [["hunter2long"]];', `[{0: password\n}] = [["${R}"]];`],
    ['a.js', 'const {0: password\n}: string[] = ["hunter2long"];', `const {0: password\n}: string[] = ["${R}"];`],
    // an interpolation keeps the expression state top-level code has
    ['a.js', 'const label = `${ (() => { return /"}/.test(value); })() }`;\nconst password /*gap*/ = "hunter2long";', `const label = \`\${ (() => { return /"}/.test(value); })() }\`;\nconst password /*gap*/ = "${R}";`],
    ['a.js', 'const label = `${ (() => { if (ready) /"/.test(x); })() }`; const password = "hunter2long";', `const label = \`\${ (() => { if (ready) /"/.test(x); })() }\`; const password = "${R}";`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('a key ending only in token needs a value that looks like a credential', () => {
  it.each([
    ['a.kt', 'val token = "kQ7wR9tY2pZ4aS6d"', `val token = "${R}"`],
    ['a.js', 'const pushToken = "f8a9b7c6d5e4f3a2";', `const pushToken = "${R}";`],
    ['a.env', 'HF_TOKEN=hf_aB3dE5fG7hJ9kL1mN3p', `HF_TOKEN=${R}`],
    ['a.yaml', 'token: x9Fq2LmZ7vRt', `token: ${R}`],
    ['a.ts', "let token: number | 'unregistered' = 'unregistered';", `let token: number | '${R}' = '${R}';`],
    ['Main.kt', 'val token = "Bearer ${session.token}"', `val token = "${R}"`],
    ['a.yaml', 'token: none', `token: ${R}`],
    ['a.js', 'const authenticationToken = "hunter2long";', `const authenticationToken = "${R}";`],
    ['a.js', 'const csrfToken = "hunter2long";', `const csrfToken = "${R}";`],
    ['a.ts', 'const frameToken = "frameLabel";', 'const frameToken = "frameLabel";'],
  ])('withholds %s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it.each([
    ['a.ts', "export const ANSWER_TOKEN = 'answer_token';"],
    ['a.ts', "const IGNORE_TOKEN = 'smartperfetto-guardrail-ignore';"],
      ['Main.kt', 'mWindowToken = "abcdefghij"'],
      ['a.ts', 'db.exec(`UPDATE leases SET lease_token = NULL WHERE id = ?`);'],
    ['a.ts', 'const sql = `SELECT * FROM a JOIN b ON a.display_frame_token = b.display_frame_token`;'],
    ])('keeps %s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });
});

describe('round 9: strengths, names, definitions and line breaks', () => {
  it.each([
    // a weak key never hides a strong key: target lists, getter bodies, data
    ['a.js', 'const [token, password] = ["frameLabel", "hunter2long"];', `const [token, password] = ["${R}", "${R}"];`],
    ['a.js', 'const [frameToken, password] = ["frameLabel", "hunter2long"];', `const [frameToken, password] = ["${R}", "${R}"];`],
    ['a.js', 'function getFrameToken() {\n  function getPassword() { return "hunter2long"; }\n  return getPassword();\n}', `function getFrameToken() {\n  function getPassword() { return "${R}"; }\n  return getPassword();\n}`],
    ['notes.md', '{"frame_token": {"password": "hunter2long"}}', `{"frame_token": {"password": "${R}"}}`],
    ['config.json', '{"token": {"password": "hunter2long"}}', `{"token": {"${R}": "${R}"}}`],
    ['a.yaml', 'frame_token:\n  password: hunter2long', `frame_token:\n  password: ${R}`],
    // a token named for any other purpose is a credential, in every syntax
    ['a.js', 'const authorizationToken = "hunter2long";', `const authorizationToken = "${R}";`],
    ['a.js', 'const securityToken = "hunter2long";', `const securityToken = "${R}";`],
    ['a.js', 'const xsrfToken = "hunter2long";', `const xsrfToken = "${R}";`],
    ['a.js', 'const resetToken = "hunter2long";', `const resetToken = "${R}";`],
    ['a.js', 'const verificationToken = "hunter2long";', `const verificationToken = "${R}";`],
    ['a.yaml', 'authenticationToken: hunter2long', `authenticationToken: ${R}`],
    ['config.json', '{"authenticationToken": "hunter2long"}', `{"authenticationToken": "${R}"}`],
    ['strings.xml', '<string name="authentication_token">hunter2long</string>', `<string name="authentication_token">${R}</string>`],
    ['a.h', '#define AUTHENTICATION_TOKEN "hunter2long"', `#define AUTHENTICATION_TOKEN "${R}"`],
    ['A.java', 'String getAuthenticationToken() { return "hunter2long"; }', `String getAuthenticationToken() { return "${R}"; }`],
    // a call's name does not prove it reads by name; a compared literal can be what a getter returns
    ['a.js', 'function getString(value) { return value; }\nconst password = getString("hunter2long");', `function getString(value) { return value; }\nconst password = getString("${R}");`],
    ['a.js', 'function getPassword(candidate) {\n  return candidate === "hunter2long" ? candidate : null;\n}', `function getPassword(candidate) {\n  return candidate === "${R}" ? candidate : null;\n}`],
    // definitions a receiver, an extension, a generator or a qualifier introduces
    ['a.go', 'func (s *Store) getPassword() string { return "hunter2long" }', `func (s *Store) getPassword() string { return "${R}" }`],
    ['a.kt', 'fun String.getPassword(): String { return "hunter2long" }', `fun String.getPassword(): String { return "${R}" }`],
    ['a.js', 'function* getPassword() { return "hunter2long"; }', `function* getPassword() { return "${R}"; }`],
    ['a.cc', 'std::string Store::getPassword() const { return "hunter2long"; }', `std::string Store::getPassword() const { return "${R}"; }`],
    // every name a return expression mentions is followed
    ['a.js', 'function getPassword() {\n  const p = "hunter2long";\n  return (p);\n}', `function getPassword() {\n  const p = "${R}";\n  return (p);\n}`],
    ['a.js', 'function getPassword(ok) {\n  const p = "hunter2long";\n  return ok ? p : null;\n}', `function getPassword(ok) {\n  const p = "${R}";\n  return ok ? p : null;\n}`],
    // a single-line literal ends at a raw line break inside an interpolation too
    ['a.kt', 'val label = "${"bad\nval password /*gap*/ = "hunter2long"', `val label = "\${"bad\nval password /*gap*/ = "${R}"`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it.each([
    ['a.ts', 'type Token = {kind: \'identifier\' | \'string\'; value: string};'],
    ['a.ts', 'const ok = typeof token === \'string\' && token.length > 0;'],
  ])('keeps %s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });

  it('withholds an authentication token in owner text', () => {
    expect(redactCredentialsInText('authenticationToken = "hunter2long"')).not.toContain('hunter2long');
  });
});

describe('round 10: authentication purposes, declarations, getter bodies and directives', () => {
  it.each([
    // an authentication word before a domain token's name makes it a credential, in every syntax
    ['a.js', 'const authInputToken = "hunter2long";', `const authInputToken = "${R}";`],
    ['a.js', 'const authenticationSyncToken = "hunter2long";', `const authenticationSyncToken = "${R}";`],
    ['a.js', 'const accessPageToken = "hunter2long";', `const accessPageToken = "${R}";`],
    ['a.js', 'const SESSION_SYNC_TOKEN = "hunter2long";', `const SESSION_SYNC_TOKEN = "${R}";`],
    ['a.js', 'const authinputtoken = "hunter2long";', `const authinputtoken = "${R}";`],
    ['config.json', '{"authInputToken": "hunter2long"}', `{"authInputToken": "${R}"}`],
    ['a.yaml', 'authInputToken: hunter2long', `authInputToken: ${R}`],
    ['a.xml', '<authInputToken>hunter2long</authInputToken>', `<authInputToken>${R}</authInputToken>`],
    ['notes.md', 'authInputToken=hunter2long', `authInputToken=${R}`],
    ['a.properties', 'auth.input.token=hunter2long', `auth.input.token=${R}`],
    // a contextual type keyword declares only with the name on its line; a language without it has a type of that name
    ['a.js', 'let password;\nconst type = 1;\ntype\npassword = "hunter2long";', `let password;\nconst type = 1;\ntype\npassword = "${R}";`],
    ['A.java', 'type password = new type("hunter2long");', `type password = new type("${R}");`],
    ['a.ts', 'let interface_ = 1;\ninterface\npassword = "hunter2long";', `let interface_ = 1;\ninterface\npassword = "${R}";`],
    ['a.py', 'type\npassword = "hunter2long"', `type\npassword = "${R}"`],
    ['build.gradle', 'def trait = 1\ntrait\npassword = "hunter2long"', `def trait = 1\ntrait\npassword = "${R}"`],
    // only a whole `typeof <name>` operand makes a compared type name a type
    ['a.js', 'function getPassword(x) {\n  return (typeof x, x) === "string" ? x : null;\n}', `function getPassword(x) {\n  return (typeof x, x) === "${R}" ? x : null;\n}`],
    ['a.js', 'function getPassword(x) {\n  return typeof x && x === "string" ? x : null;\n}', `function getPassword(x) {\n  return typeof x && x === "${R}" ? x : null;\n}`],
    ['a.js', 'function getPassword(x) {\n  return a + typeof x === "string" ? x : null;\n}', `function getPassword(x) {\n  return a + typeof x === "${R}" ? x : null;\n}`],
    ['a.js', 'function getPassword(x) {\n  return typeof x === "string" + y ? x : null;\n}', `function getPassword(x) {\n  return typeof x === "${R}" + y ? x : null;\n}`],
    // every literal of a credential getter's body, however it reaches the return
    ['a.js', 'function getPassword() {\n  const p /*gap*/ = "hunter2long";\n  return p;\n}', `function getPassword() {\n  const p /*gap*/ = "${R}";\n  return p;\n}`],
    ['a.js', 'function getPassword() {\n  const p\n    = "hunter2long";\n  return p;\n}', `function getPassword() {\n  const p\n    = "${R}";\n  return p;\n}`],
    ['a.js', 'function getPassword() {\n  const p = "hunter2long";\n  const q = p;\n  return q;\n}', `function getPassword() {\n  const p = "${R}";\n  const q = p;\n  return q;\n}`],
    ['a.js', 'function getPassword() {\n  const [p] = ["hunter2long"];\n  return p;\n}', `function getPassword() {\n  const [p] = ["${R}"];\n  return p;\n}`],
    ['a.js', 'function getPassword() {\n  const o = {v: "hunter2long"};\n  return o.v;\n}', `function getPassword() {\n  const o = {v: "${R}"};\n  return o.v;\n}`],
    ['A.java', 'String getPassword() {\n    StringBuilder sb = new StringBuilder();\n    sb.append("hunter2long");\n    return sb.toString();\n}', `String getPassword() {\n    StringBuilder sb = new StringBuilder();\n    sb.append("${R}");\n    return sb.toString();\n}`],
    ['a.kt', 'fun refreshToken(): Boolean {\n    log("visible")\n    return true\n}', `fun refreshToken(): Boolean {\n    log("${R}")\n    return true\n}`],
    // a key at a member access no name precedes
    ['a.c', 'struct S s = {.password = "hunter2long"};', `struct S s = {.password = "${R}"};`],
    ['A.java', 'DataSourceBuilder.create().username("sa").password("hunter2long").build();', `DataSourceBuilder.create().username("sa").password("${R}").build();`],
    ['a.kt', 'user?.password = "hunter2long"', `user?.password = "${R}"`],
    ['a.ts', 'items[0].password = "hunter2long";', `items[0].password = "${R}";`],
    // a directive's words may be separated by comments and splices; a getter-named function-like macro
    ['a.c', '#define /*c*/ PASSWORD "hunter2long"', `#define /*c*/ PASSWORD "${R}"`],
    ['a.c', '#define \\\nPASSWORD "hunter2long"', `#define \\\nPASSWORD "${R}"`],
    ['a.c', '/* x */ # define API_KEY \\\n  "hunter2long"', `/* x */ # define API_KEY \\\n  "${R}"`],
    ['a.c', '#define GET_PASSWORD() "hunter2long"', `#define GET_PASSWORD() "${R}"`],
    ['a.c', '#define GET_TOKEN(x) lookup("token", x)', `#define GET_TOKEN(x) lookup("${R}", x)`],
    // a Python block runs over lines a string, a bracket or a splice continues
    ['a.py', 'def get_password(self):\n    doc = """\n"""\n    return "hunter2long"\n', `def get_password(self):\n    doc = """\n"""\n    return "${R}"\n`],
    ['a.py', 'def get_password(self):\n    x = foo(\n1)\n    return "hunter2long"\n', `def get_password(self):\n    x = foo(\n1)\n    return "${R}"\n`],
    ['a.py', 'def get_password(self):\n    x = 1 + \\\n2\n    return "hunter2long"\n', `def get_password(self):\n    x = 1 + \\\n2\n    return "${R}"\n`],
    ['a.py', 'def get_password(self) -> "x:y":\n    return "hunter2long"\n', `def get_password(self) -> "x:y":\n    return "${R}"\n`],
    // a getter gets the noun before a preposition; a typeof operand is a whole member chain
    ['a.ts', 'class S {\n  getEncryptionKeyFromPassword(p: string) {\n    return derive(p, "hunter2long");\n  }\n}', `class S {\n  getEncryptionKeyFromPassword(p: string) {\n    return derive(p, "${R}");\n  }\n}`],
    ['a.ts', 'class S {\n  getOrCreateToken() {\n    return "hunter2long";\n  }\n}', `class S {\n  getOrCreateToken() {\n    return "${R}";\n  }\n}`],
    ['a.ts', "function getToken(a) {\n  return f(typeof a) === 'string' ? a : null;\n}", `function getToken(a) {\n  return f(typeof a) === '${R}' ? a : null;\n}`],
    ['a.ts', "function getToken(a) {\n  return 'string' === typeof a + b ? a : null;\n}", `function getToken(a) {\n  return '${R}' === typeof a + b ? a : null;\n}`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it.each([
    ['a.ts', 'type Token = "a" | "b";'],
    ['a.ts', 'export type ApiToken = "bearer" | "basic";'],
    ['a.kt', 'class Password(val value: String = "label")'],
    ['A.java', 'record Password(String value) { static final String LABEL = "label"; }'],
    ['a.py', 'class Password(Base):\n    label = "label"'],
    ['a.ts', 'function getToken(x: unknown) {\n  if (typeof x === "string") return x;\n  return null;\n}'],
    ['a.ts', 'function getToken(x: unknown) {\n  return "string" === typeof x?.y ? x : null;\n}'],
    ['a.ts', 'function getToken(x: unknown) {\n  return typeof (x) !== "object" && (typeof x) == "string" ? x : null;\n}'],
    ['a.ts', 'function getToken(x: unknown) {\n  switch (true) { case typeof x === "string": return x; }\n}'],
    ['a.ts', 'const accessibilityFocusToken = "focusLabel";'],
    ['a.ts', 'const mapInputToken = "inputLabel1";'],
    ['notes.md', 'display_frame_token=1234567890 surface_frame_token=9876543210'],
    ['a.yaml', 'next_page_token: 12345678901234'],
    ['a.c', '#define PASSWORD_LENGTH 16'],
    // a device serial, model or build code inside a path or a joined name is still a name
    ['notes.md', 'traces/imported/hpc-scroll-runs/Honor-300-Pro/trace/AMP-AN00-AY8CUT4B27009707-scrolling-webview-20260215-181714.pftrace'],
    ['notes.md', 'fingerprint: HONOR/AMP-AN00/HNAMP:16/HONORAMP-AN00/10DLDLD111C00E110:user/release-keys'],
    ['a.ts', "const fingerprint = 'google/sdk_gphone64_arm64/emu64a:15/AE3A/1:user/release-keys';"],
    ['a.ts', "const csrfToken = typeof req.headers['x-csrf-token'] === 'string'\n  ? req.headers['x-csrf-token'] : undefined;"],
    ['a.ts', "function getToken() {\n  return typeof getValue() === 'string' ? 1 : 2;\n}"],
    ['a.ts', "function getToken(a) {\n  return typeof a?.[k] === 'string' || 'string' === ((typeof a.b)) ? a : null;\n}"],
    ['a.ts', 'class S {\n  private getSessionFromToken(accessToken: string) {\n    log("visible");\n    return null;\n  }\n}'],
  ])('keeps %s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });

  it('withholds an authentication-qualified domain token in owner text', () => {
    expect(redactCredentialsInText('authInputToken = "hunter2long"')).not.toContain('hunter2long');
  });
});

describe('round 11: purposes in two words, members, joined lines, make, CMake and Python blocks', () => {
  it.each([
    // two words that name an authentication purpose together, and authentication flows
    ['a.js', 'const signInInputToken = "hunter2long";', `const signInInputToken = "${R}";`],
    ['a.js', 'const logInPageToken = "hunter2long";', `const logInPageToken = "${R}";`],
    ['a.yaml', 'sign_in_input_token: hunter2long', `sign_in_input_token: ${R}`],
    ['a.js', 'const otpInputToken = "hunter2long";', `const otpInputToken = "${R}";`],
    ['a.js', 'const resetPageToken = "hunter2long";', `const resetPageToken = "${R}";`],
    ['a.js', 'const emailVerificationInputToken = "hunter2long";', `const emailVerificationInputToken = "${R}";`],
    // a member named like a type keyword declares nothing
    ['a.js', 'let password;\nconst obj = { class: 1 };\nobj.class\npassword = "hunter2long";', `let password;\nconst obj = { class: 1 };\nobj.class\npassword = "${R}";`],
    ['a.js', 'obj.enum\npassword = "hunter2long";', `obj.enum\npassword = "${R}";`],
    ['a.kt', 'val k = Foo::class\npassword = "hunter2long"', `val k = Foo::class\npassword = "${R}"`],
    // lines a language joins before it reads tokens: the `\` and line break stay
    ['a.c', 'const char* PASS\\\nWORD = "hunter2long";', `const char* PASS\\\nWORD = "${R}";`],
    ['a.c', '#de\\\nfine PASSWORD "hunter2long"', `#de\\\nfine PASSWORD "${R}"`],
    ['a.c', '#define PASS\\\nWORD "hunter2long"', `#define PASS\\\nWORD "${R}"`],
    ['a.c', 'const char* password = "hunter\\\n2long";', `const char* password = "${R}\\\n${R}";`],
    ['a.cc', 'std::string pass\\\nword{"hunter2long"};', `std::string pass\\\nword{"${R}"};`],
    ['a.sh', 'PASS\\\nWORD=hunter2long', `PASS\\\nWORD=${R}`],
    ['a.sh', 'export PASSWORD="hunter\\\n2long"', `export PASSWORD="${R}\\\n${R}"`],
    ['a.properties', 'pass\\\n    word=hunter2long', `pass\\\n    word=${R}`],
    ['a.properties', 'password=hunter\\\n    2long\nnext=1', `password=${R}\\\n    ${R}\nnext=1`],
    // make and CMake assignments
    ['a.mk', 'PASSWORD := hunter2long', `PASSWORD := ${R}`],
    ['Makefile', 'KEYSTORE_PASSWORD ?= hunter2long # the store', `KEYSTORE_PASSWORD ?= ${R} # the store`],
    ['a.mk', 'export API_TOKEN = hunter2long', `export API_TOKEN = ${R}`],
    ['a.mk', 'override SECRET += hunter2long', `override SECRET += ${R}`],
    ['a.mk', 'PASSWORD = hunter \\\n  2long', `PASSWORD = ${R} \\\n  ${R}`],
    ['a.mk', 'define PASSWORD\nhunter2long\nendef\nX = 1', `define PASSWORD\n${R}\nendef\nX = 1`],
    ['a.cmake', 'set(PASSWORD hunter2long)', `set(PASSWORD ${R})`],
    ['CMakeLists.txt', 'SET(API_KEY "hunter2long" CACHE STRING "the key")', `SET(API_KEY "${R}" CACHE STRING "the key")`],
    ['a.cmake', 'set(ENV{GITHUB_TOKEN} hunter2long)', `set(ENV{GITHUB_TOKEN} ${R})`],
    ['a.cmake', 'set(PASSWORD [[hunter2long]])', `set(PASSWORD [[${R}]])`],
    // a command substitution says where a value comes from; with anything after it the whole is a value,
    // and the data reader reads backticks as quotes (a Markdown code span)
    ['a.sh', 'export DB_PASSWORD=$(cat /run/secrets/db)hunter2long', `export DB_PASSWORD=${R}`],
    ['a.sh', 'API_TOKEN=`cat token.txt` ./run.sh', `API_TOKEN=\`${R}\` ./run.sh`],
    // a Python block ends only at code indented no deeper than its definition
    ['a.py', 'def getPassword():\n    pass\n# comment\n    return "hunter2long"\n', `def getPassword():\n    pass\n# comment\n    return "${R}"\n`],
    ['a.py', 'def getPassword():\n    pass\n\f    return "hunter2long"\n', `def getPassword():\n    pass\n\f    return "${R}"\n`],
    // a weak key's value is judged without the keyless heuristic's names
    ['a.ts', 'const frameToken = "ABC12345-DEF67890";', `const frameToken = "${R}";`],
    ['a.ts', 'const pageToken = "ab123cd-xy456z";', `const pageToken = "${R}";`],
    // a shell reads quotes per context, and a comment only where a word starts in what it reads
    ['a.sh', 'X=foo\\\n#bar; PASS\\\nWORD=hunter2long', `X=foo\\\n#bar; PASS\\\nWORD=${R}`],
    ['a.sh', 'X="$(printf \'%s\' \'"\')"; PASS\\\nWORD=hunter2long', `X="$(printf '%s' '"')"; PASS\\\nWORD=${R}`],
    ['a.sh', "cat <<EOF\ndon't\nEOF\nPASS\\\nWORD=hunter2long", `cat <<EOF\ndon't\nEOF\nPASS\\\nWORD=${R}`],
    ['a.sh', 'a;#c \\\nPASSWORD=hunter2long', `a;#c \\\nPASSWORD=${R}`],
    // make definitions nest, and a recipe line holds no directive
    ['a.mk', 'define PASSWORD\ndefine OTHER\nlabel\nendef\nhunter2long\nendef', `define PASSWORD\n${R}\n${R}\n${R}\n${R}\nendef`],
    ['a.mk', 'define PASSWORD\nx\n\tendef\nhunter2long\nendef', `define PASSWORD\n${R}\n\t${R}\n${R}\nendef`],
    // a command kept as where a value comes from, holding another credential key, is withheld whole
    ['a.sh', 'DB_PASSWORD=$(tool --password=hunter2long)', `DB_PASSWORD=${R}`],
    ['a.sh', 'DB_PASSWORD=$(PASSWORD=hunter2long printenv PASSWORD)', `DB_PASSWORD=${R}`],
    ['a.mk', 'DB_PASSWORD := $(tool --password=hunter2long)', `DB_PASSWORD := ${R}`],
    ['notes.md', 'DB_PASSWORD=$(tool --password=hunter2long)', `DB_PASSWORD=${R}`],
    ['a.sh', 'X=$(tool --password=hunter2long)', `X=$(tool --password=${R})`],
    // CMake groups arguments in parentheses
    ['a.cmake', 'set(PASSWORD (a) hunter2long)', `set(PASSWORD (${R}) ${R})`],
    // a shell's text is read as written and with every `\` and line break removed: what a quoted
    // here-document's body joins is withheld too (over-redaction, as no shell is lexed)
    ['a.sh', "cat <<'EOF'\nPASS\\\nWORD=x\nEOF", `cat <<'EOF'\nPASS\\\nWORD=${R}\nEOF`],
    // what a shell joins is read without lexing it: here-strings, escaped spaces, comments before a
    // here-document, quoted delimiter words, case patterns
    ['a.sh', "cat <<< 'EOF'\nPASS\\\nWORD=hunter2long", `cat <<< 'EOF'\nPASS\\\nWORD=${R}`],
    ['a.sh', 'X=foo\\ #bar; PASS\\\nWORD=hunter2long', `X=foo\\ #bar; PASS\\\nWORD=${R}`],
    ['a.sh', "cat <<EOF # 'comment\n'\nEOF\nPASS\\\nWORD=hunter2long", `cat <<EOF # 'comment\n'\nEOF\nPASS\\\nWORD=${R}`],
    ['a.sh', "cat <<'EOF'foo\nEOFfoo\nPASS\\\nWORD=hunter2long", `cat <<'EOF'foo\nEOFfoo\nPASS\\\nWORD=${R}`],
    ['a.sh', 'case $x in a) echo "\'";; esac; PASS\\\nWORD=hunter2long', `case $x in a) echo "'";; esac; PASS\\\nWORD=${R}`],
    // CMake's options take the end of the call only
    ['a.cmake', 'set(PASSWORD (PARENT_SCOPE) hunter2long)', `set(PASSWORD (${R}) ${R})`],
    ['a.cmake', 'set(PASSWORD hunter2long CACHE hunter3long "doc")', `set(PASSWORD ${R} ${R} ${R} "${R}")`],
    // inside single quotes a shell keeps the pair: the text as written is what it reads
    ['a.sh', "echo 'a\\\nPASSWORD=hunter2long'", `echo 'a\\\nPASSWORD=${R}'`],
    // a `PARENT_SCOPE` that is not last is part of the value
    ['a.cmake', 'set(PASSWORD PARENT_SCOPE hunter2long)', `set(PASSWORD ${R} ${R})`],
    // CMake's inner parentheses are arguments of their own
    ['a.cmake', 'set(PASSWORD CACHE STRING () hunter2long)', `set(PASSWORD ${R} ${R} () ${R})`],
    ['a.cmake', 'set(PASSWORD CACHE STRING (hunter2long))', `set(PASSWORD ${R} ${R} (${R}))`],
    ['a.cmake', 'set(PASSWORD CACHE STRING hunter2long ())', `set(PASSWORD ${R} ${R} ${R} ())`],
    // an assigned word is a value; only after a label are a word and more words a sentence
    ['a.js', 'run("--password=correcthorsebatterystaple --user=bob");', `run("--password=${R} --user=bob");`],
    ['notes.md', 'Run tool --password=correcthorsebatterystaple --user=bob', `Run tool --password=${R} --user=bob`],
    ['a.sh', 'tool --password=correcthorsebatterystaple --user=bob', `tool --password=${R} --user=bob`],
    ['a.yaml', 'args: --password=correcthorsebatterystaple --user=bob', `args: --password=${R} --user=bob`],
    // a long flag's unquoted value
    ['a.sh', 'tool --password correcthorsebatterystaple --user bob', `tool --password ${R} --user bob`],
    ['notes.md', 'mysql -u root --password hunter2long db', `mysql -u root --password ${R} db`],
    // hex of a hash's length that nothing names as a hash is still withheld
    ['notes.md', 'push f39ca3510efb2347ebfef231e25a3e804922450d now', `push ${R} now`],
    ['notes.md', 'hash 0123456789abcdef0123456789abcdef01234567890', `hash ${R}`],
    // a long flag's value may start with or hold an escaped character
    ['a.sh', 'tool --password \\hunter2long', `tool --password ${R}`],
    ['a.sh', 'tool --password correcthorse\\ batterystaple', `tool --password ${R}`],
    ['notes.md', 'tool --password correcthorse\\ batterystaple', `tool --password ${R}`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it.each([
    ['a.mk', 'PASSWORD := $(DB_PASSWORD)\nAPI_TOKEN = $(shell cat token.txt)'],
    ['a.cmake', 'set(PASSWORD ${DB_PASSWORD})\nset(API_TOKEN $ENV{API_TOKEN})'],
    ['a.mk', 'LOCAL_MODULE := password_store\nLOCAL_SRC_FILES := token.c'],
    ['a.cmake', 'set(SOURCES token.c password.c)'],
    ['a.cmake', 'set(CONFIG_SOC_I2S_SUPPORTS_PLL_F160M "y")\nset(CONFIG_MBEDTLS_ECP_DP_BP256R1_ENABLED "y")'],
    ['a.sh', 'export DB_PASSWORD=$(cat /run/secrets/db)'],
    ['notes.md', 'Run with password=$(openssl rand -hex 16) once.'],
    ['a.mk', 'API_KEY := $(shell cat $(KEY_FILE))'],
    ['a.sh', 'echo ${#items[@]} # a count\nexit 0'],
    ['a.cmake', 'set(API_KEY ${KEY} CACHE STRING "the key" FORCE)\nset(PASSWORD ${PASS} PARENT_SCOPE)'],
    ['a.js', 'log("password: missing value");'],
    ['notes.md', 'The token: expected format'],
    ['notes.md', 'Use the --password option to set it.'],
    ['a.sh', 'tool --password "$PW" --token $TOKEN'],
    ['notes.md', 'Set token=newToken, password=passwordValue or api_key=user.apiKey.'],
    // the keyless heuristic reads names, hashes named as such and links after CJK punctuation
    ['notes.md', '- **链接**：https://mp.weixin.qq.com/s?__biz=MzAwODA2Njk2OA==&mid=2247487528&idx=1&sn=b3308ebcb243df444d9575aaf52c0dd4&scene=21'],
    ['notes.md', 'AndroidX Fragment 固定 commit `f39ca3510efb2347ebfef231e25a3e804922450d`'],
    ['notes.md', '"sha256": "11992042a5e3a71102a7e0330592016fcf83bc2377d6ec752ca5afe3d94419b8"'],
    ['notes.md', '- **链接**: Obsidian/Personal-Knowlodge/source/rss-tech/2026-04-20_RSS_5f3e2a1b/notes.md'],
    ['a.py', 'class A:\n    def get_password(self):\n        return self._password\n# a comment\n    def label(self):\n        return "visible"\n'],
  ])('keeps %s: %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });

  it('registers every literal of a getter\'s body for the guard, passphrases included', () => {
    const getter = 'function getApiKey() {\n  if (!headers.has("Authorization")) log("Authorization header missing");\n  return "hunter2long";\n}';
    expect(credentialValues(getter, credentialContextForPath('a.js'))).toEqual(['Authorization', 'Authorization header missing', 'hunter2long']);
    const passphrases = 'function getPassword() { return "correcthorsebatterystaple"; }\nconsole.log("correcthorsebatterystaple");\n'
      + 'function getToken() { return "secret phrase with spaces"; }\nlog("secret phrase with spaces");';
    const owner = redactCredentialsInText(passphrases, credentialContextForPath('a.js'));
    expect(owner).not.toContain('correcthorse');
    expect(owner).not.toContain('phrase with');
  });

  it.each([
    ["# password=prefix\\\nPASSWORD=hunter2long\nprintf '%s' 'hunter2long'", 'hunter2long'],
    ["DB_PASSWORD=$(tool --password=correcthorsebatterystaple --user=bob)\nprintf '%s' 'correcthorsebatterystaple'", 'correcthorse'],
    ["DB_PASSWORD=$(tool --password='prefix password=hunter2long suffix')\nprintf '%s' 'prefix password=hunter2long suffix'", 'prefix'],
  ])('withholds a registered value where it recurs: %j', (text, secret) => {
    expect(redactCredentialsInText(text, credentialContextForPath('a.sh'))).not.toContain(secret);
  });

  it('registers many inner passwords on one line in linear time', () => {
    const started = Date.now();
    redactCredentialsInText(`DB_PASSWORD=$(tool ${'--password=hunter2long '.repeat(160000)})`, credentialContextForPath('a.sh'));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ['a.sh', "tool --password correcthorse\\ batterystaple\necho correcthorse batterystaple", 'batterystaple'],
    ['notes.md', "DB_PASSWORD=$(tool --password=alphaBeta --user=bob)\necho alphaBeta", 'alphaBeta'],
    ['notes.md', "DB_PASSWORD=$(tool --frame-token='password=hunter2long')\necho hunter2long", 'hunter2long'],
    ['notes.md', "password=abcdefgh; api_key=defghijk; echo abcdefghijk", 'ijk'],
  ])('withholds a registered value where it recurs in %s: %j', (file, text, secret) => {
    expect(redactCredentialsInText(text, credentialContextForPath(file))).not.toContain(secret);
  });

  it('registers nested credential elements in linear total length', () => {
    const nested = `${'<password>'.repeat(20000)}hunter2long${'</password>'.repeat(20000)}`;
    const started = Date.now();
    expect(credentialValues(nested, credentialContextForPath('a.xml')).join('').length).toBeLessThan(nested.length * 4);
    expect(redactCredentialsInText(nested, credentialContextForPath('notes.md'))).not.toContain('hunter2long');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('registers the passwords inside a command withheld whole', () => {
    expect(credentialValues('DB_PASSWORD=$(tool --password=hunter2long)', credentialContextForPath('a.sh'))).toEqual(['hunter2long']);
    const commands = 'DB_PASSWORD=$(tool --password=hunter2long)\nprintf \'%s\' \'hunter2long\'\n'
      + 'DB_PASSWORD=$(PASSWORD=secondSecret456 printenv PASSWORD)\necho secondSecret456';
    expect(credentialValues(commands, credentialContextForPath('a.sh'))).toEqual(expect.arrayContaining(['hunter2long', 'secondSecret456']));
    expect(redactCredentialsInText(commands, credentialContextForPath('a.sh'))).not.toMatch(/hunter2long|secondSecret456/);
  });

  it('registers a joined credential as the language reads it and as it is written', () => {
    expect(credentialValues('const char* password = "hunter2long\\\nsecondSecret456";', credentialContextForPath('a.c')))
      .toEqual(expect.arrayContaining(['hunter2longsecondSecret456', 'hunter2long', 'secondSecret456', 'hunter2long\\\nsecondSecret456']));
    const joined = 'const char *password = "hunt\\\ner2long";\nputs("hunter2long");';
    expect(credentialValues(joined, credentialContextForPath('a.c'))).toEqual(expect.arrayContaining(['hunter2long', 'hunt\\\ner2long']));
    expect(redactCredentialsInText(joined, credentialContextForPath('a.c'))).not.toContain('hunter2long');
  });
});

describe('round 16: a whole value registers however it is split', () => {
  const S = `ghp_${'A'.repeat(36)}`;

  it.each(['a.xml', 'notes.md'])('registers a password between an element and a token whole in %s', file => {
    const owner = redactCredentialsInText(`<password>prefix password="abc ${S} def" suffix</password>\necho "abc ${S} def"`,
      credentialContextForPath(file));
    expect(owner.split('\n')[1]).toBe(`echo "${R}"`);
  });

  it.each([
    ['a.sh', 'tool --password \\ hunter2long'],
    ['notes.md', 'tool --password \\ hunter2long'],
    ['a.sh', 'tool --password \\\thunter2long'],
    ['notes.md', 'tool --password \\\thunter2long'],
  ])('reads a flag value that starts with an escaped blank in %s: %j', (file, text) => {
    expect(redact(file, text)).toBe(`tool --password ${R}`);
    expect(redactCredentialsInText(`${text}\necho "hunter2long"`, credentialContextForPath(file))).not.toContain('hunter2long');
  });

  it.each([
    ['prefix\\ password=hunter2long\\ suffix', 'hunter2long'],
    ['prefix\\ --api-key=abcdef123456\\ suffix', 'abcdef123456'],
  ])('registers an escaped value whole, as written and as read, and the rest after each key in it: %j', (value, inner) => {
    const text = `DB_PASSWORD=$(tool --password=${value})\necho '${value.replace(/\\(.)/g, '$1')}'\necho ${value}\necho "${inner}"`;
    for (const file of ['a.sh', 'notes.md']) {
      const owner = redactCredentialsInText(text, credentialContextForPath(file));
      expect(owner).not.toMatch(/prefix|suffix/);
      expect(owner).not.toContain(inner);
    }
  });

  it.each([
    ['a.sh', 'DB_PASSWORD=$(tool --password=hunter2long:token=abcdef123456)\necho abcdef123456', 'abcdef123456'],
    ['notes.md', 'password: "use token=hunter2longer here"\necho hunter2longer here', 'hunter2longer'],
    // a weak key inside a strong value: the rest after it whatever its shape
    ['a.sh', "DB_PASSWORD=$(tool --password=prefix\\ frame_token=hunter2long\\ suffix)\necho 'hunter2long suffix'", 'hunter2long'],
    ['notes.md', 'password: "use frame_token=hunter2longer here"\necho hunter2longer here', 'hunter2longer'],
  ])('registers the rest of a value after a key inside it in %s: %j', (file, text, secret) => {
    expect(redactCredentialsInText(text, credentialContextForPath(file))).not.toContain(secret);
  });

  it.each([
    ['a.sh', 'PASSWORD=hunter2"long"\n', 'echo hunter2long; echo hunter2"long"', /hunter2|long/],
    ['a.py', 'password = "hunter2" "long"\n', 'print("hunter2long")', /hunter2|long/],
    ['a.c', 'const char *password = "hunt" "er2long";\n', 'puts("hunter2long"); puts("hunt" "er2long");', /hunt|er2long/],
    ['a.c', 'const char *password = "hunt\\\nr2longpass";\n', 'quoted: "hunt\\\nr2longpass"', /hunt|r2longpass/],
    ['a.properties', 'password=hunt\\\n    er2long\n', 'echo hunter2long and hunt\\\n    er2long', /hunt|er2long/],
    ['a.mk', 'define PASSWORD\nabc1234\nefgh567\nendef\n', 'note abc1234\nefgh567', /abc1234|efgh567/],
    ['a.yaml', 'password: |\n  abcd123\n  efgh456\n', 'note: "abcd123\n  efgh456"', /abcd123|efgh456/],
  ])('registers a value whose parts are each short whole in %s: %j', (file, source, recurrence, parts) => {
    expect(redactCredentialsInText(source + recurrence, credentialContextForPath(file))).not.toMatch(parts);
  });

  it('reads the keys inside an escaped value as part of it, in linear time', () => {
    const started = Date.now();
    redactCredentialsInText(`DB_PASSWORD=$(tool --password=a${'\\ password=a'.repeat(64000)})`, credentialContextForPath('a.sh'));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('finds a recurrence of a value written in any UTF-16 code units', () => {
    const password = 'p\u00e4ssw\u00f6rd\u{1F600}\u79d8\u5bc6';
    expect(redactCredentialsInText(`password = "${password}"\necho ${password} done`, credentialContextForPath('a.py')))
      .toBe(`password = "${R}"\necho ${R} done`);
  });

  it('registers deep nesting in linear total length, every level reachable', () => {
    for (const depth of [2000, 8000]) {
      const nested = `${'<pwd>'.repeat(depth)}hunter2long${'</pwd>'.repeat(depth)}`;
      expect(credentialValues(nested, credentialContextForPath('a.xml')).join('').length).toBeLessThan(nested.length);
      expect(redactCredentialsInText(`${nested}\necho hunter2long`, credentialContextForPath('a.xml'))).not.toContain('hunter2long');
    }
  });
});

describe('round 17: values between keys, values as their format reads them', () => {
  it.each([
    ['a.sh', 'DB_PASSWORD=$(tool --password=hunter2long:token=abcdef123456:password=otherSecret987)\necho abcdef123456\necho otherSecret987\necho hunter2long', /abcdef123456|otherSecret987|hunter2long/],
    ['a.sh', 'DB_PASSWORD=$(tool --password=prefix\\ token=abcdef123456\\ password=otherSecret987)\necho abcdef123456', /abcdef123456/],
    ['notes.md', 'password: "use api_key=abcdefghijk password=otherSecret987"\necho abcdefghijk', /abcdefghijk/],
    ['notes.md', 'password: "use api_key=abcdefghijk, password=otherSecret987"\necho abcdefghijk', /abcdefghijk/],
    // any key form ends the value before it, a credential's or not
    ['a.sh', 'DB_PASSWORD=$(tool --password=hunter2long:user=bob:token=abcdef123456)\necho hunter2long', /hunter2long/],
    ['notes.md', 'password: "hunter2long user=bob api_key=abcdefghijk"\necho hunter2long', /hunter2long/],
  ])('registers a value between two keys inside a value in %s: %j', (file, text, secret) => {
    expect(redactCredentialsInText(text, credentialContextForPath(file))).not.toMatch(secret);
  });

  it('does not cut a value at a label inside it', () => {
    const ids = "store.put('secret:provider:t:w:u:id', {});\nconst providerDir = path.join(tmpDir, 'provider-data');";
    expect(credentialValues(ids, credentialContextForPath('a.ts'))).not.toContain('provider');
    expect(redactCredentialsInText(ids, credentialContextForPath('a.ts')))
      .toContain("const providerDir = path.join(tmpDir, 'provider-data');");
  });

  it.each([
    ['a.yaml', 'password: >-\n  hunter2\n  longpas\necho "hunter2 longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: |-\n  hunter2\n  longpas\necho "hunter2\nlongpas"', /hunter2|longpas/],
    ['a.yaml', 'password: |2\n  hunter2\n    longpas\necho "hunter2\n  longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: >+\n  hunter2\n  longpas\n\n  morepw1\necho "hunter2 longpas\nmorepw1"', /hunter2|longpas|morepw1/],
    ['a.yaml', 'password: >\n  hunter2\n    deeper1\n  longpas\necho "hunter2\n  deeper1\nlongpas"', /hunter2|deeper1|longpas/],
    ['a.yaml', 'password: hunter2\n  longpas\necho "hunter2 longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: "hunter2\n  longpas"\necho "hunter2 longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: "hunter2\\\n  longpas"\necho "hunter2longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: |\n  #abc123secret\nnext: 1\necho "#abc123secret"', /abc123secret/],
    ['a.cmake', 'set(PASSWORD abc1234 efgh567)\nmessage("abc1234;efgh567")', /abc1234|efgh567/],
    ['a.js', 'const password = "hunter2" + "long";\nconsole.log("hunter2long");', /hunter2|long"/],
    ['a.kt', 'val password = "hunter2" +\n    "long"\nprintln("hunter2long")', /hunter2|long"/],
  ])('registers the value as its format reads it in %s: %j', (file, text, parts) => {
    expect(redactCredentialsInText(text, credentialContextForPath(file))).not.toMatch(parts);
  });

  it('withholds a value written across lone CRs where it recurs as written, keeping its CR line breaks', () => {
    const owner = redactCredentialsInText('password: |\r  hunter2long\r  abcdef\rnext: visible\recho "hunter2long\r  abcdef"',
      credentialContextForPath('a.yaml'));
    expect(owner).toContain('\rnext: visible\r');
    expect(owner.endsWith(`echo "${R}\r  ${R}"`)).toBe(true);
  });

  it('withholds a comment-like line inside a YAML block where it stands', () => {
    expect(redact('a.yaml', 'password: |\n  #abc123secret\n  rest1234\nnext: visible'))
      .toBe(`password: |\n  ${R}\n  ${R}\nnext: visible`);
  });

  it.each([
    ['a.js', 'const password = "hunter2" + "long";', `const password = "${R}" + "${R}";`],
    ['a.kt', 'val password = "hunter2" +\n    "long"', `val password = "${R}" +\n    "${R}"`],
    ['a.py', 'password = "hunter2" "long"', `password = "${R}" "${R}"`],
    ['a.c', 'const char *password = "hunt\\\nr2longpass";', `const char *password = "${R}\\\n${R}";`],
  ])('keeps the syntax between the parts of a value where it stands in %s', (file, text, expected) => {
    expect(redactCredentialsInText(text, credentialContextForPath(file))).toBe(expected);
  });

  it.each([
    ['crafted code units', (n: number) => {
      const mask = 2 * n - 1;
      let secret = '';
      for (let node = n - 2; node >= 0; node--) {
        let code = ((Math.imul(Math.imul(node, 0x9e3779b1) & mask, 0xa5cb9243) - 1) & mask) + 32768;
        if (code === 65279) code -= 32768;
        secret += String.fromCharCode(code);
      }
      return `password="${secret}"\necho "${secret}"`;
    }],
    ['wide fan-out', (n: number) => Array.from({length: n}, (_, i) => `password="abcdefgh${String.fromCharCode(0x4e00 + i)}"`).join('\n')],
  ])('finds recurrences in linear time on %s', (_label, build) => {
    const started = Date.now();
    redactCredentialsInText(build(32768), credentialContextForPath('a.yaml'));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});


/** Random YAML documents with a credential value as a block or flow scalar, from a seed. */
function yamlCredentialDocuments(seed: number, count: number): string[] {
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (n: number) => Math.floor(rand() * n);
  const word = () => Array.from({length: 2 + int(5)}, () => 'abcdefghijkmnpqrstuvwxyz23456789'[int(32)]).join('');
  const words = () => Array.from({length: 1 + int(3)}, word).join(' ');
  const sp = (n: number) => ' '.repeat(n);
  // What may stand between a key and its value: properties, a comment, blank, comment and property-only lines.
  const beforeValue = (keyIndent: number, props: string) => {
    const deeper = () => sp(keyIndent + 1 + int(2));
    const lines: string[] = [props.trimEnd() + (rand() < 0.3 ? ' # note' : '')];
    for (let k = int(4); k > 0; k--) {
      const r = rand();
      lines.push(r < 0.3 ? '' : r < 0.6 ? sp(int(keyIndent + 4)) + '# ' + word() : deeper() + ['&b', '!!str', '&c !!str'][int(3)]);
    }
    return lines.join('\n') + '\n' + deeper();
  };
  const block = () => {
    const [prefix, keyIndent] = ([['', 0], ['outer:\n  ', 2], ['- ', 2], ['outer:\n  - ', 4]] as const)[int(4)];
    const chomp = ['', '-', '+'][int(3)];
    const indicator = rand() < 0.4 ? 1 + int(4) : 0;
    const header = (rand() < 0.5 ? '|' : '>') + (rand() < 0.5 ? chomp + (indicator || '') : (indicator || '') + chomp);
    const n = indicator ? keyIndent + indicator : keyIndent + 1 + int(4);
    const lines: string[] = [];
    if (indicator && rand() < 0.4) lines.push(rand() < 0.5 ? '' : sp(int(n + 3)));
    let first = true;
    for (let i = 2 + int(5); i > 0; i--) {
      const r = rand();
      if (!first && r < 0.2) { lines.push(''); continue; }
      if (!first && r < 0.3) { lines.push(sp(int(n + 4))); continue; }
      lines.push(sp(n + (first && !indicator ? 0 : (rand() < 0.3 ? 1 + int(3) : 0))) + words());
      first = false;
    }
    // Node properties before the header, or the header on the next line.
    const props = ['', '&pass ', '!!str ', '&a !!str ', '!!str &a '][int(5)];
    const lead = rand() < 0.35 ? beforeValue(keyIndent, props) : props;
    return `${prefix}password: ${lead}${header}\n${lines.join('\n')}\n${sp(keyIndent)}next: visible\n`;
  };
  const flow = () => {
    const kind = int(3);
    const parts: string[] = [];
    const lines = 2 + int(4);
    for (let i = 0; i < lines; i++) {
      let line = words();
      if (kind === 1 && rand() < 0.5) line += '\\';
      if (kind === 2 && rand() < 0.3) line += "''x";
      // A plain scalar's line may end in a comment (not the last line: the next key follows).
      if (kind === 0 && i > 0 && rand() < 0.3) line += ' #' + word();
      parts.push((i === 0 ? '' : sp(1 + int(3))) + line);
      if (i < lines - 1 && rand() < 0.35) for (let k = 1 + int(2); k > 0; k--) parts.push(rand() < 0.5 ? '' : sp(int(3)));
    }
    const quote = ['', '"', "'"][kind];
    const props = ['', '&pass ', '!!str ', '&a !!str '][int(4)];
    const lead = rand() < 0.35 ? beforeValue(0, props) : props;
    return `password: ${lead}${quote}${parts.join('\n')}${quote}\nnext: visible\n`;
  };
  // Any line ending YAML reads: LF, CRLF, or a lone CR.
  return Array.from({length: count}, () => (rand() < 0.65 ? block() : flow()).replace(/\n/g, ['\n', '\n', '\r\n', '\r'][int(4)]));
}

/** The credential each YAML parser reads from a generated document, without leading or trailing line breaks. */
function parsedCredentials(document: string): string[] {
  const values = new Set<string>();
  // A lone CR is a line break (YAML b-break); the `yaml` package reads it as a character, so js-yaml judges those documents.
  const parsers = /\r(?!\n)/.test(document)
    ? [(text: string) => jsyaml.load(text)]
    : [(text: string) => YAML.parse(text), (text: string) => jsyaml.load(text)];
  for (const parse of parsers) {
    try {
      let data: any = parse(document);
      if (Array.isArray(data)) data = data[0];
      if (data && typeof data === 'object' && 'outer' in data) data = data.outer;
      if (Array.isArray(data)) data = data[0];
      if (typeof data?.password === 'string') values.add(data.password.replace(/^\n+|\n+$/g, ''));
    } catch {
      // not YAML this parser reads
    }
  }
  return [...values].filter(value => value.length >= 8 && /[a-z0-9]/.test(value));
}

/** What of a recurrence after `next: visible` the owner guard leaves readable. */
function readableRecurrence(document: string, value: string): string {
  const owner = redactCredentialsInText(`${document}${value}\n`, credentialContextForPath('a.yaml'));
  return owner.slice(owner.indexOf('next: visible') + 'next: visible'.length).split('[REDACTED_SECRET]').join('');
}

describe('round 18: YAML values as YAML parsers read them', () => {
  it.each([
    ['a.yaml', 'password: |2-\n    hunter2\n    longpas\necho "  hunter2\n  longpas"', /hunter2|longpas/],
    ['a.yaml', 'password: |-\n  hunter2\n    \n  longpas\necho "hunter2\n  \nlongpas"', /hunter2|longpas/],
    ['a.yaml', 'password: "hunter2\\\n\n  longpas"\necho "hunter2 longpas"\necho "hunter2longpas"\necho "hunter2\nlongpas"', /hunter2|longpas/],
    ['a.c', 'const char *password = "abc\\tdef12";\nputs("abc\tdef12");', /abc|def12/],
    ['a.json', '{"apiKey": "sk\\u002dabc123xyz"}\nsk-abc123xyz', /abc123xyz/],
    ['a.yaml', "password: 'it''s-a-secret'\necho \"it's-a-secret\"", /secret"/],
    ['notes.md', 'password: "the token=abc12345 is old"\necho abc12345', /abc12345/],
    // the two parsers disagree on white space after the last line: `yaml` drops it, js-yaml keeps it
    ['a.yaml', 'password: |1-\n   cymy vx5bu r9cam\n qvdkz\n aqj\n  \nnext: visible\necho "  cymy vx5bu r9cam\nqvdkz\naqj"\necho "  cymy vx5bu r9cam\nqvdkz\naqj\n "', /qvdkz|aqj/],
    ['a.xml', '<password>abc&amp;def123</password>\nabc&def123', /abc|def123/],
    ['a.properties', 'password=p%40ssw0rd%21\necho p@ssw0rd!', /ssw0rd/],
    // round 19: node properties, values on the next line, continuation comments, XML and HTML references
    ['a.yaml', 'password: abcdef\n  ghijkl #comment\nnext: visible\necho "abcdef ghijkl"', /abcdef|ghijkl/],
    ['a.yaml', 'password: &pass |-\n  #hunter2long\n  abcdef\nnext: visible\necho "#hunter2long\nabcdef"', /hunter2long|abcdef/],
    ['a.yaml', 'password: !!str |2-\n    #hunter2long\n    abcdef\nnext: visible\necho "  #hunter2long\n  abcdef"', /hunter2long|abcdef/],
    ['a.yaml', 'password: &pass "abc\\tdefghi"\nnext: visible\necho "abc\tdefghi"', /abc|defghi/],
    ['a.yaml', 'password: &pass hunter2long\nnext: visible\necho hunter2long', /hunter2long/],
    ['a.yaml', 'password:\n  |\n    hunter2long\nnext: visible\necho hunter2long', /hunter2long/],
    ['a.yaml', 'password: # note\n  hunter2long\nnext: visible\necho hunter2long', /hunter2long/],
    ['a.xml', '<password>abc&#0000000064;def123</password>\necho abc@def123', /abc|def123/],
    ['a.xml', '<password>abc&#x000000040;def123</password>\necho abc@def123', /abc|def123/],
    ['a.html', '<password>abc&copy;def123</password>\necho abc©def123', /abc|def123/],
    ['a.html', '<password>abc&#128;def123</password>\necho abc€def123', /abc|def123/],
    ['a.xml', '<password>abc&#128;def123</password>\necho abc\u0080def123', /abc|def123/],
    ['a.xml', '<password>abc&#0000000128;def123</password>\necho abc\u0080def123', /abc|def123/],
    // round 20: comment and property-only lines before the value, HTML attribute reading
    ['a.yaml', 'password:\n  # comment\n  |-\n    #hunter2long\n    abcdef\nnext: visible\necho "#hunter2long\nabcdef"', /hunter2long|abcdef/],
    ['a.yaml', 'password:\n# comment\n  |-\n    #hunter2long\n    abcdef\nnext: visible\necho "#hunter2long\nabcdef"', /hunter2long|abcdef/],
    ['a.yaml', 'password:\n  &a\n  "abc\\tdefghi"\nnext: visible\necho "abc\tdefghi"', /abc|defghi/],
    ['a.yaml', 'password: &a\n  !!str\n  |-\n    #hunter2long\n    abcdef\nnext: visible\necho "#hunter2long\nabcdef"', /hunter2long|abcdef/],
    ['a.html', '<config password="abc&amp def&notit;ghi123"/>\necho abc& def&notit;ghi123', /abc|ghi123/],
    // round 21: a lone CR is a line break; what follows the value stays
    ['a.yaml', 'password:\n  # note\r  &a\r  !!str\r  |-\r    #hunter2long\r    abcdef\rnext: visible\necho "#hunter2long\nabcdef"', /hunter2long|abcdef|next: \[/],
    ['a.yaml', 'password:\r  |-\r    hunter2long\r    abcdef\rnext: visible\recho "hunter2long\nabcdef"', /hunter2long|abcdef|next: \[/],
  ])('withholds where it recurs the value %s reads: %j', (file, text, leak) => {
    const owner = redactCredentialsInText(text, credentialContextForPath(file));
    expect(owner.split('\n').slice(1).join('\n')).not.toMatch(leak);
  });

  it('withholds every credential either YAML parser reads from a generated block or flow scalar', () => {
    let checked = 0;
    for (const document of yamlCredentialDocuments(23, 800)) {
      for (const value of parsedCredentials(document)) {
        checked++;
        expect([document, readableRecurrence(document, value)]).not.toEqual([document, expect.stringMatching(/[a-z0-9]/)]);
      }
    }
    expect(checked).toBeGreaterThan(600);
  });

  it.each([
    ['escaped breaks', (n: number) => `password: "${'abcdefgh\\\n  '.repeat(n)}tailtail"\n`],
    ['escaped breaks and empty lines', (n: number) => `password: "${'abcdefgh\\\n\n  '.repeat(n)}tailtail"\n`],
    ['a folded block', (n: number) => `password: >\n${'  abcdefgh\n   spaced\n\n'.repeat(n)}`],
  ])('folds %s in linear time', (_label, build) => {
    const started = Date.now();
    redactCredentialsInText(build(131072), credentialContextForPath('a.yaml'));
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ['escaped quotes on one line', 'password=\\"', 'a.sh'],
    ['an unclosed escaped quote per line', 'password=\\"abc\n', 'notes.md'],
    ['unclosed commands on one line', 'password=$(', 'a.sh'],
    ['unclosed commands in quoted prose', 'password: "x token=$(', 'notes.md'],
  ])('reads up to a short bound without looking past it: %s', (_label, unit, file) => {
    const started = Date.now();
    redactCredentialsInText(unit.repeat(65536), credentialContextForPath(file));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('round 22: line breaks, white space and value ends as each format reads them', () => {
  // Each value as the format's real reader reads it: bash, GNU make, CMake,
  // java.util.Properties, configparser (with and without inline comments),
  // tomllib, ElementTree and node's dotenv.
  it.each([
    // A shell keeps a carriage return, a vertical tab and a no-break space inside a word.
    ['a.sh', 'password=abcd\rEFGH1234\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.sh', 'PASSWORD="abcd\rEFGH1234"\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.sh', "PASSWORD='abcd\rEFGH1234'\n", ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.sh', 'PASSWORD=abcd\\\rEFGH1234\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.sh', 'PASSWORD=hunter2\vlong99\n', ['hunter2\vlong99'], /hunter2|long99/],
    ['a.sh', 'PASSWORD=hunter2 long99\n', ['hunter2 long99'], /hunter2|long99/],
    ['a.sh', 'PASSWORD=hunter2long99\r\n', ['hunter2long99\r'], /hunter2long99/],
    // A credential a declaration, another assignment, a long option or an array gives.
    ['a.sh', "declare -x PASSWORD='abc'def123\n", ['abcdef123'], /abc|def123/],
    ['a.sh', 'readonly PASSWORD=abc#def123\n', ['abc#def123'], /abc|def123/],
    ['a.sh', 'export A=1 PASSWORD=hunter2long\n', ['hunter2long'], /hunter2long/],
    ['a.sh', "PASSWORD=$'hunter2\\tlong'\n", ['hunter2\tlong'], /hunter2|long'/],
    ['a.sh', 'mysql --password hunter2long db\n', ['hunter2long'], /hunter2long/],
    ['a.sh', 'PASSWORDS=(hunter2long "second secret")\n', ['hunter2long', 'second secret'], /hunter2long|second|secret"/],
    // make, Go and Rust keep it too; CMake takes it for white space between arguments.
    ['Makefile', 'PASSWORD := abcd\rEFGH1234\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.go', 'password := "abcd\rEFGH1234"\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.go', 'password := `abcd\rEFGH1234`\n', ['abcdEFGH1234'], /abcd|EFGH1234/],
    ['a.rs', 'let password = "abcd\rEFGH1234";\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['CMakeLists.txt', 'set(PASSWORD abcd\rEFGH1234)\n', ['abcd;EFGH1234'], /abcd|EFGH1234/],
    ['CMakeLists.txt', 'set(PASSWORD abcd\;EFGH1234)\n', ['abcd;EFGH1234'], /abcd|EFGH1234/],
    ['CMakeLists.txt', 'set(PASSWORD "abcd\;EFGH1234")\n', ['abcd\;EFGH1234'], /abcd|EFGH1234/],
    ['CMakeLists.txt', 'set(PASSWORD [[\nhunter2long]])\n', ['hunter2long'], /hunter2long/],
    ['CMakeLists.txt', 'set(PASSWORD "abcd\\nEFGH\\;1234")\n', ['abcd\nEFGH\\;1234'], /abcd|EFGH|1234/],
    // a `\` before a line break continues a JavaScript string without one
    ['a.js', 'const password = "hunter2\\\nlong99";\n', ['hunter2long99'], /hunter2|long99/],
    // A dotenv file: a shell sourcing it and dotenv libraries each read it their own way.
    ['.env', 'PASSWORD=abcd\rNEXT=visible\n', ['abcd\rNEXT=visible', 'abcd'], /abcd|NEXT/],
    ['.env', "PASSWORD='abc123'def456\n", ['abc123def456', "'abc123'def456"], /abc123|def456/],
    ['.env', 'PASSWORD=abc123#def456 ghi789\n', ['abc123'], /abc123|def456|ghi789/],
    ['.env', 'PASSWORD="abc123\\ndef456"\n', ['abc123\\ndef456', 'abc123\ndef456'], /abc123|def456/],
    // Java properties: a form feed separates, escapes decode their own way.
    ['a.properties', 'password\fhunter2longvalue\n', ['hunter2longvalue'], /hunter2longvalue/],
    ['a.properties', 'password=R7X5D8\\u0041H2J4Z9 J4M6N5 \n', ['R7X5D8AH2J4Z9 J4M6N5 '], /R7X5|H2J4Z9|J4M6N5/],
    ['a.properties', 'password=abc\\bdef\\x41ghi\n', ['abcbdefx41ghi'], /abc|def|ghi/],
    // configparser: no inline comments, continuation lines across comments and blank lines.
    ['a.ini', '[s]\npassword = hunter2 ;longvalue\n', ['hunter2 ;longvalue', 'hunter2'], /hunter2|longvalue/],
    ['a.ini', '[s]\npassword = hunter2long\n# c\n    CONTINUED99 ;note\n\n    MORE999\nnext = visible\n',
      ['hunter2long\nCONTINUED99 ;note\n\nMORE999', 'hunter2long\nCONTINUED99\n\nMORE999'], /hunter2long|CONTINUED99|MORE999|note/],
    ['a.cfg', 'password = hunter2long\n    CONTINUED99\n', ['hunter2long\nCONTINUED99'], /hunter2long|CONTINUED99/],
    // TOML strings, wherever they stand.
    ['a.toml', 'password = """\nN2S7M3\\tB9Z7H4\\\n   K2D3J6"""\n', ['N2S7M3\tB9Z7H4K2D3J6'], /N2S7M3|B9Z7H4|K2D3J6/],
    ['a.toml', 'passwords = ["abc", """V9M5X6\\\n   Q8J7N6"""]\n', ['V9M5X6Q8J7N6'], /V9M5X6|Q8J7N6/],
    ['a.toml', "password = '''\nabc\\def123'''\n", ['abc\\def123'], /abc|def123/],
    // XML: attribute values normalized, element text with CDATA, references and line breaks.
    ['a.xml', '<r password="abcd\nEFGH1234"/>\n', ['abcd EFGH1234'], /abcd|EFGH1234/],
    ['a.xml', '<r><password>abcd&#x41;EFGH\r\n1234</password></r>\n', ['abcdAEFGH\n1234'], /abcd|EFGH|1234/],
    ['a.xml', '<r><string name="api_key"><![CDATA[hunter2&long99]]></string></r>\n', ['hunter2&long99'], /hunter2|long99/],
    ['a.xml', '<r><entry key="password">hunter2<b>x</b>long</entry></r>\n', ['hunter2xlong'], /hunter2|long</],
    ['a.xml', '<r password="p@ss<w0rdLONG"/>\n', ['p@ss<w0rdLONG'], /p@ss|w0rdLONG/],
    // bash's `$'…'` quoting: octal escapes, and `\'` inside does not close it
    ['a.sh', "PASSWORD=$'hunter2\\101long'\n", ['hunter2Along'], /hunter2|long'/],
    ['a.sh', "PASSWORD=$'abc\\'def123'\nnext=visible\n", ["abc'def123"], /abc|def123/],
    // a long option's value is one shell word, a vertical tab inside it included
    ['a.sh', 'mysql --password hunter2\vlong99 db\n', ['hunter2\vlong99'], /hunter2|long99/],
    // a lone CR inside a shell string's data is part of the value
    ['a.sh', 'echo "password=abcd\rEFGH1234" > app.conf\n', [], /abcd|EFGH1234/],
    // Java decodes `\t` but reads `\b` as `b`
    ['a.properties', 'password=abc\\tdef\\bghi12\n', ['abc\tdefbghi12'], /abc|def|ghi12/],
    // a credential key written as words
    ['notes.md', 'API Key: abc123def456\n', ['abc123def456'], /abc123def456/],
    ['a.yaml', 'API Key: abc123def456\nnext: visible\n', ['abc123def456'], /abc123def456/],
    ['a.json', '{"apiKey": "abc123def456", "Private Key": "xyz789uvw012"}\n', ['abc123def456', 'xyz789uvw012'], /abc123def456|xyz789uvw012/],
    ['a.py', 'config = {"API Key": "abc123def456"}\n', ['abc123def456'], /abc123def456/],
    ['a.kt', 'val m = mapOf("API Key" to "abc123def456")\n', ['abc123def456'], /abc123def456/],
    ['a.ini', '[db]\ndb password = hunter2 long99\n', ['hunter2 long99'], /hunter2|long99/],
    ['a.ini', '[db]\nmy database admin password = hunter2 long99\n', ['hunter2 long99'], /hunter2|long99/],
    // a key of words whose last word alone names a credential is as strong as that word, in code too
    ['a.py', 'config = {"frame token": "abc12"}\n', [], /abc12/],
    // a YAML key of words, its value read as YAML reads it
    ['a.yaml', 'API Key: |\n  hunter2long\n  second99\nnext: visible\n', ['hunter2long\nsecond99'], /hunter2long|second99/],
    // round 23: configparser reading a string keeps a lone CR
    ['a.ini', '[x]\npassword=abcd\rEFGH1234\nnext=visible\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    ['a.cfg', '[x]\npassword=abcd\rEFGH1234\nnext=visible\n', ['abcd\rEFGH1234'], /abcd|EFGH1234/],
    // bash ends a $'…' string at a NUL it decodes and goes on with the rest of the word
    ['a.sh', "password=$'abcdefgh1234\\0TAIL5678'\n", ['abcdefgh1234'], /abcdefgh1234|TAIL5678/],
    ['a.sh', "password=$'abcdefgh1234\\x00TAIL5678'\n", ['abcdefgh1234'], /abcdefgh1234|TAIL5678/],
    ['a.sh', "password=$'abcdefgh1234\\c@TAIL5678'\n", ['abcdefgh1234'], /abcdefgh1234|TAIL5678/],
    ['a.sh', "password=$'abcd\\0efgh'ijkl5678\n", ['abcdijkl5678'], /abcd|efgh|ijkl5678/],
    // a parenthesis inside a CMake call is an element of the list
    ['CMakeLists.txt', 'set(password abcd(EFGH))\nset(next visible)\n', ['abcd;(;EFGH;)'], /abcd|EFGH/],
    // an outer credential element's text holds an inner one's
    ['a.xml', '<root><password>abcd<password>EFGH</password>ijkl</password><next>visible</next></root>\n', ['abcdEFGHijkl'], /abcd|EFGH|ijkl/],
  ] as Array<[string, string, string[], RegExp]>)('%s %j as its reader reads it', (file, text, values, leak) => {
    const context = credentialContextForPath(file);
    expect(redact(file, text)).not.toMatch(leak);
    for (const value of values.filter(read => read.trim().length >= 8)) {
      expect(redactCredentialsInText(`${text}\n${value}\n`, context).slice(text.length)).not.toMatch(leak);
    }
  });

  it.each([
    ['a.sh', 'password=abcd\rEFGH1234\nnext=visible\n', `password=${R}\r${R}\nnext=visible\n`],
    ['a.sh', 'X=$(tool --password=hunter2long)\n', `X=$(tool --password=${R})\n`],
    ['a.sh', 'PASSWORD=hunter2long>/dev/null\n', `PASSWORD=${R}>/dev/null\n`],
    ['a.sh', 'mysql --password hunter2long db\n', `mysql --password ${R} db\n`],
    ['a.ini', '[s]\npassword = hunter2long\n# c\n    CONTINUED99\nnext = visible\n', `[s]\npassword = ${R}\n# c\n    ${R}\nnext = visible\n`],
    ['a.xml', '<r password="p@ss<w0rdLONG"/><next>visible</next>\n', `<r password="${R}"/><next>visible</next>\n`],
    // a weak key's element with child elements holds structure, not a token
    ['a.xml', '<r><frameToken><id>12</id><size>34</size></frameToken></r>\n', '<r><frameToken><id>12</id><size>34</size></frameToken></r>\n'],
    // a key whose words name no credential
    ['a.json', '{"Primary Key": "customer_id", "sort key": "created_at"}\n', '{"Primary Key": "customer_id", "sort key": "created_at"}\n'],
    // a string of words as a call's argument is a message, not a key
    ['a.ts', 'expect(explainError("Invalid API key", "en", hint));\nshowError("Wrong password", "Please retry");\n', 'expect(explainError("Invalid API key", "en", hint));\nshowError("Wrong password", "Please retry");\n'],
  ])('keeps what is not the value: %s %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it('holds owner text that ends in a credential key written as words', () => {
    expect(endsInDanglingCredentialPrefix('API Key: ')).toBe(true);
    expect(endsInDanglingCredentialPrefix('Primary Key: ')).toBe(false);
  });

  it('reads a file the way each of its readers reads it', () => {
    const readings = (file: string) => credentialContextForPath(file).readings
      .map(reading => `${reading.language}:${reading.loneCarriageReturn}`);
    expect(readings('a.sh')).toEqual(['shell:character']);
    expect(readings('.env.local')).toEqual(['shell:character', 'dotenv:line-break']);
    expect(readings('a.yaml')).toEqual(['yaml:line-break']);
    expect(readings('a.go')).toEqual(['go:character']);
    expect(readings('a.cfg')).toEqual(['properties:line-break', 'ini:line-break', 'ini:character']);
    expect(readings('a.ini')).toEqual(['ini:line-break', 'ini:character']);
    expect(readings('a.proto')).toEqual(['c:line-break', 'c:character']);
    expect(readings('notes.md')).toEqual(['text:line-break']);
  });

  it('withholds every value node\'s dotenv reads from a generated file', () => {
    let checked = 0;
    for (const document of dotenvDocuments(29, 800)) {
      const value = dotenv.parse(document).PASSWORD;
      if (typeof value !== 'string' || value.trim().length < 8) continue;
      checked++;
      const parts = secretWindows(document, value);
      const context = credentialContextForPath('.env');
      const inPlace = redactSecrets(document, context).text;
      const owner = redactCredentialsInText(`${document}\n${value}\n`, context);
      expect([document, parts.filter(part => inPlace.includes(part) || owner.includes(part))]).toEqual([document, []]);
    }
    expect(checked).toBeGreaterThan(400);
  });
});

/** Random dotenv files with a PASSWORD value of secret words (`K7Q2M9`), from a seed. */
function dotenvDocuments(seed: number, count: number): string[] {
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(...options: T[]) => options[Math.floor(rand() * options.length)];
  const secret = () => Array.from({length: 3}, () => pick(...'BCDFGHJKLMNPQRSTVWXZ') + pick(...'23456789')).join('');
  const value = () => {
    const words = Array.from({length: 1 + Math.floor(rand() * 3)}, secret);
    const quote = pick('"', "'", '`', '', '');
    const joiner = quote ? pick(' ', '\n', '\\n', '\t', ' # ', '#', '\\"') : pick('', ' ', '\t', '#', ' #', '\r', "'", '"');
    const tail = quote ? pick('', '', ' # note', 'junk', ' junk') : '';
    return quote + words.join(joiner) + quote + tail;
  };
  return Array.from({length: count}, () => {
    const lines = [pick('', 'export ') + `PASSWORD${pick('=', ' = ', ': ')}${value()}${pick('', ' # note', '  #note')}`, 'next=visible'];
    if (rand() < 0.3) lines.unshift(pick('# a comment', '', 'OTHER=x'));
    return (lines.join('\n') + '\n').replace(/\n/g, pick('\n', '\n', '\r\n', '\r'));
  });
}

/**
 * The 3-character windows of the secret words in `value` that no other secret
 * word of `document` holds: any of them still readable is a leak.
 */
function secretWindows(document: string, value: string): string[] {
  const word = /(?:[BCDFGHJKLMNPQRSTVWXZ][2-9]){3}/g;
  const inValue = new Set(value.match(word) ?? []);
  const others = [...new Set(document.match(word) ?? [])].filter(found => !inValue.has(found)).join(' ');
  const windows = new Set<string>();
  for (const found of inValue) for (let index = 0; index + 3 <= found.length; index++) windows.add(found.slice(index, index + 3));
  return [...windows].filter(part => !others.includes(part));
}

describe('withholds what a credential getter or delegate returns', () => {
  it.each([
    ['a.kt', 'val password by lazy { "hunter2long" }', `val password by lazy { "${R}" }`],
    ['a.kt', 'val password: String\n    get() = "hunter2long"', `val password: String\n    get() = "${R}"`],
    ['A.java', 'public String getPassword() {\n    return "hunter2long";\n}', `public String getPassword() {\n    return "${R}";\n}`],
    ['A.java', 'public String getPassword()\n{\n    log("visible");\n    return "hunter2long";\n}', `public String getPassword()\n{\n    log("${R}");\n    return "${R}";\n}`],
    ['a.kt', 'fun getApiKey(): String = "abc123secret"', `fun getApiKey(): String = "${R}"`],
    ['a.js', 'get password() { return "hunter2long"; }', `get password() { return "${R}"; }`],
    ['a.py', 'def get_password(self) -> str:\n    return "hunter2long"\n\nprint("visible")', `def get_password(self) -> str:\n    return "${R}"\n\nprint("visible")`],
    ['a.go', 'func getPassword() (string, error) {\n\treturn "hunter2long", nil\n}', `func getPassword() (string, error) {\n\treturn "${R}", nil\n}`],
    ['a.cc', 'std::string getPassword() const { return "hunter2long"; }', `std::string getPassword() const { return "${R}"; }`],
    ['a.rs', 'fn get_password() -> &\'static str {\n    "hunter2long"\n}', `fn get_password() -> &'static str {\n    "${R}"\n}`],
    ['a.rs', 'fn get_password(ready: bool) -> &\'static str {\n    if ready { return "firstSecret123"; }\n    "hunter2long"\n}', `fn get_password(ready: bool) -> &'static str {\n    if ready { return "${R}"; }\n    "${R}"\n}`],
    ['a.rs', 'fn get_password() -> &\'static str {\n    let f = || { return "visible"; };\n    "hunter2long"\n}', `fn get_password() -> &'static str {\n    let f = || { return "${R}"; };\n    "${R}"\n}`],
    ['main.dart', 'String getPassword() => "hunter2long";', `String getPassword() => "${R}";`],
    ['a.kt', 'fun getPassword(): String\n    = "hunter2long"', `fun getPassword(): String\n    = "${R}"`],
    ['a.ts', 'class A {\n  apiKey(): string {\n    return "abc123secret";\n  }\n}', `class A {\n  apiKey(): string {\n    return "${R}";\n  }\n}`],
    ['A.java', 'String getPassword() {\n    String p = "hunter2long";\n    log("visible");\n    return p;\n}', `String getPassword() {\n    String p = "${R}";\n    log("${R}");\n    return p;\n}`],
    ['A.java', 'String getAuthToken() {\n    this.authToken = "hunter2long";\n    return this.authToken;\n}', `String getAuthToken() {\n    this.authToken = "${R}";\n    return this.authToken;\n}`],
    ['a.go', 'func getPassword() string {\n\tp := "hunter2long"\n\treturn p\n}', `func getPassword() string {\n\tp := "${R}"\n\treturn p\n}`],
    ['a.go', 'func getPassword() (p string) {\n\tp = "hunter2long"\n\treturn\n}', `func getPassword() (p string) {\n\tp = "${R}"\n\treturn\n}`],
    ['a.py', '@property\ndef password(self):\n    return "hunter2long"', `@property\ndef password(self):\n    return "${R}"`],
    ['a.kt', 'fun apiKey(): String = "abc123secret"', `fun apiKey(): String = "${R}"`],
    ['a.ts', 'class A {\n  getAuthToken(): string | undefined {\n    const token = read();\n    return typeof token === \'string\' && token ? token : "fallbackSecret";\n  }\n}',
      `class A {\n  getAuthToken(): string | undefined {\n    const token = read();\n    return typeof token === 'string' && token ? token : "${R}";\n  }\n}`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('reads raw and slashy strings', () => {
  it.each([
    ['a.swift', 'let password = #"raw"secret"#', `let password = #"${R}"#`],
    ['a.rs', `let password = r${'#'.repeat(12)}"hunter"2long"${'#'.repeat(12)};`, `let password = r${'#'.repeat(12)}"${R}"${'#'.repeat(12)};`],
    ['build.gradle', 'def password = /hunter2long/', `def password = /${R}/`],
    ['build.gradle', 'def password = $/hunter2long/$', `def password = $/${R}/$`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('never leaves a credential-named value unread', () => {
  it.each([
    ['a.js', `const password = ${'x+'.repeat(2100)}"shortSecret123";`, `const password = ${'x+'.repeat(2100)}"${R}";`],
    ['Main.kt', `val password = "${'a'.repeat(20000)}`, `val password = "${R}`],
    ['Main.kt', `val password = """${'a'.repeat(17000)}\nlastSecret123\n"""\nval x = 1`, `val password = """${R}\n${R}\n"""\nval x = 1`],
    ['a.js', 'const password = "first\\\nlastSecret123";', `const password = "${R}\n${R}";`],
    ['a.js', 'const password = "first\\\nlastSecret123', `const password = "${R}\n${R}`],
    ['notes.md', `password = ${'1!'.repeat(300)}lastSecret123`, `password = ${R}`],
    ['notes.md', `password = "${'a'.repeat(4100)}lastSecret123"`, `password = "${R}"`],
    ['strings.xml', `<string name="api_key">${'a'.repeat(4100)}lastSecret123</string>`, `<string name="api_key">${R}</string>`],
    ['a.xml', `<config password="${'a'.repeat(4100)}lastSecret123"/>`, `<config password="${R}"/>`],
    ['a.properties', `${'a.'.repeat(80)}password=hunter2long`, `${'a.'.repeat(80)}password=${R}`],
    ['a.js', `const password = "hunter2long" + ${'\n'.repeat(3)}"secondSecret456";`, `const password = "${R}" + ${'\n'.repeat(3)}"${R}";`],
  ])('%s: %#', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('reads a config value whole before judging it', () => {
  it.each([
    ['keystore.properties', 'keystore_password=@Ab2960617', `keystore_password=${R}`],
    ['gradle.properties', 'signingPassword=letmeinplease', `signingPassword=${R}`],
    ['a.properties', 'password=$abc123', `password=${R}`],
    ['a.properties', 'db.password=abc\\\n  def', `db.password=${R}\\\n  ${R}`],
    ['a.properties', 'password=hello world\\\n  more words', `password=${R}\\\n  ${R}`],
    ['a.properties', 'password=${PASSWORD}\\\n  continuedSecret', `password=${R}\\\n  ${R}`],
    ['a.properties', 'password=abc\\\\\nordinary=value', `password=${R}\nordinary=value`],
    ['a.yaml', 'password: |\n  abc123\n  def456\nnext: x', `password: |\n  ${R}\n  ${R}\nnext: x`],
    ['a.yaml', 'password: |2-\n  fixedSecret123\nnext: x', `password: |2-\n  ${R}\nnext: x`],
    ['a.yaml', 'password: abc123\n  continuedSecret\nnext: x', `password: ${R}\n  ${R}\nnext: x`],
    ['a.yaml', 'users:\n  - password: hunter2long\n    name: admin', `users:\n  - password: ${R}\n    name: admin`],
    ['a.yaml', 'users:\n  - password: |\n      blockSecret123\n    name: admin', `users:\n  - password: |\n      ${R}\n    name: admin`],
    ['a.yaml', 'db: {user: admin, password: hunter2long}', `db: {user: admin, password: ${R}}`],
    ['a.sh', 'password=\'$abc123\'', `password='${R}'`],
    ['a.sh', 'password="${PASSWORD:-fixedSecret123}"', `password="${R}"`],
    ['a.sh', 'export PASSWORD="${PASSWORD:-fallbackSecret}"', `export PASSWORD="${R}"`],
    ['a.sh', 'password="$PASSWORD"fixedSecret123', `password="$PASSWORD"${R}`],
    ['a.sh', 'password="abc123"def456', `password="${R}"${R}`],
    ['a.sh', 'password=abc\\ def456', `password=${R}`],
    ['a.sh', 'password="abc"\\ def456', `password="${R}"${R}`],
    ['a.sh', 'mysql --password=hunter2long -u root', `mysql --password=${R} -u root`],
    ['a.sh', 'local password="hunter2long"', `local password="${R}"`],
  ])('%s: %j', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('reads literal contents as data and comments and plain text as prose', () => {
  it.each([
    ['a.js', 'fetch(u, {body: "user=a&password=letmeinplease"})', `fetch(u, {body: "user=a&password=${R}"})`],
    ['A.java', 'String url = "jdbc:mysql://db/x?user=a&password=abc123";', `String url = "jdbc:mysql://db/x?user=a&password=${R}";`],
    ['a.js', 'const body = \'{"password":"hunter2","user":"a"}\';', `const body = '{"password":"${R}","user":"a"}';`],
    ['A.java', 'String j = "{\\"apiKey\\":\\"zz9-secret\\"}";', `String j = "{\\"apiKey\\":\\"${R}\\"}";`],
    ['a.js', 'const payload = "password=supersecret";', `const payload = "password=${R}";`],
    ['a.js', 'const body = \'{"api_token": ["abc123secret"]}\';', `const body = '{"api_token": ["${R}"]}';`],
    ['a.kt', '// password: hunter2long please rotate', `// password: ${R} please rotate`],
    ['notes.md', 'Set password: hunter2long in the config.', `Set password: ${R} in the config.`],
    ['notes.md', 'password =\n"shortSecret123"', `password =\n"${R}"`],
    ['notes.md', 'password =\n\n"shortSecret123"\n', `password =\n\n"${R}"\n`],
    ['notes.md', 'call setPassword(\n"shortSecret123")', `call setPassword(\n"${R}")`],
    ['notes.md', 'password = "first\\"secondSecret123"', `password = "${R}"`],
    ['notes.md', 'password = "first\\\nlastSecret123"', `password = "${R}\n${R}"`],
    ['notes.md', 'password = `first\\`\n      lastSecret123`', `password = \`${R}\n      ${R}\``],
    ['schema.sql', "CREATE USER app WITH PASSWORD 'hunter2long';", `CREATE USER app WITH PASSWORD '${R}';`],
    ['notes.md', 'run `tool --api-token "abc123secret"` once', `run \`tool --api-token "${R}"\` once`],
    ['notes.md', '{"passwords": ["first1secret", "second2secret"]}', `{"passwords": ["${R}", "${R}"]}`],
    ['config.json', '{"password": {"value": "hunter2long"}}', `{"password": {"${R}": "${R}"}}`],
  ])('%s: %#', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('markup', () => {
  it.each([
    ['strings.xml', '<string name="google_maps_api_key">AIzaSyB-AbCdEfGhIjKlMnOpQrStUvWxYz0123</string>',
      `<string name="google_maps_api_key">${R}</string>`],
    ['strings.xml', '<string name="api_token" translatable="false">abc123secret</string>', `<string name="api_token" translatable="false">${R}</string>`],
    ['strings.xml', '<string name="api_key"><![CDATA[abc123secret]]></string>', `<string name="api_key">${R}</string>`],
    ['a.xml', '<config password="hunter2long"/>', `<config password="${R}"/>`],
    ['a.xml', '<config password="it\'s-a-secret"/>', `<config password="${R}"/>`],
    ['a.xml', '<config password="hunter2long', `<config password="${R}`],
    ['settings.xml', '<server>\n  <id>repo</id>\n  <password>hunter2long</password>\n</server>',
      `<server>\n  <id>repo</id>\n  <password>${R}</password>\n</server>`],
    ['a.xml', '<password>\n  multiLineSecret\n</password>', `<password>\n  ${R}\n</password>`],
    ['a.xml', '<password>unclosedSecret\n<other/>', `<password>${R}\n${R}`],
    ['beans.xml', '<property name="password" value="hunter2long"/>', `<property name="password" value="${R}"/>`],
    ['AndroidManifest.xml', '<meta-data android:name="com.google.android.geo.API_KEY" android:value="secretMapsKey123"/>',
      `<meta-data android:name="com.google.android.geo.API_KEY" android:value="${R}"/>`],
    ['Info.plist', '<key>APIToken</key>\n<string>abc123secret</string>', `<key>APIToken</key>\n<string>${R}</string>`],
    ['notes.md', 'Set <password>hunter2long</password> in settings.xml', `Set <password>${R}</password> in settings.xml`],
    ['page.html', '<input name="password" value="hunter2long">', `<input name="password" value="${R}">`],
    ['notes.md', '<password><password>hunter2long</password></password>', `<password>${R}</password>`],
  ])('%s: %#', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });
});

describe('tokens with a recognizable shape', () => {
  it.each([
    ['Api.kt', 'headers["Authorization"] = "Bearer abcdef1234567890"', `headers["Authorization"] = "Bearer ${R}"`],
    ['Api.kt', 'val k = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"', `val k = "${R}"`],
    ['Api.kt', 'val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"', `val jwt = "${R}"`],
    ['notes.md', 'Authorization: Basic dXNlcjpodW50ZXIybG9uZw==', `Authorization: Basic ${R}`],
    ['Keys.kt', 'val k = "DeadBeefDeadBeefDeadBeefDeadBeef"', `val k = "${R}"`],
    ['Keys.kt', 'val x = "A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1"', `val x = "${R}"`],
    ['Keys.kt', 'val k = "kQ7/wR9/tY2/pZ4/aS6/dF8/gH3/jK5/mN1"', `val k = "${R}"`],
    ['Keys.kt', 'val k = "24BC0zryoDI8W1Kawug6vkoquRcevelgVahnQlxdkXw="', `val k = "${R}"`],
    ['Keys.kt', 'val k = "0d369cbd74c21d2d6b91259708e13e0df1fbaff2"', `val k = "${R}"`],
    ['Fixture.kt', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----',
      `-----BEGIN PRIVATE KEY-----\n${R}\n${R}\n-----END PRIVATE KEY-----`],
    ['key.asc', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFzAbCdEfGh\n-----END PGP PRIVATE KEY BLOCK-----',
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${R}\n-----END PGP PRIVATE KEY BLOCK-----`],
  ])('%s: %#', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
  });

  it('still redacts internal URLs for the model', () => {
    expect(redactSecrets('see https://ci.corp/build/42').text).toBe(`see ${R}`);
  });
});

describe('keeps every line break', () => {
  it.each([
    ['a.py', 'password = """firstSecret123\nsecondSecret456\n"""\nprint("visible")', `password = """${R}\n${R}\n"""\nprint("visible")`],
    ['a.py', 'password = """first\r\nsecond\r\n"""\r\nx = 1\r\n', `password = """${R}\r\n${R}\r\n"""\r\nx = 1\r\n`],
  ])('%s: %#', (file, text, expected) => {
    expect(redact(file, text)).toBe(expected);
    expect(redact(file, text).split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('keyless random secrets in a literal (a heuristic with known misses)', () => {
  // mulberry32: a fixed seed keeps the sample, and so the result, reproducible.
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
  }
  const random = seeded(20261002);
  const bytes = (count: number) => Buffer.from(Array.from({length: count}, () => Math.floor(random() * 256)));
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const pick = (alphabet: string, count: number) =>
    Array.from({length: count}, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  const withheld = (secret: string, file: string, line: (value: string) => string) => {
    const text = line(secret);
    const at = text.indexOf(secret);
    return findCredentialSpans(text, credentialContextForPath(file))
      .some(span => span.start <= at && span.end >= at + secret.length);
  };

  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  it.each([
    ['base64', () => bytes(between(24, 48)).toString('base64'), 3],
    ['base64url', () => bytes(between(24, 48)).toString('base64url'), 6],
    ['alphanumeric', () => pick(ALNUM, between(32, 64)), 3],
    ['hex', () => bytes(between(16, 32)).toString('hex'), 0],
  ] as const)('finds %s secrets in a literal and a config value', (_label, generate, allowedMisses) => {
    const sample = Array.from({length: 1000}, generate);
    expect(sample.filter(secret => !withheld(secret, 'a.kt', value => `val k = "${value}"`)).length)
      .toBeLessThanOrEqual(allowedMisses);
    expect(sample.filter(secret => !withheld(secret, 'a.properties', value => `x=${value}`)).length)
      .toBeLessThanOrEqual(allowedMisses);
  });

  it.each([
    ['a.md', '| 1 | cold | WP62-02131232314454-launch-aosp-heavy-iter1-20260419-234229.ptrace |'],
    ['a.md', 'see Tools/results/android-comprehensive-runs/run-20260425-101445/report.md'],
  ])('keeps names joined from words and numbers: %s %j', (file, text) => {
    expect(redact(file, text)).toBe(text);
  });
});

describe('redacting redacted text again', () => {
  it('changes nothing and counts nothing', () => {
    const once = redactSecrets('val password = "hunter2long"', credentialContextForPath('a.kt'));
    expect(once.redactedCount).toBe(1);
    const twice = redactSecrets(once.text, credentialContextForPath('a.kt'));
    expect(twice).toEqual({text: once.text, redactedCount: 0});
    expect(credentialValues(once.text, credentialContextForPath('a.kt'))).toEqual([]);
  });
});

describe('owner guard', () => {
  it('registers by value what is long enough to withhold wherever it recurs, one value per line', () => {
    expect(credentialValues('password = "short1" and api_key = "longer-secret-9"', credentialContextForPath('a.kt')))
      .toEqual(['longer-secret-9']);
    expect(credentialValues('password =\n"shortSecret123"')).toEqual(['shortSecret123']);
  });

  it('redacts a found credential where it is and a long one wherever it recurs', () => {
    expect(redactCredentialsInText('api_key="hunter2long", later hunter2long; pwd: "ab1"'))
      .toBe(`api_key="${R}", later ${R}; pwd: "${R}"`);
    expect(redactCredentialsInText('password =\n"shortSecret123"')).toBe(`password =\n"${R}"`);
  });

  it('replaces many distinct recurring credentials in one pass', () => {
    const text = Array.from({length: 20000}, (_, index) => {
      const secret = `secret${String(index).padStart(8, '0')}`;
      return `password = "${secret}"\nlater ${secret} again\n`;
    }).join('');
    const started = Date.now();
    const output = redactCredentialsInText(text);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(output).not.toMatch(/secret\d{8}/);
  });

  it.each([
    ['val myServiceAccessToken =', true],
    ['Authorization: Bearer', true],
    ['Authorization: Basic', true],
    ['setPassword(', true],
    ['setPassword(\n', true],
    ['password =\n', true],
    ['password =\n\n', true],
    ['--password', true],
    ['tool --password "abc', true],
    ['password = "abc', true],
    ['password = "first\\"second', true],
    ['password = "first\\\n', true],
    ['password = """', true],
    ['password = """\nabc', true],
    ['password = `abc\n', true],
    ['"password": [\n', true],
    ['token: {see\n', true],
    ['-----BEGIN PRIVATE KEY-----\nMIIE', true],
    ['password = "abc"', false],
    ['password = "abc\n', false],
    ['password = """\nabc\n"""', false],
    ['"password": ["abc"]\n', false],
    ['token: {see below}\n', false],
    ['password: |2-', false],
    ['Set <password>', false],
    ['val name =', false],
    ['hello world', false],
    ['done\n', false],
  ])('holds %j until it is complete: %s', (text, dangling) => {
    expect(endsInDanglingCredentialPrefix(text)).toBe(dangling);
  });

  // The release rule of `OwnerCredentialStream`: a complete line that is not
  // dangling is redacted and released. No split point may release a secret.
  function stream(chunks: readonly string[]): string {
    let pending = '';
    let output = '';
    for (const chunk of chunks) {
      for (const fragment of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        pending += fragment;
        if (fragment.endsWith('\n') && !endsInDanglingCredentialPrefix(pending)) {
          output += redactCredentialsInText(pending);
          pending = '';
        }
      }
    }
    return output + redactCredentialsInText(pending);
  }

  it.each([
    ['password =\n\n"shortSecret123"\nnext line\n', 'shortSecret123'],
    ['setPassword(\n  "shortSecret123")\n', 'shortSecret123'],
    ['password = """\nfirstSecret123\nsecondSecret456\n"""\ndone\n', 'secondSecret456'],
    ['password = `first\\`\n  lastSecret123`\n', 'lastSecret123'],
    ['password = "first\\\nlastSecret123"\n', 'lastSecret123'],
    ['"password": [\n  "firstSecret123",\n  "secondSecret456"\n]\n', 'secondSecret456'],
    ['Authorization: Bearer\n abcdef1234567890ghij\n', 'abcdef1234567890ghij'],
    ['Authorization: Basic\n dXNlcjpodW50ZXIybG9uZw==\n', 'dXNlcjpodW50ZXIybG9uZw=='],
    ['tool --password "hunter2long"\n', 'hunter2long'],
    ['Set <password>hunter2long</password> now\n', 'hunter2long'],
    ['api_key = "hunter2long"\n', 'hunter2long'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'],
  ])('streams %j without releasing the secret at any split', (input, secret) => {
    for (let first = 1; first < input.length; first++) {
      const second = Math.min(input.length - 1, first + 7);
      for (const chunks of [[input.slice(0, first), input.slice(first)],
        [input.slice(0, first), input.slice(first, second), input.slice(second)]]) {
        expect(stream(chunks)).not.toContain(secret);
      }
    }
  });
});

describe('public artifacts keep the broad rules', () => {
  it('still redacts long identifiers and whole assignments there', () => {
    expect(redactSecretsForPublicArtifact('class MediumLoadBetweenFramesGeckoViewActivity').text).toBe(`class ${R}`);
    expect(redactSecretsForPublicArtifact('password=hunter2long').text).toContain(R);
  });
});

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
