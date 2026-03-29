---
name: git
description: Git 工作流与中文 Commit 规范 (UTF-8)
---
# Git Workflow Skill

## Commit 规范
- **语言**: 必须使用 **中文 (简体中文)** 编写 commit 描述。
- **格式**: 采用 `type(scope): 描述` 格式（符合 Conventional Commits）。
- **编码**: 必须确保输出为 **UTF-8** 编码，避免 GitHub 乱码。
- **常用类型**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`。

## 工作流步骤
1. 使用 `git status` 查看当前状态。
2. 使用 `git diff` 审查具体改动。
3. 使用 `git add <file>` 暂存文件。
4. 按照上述规范编写中文 commit 消息并执行 `git commit`。
5. 推送到远端分支。

## 说明
- 描述部分应简洁明了。
- 确保终端环境支持 UTF-8，以防止提交时描述信息丢失或损坏。
