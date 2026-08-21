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

除轻量 Conversation surface 外，源码、外部 RAG 或 reference trace 任一被选择时，
轻量 runtime 不具备所需工具，`fast` / `auto` 会解析为 `full`。Conversation
固定使用 fast executor 并只返回受限引用；需要源码/RAG 深证据时必须 handoff 到新的
完整分析。Smart Profile 的 preview 只生成场景盘点；从 preview
进入深度分析时，源码模式、`codebaseIds`、`knowledgeSourceIds`、输出语言和 preview
身份必须原样传给实际 run，不能依赖 UI 的隐式全局状态。

## 授权与连续性

每个 run 在创建 session 前解析当前 scope 中的注册项，并生成非 secret 授权指纹。指纹
覆盖 tenant/workspace/user、源码模式、排序后的 allowlist、active/index generation、
内容指纹与 revision provenance，以及许可/同意状态。工具调用和 run 边界重新计算指纹；
发生删除、重建、撤销同意或 scope 变化时，旧 session fail closed，并要求新会话。

私有分析只允许当前进程内的受限多轮连续性，不恢复持久化 provider conversation。
原始 query、工具参数、检索正文和中间推理不进入日志、普通 session history、HTML
报告或 snapshot；旧版本留下的私有 context snapshot 在私有请求尝试恢复时会被清除。
最终结论、确定性 trace 证据和有界 provenance 经过共享投影后，才分别进入聊天、报告、
CLI artifact 和 analysis-result snapshot。

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
