// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Conclusion contract derivation, normalization and sidecar round-trip tests.
 */

import {
  deriveConclusionContract,
  normalizeConclusionOutput,
} from '../conclusionGenerator';
import {parseConclusionContractSidecar, parseTypedConclusionContractJson, parseConclusionContractDeclaration,
  parseDeclaredRelationProposals, renderConclusionContractSidecar, conclusionParseIssueTriageCodes,
  CONCLUSION_PARSE_ISSUE_CODES, type ConclusionContract, type ClaimSemanticsV1,
} from '../conclusionContract';

describe('complete generated conclusion collections', () => {
  const collection = (prefix: string, count: number) => Array.from({length: count}, (_, index) => `${prefix} ${index + 1}`);

  it('keeps every legacy JSON conclusion, cluster, evidence item, uncertainty and next step', () => {
    const raw = JSON.stringify({schema_version: 'conclusion_contract_v1',
      conclusion: collection('Conclusion', 4).map((statement, index) => ({rank: index + 1, statement})),
      clusters: collection('Cluster', 6).map((description, index) => ({cluster: `K${index + 1}`, description})),
      evidence_chain: collection('Evidence', 13).map(text => ({conclusion_id: 'C4', evidence: [text]})),
      uncertainties: collection('Uncertainty', 7), next_steps: collection('Next action', 7)});
    const contract = deriveConclusionContract(raw)!;
    expect(contract.conclusions).toHaveLength(4);
    expect(contract.clusters).toHaveLength(6);
    expect(contract.evidenceChain).toHaveLength(13);
    expect(contract.uncertainties).toHaveLength(7);
    expect(contract.nextSteps).toHaveLength(7);
    const rendered = normalizeConclusionOutput(raw);
    for (const tail of ['Conclusion 4', 'Cluster 6', 'Evidence 13', 'Uncertainty 7', 'Next action 7']) {
      expect(rendered).toContain(tail);
    }
  });

  it.each(['number', 'claim', 'bullet'] as const)('retains all %s conclusions through Markdown roundtrip', style => {
    const statements = collection('Observed statement', 12);
    const body = `## 结论（按可能性排序）\n${statements.map((text, index) =>
      `${style === 'number' ? `${index + 1}.` : style === 'claim' ? `C${index + 1}:` : '-'} ${text}`).join('\n')}`;
    const contract = deriveConclusionContract(body)!;
    expect(contract.conclusions.map(item => item.statement)).toEqual(statements);
    const rendered = normalizeConclusionOutput(body);
    expect(deriveConclusionContract(rendered)?.conclusions.map(item => item.statement)).toEqual(statements);
    expect(normalizeConclusionOutput(rendered)).toContain('Observed statement 12');
  });

  it('keeps generated JSON-like conclusion and cluster tails before Markdown normalization', () => {
    const raw = ['conclusion:', ...collection('Observed conclusion', 4).map(statement => JSON.stringify({statement})),
      'clusters:', ...collection('Cluster detail', 6).map((description, index) => JSON.stringify({cluster: `K${index + 1}`, description})),
      'evidence_chain:', JSON.stringify({conclusion_id: 'C4', evidence: ['Evidence for the final conclusion']}),
      'uncertainties:', 'Uncertainty remains', 'next_steps:', 'Inspect the recorded event'].join('\n');
    const normalized = normalizeConclusionOutput(raw);
    expect(normalized).toContain('Observed conclusion 4');
    expect(normalized).toContain('Cluster detail 6');
    expect(deriveConclusionContract(normalized)?.conclusions).toHaveLength(4);
    expect(deriveConclusionContract(normalized)?.clusters).toHaveLength(6);
  });
});

describe('conclusion contract derivation and normalization', () => {
  test('normalizeConclusionOutput keeps generic cluster heading without scene hints', () => {
    const normalized = normalizeConclusionOutput(`结论: 启动阶段存在初始化耗时
clusters: S1: 初始化阶段（3帧, 75%）
证据链: C1: 首帧延迟`);

    expect(normalized).toContain('## 聚类（先看大头）');
    expect(normalized).not.toContain('## 掉帧聚类（先看大头）');
  });

  test('deriveConclusionContract infers jank sceneId from markdown heading', () => {
    const contract = deriveConclusionContract(`## 结论（按可能性排序）
1. 存在掉帧

## 掉帧聚类（先看大头）
- K1: 主线程耗时（4帧, 66.7%）

## 证据链（对应上述结论）
- C1: ev_0123456789ab

## 不确定性与反例
- 暂无

## 下一步（最高信息增益）
- 继续下钻`);

    expect(contract?.metadata?.sceneId).toBe('jank');
  });

  test('deriveConclusionContract applies sceneId hint for generic cluster heading', () => {
    const contract = deriveConclusionContract(`## 结论（按可能性排序）
1. 存在掉帧

## 聚类（先看大头）
- K1: 主线程耗时（4帧, 66.7%）

## 证据链（对应上述结论）
- C1: ev_0123456789ab

## 不确定性与反例
- 暂无

## 下一步（最高信息增益）
- 继续下钻`, {
      sceneId: 'jank',
    });

    expect(contract?.metadata?.sceneId).toBe('jank');
  });

  test('round-trips claim references through deterministic contract markdown', () => {
    const raw = JSON.stringify({
      schema_version: 'conclusion_contract_v1',
      mode: 'initial_report',
      conclusion: [{ rank: 1, statement: '帧耗时异常', confidence: 90 }],
      clusters: [],
      evidence_chain: [{ conclusion_id: 'C1', evidence: ['帧耗时 45.6ms（ev_111111111111）'] }],
      claims: [{
        id: 'Q1',
        conclusion_id: 'C1',
        text: '帧耗时 45.6ms',
        references: [{
          evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
          source_ref: '表 1',
          source_tool_call_id: 'execute_sql:1:params-a',
          row_index: 0,
          row_selector: { frame_id: 123 },
          column: 'dur_ms',
          value: 45.6,
        }],
      }],
      uncertainties: [],
      next_steps: ['owner: perf; priority: P1; action: 继续下钻; verification: 复查表 1'],
    });
    const initial = deriveConclusionContract(raw);

    expect(initial?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      sourceToolCallId: 'execute_sql:1:params-a',
      rowIndex: 0,
      rowSelector: { frame_id: 123 },
      column: 'dur_ms',
      value: 45.6,
    });

    const markdown = normalizeConclusionOutput(raw);
    const roundTripped = deriveConclusionContract(markdown);
    expect(roundTripped?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      sourceToolCallId: 'execute_sql:1:params-a',
      rowIndex: 0,
      rowSelector: { frame_id: 123 },
      column: 'dur_ms',
      value: 45.6,
    });

    const selectorFromPromptFormat = deriveConclusionContract([
      '## 逐句数据引用（结构化来源）',
      '- Q1 / C1: 帧 123 耗时 45.6ms',
      '  - evidence_ref_id=data:sql_table:current:trace-a:query-a:params-a; source_ref=表 1; row_selector=frame_id=123, thread=main; column=dur_ms; value=45.6',
    ].join('\n'));

    expect(selectorFromPromptFormat?.claims?.[0]?.references[0]).toMatchObject({
      evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      sourceRef: '表 1',
      rowSelector: { frame_id: 123, thread: 'main' },
      column: 'dur_ms',
      value: 45.6,
    });

    const compressedReferences = deriveConclusionContract([
      '## 逐句数据引用（结构化来源）',
      '- Q1 / C1: 热点 self_ms 排名。',
      '  - evidence_ref_id=art-30; source_ref=可操作热点; row_index=0-1; column=slice_name,self_ms,self_percent; value=ChaosTask/456.32/34.1, LoadSimulator_ActivityInit/249.8/18.7',
      '- Q2 / C1: 热点状态。',
      '  - evidence_ref_id=art-35; source_ref=hot_slice_states; row_selector=slice_name=ChaosTask AND state=Running; column=state,state_pct; value=Running,100; row_selector=slice_name=SimulateInflation; column=state,state_pct; value=Running,98.4',
      '- Q3 / C1: 慢因。',
      '  - evidence_ref_id=art-39; source_ref=检测到的慢启动原因; row_index=0; column=reason_id,severity,evidence; value=SR12,critical,非框架 slice 占 bindApplication 98.8%, 总耗时 568.8 ms',
    ].join('\n'));

    expect(compressedReferences?.claims?.[0]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'slice_name', value: 'ChaosTask' }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'self_ms', value: 456.32 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 0, column: 'self_percent', value: 34.1 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'slice_name', value: 'LoadSimulator_ActivityInit' }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'self_ms', value: 249.8 }),
      expect.objectContaining({ evidenceRefId: 'art-30', sourceRef: '可操作热点', rowIndex: 1, column: 'self_percent', value: 18.7 }),
    ]);
    expect(compressedReferences?.claims?.[1]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'ChaosTask', state: 'Running' }, column: 'state', value: 'Running' }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'ChaosTask', state: 'Running' }, column: 'state_pct', value: 100 }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'SimulateInflation' }, column: 'state', value: 'Running' }),
      expect.objectContaining({ evidenceRefId: 'art-35', sourceRef: 'hot_slice_states', rowSelector: { slice_name: 'SimulateInflation' }, column: 'state_pct', value: 98.4 }),
    ]);
    expect(compressedReferences?.claims?.[2]?.references).toEqual([
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'reason_id', value: 'SR12' }),
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'severity', value: 'critical' }),
      expect.objectContaining({ evidenceRefId: 'art-39', sourceRef: '检测到的慢启动原因', rowIndex: 0, column: 'evidence', value: '非框架 slice 占 bindApplication 98.8%, 总耗时 568.8 ms' }),
    ]);
  });

  it('sanitizes typed source provenance while keeping chat markdown unchanged', () => {
    const baseContract = {
      schemaVersion: 'conclusion_contract_v1' as const,
      mode: 'focused_answer' as const,
      conclusions: [{rank: 1, statement: 'Foo.run 与 trace 阻塞事件一致'}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        text: 'Foo.run 与 trace 阻塞事件一致',
        references: [{evidenceRefId: 'data:trace-1'}],
      }],
      uncertainties: [],
      nextSteps: [],
    };
    const sourceContract = {
      ...baseContract,
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['app-source'],
        status: 'corroborated',
        attemptedTools: ['read_codebase_file'],
        queriedCodebaseIds: ['app-source'],
        usedCodebaseIds: ['app-source'],
        references: [{
          id: 'model-controlled-id',
          referenceId: 'lookup-1',
          codebaseId: 'app-source',
          filePath: 'src/main/Foo.kt',
          lookupKind: 'body',
          rootPath: '/private/raw-root-canary',
          snippet: 'raw-source-canary',
        }],
      },
      sourceReferences: [{
        id: 'model-controlled-id',
        referenceId: 'lookup-1',
        codebaseId: 'app-source',
        filePath: 'src/main/Foo.kt',
        lookupKind: 'body',
        text: 'raw-source-canary',
      }],
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: ['model-controlled-id'],
        traceEvidenceRefIds: ['data:trace-1'],
        reason: 'raw-source-canary',
      }],
    };

    const parsed = deriveConclusionContract(JSON.stringify(sourceContract));

    expect(parsed?.sourceUseDecision?.references[0]?.id).toMatch(/^source-ref-v1-/);
    expect(parsed?.sourceUseDecision?.references[0]?.id).not.toBe('model-controlled-id');
    expect(parsed?.sourceReferences?.[0]?.id).toBe(parsed?.sourceUseDecision?.references[0]?.id);
    expect(JSON.stringify(parsed)).not.toContain('/private/raw-root-canary');
    expect(JSON.stringify(parsed)).not.toContain('raw-source-canary');
    expect(normalizeConclusionOutput(JSON.stringify(sourceContract))).toBe(
      normalizeConclusionOutput(JSON.stringify(baseContract)),
    );
  });
});


describe('versioned conclusion declaration sidecar', () => {
  function semantics(): ClaimSemanticsV1 {
    return {schemaVersion: 'claim_semantics@1', predicate: 'future.metric@7', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'some', modality: 'possible', conditions: ['condition'],
      scope: {population: 'selected_interval', timeRangeNs: {start: '9007199254740993', end: '9007199254741993'},
        subjectRefs: [{artifactId: 'art-1', rowSelector: {code: '001'}, column: 'value', value: '001'}]},
      numeric: {operator: 'gt', value: '2.00', unit: 'ms'}};
  }

  function contract(): ConclusionContract {
    return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: 'Original statement'}], clusters: [], evidenceChain: [],
      claims: [{id: 'claim:original', conclusionId: 'C-original', text: 'Original claim', kind: 'numeric',
        references: [{artifactId: 'art-1', sourceToolCallId: 'call-1', rowSelector: {code: '001'}, column: 'value', value: '001'}],
        artifactRefs: [{artifactId: 'art-1', rowIndex: 501}], relationRefs: ['proposal:relation-1'], semantics: semantics()}],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation-1', kind: 'overlap',
        direction: 'symmetric', subject: {artifactId: 'art-1', rowIndex: 501, column: 'ts', value: '9007199254740993'},
        object: {artifactId: 'art-2', rowIndex: 0, column: 'ts', value: '9007199254740993'}}],
      uncertainties: [], nextSteps: []};
  }

  function rawSidecar(raw: unknown): string {
    return '<!-- smartperfetto:conclusion-contract@1\n```json\n' + JSON.stringify(raw) + '\n```\n-->';
  }

  const sourceBinding = {claimId: 'claim:original', mechanismStatus: 'compatible' as const,
    sourceReferenceIds: ['source-ref-v1-original'], traceEvidenceRefIds: []};

  it.each(['absent', 'empty', 'duplicate'] as const)('preserves %s original source-binding declarations', mode => {
    const original = contract();
    if (mode === 'empty') original.sourceClaimBindings = [];
    if (mode === 'duplicate') original.sourceClaimBindings = [sourceBinding, {...sourceBinding}];
    for (const parsed of [parseConclusionContractSidecar(rawSidecar(original)), parseTypedConclusionContractJson(JSON.stringify(original))]) {
      expect(parsed).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
      expect(parsed.contract?.sourceClaimBindings).toEqual(original.sourceClaimBindings);
      expect(Object.prototype.hasOwnProperty.call(parsed.contract, 'sourceClaimBindings')).toBe(mode !== 'absent');
    }
  });

  it.each([
    null, {}, 'bindings', 1, [null], [{}], [{...sourceBinding, claimId: undefined}],
    [{...sourceBinding, sourceReferenceIds: undefined}], [{...sourceBinding, traceEvidenceRefIds: null}],
    [{...sourceBinding, sourceReferenceIds: [null]}], [{...sourceBinding, claimId: ' claim:original '}],
    [{...sourceBinding, sourceReferenceIds: [' source-ref-v1-original ']}],
    [{...sourceBinding, mechanismStatus: 'verified'}], [{...sourceBinding, reason: 1}],
    [sourceBinding, {claimId: 'other'}], [sourceBinding, null],
  ])('keeps malformed original source bindings invalid through typed and sidecar round trips: %j', sourceClaimBindings => {
    const original = {...contract(), sourceClaimBindings};
    for (const parsed of [parseConclusionContractSidecar(rawSidecar(original)), parseTypedConclusionContractJson(JSON.stringify(original))]) {
      expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [
        {code: 'invalid_reference', path: 'sourceClaimBindings'},
      ]});
      expect(parsed.contract?.rawDeclaration).toEqual(JSON.parse(JSON.stringify(original)));
      const reparsed = parseConclusionContractSidecar(renderConclusionContractSidecar(parsed.contract!));
      expect(reparsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible'});
      expect(reparsed.rawPayload).toEqual(parsed.rawPayload);
    }
  });

  it.each([undefined, new Array(1), [{...sourceBinding, sourceReferenceIds: new Array(1)}],
    [{...sourceBinding, traceEvidenceRefIds: new Array(1)}]])('rejects explicit undefined or sparse local bindings: %j', sourceClaimBindings => {
    const parsed = parseConclusionContractDeclaration({...contract(), sourceClaimBindings});
    expect(parsed).toMatchObject({contract: {bindingEligibility: 'ineligible'}, issues: [
      {code: 'invalid_reference', path: 'sourceClaimBindings'},
    ]});
    expect(Object.prototype.hasOwnProperty.call(parsed.contract?.rawDeclaration, 'sourceClaimBindings')).toBe(true);
  });

  it('round-trips an original source location without inferring or normalizing its tuple', () => {
    const original = contract();
    original.claims![0].semantics!.source = {sourceReferenceId: 'source-ref-v1-original',
      filePath: '目录/Probe "Data".kt', lineRange: {start: 9, end: 15}};
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed.status).toBe('valid');
    expect(parsed.contract?.claims![0].semantics?.source).toEqual(original.claims![0].semantics!.source);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(parsed.contract!));
    expect(roundTrip.contract?.claims![0].semantics?.source).toEqual(original.claims![0].semantics!.source);
  });

  it.each([
    {}, {sourceReferenceId: 'id', filePath: 'File.kt'},
    {sourceReferenceId: '', filePath: 'File.kt', lineRange: {start: 1, end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 0, end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 2, end: 1}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: '1', end: 2}},
    {sourceReferenceId: 'id', filePath: 'File.kt', lineRange: {start: 1, end: 2}, verified: true},
  ])('retains invalid source declarations as invalid: %j', source => {
    const original = structuredClone(contract()) as any;
    original.claims[0].semantics.source = source;
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed.status).toBe('invalid');
    expect(parsed.contract?.claims![0].rawSemantics).toEqual(original.claims[0].semantics);
  });

  it('preserves explicit SQL null in reference values and relation endpoints', () => {
    const original = contract();
    original.claims![0].references[0].value = null;
    original.claims![0].semantics!.scope.subjectRefs![0].value = null;
    original.relationProposals![0].subject.value = null;
    const parsed = parseConclusionContractSidecar(rawSidecar(original));
    expect(parsed).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
    expect(parsed.contract?.claims![0].references[0]).toHaveProperty('value', null);
    expect(parsed.contract?.claims![0].semantics?.scope.subjectRefs![0]).toHaveProperty('value', null);
    expect(parsed.contract?.relationProposals![0].subject).toHaveProperty('value', null);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(parsed.contract!));
    expect(roundTrip.contract?.claims).toEqual(original.claims);
    expect(roundTrip.contract?.relationProposals).toEqual(original.relationProposals);
  });

  it('classifies every closed relation proposal shape failure without changing admission', () => {
    const valid = () => ({schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation-1',
      kind: 'comparison_delta', direction: 'subject_to_object',
      subject: {evidenceRefId: 'subject', rowIndex: 0, rowSelector: {side: 'current'}, column: 'value', value: null},
      object: {artifactId: 'object', rowIndex: 1}, proof: {sourceToolCallId: 'proof'},
      proofBindings: {subject: {endpointColumn: 'subject_id', proofColumn: 'left_id'},
        object: {endpointColumn: 'object_id', proofColumn: 'right_id'}},
      metricColumn: 'delta', value: 1, unit: 'ms', deltaDirection: 'current_minus_reference'} as any);
    const cases: Array<[string, (proposal: any) => void]> = [
      ['item_not_object', proposal => {proposal.valueOf = () => null;}],
      ['unknown_field', proposal => {proposal.PRIVATE_RELATION_KEY_CANARY = true;}],
      ['invalid_schema_version', proposal => {proposal.schemaVersion = 'other';}],
      ['invalid_id', proposal => {proposal.id = 'not-a-proposal';}],
      ['invalid_kind', proposal => {proposal.kind = 'causes';}],
      ['invalid_direction', proposal => {proposal.direction = 'forward';}],
      ['invalid_subject', proposal => {proposal.subject = {column: 'value'};}],
      ['invalid_object', proposal => {proposal.object = {evidenceRefId: ''};}],
      ['invalid_proof', proposal => {proposal.proof = {private: 'PRIVATE_RELATION_VALUE_CANARY'};}],
      ['invalid_value', proposal => {proposal.value = null;}],
      ['invalid_unit', proposal => {proposal.unit = ' ';}],
      ['invalid_metric_column', proposal => {proposal.metricColumn = 1;}],
      ['invalid_delta_direction', proposal => {proposal.deltaDirection = 'reference_minus_current';}],
      ['invalid_proof_bindings', proposal => {delete proposal.proofBindings.object;}],
    ];
    for (const [reason, mutate] of cases) {
      let proposal: any = valid();
      if (reason === 'item_not_object') proposal = null;
      else mutate(proposal);
      const parsed = parseDeclaredRelationProposals([proposal]);
      expect(parsed.relationProposals).toEqual([]);
      expect(parsed.issues).toEqual([{code: 'invalid_relation_proposal', path: 'relationProposals[0]',
        relationProposalDiagnostic: {scope: 'item', ordinal: 1, reason}}]);
    }
    expect(parseDeclaredRelationProposals([valid()])).toEqual({relationProposals: [valid()], issues: []});
  });

  it('keeps endpoint null distinct from proposal null and requires both proof binding sides', () => {
    const base = structuredClone(contract().relationProposals![0]) as any;
    base.subject.value = null;
    expect(parseDeclaredRelationProposals([base]).issues).toEqual([]);
    for (const mutate of [
      (proposal: any) => {proposal.value = null;},
      (proposal: any) => {proposal.proofBindings = {subject: {endpointColumn: 'a', proofColumn: 'b'}};},
      (proposal: any) => {proposal.proofBindings = {object: {endpointColumn: 'a', proofColumn: 'b'}};},
      (proposal: any) => {proposal.proofBindings = {subject: {endpointColumn: 'a', proofColumn: 'b'},
        object: {endpointColumn: 'c', proofColumn: 'd', PRIVATE_RELATION_KEY_CANARY: true}};},
    ]) {
      const proposal = structuredClone(base);
      mutate(proposal);
      expect(parseDeclaredRelationProposals([proposal]).issues[0].relationProposalDiagnostic?.reason)
        .toBe(proposal.value === null ? 'invalid_value' : 'invalid_proof_bindings');
    }
  });

  it('uses original one-based relation ordinals up to 24 and never fabricates collection or later ordinals', () => {
    const collection = parseDeclaredRelationProposals({PRIVATE_RELATION_VALUE_CANARY: true});
    expect(collection.issues).toEqual([{code: 'invalid_relation_proposal', path: 'relationProposals',
      relationProposalDiagnostic: {scope: 'collection', reason: 'collection_not_array'}}]);
    expect(collection.issues[0].relationProposalDiagnostic).not.toHaveProperty('ordinal');

    const proposals = Array.from({length: 25}, (_, index) => ({...structuredClone(contract().relationProposals![0]),
      id: `proposal:item_${index + 1}`})) as any[];
    for (const index of [0, 23, 24]) proposals[index].kind = 'invalid';
    const issues = parseDeclaredRelationProposals(proposals).issues;
    expect(issues.map(issue => issue.path)).toEqual([
      'relationProposals[0]', 'relationProposals[23]', 'relationProposals[24]',
    ]);
    expect(issues.map(issue => issue.relationProposalDiagnostic)).toEqual([
      {scope: 'item', ordinal: 1, reason: 'invalid_kind'},
      {scope: 'item', ordinal: 24, reason: 'invalid_kind'},
      undefined,
    ]);
  });

  it('projects parse issues into closed triage codes with one slot per base code', () => {
    const proposals = Array.from({length: 26}, (_, index) => ({...structuredClone(contract().relationProposals![0]),
      id: `proposal:item_${index + 1}`})) as any[];
    proposals[0].kind = 'invalid';
    proposals[1].direction = 'sideways';
    proposals[2].kind = 'invalid';
    proposals[25].kind = 'invalid';
    const relationIssues = parseDeclaredRelationProposals(proposals).issues;
    expect(conclusionParseIssueTriageCodes([
      ...relationIssues,
      {code: 'invalid_semantics', path: 'claims[0].semantics'},
    ])).toEqual(['invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_semantics']);

    // Items past the diagnostic cap keep the bare code; the collection reason is closed too.
    expect(conclusionParseIssueTriageCodes([relationIssues[3]])).toEqual(['invalid_relation_proposal']);
    expect(conclusionParseIssueTriageCodes(parseDeclaredRelationProposals({x: 1}).issues))
      .toEqual(['invalid_relation_proposal:collection_not_array']);

    // Already-projected strings round-trip; anything outside the vocabulary is never echoed.
    expect(conclusionParseIssueTriageCodes([
      'invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_json',
      'PRIVATE_CODE_CANARY', 'invalid_json:invalid_kind', 'invalid_relation_proposal:PRIVATE_REASON_CANARY',
      'invalid_relation_proposal:invalid_kind:extra', {code: 'PRIVATE_OBJECT_CANARY'}, null,
    ])).toEqual(['invalid_relation_proposal:invalid_kind+invalid_direction', 'invalid_json']);

    expect(conclusionParseIssueTriageCodes(['invalid_json', 'invalid_claim', 'invalid_semantics', 'duplicate_marker']))
      .toEqual(['invalid_json', 'invalid_claim', 'invalid_semantics']);
    expect([...CONCLUSION_PARSE_ISSUE_CODES].sort()).toEqual([
      'duplicate_claim_id', 'duplicate_marker', 'duplicate_proposal_id', 'invalid_claim', 'invalid_contract',
      'invalid_framing', 'invalid_json', 'invalid_reference', 'invalid_relation_proposal', 'invalid_semantics',
      'untrusted_parser_metadata',
    ]);
  });

  it.each(['rowSelector', 'numeric', 'proposal_value'] as const)(
    'does not widen %s to accept null when reference values become nullable', target => {
      const invalid = structuredClone(contract()) as any;
      if (target === 'rowSelector') invalid.claims[0].references[0].rowSelector = {code: null};
      if (target === 'numeric') invalid.claims[0].semantics.numeric.value = null;
      if (target === 'proposal_value') invalid.relationProposals[0].value = null;
      const parsed = parseConclusionContractSidecar(rawSidecar(invalid));
      expect(parsed.status).toBe('invalid');
      expect(parsed.bindingEligibility).toBe('ineligible');
      expect(parsed.issues.length).toBeGreaterThan(0);
    },
  );

  it('round-trips typed declarations, exact scalar types and proposal IDs without proof', () => {
    const original = contract();
    const markdown = renderConclusionContractSidecar(original);
    const result = parseConclusionContractSidecar(markdown);
    expect(result.status).toBe('valid');
    expect(result.bindingEligibility).toBe('eligible');
    expect(result.contract?.claims).toEqual(original.claims);
    expect(result.contract?.relationProposals).toEqual(original.relationProposals);
    expect(result.contract?.claims?.[0].semantics?.numeric?.value).toBe('2.00');
    expect(result.contract?.claims?.[0].references[0].value).toBe('001');
    expect(result.contract).not.toHaveProperty('verified');
    expect(deriveConclusionContract(markdown)?.claims).toEqual(original.claims);
    expect(deriveConclusionContract(JSON.stringify(original))?.claims).toEqual(original.claims);
    expect(deriveConclusionContract('```json\n' + JSON.stringify(original) + '\n```')?.claims).toEqual(original.claims);
  });

  it('accepts an unknown predicate declaration without inferring or verifying it', () => {
    const result = parseConclusionContractSidecar(rawSidecar(contract()));
    expect(result.status).toBe('valid');
    expect(result.contract?.claims?.[0].semantics?.predicate).toBe('future.metric@7');
    expect(result.contract?.claims?.[0]).not.toHaveProperty('supportLevel');
  });

  it.each([
    ['missing', undefined, 'missing', 'missing_required'],
    ['null', null, 'null', 'wrong_type'],
    ['array', [], 'array', 'wrong_type'],
    ['object', {private: 'PRIVATE_STRUCTURE_CANARY'}, 'object', 'wrong_type'],
    ['literal', 'PRIVATE_STRUCTURE_CANARY', 'string', 'invalid_enum'],
  ])('explains a %s root mode without exposing its value or admitting the declaration', (_label, value, actual, reason) => {
    const input: Record<string, unknown> = {...contract(), mode: value};
    if (value === undefined) delete input.mode;
    const parsed = parseConclusionContractSidecar(rawSidecar(input));
    expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [{
      code: 'invalid_contract', path: '$', details: [{field: '$.mode', expected: 'conclusion_mode', actual, reason}],
    }]});
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.contract).toBeUndefined();
    expect(parsed.rawPayload).toEqual(input);
    expect(JSON.stringify(parsed.issues)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it.each([NaN, Infinity, -Infinity])('distinguishes nonfinite rank %s without changing finite numeric boundaries', rank => {
    const invalid = parseConclusionContractDeclaration({...contract(), conclusions: [{rank, statement: 'Synthetic'}]});
    expect(invalid.issues).toMatchObject([{code: 'invalid_contract', path: '$', details: [{
      field: '$.conclusions[].rank', expected: 'finite_number', actual: 'nonfinite_number', reason: 'invalid_number',
    }]}]);
    expect(invalid.contract).toBeUndefined();
    for (const finite of [0, -0, -1, Number.MAX_VALUE, Number.MIN_VALUE]) {
      expect(parseConclusionContractDeclaration({...contract(), conclusions: [{rank: finite, statement: ''}]}).issues).toEqual([]);
    }
  });

  it('reports numeric overflow parsed from JSON as nonfinite while preserving the original rejection', () => {
    const raw = rawSidecar({...contract(), conclusions: [{rank: 7, statement: 'Synthetic'}]}).replace(/"rank":\s*7/, '"rank":1e400');
    expect(parseConclusionContractSidecar(raw)).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [{
      code: 'invalid_contract', details: [{field: '$.conclusions[].rank', expected: 'finite_number',
        actual: 'nonfinite_number', reason: 'invalid_number'}],
    }]});
  });

  it('does not reclassify typed JSON with a wrong schemaVersion while sidecars diagnose the fixed literal', () => {
    const input = {...contract(), schemaVersion: 'PRIVATE_STRUCTURE_CANARY'};
    expect(parseTypedConclusionContractJson(JSON.stringify(input))).toMatchObject({status: 'absent', issues: []});
    expect(parseConclusionContractSidecar(rawSidecar(input))).toMatchObject({status: 'invalid', issues: [{
      code: 'invalid_contract', path: '$', details: [{field: '$.schemaVersion', expected: 'conclusion_contract_v1',
        actual: 'string', reason: 'invalid_literal'}],
    }]});
  });

  it('deduplicates repeated collection shape failures without inflating the original parse issue count', () => {
    const parsed = parseConclusionContractDeclaration({...contract(), conclusions: Array.from({length: 100}, () => ({rank: '1', statement: null}))});
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues).toMatchObject([{details: [
      {field: '$.conclusions[].statement', expected: 'string', actual: 'null', reason: 'wrong_type'},
      {field: '$.conclusions[].rank', expected: 'finite_number', actual: 'string', reason: 'wrong_type'},
    ]}]);
  });

  it('caps unique structure details while preserving one root rejection and avoiding user keys or values', () => {
    const invalidItems = [{}, null, [], 'PRIVATE_STRUCTURE_CANARY', 0, false, undefined, Infinity, () => undefined];
    const parsed = parseConclusionContractDeclaration({...contract(), conclusions: invalidItems,
      clusters: invalidItems, evidenceChain: invalidItems});
    expect(parsed.contract).toBeUndefined();
    expect(parsed.issues).toHaveLength(1);
    const details = parsed.issues[0].details!;
    expect(details).toHaveLength(24);
    expect(new Set(details.map(detail => `${detail.field}:${detail.actual}`)).size).toBe(24);
    expect(JSON.stringify(details)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it.each(['uncertainties', 'nextSteps'] as const)(
    'rejects object-valued %s while valid strings preserve the same original declarations', field => {
      const claims: NonNullable<ConclusionContract['claims']> = [
        {id: 'c1', text: 'The app identity was inferred from the available activity.', kind: 'identity',
          references: [{evidenceRefId: 'data:processes', column: 'process_name', value: 'example.app'}]},
        {id: 'c2', text: 'The main process has the highest observed activity.', kind: 'comparison',
          references: [{evidenceRefId: 'data:activity', column: 'slice_count', value: 164643}]},
      ];
      const base: ConclusionContract = {...contract(), claims, relationProposals: []};
      const entry = {topic: 'Identity inference', detail: 'A canonical identity resolver was not used.'};
      const invalidDeclaration = {...base, [field]: [entry]};
      const raw = rawSidecar(invalidDeclaration);
      const invalid = parseConclusionContractSidecar(raw);
      expect(invalid).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible',
        issues: [{code: 'invalid_contract', path: '$'}], rawPayload: invalidDeclaration});
      expect(invalid.contract).toBeUndefined();
      expect(normalizeConclusionOutput(raw)).toBe(raw);
      const validDeclaration = {...base, [field]: [`${entry.topic}: ${entry.detail}`]};
      const valid = parseConclusionContractSidecar(rawSidecar(validDeclaration));
      expect(valid).toMatchObject({status: 'valid', bindingEligibility: 'eligible', issues: []});
      expect(valid.contract?.claims).toEqual(claims);
      expect(valid.contract?.[field]).toEqual(validDeclaration[field]);
      expect(valid.contract?.claims?.every(claim => claim.semantics === undefined && claim.supportLevel === undefined)).toBe(true);
    },
  );

  it.each(['Simple answer', '# Arbitrary title\nNo required heading', 'A prose answer with no final punctuation'])(
    'keeps body formatting independent of binding: %s', body => {
      const original = body + '\r\n\r\n' + renderConclusionContractSidecar(contract()).replace(/\n/g, '\r\n');
      const result = parseConclusionContractSidecar(original);
      expect(result.status).toBe('valid');
      expect(result.narrative).toBe(body + '\r\n\r\n');
      expect(normalizeConclusionOutput(original)).toBe(original);
      expect(deriveConclusionContract(original)?.claims?.[0].id).toBe('claim:original');
    },
  );

  it('does not activate markers inside fences, blockquotes, indented code, comments or JSON strings', () => {
    const marker = renderConclusionContractSidecar(contract());
    const examples = [
      '````text\n' + marker + '\n````',
      '~~~example\n' + marker + '\n~~~',
      marker.split('\n').map(line => '> ' + line).join('\n'),
      marker.split('\n').map(line => '    ' + line).join('\n'),
      '<!-- example\n' + marker + '\n-->',
      JSON.stringify({text: marker}),
    ];
    for (const example of examples) expect(parseConclusionContractSidecar(example).status).toBe('absent');
    expect(parseConclusionContractSidecar(examples[0] + '\n\n' + marker).status).toBe('valid');
  });

  it.each(['missing-close', 'missing-json-fence', 'tail-garbage', 'wrong-version', 'duplicate'])(
    'blocks legacy extraction after invalid machine framing: %s', variant => {
      const marker = renderConclusionContractSidecar(contract());
      const broken = variant === 'missing-close' ? marker.slice(0, -3) :
        variant === 'missing-json-fence' ? marker.replace('```json\n', '') :
        variant === 'tail-garbage' ? marker.replace('\n```\n-->', '\n{"other":true}\n```\n-->') :
        variant === 'wrong-version' ? marker.replace('contract@1', 'contract@2') : marker + '\n' + marker;
      const input = '## 结论（按可能性排序）\n1. Legacy fallback must not win\n\n' + broken;
      const result = parseConclusionContractSidecar(input);
      expect(result.status).toBe('invalid');
      expect(result.bindingEligibility).toBe('ineligible');
      expect(result.contract).toBeUndefined();
      expect(deriveConclusionContract(input)).toBeNull();
      expect(normalizeConclusionOutput(input)).toBe(input);
    },
  );

  it('returns exact nonoverlapping machine spans for valid, duplicate and interrupted declarations', () => {
    const marker = renderConclusionContractSidecar(contract());
    const input = '前缀😀\r\n' + marker.replace(/\n/g, '\r\n') + '\r\n中间\r\n' + marker + '\n结尾';
    const result = parseConclusionContractSidecar(input);
    expect(result.status).toBe('invalid');
    expect(result.machineSegments).toHaveLength(2);
    expect(result.machineSegments.map(segment => input.slice(segment.start, segment.end))).toEqual([
      marker.replace(/\n/g, '\r\n'), marker,
    ]);
    expect(result.narrative).toBe('前缀😀\r\n\r\n中间\r\n\n结尾');
    const interrupted = 'Body\n' + marker.slice(0, -3);
    const partial = parseConclusionContractSidecar(interrupted);
    expect(partial.machineSegments).toEqual([{start: 5, end: interrupted.length}]);
    expect(partial.narrative).toBe('Body\n');
    const nested = marker.replace('\n```\n-->', '\n' + marker + '\n```\n-->');
    const duplicate = parseConclusionContractSidecar(nested);
    expect(duplicate.status).toBe('invalid');
    expect(duplicate.issues[0].code).toBe('duplicate_marker');
    expect(duplicate.machineSegments).toHaveLength(1);
  });

  it('retains invalid semantics and parser issues across render and parse', () => {
    const original = contract();
    const invalid = {...original, claims: [{...original.claims![0], semantics: {...semantics(), polarity: ['affirmed']}}]};
    const parsed = parseConclusionContractSidecar(rawSidecar(invalid));
    expect(parsed.status).toBe('invalid');
    expect(parsed.contract?.claims?.[0].semantics).toBeUndefined();
    expect(parsed.contract?.claims?.[0].rawSemantics).toEqual(invalid.claims[0].semantics);
    expect(parsed.issues).toContainEqual({code: 'invalid_semantics', path: 'claims[0].semantics',
      claimDiagnostic: {ordinal: 1, code: 'invalid_semantics', field: 'semantics.polarity'}});
    const derived = deriveConclusionContract(rawSidecar(invalid));
    expect(derived?.bindingEligibility).toBe('ineligible');
    expect(derived?.claims?.[0].text).toBe(invalid.claims[0].text);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(derived!));
    expect(roundTrip.status).toBe('invalid');
    expect(roundTrip.contract?.claims?.[0].rawSemantics).toEqual(invalid.claims[0].semantics);
  });

  it('preserves duplicate claim and proposal items without assigning replacement IDs', () => {
    const original = contract();
    original.claims!.push({...original.claims![0], text: 'Second distinct original claim'});
    original.relationProposals!.push({...original.relationProposals![0], unit: 'ns'});
    const result = parseConclusionContractSidecar(rawSidecar(original));
    expect(result.status).toBe('invalid');
    expect(result.contract?.claims?.map(claim => [claim.id, claim.text])).toEqual(original.claims!.map(claim => [claim.id, claim.text]));
    expect(result.contract?.relationProposals).toEqual(original.relationProposals);
    expect(result.issues.map(issue => issue.code)).toEqual(['duplicate_claim_id', 'duplicate_proposal_id']);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(result.contract!));
    expect(roundTrip.issues.map(issue => issue.code)).toEqual(['duplicate_claim_id', 'duplicate_proposal_id']);
  });

  it('keeps invalid citations and proposals visible as raw declarations, never valid bindings', () => {
    const original = contract();
    const invalid = {...original, claims: [{...original.claims![0], references: [{column: 'value', value: '999'}]}],
      relationProposals: [{...original.relationProposals![0], id: 'backend-proof-id'}]};
    const result = parseConclusionContractSidecar(rawSidecar(invalid));
    expect(result.status).toBe('invalid');
    expect(result.contract?.claims?.[0].text).toBe('Original claim');
    expect(result.contract?.claims?.[0].rawReferences).toEqual(invalid.claims[0].references);
    expect(result.contract?.rawRelationProposals).toEqual(invalid.relationProposals);
    expect(result.contract?.relationProposals).toEqual([]);
    const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(result.contract!));
    expect(roundTrip.contract?.claims?.[0].rawReferences).toEqual(invalid.claims[0].references);
    expect(roundTrip.contract?.rawRelationProposals).toEqual(invalid.relationProposals);
  });

  it('cannot take parser state from model-controlled metadata', () => {
    const original = contract();
    const result = parseConclusionContractSidecar(rawSidecar({...original, parseIssues: [], bindingEligibility: 'eligible', verified: true,
      claims: [{...original.claims![0], semantics: {predicate: 'incomplete'}, semanticsParseIssues: []}]}));
    expect(result.status).toBe('invalid');
    expect(result.bindingEligibility).toBe('ineligible');
    expect(result.contract).not.toHaveProperty('verified');
    expect(result.issues).toEqual(expect.arrayContaining([
      {code: 'untrusted_parser_metadata', path: '$'},
      {code: 'invalid_semantics', path: 'claims[0].semantics',
        // The omitted schema version is the canonical default, so the first real failure is polarity.
        claimDiagnostic: {ordinal: 1, code: 'invalid_semantics', field: 'semantics.polarity'}},
    ]));
  });

  it.each(['parseIssues', 'bindingEligibility', 'verified', 'rawDeclaration'])(
    'does not launder a root parser-owned field through machine rendering: %s', key => {
      const input = {...contract(), [key]: key === 'parseIssues' ? [] : key === 'rawDeclaration' ? contract() : true};
      const first = parseConclusionContractSidecar(rawSidecar(input));
      expect(first.status).toBe('invalid');
      expect(first.issues).toEqual([{code: 'untrusted_parser_metadata', path: '$'}]);
      expect(first.contract?.rawDeclaration).toEqual(input);
      const rendered = renderConclusionContractSidecar(first.contract!);
      const second = parseConclusionContractSidecar(rendered);
      expect(second.status).toBe('invalid');
      expect(second.bindingEligibility).toBe('ineligible');
      expect(second.issues).toEqual(first.issues);
      expect(second.rawPayload).toEqual(input);
    },
  );

  it.each(['semanticsParseIssues', 'parseIssues', 'rawDeclaration'])(
    'preserves a claim-only parser metadata rejection without a second invalid field: %s', key => {
      const original = contract();
      const input = {...original, claims: [{...original.claims![0], [key]: []}]};
      const first = parseConclusionContractSidecar(rawSidecar(input));
      expect(first.status).toBe('invalid');
      expect(first.issues).toEqual([{code: 'untrusted_parser_metadata', path: 'claims[0]',
        claimDiagnostic: {ordinal: 1, code: 'untrusted_parser_metadata', field: 'parser_metadata'}}]);
      expect(first.contract?.claims?.[0].semantics).toEqual(original.claims![0].semantics);
      expect(first.contract?.rawClaims).toEqual(input.claims);
      const second = parseConclusionContractSidecar(renderConclusionContractSidecar(first.contract!));
      expect(second.status).toBe('invalid');
      expect(second.bindingEligibility).toBe('ineligible');
      expect(second.issues).toEqual(first.issues);
      expect(second.rawPayload).toEqual(input);
    },
  );

  it.each([
    ['root', 'verified'], ['root', 'parseIssues'], ['root', 'rawDeclaration'],
    ['claim', 'semanticsParseIssues'], ['claim', 'rawReferences'], ['claim', 'rawDeclaration'],
    ['claim', 'parseIssues'], ['claim', 'bindingEligibility'], ['claim', 'verified'],
  ])('detects reserved %s.%s without other typed declaration signals', (level, key) => {
    const base = contract();
    delete base.relationProposals;
    delete base.claims![0].semantics;
    const input = level === 'root' ? {...base, [key]: []} :
      {...base, claims: [{...base.claims![0], [key]: []}]};
    const json = JSON.stringify(input);
    for (const text of [json, '```json\n' + json + '\n```']) {
      const parsed = parseTypedConclusionContractJson(text);
      expect(parsed.status).toBe('invalid');
      expect(parsed.issues).toEqual([level === 'root' ? {code: 'untrusted_parser_metadata', path: '$'}
        : {code: 'untrusted_parser_metadata', path: 'claims[0]',
          claimDiagnostic: {ordinal: 1, code: 'untrusted_parser_metadata', field: 'parser_metadata'}}]);
      const derived = deriveConclusionContract(text);
      expect(derived?.bindingEligibility).toBe('ineligible');
      expect(derived?.parseIssues).toEqual(parsed.issues);
      expect(normalizeConclusionOutput(text)).toBe(text);
      const roundTrip = parseConclusionContractSidecar(renderConclusionContractSidecar(derived!));
      expect(roundTrip.status).toBe('invalid');
      expect(roundTrip.rawPayload).toEqual(input);
    }
  });

  it.each(['invalid-mode', 'missing-uncertainties'])(
    'blocks typed JSON shell failures before legacy headings can discard claims: %s', defect => {
      const input: Record<string, unknown> = {...contract(), conclusion: 'Original narrative'};
      if (defect === 'invalid-mode') input.mode = 'invalid';
      else delete input.uncertainties;
      const json = JSON.stringify(input);
      for (const text of [json, '```json\n' + json + '\n```', '```json\r\n' + json + '\r\n```']) {
        const parsed = parseTypedConclusionContractJson(text);
        expect(parsed.status).toBe('invalid');
        expect(parsed.bindingEligibility).toBe('ineligible');
        expect(parsed.issues).toEqual([{code: 'invalid_contract', path: '$', details: [defect === 'invalid-mode'
          ? {field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'}
          : {field: '$.uncertainties', expected: 'array', actual: 'missing', reason: 'missing_required'}]}]);
        expect(parsed.raw).toBe(text);
        expect(parsed.rawPayload).toEqual(input);
        expect(parsed.contract).toBeUndefined();
        expect(deriveConclusionContract(text)).toBeNull();
        expect(normalizeConclusionOutput(text)).toBe(text);
      }
    },
  );

  it('does not let the legacy first-object extractor repair typed JSON framing', () => {
    const invalid = {...contract(), mode: 'invalid', conclusion: 'Original narrative'};
    for (const json of [JSON.stringify(contract()), JSON.stringify(invalid)]) {
      for (const text of [json + '\ntrailing text', '```json\n' + json + '\n```\ntrailing text']) {
        expect(deriveConclusionContract(text)).toBeNull();
        expect(normalizeConclusionOutput(text)).toBe(text);
      }
    }
  });

  it('keeps non-typed legacy JSON aliases on the compatibility parser', () => {
    const legacy = JSON.stringify({schema_version: 'conclusion_contract_v1', conclusion: 'Legacy statement',
      evidence_chain: [], claims: [{claim_id: 'legacy-claim', statement: 'Legacy statement', references: []}],
      uncertainties: [], next_steps: []});
    expect(parseTypedConclusionContractJson(legacy).status).toBe('absent');
    expect(deriveConclusionContract(legacy)?.claims?.[0]).toMatchObject({id: 'legacy-claim', text: 'Legacy statement'});
  });

  it('escapes comment closers and preserves decoded quotes, fences and multiline values', () => {
    const original = contract();
    const value = 'literal --> & <tag> "quote"\n```json\nline\n```\n<!-- smartperfetto:conclusion-contract@1';
    original.claims![0].text = value;
    original.claims![0].semantics!.conditions = [value];
    original.claims![0].references[0].value = value;
    const rendered = renderConclusionContractSidecar(original);
    const result = parseConclusionContractSidecar(rendered);
    expect(result.status).toBe('valid');
    expect(result.contract?.claims?.[0].text).toBe(value);
    expect(result.contract?.claims?.[0].semantics?.conditions).toEqual([value]);
    expect(result.contract?.claims?.[0].references[0].value).toBe(value);
    const unescaped = rawSidecar(original);
    expect(parseConclusionContractSidecar(unescaped).status).toBe('invalid');
  });

  it('leaves plain legacy contracts on their existing visible rendering', () => {
    const original = contract();
    delete original.relationProposals;
    delete original.claims![0].semantics;
    delete original.claims![0].kind;
    delete original.claims![0].artifactRefs;
    delete original.claims![0].relationRefs;
    const rendered = normalizeConclusionOutput(JSON.stringify(original));
    expect(parseConclusionContractSidecar(rendered).status).toBe('absent');
    expect(deriveConclusionContract(JSON.stringify(original))?.claims?.[0].text).toBe('Original claim');
  });
});
