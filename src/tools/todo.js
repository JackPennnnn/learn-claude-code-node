/**
 * TodoManager — s03 的核心模块
 *
 * 解决的问题：
 *   多步任务中，模型会随着对话变长而"丢失进度"——重复做过的事、跳步、跑偏。
 *
 * 设计思路：
 *   1. 给 Agent 一个结构化的任务清单，让它自己写、自己更新
 *   2. 同一时间只允许一个任务处于 in_progress，强制"顺序聚焦"
 *   3. 通过 render() 输出人类可读的清单，方便我们观察 Agent 的规划过程
 *
 * 状态流转：
 *   pending  →  in_progress  →  completed
 *   [ ]          [>]             [x]
 */

class TodoManager {
    constructor() {
        /**
         * 存储所有任务项
         * 每项格式: { id: string, text: string, status: 'pending' | 'in_progress' | 'completed' }
         */
        this.items = [];
    }

    /**
     * 更新整个任务列表（全量替换）
     *
     * 为什么是全量替换而不是增量更新？
     *   因为让 LLM 做增量操作（"把第3个改成completed"）容易出错，
     *   全量替换更简单可靠——模型每次提交完整的列表，我们做校验就行。
     *
     * @param {Array} items - 任务项数组，每项包含 id, text, status
     * @returns {string} 渲染后的任务清单文本
     * @throws {Error} 校验不通过时抛出错误
     */
    update(items) {
        // 【校验 1】限制最多 20 个任务，防止模型无限拆分
        if (items.length > 20) {
            throw new Error('最多允许 20 个任务');
        }

        const validated = [];       // 校验通过的任务列表
        let inProgressCount = 0;    // 统计 in_progress 的数量

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const id = String(item.id || (i + 1));              // 默认用序号作为 id
            const text = String(item.text || '').trim();        // 任务描述，去除首尾空格
            const status = String(item.status || 'pending').toLowerCase(); // 默认状态为 pending

            // 【校验 2】任务描述不能为空
            if (!text) {
                throw new Error(`任务 #${id}: text 不能为空`);
            }

            // 【校验 3】status 只能是三种之一
            if (!['pending', 'in_progress', 'completed'].includes(status)) {
                throw new Error(`任务 #${id}: 无效的状态 '${status}'，只能是 pending / in_progress / completed`);
            }

            // 统计 in_progress 数量
            if (status === 'in_progress') {
                inProgressCount++;
            }

            validated.push({ id, text, status });
        }

        // 【校验 4】核心规则——同时只能有一个 in_progress
        // 这迫使模型按顺序一个一个完成任务，不会"贪多嚼不烂"
        if (inProgressCount > 1) {
            throw new Error('同一时间只能有一个任务处于 in_progress 状态');
        }

        // 校验全部通过，替换内部状态
        this.items = validated;

        // 返回渲染后的文本，模型会在上下文中看到当前的任务状态
        return this.render();
    }

    /**
     * 将任务列表渲染为人类可读的文本
     *
     * 输出示例：
     *   [x] #1: 创建项目目录结构
     *   [>] #2: 编写 utils.py        ← 正在进行
     *   [ ] #3: 编写单元测试
     *
     *   (1/3 completed)
     *
     * @returns {string} 格式化后的任务清单
     */
    render() {
        if (this.items.length === 0) {
            return 'No todos.';
        }

        // 状态 → 图标的映射
        const markers = {
            pending: '[ ]',       // 待做
            in_progress: '[>]',   // 进行中
            completed: '[x]'      // 已完成
        };

        const lines = this.items.map(item => {
            const marker = markers[item.status];
            return `${marker} #${item.id}: ${item.text}`;
        });

        // 在底部添加完成进度统计
        const doneCount = this.items.filter(t => t.status === 'completed').length;
        lines.push(`\n(${doneCount}/${this.items.length} completed)`);
        return lines.join('\n');
    }
}

// 导出单例 —— 整个 Agent 生命周期共享同一个 TodoManager
// 这样模型在不同轮次的调用中都能看到同一份任务列表
export const todoManager = new TodoManager();
