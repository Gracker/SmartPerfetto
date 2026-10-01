// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

/**
 * A template analysis the caller asked for but cannot get: an unknown
 * template, or a trace without the data the template reads.
 */
export class TemplateAnalysisError extends PublicRequestError {}

export function templateDataUnavailable(message: string): TemplateAnalysisError {
  return new TemplateAnalysisError('template_data_unavailable', message, 422);
}
