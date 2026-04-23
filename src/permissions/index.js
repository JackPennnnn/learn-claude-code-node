/**
 * 权限系统 — s07 核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一章解决什么问题？
 *
 *   到了 s06，Agent 已经能读文件、改文件、跑命令、压缩上下文。
 *   但模型可能：
 *     - 写错文件
 *     - 执行危险命令
 *     - 在不该动手的时候动手
 *
 *   所以系统需要一条新管道：
 *     "意图"不能直接变成"执行"，
 *     中间必须先经过权限检查。
 *
 * 最小权限管道（严格按 s07 文章顺序）：
 *
 *   tool_call
 *     │
 *     ▼
 *   1. deny rules        命中 → 拒绝
 *     │
 *     ▼
 *   2. mode policy       根据当前模式决定
 *     │
 *     ▼
 *   3. bash safety       仅 execute_bash 走这里
 *     │
 *     ▼
 *   4. allow rules       命中 → 放行
 *     │
 *     ▼
 *   5. ask user          剩下灰区交给人确认
 *
 * ═══════════════════════════════════════════════════════════════
 *
 * 教学边界（与 s07 一致）：
 *   - 只做 3 种模式：default / plan / auto
 *   - 只做 deny / allow 两类规则
 *   - bash 只做模式匹配版安全检查
 *   - 不做企业策略源、复杂分类器、配置持久化
 *
 * 一句话记住：
 *   任何工具调用，都不应该直接执行；中间必须先过一条权限管道。
 */

import { rl } from '../io/rl.js';
import { checkBashSafety } from './bash-safety.js';

// ═══════════════════════════════════════════════════════════════════════
// 工具分类
//
// 这两个集合用来支撑 mode 层的判定：
//   - plan 模式：阻止所有 WRITE_TOOLS
//   - auto 模式：自动放行所有 READ_ONLY_TOOLS
// ═══════════════════════════════════════════════════════════════════════

// 只读类工具：调用它们最多消耗算力，不会改变系统外部状态
// 【s09】list_memories 只读，归入此类
const READ_ONLY_TOOLS = new Set(['read_file', 'load_skill', 'todo', 'list_memories']);

// 写入/外部副作用类工具：可能落盘、起进程、派发子任务
// 【s09】save_memory / delete_memory 会修改 .memory/ 下的文件，归入写入类
//        这样 plan 模式会自动拒绝，default 模式会询问，auto 模式仍要确认
const WRITE_TOOLS = new Set(['write_file', 'execute_bash', 'task', 'save_memory', 'delete_memory']);

// ═══════════════════════════════════════════════════════════════════════
// 权限模式
//
// default — 未命中规则时问用户（最安全的默认值）
// plan    — 只允许读，所有写入工具一律拒绝（适合做计划/审查/分析）
// auto    — 简单安全操作自动过，危险操作再问（流畅度最高）
//
// 注意：模式只是"总体风格"，仍然受 deny rules 和 bash safety 约束。
// 也就是说 auto 模式下 sudo 依然会被挡掉。
// ═══════════════════════════════════════════════════════════════════════

const VALID_MODES = new Set(['default', 'plan', 'auto']);
let currentMode = 'default';

// ═══════════════════════════════════════════════════════════════════════
// 规则数据结构
//
// PermissionRule = {
//   tool:     string,                    // 针对哪个工具名
//   behavior: 'allow' | 'deny' | 'ask',  // 命中后怎么处理
//   content?: string,                    // 可选：内容 glob（如 'sudo *'）
//   path?:    string                     // 可选：路径 glob（fs 工具用）
// }
//
// 这里的 glob 实现非常简单：把 * 翻译成 .*，整体作为正则匹配。
// 真实生产里会用更严格的 minimatch，教学版够用即可。
// ═══════════════════════════════════════════════════════════════════════

// 预设的拒绝规则：跨模式、跨 Agent 一律生效
const denyRules = [
    { tool: 'execute_bash', content: 'sudo *', behavior: 'deny' },
    { tool: 'execute_bash', content: 'rm -rf *', behavior: 'deny' }
];

// 预设的放行规则：纯只读 / 纯计划类工具，没必要每次都问
const allowRules = [
    { tool: 'read_file', behavior: 'allow' },
    { tool: 'load_skill', behavior: 'allow' },
    { tool: 'todo', behavior: 'allow' },
    { tool: 'compact', behavior: 'allow' },
    // 【s09】list_memories 是纯读：列出已有 memory 不会改任何东西
    { tool: 'list_memories', behavior: 'allow' }
];

/**
 * 把 glob 模式（含 *）翻译成正则，做大小写敏感的整串匹配
 * 例如：'sudo *'  →  /^sudo .*$/
 */
function globToRegex(glob) {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`);
}

/**
 * 判断一条规则是否命中本次工具调用
 *
 * 命中条件（必须全部满足）：
 *   1. rule.tool 与 toolName 完全相等
 *   2. 若 rule.content 存在，要求 toolInput.command 或 toolInput.content 命中 glob
 *   3. 若 rule.path 存在，要求 toolInput.path 命中 glob
 */
function matches(rule, toolName, toolInput) {
    if (rule.tool !== toolName) return false;

    if (rule.content) {
        const haystack = toolInput.command ?? toolInput.content ?? '';
        if (!globToRegex(rule.content).test(String(haystack))) return false;
    }

    if (rule.path) {
        const p = toolInput.path ?? '';
        if (!globToRegex(rule.path).test(String(p))) return false;
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
// 第 1 层：核心决策函数
//
// 输入工具名 + 工具参数，输出 { behavior, reason }。
// 这里只负责"判断"，不会真的执行任何 IO（连提问都不做）。
// 这样的好处是：单元测试时可以脱离 stdin 直接验证决策。
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{ behavior: 'allow' | 'deny' | 'ask', reason: string }}
 */
export function checkPermission(toolName, toolInput = {}) {
    for (const rule of denyRules) {
        if (matches(rule, toolName, toolInput)) {
            return { behavior: 'deny', reason: `命中 deny 规则：${rule.tool} ${rule.content || ''}`.trim() };
        }
    }

    if (currentMode === 'plan' && WRITE_TOOLS.has(toolName)) {
        return { behavior: 'deny', reason: 'plan 模式不允许写入/副作用类工具' };
    }
    if (currentMode === 'auto' && READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: 'allow', reason: 'auto 模式自动放行只读工具' };
    }

    if (toolName === 'execute_bash') {
        const safety = checkBashSafety(toolInput.command || '');
        if (safety.matched) {
            return { behavior: 'deny', reason: `bash 安全检查不通过：${safety.reason}` };
        }
    }

    for (const rule of allowRules) {
        if (matches(rule, toolName, toolInput)) {
            return { behavior: 'allow', reason: `命中 allow 规则：${rule.tool}` };
        }
    }

    return { behavior: 'ask', reason: '未命中任何规则，需要用户确认' };
}

// ═══════════════════════════════════════════════════════════════════════
// 第 2 层：与用户交互
//
// askUser 把决策结果落到 stdin/stdout 上：弹一个 [y/N] 让用户拍板。
// 注意 readline 是从 src/io/rl.js 拿到的共享单例，
// 不会和主循环的 rl.question 冲突。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 向用户弹出 [y/N] 确认框
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} reason - 来自 checkPermission 的说明
 * @returns {Promise<boolean>} true=用户允许 / false=用户拒绝（默认拒绝）
 */
async function askUser(toolName, toolInput, reason) {
    // 把工具参数压成一行预览，太长就截断
    const argsPreview = JSON.stringify(toolInput).slice(0, 200);
    console.log('\n──────────── 权限确认 ────────────');
    console.log(`工具: ${toolName}`);
    console.log(`参数: ${argsPreview}`);
    console.log(`原因: ${reason}`);
    const answer = await rl.question('是否允许执行？[y/N]: ');
    console.log('──────────────────────────────────');
    return answer.trim().toLowerCase() === 'y';
}

// ═══════════════════════════════════════════════════════════════════════
// 第 3 层：上层入口 gatekeep
//
// 这才是被 src/index.js 和 subagent.js 调用的"门禁函数"。
// 它把"决策 + 交互 + 计数"三件事粘在一起：
//
//   1. 调 checkPermission 拿决策
//   2. 如果是 ask，按 interactive 决定弹窗或转 deny
//   3. 维护 denyStreak —— 连续被拒次数到阈值时打印提示
//
// 返回值始终标准化为 { behavior: 'allow' | 'deny', reason }，
// 调用方只需要二选一处理，不用再关心 ask 这种中间态。
// ═══════════════════════════════════════════════════════════════════════

// 连续被拒计数器：用来在模型反复被挡时给用户一个提示
let denyStreak = 0;
const DENY_STREAK_THRESHOLD = 3;

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @param {{ interactive?: boolean }} options
 *   interactive=true  且决策为 ask → 弹窗询问用户
 *   interactive=false 且决策为 ask → 直接当 deny 处理（用于无头/CI 场景）
 * @returns {Promise<{ behavior: 'allow' | 'deny', reason: string }>}
 */
export async function gatekeep(toolName, toolInput = {}, options = {}) {
    const { interactive = true } = options;
    const decision = checkPermission(toolName, toolInput);

    let finalBehavior = decision.behavior;
    let finalReason = decision.reason;

    if (decision.behavior === 'ask') {
        if (!interactive) {
            finalBehavior = 'deny';
            finalReason = `${decision.reason}（非交互环境，自动拒绝）`;
        } else {
            const ok = await askUser(toolName, toolInput, decision.reason);
            finalBehavior = ok ? 'allow' : 'deny';
            finalReason = ok ? '用户确认放行' : '用户拒绝';
        }
    }

    if (finalBehavior === 'deny') {
        denyStreak += 1;
        if (denyStreak >= DENY_STREAK_THRESHOLD) {
            console.log(`📢 已连续 ${denyStreak} 次被拒，建议切到 plan 模式（/mode plan）或重新明确目标。`);
        }
    } else {
        denyStreak = 0;
    }

    return { behavior: finalBehavior, reason: finalReason };
}

// ═══════════════════════════════════════════════════════════════════════
// 暴露给主循环的小 API
//
// 这些函数让 src/index.js 可以处理 /mode、/perm 这样的斜杠命令，
// 也方便后续章节（比如 s08 的 hook）注入更多自定义规则。
// ═══════════════════════════════════════════════════════════════════════

export function getMode() {
    return currentMode;
}

/**
 * 切换权限模式
 * @returns {boolean} 切换是否成功（无效模式名会返回 false）
 */
export function setMode(newMode) {
    if (!VALID_MODES.has(newMode)) return false;
    currentMode = newMode;
    return true;
}

/**
 * 运行时追加一条规则
 * 例：addRule('deny', { tool: 'execute_bash', content: 'curl *' })
 */
export function addRule(behavior, rule) {
    const target = behavior === 'deny' ? denyRules : allowRules;
    target.push({ ...rule, behavior });
}

/**
 * 把当前权限状态压成一段可读文本，供 /perm 命令打印
 */
export function describeState() {
    return [
        `当前模式: ${currentMode}`,
        `连续被拒次数: ${denyStreak}`,
        `Deny 规则: ${denyRules.length} 条`,
        `Allow 规则: ${allowRules.length} 条`,
        '可用模式: default(问用户) / plan(只读) / auto(自动放行只读)'
    ].join('\n');
}
