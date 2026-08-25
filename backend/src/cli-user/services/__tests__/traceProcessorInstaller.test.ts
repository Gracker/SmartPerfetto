// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { resolveDownloadUrl, type PinConfig } from '../traceProcessorInstaller';

describe('traceProcessorInstaller', () => {
  const sourceRevision = 'a'.repeat(40);
  const pin: PinConfig = {
    version: sourceRevision,
    artifactVersion: 'v58.2',
    urlBase: 'https://storage.example/perfetto',
    sha256ByPlatform: {},
  };

  it('separates the source revision from the artifact download directory', () => {
    expect(resolveDownloadUrl(pin, 'linux-arm64', {})).toBe(
      'https://storage.example/perfetto/v58.2/linux-arm64/trace_processor_shell',
    );
    expect(resolveDownloadUrl(pin, 'windows-amd64', {})).toBe(
      'https://storage.example/perfetto/v58.2/windows-amd64/trace_processor_shell.exe',
    );
  });

  it('preserves mirror and legacy-pin fallbacks', () => {
    expect(
      resolveDownloadUrl(pin, 'mac-amd64', {
        TRACE_PROCESSOR_DOWNLOAD_BASE: 'https://mirror.example/perfetto/',
      }),
    ).toBe('https://mirror.example/perfetto/v58.2/mac-amd64/trace_processor_shell');

    expect(
      resolveDownloadUrl(
        { ...pin, artifactVersion: undefined },
        'mac-amd64',
        {},
      ),
    ).toBe(`https://storage.example/perfetto/${sourceRevision}/mac-amd64/trace_processor_shell`);
  });

  it('preserves an explicit download URL', () => {
    expect(
      resolveDownloadUrl(pin, 'linux-amd64', {
        TRACE_PROCESSOR_DOWNLOAD_URL: 'https://mirror.example/trace_processor_shell',
      }),
    ).toBe('https://mirror.example/trace_processor_shell');
  });
});
