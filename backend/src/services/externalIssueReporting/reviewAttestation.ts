// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {resolveAuthConfig, resolveFeatureConfig} from '../../config';
import {deriveServerSecret} from '../../security/serverSecret';
import {
  canonicalContentHash,
  canonicalJsonString,
} from '../selfEvolution/canonicalJson';
import type {
  ExternalIssueReviewV1,
} from '../../types/externalIssueReporting';

const PROTOCOL_PREFIX = 'smartperfetto.external-issue-review.';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_BYTES = 16;
const MAX_TOKEN_BYTES = 8 * 1024;

interface ReviewAttestationPayload {
  v: 1;
  runId: string;
  runManifestId: string;
  providerSnapshotHash: string | null;
  tenantId: string;
  workspaceId: string;
  userId: string;
  reviewHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

interface ExternalIssueReviewScope {
  tenantId: string;
  workspaceId: string;
  userId: string;
}

let devProcessSecret: Buffer | undefined;

function attestationSecret(): Buffer {
  if (resolveAuthConfig(process.env).oidcEnabled) {
    return deriveServerSecret({
      purpose: 'external-issue-review',
      minimumBytes: MIN_SECRET_BYTES,
    });
  }
  const configured = [
    process.env.SMARTPERFETTO_SSO_COOKIE_SECRET,
    process.env.SMARTPERFETTO_API_KEY,
  ].find(value =>
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES);
  if (configured) {
    return crypto
      .createHmac('sha256', configured)
      .update('smartperfetto.external-issue-review.v1')
      .digest();
  }
  if (resolveFeatureConfig().enterprise) {
    throw new Error(
      'A persistent server secret is required for external issue review attestation',
    );
  }
  devProcessSecret ??= crypto.randomBytes(32);
  return devProcessSecret;
}

function unsignedReview(review: ExternalIssueReviewV1): Omit<
  ExternalIssueReviewV1,
  'serverAttestation'
> {
  const {serverAttestation: _serverAttestation, ...value} = review;
  return value;
}

function sign(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', attestationSecret())
    .update(`${PROTOCOL_PREFIX}${encodedPayload}`)
    .digest('base64url');
}

function safeSignatureEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function issueExternalIssueReviewAttestation(input: {
  review: ExternalIssueReviewV1;
  providerSnapshotHash: string | null;
  providerScope: ExternalIssueReviewScope;
  now?: number;
  ttlMs?: number;
}): string {
  const issuedAt = input.now ?? Date.now();
  const payload: ReviewAttestationPayload = {
    v: 1,
    runId: input.review.runId,
    runManifestId: input.review.runManifestId,
    providerSnapshotHash: input.providerSnapshotHash,
    tenantId: input.providerScope.tenantId,
    workspaceId: input.providerScope.workspaceId,
    userId: input.providerScope.userId,
    reviewHash: canonicalContentHash(unsignedReview(input.review)),
    issuedAt,
    expiresAt: issuedAt + Math.max(30_000, input.ttlMs ?? DEFAULT_TTL_MS),
    nonce: crypto.randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(
    canonicalJsonString(payload),
    'utf8',
  ).toString('base64url');
  return `${PROTOCOL_PREFIX}${encoded}.${sign(encoded)}`;
}

export function verifyExternalIssueReviewAttestation(input: {
  review: ExternalIssueReviewV1;
  providerSnapshotHash: string | null;
  providerScope: ExternalIssueReviewScope;
  now?: number;
}): boolean {
  const token = input.review.serverAttestation;
  if (
    typeof token !== 'string' ||
    !token.startsWith(PROTOCOL_PREFIX) ||
    Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES
  ) {
    return false;
  }
  const signed = token.slice(PROTOCOL_PREFIX.length);
  const separator = signed.lastIndexOf('.');
  if (separator <= 0) return false;
  const encoded = signed.slice(0, separator);
  const signature = signed.slice(separator + 1);
  const expected = sign(encoded);
  if (!safeSignatureEquals(signature, expected)) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<ReviewAttestationPayload>;
    const now = input.now ?? Date.now();
    return payload.v === 1 &&
      payload.runId === input.review.runId &&
      payload.runManifestId === input.review.runManifestId &&
      payload.providerSnapshotHash === input.providerSnapshotHash &&
      payload.tenantId === input.providerScope.tenantId &&
      payload.workspaceId === input.providerScope.workspaceId &&
      payload.userId === input.providerScope.userId &&
      payload.reviewHash ===
        canonicalContentHash(unsignedReview(input.review)) &&
      typeof payload.issuedAt === 'number' &&
      typeof payload.expiresAt === 'number' &&
      payload.issuedAt <= now &&
      payload.expiresAt > now &&
      typeof payload.nonce === 'string' &&
      payload.nonce.length > 0;
  } catch {
    return false;
  }
}
