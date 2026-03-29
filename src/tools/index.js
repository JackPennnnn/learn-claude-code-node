import { writeFile, readFile } from './fs.js';
import { executeBash } from './bash.js';
import { todoManager } from './todo.js';

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