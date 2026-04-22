/**
 * 共享 readline 单例 — s07 配套基础设施
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么要单独抽一个文件？
 *   原本 readline 实例只在 src/index.js 的 main() 里创建，
 *   只有主循环能用它和用户对话。
 *
 *   s07 的权限系统在工具执行前可能需要弹出 [y/N] 确认，
 *   也就是说"非主循环"的代码也要能向用户提问。
 *
 *   如果在权限模块里再 createInterface 一次，
 *   两个 readline 会同时抢 stdin，行为不可预测。
 *
 *   解决办法：把 readline 升级成模块级单例，
 *   主循环、权限系统、未来可能的 hook 系统都共用同一个 rl。
 * ═══════════════════════════════════════════════════════════════
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// 整个进程只会创建一次 readline 接口
// 任何模块只要 import { rl }，拿到的都是同一个实例
export const rl = readline.createInterface({ input, output });
