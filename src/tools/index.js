import { writeFile, readFile } from './fs.js';
import { executeBash } from './bash.js';
import { todoManager } from './todo.js';
// 【s05 新增】导入技能加载器
import { SkillLoader } from './skill-loader.js';
import { requestManualCompact } from '../context/compact.js';
// 【s09 新增】记忆系统：跨会话保存 user/feedback/project/reference 长期信息
//   - 故意只在 parentTools 暴露这些工具：子 Agent 是短期任务，不该写跨会话记忆
//   - saveMemory / listMemories / deleteMemory 都是异步函数，路由层 await 即可
import { saveMemory, listMemories, deleteMemory, MEMORY_TYPES, MEMORY_SCOPES } from '../memory/index.js';
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
    // 【s09 新增】记忆系统三件套 —— save / list / delete
    //
    // 为什么放在 parentTools 而不是 childTools？
    //   子 Agent 是短期、独立上下文的执行者，没有"跨会话留下东西"的语义。
    //   只有父 Agent 才是会话的"主人"，写 memory 是它的责任。
    //
    // 描述里反复强调"边界"是为了让模型自己学会拒绝写无关信息：
    //   memory 不是临时草稿，更不是当前任务进度。
    {
        type: 'function',
        function: {
            name: 'save_memory',
            description: `Save a long-term memory that should persist across sessions.
ONLY use this when the information is BOTH:
  (1) likely useful in future conversations, AND
  (2) cannot be easily re-derived by reading the current codebase.

DO NOT use for: file structure, function signatures, current task progress, branch names, bug-fix details, or anything observable from code.

Choose type carefully:
  - user:      user's long-term preferences (e.g. coding style, verbosity)
  - feedback:  a correction the user made that should generalize
  - project:   non-obvious project background / convention / compliance reason
  - reference: pointer to an external resource (board, dashboard, docs URL)

Default scope is 'private' (only this user). Use 'team' only when the info is meant for the whole team.`,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short identifier (lowercase, will be slugified)' },
                    description: { type: 'string', description: 'One-line summary shown in the index' },
                    type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Memory category' },
                    content: { type: 'string', description: 'Body text (markdown allowed)' },
                    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'private (default) or team' }
                },
                required: ['name', 'description', 'type', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_memories',
            description: 'List saved memories. Use this when you suspect a relevant memory exists but is not in the current system prompt (e.g. after /memory ignore was toggled).',
            parameters: {
                type: 'object',
                properties: {
                    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Limit to one scope; omit for all' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_memory',
            description: 'Delete a memory by name. Use when a saved memory is wrong, outdated, or no longer relevant. scope is REQUIRED to avoid accidentally deleting a team memory with the same name as a private one.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Memory name to delete' },
                    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Which scope to delete from' }
                },
                required: ['name', 'scope']
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

        // 【s09 新增】记忆系统 —— 三个工具共用同一个 memory 模块
        // 注意所有返回值都用 JSON.stringify 转字符串：
        //   tool result 必须是字符串，模型才能稳定解析；
        //   结构化对象必须先序列化再返回。
        case 'save_memory': {
            const result = await saveMemory({
                name: toolArgs.name,
                description: toolArgs.description,
                type: toolArgs.type,
                content: toolArgs.content,
                scope: toolArgs.scope
            });
            return `已保存 memory: ${result.name} [${result.scope}] → ${result.path}`;
        }

        case 'list_memories': {
            const items = await listMemories({ scope: toolArgs.scope });
            if (items.length === 0) return '(no memories)';
            // 给模型一份紧凑的列表，每行一条；模型如果需要正文再调 read_file 即可
            return items
                .map((m) => `- [${m.scope}/${m.type}] ${m.name}: ${m.description} (${m.path})`)
                .join('\n');
        }

        case 'delete_memory': {
            const result = await deleteMemory({ name: toolArgs.name, scope: toolArgs.scope });
            return result.ok
                ? `已删除 memory: ${result.name} [${result.scope}]`
                : `未删除：${result.reason}`;
        }

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