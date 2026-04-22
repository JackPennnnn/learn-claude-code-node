/**
 * Bash 最小安全检查 — s07 配套模块
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么 bash 要被特殊对待？
 *
 *   read_file 只能读文件、write_file 只能写文件，
 *   这两类工具的"破坏半径"是有限的。
 *
 *   但 execute_bash 几乎可以做任何事：
 *     - 删数据库
 *     - 改系统配置
 *     - 通过命令替换偷偷执行别的命令
 *     - 把磁盘写废
 *
 *   所以 s07 文章里特地强调：
 *     "bash 不是普通文本，而是可执行动作描述。"
 *
 *   完整的安全分析应该用 AST 解析 shell 语法树，
 *   但教学版做最小可用的"模式匹配"已经能挡掉绝大多数明显危险。
 * ═══════════════════════════════════════════════════════════════
 *
 * 设计原则：
 *   1. 只判断"明显危险"，不做完整 shell 语法分析
 *   2. 命中即拒绝，附带可读的 reason
 *   3. 不命中 ≠ 安全，只是"没踩到这层雷"，后续还会过 ask 环节
 */

// 危险模式表 —— 每条记录包含一个匹配函数和拒绝原因
// 用函数而不是单纯的正则，可以表达更复杂的判断（例如 sudo 必须是独立 token）
const DANGEROUS_PATTERNS = [
    {
        // sudo 提权：教学环境绝对不允许
        // 用 \b 边界避免误伤 "pseudo" 这种带 sudo 子串的词
        test: (cmd) => /\bsudo\b/.test(cmd),
        reason: 'sudo 提权命令被禁止'
    },
    {
        // rm -rf / rm -fr / rm -r -f 等组合
        // 这是删库跑路的经典姿势，先无脑挡掉
        test: (cmd) => /\brm\s+(-[rRfF]+|-[rRfF]\s+-[rRfF])/.test(cmd),
        reason: 'rm -rf 类强制递归删除被禁止'
    },
    {
        // 命令替换 $(...) 或 反引号
        // 这两种语法允许在命令中嵌入"先执行另一段命令再把结果拼回来"，
        // 是绕过任何字符串黑名单的常见手段
        test: (cmd) => /\$\([^)]*\)|`[^`]*`/.test(cmd),
        reason: '检测到命令替换 $() 或反引号，存在注入风险'
    },
    {
        // 直接写设备文件（/dev/sda、/dev/null 之外的设备）
        // 误操作可能把整块磁盘清零
        test: (cmd) => />\s*\/dev\/(sd[a-z]|nvme|hd[a-z]|disk)/.test(cmd),
        reason: '检测到向块设备写入，可能损坏磁盘'
    },
    {
        // 经典 fork bomb，单字符就能让系统挂掉
        test: (cmd) => /:\(\)\s*\{.*\|.*&\s*\}\s*;\s*:/.test(cmd),
        reason: '检测到疑似 fork bomb'
    }
];

/**
 * 检查 bash 命令是否命中任意危险模式
 *
 * @param {string} command - 完整的 shell 命令字符串
 * @returns {{ matched: boolean, reason: string }}
 *   matched=true 表示命中了某条危险规则，应当拒绝
 *   matched=false 表示通过了这一层，但不代表绝对安全
 */
export function checkBashSafety(command) {
    if (typeof command !== 'string' || command.trim() === '') {
        return { matched: false, reason: '' };
    }

    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
            return { matched: true, reason: pattern.reason };
        }
    }
    return { matched: false, reason: '' };
}
