import OpenAI from "openai";
// 从 .env 文件中加载环境变量（API Key 等敏感信息不硬编码在代码里）
import 'dotenv/config';
import process from 'process';
// 【s04 修改】引入 parentTools 替代原来的 tools
// parentTools = childTools（基础工具） + task 工具（派发子任务）
// 【s05 新增】引入 skillLoader 获取技能描述列表
import { parentTools, executeTool, skillLoader } from './tools/index.js';
import {
    createCompactState,
    maybeCompactMessages,
    persistLargeOutput,
    consumeManualCompactRequest,
    noteToolUsage
} from './context/compact.js';
// 【s07 新增】共享 readline 单例 —— 主循环和权限系统都从这里拿
// 不再在主循环本地 createInterface，避免和权限弹窗抢 stdin
import { rl } from './io/rl.js';
// 【s07 新增】权限系统入口
//   gatekeep      —— 工具执行前的门禁
//   getMode/setMode/describeState —— 支撑 /mode、/perm 斜杠命令
import { gatekeep, getMode, setMode, describeState } from './permissions/index.js';
// 【s08 新增】Hook 系统入口
//   runHooks(eventName, payload) —— 在固定时机派发扩展行为
//   主循环只暴露 3 个时机：SessionStart / PreToolUse / PostToolUse
//   import 时会自动注册内置示范 handler（欢迎信息 + 审计日志）
import { runHooks } from './hooks/index.js';
// 【s09 新增】记忆系统入口
//   loadMemorySection —— 把 .memory/ 下所有跨会话信息拼成 system prompt 末段
//   setIgnoreMemory   —— 用户说"忽略 memory"时切换为空，按 memory 不存在工作
//   describeMemoryState / listMemories —— /memory 斜杠命令用
import {
    loadMemorySection,
    setIgnoreMemory,
    isMemoryIgnored,
    describeMemoryState,
    listMemories
} from './memory/index.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
});
const MODEL = 'qwen3.5-flash';

async function main() {
    // 【s09 重构】把 system prompt 拆成 baseSystemPrompt（不变） + memory section（可切换）
    //   原因：用户随时可能输入 /memory ignore 让本会话不参考 memory，
    //   这意味着 messages[0].content 必须能在运行时重组。
    //   把"基底"和"动态部分"分开存储，rebuildSystemPrompt 直接拼回去即可。
    const baseSystemPrompt = `你是一个专业的编程助手，可以使用工具来完成任务。
Use the todo tool to plan multi-step tasks.
Mark tasks as in_progress before starting, and completed when done.
Only one task can be in_progress at a time.
Prefer using tools over writing prose.
Use the task tool to delegate subtasks that would benefit from a clean context.
The task tool spawns a subagent that has its own fresh message history.
Delegate work like reading multiple files, running commands, or any exploratory task.

记忆系统 (s09):
- 跨会话有用、且不能从代码直接重新看出来的信息，可以调用 save_memory 保存。
- 当前任务进度、文件路径、函数签名等可重新观察的内容，不要写进 memory。
- memory 里的信息可能已过时；如与当前观察冲突，优先相信当前观察。

可用技能 (使用 load_skill 加载详细指令):
${skillLoader.getDescriptions()}`;

    // 【s09 新增】会话起手把 memory section 拼到 system prompt 末尾
    //   loadMemorySection 在 ignore 状态下会返回空字符串
    //   这样 ignore 切换只需要重新调用 composeSystemPrompt + 改写 messages[0]
    const composeSystemPrompt = () => baseSystemPrompt + loadMemorySection();

    let messages = [
        { role: 'system', content: composeSystemPrompt() }
    ];

    // 【s09】给 /memory 命令用的小工具：原地刷新 system prompt
    //   只动 messages[0]，其他历史保留；模型在下一轮就能感知变化。
    const rebuildSystemPrompt = () => {
        messages[0] = { role: 'system', content: composeSystemPrompt() };
    };

    const compactState = createCompactState();

    // 【s08 新增】会话起手就触发一次 SessionStart hook
    // 内置 handler 会打印欢迎信息 + 当前权限模式
    // 用户可以通过 register('SessionStart', ...) 追加自己的开场行为
    await runHooks('SessionStart', { mode: getMode() });

    // 【s03 新增】跟踪模型连续多少轮没有调用 todo 工具
    // 这个计数器是 nag reminder 机制的基础
    let roundsSinceTodo = 0;

    while (true) {
        try {
            const userInput = await rl.question(`\n👤 你 [${getMode()}]: `);
            if (userInput.toLowerCase() === 'exit') break;

            // 【s07 新增】斜杠命令 —— 不进入对话历史，仅本地处理
            //   /mode <name>  切换权限模式（default / plan / auto）
            //   /perm         打印当前权限状态
            // 这两个命令是给"用户"用的，不是给模型用的，所以不会污染 messages
            if (userInput.startsWith('/')) {
                const [cmd, ...rest] = userInput.trim().split(/\s+/);
                if (cmd === '/mode') {
                    const target = rest[0];
                    if (!target) {
                        console.log(`当前模式: ${getMode()}（用法: /mode default|plan|auto）`);
                    } else if (setMode(target)) {
                        console.log(`✅ 已切换到 ${target} 模式`);
                    } else {
                        console.log(`❌ 未知模式: ${target}（可选: default / plan / auto）`);
                    }
                    continue;
                }
                if (cmd === '/perm') {
                    console.log(describeState());
                    continue;
                }
                // 【s09 新增】/memory 命令族 —— 查看状态 / 列表 / 临时忽略
                //
                // 设计原则：
                //   - 命令本身不进 messages，避免污染对话历史
                //   - ignore/use 切换后立即重组 system prompt，下一轮就生效
                //   - 故意不提供 /memory save——save 是模型的工作，不是用户在终端里手敲的
                if (cmd === '/memory') {
                    const sub = rest[0];
                    if (!sub) {
                        console.log(await describeMemoryState());
                    } else if (sub === 'list') {
                        const items = await listMemories({ scope: rest[1] });
                        if (items.length === 0) {
                            console.log('(no memories)');
                        } else {
                            for (const m of items) {
                                console.log(`  [${m.scope}/${m.type}] ${m.name}: ${m.description}`);
                            }
                        }
                    } else if (sub === 'ignore') {
                        setIgnoreMemory(true);
                        rebuildSystemPrompt();
                        console.log('🙈 已忽略 memory（本会话内）。下一轮 system prompt 将不再包含 memory section。');
                    } else if (sub === 'use') {
                        setIgnoreMemory(false);
                        rebuildSystemPrompt();
                        console.log(`🧠 已重新启用 memory（当前 ignore=${isMemoryIgnored() ? 'on' : 'off'}）。`);
                    } else {
                        console.log('用法: /memory          查看状态');
                        console.log('      /memory list   列出所有 memory（可选 private|team）');
                        console.log('      /memory ignore 本会话忽略 memory');
                        console.log('      /memory use    重新启用 memory');
                    }
                    continue;
                }
                console.log(`未知命令: ${cmd}（支持 /mode、/perm、/memory）`);
                continue;
            }

            // 【核心修改 2】将用户新输入的内容追加到历史中
            messages.push({ role: 'user', content: userInput });

            let isThinking = true;
            while (isThinking) {
                // 【s06 新增】在每次调用模型前统一做上下文预算管理
                // 这里会依次执行：
                //   1. 微压缩旧工具结果
                //   2. 估算当前上下文大小
                //   3. 如有必要，生成连续性摘要
                // 手动 compact 和自动超阈值压缩都走同一入口，避免两套逻辑分叉。
                messages = await maybeCompactMessages({
                    messages,
                    compactState,
                    openai,
                    model: MODEL,
                    force: consumeManualCompactRequest()
                });

                const response = await openai.chat.completions.create({
                    model: MODEL,
                    messages: messages, // 发送完整的历史记录
                    enable_thinking: true,
                    // 【s04 修改】使用 parentTools 替代原来的 tools
                    // parentTools 包含所有基础工具 + task 工具
                    tools: parentTools
                });

                const assistantOutput = response.choices[0].message;

                // 某些模型在 tool_calls 时 content 为 null，需要处理
                if (assistantOutput.content === null) assistantOutput.content = "";

                // 【核心修改 3】必须把大模型的回复（包括它想调用工具的意图）存入历史
                messages.push(assistantOutput);

                if (!assistantOutput.tool_calls) {
                    // 模型给出了最终回答，不再需要工具
                    console.log(`🤖: ${assistantOutput.content}`);
                    isThinking = false;
                } else {
                    // 模型想要调用工具
                    // 【s03 新增】跟踪本轮是否调用了 todo 工具
                    let usedTodo = false;

                    for (const toolCall of assistantOutput.tool_calls) {
                        const toolName = toolCall.function.name;
                        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                        noteToolUsage(compactState, toolName, toolArgs);

                        // 【s07 关键改动】工具执行前先过权限管道
                        //   gatekeep 内部按顺序走：deny rules → mode → bash safety → allow rules → ask
                        //   如果决策是 deny，跳过 executeTool，但仍然要塞一条 tool 消息回去——
                        //   否则模型下一轮会因为 tool_call 缺少匹配的 tool_result 而报错。
                        const decision = await gatekeep(toolName, toolArgs, { interactive: true });
                        let toolResultText;
                        if (decision.behavior === 'deny') {
                            toolResultText = `Permission denied: ${decision.reason}`;
                            console.log(`   ⛔ ${toolResultText}`);
                        } else {
                            // 【s08 关键改动】权限放行后，再过一道 PreToolUse hook
                            //   设计取舍：gatekeep 是"硬规则"，hook 是"侧车扩展"
                            //   被 deny 的调用根本不会触发 hook，避免双层语义打架
                            //
                            //   退出码语义（教学版统一约定）：
                            //     0 → 正常继续
                            //     1 → 阻止执行；把 message 作为 tool_result 写回
                            //     2 → 注入一条 user 消息后继续执行
                            const pre = await runHooks('PreToolUse', {
                                tool_name: toolName,
                                input: toolArgs
                            });

                            if (pre.exit_code === 1) {
                                toolResultText = `Hook blocked: ${pre.message || '(no reason)'}`;
                                console.log(`   🪝 ${toolResultText}`);
                            } else {
                                if (pre.exit_code === 2 && pre.message) {
                                    // 把 hook 的补充说明作为 user 消息插入，让模型看到
                                    // 用 <hook> 标签包裹，区别于真正的用户输入
                                    messages.push({
                                        role: 'user',
                                        content: `<hook>${pre.message}</hook>`
                                    });
                                    console.log(`   🪝 PreToolUse 注入提示: ${pre.message}`);
                                }

                                console.log(`🛠️ 执行工具: ${toolName}...`);
                                toolResultText = await executeTool(toolName, toolArgs);
                                console.log(`   ↪ ${String(toolResultText).substring(0, 500)}`);

                                // 【s08】工具执行完毕后触发 PostToolUse hook
                                //   - 内置 handler 会写一行审计日志
                                //   - 如果 handler 返回 exit_code=2，把补充说明追加到 tool_result 末尾
                                //   - 不会把 PostToolUse 的副作用直接塞回 messages，保持"观察用"语义
                                const post = await runHooks('PostToolUse', {
                                    tool_name: toolName,
                                    input: toolArgs,
                                    output: toolResultText
                                });
                                if (post.exit_code === 2 && post.message) {
                                    toolResultText = `${toolResultText}\n\n[hook] ${post.message}`;
                                    console.log(`   🪝 PostToolUse 追加说明: ${post.message}`);
                                }
                            }
                        }

                        // 【s06 新增】大工具结果不再直接整段塞进 messages
                        // 如果内容太大，会先完整落盘，然后只把结构化预览放回上下文。
                        const compactedToolResult = await persistLargeOutput(toolName, toolCall.id, toolResultText);

                        // 【核心修改 4】极其重要！必须把工具执行的结果追加到 messages
                        // 这样下一轮循环时，模型才能看到结果并给出最终回复
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: compactedToolResult
                        });

                        // 【s03】检测是否调用了 todo 工具
                        // 注意：被 deny 的调用不算"成功更新过 todo"，所以放在分支判断里
                        if (toolName === 'todo' && decision.behavior !== 'deny') {
                            usedTodo = true;
                        }
                    }

                    // 【s03 新增】更新 nag 计数器
                    // 如果本轮调用了 todo，归零；否则 +1
                    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

                    // 【s03 新增】Nag Reminder 机制
                    // 如果模型连续 3 轮以上没有更新 todo，在下一轮开头注入提醒
                    // 这制造了“问责压力”——你不更新计划，系统就追着你问
                    if (roundsSinceTodo >= 3) {
                        console.log('📢 提醒模型更新 todo...');
                        // 向 messages 中插入一条 user 角色的提醒消息
                        // 用 <reminder> 标签包裹，让模型知道这是系统提醒而不是用户说的话
                        messages.push({
                            role: 'user',
                            content: '<reminder>Update your todos. Mark completed tasks and set the next task to in_progress.</reminder>'
                        });
                    }

                    // 注意：这里不要 break！继续 while(isThinking) 循环，
                    // 让模型根据刚刚存入 messages 的工具结果进行下一步思考。
                }
            }
        } catch (error) {
            console.error('Error:', error);
        }
    }
    rl.close();
}

main();