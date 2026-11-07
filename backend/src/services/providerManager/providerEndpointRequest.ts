// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isCredentialFreeHttpUrl} from '../../utils/httpValue';
import {lookup} from 'dns/promises';
import http, {type IncomingMessage} from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import {resolveFeatureConfig} from '../../config';
import {publicHttpAddressAllowed} from '../publicHttpDownload';

export const PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV =
  'SMARTPERFETTO_PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST';

const MAX_PROVIDER_REDIRECTS = 3;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export interface ProviderEndpointResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  cancelBody(): void;
}

export class ProviderEndpointRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderEndpointRejectedError';
  }
}

function configuredPrivateOrigins(env: NodeJS.ProcessEnv): Set<string> {
  const origins = new Set<string>();
  for (const item of (env[PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV] ?? '').split(',')) {
    const value = item.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!isCredentialFreeHttpUrl(url)) continue;
      origins.add(url.origin);
    } catch {
      // Invalid deployment entries never broaden the outbound policy.
    }
  }
  return origins;
}

export function assertProviderEndpointPolicy(
  url: URL,
  resolvedAddresses: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isCredentialFreeHttpUrl(url)) {
    throw new ProviderEndpointRejectedError(
      'Provider endpoints must use credential-free http or https URLs',
    );
  }
  if (resolvedAddresses.length === 0) {
    throw new ProviderEndpointRejectedError('Provider endpoint DNS resolution returned no addresses');
  }
  if (!resolveFeatureConfig(env).enterprise) return;

  if (configuredPrivateOrigins(env).has(url.origin)) return;
  if (url.protocol !== 'https:') {
    throw new ProviderEndpointRejectedError(
      `Enterprise provider endpoints must use public HTTPS unless their exact origin is listed in ${PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV}`,
    );
  }
  if (resolvedAddresses.some(address => !publicHttpAddressAllowed(address))) {
    throw new ProviderEndpointRejectedError(
      `Enterprise provider endpoints cannot resolve to local, private, reserved, or mixed addresses unless their exact origin is listed in ${PROVIDER_PRIVATE_ENDPOINT_ALLOWLIST_ENV}`,
    );
  }
}

async function resolvePinnedEndpoint(
  url: URL,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{address: string; family: 4 | 6}> {
  throwIfAborted(signal);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{address: hostname, family: literalFamily as 4 | 6}]
    : await withEndpointDeadline(
      lookup(hostname, {all: true, verbatim: true}),
      timeoutMs,
      signal,
      'Provider endpoint DNS resolution timed out',
    );
  throwIfAborted(signal);
  assertProviderEndpointPolicy(url, addresses.map(item => item.address), env);
  return addresses[0] as {address: string; family: 4 | 6};
}

function abortError(message = 'Provider endpoint request aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function withEndpointDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  throwIfAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(abortError(timeoutMessage)), timeoutMs);
        if (signal) {
          abort = () => reject(abortError());
          signal.addEventListener('abort', abort, {once: true});
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

function requestPinned(
  url: URL,
  address: string,
  init: {method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal},
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(abortError());
      return;
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const createConnection = (
      _options: unknown,
      callback: (error: Error | null, socket?: net.Socket) => void,
    ) => {
      const socket = url.protocol === 'https:'
        ? tls.connect({host: address, port, servername: url.hostname})
        : net.connect({host: address, port});
      socket.once('connect', () => callback(null, socket));
      socket.once('error', callback);
      return socket;
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: init.method,
      headers: init.headers,
      agent: false,
      createConnection,
    } as any, resolve);
    const abort = () => request.destroy(abortError());
    init.signal?.addEventListener('abort', abort, {once: true});
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Provider endpoint request timed out')));
    request.once('error', reject);
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    if (init.body) request.write(init.body);
    request.end();
  });
}

function responseAdapter(response: IncomingMessage): ProviderEndpointResponse {
  let consumed = false;
  return {
    ok: (response.statusCode ?? 502) >= 200 && (response.statusCode ?? 502) < 300,
    status: response.statusCode ?? 502,
    async text(): Promise<string> {
      if (consumed) throw new Error('Provider response body was already consumed');
      consumed = true;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
          response.destroy();
          throw new Error('Provider response exceeded the 1 MiB connection-test limit');
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    cancelBody(): void {
      response.destroy();
    },
  };
}

export async function requestProviderEndpoint(
  initialUrl: string,
  init: {method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal},
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderEndpointResponse> {
  const deadline = Date.now() + timeoutMs;
  let current = new URL(initialUrl);
  const initialOrigin = current.origin;

  for (let redirectCount = 0; redirectCount <= MAX_PROVIDER_REDIRECTS; redirectCount += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Provider endpoint request timed out');
    const pinned = await resolvePinnedEndpoint(current, env, remaining, init.signal);
    const requestRemaining = deadline - Date.now();
    if (requestRemaining <= 0) throw abortError('Provider endpoint request timed out');
    const response = await requestPinned(
      current,
      pinned.address,
      init,
      requestRemaining,
    );
    const status = response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new Error('Provider endpoint redirect omitted Location');
      if (redirectCount === MAX_PROVIDER_REDIRECTS) {
        throw new Error('Provider endpoint exceeded redirect limit');
      }
      const redirected = new URL(location, current);
      if (redirected.origin !== initialOrigin) {
        throw new ProviderEndpointRejectedError(
          'Provider endpoint redirects cannot change origin while credentials are attached',
        );
      }
      current = redirected;
      continue;
    }
    return responseAdapter(response);
  }
  throw new Error('Provider endpoint exceeded redirect limit');
}
