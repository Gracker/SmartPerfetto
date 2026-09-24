// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  claimAuditRows,
  claimVerificationStatusLine,
  deriveDeliveryVerdict,
  summarizeClaimVerification,
} from '../analysisInvestigationPresentation';
import {analysisConfidenceIsGrounded} from '../../agentv3/analysisTermination';

describe('delivery verdict', () => {
  // Every input the Web panel's analysisCompletedResultStatus reports as partial
  // must be `partial` or `unverified` here, never `completed`.
  it.each([
    [{success: false}, 'failed'],
    [{success: true, partial: true}, 'partial'],
    [{success: true, deliveryAssurance: {claims: 'coverage_incomplete'}}, 'unverified'],
    [{success: true, deliveryAssurance: {report: 'failed'}}, 'unverified'],
    [{success: true, conclusionContract: {bindingEligibility: 'ineligible'}}, 'unverified'],
    [{success: true, claimSupport: [{bindingEligibility: 'eligible'}, {bindingEligibility: 'ineligible'}]}, 'unverified'],
    [{success: true, deliveryAssurance: {completion: 'passed', claims: 'passed', source: 'not_applicable',
      identity: 'not_applicable', report: 'not_checked'}}, 'completed'],
    [{success: true}, 'completed'],
  ] as const)('classifies %j as %s', (input, expected) => {
    expect(deriveDeliveryVerdict(input as never)).toBe(expected);
  });

  it('keeps a failed quality gate partial even when assurance is also incomplete', () => {
    expect(deriveDeliveryVerdict({success: true, partial: true, deliveryAssurance: {claims: 'failed'}})).toBe('partial');
  });
});

describe('claim verification status line', () => {
  const summary = (status: string, statuses: string[], extra: Record<string, unknown> = {}) =>
    summarizeClaimVerification({status, claimResults: statuses.map(item => ({status: item})), issues: [], ...extra});
  const proof = (status: string) => ({kind: 'numeric_cell', status, reason: 'r', anchorIds: [], evidenceRefIds: []});

  it('derives counts from claim results rather than stored counters', () => {
    expect(summarizeClaimVerification({status: 'failed', schemaVersion: 'claim_verifier@2', checkedClaimCount: 99,
      unsupportedClaimCount: 99, claimResults: [
        {claimId: 'a', status: 'verified', referenceCells: [{status: 'matched'}], deterministicProof: proof('proved')},
        {claimId: 'b', status: 'unsupported', referenceCells: [{status: 'matched'}, {status: 'value_mismatch'}],
          deterministicProof: proof('rejected')},
        {claimId: 'c', status: 'not_checked', referenceCells: [{status: 'ineligible'}], deterministicProof: proof('not_checked')},
      ], issues: [{claimId: 'b', severity: 'error', code: 'x'}, {claimId: '', severity: 'error', code: 'semantic_undeclared_claim'},
        {claimId: 'a', severity: 'warning', code: 'y'}]} as never))
      .toEqual({status: 'failed', totalClaimCount: 3, checkedClaimCount: 2, verifiedClaimCount: 1,
        unsupportedClaimCount: 1, referencesMatchedClaimCount: 1, propositionProvedClaimCount: 1, notCheckedClaimCount: 1,
        globalErrorCodes: ['semantic_undeclared_claim'], issueCount: 3});
  });

  it('names unmarked roundings and a warning-level undeclared assertion on an unverified answer (zh/en)', () => {
    // critical-path E2E round 3 shape: a completed review, faithful roundings, an undeclared assertion.
    const summary = summarizeClaimVerification({status: 'partial', schemaVersion: 'claim_verifier@2', claimResults: [
      {claimId: 'a', status: 'partial', referenceCells: [{status: 'matched'}], deterministicProof: proof('candidate')},
      {claimId: 'b', status: 'partial', referenceCells: [{status: 'matched'}], deterministicProof: proof('candidate')},
    ], issues: [
      {claimId: 'a', severity: 'warning', code: 'semantic_numeric_display_rounding'},
      {claimId: 'a', severity: 'warning', code: 'semantic_numeric_display_rounding'},
      {claimId: '', severity: 'warning', code: 'semantic_undeclared_claim'},
    ]} as never);
    expect(summary).toMatchObject({unmarkedRoundingClaimCount: 1, globalErrorCodes: ['semantic_undeclared_claim']});
    expect(claimVerificationStatusLine(summary, 'zh-CN'))
      .toBe('断言核验: 未完成 — 引用匹配 2/2 · 命题证明 0/2 · 已核验 0/2 · 未标注近似的数值 1 · 另: 正文含未声明的断言');
    expect(claimVerificationStatusLine(summary, 'en')).toContain('rounded without an approximation marker 1');
  });

  it('splits reference matching, proof and verification, and names a whole-answer failure (zh/en)', () => {
    // sfb_dut-demo-launch_a1 shape: partial claims, three semantic contradictions and an undeclared assertion.
    const failed = summarizeClaimVerification({status: 'failed', schemaVersion: 'claim_verifier@2', claimResults: [
      ...Array.from({length: 20}, (_, index) => ({claimId: `m${index}`, status: 'partial',
        referenceCells: [{status: 'matched'}], deterministicProof: proof('candidate')})),
      {claimId: 'x', status: 'unsupported', referenceCells: [{status: 'matched'}], deterministicProof: proof('candidate')},
      {claimId: 'v', status: 'verified', referenceCells: [{status: 'matched'}], deterministicProof: proof('proved')},
    ], issues: [{claimId: '', severity: 'error', code: 'semantic_undeclared_claim'}], notCheckedReason: 'timeout'});
    expect(claimVerificationStatusLine(failed, 'zh-CN')).toBe(
      '断言核验: 未通过 — 引用匹配 22/22 · 命题证明 1/22 · 已核验 1/22 · 矛盾 1 · 另: 正文含未声明的断言（语义复核超出时间预算）');
    expect(claimVerificationStatusLine(failed, 'en')).toBe('Claim verification: failed — references matched 22/22 · ' +
      'propositions proved 1/22 · verified 1/22 · contradicted 1 · also: the body contains undeclared assertions ' +
      '(semantic review ran out of time)');
  });

  it('never prints "0 claims failed" for a failure that belongs to the whole answer', () => {
    // rooted_lock_monitor_a1 shape: no declared claims, one undeclared-assertion error.
    const line = claimVerificationStatusLine(summarizeClaimVerification({status: 'failed', claimResults: [],
      issues: [{claimId: '', severity: 'error', code: 'semantic_undeclared_claim'}]}), 'zh-CN');
    expect(line).toBe('断言核验: 未通过 — 无结构化断言 · 另: 正文含未声明的断言');
    expect(line).not.toContain('0 条');
  });

  it('names an invalid declaration as not admitted, not contradicted', () => {
    expect(claimVerificationStatusLine(summary('partial', ['not_checked', 'not_checked'],
      {notCheckedReason: 'invalid_declarations'}), 'en'))
      .toBe('Claim verification: incomplete — references matched 0/2 · verified 0/2 · not admitted 2 ' +
        '(the conclusion declaration was invalid, so no claim was admitted)');
  });

  it('reports partial and complete verification and an empty claim set', () => {
    expect(claimVerificationStatusLine(summary('partial', ['verified', 'partial'], {notCheckedReason: 'timeout'}), 'en'))
      .toBe('Claim verification: incomplete — references matched 0/2 · verified 1/2 (semantic review ran out of time)');
    expect(claimVerificationStatusLine(summary('passed', ['verified', 'verified']), 'en'))
      .toBe('Claim verification: passed — references matched 0/2 · verified 2/2');
    expect(claimVerificationStatusLine(summary('not_checked', []), 'en')).toBe('Claim verification: not checked — no structured claims');
    expect(claimVerificationStatusLine(undefined, 'en')).toBeUndefined();
  });

  it('appends closed-vocabulary triage detail after the reason', () => {
    expect(claimVerificationStatusLine(summary('partial', ['not_checked', 'not_checked'],
      {notCheckedReason: 'invalid_declarations', notCheckedDetail: 'invalid_json,duplicate_marker'}), 'zh-CN'))
      .toBe('断言核验: 未完成 — 引用匹配 0/2 · 已核验 0/2 · 未进入核验 2（结论声明格式无效，断言未进入核验：invalid_json,duplicate_marker）');
    expect(claimVerificationStatusLine(summary('partial', ['partial'],
      {notCheckedReason: 'provider_error', notCheckedDetail: 'http_429;attempts_2'}), 'en'))
      .toBe('Claim verification: incomplete — references matched 0/1 · verified 0/1 (the semantic review call failed: http_429;attempts_2)');
    expect(claimVerificationStatusLine(summary('partial', ['partial'],
      {notCheckedReason: 'invalid_response', notCheckedDetail: 'resp_claim_invalid_location'}), 'zh-CN'))
      .toBe('断言核验: 未完成 — 引用匹配 0/1 · 已核验 0/1（语义复核结果无法完整解析：resp_claim_invalid_location）');
  });

  it('renders receipt claim-audit rows in the same vocabulary, including receipts written before the split counts', () => {
    const legacy = {totalClaims: 3, verifiedClaims: 1, unsupportedClaims: 1, uncertainClaims: 1};
    expect(claimAuditRows(legacy, 'zh-CN')).toEqual([['断言总数', 3], ['已核验', 1], ['矛盾', 1], ['未确定', 1]]);
    expect(claimAuditRows({...legacy, referencesMatchedClaims: 2, propositionProvedClaims: 1}, 'en')).toEqual([
      ['Total claims', 3], ['References matched', 2], ['Propositions proved', 1], ['Verified', 1], ['Contradicted', 1], ['Uncertain', 1]]);
  });
});

describe('grounded confidence', () => {
  it('treats the no-findings baseline as ungrounded', () => {
    expect(analysisConfidenceIsGrounded({findings: []})).toBe(false);
    expect(analysisConfidenceIsGrounded({})).toBe(false);
    expect(analysisConfidenceIsGrounded({findings: [{}]})).toBe(true);
  });
});
