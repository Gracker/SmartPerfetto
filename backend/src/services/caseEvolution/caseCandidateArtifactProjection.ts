// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CaseCandidate, CaseCandidateReview} from '../../types/caseEvolution';
import {projectArtifact} from '../evolutionLifecycle/artifactProjection';
import {anonymizeCaseReview} from './caseAnonymizer';
import {
  validateCaseCandidateReview,
  type CaseCandidateReviewValidatorDeps,
} from './caseCandidateReviewValidator';

export function projectCaseCandidateReviewArtifact(input: {
  value: unknown;
  candidate: CaseCandidate;
  validatorDeps?: CaseCandidateReviewValidatorDeps;
}) {
  return projectArtifact(input.value, {
    validate(value) {
      const result = validateCaseCandidateReview(
        value,
        input.candidate,
        input.validatorDeps,
      );
      return result.ok
        ? {
            ok: true as const,
            value: result.review,
            warnings: result.warnings,
          }
        : {
            ok: false as const,
            errors: result.errors,
            warnings: result.warnings,
          };
    },
    sanitize(review: CaseCandidateReview) {
      const result = anonymizeCaseReview(review);
      return result.ok
        ? {
            ok: true as const,
            value: result.review,
            warnings: result.warnings,
          }
        : {
            ok: false as const,
            errors: result.errors,
            warnings: result.warnings,
          };
    },
    project(review: CaseCandidateReview) {
      return {ok: true as const, value: review};
    },
  });
}
