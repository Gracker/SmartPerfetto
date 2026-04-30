// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { REPORT_CAUSAL_MAP_SCRIPT } from '../reportCausalMapAssets';

describe('REPORT_CAUSAL_MAP_SCRIPT', () => {
  test('is valid standalone browser script', () => {
    expect(() => new Function(REPORT_CAUSAL_MAP_SCRIPT)).not.toThrow();
  });
});
