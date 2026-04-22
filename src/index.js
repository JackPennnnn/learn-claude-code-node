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

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
});
const MODEL = 'qwen3.5-flash';

async function main() {
    // 【核心修改 1】messages 放在循环外，作为整个会话的历史记录
    // 【s03 修改】系统提示中告诉模型使用 todo 工具来规划多步任务
    // 【s04 修改】系统提示中增加 task 工具的使用说明
    let messages = [
        {
            role: 'system',
            content: `你是一个专业的编程助手，可以使用工具来完成任务。
Use the todo tool to plan multi-step tasks.
Mark tasks as in_progress before starting, and completed when done.
Only one task can be in_progress at a time.
Prefer using tools over writing prose.
Use the task tool to delegate subtasks that would benefit from a clean context.
The task tool spawns a subagent that has its own fresh message history.
Delegate work like reading multiple files, running commands, or any exploratory task.

可用技能 (使用 load_skill 加载详细指令):
${skillLoader.getDescriptions()}`
        }
    ];
    const compactState = createCompactState();

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
                console.log(`未知命令: ${cmd}（支持 /mode、/perm）`);
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
                            console.log(`🛠️ 执行工具: ${toolName}...`);
                            toolResultText = await executeTool(toolName, toolArgs);
                            // 把工具执行的结果打印出来，这样你能在控制台看到 todo 的渲染清单
                            console.log(`   ↪ ${String(toolResultText).substring(0, 500)}`);
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