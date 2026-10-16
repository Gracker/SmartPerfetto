// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CLI bootstrap: env loading + path layout, in two phases.
 *
 *   1. `prepareCliEnvironment()` runs from `envEntry.ts`, the first import of
 *      `bin.ts`, before any other module of the CLI graph evaluates. It pins
 *      cwd to the package root, loads the env files and publishes the runtime
 *      roots, so module-scope `process.env` reads (config objects, logger
 *      level, metrics directories, ...) see what the user configured. It never
 *      writes to the filesystem (`--help`/`--version` must not create
 *      directories) and never throws: a failure is recorded and surfaced by
 *      `bootstrap()`, i.e. as the command's own error.
 *   2. `bootstrap()` is called by each command before it performs work. It
 *      reuses the prepared environment (preparing it if no entry did, as in
 *      tests), rethrows a recorded failure and creates the directory layout.
 *      Idempotent within a process.
 *
 * Because cwd moves to the package root before any command runs, a path the
 * user typed must be resolved with `resolveInvocationPath()`, never with a
 * bare `path.resolve()`.
 *
 * Notes on process liveness:
 *   We intentionally do NOT import `reportRoutes.ts` anywhere in the CLI
 *   path — that module installs a 30-minute setInterval without `.unref()`,
 *   which would keep the CLI process alive indefinitely after analyze
 *   completes. Instead, CLI writes its HTML report directly to the session
 *   folder via `sessionStore.writeReportHtml`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { computePaths, ensureLayout, resolveHome, type CliPaths } from './io/paths';

export interface CliEnvironmentArgs {
  envFile?: string;
  sessionDir?: string;
}

export interface BootstrapOptions extends CliEnvironmentArgs {
  /** @deprecated Runtime credential checks are command-specific now. */
  requireLlm?: boolean;
}

export interface BootstrapResult {
  paths: CliPaths;
}

/** Env keys `prepareCliEnvironment()` derives; restored by the test reset. */
const DERIVED_ENV_KEYS = [
  'SMARTPERFETTO_PACKAGE_ROOT',
  'SMARTPERFETTO_DISTRIBUTION',
  'SMARTPERFETTO_HOME',
  'SMARTPERFETTO_BACKEND_DATA_DIR',
  'SMARTPERFETTO_BACKEND_LOG_DIR',
  'SMARTPERFETTO_TRACE_UPLOAD_DIR',
] as const;

type PreparedEnvironment = {
  invocationCwd: string;
  derivedEnvBefore: Partial<Record<(typeof DERIVED_ENV_KEYS)[number], string>>;
  envFile?: string;
  sessionDir?: string;
} & ({ error: Error } | LoadedEnvironment);

interface LoadedEnvironment {
  paths: CliPaths;
  layoutEnsured: boolean;
}

let prepared: PreparedEnvironment | null = null;

const ENV_ARG_KEYS = new Map<string, keyof CliEnvironmentArgs>([
  ['--env-file', 'envFile'],
  ['--session-dir', 'sessionDir'],
]);

/**
 * Read `--env-file` / `--session-dir` from raw argv the way commander will:
 * both `--x value` and `--x=value`, the last occurrence wins, the token after
 * the flag is its value even when it starts with `-`, and parsing stops at
 * `--`. A flag without a value is ignored here; commander reports it.
 *
 * This scan does not know which other options take a value, so a token such
 * as `-q --env-file=x` is read as an env flag while commander reads it as the
 * query. `bootstrap()` compares both readings and fails the command rather
 * than run it with an env it did not ask for.
 */
export function readCliEnvironmentArgs(argv: readonly string[]): CliEnvironmentArgs {
  const result: CliEnvironmentArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    const eq = token.indexOf('=');
    const key = ENV_ARG_KEYS.get(eq === -1 ? token : token.slice(0, eq));
    if (!key) continue;
    if (eq !== -1) {
      result[key] = token.slice(eq + 1);
    } else if (i + 1 < argv.length) {
      result[key] = argv[++i];
    }
  }
  return result;
}

/**
 * Side-effect-safe first phase of `bootstrap()`; see the header comment.
 * The first call wins; later calls are no-ops.
 */
export function prepareCliEnvironment(args: CliEnvironmentArgs = {}): void {
  if (prepared) return;
  const invocationCwd = process.cwd();
  // Resolve user-relative paths *before* chdir — otherwise a relative
  // --session-dir or --env-file would reanchor to the backend root.
  const envFile = resolveFrom(invocationCwd, args.envFile);
  const sessionDir = resolveFrom(invocationCwd, args.sessionDir);
  const derivedEnvBefore = Object.fromEntries(DERIVED_ENV_KEYS.map((key) => [key, process.env[key]]));
  prepared = { invocationCwd, derivedEnvBefore, envFile, sessionDir, ...applyEnvironment(envFile, sessionDir) };
}

function applyEnvironment(
  envFile: string | undefined,
  sessionDir: string | undefined,
): { error: Error } | LoadedEnvironment {
  // Backend services resolve their fallback storage paths relative to
  // `process.cwd()`, assuming the process started in `backend/` as the HTTP
  // server does. CLI can be invoked from anywhere, so pin cwd to the backend
  // root before any service module evaluates.
  const backendRoot = findBackendRoot();
  if (backendRoot && process.cwd() !== backendRoot) {
    process.chdir(backendRoot);
  }
  try {
    loadEnv(envFile, sessionDir, backendRoot);
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
  const paths = computePaths(sessionDir);
  if (backendRoot && !process.env.SMARTPERFETTO_PACKAGE_ROOT?.trim()) {
    process.env.SMARTPERFETTO_PACKAGE_ROOT = backendRoot;
  }
  if (!process.env.SMARTPERFETTO_DISTRIBUTION?.trim()) {
    process.env.SMARTPERFETTO_DISTRIBUTION = 'npm';
  }
  // Keep helper services that read SMARTPERFETTO_HOME directly (for example
  // the CLI-managed trace_processor_shell cache) aligned with --session-dir.
  process.env.SMARTPERFETTO_HOME = paths.home;
  if (!process.env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim()) {
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(paths.home, 'runtime', 'data');
  }
  if (!process.env.SMARTPERFETTO_BACKEND_LOG_DIR?.trim()) {
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(paths.home, 'runtime', 'logs');
  }
  // Keep CLI trace copies inside the same user-selected home. The web server
  // does not call this bootstrap path; it derives the trace directory from
  // UPLOAD_DIR (see services/traceUploadPaths).
  if (!process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR?.trim()) {
    process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR = paths.tracesRoot;
  }
  return { paths, layoutEnsured: false };
}

/**
 * Check the prepared environment is the one this command asked for and that
 * it loaded, without touching the filesystem. `bootstrap()` runs this first;
 * commands that need no storage layout (e.g. `probe`) call it directly.
 */
export function assertCliEnvironment(options: CliEnvironmentArgs = {}): void {
  checkedEnvironment(options);
}

function checkedEnvironment(options: CliEnvironmentArgs): LoadedEnvironment {
  prepareCliEnvironment(options);
  const env = prepared!;
  // The entry read these flags from raw argv; the command received them from
  // commander. Running with an env the command did not ask for would be
  // silent misconfiguration, so any disagreement is an error.
  const envFile = resolveFrom(env.invocationCwd, options.envFile);
  const sessionDir = resolveFrom(env.invocationCwd, options.sessionDir);
  if (envFile !== env.envFile || sessionDir !== env.sessionDir) {
    throw new Error(
      'CLI environment was prepared for a different --env-file/--session-dir ' +
      `(prepared ${JSON.stringify({envFile: env.envFile, sessionDir: env.sessionDir})}, ` +
      `requested ${JSON.stringify({envFile, sessionDir})})`,
    );
  }
  if ('error' in env) throw env.error;
  return env;
}

export function bootstrap(options: BootstrapOptions = {}): BootstrapResult {
  const env = checkedEnvironment(options);
  if (!env.layoutEnsured) {
    ensureLayout(env.paths);
    env.layoutEnsured = true;
  }
  return { paths: env.paths };
}

/**
 * @internal
 * Forget the prepared environment and restore the env roots it derived, so
 * the next `bootstrap()` prepares afresh. Tests only: cwd and values loaded
 * from env files are left to the test to restore.
 */
export function resetCliEnvironmentForTesting(): void {
  if (!prepared) return;
  for (const key of DERIVED_ENV_KEYS) {
    const value = prepared.derivedEnvBefore[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  prepared = null;
}

/**
 * Resolve a path the user typed against the directory the CLI was invoked
 * from. cwd itself is the package root once the environment is prepared.
 */
export function resolveInvocationPath(p: string): string {
  return path.resolve(prepared?.invocationCwd ?? process.cwd(), p);
}

function resolveFrom(base: string, p: string | undefined): string | undefined {
  return p ? path.resolve(base, p) : undefined;
}

/**
 * Load env with this precedence (highest first):
 *   1. --env-file argument (explicitly requested, so it overrides inherited env)
 *   2. inherited process environment
 *   3. <resolved CLI home>/env (`--session-dir`, SMARTPERFETTO_HOME, or
 *      ~/.smartperfetto)
 *   4. backend/.env relative to this compiled file
 *
 * Missing files are silently skipped; only an explicitly-passed --env-file
 * is required to exist.
 */
function loadEnv(explicitFile: string | undefined, sessionDir: string | undefined, backendRoot: string | null): void {
  if (explicitFile) {
    const resolved = path.resolve(explicitFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--env-file not found: ${resolved}`);
    }
    // dotenv reports an unreadable file (a directory, no permission) in its
    // result instead of throwing; an explicitly requested file must load.
    const { error } = dotenv.config({ path: resolved, quiet: true, override: true });
    if (error) {
      throw new Error(`--env-file could not be read: ${resolved}: ${error.message}`);
    }
    return;
  }

  // A shell/CI caller may deliberately pin a provider, runtime, or model for
  // one invocation. Default env files must provide fallbacks, never replace
  // that invocation-scoped configuration. Keep the initial key set so the
  // user-level env file can still override the package fallback below.
  const inheritedKeys = new Set(Object.keys(process.env));

  // backend/.env of this module's package root.
  if (backendRoot) {
    const envPath = path.join(backendRoot, '.env');
    loadDefaultEnvFile(envPath, inheritedKeys);
  }

  // Last chance: user-level override. Same home as computePaths(), so
  // `smp --session-dir X config init` creates the file later runs read.
  loadDefaultEnvFile(path.join(resolveHome(sessionDir), 'env'), inheritedKeys);
}

function loadDefaultEnvFile(envPath: string, inheritedKeys: ReadonlySet<string>): void {
  if (!fs.existsSync(envPath)) return;
  const values = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(values)) {
    if (!inheritedKeys.has(key)) process.env[key] = value;
  }
}

/**
 * Walk up from this module's __dirname to find the backend package root
 * (the one containing a SmartPerfetto CLI `package.json` with the `smp` or
 * `smartperfetto` bin entry). Used both to locate `.env` and to pin
 * `process.cwd()` so CWD-relative paths in the service layer resolve to
 * the right `backend/data/` and `backend/logs/` dirs.
 *
 * From `src/cli-user/` or `dist/cli-user/`, the root is 2 levels up. Cap
 * at 4 to leave headroom for monorepo layouts (packages/backend/...) without
 * walking into the user's home or root dir on a misconfigured install.
 */
function findBackendRoot(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (isSmartPerfettoPackage(pkg)) {
          return dir;
        }
      } catch {
        // fall through to parent
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isSmartPerfettoPackage(pkg: any): boolean {
  const hasCliBin = Boolean(pkg?.bin?.smp || pkg?.bin?.smartperfetto);
  return hasCliBin && (
    pkg.name === '@gracker/smartperfetto' ||
    pkg.name === 'smart-perfetto-backend'
  );
}
