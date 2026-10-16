// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// REST contract for vendor identity: /api/skills/detect-vendor returns the
// trace_vendor@1 shape, and /api/skills/execute reports `vendor` only for an
// identified OEM. Both go through the real adapter and resolver over a stub
// trace processor that answers the resolver's metadata query.

import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {Request, Response} from 'express';
import SkillController from '../skillController';
import {SkillAnalysisAdapter} from '../../services/skillEngine/skillAnalysisAdapter';
import {SkillRegistry} from '../../services/skillEngine/skillLoader';
import {
  clearTraceVendorCacheForTests,
  TRACE_VENDOR_METADATA_SQL,
} from '../../services/traceVendor/traceVendorResolver';
import {
  metadataQueryResult,
  metadataRows,
  vendorQueryServiceDouble,
} from '../../services/traceVendor/__tests__/traceVendorFixture';

function responseDouble() {
  const response = {status: jest.fn(), json: jest.fn()};
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as typeof response & Response;
}

function request(body: Record<string, unknown>, params: Record<string, string> = {}): Request {
  return {body: {outputLanguage: 'en', ...body}, query: {}, headers: {}, params} as unknown as Request;
}

const OPPO = metadataQueryResult(metadataRows({manufacturer: 'OPPO', soc: 'SM8750', sdk: 36,
  fingerprint: 'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376-7328d8-769621:user/release-keys'}));
const NUBIA = metadataQueryResult(metadataRows({soc: 'SM8750',
  fingerprint: 'nubia/pacific/pacific:15/1.4.1.0/101:user/release-keys'}));

function controllerWith(answer: () => Promise<unknown>) {
  const query = jest.fn(async (_traceId: string, sql: string) => {
    if (sql !== TRACE_VENDOR_METADATA_SQL) throw new Error(`unexpected SQL: ${sql}`);
    return answer();
  });
  const registry = new SkillRegistry();
  const skill = {name: 'vendor_rest_probe', version: '1', type: 'atomic',
    meta: {display_name: 'Vendor probe', description: 'Vendor probe'}, sql: 'SELECT 1'};
  (registry as any).skills.set(skill.name, skill);
  (registry as any).skillOrigins.set(skill.name, {origin: 'external_pack', packId: 'test-pack'});
  (registry as any).initialized = true;
  const adapter = new SkillAnalysisAdapter(vendorQueryServiceDouble(query) as any, undefined, {registry});
  jest.spyOn((adapter as any).executor, 'execute')
    .mockResolvedValue({success: true, displayResults: [], diagnostics: [], executionTimeMs: 0} as never);
  const controller = new SkillController();
  (controller as unknown as {adapter: SkillAnalysisAdapter}).adapter = adapter;
  return {controller, query};
}

describe('POST /api/skills/detect-vendor', () => {
  beforeEach(() => clearTraceVendorCacheForTests());

  it('returns exactly the trace_vendor@1 fields with a numeric confidence', async () => {
    const {controller} = controllerWith(async () => OPPO);
    const response = responseDouble();
    await controller.detectVendor(request({traceId: 'trace-rest'}), response);

    expect(response.status).not.toHaveBeenCalled();
    const body = response.json.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['confidence', 'evidence', 'os', 'schemaVersion', 'soc', 'source', 'vendor', 'vendorConfidence']);
    expect(body).toEqual({
      schemaVersion: 'trace_vendor@1', vendor: 'oppo', confidence: 0.9, vendorConfidence: 'high',
      soc: 'qualcomm', os: 'android', source: 'metadata_manufacturer',
      evidence: {manufacturer: 'OPPO', fingerprintBrand: 'OPPO', socModel: 'SM8750', sdk: 36},
    });
    expect(typeof body.confidence).toBe('number');
  });

  it('adds brand for an unmapped vendor and reports unknown with confidence 0 on failure', async () => {
    const nubia = controllerWith(async () => NUBIA);
    const response = responseDouble();
    await nubia.controller.detectVendor(request({traceId: 'trace-nubia'}), response);
    expect(response.json.mock.calls[0][0]).toMatchObject({vendor: 'other', brand: 'nubia', soc: 'qualcomm',
      source: 'metadata_fingerprint', confidence: 0.9});

    const failing = controllerWith(async () => ({columns: [], rows: [], durationMs: 0, error: 'no such table'}));
    const failed = responseDouble();
    await failing.controller.detectVendor(request({traceId: 'trace-failed'}), failed);
    expect(failed.status).not.toHaveBeenCalled();
    expect(failed.json.mock.calls[0][0]).toMatchObject({schemaVersion: 'trace_vendor@1', vendor: 'unknown',
      confidence: 0, vendorConfidence: 'low', source: 'query_failed', soc: 'unknown', os: 'unknown'});
  });

  it('still rejects a request without traceId', async () => {
    const {controller, query} = controllerWith(async () => OPPO);
    const response = responseDouble();
    await controller.detectVendor(request({}), response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /api/skills/execute/:skillId vendor field', () => {
  beforeEach(() => clearTraceVendorCacheForTests());

  it.each([
    ['an identified OEM', OPPO, 'oppo'],
    ['an unmapped brand', NUBIA, undefined],
    ['no identity', metadataQueryResult([]), undefined],
  ])('reports vendor for %s', async (_label, answer, expected) => {
    const {controller} = controllerWith(async () => answer);
    const response = responseDouble();
    await controller.executeSkill(request({traceId: 'trace-execute'}, {skillId: 'vendor_rest_probe'}), response);
    expect(response.status).not.toHaveBeenCalled();
    const body = JSON.parse(JSON.stringify(response.json.mock.calls[0][0])) as Record<string, unknown>;
    expect(body.success).toBe(true);
    if (expected) expect(body.vendor).toBe(expected);
    else expect('vendor' in body).toBe(false);
  });
});
