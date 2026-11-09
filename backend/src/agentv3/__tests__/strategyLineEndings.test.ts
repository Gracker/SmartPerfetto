// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';

import {invalidateStrategyCache, loadStrategies} from '../strategyLoader';

afterEach(() => {
  jest.restoreAllMocks();
  invalidateStrategyCache();
});

function snapshot(): unknown {
  invalidateStrategyCache();
  return JSON.parse(JSON.stringify([...loadStrategies().entries()]));
}

describe('strategy files with CRLF line endings', () => {
  it('load exactly like the LF checkout', () => {
    const lineFeed = snapshot();
    const read = fs.readFileSync;
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const content = (read as (f: unknown, o?: unknown) => string | Buffer)(file, options);
      return typeof content === 'string' && /\.(strategy\.md|template\.md|ya?ml)$/.test(String(file))
        ? content.replace(/\n/g, '\r\n')
        : content;
    }) as typeof fs.readFileSync);
    expect(snapshot()).toEqual(lineFeed);
  });
});
