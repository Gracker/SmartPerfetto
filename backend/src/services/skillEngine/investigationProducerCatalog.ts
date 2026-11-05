// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {investigationEvidenceDeclarationError, type InvestigationEvidenceDeclaration} from '../evidence/investigationEvidenceLedger';
import {getConsumableProcessIdentitySelectors} from '../processIdentity/identityGate';
import {executableSqlUnits} from './processScopeSql';
import type {SkillDefinition} from './types';

/** Registry metadata only: discovery neither executes SQL nor issues a metric witness. */
export function investigationProducerCatalog(skills: readonly SkillDefinition[], metricId: string) {
  if (!metricId) return [];
  return skills.flatMap(skill => {
    const seen = new Set<object>();
    return executableSqlUnits(skill).flatMap(unit => {
      // One producer can have named/exact SQL variants. Distinct nodes may share
      // an id, so retain their structural location and deduplicate by identity.
      if (seen.has(unit.node)) return [];
      seen.add(unit.node);
      if (typeof unit.source.sql !== 'string' || !unit.source.sql.trim()) return [];
      const declaration = unit.node.investigation_evidence as InvestigationEvidenceDeclaration | undefined;
      if (!declaration || investigationEvidenceDeclarationError(declaration)) return [];
      const metrics = declaration.metrics.filter(metric => metric.metric_id === metricId);
      if (!metrics.length) return [];
      const inputs = (skill.inputs ?? []).map(input => ({name: input.name, type: input.type,
        required: input.required, hasDefault: input.default !== undefined}));
      return [{
        skillId: skill.name, stepId: unit.path, sqlAt: unit.sqlAt,
        inputs,
        requiredWithoutDefault: inputs.filter(input => input.required && !input.hasDefault).map(input => input.name),
        processIdentitySelectors: [...getConsumableProcessIdentitySelectors(skill)].sort(),
        guarded: unit.guarded, stepOptional: unit.node.optional === true,
        availability: 'not_checked' as const,
        prerequisites: {
          requiredTables: [...(skill.prerequisites?.required_tables ?? [])],
          modules: [...(skill.prerequisites?.modules ?? [])],
        },
        metrics: metrics.map(metric => ({metricId: metric.metric_id, domain: metric.domain,
          valueColumn: metric.value, statusColumn: metric.status,
          ...(metric.unit === undefined ? {} : {unit: metric.unit}),
          ...(metric.coverage === undefined ? {} : {coverageColumn: metric.coverage}),
          ...(metric.denominator === undefined ? {} : {denominatorColumn: metric.denominator}),
          ...(metric.aggregation === undefined ? {} : {aggregation: metric.aggregation}),
        })),
      }];
    });
  }).sort((left, right) => left.skillId.localeCompare(right.skillId) || left.sqlAt.localeCompare(right.sqlAt));
}
