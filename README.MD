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
| s05 | 技能系统 | 按需加载 (Load on Demand) + UTF-8 中文规范 | ✅ 已完成 |
| s06 | 上下文压缩 | Persisted Output + Micro Compact + Summary Compact | ✅ 已完成 |
| s07 | 权限系统 | deny/mode/bash-safety/allow/ask 五段管道 + 三种模式 | ✅ 已完成 |

## 🏗️ 项目结构

```
claude-code-node/
├── src/
│   ├── index.js              # Agent 主循环（对话 → 权限门禁 → 工具调用 → 回复）
│   ├── io/
│   │   └── rl.js              # s07: 共享 readline 单例（主循环和权限弹窗复用同一个 stdin）
│   ├── permissions/           # s07: 权限系统
│   │   ├── index.js           #   核心管道：checkPermission / gatekeep / setMode 等
│   │   └── bash-safety.js     #   bash 最小安全检查（sudo / rm -rf / 命令替换…）
│   ├── context/
│   │   └── compact.js         # s06: 上下文压缩
│   └── tools/
│       ├── index.js           # 工具注册表 + 分层（childTools / parentTools）
│       ├── fs.js              # 文件读写工具
│       ├── bash.js            # Bash 命令执行工具
│       ├── todo.js            # s03: TodoManager（任务计划管理）
│       ├── skill-loader.js    # s05: 技能按需加载
│       └── subagent.js        # s04: 子智能体（独立上下文执行子任务）
├── skills/                    # s05: 技能定义目录
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

### 技能系统 (s05)

解决 System Prompt 臃肿问题——“用到什么知识，临时加载什么知识”。

```
第一层：System Prompt (低成本)
列出技能名称和描述。

第二层：load_skill 工具 (按需加载)
模型调用工具，在 tool_result 中注入完整的详细指令。
```

**UTF-8 规范**：本项目所有技能均要求生成 **中文** Commit 信息，并强制使用 **UTF-8** 编码，确保在 GitHub 上不出现乱码。

### 上下文压缩 (s06)

解决长会话里的“上下文膨胀”问题。目标不是删除历史，而是在更短的活跃上下文里保住连续性。

```
第 1 层：大结果不直接塞进上下文
  -> 保存到 data/context-outputs/，只保留预览

第 2 层：旧工具结果不一直原样保留
  -> 只保留最近 3 个 tool result 的完整内容

第 3 层：整体历史过长时
  -> 生成连续性摘要，再配合最近几轮消息继续工作
```

**当前实现包含：**

1. **Persisted Output** — 工具返回内容超过阈值时，全文写入 `data/context-outputs/`，`messages` 中只留 `<persisted-output>` 标记和预览。
2. **Micro Compact** — 更早的 tool result 会被替换成占位文本，防止旧结果长期霸占窗口。
3. **Summary Compact** — 当 `messages` 继续膨胀时，会自动生成一份包含“目标 / 已完成 / 文件 / 约束 / 下一步”的连续性摘要。
4. **手动 compact** — 模型也可以主动调用 `compact` 工具，和自动压缩复用同一条逻辑。

### 权限系统 (s07)

到 s06 为止 Agent 已经能"动手"了，但模型的"意图"不应该直接变成"执行"——
中间必须先过一道权限管道。s07 给项目加上的就是这条管道。

**核心理念（一句话）：任何工具调用都不能直接落到 handler，必须先经过 `gatekeep()`。**

```
LLM 决定调用工具
       │
       ▼
┌─────────────────────────┐
│ 1. deny rules           │ ── 命中 ──┐
├─────────────────────────┤           │
│ 2. mode policy          │ ── 命中 ──┤
│   plan → 阻所有写工具    │           │
│   auto → 放所有只读工具  │           │
├─────────────────────────┤           │
│ 3. bash safety          │ ── 命中 ──┤───►  deny + 把拒绝原因写回 tool_result
│   sudo / rm -rf / $()…  │           │       （仍然要塞 tool 消息，否则模型会报错）
├─────────────────────────┤           │
│ 4. allow rules          │ ── 命中 ──┐
├─────────────────────────┤           │
│ 5. ask user [y/N]       │ ─ y ──────┤───►  allow + 真正调用 executeTool
└─────────────────────────┘ ─ n ──────┘
```

**三种权限模式：**

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `default` | 未命中规则时弹 [y/N] 询问用户 | 日常交互（默认） |
| `plan` | 所有写入/副作用类工具一律拒绝 | 计划、审查、分析 |
| `auto` | 只读工具自动放行，写入工具仍要问 | 高流畅度的探索阶段 |

**两类规则（`PermissionRule`）：**

```js
// deny 优先于 allow，命中即拒绝
{ tool: 'execute_bash', content: 'sudo *',  behavior: 'deny' }
{ tool: 'execute_bash', content: 'rm -rf *', behavior: 'deny' }
{ tool: 'read_file',                         behavior: 'allow' }
```

`content` 是一个简单 glob，`*` 翻译成 `.*` 后整串匹配 `command` 或 `content` 字段。

**Bash 为什么要单独一层？**
`read_file` 顶多读错文件，`execute_bash` 可以做任何事。所以 s07 把 bash 当成"可执行动作描述"
而不是普通文本，单独走一层最小安全检查（[`src/permissions/bash-safety.js`](src/permissions/bash-safety.js)）：
拦截 `sudo`、`rm -rf`、命令替换 `` $() ``/反引号、向块设备写入、fork bomb 等明显危险。

**斜杠命令（在 `👤 你 [mode]:` 提示符后输入）：**

| 命令 | 说明 |
|------|------|
| `/mode default` | 切回默认模式（未命中规则时问用户） |
| `/mode plan` | 切到只读模式（写入工具一律拒绝） |
| `/mode auto` | 切到自动模式（只读工具自动放行） |
| `/mode` | 不带参数：仅打印当前模式 |
| `/perm` | 打印当前权限状态：模式、连续被拒次数、规则数量 |

斜杠命令不会进入 `messages`，不会污染对话历史。

**几个容易踩坑的点：**

1. **被 deny 也要塞 tool_result。** 如果 `tool_call` 没有匹配的 `tool` 消息，下一轮请求会直接 400。
   主循环里被拒时会推 `Permission denied: ...` 作为 tool result，让模型知道"我刚才的尝试被挡了"。
2. **子 Agent 共享同一套权限管道。** 不会出现"父 Agent 被挡，子 Agent 偷偷绕过"的破窗。
3. **连续被拒计数。** 累计 ≥3 次会在控制台打印提示，建议你切到 `plan` 模式或重新明确目标。
4. **deny 一定先于 allow / mode。** 这样像 `sudo` 这种命令在任何模式下都不会被放过。

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

**上下文压缩测试（s06）：**
```
先运行一条会产生很长输出的 bash 命令，再继续总结结果
如果你觉得上下文已经很乱，请主动调用 compact 工具
```

**权限系统测试（s07）：**
```
# 先把模式切到只读，再让模型尝试写文件，应当被 plan 模式拒绝
/mode plan
帮我创建一个 hello.txt，内容随便写

# 切到 default，让模型执行一条危险命令，应当被 deny rule 拒绝
/mode default
帮我跑一下 sudo rm -rf /tmp/test

# 查看当前权限状态
/perm
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
- **s04** 子 Agent — 任务委派与上下文隔离
- **s05** 技能系统 — 可复用的能力模块
- **s06** 上下文压缩 — 解决上下文窗口溢出
- **s07** 权限系统 — 在工具执行前过一道安全闸门（✅ 当前阶段）
- ...

## 📝 License

ISC
