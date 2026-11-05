// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import * as capture from '../evidenceCapture';
import {captureEvidenceTable, MODEL_EVIDENCE_STRING_MAX_BYTES,
  MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT, MODEL_EVIDENCE_UNIT_MAX_BYTES,
  projectEvidenceColumnUnitsForModel, projectEvidenceTableForModel} from '../evidenceCapture';
import {projectModelEvidenceMetadata} from '../modelEvidenceMetadata';
import {stringifyRuntimeToolResult} from '../../../agentRuntime/runtimeToolSpec';
import {createRuntimeToolResult} from '../../../agentRuntime/runtimeToolResult';

describe('model evidence projection', () => {
  it('separates row readability, some issued column units and absent metric binding', () => {
    const data = {columns: ['dur', 'name', 'duration_ms'], rows: [[33000000, 'task', 33]]};
    const witness = captureEvidenceTable(data, {dur: {unit: 'ns',
      origin: {kind: 'native_producer', definitionFingerprint: 'PRIVATE_FINGERPRINT'}}});
    const projected = projectModelEvidenceMetadata({...data, columnUnits: {duration_ms: 'ms'},
      modelEvidence: {registeredMetricBinding: 'present'}}, witness);
    expect(projected).toEqual({columnUnits: {dur: 'ns'}, modelEvidence: {
      captureRows: 'available', columnUnits: 'available', registeredMetricBinding: 'absent'}});
    expect(projectEvidenceColumnUnitsForModel(data, witness)).toEqual(projected.columnUnits);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_FINGERPRINT|verified|proofEligible/);
    expect(data.rows).toEqual([[33000000, 'task', 33]]);
  });

  it('keeps a genuine empty capture distinct from absent rows and preserves typed partial strings', () => {
    const empty = {columns: ['value'], rows: []};
    expect(projectModelEvidenceMetadata(empty, captureEvidenceTable(empty)).modelEvidence)
      .toEqual({captureRows: 'empty', columnUnits: 'unknown', registeredMetricBinding: 'absent'});
    expect(projectModelEvidenceMetadata(empty).modelEvidence)
      .toEqual({captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'});
    const original = {columns: ['text', 'value'], rows: [['中'.repeat(5000), 1]]};
    const witness = captureEvidenceTable(original);
    const projection = projectEvidenceTableForModel(original, witness);
    expect(projection.modelProjection.status).toBe('truncated');
    expect(projectModelEvidenceMetadata(projection.data, witness).modelEvidence.captureRows).toBe('available');
    expect(projection.modelProjection.status).toBe('truncated');
  });

  it.each(['unissued', 'unavailable', 'changed_rows', 'duplicate_columns', 'column_mismatch', 'unsupported_cell'] as const)
  ('does not recover readable/issued metadata from an invalid projection: %s', kind => {
    const data = {columns: ['dur'], rows: [[1]]};
    const origin = {kind: 'native_producer' as const, definitionFingerprint: 'private'};
    const witness = kind === 'unissued' ? {captureId: 'forged'} : kind === 'unavailable'
      ? captureEvidenceTable(undefined, {}, 'missing')
      : captureEvidenceTable({columns: ['dur'], rows: [[kind === 'changed_rows' ? 2 : kind === 'unsupported_cell' ? undefined : 1]]},
        {dur: {origin, unit: 'ns'}});
    const display = kind === 'duplicate_columns' ? {columns: ['dur', 'dur'], rows: [[1, 1]]}
      : kind === 'column_mismatch' ? {columns: ['other'], rows: [[1]]} : data;
    expect(projectModelEvidenceMetadata({...display, columnUnits: {dur: 'ns'},
      modelEvidence: {captureRows: 'available', registeredMetricBinding: 'present'}}, witness))
      .toEqual({modelEvidence: {captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
    expect(projectEvidenceColumnUnitsForModel(display, witness)).toBeUndefined();
  });

  it('keeps unsafe or untrusted units unknown rather than inferring them from numeric-looking aliases', () => {
    const data = {columns: ['unsafe_ms', 'untrusted_ns'], rows: [[1, 2]]};
    const witness = captureEvidenceTable(data, {
      unsafe_ms: {unit: 'ms\nPRIVATE', origin: {kind: 'skill_literal', definitionFingerprint: 'valid'}},
      untrusted_ns: {unit: 'ns', origin: {kind: 'native_producer', definitionFingerprint: ''}},
    });
    expect(projectModelEvidenceMetadata(data, witness)).toEqual({modelEvidence: {
      captureRows: 'available', columnUnits: 'unknown', registeredMetricBinding: 'absent'}});
  });

  it('contains only metadata calculation failures without changing input data', () => {
    const data = {columns: ['value'], rows: [[1]]};
    const projection = jest.spyOn(capture, 'projectEvidenceCaptureMetadataForModel')
      .mockImplementation(() => {throw new Error('PRIVATE_METADATA_ERROR');});
    try {
      expect(projectModelEvidenceMetadata(data)).toEqual({modelEvidence: {
        captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
      expect(data.rows).toEqual([[1]]);
    } finally {projection.mockRestore();}
  });

  it('measures additive metadata at the actual production tool serialization boundary', () => {
    const data = {columns: ['duration_ms', 'label'], rows: [[33, '中"\\\n']]};
    const available = projectModelEvidenceMetadata(data, captureEvidenceTable(data));
    const empty = {columns: data.columns, rows: []};
    const payloads = [
      {surface: 'raw_inline', payload: {success: true, ...data, totalRows: 1}, metadata: available},
      {surface: 'summary', payload: {success: true, totalRows: 1, columns: data.columns, sampleRows: data.rows}, metadata: available},
      {surface: 'artifact_page', payload: {id: 'art-1', columns: data.columns, rows: [{rowIndex: 0, values: data.rows[0]}], totalRows: 1, hasMore: false}, metadata: available},
      {surface: 'empty_capture', payload: {success: true, ...empty, totalRows: 0},
        metadata: projectModelEvidenceMetadata(empty, captureEvidenceTable(empty))},
      {surface: 'restored_without_witness', payload: {id: 'art-1', ...data}, metadata: projectModelEvidenceMetadata(data)},
    ];
    for (const {surface, payload, metadata} of payloads) {
      const before = Buffer.byteLength(stringifyRuntimeToolResult(createRuntimeToolResult(payload)));
      const after = Buffer.byteLength(stringifyRuntimeToolResult(createRuntimeToolResult({...payload, ...metadata})));
      expect(after - before).toBeGreaterThan(0);
      expect(after - before).toBeLessThan(256);
      console.info('[evidence-feedback serializer]', JSON.stringify({surface, beforeBytes: before, afterBytes: after, deltaBytes: after - before}));
    }
  });

  it('restores typed scalar cells in display column order', () => {
    const long = 'raw-'.repeat(40);
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['text', 'missing', 'enabled', 'count'],
      rows: [[long, null, false, 7]]}, {count: {origin, unit: 'ms'}});
    const display = {columns: ['enabled', 'text', 'missing'], rows: [['否', `${long.slice(0, 97)}...`, '-']]};
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected).toEqual({
      data: {columns: ['enabled', 'text', 'missing'], rows: [[false, long, null]]},
      modelProjection: {status: 'exact'},
    });
  });

  it('exposes only trusted explicit units without inferring percentage scale', () => {
    const trusted = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const missingFingerprint = {kind: 'skill_literal' as const, definitionFingerprint: '', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['ttid_ms', 'busy_pct', 'ambiguous_pct', 'unsafe', 'untrusted'],
      rows: [[1912.2, 68.1, 0.3, 1, 2]]}, {
      ttid_ms: {origin: trusted, unit: 'ms'},
      busy_pct: {origin: trusted, unit: '%'},
      unsafe: {origin: trusted, unit: `x\n${'u'.repeat(MODEL_EVIDENCE_UNIT_MAX_BYTES)}`},
      untrusted: {origin: missingFingerprint, unit: 'ms'},
    });
    const projected = projectEvidenceTableForModel({
      columns: ['ambiguous_pct', 'busy_pct', 'ttid_ms', 'unsafe', 'untrusted'],
      rows: [['30%', '68.1%', '1912.20 ms', '1', '2']],
    }, witness);
    expect(projected.columnUnits).toEqual({busy_pct: '%', ttid_ms: 'ms'});
    expect(projected.columnUnits).not.toHaveProperty('ambiguous_pct');
    expect(projected.columnUnits).not.toHaveProperty('unsafe');
    expect(projected.columnUnits).not.toHaveProperty('untrusted');
  });

  it('bounds UTF-8 strings and caps truncation locators', () => {
    const raw = '中'.repeat(MODEL_EVIDENCE_STRING_MAX_BYTES);
    const columns = Array.from({length: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3}, (_, index) => `c${index}`);
    const witness = captureEvidenceTable({columns, rows: [columns.map(() => raw)]});
    const projected = projectEvidenceTableForModel({columns, rows: [columns.map(() => '中...')]}, witness);
    const first = (projected.data as {rows: string[][]}).rows[0][0];
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(MODEL_EVIDENCE_STRING_MAX_BYTES);
    expect(projected.modelProjection).toMatchObject({status: 'truncated',
      truncatedCellCount: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3,
      truncatedCellsOmitted: 3});
    expect(projected.modelProjection.truncatedCells).toHaveLength(MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT);
  });

  it.each([
    ['unissued_witness', undefined, {columns: ['value'], rows: [['-']]}],
    ['unavailable_witness', captureEvidenceTable(undefined, {}, 'unmapped'), {columns: ['value'], rows: [['-']]}],
    ['row_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null], [null]]}), {columns: ['value'], rows: [['-']]}],
    ['duplicate_columns', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['value', 'value'], rows: [['-', '-']]}],
    ['column_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['other'], rows: [['-']]}],
    ['unsupported_raw_cell', captureEvidenceTable({columns: ['value'], rows: [[undefined]]}), {columns: ['value'], rows: [['-']]},],
  ] as const)('fails closed without turning unknown cells into SQL NULL: %s', (reason, witness, display) => {
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected.data).toBe(display);
    expect(projected.modelProjection).toEqual({status: 'unavailable', reason});
  });

  it('rejects transformed and non-table display shapes', () => {
    const witness = captureEvidenceTable({columns: ['value'], rows: [[null]]});
    const display = {text: 'no data'};
    expect(projectEvidenceTableForModel(display, witness)).toEqual({data: display,
      modelProjection: {status: 'unavailable', reason: 'not_table'}});
  });
});
