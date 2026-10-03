// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type express from 'express';
import {sendPublicRequestError} from '../middleware/routeFailure';
import {ProviderStoreUnreadableError} from '../services/providerManager';

/**
 * Answers a refusal caused by an unreadable providers.json with its fixed code
 * and message (never the file's content). Returns false for any other error.
 */
export function sendProviderStoreUnreadableIfPresent(res: express.Response, error: unknown): boolean {
  if (!(error instanceof ProviderStoreUnreadableError)) return false;
  sendPublicRequestError(res, error);
  return true;
}
