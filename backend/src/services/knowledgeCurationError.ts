// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../utils/publicRequestError';

/**
 * A curation request (baseline, case, case edge, memory promotion) that the
 * curator has to change: a rejected gate or an unknown id. Storage failures
 * (replica divergence, filesystem, database) are not, and routes answer them
 * with fixed text.
 */
export class KnowledgeCurationError extends PublicRequestError {}
