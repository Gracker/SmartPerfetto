// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {RequestContext} from '../../../middleware/auth';
import type {CaseNode} from '../../../types/sparkContracts';
import {curatedCaseNode} from '../../../../tests/helpers/caseStoreFixture';
import {
  attestCaseCuration,
  caseCurationGrantForMarkdownIngest,
  caseCurationGrantForRequest,
  describeCaseCuration,
  hasValidCaseAttestation,
  isAnalysisAdmittedCase,
  type CaseCurationGrant,
} from '../caseCuration';

function context(roles: string[], scopes: string[] = []): RequestContext {
  return {
    tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'curator-a', authType: 'sso',
    roles, scopes, requestId: 'request-a',
  };
}

const reviewedCase = (overrides: Partial<CaseNode> = {}) => curatedCaseNode('case-a', overrides);

describe('case curation grants', () => {
  it('issues an API grant only to a curator, naming the signed-in user', () => {
    expect(caseCurationGrantForRequest(context(['workspace_admin'])))
      .toEqual({issuer: 'curator_api', actor: 'curator-a'});
    expect(caseCurationGrantForRequest(context([], ['self_evolution:curate'])).issuer).toBe('curator_api');
    expect(() => caseCurationGrantForRequest(context(['analyst'], ['trace:read', 'agent:run'])))
      .toThrow('case_curation_forbidden');
  });

  it('issues an ingest grant with no authenticated identity', () => {
    expect(caseCurationGrantForMarkdownIngest()).toEqual({issuer: 'markdown_ingest'});
  });

  it('attests only under a grant it issued: never a literal, a copy or JSON', () => {
    const grant = caseCurationGrantForRequest(context(['workspace_admin']));
    expect(attestCaseCuration(grant, reviewedCase()).issuer).toBe('curator_api');
    for (const forged of [
      {issuer: 'curator_api', actor: 'curator-a'},
      {...grant},
      JSON.parse(JSON.stringify(grant)),
    ]) {
      expect(() => attestCaseCuration(forged as CaseCurationGrant, reviewedCase())).toThrow('case_curation_grant_required');
    }
  });

  it('records the signed-in curator as the actor of an API attestation, and none for an ingest', () => {
    expect(attestCaseCuration(caseCurationGrantForRequest(context(['workspace_admin'])), reviewedCase(), 7))
      .toEqual({version: 1, issuer: 'curator_api', actor: 'curator-a', issuedAt: 7, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/)});
    expect(attestCaseCuration(caseCurationGrantForMarkdownIngest(), reviewedCase()))
      .not.toHaveProperty('actor');
  });
});

describe('case attestation', () => {
  const grant = caseCurationGrantForMarkdownIngest();

  it('vouches for exactly the record it was issued for, its status included', () => {
    const record = reviewedCase();
    const attestation = attestCaseCuration(grant, record);
    expect(hasValidCaseAttestation(record, attestation)).toBe(true);
    expect(hasValidCaseAttestation(reviewedCase({title: 'edited after the review'}), attestation)).toBe(false);
    expect(hasValidCaseAttestation(reviewedCase({status: 'published'}), attestation)).toBe(false);
    expect(hasValidCaseAttestation(reviewedCase({tags: ['scrolling']}), attestation)).toBe(false);
  });

  it('hashes the stored JSON form, so a record still verifies after its store round trip', () => {
    const record = reviewedCase({
      traceArtifactId: undefined,
      findings: [{id: 'f1', severity: 'warning', title: 'x', evidence: undefined}],
      knowledge: {
        sourceFile: 'cases/a.md',
        body: 'body',
        quality: 'curated',
        scene: 'scrolling',
        domainPack: 'scrolling.v1',
        taxonomy: {primary_root_cause: 'shader_compile', secondary_root_causes: [], responsibility: 'app', severity: 'warning'},
        // YAML frontmatter can carry a Date; arrays keep holes and non-finite numbers as null.
        context: {capturedOn: new Date('2026-01-02T03:04:05Z'), samples: [1, undefined, Number.NaN, Infinity]},
        evidenceSignatures: {required: [], supportive: []},
        recommendations: {app: [], oem: []},
      },
    });
    const attestation = attestCaseCuration(grant, record);
    expect(hasValidCaseAttestation(record, attestation)).toBe(true);
    expect(hasValidCaseAttestation(JSON.parse(JSON.stringify(record)), attestation)).toBe(true);
  });

  it('binds content under an own __proto__ key too', () => {
    // JSON.parse keeps an own __proto__ key, which a store round trip preserves.
    const record = (note: string): CaseNode =>
      ({...reviewedCase(), ...JSON.parse(`{"extra": {"__proto__": {"note": "${note}"}}}`)});
    const attestation = attestCaseCuration(grant, record('measured'));
    expect(hasValidCaseAttestation(record('measured'), attestation)).toBe(true);
    expect(hasValidCaseAttestation(record('edited'), attestation)).toBe(false);
  });

  it('ignores key order', () => {
    const record = reviewedCase();
    const reordered = Object.fromEntries(Object.entries(record).reverse()) as unknown as CaseNode;
    expect(hasValidCaseAttestation(reordered, attestCaseCuration(grant, record))).toBe(true);
  });

  it('rejects an attestation of the wrong shape, version or issuer', () => {
    const record = reviewedCase();
    const attestation = attestCaseCuration(grant, record);
    for (const invalid of [
      undefined,
      null,
      'attested',
      {...attestation, version: 2},
      {...attestation, issuer: 'runtime_analysis'},
      {...attestation, actor: 42},
      {...attestation, issuedAt: Number.NaN},
      {...attestation, contentHash: attestation.contentHash.toUpperCase()},
      {...attestation, contentHash: undefined},
    ]) {
      expect(hasValidCaseAttestation(record, invalid)).toBe(false);
    }
  });

  it('does not protect its own audit fields: only the content is bound', () => {
    const record = reviewedCase();
    const attestation = attestCaseCuration(grant, record);
    expect(hasValidCaseAttestation(record, {...attestation, actor: 'someone-else', issuedAt: 1})).toBe(true);
  });
});

describe('analysis admission', () => {
  const grant = caseCurationGrantForMarkdownIngest();
  const admitted = (record: CaseNode) => isAnalysisAdmittedCase(record, attestCaseCuration(grant, record));

  it('admits a published or reviewed case declared shareable and attested as it is', () => {
    expect(admitted(reviewedCase())).toBe(true);
    expect(admitted(reviewedCase({status: 'published'}))).toBe(true);
  });

  it('never admits a draft, a private case or an undeclared one, attested or not', () => {
    expect(admitted(reviewedCase({status: 'draft'}))).toBe(false);
    expect(admitted(reviewedCase({status: 'private'}))).toBe(false);
    expect(admitted(reviewedCase({redactionState: 'raw'}))).toBe(false);
    expect(admitted(reviewedCase({redactionState: 'partial'}))).toBe(false);
    expect(isAnalysisAdmittedCase(reviewedCase(), undefined)).toBe(false);
  });

  it('tells a curator whether analyses read a case and who last vouched for it', () => {
    const record = reviewedCase();
    const apiGrant = caseCurationGrantForRequest(context(['workspace_admin']));
    expect(describeCaseCuration(record, attestCaseCuration(apiGrant, record, 9)))
      .toEqual({analysisAdmitted: true, curation: {issuer: 'curator_api', actor: 'curator-a', issuedAt: 9}});
    const draft = reviewedCase({status: 'draft'});
    expect(describeCaseCuration(draft, attestCaseCuration(grant, draft, 9)))
      .toEqual({analysisAdmitted: false, curation: {issuer: 'markdown_ingest', issuedAt: 9}});
    expect(describeCaseCuration(record, undefined)).toEqual({analysisAdmitted: false});
  });
});
