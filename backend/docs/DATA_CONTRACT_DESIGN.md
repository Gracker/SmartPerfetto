# SmartPerfetto 数据合约

[English](DATA_CONTRACT_DESIGN.en.md) | [中文](DATA_CONTRACT_DESIGN.md)

本文描述当前已实现的数据合约，不是迁移计划。TypeScript 权威源是
[`backend/src/types/dataContract.ts`](../src/types/dataContract.ts)；前端文件
`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts`
由生成器产生，禁止手工修改。

## 合约目标

同一份分析数据会被多个产品面消费：

```text
TraceProcessor / YAML Skill / runtime direct evidence
  -> DataEnvelope
  -> SSE 与前端表格
  -> HTML report
  -> CLI turn artifacts
  -> analysis-result snapshot / comparison
  -> evidence、claim verification 与 identity sidecar
```

这些产品面可以使用不同投影，但不能各自发明不兼容的数据结构。聊天可以隐藏低信号
审计细节；报告、snapshot 和 CLI artifact 仍需保留复核所需的来源信息。

## DataEnvelope

`DataEnvelope<T>` 由三部分组成：

```ts
interface DataEnvelope<T = DataPayload> {
  meta: DataEnvelopeMeta;
  data: T;
  display: DataEnvelopeDisplay;
}
```

- `meta`：数据类型、schema 版本、来源、时间、Skill/step、执行状态和证据来源。
- `data`：表格、图表、文本或诊断 payload。
- `display`：层级、格式、标题、列定义、可见性和排序/折叠提示。

`meta.executionStatus` 区分：

- `observed`：查询成功并观察到结果；
- `empty`：查询成功但没有匹配行；
- `optional_error`：可选查询不可用或执行失败。

不要把 `empty` 和 `optional_error` 合并成“没有问题”。对比模式还会在 `meta` 中保留
`traceSide`、pane、trace id、query hash 和 evidence ref。进程/线程相关数据可以携带
identity sidecar；计划执行可以携带 phase attribution；这些字段必须跨报告、
snapshot 和 verifier 保持一致。

## 显示层与详细度

当前显示层由源码常量校验：

- `overview`：L1 概览；
- `list`：L2 列表/明细；
- `session`：按 session 或区间组织的结果；
- `deep`：L3/L4 深钻；
- `diagnosis`：确定性诊断。

显示详细度使用 `none`、`debug`、`detail`、`summary`、`key` 或 `hidden`。
`none`/`hidden` 不应被普通聊天或表格误当作可见数据；报告和内部审计是否保留由各自投影
规则决定。

## 自描述列

`ColumnDefinition` 是表格渲染的 schema。重要字段包括：

- `name`、`label`；
- `type`：`string`、`number`、`timestamp`、`duration`、`percentage`、
  `bytes`、`boolean`、`enum`、`json` 或 `link`；
- `format`、`unit`；
- `clickAction`：`navigate_timeline`、`navigate_range`、`copy` 等；
- `durationColumn`、排序、宽度、隐藏和 tooltip。

Skill 应尽量显式声明列语义。兼容路径会用
`inferColumnDefinition()` / `buildColumnDefinitions()` 推断常见 `ts`、`dur`、
`*_ms`、`*_bytes` 等字段，但推断不是新 Skill 省略 schema 的理由。

时间戳和时长可以使用字符串保存纳秒精度。前端格式化或导航时不得先经过会丢精度的
JavaScript `number`。

## Skill 兼容桥

SkillExecutor 仍会先产出 `DisplayResult` / `LayeredSkillResult`。当前桥接函数是：

- `displayResultToEnvelope()`；
- `layeredResultToEnvelopes()`；
- `envelopeToDisplayResult()`；
- `envelopesToLayeredResult()`。

它们用于兼容现有 Skill 和消费者，不代表可以绕过 DataEnvelope 校验。新增或修改
Skill 时，`display.layer`、`display.level`、列 schema、执行状态和 synthesize
输出都应能在转换后保真。

## Query Review

`QueryReviewV1` 是 SQL/Skill 执行的可审查元数据，不是新的 trace 证据。它由
`execute_sql`、`execute_sql_on` 或 `invoke_skill` 生成，记录 producer、证据/Artifact
来源、实际读取表、过滤条件、输出字段、防护规则、限制和执行统计。解析器不能可靠
判断复杂 SQL 时必须标为 `partial`，不能把推测伪装成已观察事实。

固定边界是 `allowedUse: review_metadata_only`：Query Review 可以帮助用户和 reviewer
理解“查询做了什么”，但不能单独支持诊断 claim，也不能替代 `evidenceRefId`。完整对象
随 DataEnvelope/Artifact 进入报告；给模型的 compact projection 不包含可执行 SQL；私有
分析上下文对外投影时还必须经过统一脱敏。

## Analysis Receipt

`AnalysisReceiptV2` 在分析完成边界生成，绑定 `runManifestId`、`runId`、`sessionId`、
`traceId`、请求/解析后
模式、runtime 和 provider。它分别统计 trace evidence、非证据上下文、claim audit 和
final-report/claim/identity 三类质量门禁，并指向实际生成的 report、snapshot 或 CLI turn。

Receipt 只描述本次运行实际发生的事情。`partial` 和 `not_applicable` 不能显示成 `passed`；
报告生成失败必须保留在 `outputs.reportError`，不能因为聊天已经完成而丢失。Web SSE、HTML
report、CLI 持久化和 analysis-result snapshot 都保留同一版本化合约，但可以使用各自的
可读投影；私有知识路径必须先做安全投影。

## UI Action

DataEnvelope 可以派生受限的 UI action proposal：

- `navigate_timeline`；
- `navigate_range`；
- `open_evidence_table`；
- `pin_evidence`。

动作必须引用已有 evidence/artifact/Skill 来源。前端只执行允许的 typed action，
不能执行模型生成的任意脚本、SQL 或 URL。

## Agent 外部反馈

`ExternalIssueOpportunityV1`、`ExternalIssueReviewV1` 和
`ExternalIssueDraftV1` 是分析完成后的独立派生合约，不属于
`UiActionProposalV1`，也不改变 `AnalysisRunSpec`。

- opportunity 只从持久化 `analysis_completed`、匹配 RunManifest 与可选 result
  snapshot 检测确定性信号；
- review 只允许最多三个候选，每个候选必须使用该次 run 的真实 evidence、Skill、
  claim gate、identity 或 report 引用；Agent JSON 经过精确键、枚举、大小和公开内容
  校验；review endpoint 还会附加短时效服务器完整性证明；
- draft 合并已校验候选、用户回答和敏感信息确认，分开呈现事实、Agent 判断、用户确认、
  缺失证据与脱敏记录；生成前会重验 provider pin 和服务器证明，并固定返回
  `notSubmitted: true`；
- private/code-aware 源 run、provider pin 缺失/漂移或安全敏感内容都 fail-closed。

RunManifest 的可选 `providerSnapshotHash` 让新 run 绑定 review 使用的 provider
配置快照；旧 manifest 仍可读取，但不会静默借用当前 provider。前端类型继续由同一生成器
从后端权威类型输出。

## 生成与验证

后端合约变化后：

```bash
cd backend
npm run generate:frontend-types
npm run typecheck
npx jest src/types/__tests__/dataContract.test.ts \
  src/services/skillEngine/__tests__/displayContractValidator.test.ts \
  src/services/__tests__/htmlReportGenerator.test.ts --runInBand
```

生成器会更新
`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts`。
如果生成结果变化，还要运行相关 Perfetto UI typecheck/test，并按
[`AGENTS.md`](../../AGENTS.md) 与
[前端规则](../../.claude/rules/frontend.md) 更新提交的 `frontend/` 预构建。

Skill YAML 变化另需：

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```

合入前使用仓库总门禁：

```bash
npm run verify:pr
```

## 维护检查表

- 后端类型仍是唯一手写源；生成文件没有被直接编辑。
- SSE、报告、CLI、snapshot、comparison 和 verifier 的投影边界都已检查。
- external-issue opportunity/review/draft 保留源 run 引用、provider pin、服务器
  review 证明、用户确认和 `notSubmitted` 边界。
- `empty`、`optional_error`、uncertainty 没有被混成确定性结论。
- current/reference 和 identity/provenance 信息没有在转换中丢失。
- 列单位、时间精度和 click action 与真实数据一致。
- 中英文本文档与合约测试同步更新。
