# 使用自己的设备与团队知识库

[English](private-knowledge.en.md) | [中文](private-knowledge.md)

你可以给 SmartPerfetto 添加设备专有 tag 的定义、Trace 片段解释、线程职责、版本差异和
已知问题文档。它们走**文档知识库**，独立于源码库：不需要提供源码，也不需要开启源码正文。
知识库帮助模型理解名称与机制；本次 Trace 中是否发生、持续多久和是否导致卡顿，仍需
当前 Trace 的 SQL／Skill 证据。

## 准备文档

把资料放到运行后端的机器可访问的目录。手机上的资料需要先导出到这个目录；目前不会直接
连接或同步手机知识库。支持 `.md .markdown .mdx .txt .rst .adoc .html .htm`，不直接索引 PDF。
优先用完整 tag 名作为标题，每段写清含义、参数、设备／系统版本和适用条件，例如：

```markdown
# ExamplePhone 渲染 tag（示例）

## VendorFrameCommit
适用：ExamplePhone，系统版本 3.x。
含义：渲染线程提交本帧图层，不代表帧已经上屏。
参数：frameId 为应用帧编号。
排查：需结合实际 fence 等待和 FrameTimeline 判断是否延迟。
```

这是示例定义，不是任何真实设备的事实。资料越准确、适用范围越清楚，越能减少模型猜测；
过期或冲突的资料也会误导解释，修改文件后需要重建索引。

## 在 Web 中使用

1. AI Assistant 输入框旁的上下文控件 →“管理…”→“文档知识库”→“选择文件夹添加”。
2. 填写名称和覆盖范围，预览收录／跳过文件，确认有权使用资料，并审阅 AI 服务发送披露。
3. 注册并建立索引，允许向当前配置的 AI 服务发送命中的正文。可以先试检索一个完整 tag。
4. 回到上下文控件，勾选本轮使用的知识库，再提问，例如：
   “结合设备知识库解释 VendorFrameCommit 的含义，再用当前 Trace 判断它与卡顿是否有关。”

注册不等于选择；没有权利确认、发送授权或活动索引的库不能用于分析。知识库选择独立于
源码开关。远程后端不能读取浏览器所在机器的目录；Docker 需挂载资料目录，手动路径需在
`SMARTPERFETTO_KNOWLEDGE_ROOTS` 内。

## 在 CLI 中使用

```bash
smp knowledge preview ./device-docs
smp knowledge register ./device-docs --accept-rights \
  --name "设备 tag 说明" --description "设备与版本专有 tag、参数和 Trace 片段解释" \
  --send-to-provider
smp knowledge reindex <注册返回的sourceId>
smp knowledge search <sourceId> "VendorFrameCommit" --top-k 5
smp analyze ./trace.pftrace --knowledge-source-id <sourceId> \
  --query "结合设备知识库解释 VendorFrameCommit，并核对当前 Trace"
```

`<sourceId>` 等占位符需替换成注册返回的值。CLI 和 Web 默认使用各自的数据目录；在 CLI
注册的库不会自动出现在 Web 列表，详见 [CLI 配置](../reference/cli.md)。

## 查看使用与引用

模型通过 `search_knowledge` 检索，再用 `read_knowledge_section` 阅读相关章节。
完整名称／短语命中优先，仍保留拆词和中文词组召回；这是全文检索，不是自动理解所有同义词。
检索摘录只含片段开头，必要时需继续读章节；预算不足、无匹配、版本冲突或部分读取不能冒充
已经查证。

答案使用《标题 › 小节》及 `kb:相对路径#L起-L止` 标明出处。回答下方的“知识库使用”显示：

- **检索交付数**：本轮实际交给模型的资料引用数量，不代表答案采纳了这些资料。
- **答案引用数**：答案写出的出处数量；未引用会明确显示“答案未引用知识库”。展开可见本轮
  已交付正文、仅定位到、未检索到或多库匹配未能确定等状态。状态核对的是位置与读取，不证明
  资料内容正确或因果成立。

本地历史中的回执只保存计数。答案的出处与引用可以随本地分析历史、HTML 报告、CLI 产物和
快照保留；报告的“引用的内部资料”保留位置核对状态。没有交付记录表示未记录，不等于使用数为零。

## 私有内容边界

本地索引按所有者／工作区隔离，分析只检索本轮明确选中的授权知识库，固定本轮索引版本。
命中的片段会发送给当前配置的 AI 服务（也可以是公司内部服务），不是保证全文永不离开本机。
AI 服务如何留存由其配置与政策决定；本地结果可能保留引用。撤销授权或删除库会停止后续访问，
不会删除原文目录，也不能撤回已发送的内容。

知识库里的指令不是工具授权，资料引用不是 Trace 证据。公开 Android 系统资料也可走同一条链路，
见 [Android Internals Wiki](android-internals-knowledge.md)。
