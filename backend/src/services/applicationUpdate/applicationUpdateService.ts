// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import semver from 'semver';
import {atomicWriteFile} from '../../utils/atomicFileWriter';
import {
  applicationUpdateCacheKey,
} from './buildIdentity';
import {
  ApplicationUpdateSourceError,
  dockerTagPage,
  fetchApplicationUpdateCandidate,
  type ApplicationUpdateFetch,
} from './releaseSources';
import type {
  ApplicationBuildIdentity,
  ApplicationUpdateCacheRecord,
  ApplicationUpdateCandidate,
  ApplicationUpdateError,
  ApplicationUpdateStatus,
  ApplicationUpgradeAction,
} from './types';

const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MINIMUM_MANUAL_REFRESH_MS = 30_000;
const LOCK_STALE_MS = 2 * 60 * 1_000;
const FULL_GIT_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ApplicationUpdateServiceOptions {
  fetch?: ApplicationUpdateFetch;
  now?: () => Date;
  cacheRoot?: string;
  freshMs?: number;
  timeoutMs?: number;
  minimumManualRefreshMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ApplicationUpdateCheckOptions {
  force?: boolean;
}

interface CacheLock {
  acquired: boolean;
  release(): Promise<void>;
}

function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.SMARTPERFETTO_UPDATE_CHECK?.trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

function defaultCacheRoot(env: NodeJS.ProcessEnv): string {
  const backendData = env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim();
  if (backendData) return path.join(path.resolve(backendData), 'application-update');
  const home = env.SMARTPERFETTO_HOME?.trim();
  if (home) return path.join(path.resolve(home), 'application-update');
  return path.join(os.homedir(), '.smartperfetto', 'application-update');
}

function cacheTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function validCandidate(
  value: unknown,
): ApplicationUpdateCandidate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ApplicationUpdateCandidate>;
  if (
    candidate.source !== 'github-releases' &&
    candidate.source !== 'github-main' &&
    candidate.source !== 'npm-registry'
  ) {
    return undefined;
  }
  const version =
    typeof candidate.version === 'string'
      ? semver.valid(candidate.version)
      : null;
  if (!version || semver.prerelease(version)) return undefined;
  const commit =
    typeof candidate.commit === 'string' && FULL_GIT_COMMIT.test(candidate.commit)
      ? candidate.commit
      : undefined;
  const expectedReleaseUrl =
    candidate.source === 'npm-registry'
      ? `https://www.npmjs.com/package/@gracker/smartperfetto/v/${version}`
      : candidate.source === 'github-main' && commit
        ? `https://github.com/Gracker/SmartPerfetto/commit/${commit}`
        : `https://github.com/Gracker/SmartPerfetto/releases/tag/v${version}`;
  if (candidate.releaseUrl !== expectedReleaseUrl) {
    return undefined;
  }
  const publishedAt = cacheTimestamp(candidate.publishedAt);

  let asset: ApplicationUpdateCandidate['asset'];
  if (candidate.asset !== undefined) {
    if (
      !candidate.asset ||
      typeof candidate.asset.name !== 'string' ||
      typeof candidate.asset.url !== 'string' ||
      candidate.asset.url !==
        `https://github.com/Gracker/SmartPerfetto/releases/download/v${version}/${candidate.asset.name}` ||
      candidate.asset.name.includes('/') ||
      candidate.asset.name.includes('\\')
    ) {
      return undefined;
    }
    const sha256 =
      typeof candidate.asset.sha256 === 'string' &&
      SHA256.test(candidate.asset.sha256)
        ? candidate.asset.sha256
        : undefined;
    asset = {
      name: candidate.asset.name,
      url: candidate.asset.url,
      ...(sha256 ? {sha256} : {}),
    };
  }
  return {
    source: candidate.source,
    version,
    ...(commit ? {commit} : {}),
    ...(publishedAt ? {publishedAt} : {}),
    releaseUrl: candidate.releaseUrl,
    ...(asset ? {asset} : {}),
  };
}

function validError(value: unknown): ApplicationUpdateError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = value as Partial<ApplicationUpdateError>;
  const codes = new Set<ApplicationUpdateError['code']>([
    'network_error',
    'timeout',
    'rate_limited',
    'invalid_response',
    'response_too_large',
    'cache_error',
  ]);
  const at = cacheTimestamp(error.at);
  if (
    !error.code ||
    !codes.has(error.code) ||
    typeof error.message !== 'string' ||
    error.message.length > 320 ||
    !at
  ) {
    return undefined;
  }
  return {code: error.code, message: error.message, at};
}

function validCacheRecord(
  value: unknown,
  expectedKey: string,
): ApplicationUpdateCacheRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<ApplicationUpdateCacheRecord>;
  const checkedAt = cacheTimestamp(record.checkedAt);
  const candidate = validCandidate(record.candidate);
  if (
    record.schemaVersion !== 1 ||
    record.key !== expectedKey ||
    !checkedAt ||
    !candidate
  ) {
    return undefined;
  }
  const lastError = validError(record.lastError);
  return {
    schemaVersion: 1,
    key: expectedKey,
    checkedAt,
    ...(typeof record.etag === 'string' && record.etag.length <= 512
      ? {etag: record.etag}
      : {}),
    candidate,
    ...(lastError ? {lastError} : {}),
  };
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n]/g, ' ').slice(0, 320);
}

function updateError(
  error: unknown,
  at: string,
): ApplicationUpdateError {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return {code: 'timeout', message: 'Application update check timed out', at};
  }
  if (error instanceof ApplicationUpdateSourceError) {
    return {code: error.code, message: safeErrorMessage(error), at};
  }
  return {
    code: 'network_error',
    message: safeErrorMessage(error),
    at,
  };
}

function releaseAction(
  identity: ApplicationBuildIdentity,
  candidate: ApplicationUpdateCandidate,
): ApplicationUpgradeAction {
  switch (identity.distribution) {
    case 'npm':
      return {
        kind: 'npm',
        command: 'npm install -g @gracker/smartperfetto@latest',
        url: candidate.releaseUrl,
      };
    case 'docker': {
      const imageTag =
        identity.channel === 'nightly' ? 'nightly' : candidate.version;
      return {
        kind: 'docker',
        imageTag,
        command:
          `SMARTPERFETTO_DOCKER_TAG=${imageTag} docker compose -f docker-compose.hub.yml pull smartperfetto && ` +
          `SMARTPERFETTO_DOCKER_TAG=${imageTag} docker compose -f docker-compose.hub.yml up -d smartperfetto`,
        url: dockerTagPage(imageTag),
      };
    }
    case 'portable':
      return {
        kind: 'portable',
        url: candidate.asset?.url ?? candidate.releaseUrl,
        ...(candidate.asset?.sha256
          ? {sha256: candidate.asset.sha256}
          : {}),
      };
    case 'source':
      return {
        kind: 'source',
        command: 'git fetch --tags origin',
        url: candidate.releaseUrl,
      };
  }
}

function unsupportedNightly(
  identity: ApplicationBuildIdentity,
): boolean {
  return (
    identity.channel === 'nightly' &&
    (
      (identity.distribution !== 'docker' &&
        identity.distribution !== 'source') ||
      !identity.commit ||
      !FULL_GIT_COMMIT.test(identity.commit)
    )
  );
}

export class ApplicationUpdateService {
  private readonly fetch: ApplicationUpdateFetch;
  private readonly now: () => Date;
  private readonly cacheRoot: string;
  private readonly freshMs: number;
  private readonly timeoutMs: number;
  private readonly minimumManualRefreshMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly inFlight = new Map<
    string,
    Promise<ApplicationUpdateStatus>
  >();

  constructor(options: ApplicationUpdateServiceOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.cacheRoot = options.cacheRoot ?? defaultCacheRoot(this.env);
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minimumManualRefreshMs =
      options.minimumManualRefreshMs ?? DEFAULT_MINIMUM_MANUAL_REFRESH_MS;
  }

  getStatus(identity: ApplicationBuildIdentity): ApplicationUpdateStatus {
    if (updateCheckDisabled(this.env)) {
      return this.baseStatus(identity, 'disabled');
    }
    if (unsupportedNightly(identity)) {
      return this.baseStatus(identity, 'unsupported_channel');
    }
    const cache = this.readCache(identity);
    if (cache && this.cacheAge(cache) <= this.freshMs) {
      return this.statusFromCandidate(identity, cache, false);
    }
    void this.checkNow(identity).catch(() => undefined);
    return cache
      ? this.statusFromCandidate(identity, cache, true)
      : this.baseStatus(identity, 'checking');
  }

  checkNow(
    identity: ApplicationBuildIdentity,
    options: ApplicationUpdateCheckOptions = {},
  ): Promise<ApplicationUpdateStatus> {
    if (updateCheckDisabled(this.env)) {
      return Promise.resolve(this.baseStatus(identity, 'disabled'));
    }
    if (unsupportedNightly(identity)) {
      return Promise.resolve(
        this.baseStatus(identity, 'unsupported_channel'),
      );
    }
    const key = applicationUpdateCacheKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const check = this.performCheck(identity, options).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, check);
    return check;
  }

  private async performCheck(
    identity: ApplicationBuildIdentity,
    options: ApplicationUpdateCheckOptions,
  ): Promise<ApplicationUpdateStatus> {
    const cached = this.readCache(identity);
    if (
      cached &&
      (
        (!options.force && this.cacheAge(cached) <= this.freshMs) ||
        (options.force &&
          this.cacheAge(cached) <= this.minimumManualRefreshMs)
      )
    ) {
      return this.statusFromCandidate(identity, cached, false);
    }

    let lock: CacheLock;
    try {
      await fs.promises.mkdir(this.cacheRoot, {recursive: true});
      lock = await this.acquireLock(identity);
    } catch (error) {
      return this.cacheFailureStatus(identity, cached, error);
    }
    if (!lock.acquired) {
      const concurrentCache = this.readCache(identity);
      return concurrentCache
        ? this.statusFromCandidate(identity, concurrentCache, true)
        : this.baseStatus(identity, 'checking');
    }

    const checkedAt = this.now().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const result = await fetchApplicationUpdateCandidate({
        identity,
        fetch: this.fetch,
        signal: controller.signal,
        etag: cached?.etag,
        cachedCandidate: cached?.candidate,
      });
      const record: ApplicationUpdateCacheRecord = {
        schemaVersion: 1,
        key: applicationUpdateCacheKey(identity),
        checkedAt,
        ...(result.etag ? {etag: result.etag} : {}),
        candidate: result.candidate,
      };
      await this.writeCache(identity, record);
      return this.statusFromCandidate(identity, record, false);
    } catch (error) {
      const lastError = updateError(error, checkedAt);
      if (cached) {
        const record = {...cached, lastError};
        await this.writeCache(identity, record).catch(() => undefined);
        return this.statusFromCandidate(identity, record, true);
      }
      return {
        ...this.baseStatus(identity, 'error'),
        checkedAt,
        lastError,
      };
    } finally {
      clearTimeout(timeout);
      await lock.release();
    }
  }

  private statusFromCandidate(
    identity: ApplicationBuildIdentity,
    cache: ApplicationUpdateCacheRecord,
    stale: boolean,
  ): ApplicationUpdateStatus {
    const {candidate} = cache;
    let state: ApplicationUpdateStatus['state'];
    if (identity.channel === 'nightly') {
      state =
        identity.commit === candidate.commit
          ? 'up_to_date'
          : 'update_available';
    } else {
      const current = semver.valid(identity.version);
      if (!current) {
        return {
          ...this.baseStatus(identity, 'error'),
          checkedAt: cache.checkedAt,
          lastError: {
            code: 'invalid_response',
            message: 'Current SmartPerfetto version is not valid SemVer',
            at: cache.checkedAt,
          },
        };
      }
      state = semver.eq(current, candidate.version)
        ? 'up_to_date'
        : semver.gt(current, candidate.version)
          ? 'ahead'
          : 'update_available';
    }
    return {
      schemaVersion: 1,
      state,
      checkedAt: cache.checkedAt,
      ...(stale ? {stale: true} : {}),
      source: candidate.source,
      current: identity,
      latest: {
        version: candidate.version,
        ...(candidate.commit ? {commit: candidate.commit} : {}),
        ...(candidate.publishedAt
          ? {publishedAt: candidate.publishedAt}
          : {}),
        releaseUrl: candidate.releaseUrl,
        ...(candidate.asset ? {asset: candidate.asset} : {}),
      },
      ...(state === 'update_available'
        ? {action: releaseAction(identity, candidate)}
        : {}),
      ...(cache.lastError ? {lastError: cache.lastError} : {}),
    };
  }

  private baseStatus(
    identity: ApplicationBuildIdentity,
    state: ApplicationUpdateStatus['state'],
  ): ApplicationUpdateStatus {
    return {schemaVersion: 1, state, current: identity};
  }

  private cacheFailureStatus(
    identity: ApplicationBuildIdentity,
    cached: ApplicationUpdateCacheRecord | undefined,
    error: unknown,
  ): ApplicationUpdateStatus {
    const at = this.now().toISOString();
    const lastError: ApplicationUpdateError = {
      code: 'cache_error',
      message: safeErrorMessage(error),
      at,
    };
    if (cached) {
      return this.statusFromCandidate(
        identity,
        {...cached, lastError},
        true,
      );
    }
    return {...this.baseStatus(identity, 'error'), checkedAt: at, lastError};
  }

  private cacheAge(cache: ApplicationUpdateCacheRecord): number {
    return Math.max(0, this.now().getTime() - Date.parse(cache.checkedAt));
  }

  private cachePath(identity: ApplicationBuildIdentity): string {
    return path.join(
      this.cacheRoot,
      `${applicationUpdateCacheKey(identity)}.json`,
    );
  }

  private lockPath(identity: ApplicationBuildIdentity): string {
    return `${this.cachePath(identity)}.lock`;
  }

  private readCache(
    identity: ApplicationBuildIdentity,
  ): ApplicationUpdateCacheRecord | undefined {
    const key = applicationUpdateCacheKey(identity);
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath(identity), 'utf8'));
      return validCacheRecord(raw, key);
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    identity: ApplicationBuildIdentity,
    record: ApplicationUpdateCacheRecord,
  ): Promise<void> {
    await fs.promises.mkdir(this.cacheRoot, {recursive: true});
    await atomicWriteFile(
      this.cachePath(identity),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  private async acquireLock(
    identity: ApplicationBuildIdentity,
  ): Promise<CacheLock> {
    const lockPath = this.lockPath(identity);
    const open = async (): Promise<fs.promises.FileHandle | undefined> => {
      try {
        return await fs.promises.open(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
        throw error;
      }
    };
    let handle = await open();
    if (!handle) {
      try {
        const stat = await fs.promises.stat(lockPath);
        if (this.now().getTime() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.promises.unlink(lockPath);
          handle = await open();
        }
      } catch {
        handle = await open();
      }
    }
    if (!handle) return {acquired: false, async release() {}};
    await handle.writeFile(`${process.pid}\n`);
    let released = false;
    return {
      acquired: true,
      async release() {
        if (released) return;
        released = true;
        await handle?.close();
        await fs.promises.unlink(lockPath).catch(() => undefined);
      },
    };
  }
}

let singleton: ApplicationUpdateService | undefined;

export function getApplicationUpdateService(): ApplicationUpdateService {
  singleton ??= new ApplicationUpdateService();
  return singleton;
}

export function resetApplicationUpdateServiceForTests(): void {
  singleton = undefined;
}
