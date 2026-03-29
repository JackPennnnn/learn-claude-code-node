/**
 * SkillLoader — s05 的核心模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 解决的问题：
 *   你希望 Agent 遵循特定领域的工作流（git 约定、测试模式、代码审查等），
 *   但全塞进 system prompt 太浪费：
 *     10 个技能 × 2000 tokens/技能 = 20,000 tokens
 *   大部分跟当前任务毫无关系，白白消耗上下文窗口。
 *
 * 解决思路："用到什么知识，临时加载什么知识"
 *   采用两层设计：
 *     第一层（System Prompt）：只放技能名称 + 一句话描述，低成本 ~100 tokens/技能
 *     第二层（Tool Result）：模型调用 load_skill 时，才注入完整内容 ~2000 tokens
 *
 * 技能文件格式（SKILL.md）：
 *   ---
 *   name: git
 *   description: Git workflow helpers
 *   ---
 *   这里是完整的技能指令内容...
 *
 * 目录结构：
 *   skills/
 *   ├── git/
 *   │   └── SKILL.md
 *   └── code-review/
 *       └── SKILL.md
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import path from 'node:path';

export class SkillLoader {
    constructor(skillsDir) {
        /**
         * 技能注册表
         * key: 技能名称（如 'git'）
         * value: { meta: { name, description }, body: '完整技能内容' }
         */
        this.skills = {};

        /**
         * 技能目录的绝对路径
         */
        this.skillsDir = path.resolve(skillsDir);

        // 构造时立即扫描技能目录
        this._loadSkills();
    }

    /**
     * 递归扫描技能目录，加载所有 SKILL.md 文件
     *
     * 为什么用递归扫描？
     *   技能可能嵌套在子目录中，比如 skills/advanced/git/SKILL.md
     *   递归扫描可以支持任意深度的目录结构
     *
     * 为什么用目录名作为默认技能名？
     *   这样你只需要创建一个目录 + SKILL.md，不需要额外配置
     *   当然 SKILL.md 的 frontmatter 中也可以显式指定 name
     */
    _loadSkills() {
        // 如果技能目录不存在，静默跳过（项目可能还没创建技能）
        if (!fs.existsSync(this.skillsDir)) {
            console.log(`📚 [Skills] 技能目录不存在: ${this.skillsDir}，跳过加载`);
            return;
        }

        // 递归查找所有 SKILL.md 文件
        const skillFiles = this._findSkillFiles(this.skillsDir);

        for (const filePath of skillFiles) {
            try {
                const text = fs.readFileSync(filePath, 'utf-8');
                const { meta, body } = this._parseFrontmatter(text);

                // 技能名称优先用 frontmatter 中的 name，否则用目录名
                // 例如 skills/git/SKILL.md → 技能名 'git'
                const name = meta.name || path.basename(path.dirname(filePath));

                this.skills[name] = { meta, body };
                console.log(`📚 [Skills] 已加载技能: ${name} — ${meta.description || '(无描述)'}`);
            } catch (err) {
                console.error(`📚 [Skills] 加载失败: ${filePath} — ${err.message}`);
            }
        }

        console.log(`📚 [Skills] 共加载 ${Object.keys(this.skills).length} 个技能\n`);
    }

    /**
     * 递归查找目录下所有 SKILL.md 文件
     *
     * @param {string} dir - 要搜索的目录
     * @returns {string[]} SKILL.md 文件的绝对路径数组
     */
    _findSkillFiles(dir) {
        const results = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // 递归搜索子目录
                results.push(...this._findSkillFiles(fullPath));
            } else if (entry.name === 'SKILL.md') {
                results.push(fullPath);
            }
        }

        return results;
    }

    /**
     * 解析 SKILL.md 的 YAML Frontmatter
     *
     * Frontmatter 是 Markdown 文件顶部用 --- 包裹的元数据区域：
     *   ---
     *   name: git
     *   description: Git workflow helpers
     *   ---
     *   正文内容...
     *
     * 为什么不用专业的 YAML 解析库？
     *   我们只需要提取 name 和 description 这两个简单字段，
     *   用正则就够了，不值得引入额外依赖。
     *
     * @param {string} text - SKILL.md 的完整文本
     * @returns {{ meta: object, body: string }} 元数据 + 正文
     */
    _parseFrontmatter(text) {
        // 匹配 --- 包裹的区域
        const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

        if (!match) {
            // 没有 frontmatter，整个文件都是正文
            return { meta: {}, body: text.trim() };
        }

        const frontmatterStr = match[1];
        const body = match[2].trim();

        // 简易 YAML 解析：逐行提取 key: value
        const meta = {};
        for (const line of frontmatterStr.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.substring(0, colonIdx).trim();
                const value = line.substring(colonIdx + 1).trim();
                meta[key] = value;
            }
        }

        return { meta, body };
    }

    /**
     * 获取所有技能的描述摘要（用于注入 System Prompt）
     *
     * 这是"第一层"——低成本地告诉模型有哪些技能可用。
     * 每个技能只占一行（~100 tokens），即使有很多技能也不会太贵。
     *
     * 输出示例：
     *   - git: Git workflow helpers
     *   - code-review: Code review checklist
     *
     * @returns {string} 格式化后的技能描述列表
     */
    getDescriptions() {
        const names = Object.keys(this.skills);
        if (names.length === 0) {
            return '(no skills loaded)';
        }

        const lines = names.map(name => {
            const desc = this.skills[name].meta.description || '(无描述)';
            return `  - ${name}: ${desc}`;
        });

        return lines.join('\n');
    }

    /**
     * 获取指定技能的完整内容（用于 load_skill 工具的返回值）
     *
     * 这是"第二层"——高成本但按需加载。
     * 只有当模型调用 load_skill("git") 时，才会把完整的 Git 工作流指令
     * 注入到上下文中（通过 tool_result）。
     *
     * 返回格式用 <skill> 标签包裹，让模型明确知道这是技能内容：
     *   <skill name="git">
     *   完整的技能指令...
     *   </skill>
     *
     * @param {string} name - 技能名称
     * @returns {string} 包裹在 <skill> 标签中的技能内容，或错误提示
     */
    getContent(name) {
        const skill = this.skills[name];

        if (!skill) {
            // 技能不存在，返回友好的错误提示 + 可用技能列表
            const available = Object.keys(this.skills).join(', ') || '(none)';
            return `Error: Unknown skill '${name}'. Available skills: ${available}`;
        }

        // 用 <skill> 标签包裹，让模型知道这是结构化的技能指令
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}
