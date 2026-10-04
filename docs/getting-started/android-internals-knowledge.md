# 把 Android Internals Wiki 作为知识库使用

[English](android-internals-knowledge.en.md) | [中文](android-internals-knowledge.md)

[Android Internals Wiki](https://github.com/Gracker/android-internals-wiki)（AIW）是公开的
Android 系统机制与性能分析资料。SmartPerfetto 不再内置它，也不再提供它专用的连接器：
把 AIW 的 `src/` 目录注册为**文档知识库**，它就和你自己的团队文档走同一条链路——
同一套检索、同一对工具（`search_knowledge` / `read_knowledge_section`）、同一种
`kb:路径#L起-L止` 引用和同样的隐私规则。

知识库只提供背景，不是 Trace 证据：本次 trace 里发生了什么，仍要由 Skill、SQL
等当前 trace 证据证明；只依据知识库的说法会标明“依据内部资料”。

## 1. 获取内容

```bash
git clone https://github.com/Gracker/android-internals-wiki.git
```

AIW 内容采用双许可：`CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial`，商业使用需另有书面
商业许可。注册时的权利确认只是你对“有权使用这些文档”的声明，不是许可授予。

## 2. 注册为文档知识库

只注册 `src/` 目录：仓库根目录还包含构建脚本和生成物，会降低检索质量。

Web UI：在 AI 助手对话框的上下文控件里打开“管理…”，在“文档知识库”中选择
`android-internals-wiki/src` 文件夹，先预览收录与跳过的文件，再注册并建立索引。
名称建议填 `Android Internals Wiki`，描述写清覆盖范围（例如“Android 系统机制与性能
分析：启动、渲染、Binder、调度、内存、GC、锁与 IO”），模型据此判断何时查询。

CLI：

```bash
smp knowledge register ./android-internals-wiki/src --accept-rights \
  --name "Android Internals Wiki" \
  --description "Android 系统机制与性能分析：启动、渲染、Binder、调度、内存、GC、锁与 IO" \
  --send-to-provider
smp knowledge reindex eks_xxx
smp knowledge search eks_xxx "Choreographer doFrame" --top-k 5
```

服务器部署（非本机目录选择器）需要把目录加入 `SMARTPERFETTO_KNOWLEDGE_ROOTS`，
Docker 还要先只读挂载该目录。AIW 更新后执行 `git pull` 再重建索引；上一代索引在新
代次就绪前继续服务正在运行的分析。

## 3. 在分析中使用

在对话框的上下文控件里勾选该知识库，或在 CLI 中传
`--knowledge-source-id eks_xxx`。只有具备权利确认、模型服务同意和激活索引的知识库
才能被选用；选择是逐轮的，不会自动启用所有已注册的知识库。

模型在遇到陌生的线程、slice、模块名、内部术语或已知问题时按需检索，而不是批量扫描。
实测（DeepSeek，启动/滑动/机制解释问题）中，模型只在部分运行里主动查询；如果你
需要它结合 AIW 解释某个机制，直接在问题里说明即可。引用、交付记录
（`knowledge_use@1`）和报告中的“引用的内部资料”说明见
[CLI 参考 · 文档知识库](../reference/cli.md#文档知识库)。

## 从旧版本迁移

- **内置 Knowledge Pack 已移除。** `smp knowledge-pack` 命令、`SMARTPERFETTO_AIW_PACK_*`
  环境变量、`/health` 中的 `androidInternalsKnowledgePack` 字段和 doctor 中的 Pack 行
  都已删除；发行物不再携带 Pack 快照，也不再后台检查 Pack 更新。实测中模型几乎从不
  主动调用它（历史会话里唯一一次主动调用命中的是无关文章），它带来的打包体积、后台更新和
  第二套引用契约没有换来准确性。以前下载过的 Pack 版本仍留在后端数据目录的
  `knowledge-packs/android-internals/` 下，可以手动删除。
- **旧版 Wiki 连接器已退役。** 以前通过 `/api/rag/android-internals/*` 注册的 Wiki
  仍会列在知识库列表中，标记为已停用，不能再被选用（分析会以
  `ANALYSIS_CONTEXT_SOURCE_RETIRED` 拒绝）；这些接口现在返回 410。删除旧条目后，按
  上文把 `src/` 重新注册为文档知识库。
- 旧会话、报告和快照里记录的 Pack 背景引用继续保留和显示，但新的分析不会再产生。
