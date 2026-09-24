// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisDeliveryAssurance, AnalysisAssuranceStatus} from '../types/analysisDelivery';
import type {AnalysisReceipt} from '../types/dataContract';

/** Presentation only: missing historical fields never become successful checks. */
export function investigationStatusLines(
  assurance: Pick<AnalysisDeliveryAssurance, 'investigation' | 'investigationEvidence'> | undefined,
  language: OutputLanguage,
): string[] {
  const label = (status: AnalysisAssuranceStatus | undefined): string => {
    switch (status) {
      case 'passed': return localize(language, '已核验', 'Checked');
      case 'not_applicable': return localize(language, '本轮不适用', 'Not applicable to this turn');
      case 'coverage_incomplete': return localize(language, '仍有必需维度缺失', 'Required dimensions remain incomplete');
      case 'unavailable': return localize(language, '核验不可用', 'Assessment unavailable');
      case 'failed': return localize(language, '未通过核验', 'Assessment failed');
      default: return localize(language, '尚未核验', 'Not checked');
    }
  };
  return [
    `${localize(language, '系统调查覆盖', 'System investigation coverage')}: ${label(assurance?.investigation)}`,
    `${localize(language, '系统证据覆盖', 'System evidence coverage')}: ${label(assurance?.investigationEvidence)}`,
  ];
}

export interface ClaimVerificationStatusSummary {
  status?: string;
  totalClaimCount?: number;
  checkedClaimCount?: number;
  verifiedClaimCount?: number;
  /** Claims the verifier marked unsupported: a recorded contradiction or failed check. */
  unsupportedClaimCount?: number;
  /** Claims with at least one reference cell, every one matching the captured evidence. */
  referencesMatchedClaimCount?: number;
  /** Claims whose typed proposition a finite deterministic proof established; absent before verifier@2. */
  propositionProvedClaimCount?: number;
  /** Claims that never entered verification. */
  notCheckedClaimCount?: number;
  /** Error-level issue codes that belong to no declared claim (for example an undeclared assertion). */
  globalErrorCodes?: string[];
  notCheckedReason?: string;
  notCheckedDetail?: string;
}

function claimVerificationStatusWord(status: string, language: OutputLanguage): string {
  switch (status) {
    case 'passed': return localize(language, '通过', 'passed');
    case 'failed': return localize(language, '未通过', 'failed');
    case 'partial': return localize(language, '未完成', 'incomplete');
    case 'not_checked': return localize(language, '未核验', 'not checked');
    default: return status;
  }
}

function globalClaimErrorLabel(code: string, language: OutputLanguage): string {
  switch (code) {
    case 'semantic_undeclared_claim': return localize(language, '正文含未声明的断言', 'the body contains undeclared assertions');
    case 'binding_ineligible': return localize(language, '声明或绑定校验存在未关联到具体断言的错误',
      'a declaration or binding check failed outside any claim');
    default: return localize(language, `未归类的检查未通过（${code}）`, `an unclassified check failed (${code})`);
  }
}

/**
 * The one claim-count line shared by the CLI and the HTML report. It keeps apart
 * what used to be folded into "verified": claims whose references matched the
 * captured cells, propositions a finite proof established, and claims the whole
 * review verified. Contradictions and whole-answer failures are named on their
 * own, and the review's not-checked reason is kept in every status.
 */
export function claimVerificationStatusLine(
  summary: ClaimVerificationStatusSummary | undefined,
  language: OutputLanguage,
): string | undefined {
  if (!summary?.status) return undefined;
  const total = summary.totalClaimCount ?? 0;
  const parts: string[] = [];
  if (total === 0) {
    parts.push(localize(language, '无结构化断言', 'no structured claims'));
  } else {
    if (summary.referencesMatchedClaimCount !== undefined) {
      parts.push(localize(language, `引用匹配 ${summary.referencesMatchedClaimCount}/${total}`,
        `references matched ${summary.referencesMatchedClaimCount}/${total}`));
    }
    if (summary.propositionProvedClaimCount !== undefined) {
      parts.push(localize(language, `命题证明 ${summary.propositionProvedClaimCount}/${total}`,
        `propositions proved ${summary.propositionProvedClaimCount}/${total}`));
    }
    const verified = summary.verifiedClaimCount ?? 0;
    parts.push(localize(language, `已核验 ${verified}/${total}`, `verified ${verified}/${total}`));
    const contradicted = summary.unsupportedClaimCount ?? 0;
    if (contradicted > 0) parts.push(localize(language, `矛盾 ${contradicted}`, `contradicted ${contradicted}`));
    const notChecked = summary.notCheckedClaimCount ?? 0;
    if (notChecked > 0) parts.push(localize(language, `未进入核验 ${notChecked}`, `not admitted ${notChecked}`));
  }
  const globalErrors = [...new Set(summary.globalErrorCodes ?? [])].map(code => globalClaimErrorLabel(code, language));
  if (globalErrors.length) {
    parts.push(localize(language, `另: ${globalErrors.join('；')}`, `also: ${globalErrors.join('; ')}`));
  }
  const explanation = claimVerificationNotCheckedExplanation(summary, language);
  const detail = explanation ? localize(language, `（${explanation}）`, ` (${explanation})`) : '';
  return `${localize(language, '断言核验', 'Claim verification')}: ` +
    `${claimVerificationStatusWord(summary.status, language)} — ${parts.join(' · ')}${detail}`;
}

/**
 * Receipt claim-audit rows in the same vocabulary as the status line. Receipts
 * written before the reference/proof counts existed simply omit those rows.
 */
export function claimAuditRows(
  claimAudit: AnalysisReceipt['claimAudit'],
  language: OutputLanguage,
): Array<[string, number]> {
  return [
    [localize(language, '断言总数', 'Total claims'), claimAudit.totalClaims],
    ...(claimAudit.referencesMatchedClaims !== undefined
      ? [[localize(language, '引用匹配', 'References matched'), claimAudit.referencesMatchedClaims] as [string, number]] : []),
    ...(claimAudit.propositionProvedClaims !== undefined
      ? [[localize(language, '命题证明', 'Propositions proved'), claimAudit.propositionProvedClaims] as [string, number]] : []),
    [localize(language, '已核验', 'Verified'), claimAudit.verifiedClaims],
    [localize(language, '矛盾', 'Contradicted'), claimAudit.unsupportedClaims],
    [localize(language, '未确定', 'Uncertain'), claimAudit.uncertainClaims],
  ];
}

/**
 * Why claims were not checked, with the closed-vocabulary detail codes when
 * present. Shared by the CLI status line and the HTML report so both name the
 * same cause.
 */
export function claimVerificationNotCheckedExplanation(
  verification: {notCheckedReason?: string; notCheckedDetail?: string} | undefined,
  language: OutputLanguage,
): string | undefined {
  const notCheckedReason = verification?.notCheckedReason;
  if (!notCheckedReason) return undefined;
  const reason = (() => {
    switch (notCheckedReason) {
      case 'invalid_declarations': return localize(language, '结论声明格式无效，断言未进入核验', 'the conclusion declaration was invalid, so no claim was admitted');
      case 'timeout': return localize(language, '语义复核超出时间预算', 'semantic review ran out of time');
      case 'provider_error': return localize(language, '语义复核调用失败', 'the semantic review call failed');
      case 'invalid_response': return localize(language, '语义复核结果无法完整解析', 'the semantic review response could not be fully parsed');
      case 'invalid_snapshot': return localize(language, '核验输入不完整', 'the verification input was incomplete');
      case 'complete_proposition_review_unavailable': return localize(language, '完整命题复核不可用', 'complete proposition review was unavailable');
      default: return notCheckedReason;
    }
  })();
  return verification.notCheckedDetail
    ? localize(language, `${reason}：${verification.notCheckedDetail}`, `${reason}: ${verification.notCheckedDetail}`)
    : reason;
}

interface SummarizableClaimResult {
  claimId?: string;
  status: string;
  referenceCells?: readonly {status: string}[];
  referenceResults?: readonly {status: string}[];
  deterministicProof?: {status: string};
}

/**
 * A claim's reference statuses. verifier@2 records them as `referenceCells`;
 * older results as `referenceResults`. Every producer sets `schemaVersion`
 * (@1 or @2), so the fallback order only matters for a malformed result, where
 * the older field is read first, as the quality gate always has.
 */
export function claimReferences<T>(
  verification: {schemaVersion?: string},
  claim: {referenceCells?: readonly T[]; referenceResults?: readonly T[]},
): readonly T[] {
  return verification.schemaVersion === 'claim_verifier@2'
    ? claim.referenceCells ?? claim.referenceResults ?? []
    : claim.referenceResults ?? claim.referenceCells ?? [];
}

/** Display counts come from the claim results themselves, never from a stored count. */
export function summarizeClaimVerification(verification: {
  status: string; schemaVersion?: string; unsupportedClaimCount?: number;
  notCheckedReason?: string; notCheckedDetail?: string;
  claimResults?: readonly SummarizableClaimResult[];
  issues?: readonly {claimId?: string; severity?: string; code?: string}[];
} | undefined): (ClaimVerificationStatusSummary & {issueCount: number}) | undefined {
  if (!verification) return undefined;
  const claims = verification.claimResults ?? [];
  const claimIds = new Set(claims.map(claim => claim.claimId).filter((id): id is string => Boolean(id)));
  const globalErrorCodes = [...new Set((verification.issues ?? []).flatMap(issue =>
    issue.severity === 'error' && typeof issue.code === 'string' && !(issue.claimId && claimIds.has(issue.claimId))
      ? [issue.code] : []))];
  // Finite proof exists only in verifier@2 results; older results never claim a proof count.
  const hasProofs = claims.some(claim => claim.deterministicProof !== undefined);
  return {
    status: verification.status,
    totalClaimCount: claims.length,
    checkedClaimCount: claims.filter(claim => claim.status !== 'not_checked').length,
    verifiedClaimCount: claims.filter(claim => claim.status === 'verified').length,
    unsupportedClaimCount: claims.filter(claim => claim.status === 'unsupported').length,
    referencesMatchedClaimCount: claims.filter(claim => {
      const cells = claimReferences(verification, claim);
      return cells.length > 0 && cells.every(cell => cell.status === 'matched');
    }).length,
    ...(hasProofs ? {propositionProvedClaimCount: claims.filter(claim => claim.deterministicProof?.status === 'proved').length} : {}),
    notCheckedClaimCount: claims.filter(claim => claim.status === 'not_checked').length,
    ...(globalErrorCodes.length ? {globalErrorCodes} : {}),
    ...(verification.notCheckedReason ? {notCheckedReason: verification.notCheckedReason} : {}),
    ...(verification.notCheckedDetail ? {notCheckedDetail: verification.notCheckedDetail} : {}),
    issueCount: verification.issues?.length ?? 0,
  };
}

export type DeliveryVerdict = 'completed' | 'unverified' | 'partial' | 'failed';

/**
 * One classification of a finished turn for terminal markers.
 *
 * The Web panel (analysisCompletedResultStatus) shows `partial` for everything
 * that is not a clean completion: an unfinished run, a failed quality gate,
 * incomplete delivery assurance, or an ineligible declaration. The CLI splits
 * that set in two so its marker says which one happened — `partial` for an
 * unfinished run or claims that contradict the evidence, `unverified` for a
 * delivered answer whose checks did not complete. Round 60 printed the same
 * `!` for both, and a green tick for answers with zero verified claims.
 */
export function deriveDeliveryVerdict(result: {
  success?: boolean;
  partial?: boolean;
  deliveryAssurance?: Partial<Pick<AnalysisDeliveryAssurance, 'completion' | 'claims' | 'source' | 'identity' | 'report'>>;
  conclusionContract?: {bindingEligibility?: string} | null;
  claimSupport?: readonly {bindingEligibility?: string}[];
}): DeliveryVerdict {
  if (result.success === false) return 'failed';
  if (result.partial) return 'partial';
  const assurance = result.deliveryAssurance;
  const incomplete = Boolean(assurance && (['completion', 'claims', 'source', 'identity', 'report'] as const)
    .some(key => assurance[key] === 'failed' || assurance[key] === 'coverage_incomplete'));
  const ineligible = result.conclusionContract?.bindingEligibility === 'ineligible' ||
    Boolean(result.claimSupport?.some(claim => claim.bindingEligibility === 'ineligible'));
  return incomplete || ineligible ? 'unverified' : 'completed';
}
