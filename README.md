# Claude Code From Scratch

**一步一步，从零造一个 Claude Code**

> 🍴 **Fork 自 [Windy3f3f3f3f/claude-code-from-scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch)**，感谢原作者 [@Windy3f3f3f3f](https://github.com/Windy3f3f3f3f) 的优秀教程。
>
> 在线教程仍在[原项目站点](https://windy3f3f3f3f.github.io/claude-code-from-scratch/)。
>
> 📖 **姊妹项目**：[How Claude Code Works](https://github.com/Windy3f3f3f3f/how-claude-code-works) — 12 篇专题，33 万字，从源码级别深度解析 Claude Code 架构。

---

本项目用 **~3400 行 TypeScript** 复现了 Claude Code 的核心架构——Agent Loop、13 个工具（含并行执行 + 流式早期启动）、4 层上下文压缩、语义记忆召回、技能系统、多 Agent、MCP 集成。每一步都对照真实源码讲解"它怎么做的 → 我们怎么简化的"。

## 📖 分步教程

13 章内容，从基础到进阶逐步构建一个可用的 Coding Agent：

| 章节 | 内容 |
|------|------|
| **Phase 1: 构建一个可用的 Coding Agent** | |
| [1. Agent Loop](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/01-agent-loop) | 核心循环：调用 LLM → 执行工具 → 重复 |
| [2. 工具系统](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/02-tools) | 13 个工具 + mtime 防护 + 延迟加载 |
| [3. System Prompt](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/03-system-prompt) | 提示词工程 + @include 语法 |
| [4. CLI 与会话](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/04-cli-session) | REPL、Ctrl+C、会话持久化 |
| [5. 流式输出](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/05-streaming) | Anthropic 流式 + 流式工具执行 + 并行执行 |
| [6. 权限与安全](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/06-permissions) | 5 模式 + 声明式规则 + 危险检测 |
| [7. 上下文管理](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/07-context) | 4 层压缩 + 大结果持久化 |
| **Phase 2: 进阶能力** | |
| [8. 记忆系统](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/08-memory) | 语义召回 + 4 类型记忆 + 异步预取 |
| [9. 技能系统](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/09-skills) | inline/fork 双模式 |
| [10. Plan Mode](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/10-plan-mode) | 只读规划 + 审批工作流 |
| [11. 多 Agent](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/11-multi-agent) | Sub-Agent fork-return 架构 |
| [12. MCP 集成](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/12-mcp) | JSON-RPC over stdio |
| [13. 架构对比](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/13-whats-next) | 完整对比 + 扩展方向 |
| [14. 功能测试](https://windy3f3f3f3f.github.io/claude-code-from-scratch/#/docs/14-testing) | 19 项手动测试覆盖全部功能 |

## 🚀 快速开始

```bash
git clone https://github.com/joinmouse/claude-code-mini.git
cd claude-code-mini
npm install && npm run build
```

### 配置 API

```bash
export ANTHROPIC_API_KEY="sk-ant-xxx"
# 可选：使用代理
export ANTHROPIC_BASE_URL="https://aihubmix.com"
# 可选：自定义模型（默认 claude-opus-4-6）
export MINI_CLAUDE_MODEL="claude-sonnet-4-6"
```

### 运行

```bash
npm start                    # 交互式 REPL 模式
npm start -- --resume        # 恢复上次会话
npm start -- --yolo          # 跳过安全确认
npm start -- --plan          # Plan 模式：只分析不修改
npm start -- --max-cost 0.50 # 费用限制（美元）
npm start -- --max-turns 20  # 轮次限制
```

### REPL 命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清空对话历史 |
| `/cost` | 显示累计 token 用量和费用 |
| `/compact` | 手动触发对话压缩 |
| `/memory` | 列出所有已保存的记忆 |
| `/skills` | 列出可用的技能 |

## ⚡ 核心能力

- **Agent Loop**：LLM 调用 → 工具执行 → 结果注入 → 循环迭代
- **13 个工具**：读写文件、搜索、Shell、WebFetch、ToolSearch、技能、子 Agent、Plan Mode
- **流式输出**：Anthropic 流式 API，逐字实时显示，流式工具早期执行
- **并行执行**：只读工具自动并发，2-3x 加速
- **上下文压缩**：4 层压缩（budget 截断 → stale snip → microcompact → auto-compact）+ 大结果持久化
- **权限系统**：5 种模式 + `.claude/settings.json` 规则 + 危险命令正则检测
- **记忆系统**：4 类型记忆 + 语义召回 + 异步预取
- **技能系统**：`.claude/skills/` 加载，inline/fork 双模式
- **多 Agent**：Sub-Agent fork-return（3 内置 + `.claude/agents/` 自定义）
- **MCP 集成**：JSON-RPC over stdio，动态工具发现
- **预算控制**：费用 + 轮次双重限制
- **会话持久化**：自动保存，`--resume` 恢复

## 📁 项目结构

```
src/
├── agent.ts        # Agent 循环：流式、并行执行、4 层压缩、预算
├── tools.ts        # 13 工具 + mtime 防护 + 延迟加载
├── cli.ts          # CLI 入口：参数解析、REPL
├── memory.ts       # 记忆系统：语义召回 + 异步预取
├── mcp.ts          # MCP 客户端：JSON-RPC over stdio
├── prompt.ts       # System Prompt：@include + 模板注入
├── ui.ts           # 终端输出渲染
├── subagent.ts     # 子 Agent：发现 + 调度
├── skills.ts       # 技能系统：inline/fork 双模式
├── session.ts      # 会话持久化
├── frontmatter.ts  # YAML frontmatter 解析
```

## 🔀 与原始版本的区别

> 原始版本：[Windy3f3f3f3f/claude-code-from-scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch)

本 Fork 在原项目基础上做了以下精简：

| 移除/精简项 | 说明 |
|-------------|------|
| **Python 实现** | 原始版本同时提供了 Python 和 TypeScript 双版本实现，本 Fork 仅保留 TypeScript 版本 |
| **OpenAI 兼容后端** | 原始版本支持 Anthropic + OpenAI 双后端，本 Fork 仅保留 Anthropic API |
| **多语言支持** | 原始版本包含中文/英文/日语等多语言文档，本 Fork 保留中文/英文 |
| **CI/CD 配置** | 移除了 GitHub Actions 等自动化流水线配置 |
| **Docker 部署** | 移除了 Dockerfile 和容器化相关配置 |
| **贡献者/Star History** | 移除不适用于 Fork 的展示内容 |

**保留完整**：13 章教程内容、所有源码（agent/tools/memory/mcp/skills/subagent/prompt/cli/ui/session）、测试套件、在线教程站点。

## 📄 License

MIT
