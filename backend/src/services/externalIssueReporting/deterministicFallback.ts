// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION,
  type ExternalIssueContributionKind,
  type ExternalIssueOpportunityV1,
  type ExternalIssueOwnership,
  type ExternalIssueReviewUnavailableReason,
  type ExternalIssueReviewV1,
  type ExternalIssueSignalV1,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';

export function buildDeterministicExternalIssueReview(input: {
  opportunity: ExternalIssueOpportunityV1;
  manifest: RunManifestV1;
  reason: ExternalIssueReviewUnavailableReason | 'agent_invalid';
}): ExternalIssueReviewV1 {
  const language = parseOutputLanguage(input.manifest.outputLanguage);
  const candidates = input.opportunity.signals.slice(0, 3).map(item => {
    const mapping = mapSignal(item);
    const suffix = createHash('sha256')
      .update(item.signalId)
      .digest('hex')
      .slice(0, 10);
    return {
      candidateId: `fallback-${suffix}`,
      decision: 'needs_verification' as const,
      ownership: mapping.ownership,
      contributionKind: mapping.contributionKind,
      confidence: 'low' as const,
      title: item.summary,
      agentAssessment: localize(
        language,
        'Agent 判断当前不可用；系统只能确认存在该信号，尚不能判断是否应公开反馈。',
        'Agent triage is unavailable. The system can confirm the signal, but cannot yet decide whether it should become a public report.',
      ),
      basisSignalIds: [item.signalId],
      references: item.references,
      missingEvidence: [
        localize(
          language,
          '需要用户确认复现步骤、期望行为和可公开的最小证据。',
          'The user must confirm reproduction steps, expected behavior, and the minimum evidence safe to publish.',
        ),
      ],
      userQuestions: [
        {
          questionId: `reproduction-${suffix}`,
          prompt: localize(
            language,
            '这个现象能否稳定复现？请描述最小操作步骤。',
            'Can you reproduce this consistently? Describe the minimum steps.',
          ),
          required: true,
        },
      ],
      draftSeed: {
        problemStatement: item.summary,
        expectedBehavior: localize(
          language,
          'SmartPerfetto 应给出可解释、证据一致的结果。',
          'SmartPerfetto should produce an explainable result consistent with its evidence.',
        ),
        reproductionHint: localize(
          language,
          '请补充不含敏感数据的最小复现步骤。',
          'Add minimal reproduction steps that do not contain sensitive data.',
        ),
        suggestedContribution: mapping.suggestion[language],
      },
    };
  });
  return {
    schemaVersion: EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION,
    runId: input.opportunity.runId,
    runManifestId: input.opportunity.runManifestId,
    source: 'deterministic_fallback',
    fallbackReason: input.reason,
    candidates,
  };
}

function mapSignal(signal: ExternalIssueSignalV1): {
  ownership: ExternalIssueOwnership;
  contributionKind: ExternalIssueContributionKind;
  suggestion: Record<'zh-CN' | 'en', string>;
} {
  if (signal.kind === 'skill_error' || signal.kind === 'skill_empty_result') {
    return {
      ownership: 'skill',
      contributionKind: 'skill_improvement',
      suggestion: {
        'zh-CN': '可贡献可复现的 Skill 输入、预期输出或改进建议。',
        en: 'Contribute a reproducible Skill input, expected output, or improvement proposal.',
      },
    };
  }
  if (signal.kind === 'report_generation_failed') {
    return {
      ownership: 'runtime',
      contributionKind: 'bug_report',
      suggestion: {
        'zh-CN': '可反馈运行环境、复现步骤和脱敏后的错误信息。',
        en: 'Report the runtime environment, reproduction steps, and sanitized error details.',
      },
    };
  }
  if (signal.kind === 'low_scene_confidence') {
    return {
      ownership: 'analysis',
      contributionKind: 'strategy_improvement',
      suggestion: {
        'zh-CN': '可贡献场景描述、选择范围和期望识别结果。',
        en: 'Contribute the scene description, selected range, and expected classification.',
      },
    };
  }
  return {
    ownership: signal.kind === 'identity_unresolved' ? 'trace_data' : 'analysis',
    contributionKind: signal.kind === 'identity_unresolved'
      ? 'trace_fixture'
      : 'bug_report',
    suggestion: {
      'zh-CN': '可提供脱敏后的最小证据引用与期望结论。',
      en: 'Contribute sanitized minimum evidence references and the expected conclusion.',
    },
  };
}
