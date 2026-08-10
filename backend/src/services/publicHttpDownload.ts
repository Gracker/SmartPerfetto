// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {lookup} from 'dns/promises';
import http, {type IncomingMessage} from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';

const MAX_REDIRECTS = 5;
export const TRACE_URL_TRUSTED_FAKE_IP_HOSTS_ENV =
  'SMARTPERFETTO_TRACE_URL_TRUSTED_FAKE_IP_HOSTS';

export class PublicHttpUrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicHttpUrlRejectedError';
  }
}

export interface PublicHttpDownloadResponse {
  status: number;
  statusText: string;
  headers: {get(name: string): string | null};
  body: IncomingMessage;
  finalUrl: URL;
}

type TestFetcher = (url: URL, timeoutMs: number) => Promise<PublicHttpDownloadResponse>;
let testFetcher: TestFetcher | undefined;

export function setPublicHttpDownloadForTests(fetcher?: TestFetcher): void {
  testFetcher = fetcher;
}

function parseIpv4(address: string): number[] | undefined {
  if (net.isIP(address) !== 4) return undefined;
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every(part => part >= 0 && part <= 255)
    ? parts
    : undefined;
}

function ipv4IsPublic(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b] = parts;
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function expandIpv6(address: string): number[] | undefined {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const ipv4Tail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const parts = parseIpv4(ipv4Tail);
    if (!parts) return undefined;
    normalized = normalized.slice(0, -ipv4Tail.length) +
      `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const parts = [...left, ...Array(missing).fill('0'), ...right]
    .map(part => Number.parseInt(part || '0', 16));
  return parts.length === 8 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? parts
    : undefined;
}

function ipv6IsPublic(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return false;
  const [first, second] = parts;
  if (parts.every(part => part === 0)) return false;
  if (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1) return false;
  // IPv4-compatible/translated and automatic transition prefixes can route an
  // embedded private IPv4 destination even though the outer literal is IPv6.
  // Treat the whole transition range as reserved at this public-only boundary.
  if (parts.slice(0, 6).every(part => part === 0)) return false; // ::/96
  if (
    parts.slice(0, 4).every(part => part === 0) &&
    parts[4] === 0xffff &&
    parts[5] === 0
  ) return false; // ::ffff:0:0/96 (IPv4-translated)
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    parts.slice(2, 6).every(part => part === 0)
  ) return false; // 64:ff9b::/96 (well-known NAT64)
  if (first === 0x0064 && second === 0xff9b && parts[2] === 1) return false; // 64:ff9b:1::/48
  if (first === 0x2001 && second === 0) return false; // 2001::/32 (Teredo)
  if (first === 0x2002) return false; // 2002::/16 (6to4)
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (
    parts.slice(0, 5).every(part => part === 0) &&
    parts[5] === 0xffff
  ) {
    return ipv4IsPublic([
      parts[6] >> 8,
      parts[6] & 0xff,
      parts[7] >> 8,
      parts[7] & 0xff,
    ].join('.'));
  }
  return true;
}

export function publicHttpAddressAllowed(address: string): boolean {
  const version = net.isIP(address.replace(/^\[|\]$/g, '').split('%')[0]);
  if (version === 4) return ipv4IsPublic(address);
  if (version === 6) return ipv6IsPublic(address);
  return false;
}

/**
 * RFC 2544 benchmark addresses are reserved and blocked by default. An
 * administrator can opt specific HTTPS hostnames into TUN fake-IP routing via
 * an exact allowlist; request-controlled input cannot widen this boundary.
 */
export function publicHttpResolvedAddressAllowed(
  url: URL,
  address: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (publicHttpAddressAllowed(address)) return true;
  const ipv4 = parseIpv4(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const trustedFakeIpHosts = new Set(
    String(env[TRACE_URL_TRUSTED_FAKE_IP_HOSTS_ENV] || '')
      .split(/[\s,]+/)
      .map(value => value.trim().toLowerCase())
      .filter(value => value.length > 0 && net.isIP(value) === 0),
  );
  return url.protocol === 'https:' &&
    net.isIP(hostname) === 0 &&
    trustedFakeIpHosts.has(hostname) &&
    ipv4?.[0] === 198 &&
    (ipv4[1] === 18 || ipv4[1] === 19);
}

export function sanitizedPublicHttpUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function resolvePinnedPublicAddress(url: URL): Promise<{address: string; family: 4 | 6}> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{address: hostname, family: literalFamily as 4 | 6}]
    : await lookup(hostname, {all: true, verbatim: true});
  if (
    addresses.length === 0 ||
    addresses.some(item => !publicHttpResolvedAddressAllowed(url, item.address))
  ) {
    throw new PublicHttpUrlRejectedError(
      'Local, private, reserved, and mixed-address trace URLs are not supported',
    );
  }
  return addresses[0] as {address: string; family: 4 | 6};
}

function requestPinned(
  url: URL,
  address: string,
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const createConnection = (_options: unknown, callback: (error: Error | null, socket?: net.Socket) => void) => {
      const socket = url.protocol === 'https:'
        ? tls.connect({host: address, port, servername: url.hostname})
        : net.connect({host: address, port});
      socket.once('connect', () => callback(null, socket));
      socket.once('error', callback);
      return socket;
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      headers: {Accept: 'application/octet-stream'},
      agent: false,
      createConnection,
    } as any, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Trace URL request timed out')));
    request.once('error', reject);
    request.end();
  });
}

export async function downloadPublicHttpUrl(
  initialUrl: URL,
  timeoutMs: number,
): Promise<PublicHttpDownloadResponse> {
  const deadline = Date.now() + timeoutMs;
  if (testFetcher) {
    return armResponseDeadline(await testFetcher(initialUrl, timeoutMs), deadline);
  }
  let current = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
      throw new PublicHttpUrlRejectedError(
        'Only credential-free http and https trace URLs are supported',
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Trace URL request timed out');
    const pinned = await resolvePinnedPublicAddress(current);
    const response = await requestPinned(current, pinned.address, remaining);
    const status = response.statusCode ?? 502;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new Error('Trace URL redirect omitted Location');
      if (redirectCount === MAX_REDIRECTS) throw new Error('Trace URL exceeded redirect limit');
      current = new URL(location, current);
      continue;
    }
    return armResponseDeadline({
      status,
      statusText: response.statusMessage ?? '',
      headers: {
        get(name: string): string | null {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        },
      },
      body: response,
      finalUrl: current,
    }, deadline);
  }
  throw new Error('Trace URL exceeded redirect limit');
}

function armResponseDeadline(
  response: PublicHttpDownloadResponse,
  deadline: number,
): PublicHttpDownloadResponse {
  const remaining = Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => {
    response.body.destroy(new Error('Trace URL response deadline exceeded'));
  }, remaining);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  response.body.once('end', clear);
  response.body.once('close', clear);
  return response;
}
