/**
 * SubAgent（子智能体）— s04 的核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 解决的问题：
 *   Agent 工作越久，messages[] 越来越胖。
 *   比如用户问"这个项目用什么测试框架？"，Agent 可能要读 5 个文件，
 *   但父 Agent 只需要一个词："jest"。
 *   那些中间的文件内容全都永久留在上下文里，既浪费 token 又分散注意力。
 *
 * 解决思路：
 *   "大任务拆小，每个小任务用干净的上下文"
 *   子智能体用独立的 messages[]，运行完毕后整个历史被丢弃，
 *   父 Agent 只收到最终的摘要文本。
 *
 * 架构图：
 *   ┌──────────────┐       ┌──────────────┐
 *   │ Parent Agent │       │  Sub Agent   │
 *   │ messages=[…] │       │ messages=[]  │ ← 全新上下文
 *   │              │       │              │
 *   │ tool: task   │──────→│ Agent 循环   │
 *   │ prompt="…"   │       │  call tools  │
 *   │              │       │  …N 轮…      │
 *   │ result="摘要" │←──────│ return text  │
 *   └──────────────┘       └──────────────┘
 *   父上下文不变             子上下文丢弃
 * ═══════════════════════════════════════════════════════════════
 */

import OpenAI from 'openai';
import 'dotenv/config';
import { childTools, executeTool } from './index.js';
import { persistLargeOutput } from '../context/compact.js';
// 【s07 新增】子 Agent 同样要走权限管道
// 这样设计的好处：父子两层 Agent 共享同一套规则、同一个连续被拒计数器，
// 不会出现"父 Agent 被挡掉，子 Agent 偷偷绕过"的破窗
import { gatekeep } from '../permissions/index.js';
// 【s08 新增】子 Agent 也共享同一套 Hook
// 父子 Agent 复用同一个 HookRunner，意味着任何注册的 PreToolUse / PostToolUse
// 在子 Agent 内部一样会触发（比如审计日志会把子 Agent 的工具调用也记下来）
// 注意：子 Agent 不触发 SessionStart —— 它不是新会话，只是父会话的一段子任务
import { runHooks } from '../hooks/index.js';

// 复用同一个 OpenAI 客户端配置
// 注意：这里和主 index.js 用的是同一套 API 配置
// 子 Agent 复用和父 Agent 相同的 API 配置
// 从环境变量中读取，不硬编码敏感信息
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
});
const MODEL = 'qwen3.5-flash';

/**
 * 子智能体的系统提示
 *
 * 为什么单独定义？
 *   子智能体的角色和父智能体不同：
 *   - 父智能体负责"决策和分配"
 *   - 子智能体负责"执行和汇报"
 *   所以子智能体的 system prompt 强调：完成任务后要给出简洁摘要
 */
const SUBAGENT_SYSTEM = `你是一个专业的编程助手，正在执行一个被委派的子任务。
你可以使用工具来完成任务。
完成后，请给出简洁的摘要回复。
Prefer using tools over writing prose.
Be thorough but concise in your final summary.`;

/**
 * 运行子智能体
 *
 * 这是 s04 的核心函数。它接收一个 prompt，启动一个完全独立的 Agent 循环，
 * 运行完毕后只返回最终的文本摘要。
 *
 * 关键设计：
 *   1. 独立的 subMessages[] —— 不会污染父 Agent 的 messages
 *   2. 使用 childTools —— 不包含 task 工具，防止递归嵌套
 *   3. 安全限制 30 轮 —— 防止子 Agent 无限循环
 *   4. 只返回最终文本 —— 中间过程全部丢弃
 *
 * @param {string} prompt - 分配给子智能体的任务描述
 * @returns {Promise<string>} 子智能体的最终摘要文本
 */
export async function runSubAgent(prompt) {
    console.log(`\n🚀 [Sub Agent] 启动子智能体...`);
    console.log(`📋 [Sub Agent] 任务: ${prompt.substring(0, 100)}...`);

    // ═══════════════════════════════════════════════════════════
    // 【核心】独立的消息历史 —— 这就是"干净上下文"的关键
    // 子 Agent 的 messages 和父 Agent 完全隔离，
    // 无论子 Agent 内部执行了多少轮工具调用，
    // 这些中间过程都不会出现在父 Agent 的上下文中。
    // ═══════════════════════════════════════════════════════════
    const subMessages = [
        { role: 'system', content: SUBAGENT_SYSTEM },
        { role: 'user', content: prompt }
    ];

    // 子 Agent 最终的回复文本，默认为"无摘要"
    let finalText = '(no summary)';

    // 安全限制：最多循环 30 轮
    // 为什么是 30？这是一个经验值——
    // 大多数子任务在 5-10 轮内就能完成，30 是一个宽裕的上限
    const MAX_ROUNDS = 30;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        console.log(`   🔄 [Sub Agent] 第 ${round + 1} 轮...`);

        // 调用大模型，注意这里用的是 childTools 而不是 parentTools
        // 这意味着子 Agent 不能再调用 task 工具，防止无限递归
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: subMessages,
            tools: childTools.length > 0 ? childTools : undefined,
            enable_thinking: true,
        });

        const assistantOutput = response.choices[0].message;

        // 处理 content 为 null 的情况（某些模型在 tool_calls 时会这样）
        if (assistantOutput.content === null) assistantOutput.content = '';

        // 把助手回复加入子 Agent 自己的消息历史
        subMessages.push(assistantOutput);

        if (!assistantOutput.tool_calls) {
            // ═══════════════════════════════════════════════════════
            // 【终止条件】模型不再需要工具，给出了最终回答
            // 这就是子 Agent 要返回给父 Agent 的摘要
            // ═══════════════════════════════════════════════════════
            finalText = assistantOutput.content || '(no summary)';
            console.log(`   ✅ [Sub Agent] 完成! (共 ${round + 1} 轮)`);
            break;
        }

        // 模型想要调用工具 —— 和主循环的逻辑一样
        for (const toolCall of assistantOutput.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

            // 【s07 新增】子 Agent 也必须先过权限管道
            //   - interactive: true 表示遇到 ask 时弹窗给用户（与父 Agent 行为一致）
            //   - 被 deny 时不调 executeTool，把拒绝原因作为 tool result 返回，
            //     让子 Agent 自己换方案，而不是死循环重试同一个被拒命令
            const decision = await gatekeep(toolName, toolArgs, { interactive: true });
            let result;
            if (decision.behavior === 'deny') {
                result = `Permission denied: ${decision.reason}`;
                console.log(`   ⛔ [Sub Agent] ${result}`);
            } else {
                // 【s08 新增】权限放行后再过一道 PreToolUse hook
                // 与父 Agent 完全相同的语义：0=继续 / 1=阻止 / 2=注入提示后继续
                const pre = await runHooks('PreToolUse', {
                    tool_name: toolName,
                    input: toolArgs
                });

                if (pre.exit_code === 1) {
                    result = `Hook blocked: ${pre.message || '(no reason)'}`;
                    console.log(`   🪝 [Sub Agent] ${result}`);
                } else {
                    if (pre.exit_code === 2 && pre.message) {
                        // 子 Agent 的 hook 注入也走自己的 subMessages
                        // 不会污染父 Agent 的上下文（这正是 s04 的初衷）
                        subMessages.push({
                            role: 'user',
                            content: `<hook>${pre.message}</hook>`
                        });
                        console.log(`   🪝 [Sub Agent] PreToolUse 注入: ${pre.message}`);
                    }

                    console.log(`   🛠️ [Sub Agent] 执行工具: ${toolName}...`);
                    try {
                        result = await executeTool(toolName, toolArgs);
                    } catch (err) {
                        // 工具执行出错时，把错误信息作为结果返回给子 Agent
                        // 这样子 Agent 可以尝试修复或给出错误报告
                        result = `工具执行出错: ${err.message}`;
                    }

                    // 【s08】PostToolUse —— 子 Agent 的工具调用也会被审计 handler 记录
                    const post = await runHooks('PostToolUse', {
                        tool_name: toolName,
                        input: toolArgs,
                        output: result
                    });
                    if (post.exit_code === 2 && post.message) {
                        result = `${result}\n\n[hook] ${post.message}`;
                        console.log(`   🪝 [Sub Agent] PostToolUse 追加: ${post.message}`);
                    }
                }
            }

            // 【s06 新增】子 Agent 也复用“大输出先落盘，再放预览”的机制
            // 这样即使子任务读到巨量内容，也不会因为单条 tool result 让子上下文失控。
            const compactedResult = await persistLargeOutput(toolName, toolCall.id, result);
            console.log(`      ↪ ${String(compactedResult).substring(0, 200)}`);

            // 把工具结果加入子 Agent 的消息历史
            subMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: compactedResult
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 【关键】到这里，subMessages 包含了子 Agent 的全部对话历史，
    // 可能有几十条消息。但是我们只返回 finalText（最终摘要），
    // subMessages 作为局部变量，函数结束后会被垃圾回收。
    //
    // 这就是 Sub Agent 模式的精髓：
    //   子 Agent 可能跑了 30+ 轮工具调用，
    //   但父 Agent 收到的只是一段简洁的摘要文本。
    // ═══════════════════════════════════════════════════════════
    console.log(`🏁 [Sub Agent] 返回摘要给父 Agent\n`);
    return finalText;
}
