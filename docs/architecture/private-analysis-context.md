# 私有分析上下文架构

[English](private-analysis-context.en.md) | [中文](private-analysis-context.md)

SmartPerfetto 把 trace 证据、用户源码和文档知识库视为三个独立的数据域。源码只在本次
请求显式选择、scope/同意有效且已注册根目录可访问时进入 runtime；不要求 active index。
文档知识库是独立的 SQLite FTS 文档库（不是 RAG chunk），只在本次请求显式选择、
已做权利确认、已授权发送给模型服务且有 active generation 时才可检索；license 字段
只是所有者自填的说明，不是准入条件。两者都不能被公共 RAG 语料、历史 session 或跨会话
学习隐式带入分析。

## 请求组合

| 源码选择 | 知识库选择 | 有效行为 |
|---|---|---|
| 无 | 无 | 普通 trace / Smart Profile 分析，不开放私有检索工具 |
| 有 | 无 | 使用精确 `codebaseIds` 和按需源码工具；`metadata_only` 只给 `CodeRef`，`provider_send` 还要求注册级同意 |
| 无 | 有 | 使用精确 `knowledgeSourceIds`，通过 `search_knowledge` / `read_knowledge_section` 读取各自固定的 generation；知识库仅作背景，不冒充当前 trace 证据 |
| 有 | 有 | 两套 allowlist 同时生效，分别校验后进入同一私有投影和报告边界 |

选择在合并会话或对话已有选项之后只解析一次（`effectiveAnalysisSelection`）：显式
`codeAwareMode: off` 丢弃 `codebaseIds`（隐藏的 ID 不授权任何访问，也不再返回 400）；
只有 ID 没有模式视为 `metadata_only`；没有 ID 时模式无意义，记为 `off`；知识源选择与
源码模式无关。授权、注册表读取、指纹、内存分区、运行参数和会话持久化都消费同一结果。

`fast` / `full` 选择预算，源码、知识库和 reference trace 的授权独立保留，不因
预算模式被自动移除，也不强制升级为完整报告。五个原生 runtime 按 typed intent 的
范围和证据访问约束按需调用工具；`existing_only` 禁止新采集，`read_new` 不扩大授权。
Conversation 复用这些按需能力，不自动启动额外源码分析。Smart Profile 的 preview
只生成场景盘点；从 preview
进入深度分析时，源码模式、`codebaseIds`、`knowledgeSourceIds`、输出语言和 preview
身份必须原样传给实际 run，不能依赖 UI 的隐式全局状态。

## 同意模型

知识库和源码的同意方式不同，因为授权单位不同。文档知识库没有路径过滤，授权单位就是
整个注册目录，所以“发送给模型服务”是一个布尔同意：注册时给出，或之后在 Web UI
开关（显示披露文本后确认）、`PATCH /api/rag/knowledge/:id/consent` 或
`smp knowledge consent <id> --enable|--disable` 修改，三者调用同一个注册表操作。源码库
有路径选择和语言，授权之后选择还可能变化，所以正文发送采用服务端签发的披露 token：
`authorizeContent` 只授权调用方看过的那份范围，范围变了就拒绝。两者共享显式的逐轮选择、
授权指纹、每次模型请求前的授权检查，以及 owner/strict 两种投影。

## 授权与连续性

每个 run 在创建 session 前解析当前 scope 中的注册项，并生成非 secret 授权指纹。指纹
覆盖 tenant/workspace/user、有效源码模式、排序后的 allowlist、选择范围与授权
revision、生命周期，以及许可/同意状态；不含索引 generation（索引工具各自检查本 run
固定的 generation）。工具调用和 run 边界重新计算指纹；runtime 能拦截的每次模型请求
前也重新计算，因为原生循环每次请求都会重发之前的工具结果：指纹变化即以
`analysis_context_changed_restart_required` 结束 run，而不只是拒绝之后的读取。发生删除
所选源、实际同意或范围变化、或 scope 变化时，旧 session fail closed，并要求新会话。重复提交相同同意、等价范围
或修改未选中的源不改变指纹。

私有分析只允许当前进程内的受限多轮连续性，不恢复持久化 provider conversation。
原始 query、工具参数和完整检索载荷不额外进入日志或 provider transcript。
用户可见结果使用独立的 owner 投影，保留分析正文、源码引用和具体校验原因，可随本地
历史、HTML 报告、CLI artifact 和 analysis-result snapshot 保存。日志及公开材料仍使用
严格投影；知识库正文、凭据、授权与会话撤销保持独立保护。owner 与 strict 使用独立过滤
状态和容量，源码 echo 注册过多不能导致用户结果整段消失。投影作用域仅限同步计算，
流式对象在创建时固定用途，避免显示策略扩散到日志回调。

分析过程保留模型提供的分析说明、工具调用、结果摘要和阶段状态；校验未通过时保留正文及原因。
各 runtime 在结果截断前，从已经完成外部投影的工具结果签发进程内回执，共享叙述层只用
回执中的安全事实说明是否找到定位、读到授权内容或执行失败。JSON 和模型文字不能伪造
该回执。源码使用状态来自实际调用记录；机制状态来自通过准入的非空源码绑定及核验结果，
不能由模型自行声明升级。报告保留已选择源码的安全相对路径、行号和引用身份。

最终声明在任何展示替换之前解析。原始声明与核验用的单元格值仅保存在当前进程的
finalization context 中；公开声明与正文另外经过安全投影。共享投影器签发的私有回执
把原始声明绑定到当前 run、attempt、展示候选和声明指纹。确定性核验使用原始值，
不能把展示中的 `CodeRef` 与原始 Trace 单元格比较，也不能把投影后的相等当作原始值相等。
回执缺失、候选变化或授权失效时保持未核验；序列化结果不能恢复回执。协议固定字段与
枚举按结构处理，文本值经过投影后再序列化，避免源码内容或带引号的路径破坏 JSON。

实验函数文档提交保留原始工具参数、`documentJson`、编译正文和完整原始 canonical payload，
包括无效条目。它们只进入绑定当前运行的私有提交与 finalization context；公开工具事件、
日志及进度只显示 pending／rejected 摘要。正文中的 JSON、HTML 或声明示例始终是正文，
不能被重新扫描成声明。新运输的三份原始字符串与展示正文分别逐字绑定，合法的隐私替换
还需已签发的精确输入投影链；hash 不能单独授权。正常 SDK 清理不撤销已交接提交，
产品取消、授权失效或 finalization dispose 会撤销它。持久化的作者来源不能恢复该能力。

V2 混合响应的伴随文字保存在本轮 SDK 私有上下文与有界临时缓冲中。实际保留的参数和
伴随文字合计上限为 1 MiB，任一分量因容量限制丢失内容时会保留该事实。最终提交的
签发材料来自唯一工具文档。内部材料观察只保存固定字段的计数和状态，null、未知和
未保留各自标记，沿当前 run／attempt／请求归属处理取消及迟到事件。

显式 dual mode 的 assistant 文档使用独立私有 `sourceKind: assistant_json` 快照，保留
原始 `rawAssistantText`、实际 response ID、SDK message ID、原生文档、编译正文和原始
canonical payload；不伪造 callId、rawArguments 或 handler ACK。只有创建 issuer 时捕获的
`function_or_assistant_json` 策略允许该来源，模型不能自行选择或扩大权限。每次读取仍
逐字核对原文及 source／dispatch／version／owner 身份，hash 只用于关联，不能代替相等。
assistant 载体的公开 origin 为 `sdk_final`，质量与语义复核仍要求已提交状态及匹配的
活跃 authored 绑定；旧函数来源与 `model_tool_arguments` 的对应关系保持。两种载体共享
原始声明、私有 quote bindings 和隐私投影规则，持久化记录不能恢复这些能力。

同次运行的语义复核使用已签发声明中的原始文本字段。输入权限同时绑定原始声明、
展示候选和 canonical 投影；字段路径、所属声明身份与完整文本必须一致。它只跳过
展示用的源码回显替换，私有查询、敏感路径、canary、撤权和大小检查仍然生效。
复核正文始终是实际展示正文，不会用隐藏的原始正文代替；声明未在正文表达时不能通过。

有限事实证明与语义核验分别执行。`captured.cell` 只验证原声明指定的非数值单元格，
按字符串、布尔值或 null 严格比较；数值继续使用带单位的 `numeric.cell`。
源码不走有限证明：`source_claim_verifier@2` 由服务端为每个依赖源码的 claim 计算状态
（`invalid`、`unbound`、`location_only`、`source_only`、`trace_linked`），并把正文
写出的源码位置与本轮签发的引用比对。只有 `invalid`（未签发或越出选择的引用、不属于
该 claim 的 Trace ID）使答案失败；较弱的状态保持未核验。答案只在本轮未读过的行引用某个
claim 时，无论还读过别的什么，该 claim 都停在 `location_only`。`trace_linked` 也只说明
被引用的位置读取过正文且有同一 claim 的 Trace 证据，不证明函数行为、调用链或因果，仍需完整的正文
语义复核。整个关联数组的错误结构不能被过滤成“未提供”。

无需源码的回答不会被要求取得源码核验通过。共享 finalizer 仅在本轮实际 MCP 访问
范围已捕获、没有源码访问或明确 `not_needed` 且账本为空、原始声明没有源码依赖，
并完成全文语义审阅时签发 `source: not_applicable`。缺失 scope、失败搜索、未完成
审阅或投影中被丢弃的错误源码字段都不能作为“不适用”的依据；原源码 verifier
仍保留 `not_checked`，不伪造通过结果。

直接 SQL 的单位也来自执行证据。只有应用持有、二进制与文档 pin 匹配且来源状态仍可信的
processor，才为实际结果签发字段语义。直接 `DURATION` 列的单位为 ns；别名和 `*` 展开
须与真实输出及原始 schema 逐列匹配。现有数量表达式规则还可证明部分时长换算、
时间戳相减、原生时间尺度下的 MIN/MAX 裁剪及计数单位。计算列的表示单位不自动授予
原生行身份、时钟、主体或因果证明；不支持的表达式保持未知，不从列名猜单位。
队列在执行前后核来源状态，并用进程内回执把单位绑定到 SQL 与实际结果。JSON 字段
元数据没有这个权限。SQL/模块或端口暴露使状态失效后只会单调降级；恢复同名表或相同
DDL 不能重新取得原生来源证明，失效前已完整签发的不可变 capture 仍可读取。

正式 schema 恰好具有一个 `ID` 列，且查询实际返回该原始列时，原生执行回执还保留
同一行的关系名、ID 与稳定 schema 指纹。引用时长单元格时，准备阶段也会在现有读取
预算内保留这项行身份。有限证明只投影其实际使用的单元格所属行；JSON、展示字段和
普通 capture 参数不能重新签发行身份。验收可用同一 Trace、关系、原始 ID 和独立
解析的 schema 指纹对应实际事件，不必额外查询进程或推导时钟。未返回 ID、多 ID
关系、计算出的 ID 或缺失来源仍保持未知。

个人部署同样通过共享的 run lease 生命周期管理分析查询。已验证的本地 Trace
处理器若因界面连接或 SQL 改变而失去原生来源状态，分析会在既有内存准入规则下为本轮
创建专用实例；当前和对比 Trace 各自保持原身份。HTTP 普通分析、smart 根运行、CLI 和有 Trace 的 Conversation
复用同一组实例直到 finalization，结束、取消和迟到的初始化都会回收租约与实例。
专用连接不通过统计、查看器或 RPC 别名公开。外部 RPC 与未知二进制不会借复制获得
可信来源；配额或来源校验失败也不会静默换回共享实例。

加载 Trace 本身只发送纯读取 SQL（元数据查询位于直接投影语法之内），因此刚加载、
未公开端口的本地文件 Trace（包括 CLI）保持可信，本轮直接复用共享实例而不再重新加载。
多个运行因此可能共用同一实例，直到第一次失效；失效只会单调降级（纪元递增），失效前
签发、失效后才完成的执行不会获得单位依据，之后的运行改用专用实例。

`executionContext=working`（缺省）保留现有工作区 SQL 语义。身份解析、Skill 或探测加载
模块仍可能使该实例失去原生来源状态；此时 Skill 使用自己的执行采集语义，普通 SQL
缺少的权威单位继续保持未知。不得仅按表名把查询移到别的实例，同名工作表可以有不同值。

显式 `original_trace` 使用 run 内另一条受限原生读取路径。当前 parser 完整承认的单一
pinned prelude 关系查询才可进入；JOIN、子查询、CTE、工作表和 INCLUDE 等不支持输入
明确拒绝。原 SQL 逐字执行一次，直接采集该实例的实际结果，不给旧工作区结果补贴单位。
执行前拒绝不产生执行 review/capture/artifact；真实 SQL 错误与无真实结果的 worker 异常
分别保留已执行失败和执行未知，取消或撤权不被包装为普通拒绝。

该路径仅可复用应用真正物化的 Trace：CLI 复制和 HTTP 上传完成 rename 后签发私有输入
凭据，绑定服务实例与当前 registration；首次实际加载成功并复验同一文件身份与 SHA 后
才有 loaded-source pin。普通路径登记、旧实例或 JSON 恢复不能补签。子实例使用同一份
应用控制的不可变输入，前后检查原 pin、binary/docs pin、授权、当前 owner 和 Trace pair。
没有私有源码上下文不妨碍已授权 Trace 读取；factory-issued fence 的出处检查与这些权限
分别成立。模型字段、复制或序列化凭据均不能授予读取能力。

每个 run 的不同 Trace 至多懒创建一个私有原生 reader，重复请求复用同一次初始化。
它保持独立 namespace，不公开端口，不自动恢复或轮换已失败的实例。创建遵守严格实例
数量门和既有 RAM admission；未知 RSS 不等于精确空闲内存保证。配额或来源不足时不回退
到共享工作区，也不反复加载。租约回收和迟到初始化清理保留用户 Trace 文件；处理器实际
退出与发起 release 分开核验。此来源保证限于应用控制的物化生命周期，不宣称能抵御
同 UID 对应用私有目录的恶意改写。

Conversation 的逻辑会话可保留当前进程内的原始 artifact/capture，但每轮仍使用唯一
物理 session/run ID。私有签发的 binding 绑定精确 trace pair、授权指纹和 owner scope；
JSON、历史正文或 snapshot 都不能恢复该能力。模型得到的有界目录仅用于定位仍保留的
artifact，不包含 rows 或验证权。授权/范围变化和会话销毁撤销 context；旧轮次取消、
迟到回调或 cleanup 不能影响新轮次。每次 finalization 的读取视图固定其可读取的采集集合。

## 注册与删除生命周期

注册完成且根目录仍可访问时，按需搜索/读取立即可用。索引是语义/符号检索与 patch 的
可选能力，不再是启动分析的前置条件；注册根目录漂移或丢失会 fail closed。

索引重建按 lease 隔离，先写入唯一 staged generation，完整性校验通过后才原子切换
active generation，再回收旧 generation。删除复用同一 lease，但顺序为：

```text
active -> deleting tombstone -> remove all generations -> remove registration
```

`deleting` 会立即撤销 provider 同意、切断 active generation 并阻止检索、重新授权和
重建。物理清理失败时保留 tombstone，重复 DELETE 可继续，避免“接口返回失败但旧注册
仍能使用”的部分提交。所有 registry、chunk、lease 和 API 操作都按
tenant/workspace/user scope 校验；未知或越权 ID 的 DELETE 使用幂等成功，避免泄露存在性。

Web UI 的选择按 backend URL 和请求 scope 分区；凭证变化会清空私有选择。设置弹窗中
未保存的 URL/凭证草稿不能绑定 Codebases 管理面，避免在新后端执行 mutation 却把 ID
写回旧后端分区。
