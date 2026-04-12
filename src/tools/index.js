import { writeFile, readFile } from './fs.js';
import { executeBash } from './bash.js';
import { todoManager } from './todo.js';
// 【s05 新增】导入技能加载器
import { SkillLoader } from './skill-loader.js';
import { requestManualCompact } from '../context/compact.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════════════
// 【s05 新增】初始化技能加载器
//
// __dirname 在 ESM 模块中不可用，需要手动计算
// 技能目录位于项目根目录下的 skills/ 文件夹
// ═══════════════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
export const skillLoader = new SkillLoader(path.join(PROJECT_ROOT, 'skills'));

// ═══════════════════════════════════════════════════════════════════════
// 【s04 核心改动】工具分层
//
// 为什么要分层？
//   父 Agent 可以调用 task 工具来派发子任务，
//   但子 Agent 不能调用 task 工具——否则就会无限递归：
//     父 Agent → task → 子 Agent → task → 子子 Agent → task → ...
//
// 所以我们把工具分成两层：
//   childTools  = 基础工具（read_file, write_file, execute_bash, todo）
//   parentTools = childTools + task 工具
//
// 父 Agent 使用 parentTools，子 Agent 使用 childTools
// ═══════════════════════════════════════════════════════════════════════

/**
 * childTools —— 子 Agent 可用的基础工具集
 *
 * 这些工具在父 Agent 和子 Agent 中都可以使用。
 * 子 Agent 只能用这些工具，不能用 task 工具。
 */
export const childTools = [
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: '当用户需要将内容写入文件时，可以使用该工具',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件路径' },
                    content: { type: 'string', description: '文件内容' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: '当用户需要读取文件内容时，可以使用该工具',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件路径' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_bash',
            description: '当用户需要执行bash命令时，可以使用该工具',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'bash命令' }
                }
            }
        }
    },
    // s03 todo tool - let the model manage its own task list
    {
        type: 'function',
        function: {
            name: 'todo',
            description: 'Update task list. Track progress on multi-step tasks. Use this to plan before acting.',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        description: 'Full task list (replaces previous list)',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'Unique task ID' },
                                text: { type: 'string', description: 'Task description' },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'in_progress', 'completed'],
                                    description: 'pending / in_progress / completed'
                                }
                            },
                            required: ['id', 'text', 'status']
                        }
                    }
                },
                required: ['items']
            }
        }
    },
    // 【s05 新增】load_skill 工具 —— 按需加载技能内容
    // 为什么放在 childTools 而不是 parentTools？
    //   因为加载技能只是读取文本，没有递归风险，
    //   子 Agent 也应该能加载技能来获取领域知识。
    {
        type: 'function',
        function: {
            name: 'load_skill',
            description: 'Load a skill by name to get detailed instructions. Use this when you need domain-specific guidance (e.g., git workflow, code review checklist). Check the system prompt for available skill names.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the skill to load (e.g., "git", "code-review")'
                    }
                },
                required: ['name']
            }
        }
    }
];

/**
 * parentTools —— 父 Agent 专用的完整工具集
 *
 * 【s04 新增】在 childTools 的基础上，增加了 task 工具。
 * task 工具让父 Agent 可以派发子任务给一个全新的子 Agent，
 * 子 Agent 运行完毕后只返回摘要，不污染父 Agent 的上下文。
 *
 * 注意 parentTools 用的是扩展运算符 [...childTools]，
 * 这样 childTools 的任何修改都会自动反映到 parentTools 中。
 */
export const parentTools = [
    ...childTools,
    // 【s06 新增】compact 工具 —— 手动触发完整压缩
    // 这个工具本身不直接生成摘要，只是发出“下一轮必须压缩”的信号。
    // 真正执行仍复用 maybeCompactMessages() / compactHistory()，
    // 这样自动压缩和手动压缩始终共用同一条实现路径。
    {
        type: 'function',
        function: {
            name: 'compact',
            description: 'Compact the current conversation history for continuity. Use this when the context feels crowded or when you want to proactively summarize progress.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    // 【s04 新增】task 工具 —— 分派子任务
    {
        type: 'function',
        function: {
            name: 'task',
            description: `Spawn a subagent with fresh context to handle a subtask.
The subagent has its own clean message history and access to basic tools (read_file, write_file, execute_bash, todo).
Use this to delegate work that would clutter the current context.
The subagent will return a summary of what it did.`,
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Detailed description of the subtask for the subagent to execute'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

// 【s04 兼容】保留 tools 导出名，指向 parentTools
// 这样如果有其他地方引用了 tools，不会报错
export const tools = parentTools;

/**
 * executeTool —— 工具执行路由
 *
 * 根据工具名称分发到对应的处理函数。
 * 【s04 新增】增加了 task 工具的处理，使用延迟导入避免循环依赖。
 */
export const executeTool = async (toolName, toolArgs) => {
    switch (toolName) {
        case 'write_file':
            return await writeFile(toolArgs.path, toolArgs.content);

        case 'read_file':
            return await readFile(toolArgs.path);

        case 'execute_bash':
            return await executeBash(toolArgs.command);

        // s03: todo tool execution
        case 'todo':
            return todoManager.update(toolArgs.items);

        // 【s05 新增】load_skill 工具 —— 按需加载技能完整内容
        // 这是"第二层"加载：模型在 system prompt 中看到技能名称后，
        // 决定需要某个技能时，调用此工具获取完整指令
        case 'load_skill':
            return skillLoader.getContent(toolArgs.name);

        case 'compact':
            requestManualCompact();
            return '已请求执行上下文压缩。下一轮思考前会复用统一的 compact 逻辑生成连续性摘要。';

        // 【s04 新增】task 工具 —— 启动子智能体
        // 为什么用动态 import() 而不是顶部 import？
        //   因为 subagent.js 也 import 了当前文件（index.js），
        //   如果两边都在顶部 import，会形成循环依赖。
        //   动态 import() 在运行时才加载，避免了这个问题。
        case 'task': {
            const { runSubAgent } = await import('./subagent.js');
            return await runSubAgent(toolArgs.prompt);
        }

        default:
            return `未知工具: ${toolName}`;
    }
};