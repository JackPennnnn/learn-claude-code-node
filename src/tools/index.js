import { writeFile, readFile } from './fs.js';
import { executeBash } from './bash.js';
import { todoManager } from './todo.js';
export const tools = [
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
            name: 'write_file',
            description: '当用户需要编辑文件内容时，可以使用该工具',
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

export const executeTool = async (toolName, toolArgs) => {
    switch (toolName) {
        case 'write_file':

            return await writeFile(toolArgs.path, toolArgs.content);
            break;
        case 'read_file':

            return await readFile(toolArgs.path);
            break;
        case 'execute_bash':
            return await executeBash(toolArgs.command);
            break;
        // s03: todo tool execution
        case 'todo':
            return todoManager.update(toolArgs.items);
            break;
    }
}