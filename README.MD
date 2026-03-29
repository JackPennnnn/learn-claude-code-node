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

## 🏗️ 项目结构

```
claude-code-node/
├── src/
│   ├── index.js              # Agent 主循环（对话 → 工具调用 → 回复）
│   └── tools/
│       ├── index.js           # 工具注册表 + dispatch（统一入口）
│       ├── fs.js              # 文件读写工具
│       ├── bash.js            # Bash 命令执行工具
│       └── todo.js            # s03: TodoManager（任务计划管理）
├── data/                      # 工具写入文件的默认目录
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

## 🚀 快速开始

### 安装依赖

```bash
pnpm install
```

### 运行

```bash
node src/index.js
```

### 试试这些 Prompt

```
1. Refactor the file hello.py: add type hints, docstrings, and a main guard
2. Create a Python package with __init__.py, utils.py, and tests/test_utils.py
3. Review all Python files and fix any style issues
```

输入 `exit` 退出程序。

## ⚙️ 配置

项目使用阿里云 DashScope 兼容 API：

```javascript
const openai = new OpenAI({
    apiKey: 'your-api-key',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
});
```

模型：`qwen3.5-flash`

如需更换模型或 API 服务商，修改 `src/index.js` 中的配置即可。

## 📚 学习路线

本项目跟随 [Learn Claude Code](https://learn.shareai.run/zh/) 课程逐步推进：

- **s01** Agent 循环 — 理解 LLM 如何在循环中持续思考
- **s02** 工具系统 — 给 Agent 装上"手和脚"
- **s03** TodoWrite — 让 Agent 先计划再动手（本阶段）
- **s04** 子 Agent — 任务分解与委托
- **s05** 技能系统 — 可复用的能力模块
- **s06** 上下文压缩 — 解决上下文窗口溢出
- ...

## 📝 License

ISC
