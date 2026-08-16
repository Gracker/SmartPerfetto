// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { loadQoderSdkModule } from '../qoderSdkLoader';

describe('Qoder SDK loader', () => {
  it('honors an explicit SDK module path and explains the opt-in installer on failure', async () => {
    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: '/definitely/missing/qoder-sdk.mjs',
    })).rejects.toThrow(
      /qoder:install -- --accept-terms.*SMARTPERFETTO_QODER_SDK_MODULE_PATH/,
    );
  });
});
