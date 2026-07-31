# Agent 辅助 GitHub 反馈

[English](agent-assisted-feedback.en.md) | [中文](agent-assisted-feedback.md)

<!-- i18n-headings: paired -->

完成一次分析后，用户通常能看到“不确定声明”“Skill 报错”或“报告生成失败”，但未必
知道这是不是 SmartPerfetto 的问题、应该反馈什么、能贡献什么。M10 在分析结果旁加入
一个独立的 Agent 反馈助手，把持久化证据转成可审查的 GitHub 草稿。

它不自动提交 Issue、PR、commit 或 push，也不会把勾/叉反馈自动解释成公开投诉。
叉反馈仍先作为原有事实事件保存；保存成功后只会显式展示 Agent 判断入口，由用户决定
是否继续。

## 用户流程

1. 当前或历史消息带有 V2 Analysis Receipt 时，前端读取该 run 的
   `runId`、`runManifestId` 和可选 `resultSnapshotId`。
2. 后端只读取这个 run 已持久化的 `analysis_completed` 事件、RunManifest 和匹配
   snapshot，检测不支持/不确定 claim、partial gate、Skill error/empty、低场景
   置信度、身份未解析、报告生成失败，以及同一 run 已持久化的负反馈。
3. 有信号时，结果下方显示数量和 **让 Agent 帮我判断是否应反馈**。
4. 用户点击后才运行独立、无工具、单轮的 triage Agent。它最多给出三个候选，明确：
   - `report`、`needs_user_input`、`needs_verification` 或 `not_reportable`；
   - 责任面是 analysis、Skill、Strategy、runtime、trace data、UI 还是未知；
   - 用户适合贡献 Bug 复现、Skill/Strategy 改进、Runtime 兼容信息、文档/UI 反馈或
     脱敏 Trace fixture；
   - 仍缺少什么证据，以及需要用户回答的问题。
5. 只有可反馈候选、必答问题已完成且用户确认敏感信息复核后，后端才生成草稿。
6. 最后按钮只在新窗口打开预填 GitHub 页面；仍需用户检查并点击 GitHub 的提交按钮。

仓库也提供
[Agent-Assisted Analysis Feedback Issue Form](https://github.com/Gracker/SmartPerfetto/issues/new?template=analysis_feedback.yml)，
用于未从 UI 进入或需要手工补充的情况。

## Agent 与降级边界

triage 复用源 run 当时固定的 provider/runtime，而不是当前活动 provider：

- 新 RunManifest 保存非秘密 `providerSnapshotHash`。
- review 前重新解析同一个 provider/runtime/scope，并比较 snapshot hash。
- provider 已删除、配置或密钥版本已变化、凭据不可用、旧 run 没有 pin，或当前
  runtime 暂不支持独立 triage 时，不会静默切换模型。
- 降级结果只能提示 `needs_verification` 和应补充的信息，不能替 Agent 宣称“应报告”。

Claude Agent SDK 与 OpenAI-compatible runtime 支持真实 triage；Pi Agent Core、
OpenCode 和 Qoder 的 M10 V1 使用明确的安全降级。主分析 session、run、result、
feedback 和 Self-Evolution 状态都不会被 triage 改写。

## 校验、隐私与安全

Agent 输出不是可信事实。后端会再次执行固定校验：

- 严格 schema、枚举、字段、条数和大小限制；
- signal、claim、finding、evidence 和 Skill id 必须真实存在于源 run；
- Skill 只能是 built-in 或已批准 external pack；
- 低置信度或没有具体引用的候选不能标为 `report`；
- review 返回后由服务器附加短时效完整性证明；生成草稿时会重新检查源 run 的
  provider pin，并拒绝客户端伪造、修改、过期或跨用户复用的 Agent/fallback review；
- prompt-control 内容会被拒绝；邮箱、URL、MAC、电话、绝对路径、包名和常见密钥
  在送入外部 triage Provider 前和公开草稿边界都会脱敏；
- private/code-aware 分析 fail-closed，不提供公开反馈；
- 用户勾选“可能涉及安全漏洞”后，公开草稿被禁用并改道到
  [私密 Security Advisory](https://github.com/Gracker/SmartPerfetto/security/advisories/new)。

自动脱敏不能替代人工检查。Trace 原文、私有源码、公司信息、账号、设备标识、路径、
provider 请求/响应和密钥都不应进入公开 Issue。

## 与 Self-Evolution 的关系

M10 是普通用户的外部反馈辅助面，不是 M0–M9 Self-Evolution 控制面的新自动发布
步骤：

- 勾/叉 feedback 仍进入原有 public/private 事实与投影路径；公开负反馈只作为
  `user_reported_inaccuracy` 候选信号，不自动调用 Agent 或创建 GitHub 草稿；
- GitHub 草稿不会自动创建 feedback event、proposal、overlay 或 contribution bundle；
- M0–M9 的 gate、人工 accept、apply/revert 和对账语义不变；
- 两条路径只共享源 run 的不可变归因和中立公开工件脱敏器。

## 用户冒烟测试

1. 使用 `./start.sh` 或 Docker 完成一次包含可识别 gap 的公开分析。
2. 确认结果下方显示信号数；无 gap 的 run 不应显示反馈卡。
   对无 gap 的结果点叉，确认保存成功后出现“让 Agent 分析我该反馈或贡献什么”，
   且不会自动打开 GitHub。
3. 点击 Agent 判断，确认候选说明“是否反馈、归属、可贡献内容、缺失证据”。
4. 故意漏答必答问题或不勾敏感信息复核，确认“生成 GitHub 草稿”不可用。
5. 完成回答并勾选复核，确认页面显示可检查的标题、正文、脱敏记录和
   “尚未提交”提示。
6. 点击打开 GitHub，确认新窗口是预填草稿且 GitHub 尚未提交任何 Issue。
7. 对 private/code-aware run 重复，确认公开反馈被禁用。
8. 勾选安全漏洞，确认只能进入 private Security Advisory。
9. 修改/删除源 run 的 provider profile 后再检查旧结果，确认显示配置变化降级，
   没有改用当前 provider。

## 维护者验证

```bash
npm --prefix backend run test:external-issue-reporting
npm --prefix backend run typecheck
npm --prefix backend run validate:strategies
npm --prefix backend run verify:e2e:deepseek-external-issue

cd perfetto/ui
node build.mjs --typecheck
node build.mjs --run-unittests --no-build \
  --test-filter "external issue reporting UI contract"
```

UI 修改还必须通过 `./scripts/start-dev.sh` 做浏览器验证，再从仓库根目录运行
`./scripts/update-frontend.sh`。合入前执行 `npm run verify:pr`。真实 provider 专项
suite 会强制产生可操作源 run 信号，证明 review 的 `source=agent`；若 Agent 判定可以
公开，还会验证草稿 `notSubmitted=true` 与 HTTPS GitHub 预填 URL，否则验证 Agent
明确阻止公开草稿。两种分支都不会写入 GitHub。
