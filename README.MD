# Claude Code Node

> 用 Node.js 从零复刻 Claude Code 的核心架构，逐步理解 AI Agent 的设计原理。  
> 学习路线参考：[Learn Claude Code](https://learn.shareai.run/zh/)

## 📖 项目简介

本项目是 [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)（Python 版）的 **Node.js 实现**，通过逐步构建一个 AI 编程助手，学习 Agent 架构中的关键设计模式。

当前已完成的阶段：

| 阶段 | 名称 | 核心概念 | 状态 |
|------|------|---------|------|
| s01 | Agent 循环 | 多轮对话 + 工具调用循环 | ✅ 已完成 |
| s02 | 工具系统 | read_file / write_file / execute_bash | ✅ 已完成 |
| s03 | TodoWrite | TodoManager + Nag Reminder | ✅ 已完成 |
| s04 | 子 Agent | Sub Agent 上下文隔离 + 任务委派 | ✅ 已完成 |

## 🏗️ 项目结构

```
claude-code-node/
├── src/
│   ├── index.js              # Agent 主循环（对话 → 工具调用 → 回复）
│   └── tools/
│       ├── index.js           # 工具注册表 + 分层（childTools / parentTools）
│       ├── fs.js              # 文件读写工具
│       ├── bash.js            # Bash 命令执行工具
│       ├── todo.js            # s03: TodoManager（任务计划管理）
│       └── subagent.js        # s04: 子智能体（独立上下文执行子任务）
├── data/                      # 工具写入文件的默认目录
├── .env                       # 环境变量（API Key，不上传到 GitHub）
├── .gitignore
├── package.json
└── README.MD
```

## 🧠 核心架构

### Agent 循环 (s01)

```
用户输入 → LLM 思考 → 调用工具 → 工具结果回传 → LLM 继续思考 → ... → 最终回复
```

整个对话历史存储在 `messages` 数组中，每一轮都包含用户输入、模型回复、工具调用结果，形成完整的上下文链。

### 工具系统 (s02)

| 工具名 | 功能 |
|--------|------|
| `write_file` | 将内容写入 `data/` 目录下的文件 |
| `read_file` | 读取 `data/` 目录下的文件内容 |
| `execute_bash` | 执行 shell 命令 |

### TodoWrite (s03)

解决多步任务中模型"丢失进度"的问题：

```
+----------+      +-------+      +---------+
|   User   | ---> |  LLM  | ---> | Tools   |
|  prompt  |      |       |      | + todo  |
+----------+      +---+---+      +----+----+
                      ^               |
                      |   tool_result |
                      +---------------+
                            |
                +-----------+-----------+
                | TodoManager state     |
                | [ ] task A            |
                | [>] task B <- doing   |
                | [x] task C            |
                +-----------------------+
                            |
                if roundsSinceTodo >= 3:
                  inject <reminder>
```

**三个关键机制：**

1. **TodoManager** — 模型通过 `todo` 工具管理自己的任务清单，每次全量提交
2. **单 in_progress 约束** — 同一时间只能有一个任务处于进行中，强制顺序聚焦
3. **Nag Reminder** — 连续 3 轮不调用 todo → 自动注入 `<reminder>` 提醒，制造问责压力

### 子 Agent (s04)

解决上下文污染问题——Agent 工作越久，`messages[]` 越胖，中间过程全留在上下文里浪费 token。

```
┌──────────────────┐       ┌──────────────────┐
│   Parent Agent   │       │    Sub Agent     │
│  messages=[...]  │       │  messages=[]     │ ← 全新的上下文
│                  │       │                  │
│  tool: task      │──────>│  Agent 循环      │
│  prompt="..."    │       │   call tools     │
│                  │       │   ...N 轮...     │
│  result = "摘要"  │<──────│  return summary  │
└──────────────────┘       └──────────────────┘
  父上下文保持干净            子上下文用完即弃
```

**核心设计：**

1. **工具分层** — `childTools`（基础工具）+ `parentTools`（基础 + task），子 Agent 没有 task 工具，防止无限递归
2. **上下文隔离** — 子 Agent 使用独立的 `messages=[]`，完成后整个历史被丢弃
3. **只返回摘要** — 子 Agent 可能跑了 30+ 轮工具调用，但父 Agent 只收到一段简洁的文本摘要
4. **安全限制** — 子 Agent 最多运行 30 轮，防止无限循环

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/你的用户名/claude-code-node.git
cd claude-code-node
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

复制 `.env.example` 创建 `.env` 文件，填入你的 API Key：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 大模型 API 配置
OPENAI_API_KEY=你的API密钥
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

> **⚠️ 注意**：`.env` 文件已加入 `.gitignore`，不会被上传到 GitHub，你的 API Key 是安全的。

### 4. 运行项目

```bash
node src/index.js
```

输入 `exit` 退出程序。

### 5. 试试这些 Prompt

**基础工具测试：**
```
帮我创建一个 hello.js 文件，内容是 console.log('Hello World')
```

**TodoWrite 测试（s03）：**
```
Create a Python package with __init__.py, utils.py, and tests/test_utils.py
```

**子 Agent 测试（s04）：**
```
Use a subtask to find what files are in this project
Delegate: read all .js files and summarize what each one does
Use a task to create a new module, then verify it from here
```

## ⚙️ 配置说明

### API 配置

项目通过 `.env` 文件管理 API 配置（使用 [dotenv](https://www.npmjs.com/package/dotenv) 加载）：

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `OPENAI_API_KEY` | 大模型 API 密钥 | `sk-xxx` |
| `OPENAI_BASE_URL` | API 端点地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

当前使用的模型：`qwen3.5-flash`

如需更换模型，修改 `src/index.js` 和 `src/tools/subagent.js` 中的 `model` 字段。

### 依赖说明

| 依赖 | 用途 |
|------|------|
| `openai` | OpenAI 兼容 API 客户端 |
| `dotenv` | 从 `.env` 文件加载环境变量 |

## 📚 学习路线

本项目跟随 [Learn Claude Code](https://learn.shareai.run/zh/) 课程逐步推进：

- **s01** Agent 循环 — 理解 LLM 如何在循环中持续思考
- **s02** 工具系统 — 给 Agent 装上"手和脚"
- **s03** TodoWrite — 让 Agent 先计划再动手
- **s04** 子 Agent — 任务委派与上下文隔离（✅ 当前阶段）
- **s05** 技能系统 — 可复用的能力模块
- **s06** 上下文压缩 — 解决上下文窗口溢出
- ...

## 📝 License

ISC
