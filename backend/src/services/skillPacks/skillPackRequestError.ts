// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

/**
 * A skill pack request the caller has to change: an invalid manifest or asset,
 * a pack that is not installable or has changed since preview, an unknown pack,
 * or a pack whose Skills collide with the workspace. Its message is a reason
 * token, optionally followed by the pack-relative path or id it concerns.
 */
export class SkillPackRequestError extends PublicRequestError {
  constructor(code: string, status = 400, subject?: string) {
    super(code, subject === undefined ? code : `${code}:${subject}`, status);
  }
}
