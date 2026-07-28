// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {execFile} from 'child_process';
import {randomBytes} from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import {resolveFeatureConfig, resolveServerConfig} from '../../config';
import {isLoopbackRequestHostname} from '../../security/requestOriginPolicy';
import {resolveApplicationBuildIdentity} from '../applicationUpdate/buildIdentity';
import {
  resolveCodebaseScope,
  type CodebaseScope,
} from './codebaseRegistry';

const DIRECTORY_SELECTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_SELECTIONS_PER_SCOPE = 8;
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const PICKER_MAX_BUFFER_BYTES = 64 * 1024;

type DirectoryPickerProvider =
  | 'macos'
  | 'windows'
  | 'windows_wsl'
  | 'zenity'
  | 'kdialog';

export type DirectoryPickerUnavailableReason =
  | 'unsupported_distribution'
  | 'enterprise_mode'
  | 'non_loopback_bind'
  | 'no_graphical_session'
  | 'no_supported_dialog'
  | 'remote_request';

export interface DirectoryPickerCapability {
  available: boolean;
  platform: NodeJS.Platform;
  provider?: DirectoryPickerProvider;
  reason?: DirectoryPickerUnavailableReason;
}

export interface DirectoryPickerSelection {
  selected: true;
  rootPath: string;
  directorySelectionId: string;
  displayNameSuggestion: string;
  expiresAt: number;
}

export interface DirectoryPickerCancelled {
  selected: false;
  cancelled: true;
}

export interface LocalDirectoryPickerRequest {
  hostname: string;
  remoteAddress?: string;
  origin?: string;
}

export interface LocalDirectoryPickerRequestOptions {
  allowMissingOrigin?: boolean;
}

interface PendingDirectorySelection {
  rootRealpath: string;
  scope: Required<CodebaseScope>;
  expiresAt: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface PickerCommand {
  provider: DirectoryPickerProvider;
  executable: string;
  args: string[];
  convertWithWslpath?: string;
}

interface CommandError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  stdout?: string;
  stderr?: string;
}

type CommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface NativeDirectoryPickerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  distribution?: 'source' | 'docker' | 'portable' | 'npm';
  enterprise?: boolean;
  bindHost?: string;
  now?: () => number;
  idGenerator?: () => string;
  findExecutable?: (name: string) => string | undefined;
  runCommand?: CommandRunner;
  resolveDirectory?: (selectedPath: string) => string;
  selectionTtlMs?: number;
  maxPendingSelectionsPerScope?: number;
}

export class NativeDirectoryPickerError extends Error {
  constructor(
    readonly code:
      | 'DIRECTORY_PICKER_UNAVAILABLE'
      | 'DIRECTORY_PICKER_BUSY'
      | 'DIRECTORY_PICKER_FAILED'
      | 'DIRECTORY_PICKER_TIMEOUT'
      | 'DIRECTORY_SELECTION_NOT_FOUND'
      | 'DIRECTORY_SELECTION_EXPIRED'
      | 'DIRECTORY_SELECTION_SCOPE_MISMATCH'
      | 'DIRECTORY_SELECTION_PATH_MISMATCH'
      | 'DIRECTORY_SELECTION_LIMIT_REACHED',
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'NativeDirectoryPickerError';
  }
}

function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathValue = env.PATH ?? '';
  const delimiter = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
  const directories = pathValue.split(delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const hasExtension = platform === 'win32' && path.win32.extname(name).length > 0;
  const candidates = directories.flatMap(directory => (
    platform === 'win32'
      ? (hasExtension ? [path.win32.join(directory, name)] : extensions.map(
          extension => path.win32.join(directory, `${name}${extension}`),
        ))
      : [path.posix.join(directory, name)]
  ));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the remaining PATH entries.
    }
  }
  return undefined;
}

function defaultCommandRunner(
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: PICKER_TIMEOUT_MS,
        maxBuffer: PICKER_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as CommandError;
          enriched.stdout = stdout;
          enriched.stderr = stderr;
          reject(enriched);
          return;
        }
        resolve({stdout, stderr});
      },
    );
  });
}

function defaultDirectoryResolver(selectedPath: string): string {
  const rootRealpath = fs.realpathSync(selectedPath);
  if (!fs.statSync(rootRealpath).isDirectory()) {
    throw new Error('selected_path_is_not_a_directory');
  }
  return rootRealpath;
}

function withoutCommandLineTerminator(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameScope(
  left: Required<CodebaseScope>,
  right: Required<CodebaseScope>,
): boolean {
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.userId === right.userId;
}

function selectionScopeKey(scope: Required<CodebaseScope>): string {
  return [scope.tenantId, scope.workspaceId, scope.userId].join('\0');
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;
  if (net.isIP(ipv4) !== 4) return false;
  return ipv4.split('.')[0] === '127';
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackRequestHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isPickerCancellation(
  provider: DirectoryPickerProvider,
  error: CommandError,
): boolean {
  const stderr = error.stderr ?? '';
  if (stderr.includes('(-128)') || /user cancel/i.test(stderr)) return true;
  if (provider === 'windows' || provider === 'windows_wsl') {
    return error.code === 2;
  }
  if (provider === 'zenity' || provider === 'kdialog') {
    return error.code === 1;
  }
  return false;
}

export function isLocalDirectoryPickerRequest(
  request: LocalDirectoryPickerRequest,
  options: LocalDirectoryPickerRequestOptions = {},
): boolean {
  if (!isLoopbackRequestHostname(request.hostname)) return false;
  if (!isLoopbackAddress(request.remoteAddress)) return false;
  if (!request.origin) return options.allowMissingOrigin === true;
  return isLoopbackOrigin(request.origin);
}

export class NativeDirectoryPicker {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly distribution: 'source' | 'docker' | 'portable' | 'npm';
  private readonly enterprise: boolean;
  private readonly bindHost: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly findExecutable: (name: string) => string | undefined;
  private readonly runCommand: CommandRunner;
  private readonly resolveDirectory: (selectedPath: string) => string;
  private readonly selectionTtlMs: number;
  private readonly maxPendingSelectionsPerScope: number;
  private readonly pendingSelections = new Map<string, PendingDirectorySelection>();
  private pickerBusy = false;

  constructor(options: NativeDirectoryPickerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.distribution = options.distribution ??
      resolveApplicationBuildIdentity(this.env).distribution;
    this.enterprise = options.enterprise ?? resolveFeatureConfig(this.env).enterprise;
    this.bindHost = options.bindHost ?? resolveServerConfig(this.env).bindHost;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? (() => randomBytes(24).toString('base64url'));
    this.findExecutable = options.findExecutable ??
      (name => executableOnPath(name, this.env, this.platform));
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.resolveDirectory = options.resolveDirectory ?? defaultDirectoryResolver;
    this.selectionTtlMs = options.selectionTtlMs ?? DIRECTORY_SELECTION_TTL_MS;
    this.maxPendingSelectionsPerScope = options.maxPendingSelectionsPerScope ??
      MAX_PENDING_SELECTIONS_PER_SCOPE;
  }

  capability(): DirectoryPickerCapability {
    if (this.distribution !== 'source' && this.distribution !== 'portable') {
      return {
        available: false,
        platform: this.platform,
        reason: 'unsupported_distribution',
      };
    }
    if (this.enterprise) {
      return {
        available: false,
        platform: this.platform,
        reason: 'enterprise_mode',
      };
    }
    if (!isLoopbackRequestHostname(this.bindHost)) {
      return {
        available: false,
        platform: this.platform,
        reason: 'non_loopback_bind',
      };
    }
    const command = this.resolvePickerCommand();
    if ('reason' in command) {
      return {
        available: false,
        platform: this.platform,
        reason: command.reason,
      };
    }
    return {
      available: true,
      platform: this.platform,
      provider: command.provider,
    };
  }

  async chooseDirectory(
    scope: CodebaseScope,
  ): Promise<DirectoryPickerSelection | DirectoryPickerCancelled> {
    const command = this.resolvePickerCommand();
    const capability = this.capability();
    if (!capability.available || 'reason' in command) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_PICKER_UNAVAILABLE',
        capability.reason ?? 'no_supported_dialog',
        409,
      );
    }
    this.assertSelectionCapacity(scope);
    if (this.pickerBusy) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_PICKER_BUSY',
        'A directory picker is already open',
        409,
      );
    }
    this.pickerBusy = true;
    try {
      const selectedPath = await this.runPickerCommand(command);
      if (selectedPath === null) return {selected: false, cancelled: true};
      let rootRealpath: string;
      try {
        rootRealpath = this.resolveDirectory(selectedPath);
      } catch {
        throw new NativeDirectoryPickerError(
          'DIRECTORY_PICKER_FAILED',
          'The selected directory is no longer accessible',
          400,
        );
      }
      return this.issueSelection(rootRealpath, scope);
    } finally {
      this.pickerBusy = false;
    }
  }

  validateSelection(
    selectionId: string,
    rootPath: string,
    scope: CodebaseScope,
  ): string {
    return this.resolveSelection(selectionId, rootPath, scope);
  }

  runWithSelection<T>(
    selectionId: string,
    rootPath: string,
    scope: CodebaseScope,
    operation: (rootRealpath: string) => T,
  ): T {
    const rootRealpath = this.resolveSelection(
      selectionId,
      rootPath,
      scope,
    );
    const selection = this.pendingSelections.get(selectionId);
    if (!selection) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_NOT_FOUND',
        'Directory selection was not found',
        400,
      );
    }
    this.pendingSelections.delete(selectionId);
    try {
      return operation(rootRealpath);
    } catch (error) {
      if (
        selection.expiresAt > this.now() &&
        !this.pendingSelections.has(selectionId)
      ) {
        this.pendingSelections.set(selectionId, selection);
      }
      throw error;
    }
  }

  private resolvePickerCommand():
    | PickerCommand
    | {reason: Extract<DirectoryPickerUnavailableReason, 'no_graphical_session' | 'no_supported_dialog'>} {
    if (this.platform === 'darwin') {
      const executable = fs.existsSync('/usr/bin/osascript')
        ? '/usr/bin/osascript'
        : this.findExecutable('osascript');
      return executable
        ? {
            provider: 'macos',
            executable,
            args: [
              '-e',
              'POSIX path of (choose folder with prompt "Choose a source code folder")',
            ],
          }
        : {reason: 'no_supported_dialog'};
    }

    if (this.platform === 'win32') {
      const systemRoot = this.env.SystemRoot || this.env.SYSTEMROOT;
      const systemPowerShell = systemRoot
        ? path.win32.join(
            systemRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : undefined;
      const executable = systemPowerShell && fs.existsSync(systemPowerShell)
        ? systemPowerShell
        : this.findExecutable('powershell.exe') ?? this.findExecutable('pwsh.exe');
      return executable
        ? this.windowsPickerCommand(executable, 'windows')
        : {reason: 'no_supported_dialog'};
    }

    if (this.platform === 'linux') {
      const isWsl = Boolean(this.env.WSL_DISTRO_NAME || this.env.WSL_INTEROP);
      if (isWsl) {
        const powershell = this.findExecutable('powershell.exe');
        const wslpath = this.findExecutable('wslpath');
        if (powershell && wslpath) {
          return {
            ...this.windowsPickerCommand(powershell, 'windows_wsl'),
            convertWithWslpath: wslpath,
          };
        }
      }
      if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) {
        return {reason: 'no_graphical_session'};
      }
      const zenity = this.findExecutable('zenity');
      if (zenity) {
        return {
          provider: 'zenity',
          executable: zenity,
          args: [
            '--file-selection',
            '--directory',
            '--title=Choose a source code folder',
          ],
        };
      }
      const kdialog = this.findExecutable('kdialog');
      if (kdialog) {
        return {
          provider: 'kdialog',
          executable: kdialog,
          args: ['--getexistingdirectory', '.', '--title', 'Choose a source code folder'],
        };
      }
      return {reason: 'no_supported_dialog'};
    }

    return {reason: 'no_supported_dialog'};
  }

  private windowsPickerCommand(
    executable: string,
    provider: 'windows' | 'windows_wsl',
  ): PickerCommand {
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choose a source code folder"',
      '$dialog.ShowNewFolderButton = $false',
      'try {',
      '  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '    [Console]::Out.WriteLine($dialog.SelectedPath)',
      '    exit 0',
      '  }',
      '  exit 2',
      '} finally {',
      '  $dialog.Dispose()',
      '}',
    ].join('; ');
    return {
      provider,
      executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    };
  }

  private async runPickerCommand(command: PickerCommand): Promise<string | null> {
    try {
      const result = await this.runCommand(command.executable, command.args);
      let selectedPath = withoutCommandLineTerminator(result.stdout);
      if (!selectedPath) return null;
      if (command.convertWithWslpath) {
        const converted = await this.runCommand(
          command.convertWithWslpath,
          ['-u', selectedPath],
        );
        selectedPath = withoutCommandLineTerminator(converted.stdout);
      }
      return selectedPath || null;
    } catch (error) {
      const commandError = error as CommandError;
      if (commandError.killed || commandError.signal === 'SIGTERM') {
        throw new NativeDirectoryPickerError(
          'DIRECTORY_PICKER_TIMEOUT',
          'Directory picker timed out',
          408,
        );
      }
      if (isPickerCancellation(command.provider, commandError)) return null;
      throw new NativeDirectoryPickerError(
        'DIRECTORY_PICKER_FAILED',
        'Unable to open the system directory picker',
        500,
      );
    }
  }

  private issueSelection(
    rootRealpath: string,
    scopeInput: CodebaseScope,
  ): DirectoryPickerSelection {
    this.assertSelectionCapacity(scopeInput);
    const scope = resolveCodebaseScope(scopeInput);
    const expiresAt = this.now() + this.selectionTtlMs;
    const directorySelectionId = this.idGenerator();
    this.pendingSelections.set(directorySelectionId, {
      rootRealpath,
      scope,
      expiresAt,
    });
    return {
      selected: true,
      rootPath: rootRealpath,
      directorySelectionId,
      displayNameSuggestion: path.basename(rootRealpath),
      expiresAt,
    };
  }

  private assertSelectionCapacity(scopeInput: CodebaseScope): void {
    this.cleanupExpiredSelections();
    const scope = resolveCodebaseScope(scopeInput);
    const scopeKey = selectionScopeKey(scope);
    const pendingForScope = Array.from(this.pendingSelections.values())
      .filter(selection => selectionScopeKey(selection.scope) === scopeKey)
      .length;
    if (pendingForScope >= this.maxPendingSelectionsPerScope) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_LIMIT_REACHED',
        'Too many pending directory selections',
        429,
      );
    }
  }

  private resolveSelection(
    selectionId: string,
    rootPath: string,
    scopeInput: CodebaseScope,
  ): string {
    const selection = this.pendingSelections.get(selectionId);
    if (!selection) {
      this.cleanupExpiredSelections();
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_NOT_FOUND',
        'Directory selection was not found',
        400,
      );
    }
    if (selection.expiresAt <= this.now()) {
      this.pendingSelections.delete(selectionId);
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_EXPIRED',
        'Directory selection expired',
        400,
      );
    }
    const scope = resolveCodebaseScope(scopeInput);
    if (!sameScope(selection.scope, scope)) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_SCOPE_MISMATCH',
        'Directory selection belongs to a different workspace or user',
        403,
      );
    }
    let requestedRealpath: string;
    try {
      requestedRealpath = this.resolveDirectory(rootPath);
    } catch {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_PATH_MISMATCH',
        'Selected directory no longer matches the requested path',
        400,
      );
    }
    if (!samePath(selection.rootRealpath, requestedRealpath, this.platform)) {
      throw new NativeDirectoryPickerError(
        'DIRECTORY_SELECTION_PATH_MISMATCH',
        'Selected directory does not match the requested path',
        400,
      );
    }
    return selection.rootRealpath;
  }

  private cleanupExpiredSelections(): void {
    const now = this.now();
    for (const [selectionId, selection] of this.pendingSelections) {
      if (selection.expiresAt <= now) {
        this.pendingSelections.delete(selectionId);
      }
    }
  }
}
