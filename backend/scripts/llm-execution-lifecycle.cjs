// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {types: utilTypes} = require('node:util');

const TARGET_ENV = 'SMARTPERFETTO_E2E_BENCHMARK_TARGET_JSON';
const CELLS = Object.freeze(['scheduler', 'startup', 'scrolling', 'source', 'dual']);
const SOURCE_FACET = Object.freeze({protocol: 'source_action_facet_review@1',
  facetId: 'source recommendation action semantics', receiptSchema: 'llm_source_facet_collection@1',
  reviewSchema: 'llm_source_action_facet_review@1', rubricVersion: 'source_action_rubric@1', exitCode: 3,
  receiptFile: 'source-facet-collection.json',
  rubric: Object.freeze(['object_and_facts', 'mechanism_and_call_chain', 'concrete_action',
    'causality_and_feasibility', 'validation_and_uncertainty', 'delivered_coverage'])});
const SOURCE_INPUTS = Object.freeze(['backend/src', 'backend/scripts', 'backend/strategies', 'backend/skills',
  'backend/tests/e2e', 'backend/migrations', 'backend/sql', 'backend/config', 'scripts',
  'backend/data/perfettoSqlDocs.json', 'backend/data/perfettoSqlIndex.light.json', 'backend/data/perfettoStdlibSymbols.json',
  'docs/rendering_pipelines', 'scripts/trace-processor-pin.env', 'scripts/perfetto-recording-tools-pin.env',
  'scripts/node-runtime-pin.env',
  'package.json', 'package-lock.json', 'backend/package.json', 'backend/package-lock.json',
  'backend/tsconfig.json', 'backend/tsconfig.typecheck.json']);
const OBSERVER_INPUTS = Object.freeze(['backend/src/agentRuntime/modelRequestMetrics.ts',
  'backend/src/agentRuntime/runtimePerformance.ts', 'backend/src/agentRuntime/runtimePerformanceContext.ts']);
const EXCLUDED_NAMES = new Set(['node_modules', 'dist', 'test-output', 'logs', '.git', '.gitnexus', '.omo']);
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,100}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  const sort = value => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(value));
}

// The native CLI cannot import TypeScript. Keep this bounded commitment codec in parity
// with runtimePerformance.ts; owning fixtures compare exact rows and fingerprints.
const TREATMENT_ID = 'assistant_text_to_native_v2@1';
const MIXED_CONTENT_TREATMENT_ID = 'assistant_text_to_native_v2@2';
const DUAL_CARRIER_TREATMENT_ID = 'assistant_text_to_native_v2_dual@1';
const TREATMENT_OUTPUTS = Object.freeze({
  base: Object.freeze({finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'}),
  candidate: Object.freeze({finalSubmission: 'authored_claim_document_v2', declarationSyntax: 'authoring_v2'}),
});
const DUAL_CARRIER_OUTPUTS = Object.freeze({base: TREATMENT_OUTPUTS.base,
  candidate: Object.freeze({finalSubmission: 'authored_claim_document_v2_dual', declarationSyntax: 'authoring_v2'})});
function treatmentOutputs(id = TREATMENT_ID) {
  if (id === TREATMENT_ID || id === MIXED_CONTENT_TREATMENT_ID) return TREATMENT_OUTPUTS;
  if (id === DUAL_CARRIER_TREATMENT_ID) return DUAL_CARRIER_OUTPUTS;
  throw new Error('benchmark_treatment_invalid');
}
const TREATMENT_FIELDS = ['/environment/SMARTPERFETTO_FINAL_SUBMISSION', '/environment/SMARTPERFETTO_CONCLUSION_AUTHORING'];
const configHash = value => hash(canonicalJson(value));
function buildConfigCommitments(value) {
  const rows = [], ancestors = new Set();
  let bytes = 0;
  const fail = () => {throw new Error('benchmark_config_observation_invalid');};
  const visit = (item, field, depth) => {
    if (rows.length >= 4096 || depth > 24 || field.length > 4096) fail();
    const add = (type, material) => rows.push({field, presence: 'present', type, valueCommitment: configHash(material)});
    if (item === undefined) {add('undefined', ['undefined']); return;}
    if (item === null) {add('null', ['null']); return;}
    if (typeof item === 'string') {bytes += Buffer.byteLength(item); if (bytes > 1024 * 1024) fail(); add('string', ['string', item]); return;}
    if (typeof item === 'boolean') {add('boolean', ['boolean', item]); return;}
    if (typeof item === 'number' && Number.isFinite(item)) {add('number', ['number', Object.is(item, -0) ? '-0' : String(item)]); return;}
    if (!item || typeof item !== 'object' || utilTypes.isProxy(item) || ancestors.has(item)) fail();
    ancestors.add(item);
    try {
      const array = Array.isArray(item), descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
      if (Reflect.ownKeys(item).length !== Object.keys(descriptors).length || keys.some(key => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
      if (array) {
        if (item.length > 4096 || keys.some(key => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail();
        add('array', ['array', item.length, keys.map(Number).sort((a, b) => a - b)]);
      } else {
        if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail();
        add('object', ['object', [...keys].sort()]);
      }
      for (const key of keys.sort()) visit(descriptors[key].value,
        `${field}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
    } finally {ancestors.delete(item);}
  };
  visit(value, '', 0);
  return rows.sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : 0);
}
function absentConfigField(field) {return {field, presence: 'absent', type: 'absent', valueCommitment: configHash(['absent'])};}
function parseConfigFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 4096) throw new Error('benchmark_config_fields_invalid');
  let previous;
  for (const row of fields) {
    if (!row || Object.keys(row).sort().join(',') !== 'field,presence,type,valueCommitment' ||
        typeof row.field !== 'string' || row.field.length > 4096 || !/^(?:\/(?:[^~\/]|~[01])*)*$/.test(row.field) ||
        previous !== undefined && row.field <= previous || !['absent', 'present'].includes(row.presence) ||
        !['absent', 'undefined', 'null', 'boolean', 'number', 'string', 'object', 'array'].includes(row.type) ||
        !HASH.test(row.valueCommitment || '') || (row.presence === 'absent') !== (row.type === 'absent') ||
        row.presence === 'absent' && row.valueCommitment !== absentConfigField(row.field).valueCommitment) throw new Error('benchmark_config_fields_invalid');
    previous = row.field;
  }
  if (fields[0].field !== '') throw new Error('benchmark_config_fields_invalid');
  return fields;
}
function alignConfigCommitments(left, right) {
  const sides = [new Map(parseConfigFields(left).map(row => [row.field, row])), new Map(parseConfigFields(right).map(row => [row.field, row]))];
  const keys = [...new Set(sides.flatMap(side => [...side.keys()]))].sort();
  if (keys.length > 4096) throw new Error('benchmark_config_fields_invalid');
  return sides.map(side => keys.map(key => side.get(key) ?? absentConfigField(key)));
}
function configFieldsFingerprint(fields) {return configHash({schemaVersion: 'benchmark_config_commitments@2', fields: parseConfigFields(fields)});}
function configControlsFingerprint(fields) {
  return configHash({schemaVersion: 'benchmark_config_commitments@2', fields: parseConfigFields(fields).map(row =>
    TREATMENT_FIELDS.includes(row.field) ? {...row, valueCommitment: configHash(['treatment_value', row.field])} : row)});
}
function makeConfigCommitments(fields, legacyConfigFingerprint) {
  if (!HASH.test(legacyConfigFingerprint || '')) throw new Error('benchmark_config_hash_invalid');
  return {schemaVersion: 'benchmark_config_commitments@2', fields: parseConfigFields(fields),
    fullFingerprint: configFieldsFingerprint(fields), controlsFingerprint: configControlsFingerprint(fields), legacyConfigFingerprint};
}
function parseConfigCommitments(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'controlsFingerprint,fields,fullFingerprint,legacyConfigFingerprint,schemaVersion' ||
      value.schemaVersion !== 'benchmark_config_commitments@2' || canonicalJson(value) !== canonicalJson(makeConfigCommitments(value.fields, value.legacyConfigFingerprint))) {
    throw new Error('benchmark_config_receipt_invalid');
  }
  return value;
}
function parsePurposeContracts(value) {
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).sort().join(',') === [...keys].sort().join(',');
  if (!exact(value, ['schemaVersion', 'classification', 'review']) || value.schemaVersion !== 'llm_purpose_controls@1') {
    throw new Error('benchmark_purpose_contract_invalid');
  }
  for (const purpose of ['classification', 'review']) {
    const contract = value[purpose], limit = contract?.tokenLimit;
    if (!exact(contract, ['commonConfig', 'tokenLimit'])) throw new Error('benchmark_purpose_contract_invalid');
    parseConfigFields(contract.commonConfig);
    if (limit?.status === 'absent') {
      if (!exact(limit, ['status']) || purpose === 'classification') throw new Error('benchmark_purpose_contract_invalid');
    } else if (!exact(limit, ['status', 'field', 'valueCommitment']) || limit.status !== 'explicit' ||
      !['max_tokens', 'max_completion_tokens', 'max_output_tokens'].includes(limit.field) || !HASH.test(limit.valueCommitment || '')) {
      throw new Error('benchmark_purpose_contract_invalid');
    }
  }
  return value;
}

// Native CLI mirror of the import-free finalSubmissionImplementation.ts table.
// Owning fixtures compare every exact row and malformed cross-product with TypeScript.
const TYPED_FINAL_CONTRACTS = Object.freeze({
  'openai_typed_final_admission@1': Object.freeze({representationVersion: 'authored_claim_document@1',
    compilerVersion: 'authored_claim_document_compiler@1', admissionVersion: 'openai_typed_final_admission@1', wireVersion: 'openai_chat_final_wire@1'}),
  'openai_typed_final_admission@2': Object.freeze({representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@2', wireVersion: 'openai_chat_final_wire@1'}),
  'openai_typed_final_admission@3': Object.freeze({representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@3', wireVersion: 'openai_chat_final_wire@2'}),
  'openai_typed_final_admission@4': Object.freeze({representationVersion: 'authored_claim_document@2',
    compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@4', wireVersion: 'openai_chat_final_wire@3'}),
});
function getOpenAiTypedFinalContractIdentity(admissionVersion) {
  return typeof admissionVersion === 'string' && Object.hasOwn(TYPED_FINAL_CONTRACTS, admissionVersion)
    ? TYPED_FINAL_CONTRACTS[admissionVersion] : undefined;
}
function parseOutputImplementation(value) {
  const fail = () => {throw new Error('benchmark_output_implementation_invalid');};
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
      Object.values(descriptors).some(row => !row.enumerable || !Object.hasOwn(row, 'value'))) fail();
  let expected;
  if (value.kind === 'assistant') expected = {kind: 'assistant', nativeContract: 'openai_native_completion_observer@1'};
  else if (value.kind === 'typed') {
    const identity = getOpenAiTypedFinalContractIdentity(value.admissionVersion);
    if (!identity) fail();
    expected = {kind: 'typed', ...identity};
  } else fail();
  if (Object.keys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, item]) => !Object.hasOwn(value, key) || value[key] !== item)) fail();
  return Object.freeze(expected);
}
function treatmentOutputImplementation(id, side) {
  if (![TREATMENT_ID, MIXED_CONTENT_TREATMENT_ID, DUAL_CARRIER_TREATMENT_ID].includes(id) || !['base', 'candidate'].includes(side)) {
    throw new Error('benchmark_treatment_invalid');
  }
  return side === 'base' ? {kind: 'assistant', nativeContract: 'openai_native_completion_observer@1'} : {kind: 'typed',
    ...getOpenAiTypedFinalContractIdentity(id === TREATMENT_ID ? 'openai_typed_final_admission@2' : id === MIXED_CONTENT_TREATMENT_ID
      ? 'openai_typed_final_admission@3' : 'openai_typed_final_admission@4')};
}
/** An old receipt contains no implementation observation; never synthesize one. */
function parsePreflightOutputImplementation(result, id, side) {
  const expected = treatmentOutputImplementation(id, side);
  if (result?.schemaVersion === 'llm_target_preflight@2' && id === TREATMENT_ID && !Object.hasOwn(result, 'outputImplementation')) return undefined;
  if (result?.schemaVersion !== 'llm_target_preflight@3') throw new Error('benchmark_output_implementation_invalid');
  const actual = parseOutputImplementation(result.outputImplementation);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('benchmark_output_implementation_mismatch');
  return actual;
}

function makeRepresentationTreatment(base, candidate, id = TREATMENT_ID) {
  const expected = treatmentOutputImplementation(id, 'candidate'), outputs = treatmentOutputs(id);
  const sides = {base: parseConfigCommitments(base), candidate: parseConfigCommitments(candidate)};
  if (base.controlsFingerprint !== candidate.controlsFingerprint) throw new Error('benchmark_config_mismatch');
  for (const side of ['base', 'candidate']) {
    for (const [field, value] of [[TREATMENT_FIELDS[0], outputs[side].finalSubmission],
      [TREATMENT_FIELDS[1], outputs[side].declarationSyntax]]) {
      const row = sides[side].fields.find(item => item.field === field);
      if (!row || row.presence !== 'present' || row.type !== 'string' || row.valueCommitment !== configHash(['string', value])) throw new Error('benchmark_treatment_mismatch');
    }
  }
  return {schemaVersion: id === TREATMENT_ID ? 'representation_treatment@1' : 'representation_treatment@2', id, sides: outputs,
    implementationContracts: {base: {nativeContract: 'openai_native_completion_observer@1'}, candidate: {
      representationVersion: 'authored_claim_document@2', compilerVersion: 'authored_claim_document_compiler@2',
      admissionVersion: expected.admissionVersion, ...(id !== TREATMENT_ID ? {wireVersion: expected.wireVersion} : {})}}, controlsFingerprint: base.controlsFingerprint,
    sideFullFingerprints: {base: base.fullFingerprint, candidate: candidate.fullFingerprint}};
}
/** Mirrors only maintained cell selection flags; owning tests compare the real verifier parser. */
function cellPreflightSelections(args) {
  const get = key => {
    const indices = args.map((value, index) => value === key ? index : -1).filter(index => index >= 0);
    if (indices.length > 1 || indices.length && (!args[indices[0] + 1] || args[indices[0] + 1].startsWith('--'))) throw new Error('benchmark_preflight_selection_invalid');
    return indices.length ? args[indices[0] + 1] : undefined;
  };
  const requested = get('--mode'), follow = get('--follow-up-mode'), provider = get('--provider-id');
  const mode = requested === 'smart' || requested === undefined ? 'auto' : requested;
  if (!['auto', 'fast', 'full'].includes(mode) || follow !== undefined && !['auto', 'fast', 'full'].includes(follow)) throw new Error('benchmark_preflight_selection_invalid');
  const selectedProvider = provider === undefined ? {} : {providerId: ['null', 'env', 'none', 'default'].includes(provider.trim().toLowerCase()) ? null : provider};
  const selections = [{requestedMode: mode, ...selectedProvider}];
  if (get('--follow-up-query')) selections.push({requestedMode: follow ?? 'auto', ...selectedProvider});
  return selections.filter((value, index) => selections.findIndex(other => canonicalJson(other) === canonicalJson(value)) === index);
}

function fingerprintFiles(root, inputs) {
  const result = createHash('sha256');
  const walk = relative => {
    const filename = path.join(root, relative);
    let stat;
    try {stat = fs.lstatSync(filename);} catch (error) {
      if (error.code === 'ENOENT') {result.update(`absent\0${relative}\0`); return;}
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('benchmark_source_symlink');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) {
        if (EXCLUDED_NAMES.has(name) || name.startsWith('.env') || /\.(?:env|log|sqlite|db)$/.test(name)) continue;
        walk(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      result.update(`file\0${relative.split(path.sep).join('/')}\0${stat.size}\0`);
      result.update(fs.readFileSync(filename));
      result.update('\0');
    } else throw new Error('benchmark_source_not_regular');
  };
  for (const input of inputs) walk(input);
  return result.digest('hex');
}

/** Includes task-owned new source files; excludes credentials, dependencies and generated results. */
function fingerprintSourceTree(root) {
  return fingerprintFiles(fs.realpathSync(root), SOURCE_INPUTS);
}

function fingerprintFixtureDirectory(root) {
  return fingerprintFiles(fs.realpathSync(root), ['.']);
}

/** Fixed checkout-owned source/Trace pair only. No report/review-provided filesystem paths. */
function sourceFacetContext(repositoryRoot) {
  const root = fs.realpathSync(repositoryRoot);
  const api = require(path.join(root, 'backend/scripts/agent-e2e-harness.cjs')).createProviderE2eHarness('glm');
  const inputs = api.sourceFacetInputs();
  for (const filename of [inputs.sourceRoot, inputs.tracePath, inputs.groundTruthPath]) {
    const relative = path.relative(root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('benchmark_source_facet_path_invalid');
    let cursor = root;
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('benchmark_source_facet_path_invalid');
    }
  }
  const groundTruthBytes = fs.readFileSync(inputs.groundTruthPath);
  if (groundTruthBytes.length > 1024 * 1024) throw new Error('benchmark_source_facet_oracle_invalid');
  let groundTruth;
  try {groundTruth = JSON.parse(groundTruthBytes.toString('utf8')).source_trace_ground_truth;}
  catch {throw new Error('benchmark_source_facet_oracle_invalid');}
  const traceSha256 = hash(fs.readFileSync(inputs.tracePath));
  if (traceSha256 !== groundTruth?.trace?.outputSha256) throw new Error('benchmark_source_facet_trace_mismatch');
  const contract = {protocol: SOURCE_FACET.protocol, queryHash: hash(inputs.query.text),
    expectationHash: hash(canonicalJson(inputs.expectation)), traceSha256,
    sourceFixtureHash: fingerprintFixtureDirectory(inputs.sourceRoot), groundTruthHash: hash(groundTruthBytes)};
  return {api, inputs, groundTruth, contract};
}

function validSourceFacetContract(contract) {
  const hashes = ['queryHash', 'expectationHash', 'traceSha256', 'sourceFixtureHash', 'groundTruthHash'];
  return contract && typeof contract === 'object' && !Array.isArray(contract) &&
    Object.keys(contract).length === hashes.length + 1 && contract.protocol === SOURCE_FACET.protocol &&
    hashes.every(key => HASH.test(contract[key] || ''));
}

/** Completes only automatic A2 checks. The action facet remains uncovered. */
function evaluateSourceFacetPending(report, request, repositoryRoot) {
  if (request?.cellId !== 'source' || !validSourceFacetContract(request.sourceFacet)) return undefined;
  const context = sourceFacetContext(repositoryRoot);
  if (canonicalJson(context.contract) !== canonicalJson(request.sourceFacet)) return undefined;
  const target = report?.executionTarget, metrics = report?.executionMetrics, identity = report?.runIdentity;
  const terminal = report?.summary?.terminalAnalysis;
  const all = (checks, nonempty = true) => checks && typeof checks === 'object' && !Array.isArray(checks) &&
    (!nonempty || Object.keys(checks).length > 0) && Object.values(checks).every(value => value === true);
  const onlyFacet = facets => Array.isArray(facets) && facets.length === 1 && facets[0] === SOURCE_FACET.facetId;
  if (report.strict !== true || report.passed !== false || report.completeAcceptance !== false ||
      report.semanticAcceptance !== 'INCONCLUSIVE' || report.proofAcceptance !== 'PASSED' ||
      report.observedChecksPassed !== true || report.hardGatesPassed !== true || report.errorCode !== undefined ||
      !onlyFacet(report.uncoveredFacets) || !onlyFacet(report.taskVerification?.uncoveredFacets) ||
      !all(report.checks) || !all(report.ungroupedChecks, false) ||
      !['value', 'proof', 'delivery'].every(group => all(report.checkGroups?.[group])) ||
      terminal?.completion?.status !== 'completed' || terminal.completion.schemaVersion !== 1 ||
      terminal.completion.reason !== undefined || terminal.completion.runId !== metrics?.runId ||
      typeof metrics?.runtime !== 'string' || !metrics.runtime || terminal.completion.runtimeKind !== metrics.runtime ||
      identity?.runtime !== metrics.runtime ||
      typeof terminal.conclusion !== 'string' || !terminal.conclusion.trim() || report.summary.analysisCompletedPartial === true ||
      report.analysisContext?.codeAwareMode !== 'provider_send' ||
      metrics?.schemaVersion !== 'llm_execution_metrics_artifact@1' || metrics.status !== 'sealed' ||
      !Number.isFinite(metrics.sealedAt) || !Number.isFinite(metrics.wallclockMs) || metrics.wallclockMs <= 0 ||
      typeof metrics.runId !== 'string' || !metrics.runId || typeof metrics.sessionId !== 'string' || !metrics.sessionId ||
      metrics.runId !== target?.runId || metrics.sessionId !== target?.sessionId || metrics.sessionId !== report.sessionId ||
      identity?.query !== context.inputs.query.text || report.query !== context.inputs.query.text ||
      identity.expectationHash !== context.contract.expectationHash || identity.traceSha256 !== context.contract.traceSha256) return undefined;
  try {assertExecutionTarget(target, request, target.processId);} catch {return undefined;}
  const evaluation = context.api.evaluateSemanticConditionReport({report, query: context.inputs.query,
    condition: 'A2', sourceRoot: context.inputs.sourceRoot});
  if (!onlyFacet(evaluation.uncoveredFacets) || Object.entries(evaluation)
      .some(([key, value]) => key !== 'uncoveredFacets' && value !== true)) return undefined;
  return {schemaVersion: SOURCE_FACET.receiptSchema, protocol: SOURCE_FACET.protocol,
    nonce: request.nonce, side: request.side, pairId: request.pairId, cellId: request.cellId, repetition: request.repetition,
    runId: metrics.runId, sessionId: metrics.sessionId, targetFingerprint: hash(canonicalJson(target)),
    ...context.contract, a2EvaluationFingerprint: hash(canonicalJson(evaluation)), facetId: SOURCE_FACET.facetId,
    disposition: 'collected_pending_independent_review', exitCode: SOURCE_FACET.exitCode};
}

/** Controller and scorer repeat eligibility; neither trusts a disposition string. */
function validateSourceFacetCollection({report, reportHash, receipt, request, lifecycle, repositoryRoot}) {
  if (lifecycle?.outcome !== 'nonzero_exit' || lifecycle.exitCode !== SOURCE_FACET.exitCode ||
      lifecycle.censored !== false || lifecycle.signal !== null || lifecycle.cleanup !== 'confirmed' ||
      !Number.isSafeInteger(lifecycle.processId) || lifecycle.processId <= 0 ||
      lifecycle.processId !== report?.executionTarget?.processId) return false;
  const pending = evaluateSourceFacetPending(report, request, repositoryRoot);
  if (!pending || !HASH.test(reportHash || '') || !Number.isFinite(receipt?.settledAt) ||
      receipt.settledAt < report.executionMetrics.sealedAt || receipt.settledAt > lifecycle.settledAt) return false;
  return canonicalJson(receipt) === canonicalJson({...pending, rawReportSha256: reportHash, settledAt: receipt.settledAt});
}

/** An in-process capability, never a deserializable flag. Finally must resolve before settle is called. */
function createSourceFacetSettlement({repositoryRoot, reportPath, request}) {
  const tokens = new WeakMap();
  const readBytes = () => {
    const descriptor = fs.openSync(reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('benchmark_source_facet_report_invalid');
      return fs.readFileSync(descriptor);
    } finally {fs.closeSync(descriptor);}
  };
  return {
    issue(report) {
      const pending = evaluateSourceFacetPending(report, request, repositoryRoot);
      if (!pending) return undefined;
      const bytes = readBytes();
      let saved;
      try {saved = JSON.parse(bytes.toString('utf8'));} catch {throw new Error('benchmark_source_facet_report_invalid');}
      if (canonicalJson(saved) !== canonicalJson(report)) throw new Error('benchmark_source_facet_report_mismatch');
      const token = Object.freeze({});
      tokens.set(token, {...pending, rawReportSha256: hash(bytes)});
      return token;
    },
    async settle(token, {cleanup, flush, exitCode}) {
      const pending = token === undefined ? undefined : tokens.get(token);
      if (token !== undefined && !pending) throw new Error('benchmark_source_facet_token_invalid');
      if (token !== undefined) tokens.delete(token);
      await cleanup();
      await flush();
      if (!pending) return exitCode() ?? 0;
      if ((exitCode() ?? 0) !== 0 || pending.rawReportSha256 !== hash(readBytes())) {
        throw new Error('benchmark_source_facet_unsettled');
      }
      // Recheck controlled files after main/finally, cleanup and flush, before issuing the receipt.
      if (canonicalJson(sourceFacetContext(repositoryRoot).contract) !== canonicalJson(request.sourceFacet)) {
        throw new Error('benchmark_source_facet_changed');
      }
      writeNewJson(path.join(path.dirname(reportPath), SOURCE_FACET.receiptFile), {...pending, settledAt: Date.now()});
      return SOURCE_FACET.exitCode;
    },
  };
}

function fingerprintObserver(root, reviewedHookContractFingerprint, finalTransport = false) {
  if (!HASH.test(reviewedHookContractFingerprint || '')) throw new Error('benchmark_observer_hook_fingerprint_invalid');
  const inputs = finalTransport ? [...OBSERVER_INPUTS, 'backend/src/scripts/agentE2eMetrics.ts',
    'backend/src/agentRuntime/typedOutputMaterial.ts', 'backend/src/agentRuntime/finalSubmissionImplementation.ts',
    'backend/src/agentRuntime/openAiCandidateIdentity.ts',
    'backend/src/agentRuntime/engines/openai/openAiTypedFinalOutputMaterial.ts'] : OBSERVER_INPUTS;
  for (const relative of inputs) {
    const stat = fs.lstatSync(path.join(root, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('benchmark_observer_source_missing');
  }
  const coreFingerprint = fingerprintFiles(fs.realpathSync(root), inputs);
  return {coreFingerprint, reviewedHookContractFingerprint,
    fingerprint: hash(canonicalJson({coreFingerprint, reviewedHookContractFingerprint})),
    hookEvidence: 'reviewed_contract_not_automatic_wire_equivalence'};
}

function parseTargetRequest(value) {
  let request;
  try {request = typeof value === 'string' ? JSON.parse(value) : value;} catch {throw new Error('benchmark_target_invalid');}
  const fields = ['schemaVersion', 'nonce', 'side', 'pairId', 'cellId', 'repetition', 'port',
    'expectedSourceFingerprint', 'observerFingerprint', 'configFingerprint', 'dataRootHash', 'sourceFacet'];
  const version2 = request?.schemaVersion === 'llm_execution_target_request@2';
  const treatmentFields = ['configFullFingerprint', 'configControlsFingerprint', 'treatmentHash', 'preflightFingerprint'];
  if (version2) fields.push(...treatmentFields);
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !fields.includes(key)) ||
      (!version2 && request.schemaVersion !== 'llm_execution_target_request@1') ||
      version2 && treatmentFields.some(key => !HASH.test(request[key] || '')) || !NONCE.test(request.nonce || '') ||
      !['base', 'candidate'].includes(request.side) || !SAFE_ID.test(request.pairId || '') ||
      !CELLS.includes(request.cellId) || !Number.isSafeInteger(request.repetition) || request.repetition < 1 ||
      !Number.isSafeInteger(request.port) || request.port < 1024 || request.port > 65535 ||
      ['expectedSourceFingerprint', 'observerFingerprint', 'configFingerprint', 'dataRootHash']
        .some(key => !HASH.test(request[key] || '')) ||
      request.sourceFacet !== undefined && (request.cellId !== 'source' || !validSourceFacetContract(request.sourceFacet))) {
    throw new Error('benchmark_target_invalid');
  }
  return Object.freeze({...request});
}

/** Called inside the verifier after listen(), not a copy of controller expectations. */
function observeExecutionTarget(input) {
  const request = parseTargetRequest(input.request);
  const sourceFingerprint = fingerprintSourceTree(input.repositoryRoot);
  const dataRootHash = hash(fs.realpathSync(input.dataRoot));
  const origin = `http://127.0.0.1:${input.port}`;
  const matched = input.port === request.port && sourceFingerprint === request.expectedSourceFingerprint &&
    dataRootHash === request.dataRootHash;
  return {schemaVersion: request.schemaVersion === 'llm_execution_target_request@2' ? 'llm_execution_target@2' : 'llm_execution_target@1', nonce: request.nonce, side: request.side,
    pairId: request.pairId, cellId: request.cellId, repetition: request.repetition,
    origin, processId: input.processId ?? process.pid, sourceFingerprint, dataRootHash,
    // These are controller declarations, explicitly separate from observed values.
    declaredObserverFingerprint: request.observerFingerprint, declaredConfigFingerprint: request.configFingerprint,
    ...(request.schemaVersion === 'llm_execution_target_request@2' ? {declaredConfigFullFingerprint: request.configFullFingerprint,
      declaredConfigControlsFingerprint: request.configControlsFingerprint, declaredTreatmentHash: request.treatmentHash,
      declaredPreflightFingerprint: request.preflightFingerprint} : {}),
    ...(request.sourceFacet ? {sourceFacet: request.sourceFacet} : {}),
    status: matched ? 'matched' : 'mismatch'};
}

function assertExecutionTarget(target, request, processId) {
  const version2 = request.schemaVersion === 'llm_execution_target_request@2';
  if (!target || target.schemaVersion !== (version2 ? 'llm_execution_target@2' : 'llm_execution_target@1') || target.status !== 'matched' ||
      version2 && (target.declaredConfigFullFingerprint !== request.configFullFingerprint ||
        target.declaredConfigControlsFingerprint !== request.configControlsFingerprint || target.declaredTreatmentHash !== request.treatmentHash ||
        target.declaredPreflightFingerprint !== request.preflightFingerprint) ||
      target.nonce !== request.nonce || target.side !== request.side || target.pairId !== request.pairId ||
      target.cellId !== request.cellId || target.repetition !== request.repetition || target.processId !== processId ||
      target.origin !== `http://127.0.0.1:${request.port}` ||
      target.sourceFingerprint !== request.expectedSourceFingerprint || target.dataRootHash !== request.dataRootHash ||
      target.declaredObserverFingerprint !== request.observerFingerprint ||
      target.declaredConfigFingerprint !== request.configFingerprint ||
      canonicalJson(target.sourceFacet) !== canonicalJson(request.sourceFacet)) throw new Error('benchmark_target_mismatch');
}

function canonicalFuturePath(value) {
  let ancestor = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('benchmark_output_ancestor_missing');
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function prepareFreshOutputDirectory(repositoryRoot, output) {
  const root = fs.realpathSync(repositoryRoot);
  const boundary = path.join(root, 'backend/test-output/runtime-concurrency/llm-execution-v1');
  const raw = path.isAbsolute(output) ? output : path.resolve(root, 'backend', output);
  const target = canonicalFuturePath(raw);
  const relative = path.relative(boundary, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('benchmark_output_outside_boundary');
  }
  // Existing symlinks below the checkout cannot redirect a supposedly local evidence directory.
  const rawRelative = path.relative(root, path.resolve(raw));
  let cursor = root;
  for (const component of rawRelative.split(path.sep)) {
    if (component === '..') throw new Error('benchmark_output_outside_boundary');
    cursor = path.join(cursor, component);
    try {if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('benchmark_output_symlink');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  if (fs.existsSync(target)) throw new Error('benchmark_output_exists');
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  fs.mkdirSync(target, {mode: 0o700});
  return target;
}

function writeNewJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600});
}

/** Freeze the prepared environment: dotenv/config must not fill absent values from either checkout. */
function isolateChildDotenv(env, isolatedRoot) {
  const emptyFile = path.join(isolatedRoot, '.benchmark-empty.env');
  fs.writeFileSync(emptyFile, '', {flag: 'wx', mode: 0o600});
  const captured = Object.fromEntries(Object.entries(env).filter(([key]) =>
    key !== 'DOTENV_KEY' && !key.startsWith('DOTENV_CONFIG_')));
  // dotenv's env-options passes strings through, and populate uses Boolean(override):
  // DOTENV_CONFIG_OVERRIDE='false' would enable it. Absence is the actual false value.
  return {...captured, DOTENV_CONFIG_PATH: emptyFile, DOTENV_CONFIG_QUIET: 'true',
    SMARTPERFETTO_ENV_FILE: emptyFile};
}

function replaceOption(args, key, value) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === key) {index++; continue;}
    out.push(args[index]);
  }
  return [...out, key, value];
}

/** Benchmark cells reuse maintained requests and their independent trace oracles. */
function buildCell(harness, cellId, outputPath, timeoutMs) {
  if (!CELLS.includes(cellId)) throw new Error('benchmark_cell_invalid');
  let args;
  let evidenceBoundary = 'whole_flow';
  if (cellId === 'scheduler' || cellId === 'dual') {
    const id = cellId === 'scheduler' ? 'scheduler-constructed' : 'startup-pair-real';
    const scenario = harness.systemAnalysisScenarios().find(item => item.id === id);
    if (!scenario) throw new Error('benchmark_manifest_scenario_missing');
    args = scenario.args;
  } else if (cellId === 'source') {
    const query = harness.semanticDeltaQueries().find(item => item.kind === 'autonomous-diagnosis');
    if (!query) throw new Error('benchmark_source_query_missing');
    args = harness.semanticConditionArgs(query, 'A2', outputPath, timeoutMs);
    evidenceBoundary = 'single_source_A2_not_full_source_matrix';
  } else args = harness.suites[cellId]?.args;
  if (!Array.isArray(args) || !args.includes('--expectation-json')) throw new Error('benchmark_oracle_missing');
  args = replaceOption(replaceOption(args, '--output', outputPath), '--timeout-ms', String(timeoutMs));
  if (!args.includes('--strict')) args.push('--strict');
  return {id: cellId, args, evidenceBoundary};
}

function pairedSchedule(cells, repetitions, seed) {
  const schedule = [];
  for (const cellId of cells) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const pairId = `${cellId}-${String(repetition).padStart(2, '0')}`;
    const first = parseInt(hash(`${seed}:${pairId}`).slice(0, 2), 16) % 2 ? 'candidate' : 'base';
    schedule.push({pairId, cellId, repetition, order: [first, first === 'base' ? 'candidate' : 'base']});
  }
  return schedule;
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('benchmark_port_unavailable')));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(new Error('benchmark_port_release_failed')) : resolve()));
  });
}

/** A process exit and an HTTP terminal event are different observations. */
async function runOwnedVerifier(input, dependencies) {
  const {harness} = dependencies;
  const checkPort = dependencies.assertPortFree ?? assertPortFree;
  await checkPort(input.request.port);
  const preparedAt = Date.now();
  const tracked = harness.start(input.label, process.execPath, input.args,
    {cwd: input.backendRoot, env: input.env}, false);
  let timer;
  let exit;
  let deadlineExpired = false;
  let cleanup = 'failed';
  try {
    exit = await Promise.race([tracked.result, new Promise(resolve => {
      timer = setTimeout(() => {deadlineExpired = true; resolve(null);}, input.observationTimeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    try {await harness.stop(tracked); await checkPort(input.request.port); cleanup = 'confirmed';}
    catch {cleanup = 'failed';}
  }
  return {preparedAt, settledAt: Date.now(), processId: tracked.child?.pid,
    exitCode: exit?.code ?? null, signal: typeof exit?.signal === 'string' ? exit.signal : null,
    outcome: harness.receivedSignal ? 'cancelled' : deadlineExpired ? 'observation_timeout'
      : exit?.error ? 'spawn_error' : exit?.code === 0 ? 'exited' : 'nonzero_exit',
    cleanup, log: path.basename(tracked.logPath),
    censored: deadlineExpired || Boolean(harness.receivedSignal) || Boolean(exit?.error)};
}

module.exports = {TARGET_ENV, CELLS, SOURCE_FACET, TREATMENT_ID, MIXED_CONTENT_TREATMENT_ID, DUAL_CARRIER_TREATMENT_ID, treatmentOutputs,
  getOpenAiTypedFinalContractIdentity, parseOutputImplementation, treatmentOutputImplementation, parsePreflightOutputImplementation, TREATMENT_OUTPUTS, buildConfigCommitments, alignConfigCommitments,
  configFieldsFingerprint, configControlsFingerprint, makeConfigCommitments, parseConfigCommitments, parsePurposeContracts, makeRepresentationTreatment,
  cellPreflightSelections, canonicalJson, hash, fingerprintSourceTree, fingerprintFixtureDirectory, fingerprintObserver,
  sourceFacetContext, evaluateSourceFacetPending, validateSourceFacetCollection, createSourceFacetSettlement,
  parseTargetRequest, observeExecutionTarget, assertExecutionTarget, prepareFreshOutputDirectory,
  writeNewJson, isolateChildDotenv, buildCell, pairedSchedule, assertPortFree, runOwnedVerifier};
