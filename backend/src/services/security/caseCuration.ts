// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RequestContext} from '../../middleware/auth';
import {CURATED_CASE_STATUSES} from '../../types/caseKnowledge';
import type {CaseNode} from '../../types/sparkContracts';
import {hasRbacPermission} from '../rbac';
import {storedJsonContentHash} from '../selfEvolution/canonicalJson';

/**
 * A curated case reaches an analysis (background, recall, finalization hits,
 * similarity hints) only while a curator vouches for its exact current
 * content. Before `/api/cases` required curation, any signed-in user could
 * write a case with any `source` or reviewer, so nothing inside a record can
 * prove that. The proof is an attestation the case store keeps beside the
 * record, never in it: a request body shapes only the record, and a store
 * writer that does not set the attestation again, an older version's
 * included, drops it. Anyone who can write the store files or database
 * directly is trusted; this is a structural proof, not a signature.
 *
 * An attestation authorizes every run of the store's scope (a workspace in
 * the knowledge database; the whole install for the local case file), private
 * runs included, to put the case's analysis fields into its prompt and tool
 * results, and so to send them to that run's AI provider.
 */
export interface CaseCurationAttestation {
  version: 1;
  /** A signed-in curator through `/api/cases`, or the operator running Markdown ingest. */
  issuer: 'curator_api' | 'markdown_ingest';
  /** The signed-in curator; Markdown ingest has no authenticated identity. */
  actor?: string;
  issuedAt: number;
  /** The stored-JSON hash of the record this attestation vouches for. */
  contentHash: string;
}

declare const issuedBrand: unique symbol;
/** The authority behind a case write; only the two issuers below create one, and a literal does not type-check. */
export interface CaseCurationGrant {
  readonly issuer: CaseCurationAttestation['issuer'];
  readonly actor?: string;
  readonly [issuedBrand]: true;
}

// Attesting accepts only a grant issued here; a copy, a forged object or one
// rebuilt from JSON is not in it.
const issuedGrants = new WeakSet<object>();

function issueGrant(issuer: CaseCurationGrant['issuer'], actor?: string): CaseCurationGrant {
  const grant = Object.freeze({issuer, ...(actor ? {actor} : {})}) as CaseCurationGrant;
  issuedGrants.add(grant);
  return grant;
}

/** A curator's write through `/api/cases`; refused without `self_evolution:curate`. */
export function caseCurationGrantForRequest(context: RequestContext): CaseCurationGrant {
  if (!hasRbacPermission(context, 'self_evolution:curate')) throw new Error('case_curation_forbidden');
  return issueGrant('curator_api', context.userId);
}

/** The operator importing curated Markdown, issued once by the import command. */
export function caseCurationGrantForMarkdownIngest(): CaseCurationGrant {
  return issueGrant('markdown_ingest');
}

/** The attestation a case store writes beside `record`, only under a grant issued here. */
export function attestCaseCuration(
  grant: CaseCurationGrant,
  record: CaseNode,
  now = Date.now(),
): CaseCurationAttestation {
  if (!issuedGrants.has(grant)) throw new Error('case_curation_grant_required');
  return {
    version: 1,
    issuer: grant.issuer,
    ...(grant.actor ? {actor: grant.actor} : {}),
    issuedAt: now,
    contentHash: storedJsonContentHash(record),
  };
}

function isAttestation(value: unknown): value is CaseCurationAttestation {
  if (!value || typeof value !== 'object') return false;
  const {version, issuer, actor, issuedAt, contentHash} = value as Partial<CaseCurationAttestation>;
  return version === 1 && (issuer === 'curator_api' || issuer === 'markdown_ingest') &&
    (actor === undefined || typeof actor === 'string') &&
    typeof issuedAt === 'number' && Number.isFinite(issuedAt) &&
    typeof contentHash === 'string' && /^[0-9a-f]{64}$/.test(contentHash);
}

/** Whether `attestation` vouches for exactly this record, whatever its status. */
export function hasValidCaseAttestation(record: CaseNode, attestation: unknown): attestation is CaseCurationAttestation {
  return isAttestation(attestation) && attestation.contentHash === storedJsonContentHash(record);
}

/** A published or reviewed case its author declared shareable (`redacted`). */
function isShareableCuratedCase(record: CaseNode): boolean {
  return (CURATED_CASE_STATUSES as readonly string[]).includes(record.status) && record.redactionState === 'redacted';
}

/** The one test every analysis read applies: shareable and attested for its current content. */
export function isAnalysisAdmittedCase(record: CaseNode, attestation: unknown): boolean {
  return isShareableCuratedCase(record) && hasValidCaseAttestation(record, attestation);
}

/** What a curator sees of a case's curation: whether analyses read it, and who last vouched for it. */
export interface CaseCurationView {
  analysisAdmitted: boolean;
  curation?: Omit<CaseCurationAttestation, 'version' | 'contentHash'>;
}

export function describeCaseCuration(record: CaseNode, attestation: unknown): CaseCurationView {
  if (!hasValidCaseAttestation(record, attestation)) return {analysisAdmitted: false};
  const {issuer, actor, issuedAt} = attestation;
  return {
    analysisAdmitted: isShareableCuratedCase(record),
    curation: {issuer, ...(actor ? {actor} : {}), issuedAt},
  };
}
