// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ArtifactStageResult<T> =
  | {ok: true; value: T; warnings?: readonly string[]}
  | {ok: false; errors: readonly string[]; warnings?: readonly string[]};

export type ArtifactProjectionResult<T> =
  | {ok: true; artifact: T; warnings: string[]}
  | {
      ok: false;
      stage: 'validate' | 'sanitize' | 'project';
      errors: string[];
      warnings: string[];
    };

export interface ArtifactProjectionPipeline<
  TInput,
  TValidated,
  TSanitized,
  TArtifact,
> {
  validate(input: TInput): ArtifactStageResult<TValidated>;
  sanitize(input: TValidated): ArtifactStageResult<TSanitized>;
  project(input: TSanitized): ArtifactStageResult<TArtifact>;
}

/**
 * Shared validate -> sanitize -> project lifecycle used by both Case
 * Evolution review artifacts and Self Evolution curation proposals.
 */
export function projectArtifact<
  TInput,
  TValidated,
  TSanitized,
  TArtifact,
>(
  input: TInput,
  pipeline: ArtifactProjectionPipeline<
    TInput,
    TValidated,
    TSanitized,
    TArtifact
  >,
): ArtifactProjectionResult<TArtifact> {
  const warnings: string[] = [];
  const validated = pipeline.validate(input);
  warnings.push(...(validated.warnings ?? []));
  if (!validated.ok) {
    return {
      ok: false,
      stage: 'validate',
      errors: [...validated.errors],
      warnings,
    };
  }
  const sanitized = pipeline.sanitize(validated.value);
  warnings.push(...(sanitized.warnings ?? []));
  if (!sanitized.ok) {
    return {
      ok: false,
      stage: 'sanitize',
      errors: [...sanitized.errors],
      warnings,
    };
  }
  const projected = pipeline.project(sanitized.value);
  warnings.push(...(projected.warnings ?? []));
  if (!projected.ok) {
    return {
      ok: false,
      stage: 'project',
      errors: [...projected.errors],
      warnings,
    };
  }
  return {ok: true, artifact: projected.value, warnings};
}
