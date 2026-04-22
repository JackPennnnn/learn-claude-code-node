import fs from 'node:fs/promises';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════
// 文件读写工具的"沙盒根目录"
//
// 所有工具操作的文件都必须落在这个目录里——
// 既是为了让 data/ 这个目录约定可控，
// 也是 s07 权限思想的延伸：工具自己也应当"自我约束"，
// 不允许通过 ../ 之类的相对路径跳出沙盒。
// ═══════════════════════════════════════════════════════════════════════
const SAVE_PATH = './data';
// 解析一次绝对路径，方便后面做 startsWith 判断（避免每次都重算）
const SAVE_ROOT = path.resolve(SAVE_PATH);

/**
 * 把模型传进来的 filename 归一化成"data 目录下的绝对路径"。
 *
 * 解决三个常见坑：
 *   1. 模型有时会自作主张把 'data/' 前缀也写进 filename，
 *      结果 path.join('./data', 'data/foo.txt') 变成 data/data/foo.txt。
 *      → 这里主动去掉一次开头的 'data/' 或 './data/'。
 *
 *   2. 模型偶尔会传绝对路径 '/foo.txt'，
 *      path.join 在这种情况下行为不直观。
 *      → 把开头的 '/' 当作相对根来处理。
 *
 *   3. 防止 '../../etc/passwd' 这种越狱写法跳出 data/ 沙盒。
 *      → 用 path.resolve 解析后检查是否仍在 SAVE_ROOT 之下。
 *
 * @param {string} filename
 * @returns {{ ok: true, abs: string, rel: string } | { ok: false, error: string }}
 */
function resolveSafePath(filename) {
    if (typeof filename !== 'string' || filename.trim() === '') {
        return { ok: false, error: '文件名不能为空' };
    }

    let cleaned = filename.trim();

    cleaned = cleaned.replace(/^\.?\/+/, '');
    cleaned = cleaned.replace(/^data\/+/, '');

    const abs = path.resolve(SAVE_ROOT, cleaned);

    // 必须仍在 SAVE_ROOT 之下，等价于 abs 以 SAVE_ROOT + sep 开头
    // 这一步是真正挡住 '../../' 越狱的关键
    if (abs !== SAVE_ROOT && !abs.startsWith(SAVE_ROOT + path.sep)) {
        return { ok: false, error: `路径越界：${filename} 不在 data/ 沙盒内` };
    }

    return { ok: true, abs, rel: path.relative(SAVE_ROOT, abs) || '.' };
}

/**
 * 写入文件
 *
 * @param {string} filename 文件名（相对 data/，自动去掉重复的 'data/' 前缀）
 * @param {string} content 文件内容
 * @returns {Promise<string>} 人类可读的执行结果
 */
export const writeFile = async (filename, content) => {
    const resolved = resolveSafePath(filename);
    if (!resolved.ok) {
        return `❌ 写入文件失败: ${resolved.error}`;
    }

    try {
        // 写入文件前先把所在目录建好（支持 'a/b/c.txt' 这种带子目录的写法）
        await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
        await fs.writeFile(resolved.abs, content ?? '', 'utf8');
        return `✅ 文件已成功写入至: data/${resolved.rel}`;
    } catch (error) {
        // 永远不要直接 throw，否则会让 tool_call 拿不到 tool_result
        return `❌ 写入文件失败: ${error.message}`;
    }
}

/**
 * 读取文件
 *
 * @param {string} filename 文件名（相对 data/，自动去掉重复的 'data/' 前缀）
 * @returns {Promise<string>} 文件内容；失败时返回错误说明字符串
 */
export const readFile = async (filename) => {
    const resolved = resolveSafePath(filename);
    if (!resolved.ok) {
        return `❌ 读取文件失败: ${resolved.error}`;
    }

    try {
        return await fs.readFile(resolved.abs, 'utf8');
    } catch (error) {
        // 把错误包成可读字符串返回，模型才能基于这个反馈自我修正
        // （比如换个文件名再试一次，而不是整个对话报错挂掉）
        if (error.code === 'ENOENT') {
            return `❌ 读取文件失败: 文件不存在 data/${resolved.rel}`;
        }
        return `❌ 读取文件失败: ${error.message}`;
    }
}
