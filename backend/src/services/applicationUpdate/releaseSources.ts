// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import semver from 'semver';
import {portableTargetId} from './buildIdentity';
import type {
  ApplicationBuildIdentity,
  ApplicationUpdateCandidate,
  ApplicationUpdateError,
} from './types';

const GITHUB_API_ROOT = 'https://api.github.com/repos/Gracker/SmartPerfetto';
const GITHUB_WEB_ROOT = 'https://github.com/Gracker/SmartPerfetto';
const NPM_LATEST_URL =
  'https://registry.npmjs.org/@gracker%2fsmartperfetto/latest';
const NPM_WEB_ROOT =
  'https://www.npmjs.com/package/@gracker/smartperfetto/v';
const DOCKER_TAG_API_ROOT =
  'https://hub.docker.com/v2/repositories/w553000664/smartperfetto/tags';
const DOCKER_WEB_ROOT =
  'https://hub.docker.com/r/w553000664/smartperfetto/tags';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SHA256_DIGEST = /^sha256:([a-f0-9]{64})$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

export type ApplicationUpdateFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ReleaseSourceInput {
  identity: ApplicationBuildIdentity;
  fetch: ApplicationUpdateFetch;
  signal: AbortSignal;
  etag?: string;
  cachedCandidate?: ApplicationUpdateCandidate;
}

export interface ReleaseSourceResult {
  candidate: ApplicationUpdateCandidate;
  etag?: string;
  notModified: boolean;
}

export class ApplicationUpdateSourceError extends Error {
  constructor(
    readonly code: ApplicationUpdateError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationUpdateSourceError';
  }
}

function requestHeaders(
  identity: ApplicationBuildIdentity,
  etag?: string,
): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json, application/json',
    'User-Agent': `SmartPerfetto/${identity.version}`,
    ...(etag ? {'If-None-Match': etag} : {}),
  };
}

async function readJson(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApplicationUpdateSourceError(
      'response_too_large',
      `Update metadata exceeded ${maxBytes} bytes`,
    );
  }
  if (!response.body) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'Update metadata response had no body',
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApplicationUpdateSourceError(
        'response_too_large',
        `Update metadata exceeded ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'Update metadata was not valid JSON',
    );
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      `${label} was not an object`,
    );
  }
  return value as Record<string, unknown>;
}

function stableVersion(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      `${label} did not contain a version`,
    );
  }
  const version = semver.valid(value.replace(/^v/, ''));
  if (!version || semver.prerelease(version)) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      `${label} did not contain a stable SemVer`,
    );
  }
  return version;
}

function checkedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function responseError(response: Response, label: string): never {
  if (response.status === 429 || response.status === 403) {
    throw new ApplicationUpdateSourceError(
      'rate_limited',
      `${label} rate limit prevented the update check`,
    );
  }
  throw new ApplicationUpdateSourceError(
    'network_error',
    `${label} returned HTTP ${response.status}`,
  );
}

function assetNameFor(version: string, identity: ApplicationBuildIdentity): string | undefined {
  const targetId = portableTargetId(identity.target);
  if (!targetId) return undefined;
  const extension = targetId === 'linux-x64' ? 'tar.gz' : 'zip';
  return `smartperfetto-v${version}-${targetId}.${extension}`;
}

function githubCandidateFromPayload(
  payload: unknown,
  identity: ApplicationBuildIdentity,
): ApplicationUpdateCandidate {
  const release = expectRecord(payload, 'GitHub release');
  if (release.draft === true || release.prerelease === true) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'GitHub latest release was not stable',
    );
  }
  const version = stableVersion(release.tag_name, 'GitHub release');
  const candidate: ApplicationUpdateCandidate = {
    source: 'github-releases',
    version,
    publishedAt: checkedAt(release.published_at),
    releaseUrl: `${GITHUB_WEB_ROOT}/releases/tag/v${version}`,
  };

  if (identity.distribution !== 'portable') return candidate;
  const expectedAsset = assetNameFor(version, identity);
  if (!expectedAsset || !Array.isArray(release.assets)) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'No supported portable target was available for this build',
    );
  }
  const asset = release.assets
    .map((value) => expectRecord(value, 'GitHub release asset'))
    .find((value) => value.name === expectedAsset);
  if (!asset) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      `GitHub release did not contain ${expectedAsset}`,
    );
  }
  const digest = typeof asset.digest === 'string'
    ? SHA256_DIGEST.exec(asset.digest)?.[1]
    : undefined;
  return {
    ...candidate,
    asset: {
      name: expectedAsset,
      url: `${GITHUB_WEB_ROOT}/releases/download/v${version}/${expectedAsset}`,
      ...(digest ? {sha256: digest} : {}),
    },
  };
}

async function probeDockerTag(
  versionOrChannel: string,
  input: ReleaseSourceInput,
): Promise<void> {
  const response = await input.fetch(
    `${DOCKER_TAG_API_ROOT}/${encodeURIComponent(versionOrChannel)}`,
    {
      headers: requestHeaders(input.identity),
      signal: input.signal,
    },
  );
  if (!response.ok) responseError(response, 'Docker Hub');
  const payload = expectRecord(await readJson(response), 'Docker Hub tag');
  if (payload.name !== versionOrChannel || typeof payload.digest !== 'string') {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      `Docker Hub tag ${versionOrChannel} was not ready`,
    );
  }
}

async function fetchGithubStable(
  input: ReleaseSourceInput,
): Promise<ReleaseSourceResult> {
  const response = await input.fetch(`${GITHUB_API_ROOT}/releases/latest`, {
    headers: requestHeaders(input.identity, input.etag),
    signal: input.signal,
  });
  let candidate: ApplicationUpdateCandidate;
  let notModified = false;
  if (response.status === 304) {
    if (!input.cachedCandidate) {
      throw new ApplicationUpdateSourceError(
        'invalid_response',
        'GitHub returned 304 without a validated cache entry',
      );
    }
    candidate = input.cachedCandidate;
    notModified = true;
  } else {
    if (!response.ok) responseError(response, 'GitHub');
    candidate = githubCandidateFromPayload(await readJson(response), input.identity);
  }
  if (input.identity.distribution === 'docker') {
    await probeDockerTag(candidate.version, input);
  }
  return {
    candidate,
    etag: response.headers.get('etag') ?? input.etag,
    notModified,
  };
}

async function fetchNpmLatest(
  input: ReleaseSourceInput,
): Promise<ReleaseSourceResult> {
  const response = await input.fetch(NPM_LATEST_URL, {
    headers: requestHeaders(input.identity, input.etag),
    signal: input.signal,
  });
  if (response.status === 304) {
    if (!input.cachedCandidate) {
      throw new ApplicationUpdateSourceError(
        'invalid_response',
        'npm returned 304 without a validated cache entry',
      );
    }
    return {
      candidate: input.cachedCandidate,
      etag: response.headers.get('etag') ?? input.etag,
      notModified: true,
    };
  }
  if (!response.ok) responseError(response, 'npm registry');
  const payload = expectRecord(await readJson(response), 'npm package');
  const version = stableVersion(payload.version, 'npm package');
  return {
    candidate: {
      source: 'npm-registry',
      version,
      releaseUrl: `${NPM_WEB_ROOT}/${version}`,
    },
    etag: response.headers.get('etag') ?? undefined,
    notModified: false,
  };
}

async function fetchNightly(
  input: ReleaseSourceInput,
): Promise<ReleaseSourceResult> {
  if (!input.identity.commit || !GIT_COMMIT.test(input.identity.commit)) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'Nightly build identity did not contain a full Git commit',
    );
  }
  const response = await input.fetch(`${GITHUB_API_ROOT}/commits/main`, {
    headers: requestHeaders(input.identity, input.etag),
    signal: input.signal,
  });
  if (response.status === 304) {
    if (!input.cachedCandidate) {
      throw new ApplicationUpdateSourceError(
        'invalid_response',
        'GitHub returned 304 without a validated nightly cache entry',
      );
    }
    if (input.identity.distribution === 'docker') {
      await probeDockerTag('nightly', input);
    }
    return {
      candidate: input.cachedCandidate,
      etag: response.headers.get('etag') ?? input.etag,
      notModified: true,
    };
  }
  if (!response.ok) responseError(response, 'GitHub');
  const payload = expectRecord(await readJson(response), 'GitHub main commit');
  if (typeof payload.sha !== 'string' || !GIT_COMMIT.test(payload.sha)) {
    throw new ApplicationUpdateSourceError(
      'invalid_response',
      'GitHub main commit response did not contain a full SHA',
    );
  }
  if (input.identity.distribution === 'docker') {
    await probeDockerTag('nightly', input);
  }
  return {
    candidate: {
      source: 'github-main',
      version: input.identity.version,
      commit: payload.sha,
      releaseUrl: `${GITHUB_WEB_ROOT}/commit/${payload.sha}`,
    },
    etag: response.headers.get('etag') ?? undefined,
    notModified: false,
  };
}

export async function fetchApplicationUpdateCandidate(
  input: ReleaseSourceInput,
): Promise<ReleaseSourceResult> {
  if (input.identity.channel === 'nightly') {
    if (
      input.identity.distribution !== 'docker' &&
      input.identity.distribution !== 'source'
    ) {
      throw new ApplicationUpdateSourceError(
        'invalid_response',
        `Nightly updates are not supported for ${input.identity.distribution}`,
      );
    }
    return fetchNightly(input);
  }
  if (input.identity.distribution === 'npm') {
    return fetchNpmLatest(input);
  }
  return fetchGithubStable(input);
}

export function dockerTagPage(versionOrChannel: string): string {
  return `${DOCKER_WEB_ROOT}?name=${encodeURIComponent(versionOrChannel)}`;
}
