// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {estimateAnalysisConfidence} from '../analysisTermination';

describe('estimateAnalysisConfidence', () => {
  it('averages the findings own confidences', () => {
    expect(estimateAnalysisConfidence({findings: [{confidence: 0.8}, {confidence: 0.6}]}))
      .toBeCloseTo(0.7);
  });

  it('assumes 0.5 for a finding that reports no confidence', () => {
    expect(estimateAnalysisConfidence({findings: [{}, {confidence: 1}]})).toBeCloseTo(0.75);
  });

  it('reports the same low value for a run with no findings, whatever produced it', () => {
    expect(estimateAnalysisConfidence({findings: []})).toBe(0.35);
    expect(estimateAnalysisConfidence({findings: [], partial: true})).toBe(0.25);
  });

  it('never infers confidence from the presence of conclusion text', () => {
    // The OpenAI runtime returned 0.55 whenever the conclusion string was
    // non-empty. Prose length is not evidence.
    const noFindings = estimateAnalysisConfidence({findings: []});
    expect(noFindings).toBeLessThan(0.5);
  });

  it('caps a partial run even when its findings are confident', () => {
    expect(estimateAnalysisConfidence({findings: [{confidence: 0.95}], partial: true}))
      .toBeLessThanOrEqual(0.55);
  });

  it('clamps out-of-range finding confidences', () => {
    expect(estimateAnalysisConfidence({findings: [{confidence: 5}]})).toBe(1);
    expect(estimateAnalysisConfidence({findings: [{confidence: -3}]})).toBe(0);
  });
});
