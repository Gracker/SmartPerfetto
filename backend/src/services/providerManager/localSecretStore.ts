// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {resolveAuthConfig} from '../../config';
import {deriveServerSecret} from '../../security/serverSecret';
import {withFilesystemRegistryLock} from '../filesystemRegistryLock';
import {providerDataPath} from './providerPaths';

const sodium = require('sodium-native') as {
  crypto_secretbox_easy: (ciphertext: Buffer, message: Buffer, nonce: Buffer, key: Buffer) => void;
  crypto_secretbox_open_easy: (message: Buffer, ciphertext: Buffer, nonce: Buffer, key: Buffer) => boolean;
  crypto_secretbox_KEYBYTES: number;
  crypto_secretbox_NONCEBYTES: number;
  crypto_secretbox_MACBYTES: number;
  randombytes_buf: (buffer: Buffer) => void;
};

export const SECRET_STORE_DIR_ENV = 'SMARTPERFETTO_SECRET_STORE_DIR';
export const SECRET_STORE_MASTER_KEY_ENV = 'SMARTPERFETTO_SECRET_STORE_MASTER_KEY';
export const SECRET_STORE_KEYRING_SERVICE_ENV = 'SMARTPERFETTO_SECRET_STORE_KEYRING_SERVICE';
export const SECRET_STORE_KEYRING_ACCOUNT_ENV = 'SMARTPERFETTO_SECRET_STORE_KEYRING_ACCOUNT';
export const SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV = 'SMARTPERFETTO_SECRET_STORE_ALLOW_LOCAL_MASTER_KEY';

type SecretAlgorithm = 'libsodium-secretbox';
type MasterKeySource =
  | 'env'
  | 'server-secret'
  | 'keyring'
  | 'windows-dpapi'
  | 'local-dev-file';

const WINDOWS_DPAPI_MASTER_KEY_FILE = '.master-key.dpapi';
const SECRET_STORE_STATE_FILES = [
  'provider-secrets.enc.json',
  '.master-key',
  WINDOWS_DPAPI_MASTER_KEY_FILE,
] as const;
const WINDOWS_DPAPI_TIMEOUT_MS = 10_000;
const WINDOWS_DPAPI_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_DPAPI_PROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');
const WINDOWS_DPAPI_UNPROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$raw = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');

interface EncryptedSecretEntry {
  version: number;
  algorithm: SecretAlgorithm;
  nonce: string;
  ciphertext: string;
  updatedAt: number;
}

interface EncryptedSecretFile {
  version: 2;
  entries: Record<string, EncryptedSecretEntry>;
}

interface LegacyEncryptedSecretEntry {
  version: number;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: number;
}

interface LegacyEncryptedSecretFile {
  version: 1;
  entries: Record<string, LegacyEncryptedSecretEntry>;
}

export interface SecretStoreInfo {
  filePath: string;
  masterKeySource: MasterKeySource;
  algorithm: SecretAlgorithm;
}

function resolveSecretStoreDir(): string {
  const configured = process.env[SECRET_STORE_DIR_ENV];
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const providerDir = path.resolve(providerDataPath('secrets'));
  const legacyDir = path.resolve(process.cwd(), 'data', 'secrets');
  if (
    providerDir !== legacyDir
    && !hasSecretStoreState(providerDir)
    && hasSecretStoreState(legacyDir)
  ) {
    return legacyDir;
  }
  return providerDir;
}

function hasSecretStoreState(dir: string): boolean {
  return SECRET_STORE_STATE_FILES.some(file => fs.existsSync(path.join(dir, file)));
}

function decodeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === sodium.crypto_secretbox_KEYBYTES) return decoded;
  } catch {
    // Fall through to passphrase hashing.
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function encodeMasterKey(key: Buffer): string {
  return key.toString('base64');
}

function randomMasterKey(): Buffer {
  const key = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
  sodium.randombytes_buf(key);
  return key;
}

function randomNonce(): Buffer {
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
  sodium.randombytes_buf(nonce);
  return nonce;
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot
    || process.env.SYSTEMROOT
    || process.env.WINDIR
    || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) {
    throw new Error(`Windows SystemRoot is not absolute: ${systemRoot}`);
  }
  return path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function invokeWindowsDpapi(
  operation: 'protect' | 'unprotect',
  input: Buffer,
): Buffer {
  const script = operation === 'protect'
    ? WINDOWS_DPAPI_PROTECT_SCRIPT
    : WINDOWS_DPAPI_UNPROTECT_SCRIPT;
  let output: string;
  try {
    output = execFileSync(windowsPowerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      encoding: 'utf-8',
      input: input.toString('base64'),
      maxBuffer: WINDOWS_DPAPI_OUTPUT_LIMIT_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WINDOWS_DPAPI_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new Error(
      `Windows DPAPI ${operation} failed through Windows PowerShell: ${(error as Error).message}`,
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
    throw new Error(`Windows DPAPI ${operation} returned invalid base64 output`);
  }
  const decoded = Buffer.from(output, 'base64');
  if (decoded.length === 0) {
    throw new Error(`Windows DPAPI ${operation} returned empty output`);
  }
  return decoded;
}

function windowsDpapiMasterKeyPath(dir: string): string {
  return path.join(dir, WINDOWS_DPAPI_MASTER_KEY_FILE);
}

function readWindowsDpapiMasterKey(dir: string): Buffer | null {
  const keyPath = windowsDpapiMasterKeyPath(dir);
  if (!fs.existsSync(keyPath)) return null;
  const protectedKey = fs.readFileSync(keyPath, 'utf-8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(protectedKey)) {
    throw new Error(`Windows DPAPI master key file is invalid: ${keyPath}`);
  }
  const key = invokeWindowsDpapi('unprotect', Buffer.from(protectedKey, 'base64'));
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(`Windows DPAPI master key has invalid length: ${keyPath}`);
  }
  return key;
}

function writeWindowsDpapiMasterKey(
  dir: string,
  key: Buffer,
): {key: Buffer; created: boolean} {
  const keyPath = windowsDpapiMasterKeyPath(dir);
  const protectedKey = invokeWindowsDpapi('protect', key).toString('base64');
  fs.mkdirSync(dir, {recursive: true});
  try {
    fs.writeFileSync(keyPath, `${protectedKey}\n`, {mode: 0o600, flag: 'wx'});
    try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
    return {key, created: true};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrentlyCreated = readWindowsDpapiMasterKey(dir);
    if (!concurrentlyCreated) throw error;
    return {key: concurrentlyCreated, created: false};
  }
}

function removeLegacyLocalMasterKey(dir: string): void {
  const keyPath = path.join(dir, '.master-key');
  if (!fs.existsSync(keyPath)) return;
  fs.unlinkSync(keyPath);
}

function keysEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function keyringService(): string {
  return process.env[SECRET_STORE_KEYRING_SERVICE_ENV]?.trim() || 'SmartPerfetto SecretStore';
}

function keyringAccount(): string {
  return process.env[SECRET_STORE_KEYRING_ACCOUNT_ENV]?.trim() || 'provider-master-key';
}

function readMacosKeyring(service: string, account: string): string | null {
  try {
    return execFileSync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function writeMacosKeyring(service: string, account: string, secret: string): void {
  execFileSync('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    account,
    '-w',
    secret,
  ], {stdio: 'ignore'});
}

function readLinuxKeyring(service: string, account: string): string | null {
  try {
    return execFileSync('secret-tool', [
      'lookup',
      'service',
      service,
      'account',
      account,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function writeLinuxKeyring(service: string, account: string, secret: string): void {
  execFileSync('secret-tool', [
    'store',
    '--label',
    service,
    'service',
    service,
    'account',
    account,
  ], {
    input: secret,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function readKeyringSecret(): string | null {
  const service = keyringService();
  const account = keyringAccount();
  if (process.platform === 'darwin') return readMacosKeyring(service, account);
  if (process.platform === 'linux') return readLinuxKeyring(service, account);
  return null;
}

function writeKeyringSecret(secret: string): void {
  const service = keyringService();
  const account = keyringAccount();
  if (process.platform === 'darwin') {
    writeMacosKeyring(service, account, secret);
    return;
  }
  if (process.platform === 'linux') {
    writeLinuxKeyring(service, account, secret);
    return;
  }
  throw new Error(`OS keyring is not supported on platform ${process.platform}`);
}

function readLegacyLocalMasterKey(dir: string): Buffer | null {
  const keyPath = path.join(dir, '.master-key');
  if (!fs.existsSync(keyPath)) return null;
  return decodeMasterKey(fs.readFileSync(keyPath, 'utf-8'));
}

function readOrCreateLocalDevMasterKey(dir: string): Buffer {
  const existing = readLegacyLocalMasterKey(dir);
  if (existing) return existing;
  const key = randomMasterKey();
  const keyPath = path.join(dir, '.master-key');
  fs.mkdirSync(dir, {recursive: true});
  try {
    fs.writeFileSync(keyPath, encodeMasterKey(key), {mode: 0o600, flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrentlyCreated = readLegacyLocalMasterKey(dir);
    if (!concurrentlyCreated) throw error;
    return concurrentlyCreated;
  }
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
  return key;
}

function localMasterKeyFallbackAllowed(): boolean {
  const configured = process.env[SECRET_STORE_ALLOW_LOCAL_MASTER_KEY_ENV];
  if (!configured) return process.env.NODE_ENV === 'test';
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(configured.trim().toLowerCase());
}

function resolveMasterKey(dir: string): {key: Buffer; source: MasterKeySource} {
  const configured = process.env[SECRET_STORE_MASTER_KEY_ENV];
  if (configured && configured.trim().length > 0) {
    return {key: decodeMasterKey(configured), source: 'env'};
  }

  const keyringSecret = readKeyringSecret();
  if (keyringSecret) {
    return {key: decodeMasterKey(keyringSecret), source: 'keyring'};
  }

  if (process.platform === 'win32') {
    const protectedKey = readWindowsDpapiMasterKey(dir);
    if (protectedKey) {
      const legacyKey = readLegacyLocalMasterKey(dir);
      if (legacyKey) {
        if (!keysEqual(protectedKey, legacyKey)) {
          throw new Error(
            `Windows DPAPI and legacy SecretStore master keys disagree in ${dir}; refusing to choose one.`,
          );
        }
        removeLegacyLocalMasterKey(dir);
      }
      return {key: protectedKey, source: 'windows-dpapi'};
    }
  }

  const legacyLocalKey = readLegacyLocalMasterKey(dir);
  if (legacyLocalKey) {
    if (process.platform === 'win32') {
      const persisted = writeWindowsDpapiMasterKey(dir, legacyLocalKey);
      if (!keysEqual(persisted.key, legacyLocalKey)) {
        if (persisted.created) {
          fs.rmSync(windowsDpapiMasterKeyPath(dir), {force: true});
        }
        throw new Error(
          `Windows DPAPI SecretStore master key conflicts with ${path.join(dir, '.master-key')}`,
        );
      }
      try {
        removeLegacyLocalMasterKey(dir);
      } catch (error) {
        if (persisted.created) {
          fs.rmSync(windowsDpapiMasterKeyPath(dir), {force: true});
        }
        throw new Error(
          `Windows DPAPI protected the SecretStore master key but could not remove legacy plaintext ${path.join(dir, '.master-key')}: ${(error as Error).message}`,
        );
      }
      return {key: persisted.key, source: 'windows-dpapi'};
    }
    try {
      writeKeyringSecret(encodeMasterKey(legacyLocalKey));
      return {key: legacyLocalKey, source: 'keyring'};
    } catch {
      if (localMasterKeyFallbackAllowed()) {
        return {key: legacyLocalKey, source: 'local-dev-file'};
      }
      throw new Error(
        `SecretStore master key exists only in local file ${path.join(dir, '.master-key')}; OS keyring is unavailable. Set ${SECRET_STORE_MASTER_KEY_ENV} for tests/dev or configure OS keyring.`,
      );
    }
  }

  if (resolveAuthConfig(process.env).oidcEnabled) {
    return {
      key: deriveServerSecret({
        purpose: 'provider-secret-store',
        minimumBytes: 32,
      }),
      source: 'server-secret',
    };
  }

  const newKey = randomMasterKey();
  if (process.platform === 'win32') {
    try {
      const persisted = writeWindowsDpapiMasterKey(dir, newKey);
      return {key: persisted.key, source: 'windows-dpapi'};
    } catch (error) {
      throw new Error(
        `Windows DPAPI is unavailable for the SecretStore master key. Set ${SECRET_STORE_MASTER_KEY_ENV} for tests/dev or restore Windows PowerShell/DPAPI access. ${(error as Error).message}`,
      );
    }
  }
  try {
    writeKeyringSecret(encodeMasterKey(newKey));
    return {key: newKey, source: 'keyring'};
  } catch {
    if (localMasterKeyFallbackAllowed()) {
      return {key: readOrCreateLocalDevMasterKey(dir), source: 'local-dev-file'};
    }
    throw new Error(
      `OS keyring is unavailable for SecretStore master key. Set ${SECRET_STORE_MASTER_KEY_ENV} for tests/dev or install/configure an OS keyring provider.`,
    );
  }
}

function emptySecretFile(): EncryptedSecretFile {
  return {version: 2, entries: {}};
}

function normalizeSecretObject(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export class LocalEncryptedSecretStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly masterKeySource: MasterKeySource;

  constructor(dir: string = resolveSecretStoreDir()) {
    this.dir = dir;
    this.filePath = path.join(dir, 'provider-secrets.enc.json');
    const resolved = resolveMasterKey(dir);
    this.key = resolved.key;
    this.masterKeySource = resolved.source;
  }

  info(): SecretStoreInfo {
    return {
      filePath: this.filePath,
      masterKeySource: this.masterKeySource,
      algorithm: 'libsodium-secretbox',
    };
  }

  get(ref: string): Record<string, string> {
    const file = this.readFile();
    const entry = file.entries[ref];
    if (!entry) return {};
    return this.decryptEntry(entry);
  }

  private decryptEntry(entry: EncryptedSecretEntry): Record<string, string> {
    try {
      const ciphertext = Buffer.from(entry.ciphertext, 'base64');
      if (ciphertext.length < sodium.crypto_secretbox_MACBYTES) {
        throw new Error('ciphertext too short');
      }
      const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);
      const ok = sodium.crypto_secretbox_open_easy(
        plaintext,
        ciphertext,
        Buffer.from(entry.nonce, 'base64'),
        this.key,
      );
      if (!ok) throw new Error('secretbox authentication failed');
      const parsed = JSON.parse(plaintext.toString('utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, string>
        : {};
    } catch (err) {
      console.warn('[LocalSecretStore] Failed to decrypt secret:', (err as Error).message);
      return {};
    }
  }

  put(ref: string, value: Record<string, string>): number {
    return this.writeEncrypted(ref, value);
  }

  rotate(ref: string, value?: Record<string, string>): number {
    return withFilesystemRegistryLock(this.filePath, 'secret_store_busy', () => {
      const file = this.readFileUnlocked(true);
      const current = file.entries[ref];
      const next = value ?? (current ? this.decryptEntry(current) : {});
      return this.writeEncryptedUnlocked(file, ref, next);
    });
  }

  getVersion(ref: string): number | undefined {
    return this.readFile().entries[ref]?.version;
  }

  delete(ref: string): boolean {
    return withFilesystemRegistryLock(this.filePath, 'secret_store_busy', () => {
      const file = this.readFileUnlocked(true);
      const existed = Object.prototype.hasOwnProperty.call(file.entries, ref);
      if (!existed) return false;
      delete file.entries[ref];
      this.writeFile(file);
      return true;
    });
  }

  private writeEncrypted(ref: string, value: Record<string, string>): number {
    return withFilesystemRegistryLock(this.filePath, 'secret_store_busy', () =>
      this.writeEncryptedUnlocked(this.readFileUnlocked(true), ref, value));
  }

  private writeEncryptedUnlocked(
    file: EncryptedSecretFile,
    ref: string,
    value: Record<string, string>,
  ): number {
    const previous = file.entries[ref];
    const version = (previous?.version ?? 0) + 1;
    file.entries[ref] = this.encryptEntry(
      Buffer.from(JSON.stringify(normalizeSecretObject(value)), 'utf-8'),
      version,
      Date.now(),
    );
    this.writeFile(file);
    return version;
  }

  private readFile(): EncryptedSecretFile {
    return withFilesystemRegistryLock(
      this.filePath,
      'secret_store_busy',
      () => this.readFileUnlocked(true),
    );
  }

  private readFileUnlocked(persistMigration: boolean): EncryptedSecretFile {
    if (!fs.existsSync(this.filePath)) return emptySecretFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (parsed && parsed.version === 2 && parsed.entries && typeof parsed.entries === 'object') {
        return parsed as EncryptedSecretFile;
      }
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        const migrated = this.migrateLegacyFile(parsed as LegacyEncryptedSecretFile);
        if (persistMigration) this.writeFile(migrated);
        return migrated;
      }
      throw new Error('unsupported secret store schema');
    } catch (error) {
      throw new Error(
        `secret_store_invalid_storage_requires_recovery:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private encryptEntry(
    plaintext: Buffer,
    version: number,
    updatedAt: number,
  ): EncryptedSecretEntry {
    const nonce = randomNonce();
    const ciphertext = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES);
    sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, this.key);
    return {
      version,
      algorithm: 'libsodium-secretbox',
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updatedAt,
    };
  }

  private migrateLegacyFile(file: LegacyEncryptedSecretFile): EncryptedSecretFile {
    const migrated = emptySecretFile();
    for (const [ref, entry] of Object.entries(file.entries)) {
      try {
        const decipher = crypto.createDecipheriv(
          entry.algorithm,
          this.key,
          Buffer.from(entry.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(entry.ciphertext, 'base64')),
          decipher.final(),
        ]);
        migrated.entries[ref] = this.encryptEntry(
          plaintext,
          entry.version,
          entry.updatedAt,
        );
      } catch (err) {
        throw new Error(`Failed to migrate legacy AES secret '${ref}': ${(err as Error).message}`);
      }
    }
    return migrated;
  }

  private writeFile(file: EncryptedSecretFile): void {
    fs.mkdirSync(this.dir, {recursive: true});
    const tmp = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), {mode: 0o600, flag: 'wx'});
      fs.renameSync(tmp, this.filePath);
    } finally {
      try { fs.rmSync(tmp, {force: true}); } catch { /* best effort */ }
    }
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows */ }
  }
}
