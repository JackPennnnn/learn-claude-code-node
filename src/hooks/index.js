/**
 * Hook 系统 — s08 核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一章解决什么问题？
 *
 *   到了 s07，主循环已经能在工具执行前做权限判断（gatekeep）。
 *   但很多需求并不属于"允不允许"这条线，而属于：
 *     - 在某个固定时机顺手做一点事（打日志、统计、提醒）
 *     - 不改主循环主体，也能接入额外规则
 *     - 让用户/插件在系统边缘扩展能力
 *
 *   核心理念（一句话）：
 *     主循环只负责暴露"时机"，真正的附加行为交给 hook。
 *     hook 让系统围绕主循环生长，而不是不断重写主循环本身。
 *
 * ═══════════════════════════════════════════════════════════════
 * 三件套抽象
 *
 *   1. HookEvent  = { name, payload }
 *      回答"现在发生了什么事 + 上下文是什么"
 *
 *   2. HookResult = { exit_code, message }
 *      回答"想不想阻止主流程 + 要不要补一条说明"
 *
 *   3. HookRunner = register / runHooks
 *      主循环不关心每个 hook 的细节，只把事件交给统一 runner
 *
 * ═══════════════════════════════════════════════════════════════
 * 教学版统一返回约定
 *
 *   退出码 | 含义
 *   ------|----------------------------------
 *     0   | 正常继续
 *     1   | 阻止当前动作
 *     2   | 注入一条补充消息，再继续
 *
 *   先用统一语义把 3 种作用（观察 / 拦截 / 补充）讲清，
 *   再去做"不同事件采用不同语义"的细化也不会乱。
 *
 * ═══════════════════════════════════════════════════════════════
 * 与 s07 权限系统的关系（重要）
 *
 *   gatekeep ── 系统硬规则，决定"准不准"
 *   hook     ── 侧车扩展，决定"除了执行还要做什么"
 *
 *   执行顺序：先 gatekeep，再 hook。
 *   被 deny 的工具调用根本不会触发 PreToolUse hook，
 *   避免双层语义打架。本模块**不替代** gatekeep。
 *
 * ═══════════════════════════════════════════════════════════════
 * 教学边界（与 s08 文章一致）
 *
 *   - 只做 3 个事件：SessionStart / PreToolUse / PostToolUse
 *   - 只做统一 0/1/2 退出码
 *   - 不做事件优先级、不做合并策略——先返回 1/2 的赢
 *   - 不做配置文件、不做远程加载——register API 即一切
 */

import fs from 'fs/promises';
import path from 'path';
import { getMode } from '../permissions/index.js';

// ═══════════════════════════════════════════════════════════════════════
// 事件到处理器列表的映射
//
// 这里采用最朴素的"一个事件名对应一组处理函数"结构。
// 处理函数按注册顺序执行，谁先返回 exit_code !== 0 谁就赢。
// ═══════════════════════════════════════════════════════════════════════

const HOOKS = {
    SessionStart: [],
    PreToolUse: [],
    PostToolUse: []
};

// 合法的事件名集合，用于校验 register 调用
const VALID_EVENTS = new Set(Object.keys(HOOKS));

/**
 * 注册一个 hook 处理器
 *
 * @param {'SessionStart'|'PreToolUse'|'PostToolUse'} eventName
 * @param {(payload: object) => Promise<{exit_code:number, message:string}> | {exit_code:number, message:string}} handler
 *
 * handler 可以是同步或异步函数，必须返回 { exit_code, message } 结构。
 * 如果返回 undefined / null，runner 会按 exit_code=0 处理（即"啥也没说，继续"）。
 */
export function register(eventName, handler) {
    if (!VALID_EVENTS.has(eventName)) {
        throw new Error(`未知的 hook 事件: ${eventName}（可选: ${[...VALID_EVENTS].join(' / ')}）`);
    }
    if (typeof handler !== 'function') {
        throw new Error('hook handler 必须是函数');
    }
    HOOKS[eventName].push(handler);
}

/**
 * 统一运行某个事件下的所有 hook
 *
 * 教学版规则：谁先返回阻止/注入，谁就优先；后面的 handler 不再执行。
 * 这样实现简单，也能保证"先注册的 hook 拥有更高优先级"。
 *
 * @param {string} eventName
 * @param {object} payload
 * @returns {Promise<{exit_code: 0|1|2, message: string}>}
 */
export async function runHooks(eventName, payload = {}) {
    const handlers = HOOKS[eventName] || [];
    for (const handler of handlers) {
        try {
            const result = await handler(payload);
            if (result && (result.exit_code === 1 || result.exit_code === 2)) {
                return {
                    exit_code: result.exit_code,
                    message: result.message || ''
                };
            }
        } catch (err) {
            // hook 出错不应该把主循环带崩。
            // 教学版策略：打日志 + 当成"什么也没发生"继续。
            console.error(`⚠️ hook[${eventName}] 抛错被忽略:`, err.message);
        }
    }
    return { exit_code: 0, message: '' };
}

/**
 * 列出当前所有已注册 hook 的数量，方便调试 / 给 /perm 之类命令用
 */
export function listHooks() {
    return Object.fromEntries(
        Object.entries(HOOKS).map(([k, v]) => [k, v.length])
    );
}

// ═══════════════════════════════════════════════════════════════════════
// 内置示范 handler
//
// 这两个 handler 演示了 s08 文章里讲的"hook 的 3 种作用"中的两种：
//   - 观察：SessionStart 打印欢迎信息
//   - 观察：PostToolUse 写审计日志
// 第三种"拦截/补充"留给读者自行 register。
// ═══════════════════════════════════════════════════════════════════════

// 审计日志的落盘路径（相对项目根目录）
// 之所以写到 data/ 下，是因为 .gitignore 已经忽略了这个目录里的产物
const AUDIT_LOG_PATH = path.resolve(process.cwd(), 'data', 'hooks-audit.log');

/**
 * SessionStart 示范 handler
 * 在主循环刚进入用户输入循环之前打印一条欢迎信息，
 * 顺便把当前权限模式打出来，方便用户一眼确认环境状态。
 */
register('SessionStart', (payload) => {
    const mode = payload.mode ?? getMode();
    console.log(`🪝 Hook 系统已就绪 | 当前权限模式: ${mode}`);
    return { exit_code: 0, message: '' };
});

/**
 * PostToolUse 示范 handler
 * 把每一次工具调用追加一行到 data/hooks-audit.log，
 * 形如：2025-04-22T10:00:00.000Z | write_file | {"path":"x.txt"} | out=128
 *
 * 注意：
 *   - 写文件失败不能影响主循环，所以在 catch 里只打 warning
 *   - 我们故意不返回 exit_code=2，因为审计是"观察"动作，
 *     不应该把日志内容塞回模型上下文
 */
register('PostToolUse', async (payload) => {
    try {
        const ts = new Date().toISOString();
        const toolName = payload.tool_name || 'unknown';
        const argsPreview = JSON.stringify(payload.input ?? {}).slice(0, 200);
        const outLen = String(payload.output ?? '').length;
        const line = `${ts} | ${toolName} | ${argsPreview} | out=${outLen}\n`;

        await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
        await fs.appendFile(AUDIT_LOG_PATH, line, 'utf-8');
    } catch (err) {
        console.error('⚠️ PostToolUse 审计日志写入失败:', err.message);
    }
    return { exit_code: 0, message: '' };
});

/**
 * PreToolUse 示范 handler
 * 在工具调用前检查输入内容长度，如果超过 50KB，则阻止调用
 */
register('PreToolUse', async ({ tool_name, input }) => {
    if (tool_name === 'write_file' && (input.content?.length ?? 0) > 50_000) {
      return {
        exit_code: 2,
        message: '即将写入超过 50KB 的内容，请确认这是预期行为。'
      };
    }
    return { exit_code: 0, message: '' };
  });