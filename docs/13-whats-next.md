# 13. 架构对比 & 后续

## 完整架构对比

| 组件 | Claude Code | mini-claude |
|------|------------|-------------|
| **Agent Loop** | 7 种 continue reason | 只检查 tool_use |
| **工具数量** | 66+ | 13 |
| **工具执行** | StreamingToolExecutor 并发 | 流式提前 + 只读并行 |
| **System Prompt** | static/dynamic 分界 + API 缓存 | 无缓存 |
| **权限系统** | 7 层 + AST + 8 源规则 | 5 模式 + 规则 + 正则 + 确认 |
| **上下文** | 5 级压缩 | 4 层 |
| **记忆** | 4 类型 + 语义 + MEMORY.md | 4 类型 + 语义 + MEMORY.md + 预取 |
| **技能** | 6 源 + 懒加载 + inline/fork | 2 源 + 预加载 + inline/fork |
| **多 Agent** | Sub + 自定义 + Coordinator + Swarm | Sub（3 内置 + 自定义） |
| **MCP** | mcpClient.ts + 动态发现 | McpManager + JSON-RPC over stdio |
| **预算** | USD/轮次/abort 三维 | USD + 轮次 |
| **编辑验证** | 14 步 | 引号容错 + 唯一性 + diff + read-before-edit + mtime |

## 文件映射

| mini-claude | Claude Code |
|-------------|-------------|
| `src/agent.ts` | `src/query.ts` + `src/QueryEngine.ts` |
| `src/tools.ts` | `src/Tool.ts` + `src/tools/`（66 目录） |
| `src/prompt.ts` | `src/constants/prompts.ts` + `src/utils/claudemd.ts` |
| `src/cli.ts` | `src/entrypoints/cli.tsx` + `src/commands/` |
| `src/ui.ts` | `src/components/`（React/Ink） |
| `src/session.ts` | `src/utils/sessionStorage.ts` + `src/history.ts` |
| `src/memory.ts` | `src/utils/memory.ts` |
| `src/skills.ts` | `src/utils/skills.ts` + `src/tools/SkillTool/` |
| `src/subagent.ts` | `src/tools/AgentTool/` |
| `src/mcp.ts` | `src/services/mcpClient.ts` |

## 没实现的（+ 原因）

| 未实现 | 主要原因 | Claude Code 里做什么 |
|--------|---------|-------------------|
| **Hooks** | 500-800 行发现/加载/隔离/协议，对理解 agent 无帮助 | 25 事件 × 6 类型，工具前后插入自定义逻辑 |
| **Coordinator / Swarm** | 更多是 prompt engineering，非架构问题 | 大任务拆分给多 Agent / 对等信箱通信 |
| **LSP 集成** | 1000+ 行，需深入 LSP 协议 | 编辑后毫秒级类型错误反馈 |
| **Prompt Caching** | 20-30 行改动但需仔细分区 | 不变部分前置 + `cache_control: ephemeral`，输入 token -90% |
| **Bash AST** | tree-sitter 是原生库，`node-gyp` 环境障碍 | 23 项静态检查，管道组合中的危险命令 |

## 增量升级路线

| 阶段 | 增强项 | 代码量 |
|------|-------|--------|
| **性能** | Prompt Caching | ~30 行 |
| **可扩展** | Hook 系统 / Tool 类型系统 | ~300 / 200 |
| **可靠性** | 7 种错误恢复策略 / Bash AST | ~400 / 600 |
| **高级** | Coordinator / Swarm / LSP | ~500 / 600 / 1000 |

**投入产出比最高**：Prompt Caching。给系统提示词的静态部分加 `cache_control: { type: "ephemeral" }`，多轮对话省 50%+ 输入 token。

**第二个值得做**：错误自修复 —— 把工具错误作为 `tool_result` 反馈给模型：

```typescript
try { result = await executeToolImpl(name, input); }
catch (e) { result = `Error: ${e.message}\n\nPlease try a different approach.`; }
```

约 50-80 行，显著提升实际可用性。

## 核心洞察

1. **Agent 的本质是一个 while 循环** —— 权限、上下文、记忆、多 Agent 都是围绕它的增强和防护。
2. **提示词是最便宜的代码** —— 一句提示 = 一个 if 语句，成本 0 行。
3. **工具设计决定能力上限** —— 让模型做它擅长的（理解意图/生成代码），让工具做它不擅长的（精确字符串匹配/文件操作）。
4. **上下文管理是 agent 的"记忆力"** —— 用有限资源提供"无限"错觉。
5. **安全不是事后补丁** —— 权限检查是循环的一个步骤，fail-closed 设计。
6. **3000 行 → 50 万行的差距在边缘情况** —— 环境兼容性、网络/API 不可靠性、企业级审计。
7. **LLM 与代码的协作边界** —— 模型决定"做什么"，代码确保"安全地做"。

## 交叉引用

| 主题 | 本项目 | how-claude-code-works |
|------|--------|----------------------|
| Agent 循环 | [Ch1](docs/01-agent-loop.md) | [系统主循环](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/02-agent-loop) |
| 工具系统 | [Ch2](docs/02-tools.md) | [工具系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/04-tool-system) |
| 上下文 | [Ch7](docs/07-context.md) | [上下文工程](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/03-context-engineering) |
| 权限 | [Ch6](docs/06-permissions.md) | [权限与安全](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/10-permission-security) |
| 记忆 | [Ch8](docs/08-memory.md) | [记忆系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/08-memory-system) |
| 技能 | [Ch9](docs/09-skills.md) | [技能系统](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/09-skills-system) |
| 多 Agent | [Ch11](docs/11-multi-agent.md) | [多 Agent](https://windy3f3f3f3f.github.io/how-claude-code-works/#/docs/07-multi-agent) |
