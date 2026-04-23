/**
 * 记忆系统 — s09 核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 这一章解决什么问题？
 *
 *   到 s08 为止，Agent 在单次会话里已经很完整了：
 *     - 会规划（todo）、会派子任务（task）、会按需加载技能（skill）
 *     - 会压缩上下文（compact）、会过权限闸门（gatekeep）、会跑 hook
 *
 *   但只要会话一关，所有东西都没了：
 *     - 用户多次纠正过的偏好
 *     - 团队故意定下的、不能从代码直接看出的项目约定
 *     - 某个外部看板/文档的入口
 *
 *   下一次新会话，Agent 又"像第一次合作"。
 *   memory 正是为这个问题而存在。
 *
 * ═══════════════════════════════════════════════════════════════
 * 但 memory 不是"什么都记"
 *
 *   只有同时满足下面两个条件的信息，才值得进入 memory：
 *     1. 跨会话仍然有价值
 *     2. 不能轻易从当前仓库状态/代码/git 里重新推导
 *
 *   所以下面这些**绝对不要**写进 memory：
 *     - 文件结构、目录布局、函数签名     → 重新读代码即可
 *     - 当前任务进度、PR 号、分支名      → 这是 task/plan 的事
 *     - 修 bug 的代码细节               → 代码和 commit 才是真理
 *     - 密钥、密码、凭证                 → 安全风险
 *
 *   这条边界要立死。否则 memory 会从"让系统长期变聪明"
 *   滑向"让系统长期产生幻觉"。
 *
 * ═══════════════════════════════════════════════════════════════
 * 4 类 memory（教学版固定）
 *
 *   user       —— 用户偏好（偏爱 tab、回答要简洁…）
 *   feedback   —— 被验证有效的纠正（"以后遇到 X 先做 Y"）
 *   project    —— 不易从代码看出的项目背景/约定/合规原因
 *   reference  —— 外部资源指针（看板、监控、文档 URL）
 *
 * 2 种作用域
 *
 *   private —— 只属于当前用户的本地记忆（默认）；进 .gitignore
 *   team    —— 整个团队共享的记忆；可以提交到仓库
 *
 *   一个稳的判断法：
 *     user 几乎总是 private；
 *     project / reference 通常更偏向 team；
 *     feedback 默认 private，除非它明确升级为团队规则。
 *
 * ═══════════════════════════════════════════════════════════════
 * 落盘结构
 *
 *   .memory/
 *     ├── private/
 *     │   ├── MEMORY.md              ← 自动生成的索引
 *     │   ├── prefer_tabs.md
 *     │   └── feedback_xxx.md
 *     └── team/
 *         ├── MEMORY.md
 *         └── project_compliance.md
 *
 *   每条 memory 一个 markdown 文件，正文前带一段 frontmatter
 *   作为结构化元数据，让加载器能快速知道这条记忆叫什么、属于哪类。
 *
 * ═══════════════════════════════════════════════════════════════
 * memory 与 task / plan / CLAUDE.md 的边界
 *
 *   只对这次任务有用            → task / plan
 *   以后很多会话都还会有用      → memory
 *   长期、系统级、近似规则的说明 → CLAUDE.md（本项目用 README/SYSTEM）
 *
 * ═══════════════════════════════════════════════════════════════
 * 教学边界（不做的事）
 *
 *   - 不做模型自动抽取（必须模型显式调用 save_memory）
 *   - 不做版本/过期/审计（审计交给 s08 PostToolUse hook 顺手做）
 *   - 不做远程同步（team 作用域靠 git 提交即可）
 *   - 子 Agent 不暴露 memory 工具（它是短期任务，不该写跨会话信息）
 */

import fs from 'fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'path';
import process from 'process';

// ═══════════════════════════════════════════════════════════════════════
// 类型与作用域常量
//
// 故意用 readonly 的常量数组而不是 enum，
// 既方便参数校验，也方便在 system prompt 里直接展示给模型。
// ═══════════════════════════════════════════════════════════════════════

export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);
export const MEMORY_SCOPES = Object.freeze(['private', 'team']);

const DEFAULT_SCOPE = 'private';

// 项目根目录下的 .memory/，与 data/、skills/ 平级
const MEMORY_ROOT = path.resolve(process.cwd(), '.memory');

// 加载顺序：team 在前，private 在后
// 这样团队规范会先进入模型视野，个人偏好作为补充
const SCOPE_LOAD_ORDER = ['team', 'private'];

// ═══════════════════════════════════════════════════════════════════════
// 模块内部状态
//
// 唯一的 mutable 状态：是否当轮"忽略 memory"。
// 和 permissions 模块一样，状态以模块单例形式存在；
// 主循环通过 setIgnoreMemory(true/false) 切换，
// 然后调用 loadMemorySection() 重新拼装即可。
// ═══════════════════════════════════════════════════════════════════════

let _ignore = false;

// ═══════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════

/**
 * 把任意 name 规范化为安全的文件名。
 * 限制长度避免出现"无限长 frontmatter 名"导致路径过长。
 */
function safeName(name) {
    return String(name)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled';
}

function assertType(type) {
    if (!MEMORY_TYPES.includes(type)) {
        throw new Error(`非法的 memory type: ${type}（可选: ${MEMORY_TYPES.join(' / ')}）`);
    }
}

function normalizeScope(scope) {
    const s = scope ?? DEFAULT_SCOPE;
    if (!MEMORY_SCOPES.includes(s)) {
        throw new Error(`非法的 memory scope: ${s}（可选: ${MEMORY_SCOPES.join(' / ')}）`);
    }
    return s;
}

function scopeDir(scope) {
    return path.join(MEMORY_ROOT, scope);
}

function memoryFilePath(scope, name) {
    return path.join(scopeDir(scope), `${safeName(name)}.md`);
}

async function ensureScopeDir(scope) {
    await fs.mkdir(scopeDir(scope), { recursive: true });
}

/**
 * 极简 frontmatter 解析器
 * 只识别 `---` 包起来的一段 key: value，不支持嵌套。
 * 教学版够用，不要为它再引一个 yaml 依赖。
 */
function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    for (const line of m[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) meta[k] = v;
    }
    return { meta, body: m[2] || '' };
}

function buildFrontmatter({ name, description, type, scope, created_at }) {
    return [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        `type: ${type}`,
        `scope: ${scope}`,
        `created_at: ${created_at}`,
        '---',
        ''
    ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// 核心 IO：save / list / delete
// ═══════════════════════════════════════════════════════════════════════

/**
 * 保存一条 memory。
 *
 * 设计取舍：
 *   - 同名覆盖：name 就是 memory 的"主键"。模型希望"更新一条偏好"
 *     时不该被迫先 delete 再 save。
 *   - 每次 save 都会重建对应作用域的 MEMORY.md 索引，避免状态漂移。
 *
 * @param {object} args
 * @param {string} args.name        memory 的短名（会被规范化为文件名）
 * @param {string} args.description 一句话说明这条 memory 是干嘛的
 * @param {'user'|'feedback'|'project'|'reference'} args.type
 * @param {string} args.content     正文，自由文本/markdown
 * @param {'private'|'team'} [args.scope='private']
 */
export async function saveMemory({ name, description, type, content, scope }) {
    if (!name) throw new Error('saveMemory 缺少 name');
    if (!description) throw new Error('saveMemory 缺少 description');
    assertType(type);
    const realScope = normalizeScope(scope);
    await ensureScopeDir(realScope);

    const file = memoryFilePath(realScope, name);
    const frontmatter = buildFrontmatter({
        name: safeName(name),
        description,
        type,
        scope: realScope,
        created_at: new Date().toISOString()
    });
    const body = String(content ?? '').trimEnd() + '\n';

    await fs.writeFile(file, frontmatter + body, 'utf-8');
    await rebuildIndex(realScope);

    return {
        ok: true,
        path: path.relative(process.cwd(), file),
        scope: realScope,
        name: safeName(name)
    };
}

/**
 * 列出 memory。
 *
 * @param {object} [args]
 * @param {'private'|'team'} [args.scope] 不传则列出全部
 * @returns {Promise<Array<{name,description,type,scope,path}>>}
 */
export async function listMemories({ scope } = {}) {
    const scopes = scope ? [normalizeScope(scope)] : MEMORY_SCOPES;
    const out = [];
    for (const s of scopes) {
        const dir = scopeDir(s);
        let entries;
        try {
            entries = await fs.readdir(dir);
        } catch {
            // 目录不存在 = 该作用域里还没有 memory，安静跳过
            continue;
        }
        for (const entry of entries) {
            if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
            const file = path.join(dir, entry);
            try {
                const text = await fs.readFile(file, 'utf-8');
                const { meta } = parseFrontmatter(text);
                out.push({
                    name: meta.name || entry.replace(/\.md$/, ''),
                    description: meta.description || '',
                    type: meta.type || 'unknown',
                    scope: meta.scope || s,
                    path: path.relative(process.cwd(), file)
                });
            } catch {
                // 单个文件坏了不应该让整个 list 崩，跳过即可
            }
        }
    }
    return out;
}

/**
 * 删除一条 memory。
 *
 * 注意：必须显式给 scope，避免"team 里的同名记忆被误删"。
 */
export async function deleteMemory({ name, scope }) {
    if (!name) throw new Error('deleteMemory 缺少 name');
    const realScope = normalizeScope(scope);
    const file = memoryFilePath(realScope, name);
    try {
        await fs.unlink(file);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { ok: false, reason: `memory 不存在: ${safeName(name)} @ ${realScope}` };
        }
        throw err;
    }
    await rebuildIndex(realScope);
    return { ok: true, name: safeName(name), scope: realScope };
}

// ═══════════════════════════════════════════════════════════════════════
// 索引：MEMORY.md
//
// 索引文件不重复保存正文，只是给"作用域里有什么 memory"提供一张快速目录。
// 之所以维护它，是为了让用户/团队成员可以直接在 IDE 里 cat 一下作用域目录
// 就知道里面攒了什么，不必跑 list 命令。
// ═══════════════════════════════════════════════════════════════════════

async function rebuildIndex(scope) {
    const items = await listMemories({ scope });
    const lines = [
        `# Memory Index — ${scope}`,
        '',
        items.length === 0
            ? '_(empty)_'
            : items
                  .map((m) => `- ${m.name}: ${m.description} [${m.type}]`)
                  .join('\n'),
        ''
    ];
    await ensureScopeDir(scope);
    await fs.writeFile(path.join(scopeDir(scope), 'MEMORY.md'), lines.join('\n'), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════
// 注入到 system prompt
//
// 这是 memory 系统的"出口"。
// 主循环在会话起手时拿这段文本拼到 system prompt 里，
// 模型就能在第 1 轮就看到所有跨会话信息。
//
// 设计取舍：
//   - 同步函数 + 缓存：会话起手只调一次，之后由 /memory ignore 触发刷新。
//     用同步 readFile 是因为 memory 文件通常小、数量少，简化主循环逻辑
//     比省那点 IO 重要。
//   - 输出 markdown 而不是 JSON：让模型按"阅读"而不是"解析"来理解，
//     与 s05 技能描述列表的风格一致。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 加载所有作用域的 memory 并拼成 system prompt 用的文本段。
 * 如果当前处于 ignore 状态，返回空字符串。
 */
export function loadMemorySection() {
    if (_ignore) return '';

    const sections = [];
    for (const scope of SCOPE_LOAD_ORDER) {
        const dir = scopeDir(scope);
        let entries;
        try {
            // 用同步 API：会话起手只调一次，省去 async 链路传染
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        const items = [];
        for (const entry of entries) {
            if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
            try {
                const text = readFileSync(path.join(dir, entry), 'utf-8');
                const { meta, body } = parseFrontmatter(text);
                items.push({
                    name: meta.name || entry.replace(/\.md$/, ''),
                    description: meta.description || '',
                    type: meta.type || 'unknown',
                    body: body.trim()
                });
            } catch {
                // ignore broken file
            }
        }
        if (items.length === 0) continue;
        sections.push(`### ${scope} memory`);
        for (const it of items) {
            sections.push(`#### ${it.type} · ${it.name}`);
            if (it.description) sections.push(`> ${it.description}`);
            sections.push(it.body);
            sections.push('');
        }
    }

    if (sections.length === 0) return '';

    return [
        '',
        '## Memory（跨会话长期信息，仅供参考；与当前观察冲突时优先相信当前观察）',
        '',
        ...sections
    ].join('\n');
}

/**
 * 切换 ignore 状态。
 * 用户在某轮明确说"忽略 memory"时，主循环调用 setIgnoreMemory(true)
 * 并重新拼装 system prompt——按 memory 为空来工作。
 */
export function setIgnoreMemory(flag) {
    _ignore = !!flag;
}

export function isMemoryIgnored() {
    return _ignore;
}

/**
 * 把当前状态描述成一段适合 console.log 的文本，给 /memory 命令用。
 */
export async function describeMemoryState() {
    const items = await listMemories();
    const counts = items.reduce(
        (acc, m) => {
            acc.total += 1;
            acc.byScope[m.scope] = (acc.byScope[m.scope] || 0) + 1;
            acc.byType[m.type] = (acc.byType[m.type] || 0) + 1;
            return acc;
        },
        { total: 0, byScope: {}, byType: {} }
    );
    const lines = [
        `📒 Memory 状态`,
        `   总数: ${counts.total}`,
        `   ignore: ${_ignore ? 'on（本会话不注入 memory）' : 'off'}`,
        `   按作用域: ${JSON.stringify(counts.byScope)}`,
        `   按类型:   ${JSON.stringify(counts.byType)}`,
        `   存储根:   ${path.relative(process.cwd(), MEMORY_ROOT)}/`
    ];
    return lines.join('\n');
}
