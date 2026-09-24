// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export {
  addAtraceCategories,
  calculateCaptureBufferSizeKb,
  CAPTURE_PRESETS,
  extractDurationMs,
  getCapturePreset,
  isCapturePresetId,
  listCapturePresets,
  readTraceConfigFile,
  renderAndroidTraceConfig,
  renderTraceConfigTemplate,
} from '../../services/traceCaptureConfig';

export type {
  CaptureConfigRenderOptions,
  CapturePresetDefinition,
  CapturePresetId,
  CapturePresetRequirements,
  CaptureTarget,
} from '../../services/traceCaptureConfig';
