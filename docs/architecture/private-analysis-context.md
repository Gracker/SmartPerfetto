# 私有分析上下文架构

[English](private-analysis-context.en.md) | [中文](private-analysis-context.md)

SmartPerfetto 把 trace 证据、用户源码和外部知识视为三个独立的数据域。源码只在本次
请求显式选择、scope/同意有效且已注册根目录可访问时进入 runtime；不要求 active index。
外部知识仍要求许可、同意与 active generation。两者都不能被全局 RAG、历史 session
或跨会话学习隐式带入分析。

## 请求组合

| 源码选择 | 外部 RAG 选择 | 有效行为 |
|---|---|---|
| 无 | 无 | 普通 trace / Smart Profile 分析，不开放私有检索工具 |
| 有 | 无 | 使用精确 `codebaseIds` 和按需源码工具；`metadata_only` 只给 `CodeRef`，`provider_send` 还要求注册级同意 |
| 无 | 有 | 使用精确 `knowledgeSourceIds` 和对应 active generation；外部知识仅作背景，不冒充当前 trace 证据 |
| 有 | 有 | 两套 allowlist 同时生效，分别校验后进入同一私有投影和报告边界 |

`fast` / `full` 选择预算，源码、外部 RAG 和 reference trace 的授权独立保留，不因
预算模式被自动移除，也不强制升级为完整报告。五个原生 runtime 按 typed intent 的
范围和证据访问约束按需调用工具；`existing_only` 禁止新采集，`read_new` 不扩大授权。
Conversation 复用这些按需能力，不自动启动额外源码分析。Smart Profile 的 preview
只生成场景盘点；从 preview
进入深度分析时，源码模式、`codebaseIds`、`knowledgeSourceIds`、输出语言和 preview
身份必须原样传给实际 run，不能依赖 UI 的隐式全局状态。

## 授权与连续性

每个 run 在创建 session 前解析当前 scope 中的注册项，并生成非 secret 授权指纹。指纹
覆盖 tenant/workspace/user、源码模式、排序后的 allowlist、active/index generation、
内容指纹与 revision provenance，以及许可/同意状态。工具调用和 run 边界重新计算指纹；
发生删除、重建、撤销同意或 scope 变化时，旧 session fail closed，并要求新会话。

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

同次运行的语义复核使用已签发声明中的原始文本字段。输入权限同时绑定原始声明、
展示候选和 canonical 投影；字段路径、所属声明身份与完整文本必须一致。它只跳过
展示用的源码回显替换，私有查询、敏感路径、canary、撤权和大小检查仍然生效。
复核正文始终是实际展示正文，不会用隐藏的原始正文代替；声明未在正文表达时不能通过。

有限事实证明与语义核验分别执行。`captured.cell` 只验证原声明指定的非数值单元格，
按字符串、布尔值或 null 严格比较；数值继续使用带单位的 `numeric.cell`。
`source.location` 比较原始声明中的引用、相对路径和行范围与本轮源码账本，只证明查询
返回的位置快照。它不生成 Trace 发生证据，不证明函数行为、调用链或因果。源码位置
结论还绑定源码账本和 source binding 的指纹，修改任一项后旧核验状态失效。
精确的 `semantics.source` 不要求在 `sourceClaimBindings` 重复声明；若显式提供该 claim
的关联，仍必须唯一且引用相同位置。整个关联数组的错误结构不能被过滤成“未提供”。
省略关联不会让机制 verifier 自动通过，位置事实仍需完整的正文语义复核。

无需源码的回答不会被要求取得源码核验通过。共享 finalizer 仅在本轮实际 MCP 访问
范围已捕获、没有源码访问或明确 `not_needed` 且账本为空、原始声明没有源码依赖，
并完成全文语义审阅时签发 `source: not_applicable`。缺失 scope、失败搜索、未完成
审阅或投影中被丢弃的错误源码字段都不能作为“不适用”的依据；原源码 verifier
仍保留 `not_checked`，不伪造通过结果。

直接 SQL 的单位也来自执行证据。只有本应用持有、二进制与文档 pin 匹配、尚未发生
不受控 SQL/RPC 或端口暴露的 processor，才为可明确溯源的直接列投影签发字段信息。
当前只采用正式 `DURATION` 列的 ns 单位；别名、`*` 展开必须与实际输出和原始 schema
逐列匹配。已解析的标量计算列占据原输出位置，其他直接列仍可保留来源；计算列本身不
获得单位。聚合、分组和连接等超出行对应证明范围的查询不签发这类列来源。执行队列在查询前后校验来源状态，
通过进程内回执把单位绑定到 SQL 和结果；JSON 自报字段不具备这个权限。状态失效后
查询仍可执行，但不能通过恢复同名表或相同 DDL 重新取得原生来源证明。

正式 schema 恰好具有一个 `ID` 列，且查询实际返回该原始列时，原生执行回执还保留
同一行的关系名、ID 与稳定 schema 指纹。引用时长单元格时，准备阶段也会在现有读取
预算内保留这项行身份。有限证明只投影其实际使用的单元格所属行；JSON、展示字段和
普通 capture 参数不能重新签发行身份。验收可用同一 Trace、关系、原始 ID 和独立
解析的 schema 指纹对应实际事件，不必额外查询进程或推导时钟。未返回 ID、多 ID
关系、计算出的 ID 或缺失来源仍保持未知。

个人部署同样通过共享的 run lease 生命周期管理分析查询。已验证的本地 Trace
处理器若因界面连接或 SQL 改变而失去原生来源状态，分析会在现有内存配额内为本轮
创建专用实例；当前和对比 Trace 各自保持原身份。HTTP 普通分析、smart 根运行与 CLI
复用同一组实例直到 finalization，结束、取消和迟到的初始化都会回收租约与实例。
专用连接不通过统计、查看器或 RPC 别名公开。外部 RPC 与未知二进制不会借复制获得
可信来源；配额或来源校验失败也不会静默换回共享实例。

加载 Trace 本身只发送纯读取 SQL（元数据查询位于直接投影语法之内），因此刚加载、
未公开端口的本地文件 Trace（包括 CLI）保持可信，本轮直接复用共享实例而不再重新加载。
多个运行因此可能共用同一实例，直到第一次失效；失效只会单调降级（纪元递增），失效前
签发、失效后才完成的执行不会获得单位依据，之后的运行改用专用实例。

这不是任意 SQL 的单位推导。范围明确的问题按实际运行策略跳过无关预取；完整场景的
普通模块加载仍可能使原生来源状态失效，之后由 Skill 自身的执行采集提供其字段语义，
直接 SQL 缺少依据时继续保留未知。不会为每个工具或模块加载重复创建处理器。

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
