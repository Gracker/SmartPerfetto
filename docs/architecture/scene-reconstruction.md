# 场景还原架构合同

[English](scene-reconstruction.en.md) | [中文](scene-reconstruction.md)

场景还原调查指定 Trace 范围内的用户操作、设备状态和应用响应，按时间输出可追溯的结构化时间线。用户操作见[基本使用](../getting-started/usage.md#场景还原)。本文定义采集、候选修订、核验、展示和历史读取之间的边界。

## 入口与执行所有权

用户点击“场景还原”后，`POST /api/agent/v1/scene-reconstruct` 使用当前 Provider 发起完整调查。入口从本地化 Strategy template 取得调查目标，并在服务端选择 `scene_reconstruction`，HTTP body 或模型输出不能自行取得这个内部入口身份。

该入口与普通 `/analyze` 共用 `analysisRunDispatchService`：准备会话、权限与 AI 开关、租户与 Trace 授权、配额、并发准入、Provider 固定、run、lease 和 manifest 均走同一条链路。选定 runtime 使用正常 Agent 工具循环，可以根据歧义继续查询；不是固定 SQL 执行后再调用模型写摘要。

```text
用户点击 + 当前 Provider
  → 共享分析准入与 run
  → 受信任场景上下文 + 固定 Strategy
  → Agent 查询输入 / 设备 / 应用响应事实
  → propose_scene_timeline 候选修订与诊断
  → 统一 finalizeAnalysisResult
  → 同一 revision 的界面、报告与历史投影
```

场景能力绑定当前 owner、Trace、session 和 run；运行上下文及发布凭证只在进程内签发，不能由 JSON 恢复。runtime 返回后由产品层统一结算一次并发布一个终态。停止、失败、过期 run 的后续事件不能改变最终版本。

智能模式的“场景盘点”仍是选择深钻范围的预览入口；它与这里的完整场景调查具有不同合同，不能把预览结果直接提升为本轮已核验的时间线。

## 事实与候选修订

调查从注册的 `scene_reconstruction`、`scene_device_state_changes` 等 Skill 获取事实，再按实际 source 和 schema 追查输入、窗口、生命周期、设备状态及渲染响应。解释方法在 `backend/strategies/scene-reconstruction.strategy.md`，SQL 与生产者元数据在 `backend/skills/`；TypeScript 负责生命周期、类型与证据边界。

每段保留稳定 ID、精确的十进制纳秒 `startNs` / `endNs`、对象身份，以及三个独立叙述：

| 字段 | 要回答的问题 |
| --- | --- |
| `userAction` | 用户做了什么，输入证据支持到哪一步？ |
| `deviceState` | 设备处于什么状态，哪些变化可被观察？ |
| `appResponse` | 应用或系统如何响应，响应属于哪个对象？ |

某一维度缺少证据时写明 unknown，不抹去其他已观察到的维度。缺少输入、帧或状态样本不等于 idle。多个 MOVE 不能单独证明滚动；没有惯性滚动来源时不能补造 fling。OEM DeviceState 编号必须保留原值，没有设备配置映射时不能猜测折叠姿态。

首次观测到 charging 等状态，不等于该时刻发生了状态转变。`ACTION_SCROLL` 保留为滚动轴输入，不能只凭动作编号推断物理滚轮。`scene_response_markers` 保存原始 Scroll / FlingStart 标记及其进程、时间和执行区间；标记名称里的 duration 参数不能代替实际动作的结束证据。

`propose_scene_timeline` 提交带 `baseRevision` 的增量候选，可增加、修订或移除片段。引用只能指向本轮真实工具执行保存的 artifact / evidence 及原始行位置；候选工具返回、模型笔记和历史报告都不是新证据。候选接受仅表示修订已保存，模型不能声明 verified。修订冲突、引用缺失、对象或边界矛盾应促使 Agent 回查事实。

一次提交按**原子变更组**结算：本次新增、修订、删除或被 supersede 的片段，连同在旧依赖图或新依赖图上能到达它们的片段（包括只有依赖指纹变化的已提交片段）连成一组；未受影响的共享上下文不参与分组。任一成员的 schema、边界、supersedes、依赖闭包或证据引用不成立，整组不提交，成员保留已提交版本与血缘；其他组照常提交为同一个 revision。组外片段不会依赖组内片段，因此一次求值即可得到确定结果；片段总数等共享上限在最终合成图上检查。返回的 `rejectedGroups` 一次列出每组全部失败引用，引用诊断只含标识字段名、可用列名和行数，从不回显单元格值。

注册表为证据类工具统一发布可选 `planPhaseId`，提案工具只把它用于计划归属，不进入严格的片段合同；显式 `null` 与空标识等同于未提供。MCP 宿主会在 handler 之前按工具发布的 schema 校验，因此发布的 schema 保留结构与必填项，但允许 `null`、空标识和嵌套未知键通过，最终由严格合同按组裁决；宿主可能丢弃顶层未知键，它们同样不会进入修订。数值单元格可以用其精确十进制字符串引用（纳秒字段在同一载荷里就是字符串）。提案回执携带 `success`/`planPhaseId`，被接受的修订可以完成计划阶段；可修复的拒绝以 `action_required` 返回，属于策略拒绝而不是工具故障，证据读取异常仍按故障处理。引用的 `rowIndex` 照抄行上打印的行号，行形状见 [MCP 工具](../reference/mcp-tools.md)。

## 提交节奏与预算

策略要求尽早提交小修订，但实际 run 把全部预算用于采集，首个被接受的修订普遍出现在采集末尾。节奏由共享注册表在每次采集调用前执行，对五个 runtime 一致生效，并排在授权与生命周期拒绝之后：

- 尚无已提交片段且已完成若干次采集时，采集结果附带提醒；达到次数上限或基础预算的一定比例后暂停采集，直到模型提交一次含片段的提案（被拒也算尝试，因此不会死锁），若仍无已提交片段会在几次采集后再次暂停。
- 距采集上限不足若干个“最慢近期模型轮次”（上限为采集跨度的一部分）时关闭采集窗口，只保留提案、已保留 artifact 的读取与最终回答；关闭后不再重开。
- 已有修订但长期未更新且移动截止时间临近时，采集结果提示先提交累积的片段。

OpenAI runtime 的场景分派使用进度感知截止：返回的工具结果和流式输出推迟调查截止，但不超过固定上限并保留 delivery 预留。Claude runtime 的场景分派采用同一预算（`CLAUDE_MAX_RUN_TIMEOUT_MS`，缺省回退 `AGENT_MAX_RUN_TIMEOUT_MS`，再到 60 分钟）；非场景 Claude run 以及 Pi、OpenCode、Qoder 仍使用固定预算，但同样受上述节奏约束。未发生 delivery 调用时，未消耗的 delivery 预留在硬上限内用于最终语义复核，避免慢 provider 因复核超时而退化为 `quality_gate_failed`。

长 Trace 按窗口调查并保留跨窗口的状态与未闭合边界。完整读取 artifact 分页不能补回 SQL 已被 LIMIT 截去的行；生产者截断、解析失败和未查询范围必须单独记录。资源上限导致明确的部分结果，不能静默丢掉末尾片段再宣称完整。

## 核验与覆盖边界

有限核验只回答可机械判断的谓词，例如引用是否属于本轮、对象身份是否一致、时间边界是否受证据支持。每项结果为 `passed`、`contradicted` 或 `unknown`；即使全部通过，自由文本叙述仍是 `semanticStatus: unverified`，不能由这些检查推导动作语义或因果关系已被证实。

扫描覆盖与采集完整性是不同事实：

- **扫描覆盖**以 `scene-coverage-policy.yaml` 的必查来源为固定分母，绑定本轮实际使用的 Skill 与 fragment 定义。服务端按来源和生产者指纹合并本轮真实执行回执，列出已扫描与未扫描区间；缺少生产者或未执行的来源仍保留，不能从分母删除。
- **采集完整性**回答 Trace 本身是否记录了所需事件。目前 `captureStatus` 保持 `unknown`；表存在、查询成功或返回零行都不能证明完整采集。
- **查询覆盖状态**仅在全部必查来源具有匹配生产者、成功执行且完整覆盖请求范围时为 `complete`，否则保持 `unknown` 或 `partial`。成功重扫可以补足旧失败窗口，历史问题仍单独保留。查询完成不代表采集完整，也不代表故事正确。

当前 `SceneTimelineAssessment.status` 保持 `partial`，与执行是否到达终态分开。交付判定只降不升：冻结快照中没有任何已提交片段时，run 的 `success` 为 false、置信度为 0，并说明本次没有交付场景时间线；已有时间线而原生运行失败（例如超时且无正文）时保持失败，同时说明保留了哪个 revision。已提交片段数量不会把原生失败改写为成功。成功结束一次调查不表示准确还原了每个动作；部分结果、失败和取消也不能通过报告生成或历史恢复变成“准确完成”。finalizer 只评估已有冻结快照，不补做查询或重新编故事。

## 一个版本，多种展示

`AnalysisResult.sceneTimeline` 是最终结构化版本。时间线、顶部场景展示、SSE 完成结果、HTML 与历史读取均从该版本派生，不从最终 Markdown 再解析另一份故事。运行中的修订事件属于候选展示；终态必须绑定相同 run 和 revision。

浏览器与 HTML 使用 `projectSceneTimelineForClient` 的展示视图，保留三项叙述、精确时间、对象、有限检查、覆盖和未决事项，不携带 canonical evidence 原始行。HTML 的“场景详情 (JSON)”指向现有的授权报告端点，不代表匿名共享。完整证据保存在 owner 隔离的归档内；其他普通分析表格仍遵循各自的报告投影合同。

会话快照可保存最终结果，比较快照的 `summary_json` 仅保存 `sceneReport` 引用，不复制第二套时间线。引用绑定 Trace、session、run、revision、到期时间及 manifest 哈希；它是定位记录，不是新的执行证据或发布凭证。

## 归档、权限与失效

统一 finalizer 只为至少有一个已提交片段的 revision 签发一次性 publication，revision 0 不会发布为场景报告；publication 绑定 scope、canonical revision 和实际 summary。`SceneStoryService` 消费后生成 v3 产品报告，由 `SceneEvidenceArchive` 原子发布 report、assessment 与证据分片的 manifest。只有归档成功后结果才附带 `sceneReport` 引用；失败保留 `scene_archive_unavailable`，不伪造可用报告。

归档默认保留 7 天，由 manifest 的到期时间决定。读取 `/api/agent/v1/scene-reconstruct/report/:reportId` 同时检查 owner 和当前 Trace 权限。校验和错误、到期、Trace 删除或授权不可用时不能回退到内存或旧 v2 缓存。删除 Trace 使相关归档失效，历史 SSE、状态或快照不能复活归档，也不能签发 live proof。

summary 保留实际生成时的语言与内容。切换显示语言只本地化界面标签，不用“共 N 个场景”等模板替换已保存叙述。

## 验证入口与证明范围

场景产品入口的 E2E helper 使用独立开关；从 `backend/` 执行：

```bash
npx tsx src/scripts/verifyAgentSseScrolling.ts \
  --entry scene-reconstruction --mode full --provider-id env \
  --trace ../Trace/real/android-scroll-customer/trace.pftrace \
  --output test-output/e2e-scene-reconstruction-real.json --keep-session
```

该调用需要所选 runtime 的真实凭证与 Trace 文件，走 `/scene-reconstruct`，不是用普通分析请求模拟。它的证明范围是产品路由、runtime、修订生命周期和公开展示报告检查；通过不等于自由文本语义或采集完整性已证实。动作准确性还需要独立的 Trace 时间区间与对象事实进行对照。

mock 合同测试不能替代各 runtime 的真实认证 E2E。当前其他 runtime 的 mock 通过不构成真实认证验收；真实 E2E 仍需独立记录。Qoder 的真实认证验证为 `NOT AVAILABLE` 时，应保留这个状态，不能计为通过。不同 Provider 与 runtime 的选择关系见[Agent 运行时](agent-runtime.md)。
