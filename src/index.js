import OpenAI from "openai";
// 从 .env 文件中加载环境变量（API Key 等敏感信息不硬编码在代码里）
import 'dotenv/config';
import process from 'process';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
// 【s04 修改】引入 parentTools 替代原来的 tools
// parentTools = childTools（基础工具） + task 工具（派发子任务）
// 【s05 新增】引入 skillLoader 获取技能描述列表
import { parentTools, executeTool, skillLoader } from './tools/index.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
});

const rl = readline.createInterface({ input, output });

async function main() {
    // 【核心修改 1】messages 放在循环外，作为整个会话的历史记录
    // 【s03 修改】系统提示中告诉模型使用 todo 工具来规划多步任务
    // 【s04 修改】系统提示中增加 task 工具的使用说明
    const messages = [
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

    // 【s03 新增】跟踪模型连续多少轮没有调用 todo 工具
    // 这个计数器是 nag reminder 机制的基础
    let roundsSinceTodo = 0;

    while (true) {
        try {
            const userInput = await rl.question('\n👤 你: ');
            if (userInput.toLowerCase() === 'exit') break;

            // 【核心修改 2】将用户新输入的内容追加到历史中
            messages.push({ role: 'user', content: userInput });

            let isThinking = true;
            while (isThinking) {
                const response = await openai.chat.completions.create({
                    model: 'qwen3.5-flash',
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

                        console.log(`🛠️ 执行工具: ${toolName}...`);
                        const result = await executeTool(toolName, toolArgs);
                        // 把工具执行的结果打印出来，这样你能在控制台看到 todo 的渲染清单
                        console.log(`   ↪ ${String(result).substring(0, 500)}`);

                        // 【核心修改 4】极其重要！必须把工具执行的结果追加到 messages
                        // 这样下一轮循环时，模型才能看到结果并给出最终回复
                        messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: String(result)
                        });

                        // 【s03】检测是否调用了 todo 工具
                        if (toolName === 'todo') {
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