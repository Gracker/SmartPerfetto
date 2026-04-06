# SmartPerfetto Skills (Anthropic Standard Format)

Android 性能分析 Skills，从 SmartPerfetto 导出为 Anthropic 标准 SKILL.md 格式。

## 包含的 Skills

### startup-analysis — 启动性能分析
- **场景**：冷启动/温启动/热启动性能瓶颈定位
- **能力**：TTID/TTFD 分析、四象限诊断、根因推理链、18 种 App 层根因 + 12 种系统层根因
- **文件**：
  - `SKILL.md` — 分析方法论、阶段指令、决策树、输出格式
  - `reference-sql-patterns.md` — 19 个原子 SQL 模板 + 组合编排模板
  - `reference-knowledge.md` — 根因分类体系(A1-A18/B1-B12) + 底层机制知识

### scrolling-analysis — 滑动/卡顿分析
- **场景**：滑动卡顿、掉帧、帧率分析
- **能力**：21 种根因分类码、双信号卡顿检测、缺帧检测、Flutter/WebView/Compose 架构支持
- **文件**：
  - `SKILL.md` — 分析方法论、阶段指令、根因分类、输出格式
  - `reference-sql-patterns.md` — 15+ 个原子 SQL 模板 + Flutter 专用模板
  - `reference-knowledge.md` — 渲染管线机制 + 卡顿根因分类 + 底层知识

## 安装方式

将对应的 skill 目录复制到目标项目的 skills 目录：

```bash
# 复制到项目的 .claude/skills/ 目录
cp -r startup-analysis /path/to/your-project/.claude/skills/
cp -r scrolling-analysis /path/to/your-project/.claude/skills/

# 或者复制到用户级 skills 目录（所有项目可用）
cp -r startup-analysis ~/.claude/skills/
cp -r scrolling-analysis ~/.claude/skills/
```

## 前置依赖

目标项目需要：

1. **Perfetto trace_processor**：加载 .pftrace/.perfetto-trace 文件并提供 SQL 查询能力
2. **SQL 执行工具**：Claude 可调用的 `execute_sql()` 或等效 MCP tool
3. **trace 数据要求**：
   - 启动分析：atrace 分类 `am`, `dalvik`, `wm`, `sched`（最低）
   - 滑动分析：atrace 分类 `gfx`, `view`, `input`, `sched`（最低，Android 12+）
   - 推荐额外：`binder_driver`, `disk`, `freq`

## 文件结构说明

```
skill-name/
├── SKILL.md                    # [Level 2] 主文件 — 触发后加载
│                                # 包含分析方法论、阶段指令、决策树、输出格式
│                                # Claude 读取后知道"如何分析"
│
├── reference-sql-patterns.md   # [Level 3] SQL 模板参考 — 按需加载
│                                # 包含所有原子 SQL 查询模板
│                                # Claude 执行 SQL 时参考
│
└── reference-knowledge.md      # [Level 3] 知识参考 — 按需加载
                                 # 包含根因分类体系和底层机制知识
                                 # Claude 做根因分析时参考
```

**加载层级说明**（Anthropic Skills 标准）：
- Level 1：仅 name + description（~100 tokens），始终加载
- Level 2：SKILL.md 全文（触发时加载）
- Level 3：reference 文件（SKILL.md 中引用时按需加载）

## 如果目标项目没有 SQL 执行能力

Skills 仍然有价值：
- **SKILL.md** 提供完整的分析方法论和决策树，Claude 可以指导用户手动分析
- **reference-knowledge.md** 提供根因分类体系和底层机制知识
- **reference-sql-patterns.md** 中的 SQL 可以在 Perfetto UI 的 SQL 控制台中手动执行

## 源项目

导出自 [SmartPerfetto](https://github.com/Gracker/SmartPerfetto)，一个 AI 驱动的 Android 性能分析平台。

原始格式为自定义 YAML Skills（声明式 SQL 管线 + 运行时编排），此处转换为 Anthropic 标准 SKILL.md 格式（Claude 行为指令 + SQL 模板）。
