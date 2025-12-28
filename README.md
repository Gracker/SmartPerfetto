# SmartPerfetto - AI 驱动的 Perfetto 分析平台

SmartPerfetto 是一个基于 AI 的 Perfetto 性能分析平台，通过 AI 助手帮助开发者更轻松地分析 Android 性能数据。

## 功能特性

- 🤖 **AI 智能分析**：使用自然语言提问，AI 自动生成 SQL 并分析 Trace 数据
- 📊 **多轮对话分析**：AI 会根据分析结果继续深入，直到完整回答你的问题
- ⚡ **实时进度反馈**：通过 SSE 展示 AI 分析过程，了解每一步在做什么
- 🎯 **集成 Perfetto UI**：基于官方 Perfetto UI，保留完整的可视化能力
- 🚀 **简单易用**：无需复杂配置，上传 Trace 即可开始分析

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                   Perfetto UI (Local)                       │
│                      http://localhost:10000                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┬──────────────────────────────────────┐    │
│  │   Timeline  │          AI Assistant Panel          │    │
│  │             │  ┌─────────────────────────────────┐ │    │
│  │   [Trace]   │  │ > 帮我分析这段 Trace 的 ANR      │ │    │
│  │             │  │                                 │ │    │
│  │   [Panels]  │  │ ⏳ 🤔 正在生成查询...            │ │    │
│  │             │  │ ⏳ ⏳ 正在执行查询...            │ │    │
│  │             │  │ ⏳ 📊 正在分析结果...            │ │    │
│  │             │  │                                 │ │    │
│  │             │  │ 📝 [分析结果...]                │ │    │
│  │             │  │                                 │ │    │
│  │             │  │ [上传到后端]                    │ │    │
│  │             │  └─────────────────────────────────┘ │    │
│  └─────────────┴──────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ SSE (Server-Sent Events)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend API Server                        │
│                      http://localhost:3000                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         PerfettoAnalysisOrchestrator                │   │
│  │  • 理解用户提问                                      │   │
│  │  • 生成 SQL 查询                                     │   │
│  │  • 执行查询并分析结果                                │   │
│  │  • 判断是否需要继续查询                              │   │
│  │  • 生成最终答案                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌───────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │ TraceProcessor│  │ AnalysisSession  │  │  AI SDK    │ │
│  │   Service     │  │     Service      │  │ (DeepSeek) │ │
│  └───────────────┘  └──────────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 职责分离

| 层级 | 职责 |
|------|------|
| **前端** | UI 显示、进度展示、用户交互 |
| **后端** | 完整的分析闭环：理解 → 生成SQL → 执行 → 分析 → 判断 → 继续或回答 |

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm
- Python 3.x (用于 Perfetto 构建)

### 安装依赖

```bash
# 安装后端依赖
cd backend
npm install

# Perfetto UI 依赖（首次运行时自动安装）
cd ../perfetto/ui
npm install
```

### 启动开发服务器

```bash
# 终端 1 - 启动后端
cd backend
npm run dev

# 终端 2 - 启动 Perfetto UI
cd perfetto/ui
./run-dev-server
```

### 访问应用

- **Perfetto UI**: http://localhost:10000
- **Backend API**: http://localhost:3000

## 使用指南

### 1. 打开 Perfetto UI

访问 http://localhost:10000

### 2. 打开 Trace 文件

- 点击 "Open trace file" 或拖拽 `.perfetto-trace` 文件到页面
- 等待文件加载完成

### 3. 打开 AI 助手

- 点击左侧边栏的 AI 助手图标
- AI 面板将在右侧展开

### 4. 上传 Trace 到后端

- 点击 AI 面板中的 **"上传到后端"** 按钮
- 等待上传完成（状态会显示为 "ready"）

### 5. 开始提问

在输入框中输入问题，例如：

```
> 帮我分析这段 Trace 中的 ANR 问题
> 找出所有耗时超过 100ms 的主线程操作
> 分析这段 Trace 中的内存分配情况
> 有没有明显的卡顿问题？
> 统计一下 CPU 使用情况
```

### 6. 查看分析过程

AI 会实时显示分析进度：

```
⏳ 🤔 正在生成查询...
⏳ ⏳ 正在执行查询...
⏳ 📊 正在分析结果...
📝 [最终分析结果]
```

### 可用命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/sql <query>` | 执行 SQL 查询 |
| `/goto <timestamp>` | 跳转到指定时间戳 |
| `/analyze` | 分析当前选中区域 |
| `/anr` | 快速检测 ANR |
| `/jank` | 快速检测掉帧 |
| `/clear` | 清除对话历史 |
| `/settings` | 打开设置 |

### 示例 Trace 文件

你可以从以下位置下载示例 Trace：

- [Perfetto BigTrace](https://storage.googleapis.com/perfetto.ui/bigtrace/)
- [Android Trace Examples](https://perfetto.dev/docs/quickstart/trace-viewer)

## 项目结构

```
SmartPerfetto/
├── perfetto/                 # Perfetto 官方 UI (Git Submodule)
│   └── ui/
│       ├── src/
│       │   └── plugins/
│       │       └── com.smartperfetto.AIAssistant/  # AI 助手插件
│       │           ├── ai_panel.ts                  # 主面板组件
│       │           ├── commands.ts                  # 命令处理
│       │           └── plugin.ts                    # 插件入口
│       ├── run-dev-server                            # 启动脚本
│       └── build.js                                  # 构建脚本
│
├── backend/                 # 后端 API 服务
│   ├── src/
│   │   ├── routes/
│   │   │   ├── traceAnalysisRoutes.ts          # 分析 API 路由
│   │   │   └── simpleTraceRoutes.ts            # Trace 上传路由
│   │   ├── services/
│   │   │   ├── traceProcessorService.ts        # Trace 处理服务
│   │   │   ├── perfettoAnalysisOrchestrator.ts # 分析编排器
│   │   │   ├── analysisSessionService.ts       # 会话管理
│   │   │   └── perfettoSqlSkill.ts             # SQL 生成技能
│   │   ├── types/
│   │   │   └── analysis.ts                     # 类型定义
│   │   └── index.ts                            # 入口文件
│   └── .env                                      # 环境变量
│
└── docs/                    # 文档
    └── plans/               # 设计文档
```

## 技术栈

### 前端 (Perfetto UI Plugin)

- **TypeScript** - 类型安全
- **Mithril.js** - Perfetto UI 使用的框架
- **SSE** - Server-Sent Events 用于实时更新

### 后端

- **Node.js + Express** - API 服务
- **TypeScript** - 类型安全
- **TraceProcessor WASM** - Perfetto Trace 处理引擎
- **OpenAI SDK** - 兼容 DeepSeek API
- **Multer** - 文件上传

### AI 服务

- **DeepSeek API** - SQL 生成和结果分析

## 环境变量

在 `backend/.env` 中配置：

```env
# API 服务
PORT=3000
NODE_ENV=development

# AI 服务配置
AI_SERVICE=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

# 文件上传配置
MAX_FILE_SIZE=500MB
UPLOAD_DIR=./uploads
```

## API 文档

### 上传 Trace

**POST** `/api/traces/upload`

Content-Type: `multipart/form-data`

| 参数 | 类型 | 说明 |
|------|------|------|
| file | File | Trace 文件 |

**响应**:
```json
{
  "success": true,
  "traceId": "uuid",
  "filename": "example.perfetto-trace",
  "size": 1234567
}
```

### 开始分析

**POST** `/api/trace-analysis/start`

Headers: `Content-Type: application/json`

| 参数 | 类型 | 说明 |
|------|------|------|
| traceId | string | Trace ID |
| question | string | 用户问题 |

**响应**: SSE 流式事件

```typescript
// 进度事件
type: 'progress'
data: {
  step: 'generating_sql' | 'executing_sql' | 'analyzing',
  message: '🤔 正在生成查询...'
}

// 分析完成
type: 'analysis_completed'
data: {
  answer: '分析结果...'
}
```

### 查询 Trace 状态

**GET** `/api/traces/:traceId`

**响应**:
```json
{
  "success": true,
  "trace": {
    "id": "uuid",
    "filename": "example.perfetto-trace",
    "status": "ready" | "uploading" | "error",
    "size": 1234567
  }
}
```

## 已完成功能

- ✅ Perfetto UI AI 助手插件
- ✅ Trace 文件上传到后端
- ✅ 基于 WASM 的 TraceProcessor 集成
- ✅ AI SQL 生成（DeepSeek）
- ✅ 多轮分析编排器
- ✅ SSE 实时进度推送
- ✅ 中文进度提示

## 待实现功能

- [ ] 更多预定义分析命令 (`/anr`, `/jank`, `/memory`)
- [ ] 分析结果的可视化增强
- [ ] 会话历史持久化
- [ ] 多 AI 模型支持
- [ ] 分析报告导出

## 开发说明

### 添加新的分析命令

编辑 `perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/commands.ts`：

```typescript
export const COMMANDS = {
  // ... 现有命令
  '/mycommand': {
    description: '我的自定义命令',
    handler: async (args, state) => {
      // 实现命令逻辑
    }
  }
};
```

### 修改 AI 分析逻辑

编辑 `backend/src/services/perfettoAnalysisOrchestrator.ts`：

```typescript
class PerfettoAnalysisOrchestrator {
  // 修改分析循环逻辑
  private async runAnalysisLoop(...) {
    // ...
  }
}
```

### 修改 AI Prompt

编辑 `backend/src/services/perfettoSqlSkill.ts`：

```typescript
private getSystemPrompt(): string {
  return `你的自定义 Prompt...`;
}
```

## 故障排除

### Perfetto UI 无法启动

```bash
# 检查端口占用
lsof -ti:10000 | xargs kill -9

# 重新构建
cd perfetto/ui
node build.js --only-wasm-memory64
```

### Backend 无法启动

```bash
# 检查环境变量
cat backend/.env

# 检查日志
tail -f /tmp/backend.log
```

### AI 分析无响应

```bash
# 检查 API 配置
curl http://localhost:3000/debug

# 查看 orchestrator 日志
grep "Orchestrator" /tmp/backend.log
```

### 构建失败

如果 Perfetto UI 构建失败：

```bash
cd perfetto/ui
# 清理并重新构建
rm -rf out/ node_modules/.cache
node build.js --only-wasm-memory64
```

## 许可证

MIT License

## 联系方式

- 项目地址: https://github.com/yourusername/smart-perfetto
- 邮箱: contact@smartperfetto.com
