import fs from 'node:fs/promises';
import path from 'node:path';
const SAVE_PATH = './data';

/**f
 * 写入文件
 * @param {string} filename 文件名
 * @param {string} content 文件内容
 * @returns {Promise<string>} 文件路径
 */
export const writeFile = async (filename, content) => {
    try {
        // 1. 不管文件夹在不在，直接调这个，recursive: true 保证了不会报错且能创建成功
        await fs.mkdir(SAVE_PATH, { recursive: true });

        // 2. 使用 path.join 拼接路径，比手动加 "/" 更安全，能自动处理跨平台斜杠问题
        const filePath = path.join(SAVE_PATH, filename);

        await fs.writeFile(filePath, content, 'utf8');
        return `✅ 文件已成功写入至: ${filePath}`;
    } catch (error) {
        // 记得返回错误信息，否则 Agent 会报那个 400 错误
        return `❌ 写入文件失败: ${error.message}`;
    }
}

/**
 * 读取文件
 * @param {string} filename 文件名
 * @returns {Promise<string>} 文件内容
 */
export const readFile = async (filename) => {
    const filePath = path.join(SAVE_PATH, filename);
    return await fs.readFile(filePath, 'utf8');
}