// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV, serverSecretCandidateKeys} from '../../config';
import type {RequestContext} from '../../middleware/auth';
import {
  TRACE_PROCESSOR_CAPABILITY_SECRET_ENV,
  issueTraceProcessorProxyCapability,
  resetTraceProcessorProxyCapabilitiesForTests,
  resolveTraceProcessorProxyCapability,
  stripTraceProcessorCapabilityProtocols,
} from '../traceProcessorProxyCapability';

const SECRET_ENV_KEYS = [
  ...serverSecretCandidateKeys([TRACE_PROCESSOR_CAPABILITY_SECRET_ENV]),
  ENTERPRISE_FEATURE_FLAG_ENV,
];
const originalEnv = new Map(SECRET_ENV_KEYS.map(key => [key, process.env[key]]));
const context: RequestContext = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'api_key',
  roles: ['api_key'],
  scopes: ['trace:read', 'trace:write'],
  requestId: 'request-a',
  windowId: 'window-a',
};

beforeEach(() => {
  for (const key of SECRET_ENV_KEYS) delete process.env[key];
  process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV] =
    'test-trace-processor-capability-secret-at-least-32-bytes';
  resetTraceProcessorProxyCapabilitiesForTests();
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTraceProcessorProxyCapabilitiesForTests();
});

describe('trace processor WebSocket capability', () => {
  it('survives process-local state reset and restores only the bound scope', () => {
    const capability = issueTraceProcessorProxyCapability({
      context,
      leaseId: 'lease-a',
      now: 1_000,
      ttlMs: 60_000,
    });
    resetTraceProcessorProxyCapabilitiesForTests();

    expect(resolveTraceProcessorProxyCapability(
      capability.protocol,
      'lease-a',
      2_000,
    )).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      windowId: 'window-a',
      scopes: ['trace:read'],
    });
  });

  it('rejects expiration, lease mismatch, and signature tampering', () => {
    const capability = issueTraceProcessorProxyCapability({
      context,
      leaseId: 'lease-a',
      now: 1_000,
      ttlMs: 30_000,
    });

    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-b', 2_000)).toBeNull();
    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-a', 31_001)).toBeNull();
    expect(resolveTraceProcessorProxyCapability(
      `${capability.protocol.slice(0, -1)}x`,
      'lease-a',
      2_000,
    )).toBeNull();
  });

  it('removes capability subprotocols before forwarding upstream', () => {
    const capability = issueTraceProcessorProxyCapability({context, leaseId: 'lease-a'});
    expect(stripTraceProcessorCapabilityProtocols([
      capability.protocol,
      'application.trace-processor',
    ])).toEqual(['application.trace-processor']);
  });

  // Outside OIDC the capability used to ignore SMARTPERFETTO_SERVER_SECRET and
  // sign with a random per-process key, so enterprise mode refused to start
  // a WebSocket and capabilities never survived a restart.
  it('signs with the server secret root in every auth mode', () => {
    delete process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV];
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SERVER_SECRET = 'test-server-secret-at-least-32-bytes';
    const capability = issueTraceProcessorProxyCapability({context, leaseId: 'lease-a', now: 1_000});
    resetTraceProcessorProxyCapabilitiesForTests();

    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-a', 2_000))
      .toMatchObject({userId: 'user-a'});
    process.env.SMARTPERFETTO_SERVER_SECRET = 'another-server-secret-at-least-32-bytes';
    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-a', 2_000)).toBeNull();
  });

  it('reads a padded capability secret as its trimmed value', () => {
    const capability = issueTraceProcessorProxyCapability({context, leaseId: 'lease-a', now: 1_000});
    process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV] =
      '  test-trace-processor-capability-secret-at-least-32-bytes\n';
    expect(resolveTraceProcessorProxyCapability(capability.protocol, 'lease-a', 2_000))
      .toMatchObject({userId: 'user-a'});
  });
});
