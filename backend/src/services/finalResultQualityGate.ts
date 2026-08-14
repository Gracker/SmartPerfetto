// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AgentRuntimeAnalysisResult } from '../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {
  QUICK_TRIAGE_MAX_CHINESE_CHARS,
  QUICK_TRIAGE_MAX_CLAIMS,
} from '../agentv3/quickAnswerContract';
import { assessFinalReportContractCompleteness } from './finalReportContractGate';

export type FinalResultQualityIssueCode =
  | 'empty_conclusion'
  | 'plan_summary_fallback'
  | 'process_narration_conclusion'
  | 'missing_final_report_heading'
  | 'sparse_unverified_conclusion'
  | 'quick_full_report_shape'
  | 'quick_verifier_failed'
  | 'scene_contract_incomplete'
  | 'comparison_identity_incomplete'
  | 'kernel_blocking_claim_boundary';

export interface FinalResultQualityIssue {
  code: FinalResultQualityIssueCode;
  message: string;
  offendingStatement?: string;
}

export interface FinalResultComparisonIdentity {
  currentPackageName?: string;
  referencePackageName?: string;
}

function safeComparisonPackageName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f`]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function completeFinalResultComparisonIdentity(input: {
  conclusion: string;
  identity?: FinalResultComparisonIdentity;
  outputLanguage: OutputLanguage;
}): string {
  const currentPackageName = safeComparisonPackageName(input.identity?.currentPackageName);
  const referencePackageName = safeComparisonPackageName(input.identity?.referencePackageName);
  if (!currentPackageName || !referencePackageName) return input.conclusion;
  if (
    input.conclusion.includes(currentPackageName) &&
    input.conclusion.includes(referencePackageName)
  ) {
    return input.conclusion;
  }

  const identitySection = [
    `## ${localize(input.outputLanguage, '对比对象', 'Comparison targets')}`,
    '',
    `- ${localize(input.outputLanguage, '当前侧包名', 'Current package')}: \`${currentPackageName}\``,
    `- ${localize(input.outputLanguage, '参考侧包名', 'Reference package')}: \`${referencePackageName}\``,
  ].join('\n');
  const conclusion = input.conclusion.trim();
  return conclusion ? `${conclusion}\n\n${identitySection}` : identitySection;
}

const FINAL_RESULT_QUALITY_GATE_MESSAGE =
  '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论；本次结果已标记为 partial，避免把降级文本当作正常完成。';
const FINAL_RESULT_OFFENDING_STATEMENT_MAX_CHARS = 1200;

export function serializeFinalResultQualityIssueContext(issue: FinalResultQualityIssue): string {
  return issue.offendingStatement
    ? `${issue.message}\n\n${JSON.stringify(issue.offendingStatement)}`
    : issue.message;
}

const ANALYSIS_QUERY_MARKERS = [
  '分析',
  '诊断',
  '为什么',
  '原因',
  '根因',
  '卡顿',
  '掉帧',
  '慢',
  '耗时高',
  '瓶颈',
  '性能问题',
  'analyze',
  'diagnose',
  'why',
  'root cause',
  'performance issue',
  'slow',
  'bottleneck',
  'jank',
  'anr',
];

const DEEP_ANALYSIS_QUERY_MARKERS = [
  '分析',
  '诊断',
  '为什么',
  '原因',
  '根因',
  '性能问题',
  'analyze',
  'diagnose',
  'why',
  'root cause',
  'performance issue',
];

const FACTUAL_QUERY_MARKERS = [
  '哪个',
  '哪一',
  '是什么',
  '多少',
  '列出',
  'package',
  'pid',
  'tid',
  'what',
  'which',
  'how many',
];

function normalizeTextForQualityCheck(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function splitQualityStatements(text: string): string[] {
  const statements: string[] = [];
  let statementStart = 0;
  let markdownCodeDelimiterLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '`') {
      let delimiterEnd = index + 1;
      while (text[delimiterEnd] === '`') delimiterEnd += 1;
      const delimiterLength = delimiterEnd - index;
      if (markdownCodeDelimiterLength === 0) {
        markdownCodeDelimiterLength = delimiterLength;
      } else if (markdownCodeDelimiterLength === delimiterLength) {
        markdownCodeDelimiterLength = 0;
      }
      index = delimiterEnd - 1;
      continue;
    }
    if (markdownCodeDelimiterLength > 0 && (
      markdownCodeDelimiterLength < 3 || character !== '\n'
    )) continue;
    const isDecimalPoint = character === '.' &&
      /\d/.test(text[index - 1] || '') &&
      /\d/.test(text[index + 1] || '');
    if (isDecimalPoint || !/[\n。！？.!?]/.test(character)) continue;
    const statement = text.slice(statementStart, index).trim();
    if (statement) statements.push(statement);
    statementStart = index + 1;
  }
  const remaining = text.slice(statementStart).trim();
  if (remaining) statements.push(remaining);
  return statements;
}

function boundedOffendingStatement(statement: string): string | undefined {
  const normalized = statement.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.length <= FINAL_RESULT_OFFENDING_STATEMENT_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, FINAL_RESULT_OFFENDING_STATEMENT_MAX_CHARS - 1)}…`;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length || 0;
}

function collectMarkdownSections(text: string): Array<{ heading: string; body: string }> {
  const headingPattern = /(^|\n)\s*#{1,3}\s+([^\n]+)/g;
  const matches = [...text.matchAll(headingPattern)];
  return matches.map((match, index) => {
    const headingStart = (match.index || 0) + match[1].length;
    const bodyStart = headingStart + match[0].slice(match[1].length).length;
    const nextStart = matches[index + 1]?.index ?? text.length;
    return {
      heading: match[2].trim(),
      body: text.slice(bodyStart, nextStart).trim(),
    };
  });
}

function isFallbackSummaryHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/[：:]\s*$/, '').toLowerCase();
  return normalized === '综合结论' ||
    normalized === '分阶段证据摘要' ||
    normalized === 'final conclusion' ||
    normalized === 'evidence summary by phase';
}

function isHeadingLine(line: string, labelPattern: string): boolean {
  return new RegExp(
    `^\\s*(?:#{1,3}\\s*)?(?:${labelPattern})(?:\\s*[：:])?\\s*$`,
    'i',
  ).test(line);
}

function matchHeadingWithTail(line: string, labelPattern: string): string | undefined {
  const match = line.match(new RegExp(
    `^\\s*(?:#{1,6}\\s*)?(?:${labelPattern})(?:\\s*[：:])?\\s*(.*)$`,
    'i',
  ));
  return match ? match[1].trim() : undefined;
}

function looksLikePhaseSummaryEntry(line: string): boolean {
  return /^\s*(?:[-*]\s*|\d+[.)、]\s*)?[^：:\n]{1,80}[：:]\s+\S/.test(line);
}

function countPhaseSummaryEntries(text: string): number {
  const lines = text.split(/\r?\n/);
  let inPhaseSummary = false;
  let count = 0;
  for (const line of lines) {
    const phaseSummaryTail = matchHeadingWithTail(line, '分阶段证据摘要|Evidence Summary By Phase');
    if (phaseSummaryTail !== undefined) {
      inPhaseSummary = true;
      if (looksLikePhaseSummaryEntry(phaseSummaryTail)) count++;
      continue;
    }
    if (!inPhaseSummary) continue;
    if (/^\s*#{1,6}\s+\S/.test(line)) break;
    if (looksLikePhaseSummaryEntry(line)) {
      count++;
    }
  }
  return count;
}

function hasEvidenceReferenceText(text: string): boolean {
  return countMatches(
    text,
    /(?:\bart-\d+\b|\bdata:[a-z0-9_:-]+\b|\bevidence[_-]?ref\b|\bsource_tool_call_id\b|证据\s*ID)/gi,
  ) > 0;
}

function hasConcreteEvidenceText(text: string): boolean {
  if (hasEvidenceReferenceText(text)) return true;

  const metricCount = countMatches(
    text,
    /\b(?:TTID|dur(?:ation)?|self_ms|total_ms|Running|Runnable|blocked|binder|GC|CPU|Q[1-4][ab]?)\b|(?:\d+(?:\.\d+)?\s*(?:ms|s|%|fps|MB|GHz|MHz))/gi,
  );
  return metricCount >= 3;
}

function hasReportStructureMarker(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(text) ||
    /(^|\n)\s{0,3}\*\*[^*\n]{2,80}\*\*/.test(text) ||
    /(^|\n)\s{0,3}\|/.test(text);
}

export function hasDeliverableFinalReportHeading(text: string): boolean {
  return /(^|\n)\s{0,3}(?:#{1,3}\s*)?(?:(?:[^\n#]{0,40})?分析报告|综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause)(?=\s|[：:。.!！?\n]|$)/i.test(text);
}

export function stripLeadingProcessNarrationFromFinalReport(text: string): string {
  const conclusion = text.trim();
  if (!looksLikeProcessNarrationConclusion(conclusion)) return conclusion;

  const heading = conclusion.match(
    /(^|\n)\s{0,3}(?:#{1,3}\s*)?(?:(?:[^\n#]{0,40})?分析报告|综合结论|关键结论|最终结论|最终报告|根因分析|Final Conclusion|Final Report|Analysis Report|Root Cause)(?=\s|[：:。.!！?\n]|$)/i,
  );
  if (heading?.index === undefined) return conclusion;
  const headingStart = heading.index + (heading[1]?.length ?? 0);
  return conclusion.slice(headingStart).trim();
}

export function looksLikeProcessNarrationConclusion(conclusion: string): boolean {
  const text = normalizeTextForQualityCheck(conclusion);
  if (!text) return false;

  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(text) ||
    /(?:现在|接下来|下一步).{0,40}(?:完成|进入|继续).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(text) ||
    /(?:现在完成|现在进入|进入|继续执行).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(text) ||
    /(?:update_plan_phase|submit_plan|resolve_hypothesis|阶段状态更新|执行剩余阶段|继续执行剩余阶段|OpenAI plan|provider 未主动结束 stream|plan 未完成|plan 已完成)/i.test(text);
}

function collectIndependentEvidenceSectionText(text: string): string {
  const lines = text.split(/\r?\n/);
  const sections: string[] = [];
  let collecting = false;
  const independentHeadingPattern =
    '关键证据链|证据链|关键证据|根因拆解|优化建议|风险与不确定性|Evidence Chain|Key Evidence|Root Cause|Recommendations|Risks';

  for (const line of lines) {
    if (matchHeadingWithTail(line, '综合结论|Final Conclusion') !== undefined ||
        matchHeadingWithTail(line, '分阶段证据摘要|Evidence Summary By Phase') !== undefined) {
      collecting = false;
      continue;
    }

    const independentTail = matchHeadingWithTail(line, independentHeadingPattern);
    if (independentTail !== undefined) {
      collecting = true;
      if (independentTail) sections.push(independentTail);
      continue;
    }

    if (collecting && (
      /^\s*#{1,6}\s+\S/.test(line) ||
      /^\s*\S.{0,60}[：:]\s*$/.test(line)
    )) {
      collecting = false;
      continue;
    }

    if (collecting) sections.push(line);
  }

  return sections.join('\n').trim();
}

export function looksLikePhaseSummaryFallback(conclusion: string): boolean {
  const text = conclusion.trim();
  if (!text) return false;

  const hasConclusionHeading = /(^|\n)\s*(?:#{1,3}\s*)?(综合结论|Final Conclusion)(?:\s*[：:])?/i.test(text);
  const hasPhaseSummaryHeading = /(^|\n)\s*(?:#{1,3}\s*)?(分阶段证据摘要|Evidence Summary By Phase)(?:\s*[：:])?/i.test(text);
  if (!hasConclusionHeading || !hasPhaseSummaryHeading) return false;

  if (countPhaseSummaryEntries(text) < 1) return false;

  const nonFallbackSections = collectMarkdownSections(text)
    .filter(section => !isFallbackSummaryHeading(section.heading));
  const independentEvidenceText = collectIndependentEvidenceSectionText(text);
  if (independentEvidenceText && hasConcreteEvidenceText(independentEvidenceText)) {
    return false;
  }
  if (nonFallbackSections.length === 0) return true;

  return !hasConcreteEvidenceText(
    nonFallbackSections.map(section => `${section.heading}\n${section.body}`).join('\n\n'),
  );
}

function looksLikeAnalysisQuery(query: string | undefined): boolean {
  const normalized = normalizeTextForQualityCheck(String(query || '')).toLowerCase();
  if (!normalized) return true;
  const asksFactualQuestion = FACTUAL_QUERY_MARKERS.some(marker => normalized.includes(marker));
  const asksDeepAnalysis = DEEP_ANALYSIS_QUERY_MARKERS.some(marker => normalized.includes(marker));
  if (asksFactualQuestion && !asksDeepAnalysis) return false;
  return ANALYSIS_QUERY_MARKERS.some(marker => normalized.includes(marker));
}

function hasSupportedClaimVerification(result: AgentRuntimeAnalysisResult): boolean {
  const status = result.claimVerificationResult?.status;
  if (status === 'passed') return true;
  if (status !== 'partial') return false;
  return result.claimVerificationResult?.claimResults?.some(claim =>
    claim.status === 'verified' || claim.status === 'partial' || claim.status === 'inference'
  ) === true;
}

function conclusionContractHasEvidence(result: AgentRuntimeAnalysisResult): boolean {
  const contract = result.conclusionContract;
  if (!contract) return false;
  if (Array.isArray(contract.evidenceChain) && contract.evidenceChain.length > 0) return true;
  return Array.isArray(contract.claims) &&
    contract.claims.some(claim =>
      (Array.isArray(claim.references) && claim.references.length > 0) ||
      (Array.isArray(claim.artifactRefs) && claim.artifactRefs.length > 0) ||
      (Array.isArray(claim.relationRefs) && claim.relationRefs.length > 0)
    );
}

function hasEvidenceBackedArtifacts(result: AgentRuntimeAnalysisResult): boolean {
  return Boolean(
    conclusionContractHasEvidence(result) ||
    (Array.isArray(result.claimSupport) && result.claimSupport.some(claim =>
      claim.supportLevel === 'verified' ||
      claim.supportLevel === 'partial' ||
      claim.supportLevel === 'inference'
    )) ||
    hasSupportedClaimVerification(result),
  );
}

function isQuickRunResult(result: AgentRuntimeAnalysisResult): boolean {
  return result.quickRun?.resolvedMode === 'quick';
}

function removeNegatedFullReportBoundaryText(text: string): string {
  return text
    .replace(
      /(?:不(?:等同于|是|代表|应被视为)|并非|不能(?:作为|当作)?|不可(?:作为|当作)?|不是).{0,24}(?:完整|全面|全景).{0,40}(?:诊断|分析|报告)/g,
      '',
    )
    .replace(
      /(?:not|isn't|doesn't|should\s+not|cannot|can't).{0,30}(?:full|complete|comprehensive).{0,50}(?:diagnosis|analysis|report)/gi,
      '',
    );
}

function looksLikeOverExpandedQuickReport(
  result: AgentRuntimeAnalysisResult,
  conclusion: string,
): boolean {
  if (!isQuickRunResult(result)) return false;
  const reportShapeText = removeNegatedFullReportBoundaryText(conclusion);
  const headingCount = countMatches(reportShapeText, /(^|\n)\s{0,3}#{1,3}\s+\S/g);
  const claimCount = result.conclusionContract?.claims?.length ?? 0;
  const hasFullReportLanguage =
    /(?:完整|全面|全景).{0,16}(?:诊断|分析|报告)|(?:full|complete|comprehensive).{0,20}(?:diagnosis|analysis|report)/i.test(reportShapeText) ||
    /(^|\n)\s{0,3}#{1,3}\s*[^\n]{0,40}(?:完整诊断报告|完整分析报告|综合诊断报告|Full Report|Comprehensive Report)/i.test(reportShapeText);
  const triageOverBudget = result.quickRun?.profile === 'triage' &&
    reportShapeText.length > QUICK_TRIAGE_MAX_CHINESE_CHARS * 2;
  const triageContractOverrun = result.quickRun?.profile === 'triage' &&
    (headingCount > 2 || claimCount > QUICK_TRIAGE_MAX_CLAIMS);
  return hasFullReportLanguage || triageOverBudget || triageContractOverrun || headingCount >= 6 || reportShapeText.length > 3600;
}

const IO_DOMAIN_LANGUAGE_PATTERN =
  /(?:\bio\b|i\/o|磁盘|存储|文件\s*i\/?o|io_wait|io wait|disk|storage)/i;

function hasIoDomainLanguage(text: string): boolean {
  return IO_DOMAIN_LANGUAGE_PATTERN.test(text);
}

function hasPollIoCausalLanguage(text: string): boolean {
  return (
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)/i.test(text) &&
    hasIoDomainLanguage(text) &&
    /(?:根因|证明|导致|阻塞|等待|瓶颈|卡顿|慢|root cause|cause|proves?)/i.test(text)
  );
}

function reversesPollIoQualifier(claim: string): boolean {
  const normalized = claim.toLowerCase().replace(/[\s`*_#()[\]{}:：|]+/g, '');
  return /(?:并非|不是)(?:不能|无法|不可)|(?:不能|无法|不可)不(?:将其|把它|把该信号)?/i.test(normalized);
}

function hasPositivePollIoAttribution(text: string): boolean {
  let pollAntecedentAvailable = false;
  return text.split(/[,，;；]/).some(clause => {
    const pollMatches = Array.from(clause.matchAll(
      /(?:do_epoll_wait|epoll_wait|ep_poll|__pollwait|epoll|poll)/gi,
    ));
    const strongClaims = Array.from(clause.matchAll(
      /(?:证明|说明|表明|导致|构成|认定(?:为)?|归因(?:为)?|proves?|shows?|demonstrates?|indicates?|(?<!root[\s-])causes?|constitutes?|establishes?)[^。！？.!?\n]{0,60}?(?:磁盘\s*(?:io|i\/o)|存储\s*(?:io|i\/o)|disk\s*(?:io|i\/o)|storage\s*(?:io|i\/o)|io|i\/o|磁盘|存储|根因|卡顿|瓶颈|启动慢|disk|storage|root\s+cause|stall|slowdown|latency)|(?:仍|还是|依然)?\s*(?:是|属于)\s*[^。！？.!?\n]{0,40}?(?:io|i\/o|磁盘|存储)[^。！？.!?\n]{0,20}?根因|(?:is|are)(?!\s+not)\s+(?:still\s+)?(?:the\s+)?[^.!?\n]{0,40}?(?:io|i\/o|disk|storage)[^.!?\n]{0,20}?root\s+cause/gi,
    ));
    if (pollMatches.length > 0) {
      pollAntecedentAvailable = true;
    } else if (pollAntecedentAvailable) {
      const firstStrongClaim = strongClaims[0];
      const possibleSubject = firstStrongClaim?.index === undefined
        ? clause
        : clause.slice(0, firstStrongClaim.index);
      const hasExplicitCoreference = /(?:它|这|该信号|这个信号|此信号|这个证据|该证据|此证据|\bit\b|\bthis(?:\s+(?:signal|evidence))?\b|\bthat\s+(?:signal|evidence)\b)/i.test(possibleSubject);
      if (!hasExplicitCoreference && !hasOnlyDiscoursePrefix(possibleSubject)) {
        pollAntecedentAvailable = false;
      }
    }
    if (strongClaims.length === 0 || !pollAntecedentAvailable) {
      return false;
    }
    return strongClaims.some(strongClaim => {
      if (strongClaim.index === undefined) return false;
      const precedingPolls = pollMatches.filter(
        pollMatch => pollMatch.index !== undefined && pollMatch.index < strongClaim.index,
      );
      const nearestPoll = precedingPolls[precedingPolls.length - 1];
      const predicateQualifierStart = nearestPoll?.index !== undefined
        ? nearestPoll.index + nearestPoll[0].length
        : Math.max(0, strongClaim.index - 24);
      const predicateQualifier = clause.slice(
        predicateQualifierStart,
        strongClaim.index,
      );
      const claimObjectSuffix = clause.slice(
        strongClaim.index + strongClaim[0].length,
        strongClaim.index + strongClaim[0].length + 40,
      );
      const hasTentativePredicate = /(?:可能|或许|也许|may|might|could|possibly|potentially)\s*$/i.test(
        predicateQualifier,
      );
      const hasCandidateObject = /^\s*(?:(?:only|merely)\s+)?(?:as\s+)?(?:a\s+)?candidate\b|^\s*(?:仅|只是|只)?(?:为|是)?\s*(?:候选|可能性)/i.test(
        claimObjectSuffix,
      );
      if (hasTentativePredicate || hasCandidateObject) return false;

      const predicatePrefix = clause.slice(0, strongClaim.index);
      const compactPrefix = predicatePrefix
        .toLowerCase()
        .replace(/[\s`*_#()[\]{}:：|]+/g, '');
      const doubleNegation = /(?:并非不|不是不|不能不|无法不|不可不)|\b(?:doesnot|isnot|cannot)not\b/i.test(compactPrefix);
      const directlyNegated = !doubleNegation &&
        /(?:不能|无法|不可|并非|不是|不)(?:直接|足以|明确|真正|conclusively|directly|necessarily)?$/i.test(compactPrefix);
      if (directlyNegated) return false;

      if (nearestPoll?.index !== undefined) {
        if (doubleNegation) return true;
        const subjectRemainder = predicatePrefix.slice(
          nearestPoll.index + nearestPoll[0].length,
        );
        return hasOnlyDiscoursePrefix(subjectRemainder);
      }

      return hasExplicitKernelIoCoreferenceCausalLanguage(clause) ||
        hasOnlyDiscoursePrefix(predicatePrefix);
    });
  });
}

function hasPriorPositivePollIoAttribution(claim: string): boolean {
  const qualifierMatches = Array.from(claim.matchAll(
    /(?<!并非)(?<!不是)(?:不能|无法|不可)(?!\s*不)/gi,
  )).filter(match => {
    if (match.index === undefined) return false;
    return /^(?:不能|无法|不可)[^。！？.!?\n]{0,30}?(?:归为|归因(?:为)?|认定(?:为)?)[^。！？.!?\n]{0,20}?(?:io|i\/o)(?:\s*根因)?/i.test(
      claim.slice(match.index, match.index + 80),
    );
  });
  const qualifierMatch = qualifierMatches[qualifierMatches.length - 1];
  if (!qualifierMatch || qualifierMatch.index === undefined) return false;
  return hasPositivePollIoAttribution(claim.slice(0, qualifierMatch.index));
}

const QUALIFIED_KERNEL_IO_ANTECEDENT = '__qualified_kernel_io_antecedent__';
const QUALIFIED_BLOCKED_FUNCTION_ANTECEDENT = '__qualified_stack_antecedent__';

function hasOnlyDiscoursePrefix(text: string): boolean {
  const remainder = text
    .toLowerCase()
    .replace(/(?:尽管如此|即便如此|话虽如此|但是|然而|不过|可是|因此|所以|相反|反而|依然|还是|仍然|并且|从而|进而|继而|由此|仍|但|而|并|却|故|足以|直接)/g, ' ')
    .replace(/\b(?:even\s+so|despite\s+that|but|however|yet|nevertheless|nonetheless|therefore|thus|conversely|thereby|consequently|hence|still|directly|although|and)\b/g, ' ')
    .replace(/[\s`*_#()[\]{}:：,，;；.!?。！？—-]+/g, '');
  return remainder.length === 0;
}

function removeExplicitPollEvidenceExclusions(statement: string): string {
  let remaining = statement;
  const exclusionClauses = [
    /(?:未|没有)(?:命中|发现)[^,，;；。！？.!?\n]{0,80}/gi,
    /no\s+[^,;.!?\n]{0,80}(?:match|hit|evidence)\b[^,;.!?\n]{0,20}/gi,
  ];

  for (const pattern of exclusionClauses) {
    remaining = remaining.replace(pattern, clause => {
      if (!/(?:epoll|poll)/i.test(clause)) return clause;
      if (/(?:之外|以外|other\s+than|except)/i.test(clause)) return clause;
      return ' ';
    });
  }

  return remaining;
}

function removeQualifiedPollIoClaims(statement: string): string {
  let remaining = removeExplicitPollEvidenceExclusions(statement);
  const appLevelBlockedFunctionExclusionPattern = /(?:(?:并非|不是)\s*)?(?:blocked_?functions?)[^。！？.!?\n]{0,40}?(?:全(?:部)?为|均为|=)\s*null[^。！？.!?\n]{0,120}?(?:应用层[^。！？.!?\n]{0,20})?(?:主动)?等待[^。！？.!?\n]{0,80}?(?:非|并非|不是)\s*系统[^。！？.!?\n]{0,60}?(?:epoll|poll)[^。！？.!?\n]{0,24}?阻塞/gi;
  remaining = remaining.replace(appLevelBlockedFunctionExclusionPattern, claim => {
    const reversedAbsence = /(?:并非|不是)[^。！？.!?\n]{0,24}(?:blocked_?functions?)?[^。！？.!?\n]{0,12}(?:全(?:部)?为|均为)\s*null|(?:blocked_?functions?)[^。！？.!?\n]{0,16}(?:并非|不是|不为)\s*null/i.test(claim);
    if (reversedAbsence || hasPositivePollIoAttribution(claim)) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const unavailablePollEvidencePattern = /(?:blocked_reason|blocked_function|wchan)[^。！？.!?\n]{0,80}?(?:null|缺失|未采集|不可用)[^。！？.!?\n]{0,120}?(?:无法|不能|不可)(?:判定|确认|区分)[^。！？.!?\n]{0,120}?(?:epoll|poll)[^。！？.!?\n]{0,120}?(?:不能|无法|不可)[^。！？.!?\n]{0,30}?(?:归为|归因(?:为)?|认定(?:为)?)[^。！？.!?\n]{0,20}?(?:io|i\/o)(?:\s*根因)?/gi;
  remaining = remaining.replace(unavailablePollEvidencePattern, claim => {
    if (
      reversesPollIoQualifier(claim) ||
      hasPriorPositivePollIoAttribution(claim)
    ) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const unavailablePollCandidatePattern = /(?:blocked_reason|blocked_function|wchan)[^。！？!?\n]{0,80}?(?:null|缺失|未采集|不可用|missing|unavailable)[^。！？!?\n]{0,120}?(?:无法|不能|不可|unable|cannot)[^。！？!?\n]{0,60}?(?:追踪|判定|确认|区分|trace|determine|confirm|distinguish)[^。！？!?\n]{0,120}?(?:可能|候选|possible|may|might|candidate)[^。！？!?\n]{0,120}?(?:epoll|poll)[^。！？!?\n]{0,80}?(?:等待事件|事件等待|空闲|event\s+wait|idle)/gi;
  remaining = remaining.replace(unavailablePollCandidatePattern, claim => {
    if (
      reversesPollIoQualifier(claim) ||
      hasPriorPositivePollIoAttribution(claim) ||
      hasPositivePollIoAttribution(claim)
    ) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const sleepingPollAmbiguityPattern = /(?:Sleeping|睡眠)(?:\s*状态)?[^,，;；。！？.!?\n]{0,30}?(?:不等于|并非|不是)\s*(?:io|i\/o)[^,，;；。！？.!?\n]{0,40}?(?:无法|不能|不可)(?:确认|判定|区分)[^,，;；。！？.!?\n]{0,40}?(?:epoll|poll)[^,，;；。！？.!?\n]{0,30}?(?:等待事件|事件等待|空闲)/gi;
  remaining = remaining.replace(sleepingPollAmbiguityPattern, claim => {
    if (
      /(?:并非|不是)\s*不等于/i.test(claim) ||
      hasPositivePollIoAttribution(claim)
    ) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const qualifiedClaimPatterns = [
    /(?:blocked_reason|blocked_function|wchan)[^;；。！？.!?\n]{0,80}?(?:可区分|用于区分|区分为)[^,，;；。！？.!?\n]{0,100}?(?:epoll|poll)[^,，;；。！？.!?\n]{0,30}?(?:等待|空闲)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,，;；。！？.!?\n]{0,60}?(?:不是|并非|不能|不可|不应|无法|不作为|已排除|排除|不等于|不足以)[^,，;；。！？.!?\n]{0,60}?(?:io|i\/o|磁盘|存储|根因)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,，;；。！？.!?\n]{0,60}?(?:只是|仅是|仅表示|表示为|属于|(?:(?:通常|一般)\s*)?表示)[^,，;；。！？.!?\n]{0,40}?(?:等待事件(?:或空闲)?|空闲|poll_idle|候选|可疑)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?(?:cannot|can't|does\s+not|doesn't)\s+(?:(?:by\s+itself|alone|directly|necessarily|conclusively)\s+)?(?:be\s+used\s+to\s+)?(?:prove|establish|show|demonstrate|mean|constitute|imply|indicate)[^,;.!?\n]{0,60}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?not\s+(?:an?\s+)?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?(?:alone\s+)?(?:is|are)\s+(?:insufficient|not\s+sufficient)(?:\s+evidence)?\s+to\s+(?:prove|establish|show|demonstrate|imply|indicate)[^,;.!?\n]{0,60}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,40}?neither\s+(?:proves?|establishes?|shows?|demonstrates?|implies?|indicates?)\s+nor\s+(?:proves?|establishes?|shows?|demonstrates?|implies?|indicates?)[^,;.!?\n]{0,60}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?(?:must|should)\s+not\s+be\s+(?:presented|treated|interpreted|described)\s+as[^,;.!?\n]{0,40}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?(?:is|are)\s+not\s+evidence\s+(?:of|for)[^,;.!?\n]{0,40}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:epoll|poll|do_epoll_wait|ep_poll|__pollwait)[^,;.!?\n]{0,60}?(?:is|are|represents?|indicates?)[^,;.!?\n]{0,30}?(?:event\s+wait(?:\s+or\s+idle)?|idle|poll_idle|ambiguous|candidate)/gi,
  ];
  for (const pattern of qualifiedClaimPatterns) {
    remaining = remaining.replace(pattern, ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `);
  }
  return remaining;
}

function hasExplicitKernelIoCoreferenceCausalLanguage(text: string): boolean {
  return (
    /\b(?:it|this(?:\s+(?:signal|evidence))?|that\s+(?:signal|evidence))\b\s*(?:still\s+)?(?:proves?|establishes?|constitutes?|causes?)[^,;.!?\n]{0,60}(?:io|i\/o|disk|storage|root\s+cause|stall|slowdown|latency)/i.test(text) ||
    /(?:它|这|该信号|这个信号|此信号|这个证据|该证据|此证据)\s*(?:仍|还是|依然)?\s*(?:证明|导致|构成)[^,，;；。！？.!?\n]{0,60}(?:io|i\/o|磁盘|存储|根因|卡顿|瓶颈|启动慢)/i.test(text)
  );
}

function hasKernelIoCoreferenceCausalLanguage(text: string): boolean {
  if (hasExplicitKernelIoCoreferenceCausalLanguage(text)) return true;

  if (!text.includes(QUALIFIED_KERNEL_IO_ANTECEDENT)) return false;

  let antecedentAvailable = false;
  return text.split(/[,，;；]/).some(clause => {
    if (clause.includes(QUALIFIED_KERNEL_IO_ANTECEDENT)) {
      antecedentAvailable = true;
      clause = clause.slice(
        clause.lastIndexOf(QUALIFIED_KERNEL_IO_ANTECEDENT) + QUALIFIED_KERNEL_IO_ANTECEDENT.length,
      );
    }
    if (!antecedentAvailable) return false;
    const requiresMoreEvidence = /(?:需要|仍需|还需|需|补证|采集|才能|候选|可能|need|require|capture|sample|candidate|possible|may\b)/i.test(clause);
    if (requiresMoreEvidence) return false;
    const strongClaim = clause.match(
      /(?:仍|还是|依然)?\s*(?:足以|直接)?\s*(?:证明|导致|构成)[^。！？.!?\n]{0,60}(?:io|i\/o|磁盘|存储|根因|卡顿|瓶颈|启动慢)|(?:仍|还是|依然)?\s*(?<!可)(?<!但)(?<!不)(?<!只)(?:是|属于|构成)\s*(?:启动慢|卡顿|瓶颈)?[^。！？.!?\n]{0,30}根因|(?:still\s+)?(?:directly\s+)?(?:proves?|establishes?|constitutes?|causes?)[^.!?\n]{0,60}(?:io|i\/o|disk|storage|root\s+cause|stall|slowdown|latency)|(?:still\s+)?(?:is|are|constitutes?)\s+(?:the\s+)?(?:startup\s+)?root\s+cause/i,
    );
    if (!strongClaim || strongClaim.index === undefined) return false;
    const possibleSubject = clause.slice(0, strongClaim.index);
    return hasOnlyDiscoursePrefix(possibleSubject);
  });
}

const D_STATE_LANGUAGE_PATTERN =
  /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|uninterruptible\s+sleep)/i;
const D_STATE_STRONG_CAUSAL_LANGUAGE_PATTERN =
  /(?:根因|证明|导致|阻塞|瓶颈|卡顿|慢|root\s+cause|\bcauses?\b|proves?|blocking)/i;

function removeDStateTaxonomyLanguage(text: string): string {
  return text.replace(
    /(?:不可中断等待|不可中断睡眠|uninterruptible\s+(?:wait|sleep))/gi,
    '',
  );
}

function commaStartsIndependentDStateCausalItem(text: string): boolean {
  const causalText = removeDStateTaxonomyLanguage(text);
  const strongClaim = causalText.match(D_STATE_STRONG_CAUSAL_LANGUAGE_PATTERN);
  if (strongClaim?.index === undefined) return false;
  const predicatePrefix = causalText.slice(0, strongClaim.index);
  if (
    D_STATE_LANGUAGE_PATTERN.test(predicatePrefix) ||
    hasExplicitKernelIoCoreferenceCausalLanguage(causalText) ||
    hasOnlyDiscoursePrefix(predicatePrefix)
  ) {
    return false;
  }
  const hasIndependentEvidenceSubject = /(?:独立|independent|sqlite|fsync|file|database|cpu|binder|futex|lock|unwinder|perf)/i.test(
    predicatePrefix,
  );
  return hasIndependentEvidenceSubject || !hasIoDomainLanguage(predicatePrefix);
}

function splitDStateDiagnosticItems(text: string): string[] {
  const separators = Array.from(text.matchAll(/[、,，]/g));
  const items: string[] = [];
  let itemStart = 0;
  separators.forEach((separator, index) => {
    if (separator.index === undefined) return;
    const nextSeparatorIndex = separators[index + 1]?.index ?? text.length;
    const followingItem = text.slice(separator.index + 1, nextSeparatorIndex);
    const shouldSplit = separator[0] === '、' ||
      commaStartsIndependentDStateCausalItem(followingItem);
    if (!shouldSplit) return;
    items.push(text.slice(itemStart, separator.index));
    itemStart = separator.index + 1;
  });
  items.push(text.slice(itemStart));
  return items;
}

function hasDStateIoCausalLanguage(text: string): boolean {
  if (!D_STATE_LANGUAGE_PATTERN.test(text) || !hasIoDomainLanguage(text)) return false;

  let dStateAntecedentAvailable = false;
  return splitDStateDiagnosticItems(text).some(originalItem => {
    const item = removeDStateTaxonomyLanguage(originalItem);
    const hasDStateSubject = D_STATE_LANGUAGE_PATTERN.test(originalItem);
    const hasIoSubject = hasIoDomainLanguage(originalItem);
    const strongClaim = item.match(D_STATE_STRONG_CAUSAL_LANGUAGE_PATTERN);
    const hasBoundWaitClaim = hasDStateSubject && hasIoSubject && /等待/i.test(item);

    if (hasDStateSubject && hasIoSubject && (strongClaim || hasBoundWaitClaim)) {
      return true;
    }
    if (
      dStateAntecedentAvailable &&
      hasIoSubject &&
      strongClaim?.index !== undefined
    ) {
      const predicatePrefix = item.slice(0, strongClaim.index);
      const prefixWithoutIoSubject = predicatePrefix.replace(
        /(?:磁盘|存储)?\s*(?:io|i\/o)|(?:io|i\/o)\s*(?:磁盘|存储)?/gi,
        '',
      );
      if (
        hasOnlyDiscoursePrefix(prefixWithoutIoSubject) ||
        hasExplicitKernelIoCoreferenceCausalLanguage(item)
      ) {
        return true;
      }
    }

    if (hasDStateSubject) {
      dStateAntecedentAvailable = true;
    } else if (!hasOnlyDiscoursePrefix(item)) {
      dStateAntecedentAvailable = false;
    }
    return false;
  });
}

function normalizeDStateQualifierText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s`*_#()[\]{}:：|]+/g, '');
}

function reversesDStateQualifier(claim: string): boolean {
  const normalized = normalizeDStateQualifierText(claim);
  return /(?:并非|不是)(?:不能|无法|不可|证据不足|不足以|(?:因|由于)?无(?:anr)?窗口|无数据|rowcount=0|已?跳过|非(?:io|i\/o|磁盘|存储)|未达|低于|小于|不超过)|(?:并非|不是)(?:本次|当前)?trace(?:未|不能|无法)(?:直接)?证明|(?:不能|无法|不可)不|不(?:低于|小于)|rowcount!=0|(?:未|没有|不|无需)跳过|\b(?:cannot|can't)not\b|\bnot(?:skipped|rowcount=0|no(?:anr)?window|nodata)\b/i.test(normalized);
}

function projectsDStateQualifier(claim: string): boolean {
  const normalized = normalizeDStateQualifierText(claim);
  return /(?:预计|预期|目标(?:为)?|计划|可能|将|会).{0,24}(?:rowcount=0|返回0行|无(?:anr)?窗口|无数据|已?跳过)|\b(?:expected|target|planned|may|might|will)\b.{0,40}(?:rowcount=0|returned0rows|no(?:anr)?window|nodata|skipped)/i.test(normalized);
}

function hasDStateAttributionSubject(textBeforePredicate: string): boolean {
  const clauseStart = Math.max(
    textBeforePredicate.lastIndexOf(','),
    textBeforePredicate.lastIndexOf('，'),
    textBeforePredicate.lastIndexOf(';'),
    textBeforePredicate.lastIndexOf('；'),
    textBeforePredicate.lastIndexOf('。'),
    textBeforePredicate.lastIndexOf('！'),
    textBeforePredicate.lastIndexOf('？'),
    textBeforePredicate.lastIndexOf('.'),
    textBeforePredicate.lastIndexOf('!'),
    textBeforePredicate.lastIndexOf('?'),
  ) + 1;
  const clausePrefix = textBeforePredicate.slice(clauseStart);
  if (/(?:\bD-state\b|i\/?od-state|D状态|D\/DK|不可中断睡眠|Q4a)/i.test(clausePrefix)) {
    return true;
  }
  if (/(?:它|这|该信号|这个信号|此信号|这个证据|该证据|此证据|\bit\b|\bthis(?:signal|evidence)?\b|\bthat(?:signal|evidence)\b)/i.test(clausePrefix)) {
    return true;
  }

  const discourseOnly = clausePrefix.replace(
    /(?:尽管如此|即便如此|话虽如此|但是|然而|不过|可是|因此|所以|相反|反而|依然|还是|仍然|并且|从而|进而|继而|由此|仍|但|而|并|却|故|足以|直接|even(?:so)?|despitethat|but|however|yet|nevertheless|nonetheless|therefore|thus|conversely|thereby|consequently|hence|still|directly|although|and)/gi,
    '',
  );
  return discourseOnly.length === 0;
}

function hasPositiveDStateAttributionBefore(normalized: string, endIndex: number): boolean {
  const prefix = normalized.slice(0, endIndex);
  const positiveAttributionPattern = /(?:证明|导致|构成|认定(?:为)?|归因(?:为)?|归为|(?:是|属于)[^,，;；。！？.!?]{0,24}?根因|proves?|causes?|constitutes?|establishes?|is(?:the)?rootcause)/gi;
  let negatedAttributionObjectOpen = false;
  let previousMatchEnd = 0;
  for (const match of prefix.matchAll(positiveAttributionPattern)) {
    const matchIndex = match.index;
    const textSincePreviousAttribution = prefix.slice(previousMatchEnd, matchIndex);
    if (
      negatedAttributionObjectOpen &&
      /(?:[,，;；。！？.!?]|\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|根因|rootcause|但是|然而|不过|可是|但|\bbut\b|\bhowever\b|\byet\b)/i.test(textSincePreviousAttribution)
    ) {
      negatedAttributionObjectOpen = false;
    }
    const precedingText = prefix.slice(0, match.index);
    const directlyNegated = /(?:并非|并不|不是|不能|无法|不可|未|不|doesnot|didnot|isnot|cannot|can't|not|never)(?:直接|足以|明确|真正|directly|clearly|conclusively|necessarily)?$/i.test(precedingText);
    const isRootCauseCopula = /^(?:(?:是|属于)[^,，;；。！？.!?]{0,24}根因|is(?:the)?rootcause)$/i.test(match[0]);
    previousMatchEnd = matchIndex + match[0].length;
    if (directlyNegated) {
      negatedAttributionObjectOpen = !isRootCauseCopula;
      continue;
    }
    if (negatedAttributionObjectOpen && isRootCauseCopula) {
      negatedAttributionObjectOpen = false;
      continue;
    }
    if (hasDStateAttributionSubject(precedingText)) return true;
  }
  return false;
}

function hasPriorPositiveDStateAttribution(claim: string): boolean {
  const normalized = normalizeDStateQualifierText(claim);
  const qualifierMatches = Array.from(normalized.matchAll(
    /(?:只是|仅是|仅表示|只表示|表示为|不能|无法|不可|不等于|证据不足|不足以|候选|可疑|不显著|不明显|不突出|较低|很低|有限|可忽略|非(?:io|i\/o|磁盘|存储)(?:阻塞)?|rowcount=0|返回0行|无(?:anr)?窗口|无数据|已?跳过|only|merely|cannot|can't|doesnot|isnot|notenough|insufficient|ambiguous|candidate|negligible|limited|returned0rows|no(?:anr)?window|nodata|skipped)/gi,
  ));
  if (qualifierMatches.length === 0) return false;
  const qualifierIndex = qualifierMatches[qualifierMatches.length - 1].index;
  return hasPositiveDStateAttributionBefore(normalized, qualifierIndex);
}

function hasPositiveDStateAttribution(claim: string): boolean {
  const normalized = normalizeDStateQualifierText(claim);
  return hasPositiveDStateAttributionBefore(normalized, normalized.length);
}

function hasPositiveKernelIoClaimAfterDStateQualifier(claim: string): boolean {
  const qualifier = /(?:无法确认|不能确认|未确认|证据不足|不能归因|无法归因)/gi;
  for (const match of claim.matchAll(qualifier)) {
    if (match.index === undefined) continue;
    const remainder = claim.slice(match.index + match[0].length);
    if (hasKernelIoCoreferenceCausalLanguage(
      `${QUALIFIED_KERNEL_IO_ANTECEDENT} ${remainder}`,
    )) {
      return true;
    }
  }
  return false;
}

function hasPositiveAttributionInsideNegativeDStateIoClaim(claim: string): boolean {
  const normalized = normalizeDStateQualifierText(claim);
  if (!/^(?:也|且)?非(?:磁盘)?(?:io|i\/o)阻塞/i.test(normalized)) return false;
  return hasPositiveDStateAttributionBefore(normalized, normalized.length);
}

function hasAffirmativeDStateIoEvidence(text: string): boolean {
  const hasEvidenceToken =
    /io_wait\s*(?:=|为|是)?\s*1/i.test(text) ||
    /(?:filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|ext4|f2fs|erofs|ufshcd|mmc_|dm_|fsync)/i.test(text) ||
    /(?:sqlite|file\s*i\/?o|文件\s*i\/?o|数据库|sharedpreferences).{0,40}(?:slice|trace|stack|调用栈|证据|耗时|ms)/i.test(text);
  if (!hasEvidenceToken) return false;

  const hasConcreteObservation =
    /(?:观测|观察|出现|存在|命中|记录|测得|显示|捕获|采集到|observed|captured|measured|recorded|shows?|evidence_ref_id|source_ref)/i.test(text) ||
    /(?:dur(?:ation)?\s*[:=]\s*\d|\d+(?:\.\d+)?\s*ms|slice\s*[:=]\s*\d)/i.test(text);
  if (!hasConcreteObservation) return false;

  const isNegatedOrProspective =
    /(?:无关|不相关|与[^。！？.!?\n]{0,30}无关|unrelated|not\s+related)/i.test(text) ||
    /(?:没有|未(?:发现|捕获|采集|观测|命中)?|无|缺少|不具备|尚无)[^。！？.!?\n]{0,60}(?:io_wait|filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|fsync|sqlite|file\s*i\/?o|文件\s*i\/?o|数据库)/i.test(text) ||
    /\b(?:no|without|missing|lack(?:s|ed)?)\b[^.!?\n]{0,60}(?:io_wait|filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|fsync|sqlite|file\s*i\/?o|database)/i.test(text) ||
    /(?:后续|下一步|仍需|还需|需要|待(?:采集|补充|确认|观测)|建议|应当|应该|必须)[^。！？.!?\n]{0,60}(?:io_wait|filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|fsync|sqlite|file\s*i\/?o|文件\s*i\/?o|数据库)/i.test(text) ||
    /\b(?:need|require|should|must|future|next)\b[^.!?\n]{0,60}(?:io_wait|filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|fsync|sqlite|file\s*i\/?o|database)/i.test(text) ||
    /(?:io_wait|filemap|io_schedule|wait_on_page|folio_wait|submit_bio|blk_|fsync|sqlite|file\s*i\/?o|database)[^.!?\n]{0,40}(?:was\s+not|not\s+(?:captured|observed|found))/i.test(text) ||
    /(?:只有|仅当|如果|若|假设|可能|也许|尚未验证|未验证|当前不具备|if\b|only\s+if|may\b|might\b|hypothes|unverified|would\s+support|do\s+not\s+have)/i.test(text);
  return !isNegatedOrProspective;
}

function hasExplicitDStateEvidenceBinding(text: string): boolean {
  return /(?:同一(?:等待)?窗口|同一(?:时间)?区间|在(?:同一)?窗口内|同时(?:命中|观测|观察|出现)|对应(?:的)?\s*D(?:-state|\s*状态)?|与(?:该|此)?\s*D(?:-state|\s*状态)?.{0,24}(?:重叠|一致|对应)|same\s+(?:wait\s+)?(?:window|interval)|overlap(?:s|ped|ping)?\s+with\s+(?:the\s+)?D-state|corresponding\s+D-state)/i.test(text);
}

function parseMarkdownTableCells(statement: string): string[] | undefined {
  const trimmed = statement.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;

  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map(cell => cell.replace(/[`*]/g, '').trim());
  return cells.length >= 3 ? cells : undefined;
}

function isConfirmedTableStatus(cell: string): boolean {
  return /^(?:已确认|confirmed)$/i.test(cell);
}

function isExclusionTableStatus(cell: string): boolean {
  return /^(?:(?:✗|×|❌)\s*)?(?:已)?排除$/i.test(cell);
}

function hasExplicitPositiveDStateIoTableStatus(statement: string): boolean {
  const cells = parseMarkdownTableCells(statement);
  if (!cells) return false;

  const subjectCell = cells[0] ?? '';
  const rowText = cells.join(' | ');
  const hasConfirmedStatus = cells.some(isConfirmedTableStatus);
  const hasConflictingStatus = hasConfirmedStatus && cells.some(isExclusionTableStatus);
  return (
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|Q4a)/i.test(rowText) &&
    hasIoDomainLanguage(rowText) &&
    (
      hasConflictingStatus ||
      (
        /(?:根因|root\s+cause)/i.test(subjectCell) &&
        hasConfirmedStatus
      )
    )
  );
}

function removeQualifiedDStateIoTableRow(statement: string): string {
  const cells = parseMarkdownTableCells(statement);
  if (!cells) return statement;

  const rowText = cells.join(' | ');
  const hasDStateSubject = /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠|Q4a)/i.test(rowText);
  if (!hasDStateSubject || !hasIoDomainLanguage(rowText)) return statement;
  if (hasExplicitPositiveDStateIoTableStatus(statement)) return statement;

  const hasExclusionStatus = cells.some(isExclusionTableStatus);
  const hasUnavailableStatus = /^不可用$/i.test(cells[1] ?? '');
  const hasExplicitNonAttributionStatus = hasUnavailableStatus || hasExclusionStatus ||
    cells.some(cell =>
      /^(?:无法|不能|不可)(?:直接)?(?:确认|归因(?:为)?|认定(?:为)?)$/i.test(cell) ||
      /^(?:未确认|证据不足)$/i.test(cell) ||
      /^(?:(?:本次|当前)\s*)?trace\s*(?:未|不能|无法)(?:直接)?证明(?:\s|—|[-:：]|$)/i.test(cell) ||
      /^(?:the\s+)?trace\s+(?:does\s+not|cannot|can't)\s+(?:directly\s+)?prove(?:s)?(?:\s|—|[-:：]|$)/i.test(cell),
    );
  const evidenceCells = cells.slice(1).join(' | ');
  const explicitlyMissingIoSignals =
    /(?:缺少|无|没有|未(?:采集|捕获|命中)?)[^|]{0,50}io_wait[^|]{0,40}(?:blocked_function|io\s*阻塞函数)/i.test(evidenceCells) ||
    /(?:缺少|无|没有|未(?:采集|捕获|命中)?)[^|]{0,50}(?:blocked_function|io\s*阻塞函数)[^|]{0,40}io_wait/i.test(evidenceCells);
  const hasLowStatusWithMissingBoundary = cells.some(cell => /^低$/i.test(cell)) &&
    explicitlyMissingIoSignals &&
    /(?:不能|无法|不可)(?:直接)?归因(?:为)?[^|]{0,20}(?:io|i\/o|磁盘|存储)/i.test(evidenceCells);
  const hasExplicitLowNonAttribution = cells.some(cell =>
    /(?:占比|比例)?(?:低|较低|很低|有限|可忽略)[^|]{0,24}(?:不足以|不能|无法|不可)[^|]{0,16}(?:标定|确认|归因|认定|证明)[^|]{0,24}(?:io|i\/o|磁盘|存储)(?:\s*根因)?/i.test(cell),
  );
  const hasMissingEvidenceStatus = cells.some(cell => /^missing_evidence$/i.test(cell));
  const hasMissingEvidenceBoundary = hasMissingEvidenceStatus &&
    /(?:缺少|缺|无|没有|未(?:采集|捕获|命中)?)[^|]{0,60}(?:io_wait|page[-\s]?cache\s+wchan|blocked_function|io\s*阻塞函数)/i.test(evidenceCells);
  const zeroDStateMatch = /(?:(?:零|0(?:\.0+)?(?![\d.]))\s*(?:D\/DK|D-state|D\s*状态)|(?:D\/DK|D-state|D\s*状态)\s*(?:=|为|:|：)?\s*0(?:\.0+)?(?![\d.])\s*(?:ms|毫秒)?)/i.exec(evidenceCells);
  const zeroDStatePrefix = zeroDStateMatch?.index === undefined
    ? ''
    : evidenceCells.slice(Math.max(0, zeroDStateMatch.index - 16), zeroDStateMatch.index);
  const hasAffirmativeZeroDState = Boolean(zeroDStateMatch) &&
    !/(?:并非|不是|不|预计|预期|目标|计划|可能)[^|]{0,8}$/i.test(zeroDStatePrefix);
  const emptyBlockedFunctionMatch = /blocked_function\s*(?:为空|为\s*null|=\s*null|is\s+null|无数据|0\s*行)/i.exec(evidenceCells);
  const emptyBlockedFunctionPrefix = emptyBlockedFunctionMatch?.index === undefined
    ? ''
    : evidenceCells.slice(
      Math.max(0, emptyBlockedFunctionMatch.index - 16),
      emptyBlockedFunctionMatch.index,
    );
  const hasAffirmativeEmptyBlockedFunction = Boolean(emptyBlockedFunctionMatch) &&
    !/(?:预计|预期|目标|计划|可能)[^|]{0,8}$/i.test(emptyBlockedFunctionPrefix);
  const emptyIoBlockingMatch = /\bio_blocking\b\s*(?:=|为|返回)?\s*0(?![\d.])\s*(?:行|条|rows?|slices?)?/i.exec(evidenceCells);
  const emptyIoBlockingPrefix = emptyIoBlockingMatch?.index === undefined
    ? ''
    : evidenceCells.slice(
      Math.max(0, emptyIoBlockingMatch.index - 16),
      emptyIoBlockingMatch.index,
    );
  const hasAffirmativeEmptyIoBlocking = Boolean(emptyIoBlockingMatch) &&
    !/(?:并非|不是|不|预计|预期|目标|计划|可能)[^|]{0,8}$/i.test(emptyIoBlockingPrefix);
  const hasObservedNoDStateBoundary =
    hasAffirmativeZeroDState &&
    (hasAffirmativeEmptyBlockedFunction || hasAffirmativeEmptyIoBlocking);
  if (
    !hasExplicitNonAttributionStatus &&
    !hasLowStatusWithMissingBoundary &&
    !hasExplicitLowNonAttribution &&
    !hasMissingEvidenceBoundary &&
    !hasObservedNoDStateBoundary
  ) return statement;

  if (
    reversesDStateQualifier(evidenceCells) ||
    projectsDStateQualifier(evidenceCells) ||
    hasPriorPositiveDStateAttribution(evidenceCells) ||
    hasPositiveDStateAttribution(evidenceCells) ||
    hasPositiveKernelIoClaimAfterDStateQualifier(evidenceCells) ||
    hasPositiveAttributionInsideNegativeDStateIoClaim(evidenceCells)
  ) {
    return statement;
  }
  return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
}

function removeQualifiedDStateIoClaims(statement: string): string {
  let remaining = removeQualifiedDStateIoTableRow(statement);
  const dStateIoCheckNotTriggeredPattern = /(?:Q4a(?:(?:\.(?=\d))|[^。！？.!?\n]){0,40}?(?:D\s*状态)|\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,140}?(?:io|i\/o)\s*检查\s*(?:未触发|未命中)/gi;
  remaining = remaining.replace(dStateIoCheckNotTriggeredPattern, (claim, offset: number) => {
    const context = remaining.slice(
      Math.max(0, offset - 24),
      Math.min(remaining.length, offset + claim.length + 24),
    );
    const projectedCheckResult = /(?:预计|预期|目标|计划|可能|将|会)[^。！？.!?\n]{0,60}(?:io|i\/o)\s*检查\s*(?:未触发|未命中)/i.test(context);
    const reversedCheckResult = /(?:未触发|未命中)\s*(?:并不成立|不成立|为假|并非事实)/i.test(context);
    if (
      projectedCheckResult ||
      reversedCheckResult ||
      hasPositiveDStateAttribution(context) ||
      hasPositiveKernelIoClaimAfterDStateQualifier(context)
    ) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const missingBlockedFunctionFamilyLowDStatePattern = /(?:(?:并非|不是)\s*)?(?:blocked_?functions?)[^。！？.!?\n]{0,30}?不含[^。！？.!?\n]{0,36}?(?:io|i\/o)[^。！？.!?\n]{0,12}?\/?\s*page[-\s]?cache[^。！？.!?\n]{0,24}?函数族[^。！？.!?\n]{0,80}?(?:\bD-state\b|D\s*状态)[^。！？.!?\n]{0,32}?(?:仅|只有|仅为|仅占)?\s*\d+(?:\.\d+)?\s*(?:ms|毫秒)[^。！？.!?\n]{0,28}?(?:\d+(?:\.\d+)?\s*%)?[^。！？.!?\n]{0,24}?不足以构成根因/gi;
  remaining = remaining.replace(missingBlockedFunctionFamilyLowDStatePattern, claim => {
    const reversedAbsence = /(?:并非|不是)[^。！？.!?\n]{0,24}(?:blocked_?functions?)?[^。！？.!?\n]{0,12}不含|(?:blocked_?functions?)[^。！？.!?\n]{0,16}(?:并非|不是)\s*不含/i.test(claim);
    if (
      reversedAbsence ||
      reversesDStateQualifier(claim) ||
      projectsDStateQualifier(claim) ||
      hasPriorPositiveDStateAttribution(claim) ||
      hasPositiveDStateAttribution(claim) ||
      hasPositiveKernelIoClaimAfterDStateQualifier(claim) ||
      hasPositiveAttributionInsideNegativeDStateIoClaim(claim)
    ) {
      return claim;
    }
    return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  const qualifiedClaimPatterns = [
    /(?:(?:并非|不是)\s*)?(?:(?:本次|当前)\s*)?trace\s*(?:未|不能|无法)(?:直接)?证明(?:(?:\.(?=\d))|[^。！？.!?\n]){0,180}?(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,60}?(?:仅|只有|仅为|仅占)?\s*\d+(?:\.\d+)?\s*(?:ms|毫秒)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,30}?(?:\d+(?:\.\d+)?\s*%)?/gi,
    /\|[^|\n]{0,80}(?:io|i\/o|磁盘|存储)[^|\n]{0,30}根因[^|\n]*\|\s*(?:\*{1,2}\s*)?(?:无法确认|不能确认|未确认|证据不足|不能归因|无法归因)(?:\s*\*{1,2})?(?:(?:\.(?=\d))|[^|\n]){0,120}?(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^|\n]){0,120}?\|/gi,
    /(?:i\/o\s*D-state|D-state[^。！？.!?\n]{0,24}?i\/o)[^。！？.!?\n]{0,180}?(?:因|由于)\s*无\s*(?:ANR\s*)?窗口[^。！？.!?\n]{0,30}?(?:返回)?(?:空结果|为空|无数据)/gi,
    /(?:i\/o\s*阻塞[^。！？.!?\n]{0,24}?D-state|D-state[^。！？.!?\n]{0,24}?i\/o\s*阻塞)[^。！？.!?\n]{0,80}?(?:未做|未执行|未统计|未分析|跳过)[^。！？.!?\n]{0,80}?(?:无|没有|缺少)[^。！？.!?\n]{0,60}?(?:数据|process_name|uninterruptible_wait_ms)/gi,
    /(?:Q4a[^。！？.!?\n]{0,30}?(?:D\s*状态)|\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,50}?(?:仅|只有|仅为|仅占)?\s*\d+(?:\.\d+)?\s*ms(?:(?:\.(?=\d))|[^。！？.!?\n]){0,24}?\d+(?:\.\d+)?\s*%(?:(?:\.(?=\d))|[^。！？.!?\n]){0,30}?(?:未达|低于|小于|不超过)[^。！？.!?\n]{0,20}?(?:干预)?阈值/gi,
    /(?<!并非)(?<!不是)(?:也|且)?非\s*(?:磁盘\s*)?i\/?o\s*阻塞(?:(?:\.(?=\d))|[^。！？.!?\n]){0,90}?(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,40}?(?:仅|只有|仅为|仅占)?\s*\d+(?:\.\d+)?\s*ms(?:(?:\.(?=\d))|[^。！？.!?\n]){0,24}?(?:\d+(?:\.\d+)?\s*%)?\s*[)）]?/gi,
    /(?:i\/?o\s*D-state\s*阻塞|D-state[^。！？.!?\n]{0,30}?i\/?o[^。！？.!?\n]{0,20}?阻塞)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,220}?(?:rowCount\s*=\s*0|(?:明确)?返回\s*0\s*行|(?:当前|本次)?(?:无|没有)\s*(?:ANR\s*)?窗口|(?:当前|本次)?无数据|已?跳过|returned\s+0\s+rows|no\s+(?:ANR\s+)?window|no\s+data|skipped)(?:\s*\|)?/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)[^。！？.!?\n]{0,40}?(?:只是|仅是|仅表示|只表示|表示为|属于)[^。！？.!?\n]{0,40}?(?:不可中断等待|等待状态)[^。！？.!?\n]{0,50}?(?:仍需|还需|需要)[^。！？.!?\n]{0,30}?(?:io|i\/o|磁盘|存储)(?:\s*证据)?/gi,
    /(?:\bD-state\b|D\/DK|uninterruptible\s+sleep)[^.!?\n]{0,40}?(?:only|merely)\s+(?:indicates?|represents?|means?|is)[^.!?\n]{0,40}?uninterruptible\s+(?:sleep|wait)[^.!?\n]{0,50}?(?:requires?|needs?)[^.!?\n]{0,30}?(?:io|i\/o|disk|storage)(?:\s+evidence)?/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,180}?(?<!并非)(?<!不是)(?:不能|无法|不可)(?!\s*(?:\*{1,2}\s*)?不)\s*(?:\*{1,2}\s*)?(?:直接\s*)?(?:归为|归因(?:为)?|认定(?:为)?|证明)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,30}?(?:io|i\/o|磁盘(?:\s*i\/?o)?|存储(?:\s*i\/?o)?)(?:\s*(?:是|为)?\s*根因)?/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,100}?(?:io|i\/o|磁盘|存储)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,30}?(?:根因)?(?:(?:\.(?=\d))|[^。！？.!?\n]){0,24}?(?<!并非)(?<!不是)(?:(?:不能|无法|不可)(?!\s*(?:\*{1,2}\s*)?不)\s*(?:\*{1,2}\s*)?(?:确认|证明|归因)|证据不足)/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)[^,，;；。！？.!?\n]{0,70}?(?<!并非)(?<!不是)(?:不能(?!\s*不)|不可(?!\s*不)|不等于|无法(?!\s*不)|证据不足|不足以|候选|可疑)[^,，;；。！？.!?\n]{0,70}?(?:io|i\/o|磁盘|存储|根因)/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)[^。！？\n]{0,90}?无[^。！？\n]{0,30}?(?:io|i\/o|磁盘|存储)[^。！？\n]{0,30}?(?:风险|证据|根因)/gi,
    /(?:\bD-state\b|D\s*状态|D\/DK|不可中断睡眠)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,100}?(?:io|i\/o|磁盘|存储)(?:(?:\.(?=\d))|[^。！？.!?\n]){0,40}?(?<!并非)(?<!不是)(?<!不能说)(?<!不可谓)(?:并?不显著|并?不明显|不突出|较低|很低|有限|可忽略)/gi,
    /(?:\bD-state\b|D\/DK|uninterruptible\s+sleep)[^,;.!?\n]{0,70}?(?:cannot|can't|does\s+not|doesn't|not\s+enough|insufficient|ambiguous|candidate)[^,;.!?\n]{0,70}?(?:io|i\/o|disk|storage|root\s+cause)/gi,
    /(?:\bD-state\b|D\/DK|uninterruptible\s+sleep)[^.!?\n]{0,90}?no[^.!?\n]{0,30}?(?:io|i\/o|disk|storage)[^.!?\n]{0,30}?(?:risk|evidence|root\s+cause)/gi,
  ];
  for (const pattern of qualifiedClaimPatterns) {
    remaining = remaining.replace(pattern, claim => {
      if (
        reversesDStateQualifier(claim) ||
        projectsDStateQualifier(claim) ||
        hasPriorPositiveDStateAttribution(claim) ||
        hasPositiveDStateAttribution(claim) ||
        hasPositiveKernelIoClaimAfterDStateQualifier(claim) ||
        hasPositiveAttributionInsideNegativeDStateIoClaim(claim)
      ) {
        return claim;
      }
      return ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
    });
  }
  const lowEnglishDStateIoClaim = /(?:\bD-state\b|D\/DK|uninterruptible\s+sleep)(?:(?:\.(?=\d))|[^.!?\n]){0,100}?(?:io|i\/o|disk|storage)(?:(?:\.(?=\d))|[^.!?\n]){0,40}?(?:not\s+(?:significant|material|substantial|prominent)|insignificant|negligible|limited)/gi;
  remaining = remaining.replace(lowEnglishDStateIoClaim, claim => {
    const reversesLowSeverity = /\bnot\s+(?:not\s+significant|insignificant|negligible|limited)\b/i.test(claim);
    return reversesLowSeverity ? claim : ` ${QUALIFIED_KERNEL_IO_ANTECEDENT} `;
  });
  return remaining;
}

function hasBlockedFunctionFullStackClaim(text: string): boolean {
  return (
    /(?:blocked_function|sched_blocked_reason|wchan).{0,120}(?:完整|full).{0,40}(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack)/i.test(text) ||
    /(?:完整|full).{0,40}(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack).{0,120}(?:blocked_function|sched_blocked_reason|wchan)/i.test(text)
  );
}

function hasImplicitSubjectFullStackClaim(text: string): boolean {
  if (!text.includes(QUALIFIED_BLOCKED_FUNCTION_ANTECEDENT)) return false;

  let antecedentAvailable = false;
  return text.split(/[,，;；]/).some(clause => {
    if (clause.includes(QUALIFIED_BLOCKED_FUNCTION_ANTECEDENT)) {
      antecedentAvailable = true;
      clause = clause.split(QUALIFIED_BLOCKED_FUNCTION_ANTECEDENT).join(' ');
    }
    if (!antecedentAvailable) return false;
    const requiresMoreEvidence = /(?:需要|仍需|还需|需|补证|采集|才能|need|require|capture|sample)/i.test(clause);
    if (requiresMoreEvidence) return false;
    const fullStackClaim = clause.match(
      /(?:仍|还是|依然)?\s*(?:是|属于|构成)\s*(?:完整|full)[^。！？.!?\n]{0,30}(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack)|(?:still\s+)?(?:is|are|constitutes?)\s+(?:an?\s+)?full[^.!?\n]{0,30}(?:call\s*stack|callstack|kernel\s+stack|stack)/i,
    );
    if (!fullStackClaim || fullStackClaim.index === undefined) return false;
    const possibleSubject = clause.slice(0, fullStackClaim.index);
    return hasOnlyDiscoursePrefix(possibleSubject);
  });
}

function removeQualifiedBlockedFunctionClaims(statement: string): string {
  let remaining = statement;
  const qualifiedClaimPatterns = [
    /(?:blocked_function|sched_blocked_reason|wchan)\s*(?:是|为|=)?\s*(?:kernel\s+)?(?:wchan\s+)?(?:单帧|single[- ]frame)[^。！？.!?\n]{0,30}?(?:不是|并非|非|is\s+not|isn't)\s*(?:完整|full)[^。！？.!?\n]{0,30}?(?:调用栈|内核栈|堆栈|call\s*stack|callstack|kernel\s+stack|stack)/gi,
    /(?:blocked_function|sched_blocked_reason|wchan)[^,，;；。！？.!?\n]{0,80}?(?:不是|并非|不能|无法|不可|不等于)[^,，;；。！？.!?\n]{0,50}?(?:完整|full)[^,，;；。！？.!?\n]{0,30}?(?:调用栈|内核栈|堆栈|call\s*stack|callstack|stack)/gi,
    /(?:blocked_function|sched_blocked_reason|wchan)[^,;.!?\n]{0,80}?(?:(?:is|are)\s+)?not\s+(?:an?\s+)?full[^,;.!?\n]{0,30}?(?:call\s*stack|callstack|kernel\s+stack|stack)/gi,
    /(?:blocked_function|sched_blocked_reason|wchan)[^。！？.!?\n]{0,80}?(?:单帧|single[- ]frame|\bwchan\b)/gi,
  ];
  for (const pattern of qualifiedClaimPatterns) {
    remaining = remaining.replace(pattern, ` ${QUALIFIED_BLOCKED_FUNCTION_ANTECEDENT} `);
  }
  return remaining;
}

function assessKernelBlockingClaimBoundary(conclusion: string): FinalResultQualityIssue | undefined {
  const statements = splitQualityStatements(conclusion);
  const unqualifiedDStateClaimIndexes = statements
    .map((statement, index) => ({statement, index}))
    .filter(({statement}) =>
      hasDStateIoCausalLanguage(statement) ||
      hasExplicitPositiveDStateIoTableStatus(statement)
    )
    .filter(({statement, index}) => {
      if (hasExplicitPositiveDStateIoTableStatus(statement)) return true;
      const remaining = removeQualifiedDStateIoClaims(statement);
      return hasDStateIoCausalLanguage(remaining) ||
        hasKernelIoCoreferenceCausalLanguage(remaining) ||
        (
          remaining.includes(QUALIFIED_KERNEL_IO_ANTECEDENT) &&
          hasExplicitKernelIoCoreferenceCausalLanguage(statements[index + 1] || '')
        );
    })
    .map(({index}) => index);
  const allDStateClaimsHaveBoundEvidence = unqualifiedDStateClaimIndexes.every(claimIndex =>
    statements.some((statement, evidenceIndex) => {
      if (Math.abs(evidenceIndex - claimIndex) > 2) return false;
      if (!hasAffirmativeDStateIoEvidence(statement)) return false;
      return hasExplicitDStateEvidenceBinding(statement);
    })
  );
  if (unqualifiedDStateClaimIndexes.length > 0 && !allDStateClaimsHaveBoundEvidence) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} D/DK 只能说明不可中断等待；没有 io_wait=1、IO/page-cache blocked_function 或 app-level 文件/数据库证据时，不能直接写成磁盘 IO 根因。`,
      offendingStatement: boundedOffendingStatement(
        statements[unqualifiedDStateClaimIndexes[0]] || '',
      ),
    };
  }

  const pollIoClaimStatements = splitQualityStatements(conclusion)
    .map(statement => statement.trim())
    .filter(hasPollIoCausalLanguage);
  const unqualifiedPollIoClaim = pollIoClaimStatements.find(statement => {
    const remaining = removeQualifiedPollIoClaims(statement);
    return hasPollIoCausalLanguage(remaining) ||
      hasKernelIoCoreferenceCausalLanguage(remaining);
  });
  if (unqualifiedPollIoClaim) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} epoll/poll 类 blocked_function 通常表示等待事件或空闲，不能直接写成 IO 根因；需要 io_wait=1、IO/page-cache 函数族或 app-level 文件/数据库证据补强。`,
      offendingStatement: boundedOffendingStatement(unqualifiedPollIoClaim),
    };
  }

  const unqualifiedBlockedFunctionStackClaim = splitQualityStatements(conclusion)
    .filter(hasBlockedFunctionFullStackClaim)
    .find(statement => {
      const remaining = removeQualifiedBlockedFunctionClaims(statement);
      return hasBlockedFunctionFullStackClaim(remaining) ||
        hasImplicitSubjectFullStackClaim(remaining);
    });
  if (unqualifiedBlockedFunctionStackClaim) {
    return {
      code: 'kernel_blocking_claim_boundary',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} blocked_function 来自 sched_blocked_reason 的 kernel wchan 单帧，不是完整内核调用栈；完整 off-CPU 栈需要 linux.perf / sched_switch 事件采样。`,
      offendingStatement: boundedOffendingStatement(unqualifiedBlockedFunctionStackClaim),
    };
  }

  return undefined;
}

export function assessFinalResultQuality(input: {
  result: AgentRuntimeAnalysisResult;
  query?: string;
  sceneType?: string;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): FinalResultQualityIssue | undefined {
  const { result, query, sceneType, comparisonIdentity } = input;
  if (!result.success) return undefined;

  const conclusion = result.conclusion.trim();
  if (result.partial === true) {
    if (looksLikeAnalysisQuery(query)) {
      return assessKernelBlockingClaimBoundary(conclusion);
    }
    return undefined;
  }

  if (!conclusion) {
    return {
      code: 'empty_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikePhaseSummaryFallback(conclusion)) {
    return {
      code: 'plan_summary_fallback',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikeProcessNarrationConclusion(conclusion)) {
    return {
      code: 'process_narration_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (isQuickRunResult(result) && result.claimVerificationResult?.status === 'failed') {
    return {
      code: 'quick_verifier_failed',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} 快速模式当前断言未通过证据核对；不能作为已核验快速答案交付。`,
    };
  }

  if (looksLikeOverExpandedQuickReport(result, conclusion)) {
    return {
      code: 'quick_full_report_shape',
      message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} 快速模式只能交付局部事实或快速 triage；当前输出呈现完整报告形态，应切换完整模式重新分析。`,
    };
  }

  if (
    !isQuickRunResult(result) &&
    looksLikeAnalysisQuery(query) &&
    hasReportStructureMarker(conclusion) &&
    !hasDeliverableFinalReportHeading(conclusion)
  ) {
    return {
      code: 'missing_final_report_heading',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  const hasFindings = Array.isArray(result.findings) && result.findings.length > 0;
  if (
    looksLikeAnalysisQuery(query) &&
    conclusion.length < 280 &&
    !hasFindings &&
    !hasEvidenceBackedArtifacts(result) &&
    !hasEvidenceReferenceText(conclusion)
  ) {
    return {
      code: 'sparse_unverified_conclusion',
      message: FINAL_RESULT_QUALITY_GATE_MESSAGE,
    };
  }

  if (looksLikeAnalysisQuery(query)) {
    const kernelBlockingIssue = assessKernelBlockingClaimBoundary(conclusion);
    if (kernelBlockingIssue) return kernelBlockingIssue;
  }

  const comparisonIdentityIssue = assessFinalResultComparisonIdentity(
    conclusion,
    comparisonIdentity,
  );
  if (comparisonIdentityIssue) return comparisonIdentityIssue;

  if (!isQuickRunResult(result) && looksLikeAnalysisQuery(query)) {
    const contractIssue = assessFinalReportContractCompleteness({
      conclusion,
      query,
      sceneType,
      contractSceneId: result.conclusionContract?.metadata?.sceneId,
      caseRecommendations: result.conclusionContract?.caseRecommendations as Array<Record<string, unknown>> | undefined,
    });
    if (contractIssue) {
      const missingText = contractIssue.missingLabels.join('、');
      return {
        code: 'scene_contract_incomplete',
        message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} ` +
          `缺失 ${contractIssue.sceneType} 场景 Final Report Contract 要求的结构：${missingText}。`,
      };
    }
  }

  return undefined;
}

export function assessFinalResultComparisonIdentity(
  conclusion: string,
  identity: FinalResultComparisonIdentity | undefined,
): FinalResultQualityIssue | undefined {
  if (!identity) return undefined;

  const packageNames = [...new Set([
    identity.currentPackageName?.trim(),
    identity.referencePackageName?.trim(),
  ].filter((packageName): packageName is string => Boolean(packageName)))];
  const missingPackageNames = packageNames.filter(packageName => !conclusion.includes(packageName));
  if (missingPackageNames.length === 0) return undefined;

  return {
    code: 'comparison_identity_incomplete',
    message: `${FINAL_RESULT_QUALITY_GATE_MESSAGE} ` +
      `双 Trace 对比结论必须显式写出两侧完整包名，不能只使用左侧/右侧或业务别名；缺失：${missingPackageNames.join('、')}。`,
  };
}

export function applyFinalResultQualityGate(input: {
  result: AgentRuntimeAnalysisResult;
  query?: string;
  sceneType?: string;
  comparisonIdentity?: FinalResultComparisonIdentity;
}): FinalResultQualityIssue | undefined {
  const issue = assessFinalResultQuality(input);
  if (!issue) return undefined;

  input.result.partial = true;
  input.result.confidence = Math.min(input.result.confidence || 0, 0.55);
  input.result.terminationReason = input.result.terminationReason ?? 'plan_incomplete';
  if (!input.result.terminationMessage) {
    input.result.terminationMessage = issue.message;
  } else if (!input.result.terminationMessage.includes(issue.message)) {
    input.result.terminationMessage = `${input.result.terminationMessage}\n\n${issue.message}`;
  }
  return issue;
}
