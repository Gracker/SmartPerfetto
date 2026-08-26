// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {parseAospManifestProjects} from '../codebase/aospManifest';

describe('AOSP manifest scope discovery', () => {
  it('returns bounded project paths and groups without repository internals', () => {
    const projects = parseAospManifestProjects(`
      <manifest>
        <project name="platform/frameworks/base" path="frameworks/base" groups="pdk,android" />
        <project name="platform/system/core" groups="android" />
        <project name="unsafe" path="../outside" groups="private" />
      </manifest>
    `);

    expect(projects).toEqual([
      {name: 'platform/frameworks/base', path: 'frameworks/base', groups: ['android', 'pdk']},
      {name: 'platform/system/core', path: 'platform/system/core', groups: ['android']},
    ]);
    expect(JSON.stringify(projects)).not.toContain('.repo');
  });
});
