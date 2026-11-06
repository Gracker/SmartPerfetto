// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {z} from 'zod';
import {AUTHORED_CLAIM_OBJECT_VERSION} from './authoredClaimObject';
import {CONCLUSION_PROTOCOL_VALUES} from './conclusionContract';

// Generation constraints only. The pure compiler reads original values without
// using Zod to filter invalid semantic entries or normalize their contents.
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const index = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const referenceUse = index;
const valuePresence = z.union([
  z.strictObject({kind: z.literal('absent')}),
  z.strictObject({kind: z.literal('present'), value: scalar.nullable()}),
]);
const relationValuePresence = z.union([
  z.strictObject({kind: z.literal('absent')}),
  z.strictObject({kind: z.literal('present'), value: scalar}),
]);

const reference = z.strictObject({
  evidenceRefId: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceToolCallId: z.string().nullable(),
  artifactId: z.string().nullable(),
  sourceArtifactId: z.string().nullable(),
  column: z.string().nullable(),
  rowIndex: z.number().nullable(),
  rowSelector: z.array(z.strictObject({key: z.string(), value: scalar})).nullable(),
  value: valuePresence,
});

const artifactSelector = z.union([
  z.strictObject({
    encoding: z.literal('entries'),
    entries: z.array(z.strictObject({key: z.string(), value: scalar.nullable()})),
  }),
  z.strictObject({encoding: z.literal('json_object'), jsonText: z.string()}),
]);
const artifactReference = z.strictObject({
  artifactId: z.string(),
  rowIndex: z.number().nullable(),
  rowSelector: artifactSelector.nullable(),
});

const semanticFrame = z.strictObject({
  predicate: z.string(),
  polarity: z.enum(CONCLUSION_PROTOCOL_VALUES.polarity),
  discourse: z.enum(CONCLUSION_PROTOCOL_VALUES.discourse),
  quantifier: z.enum(CONCLUSION_PROTOCOL_VALUES.quantifier),
  modality: z.enum(CONCLUSION_PROTOCOL_VALUES.modality),
  conditions: z.array(z.string()).nullable(),
  population: z.enum(CONCLUSION_PROTOCOL_VALUES.population),
});

// Ordinary unions produce anyOf, including the two explicit quote locations.
const quote = z.union([
  z.strictObject({kind: z.literal('global'), text: z.string(), occurrence: index.nullable()}),
  z.strictObject({
    kind: z.literal('body_part'),
    text: z.string(),
    partIndex: index,
    localOccurrence: index.nullable(),
  }),
]);
const presentation = z.strictObject({
  unit: z.string(),
  decimalPlaces: z.number(),
  rounding: z.literal('half_away_from_zero'),
  quotes: z.array(quote),
});
const numeric = z.strictObject({
  operator: z.enum(CONCLUSION_PROTOCOL_VALUES.operator),
  value: z.union([z.string(), z.number()]),
  unit: z.string(),
  presentation: presentation.nullable(),
});
const claimSemantics = z.strictObject({
  frameIndex: index,
  subjectRefs: z.array(referenceUse).nullable(),
  objectRefs: z.array(referenceUse).nullable(),
  timeRangeNs: z.strictObject({
    start: z.union([z.string(), z.number()]),
    end: z.union([z.string(), z.number()]),
  }).nullable(),
  numeric: numeric.nullable(),
});
const claim = z.strictObject({
  id: z.string().nullable(),
  conclusionId: z.string().nullable(),
  text: z.string(),
  kind: z.enum(CONCLUSION_PROTOCOL_VALUES.claimKind).nullable(),
  references: z.array(referenceUse),
  artifactRefs: z.array(artifactReference).nullable(),
  relationRefs: z.array(z.string()).nullable(),
  supportLevel: z.enum(CONCLUSION_PROTOCOL_VALUES.supportLevel).nullable(),
  semantics: claimSemantics.nullable(),
});

const proofBinding = z.strictObject({endpointColumn: z.string(), proofColumn: z.string()});
const relation = z.strictObject({
  id: z.string(),
  kind: z.enum(CONCLUSION_PROTOCOL_VALUES.relationKind),
  direction: z.enum(CONCLUSION_PROTOCOL_VALUES.direction),
  subject: referenceUse,
  object: referenceUse.nullable(),
  proof: referenceUse.nullable(),
  proofBindings: z.strictObject({subject: proofBinding, object: proofBinding}).nullable(),
  metricColumn: z.string().nullable(),
  value: relationValuePresence,
  unit: z.string().nullable(),
  deltaDirection: z.enum(CONCLUSION_PROTOCOL_VALUES.deltaDirection).nullable(),
});

const conclusion = z.strictObject({
  rank: z.number(),
  statement: z.string(),
  confidencePercent: z.number().nullable(),
  trigger: z.string().nullable(),
  supply: z.string().nullable(),
  amplification: z.string().nullable(),
});
const cluster = z.strictObject({
  cluster: z.string(),
  description: z.string().nullable(),
  frames: z.number().nullable(),
  percentage: z.number().nullable(),
  frameRefs: z.array(z.string()).nullable(),
  omittedFrameRefs: z.number().nullable(),
});
const sourceBinding = z.strictObject({
  claimId: z.string(),
  sourceReferenceIds: z.array(z.string()),
  traceEvidenceRefIds: z.array(z.string()),
});
const displayMetadata = z.strictObject({
  confidencePercent: z.number().nullable(),
  sceneId: z.string().nullable(),
  clusterPolicy: z.strictObject({
    outputMode: z.enum(['required', 'optional', 'none']),
    frameListMode: z.enum(['none', 'top', 'full']),
    maxFramesPerCluster: z.number().nullable(),
  }).nullable(),
});
const contract = z.strictObject({
  mode: z.enum(CONCLUSION_PROTOCOL_VALUES.mode),
  conclusions: z.array(conclusion).nullable(),
  clusters: z.array(cluster).nullable(),
  evidenceChain: z.array(z.strictObject({conclusionId: z.string(), text: z.string()})).nullable(),
  claims: z.array(claim),
  relationProposals: z.array(relation).nullable(),
  sourceClaimBindings: z.array(sourceBinding).nullable(),
  uncertainties: z.array(z.string()).nullable(),
  nextSteps: z.array(z.string()).nullable(),
  metadata: displayMetadata.nullable(),
});

/** Complete document only; the transport owns the outer {document: ...} envelope. */
export const authoredClaimObjectSchema = z.strictObject({
  representationVersion: z.literal(AUTHORED_CLAIM_OBJECT_VERSION),
  referenceDictionary: z.array(reference),
  semanticFrames: z.array(semanticFrame),
  contract,
  bodyParts: z.array(z.union([z.string(), z.strictObject({claimText: z.string()})])),
});

/** @internal Generation-shape test input. Runtime admission always validates the original unknown value. */
export type AuthoredClaimObjectInput = z.infer<typeof authoredClaimObjectSchema>;
