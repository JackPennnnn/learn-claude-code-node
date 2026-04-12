import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const CONTEXT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'context-outputs');

export const PERSIST_THRESHOLD = 4000;
export const PERSIST_PREVIEW_CHARS = 1200;
export const MICRO_COMPACT_KEEP_TOOL_RESULTS = 3;
export const CONTEXT_CHAR_LIMIT = 18000;
export const RECENT_MESSAGES_TO_KEEP = 8;
const MAX_RECENT_FILES = 8;

let manualCompactRequested = false;

/**
 * CompactState —— s06 的显式压缩状态
 *
 * 为什么要单独维护？
 *   因为压缩不是一次性的“砍历史”，而是一个持续过程。
 *   Agent 需要记住：
 *   1. 之前是否已经压缩过
 *   2. 最近一次压缩总结了什么
 *   3. 最近重点碰过哪些文件
 *
 * 这样下次再次压缩时，才能延续工作主线，而不是每次都从零开始概括。
 */
export function createCompactState() {
    return {
        hasCompacted: false,
        lastSummary: '',
        recentFiles: []
    };
}

/**
 * 记录最近访问的文件
 *
 * recentFiles 不是完整审计日志，而是“压缩后还值得保留的工作记忆”。
 * 我们只保留最近少量文件，避免这个状态自己再次膨胀。
 */
export function trackRecentFile(compactState, filePath) {
    if (!compactState || !filePath) return;

    const normalized = String(filePath).trim();
    if (!normalized) return;

    compactState.recentFiles = [
        normalized,
        ...compactState.recentFiles.filter(item => item !== normalized)
    ].slice(0, MAX_RECENT_FILES);
}

export function noteToolUsage(compactState, toolName, toolArgs = {}) {
    if (toolName === 'read_file' || toolName === 'write_file') {
        trackRecentFile(compactState, toolArgs.path);
    }
}

/**
 * 大工具结果先落盘，只把预览放回上下文
 *
 * 关键思想：
 *   “不丢内容，只搬位置。”
 *   如果直接截断，模型以后就再也拿不到全文；
 *   如果全文常驻 messages，又会迅速挤爆上下文窗口。
 *   所以教学版采用折中方案：
 *     全文写入磁盘
 *     当前上下文里只留一个结构化标记 + 预览
 */
export async function persistLargeOutput(toolName, toolCallId, result) {
    const fullText = String(result ?? '');
    if (fullText.length <= PERSIST_THRESHOLD) {
        return fullText;
    }

    await fs.mkdir(CONTEXT_OUTPUT_DIR, { recursive: true });

    const safeToolName = String(toolName || 'tool').replace(/[^a-zA-Z0-9_-]/g, '-');
    const safeToolCallId = String(toolCallId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-');
    const fileName = `${Date.now()}-${safeToolName}-${safeToolCallId}.txt`;
    const storedPath = path.join(CONTEXT_OUTPUT_DIR, fileName);

    await fs.writeFile(storedPath, fullText, 'utf8');

    const relativePath = path.relative(PROJECT_ROOT, storedPath).replaceAll(path.sep, '/');
    const preview = fullText.slice(0, PERSIST_PREVIEW_CHARS);
    const suffix = fullText.length > PERSIST_PREVIEW_CHARS ? '\n...(truncated preview)...' : '';

    return (
        '<persisted-output>\n'
        + `Full output saved to: ${relativePath}\n`
        + `Original length: ${fullText.length} characters\n`
        + 'Preview:\n'
        + `${preview}${suffix}\n`
        + '</persisted-output>'
    );
}

/**
 * 微压缩：只保留最近 3 个工具结果的完整内容
 *
 * 这一步不追求“总结能力”，只追求便宜、稳定、可预测：
 *   - 最新工具结果：保留原文，方便模型立刻继续工作
 *   - 更早工具结果：替换成占位提示，避免旧结果长期霸占窗口
 */
export function microCompactMessages(messages) {
    const toolIndexes = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'tool') {
            toolIndexes.push(i);
        }
    }

    if (toolIndexes.length <= MICRO_COMPACT_KEEP_TOOL_RESULTS) {
        return messages;
    }

    const keepIndexes = new Set(toolIndexes.slice(-MICRO_COMPACT_KEEP_TOOL_RESULTS));

    return messages.map((message, index) => {
        if (message.role !== 'tool' || keepIndexes.has(index)) {
            return message;
        }

        if (message.content === '[Earlier tool result omitted for brevity]') {
            return message;
        }

        return {
            ...message,
            content: '[Earlier tool result omitted for brevity]'
        };
    });
}

/**
 * 教学版上下文大小估算
 *
 * 这里故意不用 token 库，而是先用字符数近似。
 * 目的不是算得绝对精确，而是让“主循环开始关心预算”这件事先成立。
 */
export function estimateContextSize(messages) {
    return messages.reduce((total, message) => {
        return total + JSON.stringify(message).length;
    }, 0);
}

function formatMessagesForSummary(messages) {
    return messages.map((message, index) => {
        const lines = [
            `#${index + 1}`,
            `role=${message.role}`
        ];

        if (message.name) lines.push(`name=${message.name}`);
        if (message.tool_call_id) lines.push(`tool_call_id=${message.tool_call_id}`);
        if (message.tool_calls?.length) {
            const toolNames = message.tool_calls.map(call => call.function?.name || '(unknown)').join(', ');
            lines.push(`tool_calls=${toolNames}`);
        }

        lines.push('content:');
        lines.push(String(message.content ?? ''));

        return lines.join('\n');
    }).join('\n\n');
}

function buildSummaryRequest(messages, compactState) {
    const recentFiles = compactState.recentFiles.length > 0
        ? compactState.recentFiles.join(', ')
        : '(none)';
    const previousSummary = compactState.lastSummary || '(none)';

    return `请把下面这段 Agent 历史压缩成“可继续工作的连续性摘要”。

必须保留且明确分段输出这 5 类信息：
1. 当前目标
2. 已完成的关键动作
3. 已修改或重点查看过的文件
4. 关键决定与约束
5. 下一步

额外上下文：
- 最近一次压缩摘要：${previousSummary}
- CompactState.recentFiles: ${recentFiles}

要求：
- 使用简洁中文
- 不要空话
- 不要丢失尚未完成的工作
- 如果某类信息缺失，请写“无”

以下是需要压缩的消息历史：

${formatMessagesForSummary(messages)}`;
}

function buildFallbackSummary(messages, compactState) {
    const latestUser = [...messages].reverse().find(message => message.role === 'user');
    const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant' && message.content);
    const recentFiles = compactState.recentFiles.length > 0
        ? compactState.recentFiles.join(', ')
        : '无';

    return [
        '## 当前目标',
        latestUser?.content || compactState.lastSummary || '无',
        '',
        '## 已完成的关键动作',
        latestAssistant?.content || '无',
        '',
        '## 已修改或重点查看过的文件',
        recentFiles,
        '',
        '## 关键决定与约束',
        '已启用教学版上下文压缩：大输出落盘、旧工具结果占位、必要时生成连续性摘要。',
        '',
        '## 下一步',
        '基于最近几轮消息继续推进当前任务。'
    ].join('\n');
}

/**
 * 完整压缩：把“旧历史”折叠成一份连续性摘要
 *
 * 这里和微压缩的区别在于：
 *   微压缩只做机械替换；
 *   完整压缩要真正提炼主线，让模型即使丢掉大量细节，也还能接着干活。
 */
export async function compactHistory({ messages, compactState, openai, model }) {
    const recentTailStart = Math.max(1, messages.length - RECENT_MESSAGES_TO_KEEP);
    const recentTail = messages.slice(recentTailStart);
    let summary;

    try {
        const response = await openai.chat.completions.create({
            model,
            enable_thinking: false,
            messages: [
                {
                    role: 'system',
                    content: '你是一个专门负责压缩对话历史的助手。你的目标不是缩到最短，而是保住继续工作所需的连续性。'
                },
                {
                    role: 'user',
                    content: buildSummaryRequest(messages, compactState)
                }
            ]
        });

        summary = response.choices[0]?.message?.content?.trim();
    } catch (error) {
        summary = buildFallbackSummary(messages, compactState);
    }

    if (!summary) {
        summary = buildFallbackSummary(messages, compactState);
    }

    compactState.hasCompacted = true;
    compactState.lastSummary = summary;

    const systemMessage = messages[0];

    return [
        systemMessage,
        {
            role: 'user',
            content: 'This conversation was compacted for continuity.\n\n' + summary
        },
        ...recentTail
    ];
}

export function requestManualCompact() {
    manualCompactRequested = true;
}

export function consumeManualCompactRequest() {
    const requested = manualCompactRequested;
    manualCompactRequested = false;
    return requested;
}

/**
 * 主循环统一入口
 *
 * 顺序必须固定：
 *   1. 先做微压缩，便宜地清掉旧工具结果
 *   2. 再估算预算
 *   3. 超预算或手动触发时，再做完整压缩
 *
 * 这样手动 compact 和自动 compact 共享同一套逻辑，不会出现两套行为逐渐漂移。
 */
export async function maybeCompactMessages({
    messages,
    compactState,
    openai,
    model,
    force = false
}) {
    const microCompacted = microCompactMessages(messages);
    const contextSize = estimateContextSize(microCompacted);

    if (!force && contextSize <= CONTEXT_CHAR_LIMIT) {
        return microCompacted;
    }

    return await compactHistory({
        messages: microCompacted,
        compactState,
        openai,
        model
    });
}
