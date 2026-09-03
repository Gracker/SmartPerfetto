// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ScrollingJankClaimBoundaryCode =
  | 'prediction_error_noise_overclaim'
  | 'exclusive_user_perceived_jank_overclaim';

export interface ScrollingJankClaimBoundaryIssue {
  code: ScrollingJankClaimBoundaryCode;
  statement: string;
}

function splitStatements(text: string): string[] {
  return text
    .split(/[\n。！？!?]+/)
    .map(statement => statement.trim())
    .filter(Boolean);
}

function isNegatedBoundaryWarning(statement: string, claimPattern: RegExp): boolean {
  const match = claimPattern.exec(statement);
  if (!match || match.index === undefined) return false;
  const prefix = statement.slice(Math.max(0, match.index - 48), match.index);
  const suffix = statement.slice(match.index + match[0].length, match.index + match[0].length + 96);
  return /(?:不能|不可|不应|不要|并非|不是|不代表|无法|勿|严禁)[^。！？!?]{0,80}$/i.test(prefix) ||
    /(?:cannot|can't|should\s+not|must\s+not|is\s+not|isn't|does\s+not|doesn't|do\s+not|don't)\b[^.!?]{0,80}$/i.test(prefix) ||
    /^(?:[”"'’」』】）)]?\s*)?(?:这种|这个|该|此)?\s*(?:说法|结论|表述|判断)?\s*(?:是|并|均|都)?\s*(?:不成立|不准确|错误|不正确|不受支持|没有证据支持)/i.test(suffix) ||
    /^(?:[”"'’)]?\s*)?(?:claim|statement|conclusion)?\s*(?:is|are)?\s*(?:not\s+supported|not\s+accurate|incorrect|unsupported|wrong)\b/i.test(suffix);
}

export function assessScrollingJankClaimBoundary(
  text: string,
): ScrollingJankClaimBoundaryIssue | undefined {
  for (const statement of splitStatements(text)) {
    const predictionError = /(?:Prediction\s+Error|prediction_error|预测误差)/i.test(statement);
    const noiseClaim = /(?:统计噪声|纯噪声|只是噪声|仅是噪声|统计假象|统计伪影|statistical\s+noise|mere(?:ly)?\s+noise|just\s+noise|measurement\s+artifact|statistical\s+artifact|label(?:ing)?\s+artifact)/i;
    if (predictionError && noiseClaim.test(statement) && !isNegatedBoundaryWarning(statement, noiseClaim)) {
      return {
        code: 'prediction_error_noise_overclaim',
        statement,
      };
    }

    const exclusiveJankClaim = /(?:唯一(?:的)?|只有)[^。！？!?]{0,32}(?:真实|用户可感知)[^。！？!?]{0,24}(?:掉帧|卡顿)|(?:真实|用户可感知)[^。！？!?]{0,20}(?:掉帧|卡顿)[^。！？!?]{0,12}(?:仅|只有)\s*(?:\d+(?:\.\d+)?%?\s*(?:帧|个)?|[一二三四五六七八九十百千万]+\s*(?:帧|个)?)|\b(?:the\s+)?only\b[^.!?]{0,36}(?:real|user[- ]perceived)[^.!?]{0,24}(?:jank|stutter|dropped?\s+frames?)|(?:real|user[- ]perceived)[^.!?]{0,24}(?:jank|stutter|dropped?\s+frames?)[^.!?]{0,12}\bonly\b\s*\d+(?:\.\d+)?%?/i;
    if (exclusiveJankClaim.test(statement) && !isNegatedBoundaryWarning(statement, exclusiveJankClaim)) {
      return {
        code: 'exclusive_user_perceived_jank_overclaim',
        statement,
      };
    }
  }

  return undefined;
}
