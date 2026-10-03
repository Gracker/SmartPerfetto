// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** What an answer needs from selected source: nothing, where code is, or how it behaves. */
export const SOURCE_NEEDS = ['none', 'locate', 'mechanism'] as const;
export type SourceNeed = typeof SOURCE_NEEDS[number];
