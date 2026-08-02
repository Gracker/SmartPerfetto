// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {resolveAuthConfig, resolveFeatureConfig} from '../config';
import type {RequestContext, RequestContextAuthType} from '../middleware/auth';
import {deriveServerSecret, resetServerSecretForTests} from '../security/serverSecret';

export const TRACE_PROCESSOR_CAPABILITY_SECRET_ENV =
  'SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET';

const CAPABILITY_PROTOCOL_PREFIX = 'smartperfetto.tp.';
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_BYTES = 32;

interface CapabilityPayload {
  v: 1;
  leaseId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  windowId?: string;
  authType: RequestContextAuthType;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface TraceProcessorProxyCapability {
  protocol: string;
  expiresAt: number;
}

let devProcessSecret: Buffer | undefined;

function capabilitySecret(): Buffer {
  if (resolveAuthConfig(process.env).oidcEnabled) {
    return deriveServerSecret({
      purpose: 'trace-processor-capability',
      preferredEnvKeys: [TRACE_PROCESSOR_CAPABILITY_SECRET_ENV],
      minimumBytes: MIN_SECRET_BYTES,
    });
  }
  const configured = [
    process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV],
    process.env.SMARTPERFETTO_SSO_COOKIE_SECRET,
    process.env.SMARTPERFETTO_API_KEY,
  ].find(value => typeof value === 'string' && value.length >= MIN_SECRET_BYTES);
  if (configured) return Buffer.from(configured, 'utf8');
  if (resolveFeatureConfig().enterprise) {
    throw new Error(
      `${TRACE_PROCESSOR_CAPABILITY_SECRET_ENV} must contain at least ${MIN_SECRET_BYTES} bytes in enterprise mode`,
    );
  }
  devProcessSecret ??= crypto.randomBytes(32);
  return devProcessSecret;
}

function sign(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', capabilitySecret())
    .update(encodedPayload)
    .digest('base64url');
}

function safeSignatureEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function decodePayload(encoded: string): CapabilityPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as
      Partial<CapabilityPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.leaseId !== 'string' || !parsed.leaseId ||
      typeof parsed.tenantId !== 'string' || !parsed.tenantId ||
      typeof parsed.workspaceId !== 'string' || !parsed.workspaceId ||
      typeof parsed.userId !== 'string' || !parsed.userId ||
      typeof parsed.authType !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.nonce !== 'string' || !parsed.nonce
    ) {
      return null;
    }
    return parsed as CapabilityPayload;
  } catch {
    return null;
  }
}

/**
 * Mint a short-lived WebSocket-only capability from an authenticated request.
 * Browsers cannot attach Authorization headers to WebSocket upgrades, so the
 * signed capability is carried as a subprotocol. The long-lived API key never
 * enters the URL, browser history, or the upload identity key.
 */
export function issueTraceProcessorProxyCapability(input: {
  context: RequestContext;
  leaseId: string;
  now?: number;
  ttlMs?: number;
}): TraceProcessorProxyCapability {
  const issuedAt = input.now ?? Date.now();
  const expiresAt = issuedAt + Math.max(30_000, input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS);
  const payload: CapabilityPayload = {
    v: 1,
    leaseId: input.leaseId,
    tenantId: input.context.tenantId,
    workspaceId: input.context.workspaceId,
    userId: input.context.userId,
    ...(input.context.windowId ? {windowId: input.context.windowId} : {}),
    authType: input.context.authType,
    issuedAt,
    expiresAt,
    nonce: crypto.randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    protocol: `${CAPABILITY_PROTOCOL_PREFIX}${encoded}.${sign(encoded)}`,
    expiresAt,
  };
}

export function resolveTraceProcessorProxyCapability(
  protocolHeader: string | string[] | undefined,
  leaseId: string,
  now = Date.now(),
): RequestContext | null {
  const protocols = splitProtocols(protocolHeader);
  const protocol = protocols.find(value => value.startsWith(CAPABILITY_PROTOCOL_PREFIX));
  if (!protocol) return null;
  const token = protocol.slice(CAPABILITY_PROTOCOL_PREFIX.length);
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeSignatureEquals(signature, sign(encoded))) return null;
  const payload = decodePayload(encoded);
  if (
    !payload ||
    payload.leaseId !== leaseId ||
    payload.issuedAt > now + 30_000 ||
    payload.expiresAt <= now
  ) {
    return null;
  }
  return {
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    authType: payload.authType,
    roles: ['analyst'],
    scopes: ['trace:read'],
    requestId: `ws-cap-${crypto.randomUUID()}`,
    ...(payload.windowId ? {windowId: payload.windowId} : {}),
  };
}

function splitProtocols(protocolHeader: string | string[] | undefined): string[] {
  return (Array.isArray(protocolHeader) ? protocolHeader : [protocolHeader ?? ''])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
}

export function stripTraceProcessorCapabilityProtocols(
  protocolHeader: string | string[] | undefined,
): string[] {
  return splitProtocols(protocolHeader)
    .filter(value => !value.startsWith(CAPABILITY_PROTOCOL_PREFIX));
}

export function resetTraceProcessorProxyCapabilitiesForTests(): void {
  devProcessSecret = undefined;
  resetServerSecretForTests();
}

export const __testing = {
  CAPABILITY_PROTOCOL_PREFIX,
  DEFAULT_CAPABILITY_TTL_MS,
};
