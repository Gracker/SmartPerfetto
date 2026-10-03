// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from '@jest/globals';

jest.mock('commander', () => ({
  Command: class {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    action() { return this; }
  },
}));

import { validateContracts, validateFile } from '../commands/validate';
import type { SkillDefinition } from '../../services/skillEngine/types';

/** `validate:skills` resolves `save_from` against every Skill on disk. */
describe('validate --contracts save_from', () => {
  const withReference = (skill: string, saveFrom: string): SkillDefinition => ({
    name: 'save_from_contract_probe', version: '1', type: 'composite',
    meta: {display_name: 'probe', description: 'probe'},
    steps: [{id: 'ref', skill, save_as: 'rows', save_from: saveFrom} as any],
  });
  const saveFromErrors = (skill: SkillDefinition) =>
    validateContracts(skill).errors.filter(error => error.includes('save_from'));

  it('accepts the shipped binding and a real child step', () => {
    const shipped = yaml.load(fs.readFileSync(
      path.join(process.cwd(), 'skills/composite/jank_frame_detail.skill.yaml'), 'utf8')) as SkillDefinition;
    expect(saveFromErrors(shipped)).toEqual([]);
    expect(saveFromErrors(withReference('cpu_throttling_in_range', 'throttle_detection'))).toEqual([]);
  });

  it('rejects an unknown child step and an unknown child Skill', () => {
    expect(saveFromErrors(withReference('cpu_throttling_in_range', 'no_such_step')))
      .toEqual([expect.stringContaining("has no top-level step 'no_such_step'")]);
    expect(saveFromErrors(withReference('no_such_skill_d10', 'limit_evidence')))
      .toEqual([expect.stringContaining("'no_such_skill_d10' does not exist")]);
  });
});

/** No runtime interpolates a rule confidence: a template or a severity word would misreport. */
describe('validate --contracts diagnostic confidence', () => {
  const withConfidence = (confidence: unknown): SkillDefinition => ({
    name: 'confidence_contract_probe', version: '1', type: 'composite',
    meta: {display_name: 'probe', description: 'probe'},
    steps: [{id: 'verdict', type: 'diagnostic', inputs: [], rules: [
      {condition: 'true', diagnosis: 'observed', confidence},
    ]} as any],
  });
  const confidenceErrors = (confidence: unknown) =>
    validateContracts(withConfidence(confidence)).errors.filter(error => error.includes('confidence'));

  it('accepts a literal level, a number, or no confidence', () => {
    for (const confidence of ['high', 'medium', 'low', 0.8, undefined]) {
      expect(confidenceErrors(confidence)).toEqual([]);
    }
  });

  it('rejects a template, a severity word and a non-finite number', () => {
    for (const confidence of ["${level === '高' ? 'high' : 'low'}", 'critical', Number.NaN]) {
      expect(confidenceErrors(confidence)).toEqual([
        expect.stringContaining('steps[0].rules[0].confidence: Diagnostic rule confidence must be high, medium, low or a number'),
      ]);
    }
  });
});

/** A saved-result path read must say whether its step runs without the row, as both runtimes read it. */
describe('validate --contracts saved-result path reads', () => {
  const reading = (sql: string, condition?: string): SkillDefinition => ({
    name: 'result_read_contract_probe', version: '1', type: 'composite',
    meta: {display_name: 'probe', description: 'probe'},
    steps: [
      {id: 'probe', type: 'atomic', sql: 'SELECT 1 AS status', save_as: 'cov'},
      {id: 'reader', type: 'atomic', sql, ...(condition ? {condition} : {})},
    ] as any,
  });
  const readErrors = (skill: SkillDefinition) =>
    validateContracts(skill).errors.filter(error => error.includes("earlier step's result"));

  it('accepts a default or a guarding condition and rejects neither', () => {
    expect(readErrors(reading("SELECT '${cov.data[0].status|}' AS s"))).toEqual([]);
    expect(readErrors(reading("SELECT '${cov.data[0].status}' AS s", 'cov.data?.length > 0'))).toEqual([]);
    expect(readErrors(reading("SELECT '${cov.data[0].status}' AS s")))
      .toEqual([expect.stringContaining('steps[1].sql: ${cov.data[0].status} reads')]);
  });
});

/** Heat or cap wording must have the evidence behind it, as validate:skills and Self-Evolution read it. */
describe('validate --contracts cause wording', () => {
  it('rejects a cap the Skill reads no limit evidence for, in the text the catalog shows', () => {
    const probe = (label: string): SkillDefinition => ({
      name: 'cause_wording_contract_probe', version: '1', type: 'atomic',
      meta: {display_name: 'probe', description: 'probe'},
      steps: [{id: 'drops', type: 'atomic', sql: 'SELECT 1 AS n', display: {columns: [{name: 'n', label}]}}] as any,
    });
    const wordingErrors = (skill: SkillDefinition) =>
      validateContracts(skill).errors.filter(error => error.includes('as a cause'));
    expect(wordingErrors(probe('频率下调次数'))).toEqual([]);
    expect(wordingErrors(probe('降频次数'))).toEqual([expect.stringContaining('steps.drops.catalog.columns.n.label.zh-CN')]);
  });
});

/** A top-level key no loader reads would read as configuration that takes effect. */
describe('validate top-level keys of vendor overrides and pipelines', () => {
  const validateYaml = (fileName: string, lines: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-validate-keys-'));
    try {
      const file = path.join(dir, fileName);
      fs.writeFileSync(file, [...lines, ''].join('\n'));
      return validateFile(file).errors;
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  };
  const override = (extra: string[], steps = ['additional_steps:', '  - {id: vendor_rows, name: Rows, sql: SELECT 1}']) => [
    'extends: composite/startup_analysis', 'version: "1"', 'meta: {vendor: pixel, display_name: P, description: P}',
    'vendor_detection:', '  signatures:', '    - {pattern: Pixel, confidence: high}', ...steps, ...extra,
  ];

  it('accepts every shipped vendor override and pipeline', () => {
    const errors = (dir: string, pattern: RegExp) => fs.readdirSync(dir, {recursive: true, encoding: 'utf8'})
      .filter(file => pattern.test(file) && !path.basename(file).startsWith('_'))
      .flatMap(file => validateFile(path.join(dir, file)).errors.map(error => `${file}: ${error}`));
    expect(errors(path.join(process.cwd(), 'skills/vendors'), /\.override\.yaml$/)).toEqual([]);
    expect(errors(path.join(process.cwd(), 'skills/pipelines'), /\.skill\.yaml$/)).toEqual([]);
  });

  it('rejects a vendor override key the registry does not read, and one with no additional step', () => {
    expect(validateYaml('x.override.yaml', override([]))).toEqual([]);
    expect(validateYaml('x.override.yaml', override(['thresholds_override: {cold_start_time: {levels: {}}}'])))
      .toEqual([expect.stringContaining('thresholds_override: No loader reads')]);
    expect(validateYaml('x.override.yaml', override(['override_params: {limit: 1}'], [])))
      .toEqual([
        expect.stringContaining('override_params: No loader reads'),
        expect.stringContaining('declare additional_steps'),
      ]);
  });

  it('rejects a pipeline key the pipeline loaders do not read', () => {
    const pipeline = ['name: pipeline_x', 'version: "1"', 'type: pipeline_definition', 'category: rendering',
      'meta: {pipeline_id: X}', 'teaching: {source: x}', 'auto_pin: {}'];
    expect(validateYaml('x.skill.yaml', pipeline)).toEqual([]);
    expect(validateYaml('x.skill.yaml', [...pipeline, 'display: {level: summary}']))
      .toEqual([expect.stringContaining('display: No loader reads')]);
  });
});
