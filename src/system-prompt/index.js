/**
 * 系统提示词流水线 — s10 核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一章解决什么问题？
 *
 *   到 s09 为止，system prompt 还是直接在 src/index.js 里硬编码的一大段字符串：
 *     baseSystemPrompt + loadMemorySection()
 *
 *   一旦系统继续长功能，这种"大字符串"做法会迅速破产：
 *     - 工具列表会变（s02/s05/s06/s09 一路在加）
 *     - skills 描述会变（按需加载，每个项目不同）
 *     - memory 会变（运行时通过 /memory ignore 切换）
 *     - 当前日期、cwd、权限模式每轮都可能变
 *     - 某些提醒只该活一轮，不该永久塞进系统说明
 *
 *   所以 system prompt 必须升级成"由多个来源共同组装出来的一条流水线"。
 *
 * ═══════════════════════════════════════════════════════════════
 * 6 段拼装顺序（教学版固定）
 *
 *   _buildCore       —— 身份 / 多步任务规则 / memory 边界
 *   _buildTools      —— 列出当前可用工具（不含完整 schema，只给名字 + 一句话）
 *   _buildSkills     —— skillLoader.getDescriptions() 的结果
 *   _buildMemory     —— loadMemorySection()，ignore 时自然为空
 *   _buildClaudeMd   —— 读取项目根 ./CLAUDE.md 作为长期项目规则
 *   _buildDynamic    —— 日期 / cwd / model / 当前权限模式
 *
 *   稳定段（前 5 段）和动态段（最后一段）之间放一条
 *   `=== DYNAMIC ===` 边界标记，不是魔法，只是提醒：
 *     上面的内容相对稳定，下面的内容每轮可能变。
 *
 * ═══════════════════════════════════════════════════════════════
 * system prompt 与 system reminder 的边界
 *
 *   system prompt 适合放：
 *     - 身份 / 长期规则 / 工具列表 / 长期约束
 *
 *   system reminder 适合放：
 *     - 这一轮才临时需要的补充上下文（todo nag、PreToolUse 注入提示）
 *     - 当前轮变化的状态
 *
 *   reminder 仍然以 user 消息形式追加进 messages，但用统一的
 *   <system-reminder> 标签包裹，模型可以从标签上区分"真正的用户"
 *   和"系统硬塞的提醒"。这一段由 buildSystemReminder() 提供，
 *   主循环里的 <reminder>/<hook> 字面量都会迁移到这里。
 *
 * ═══════════════════════════════════════════════════════════════
 * 教学边界（不做的事）
 *
 *   - 不做复杂的 section 注册表 / 优先级 / token 预算
 *   - 不做 prompt 缓存（虽然稳定/动态边界已经为缓存留好接缝）
 *   - 不接入 MCP 给 prompt 追加能力描述（留给后续章节）
 *   - CLAUDE.md 暂只读项目根目录，不做"用户级 + 项目根 + cwd 子目录"叠加
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 稳定段与动态段之间的分隔线。
// 不是模型必须遵守的协议，仅作为人/缓存层都能识别的"接缝"。
const DYNAMIC_BOUNDARY = '=== DYNAMIC ===';

// 项目根目录下的 CLAUDE.md，作为长期项目规则的来源。
// 找不到不报错——CLAUDE.md 是可选输入，缺失时该段安静跳过。
const CLAUDE_MD_PATH = path.resolve(process.cwd(), 'CLAUDE.md');

/**
 * SystemPromptBuilder
 *
 * 一个"无状态"的组装器：每次 build() 都重新拉取最新的 skills / memory /
 * mode / 时间，避免任何"上一轮缓存导致提示词与现实不一致"的问题。
 *
 * 依赖通过构造函数注入而不是顶部 import：
 *   - 让模块本身保持纯净，只依赖 fs/path/process
 *   - 测试时可以塞 mock 的 skillLoader / getMode 进来
 *   - 主循环明确地"持有"这些来源，不会出现"谁先初始化"的隐式顺序
 */
export class SystemPromptBuilder {
    /**
     * @param {object} deps
     * @param {{ getDescriptions: () => string }} deps.skillLoader
     *        s05 的 SkillLoader 实例，提供"技能名称 + 一句话描述"。
     * @param {string} deps.model
     *        当前使用的模型 ID，仅用于动态段展示，不影响行为。
     * @param {() => string} deps.getMode
     *        s07 权限模式读取器，每次 build() 都拉一次最新值。
     * @param {() => string} [deps.loadMemorySection]
     *        s09 memory 段加载器；ignore 状态下应返回空字符串。
     *        允许覆盖以便测试，主循环传入真实的 loadMemorySection。
     */
    constructor({ skillLoader, model, getMode, loadMemorySection }) {
        this.skillLoader = skillLoader;
        this.model = model;
        this.getMode = getMode;
        this.loadMemorySection = loadMemorySection ?? (() => '');
    }

    /**
     * 组装并返回完整 system prompt。
     *
     * 设计取舍：
     *   - 每段返回的字符串可能为空（如 skills 没装、CLAUDE.md 不存在），
     *     用 filter(Boolean) 把空段直接丢掉，保持输出整洁。
     *   - 段与段之间用一个空行分隔，让模型在视觉上更容易切分主题。
     */
    build() {
        const parts = [
            this._buildCore(),
            this._buildTools(),
            this._buildSkills(),
            this._buildMemory(),
            this._buildClaudeMd(),
            DYNAMIC_BOUNDARY,
            this._buildDynamic()
        ];
        return parts.filter(Boolean).join('\n\n');
    }

    // ───────────────────────────────────────────────────────────
    // 段 1：核心身份与行为规则
    //
    // 这一段是真正"长期不变"的内容：
    //   - 你是谁
    //   - 你应该如何思考多步任务（呼应 s03 todo）
    //   - 你应该如何派发子任务（呼应 s04 task）
    //   - memory 的边界（呼应 s09，避免模型把任何东西都塞进 memory）
    //
    // 这里故意不放任何会随环境变化的东西（日期/路径/模式）。
    // 把"会变的"和"不变的"分开，是这一章最关键的心智。
    // ───────────────────────────────────────────────────────────
    _buildCore() {
        return [
            '你是一个专业的编程助手，可以使用工具来完成任务。',
            '',
            'Use the todo tool to plan multi-step tasks.',
            'Mark tasks as in_progress before starting, and completed when done.',
            'Only one task can be in_progress at a time.',
            'Prefer using tools over writing prose.',
            'Use the task tool to delegate subtasks that would benefit from a clean context.',
            'The task tool spawns a subagent that has its own fresh message history.',
            'Delegate work like reading multiple files, running commands, or any exploratory task.',
            '',
            '记忆系统 (s09):',
            '- 跨会话有用、且不能从代码直接重新看出来的信息，可以调用 save_memory 保存。',
            '- 当前任务进度、文件路径、函数签名等可重新观察的内容，不要写进 memory。',
            '- memory 里的信息可能已过时；如与当前观察冲突，优先相信当前观察。',
            '',
            '系统提醒 (s10):',
            '- 你可能会在 user 消息里看到 <system-reminder>...</system-reminder> 标签。',
            '- 这是系统硬塞的本轮临时提醒（例如 todo nag、hook 注入），不是真实用户的话。',
            '- 请按提醒指引行动，但不要把它当成新的用户请求。'
        ].join('\n');
    }

    // ───────────────────────────────────────────────────────────
    // 段 2：工具列表
    //
    // 注意：这里只是"再一次用自然语言概述"工具，
    // 真正给模型解析参数 schema 的是 chat.completions.create({ tools }) 那条路。
    //
    // 为什么仍然写一遍？
    //   - 让模型在系统说明阶段就形成"我手里有什么"的整体认知，
    //     而不是只在每次工具调用前临时拼出来。
    //   - 解释意图（"什么时候用"），这是 schema 表达不出来的。
    // ───────────────────────────────────────────────────────────
    _buildTools() {
        const lines = [
            '## 可用工具（详细参数 schema 已通过 tools 字段传入）',
            '- write_file       写文件到 data/ 目录',
            '- read_file        读 data/ 目录下的文件',
            '- execute_bash     执行 shell 命令（受 s07 bash safety 约束）',
            '- todo             更新任务清单（多步任务必用）',
            '- load_skill       按需加载某个技能的完整指令（见下方 Skills 列表）',
            '- compact          手动触发上下文压缩（s06）',
            '- save_memory      保存跨会话长期信息（s09，仅父 Agent 可用）',
            '- list_memories    列出已保存的 memory（s09，仅父 Agent 可用）',
            '- delete_memory    删除一条 memory（s09，仅父 Agent 可用）',
            '- task             派发子任务给独立上下文的子 Agent（s04，仅父 Agent 可用）'
        ];
        return lines.join('\n');
    }

    // ───────────────────────────────────────────────────────────
    // 段 3：skills 元信息
    //
    // 这是 s05"按需加载"的第一层：
    //   只列名字 + 一句话描述（约 100 tokens/技能），
    //   模型决定需要某个技能时再调 load_skill 拉完整正文。
    //
    // 没有任何技能时整段不出现，避免给模型一段空目录造成困惑。
    // ───────────────────────────────────────────────────────────
    _buildSkills() {
        const desc = this.skillLoader?.getDescriptions?.() ?? '';
        if (!desc || desc === '(no skills loaded)') return '';
        return ['## 可用技能（使用 load_skill 加载详细指令）', desc].join('\n');
    }

    // ───────────────────────────────────────────────────────────
    // 段 4：memory
    //
    // 这一段是 s09 memory 系统的"出口"：
    //   - loadMemorySection() 已经包含了 ## 标题和 markdown 结构
    //   - 在 ignore 状态下返回空，整段直接消失（不要塞个空标题骗模型有内容）
    //
    // memory 段必须出现在 CLAUDE.md 之前还是之后？
    //   教学版选择在前：让"会话特定的长期事实"先进入模型视野，
    //   然后才是更稳定的项目规则；这样冲突时项目规则更容易被记住。
    // ───────────────────────────────────────────────────────────
    _buildMemory() {
        const section = this.loadMemorySection() || '';
        return section.trim();
    }

    // ───────────────────────────────────────────────────────────
    // 段 5：CLAUDE.md（长期项目规则）
    //
    // 与 memory / skills 的区别：
    //   - skills    可选能力包，按需加载
    //   - memory    跨会话事实，可能漂移，模型应优先相信当前观察
    //   - CLAUDE.md 长期项目规则，准·权威，与 README 同级
    //
    // 教学版只读项目根目录的 CLAUDE.md：
    //   找不到时整段返回空，不要伪造一段"暂无项目规则"的占位。
    // ───────────────────────────────────────────────────────────
    _buildClaudeMd() {
        try {
            const text = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8').trim();
            if (!text) return '';
            return ['## 项目长期规则（CLAUDE.md）', text].join('\n');
        } catch {
            return '';
        }
    }

    // ───────────────────────────────────────────────────────────
    // 段 6：动态环境信息
    //
    // 任何"每轮可能变"的信息都该放这里，不要混进上面的稳定段：
    //   - Date：今天是哪天，影响模型对"最近"等词的理解
    //   - Cwd：当前工作目录，影响相对路径
    //   - Model：当前使用的模型 ID，便于日志/调试
    //   - Mode：当前 s07 权限模式，模型据此调整行为预期
    //
    // 出现在 DYNAMIC_BOUNDARY 之后，"上面稳定、下面动态"一目了然。
    // ───────────────────────────────────────────────────────────
    _buildDynamic() {
        const lines = [
            `Date: ${new Date().toISOString().slice(0, 10)}`,
            `Cwd:  ${process.cwd()}`,
            `Model: ${this.model}`,
            `Mode:  ${this.getMode?.() ?? 'unknown'}`
        ];
        return lines.join('\n');
    }
}

/**
 * 把任意文本统一包成 <system-reminder> 标签。
 *
 * 为什么需要这个小帮助函数？
 *   到 s09 为止，主循环里有两处"以 user 消息塞临时提醒"的代码：
 *     1. todo nag           → '<reminder>Update your todos...</reminder>'
 *     2. PreToolUse hook    → '<hook>...</hook>'
 *   标签不一致，模型很难形成统一的"这是系统提醒"心智。
 *
 *   s10 的做法：标签收敛为 <system-reminder>，所有临时提醒走同一个出口。
 *   后续如果想引入"reminder 队列 / 优先级 / 一次性消费"等机制，
 *   也只需要在这一个函数后面加。
 *
 * 注意：返回的仍然是字符串，主循环负责把它包成 user 消息塞进 messages。
 *       这一层不接触 messages 数组，保持纯函数。
 */
export function buildSystemReminder(text) {
    return `<system-reminder>${text}</system-reminder>`;
}
