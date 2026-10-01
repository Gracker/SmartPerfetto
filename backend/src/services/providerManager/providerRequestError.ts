// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

type ProviderRequestErrorCode = 'provider_not_found' | 'provider_invalid_request';

/**
 * A provider request the caller can fix: an unknown id or an invalid input.
 * Its message is written by Provider Manager for the user and is safe to
 * return; any other error from a provider operation (secret store, database,
 * mutation lease) is not, and routes answer it with fixed text.
 */
export class ProviderRequestError extends PublicRequestError {
  declare readonly code: ProviderRequestErrorCode;

  constructor(code: ProviderRequestErrorCode, message: string) {
    super(code, message, code === 'provider_not_found' ? 404 : 400);
  }
}

export function providerNotFound(id: string): ProviderRequestError {
  return new ProviderRequestError('provider_not_found', `Provider not found: ${id}`);
}

export function invalidProviderRequest(message: string): ProviderRequestError {
  return new ProviderRequestError('provider_invalid_request', message);
}
