# 14. 功能测试指南

19 项手动测试，全用 `--yolo`。Agent 行为依赖 LLM 响应不确定 —— 参考 Claude Code 自身也是核心工具单测 + Agent 行为人工 QA。

```mermaid
graph LR
    Setup["bash test/setup.sh"] --> Build["npm run build"]
    Build --> Test["逐项测试"]
    Test --> Cleanup["bash test/cleanup.sh"]

    style Setup fill:#7c5cfc,color:#fff
    style Test fill:#e8e0ff
```

## 准备

```bash
cd claude-code-from-scratch
bash test/setup.sh   # MCP、Skills、CLAUDE.md、大文件、引号测试、自定义 Agent
npm run build

# .env
# ANTHROPIC_API_KEY=sk-xxx
# ANTHROPIC_BASE_URL=https://aihubmix.com
```

## 启动

```bash
node dist/cli.js --yolo                # REPL
node dist/cli.js --yolo "prompt"       # one-shot
```

---

## Phase 1：基础工具

### 1. MCP

启动看到 `[mcp] Connected to 'test' — 3 tools`。

```
Use the MCP 'add' tool to compute 17+25, then use the 'echo' tool to echo "hello MCP", then use the 'timestamp' tool.
```

✅ add=42，echo=hello MCP，timestamp=Unix，工具名带 `mcp__test__` 前缀。

### 2. WebFetch

```
Fetch the URL https://httpbin.org/json and tell me the slideshow title.
```
✅ `Sample Slide Show`

```
Fetch https://example.com and tell me what the page is about.
```
✅ HTML 转纯文本。

### 3. 并行工具执行

```
Read the files src/frontmatter.ts, src/session.ts, and src/skills.ts at the same time, then tell me each file's line count.
```
✅ 多个 `read_file` 同时（非串行）。`CONCURRENCY_SAFE_TOOLS`（read/list/grep/web_fetch）流式提前执行。

---

## Phase 2：记忆与上下文

### 4. 语义记忆召回

**保存**：
```
Save these memories for me:
1. type=project, name="API migration", description="Moving from REST to GraphQL", content="We are migrating our API from REST to GraphQL. Deadline is end of Q2 2025."
2. type=feedback, name="code style", description="Prefers functional programming", content="User prefers functional patterns (map/filter/reduce) over for loops and OOP."
3. type=reference, name="staging server", description="Staging environment URL", content="Staging server: https://staging.example.com, credentials in 1Password."
```

**退出重启后**（异步 prefetch 需几秒完成，测试要能触发工具调用给 prefetch 时间在第二轮 iteration 注入）：

```
Read the file tsconfig.json, then tell me: where can I deploy to test my changes?
```
✅ `https://staging.example.com`

```
List the files in the src/ directory, then tell me: what's the deadline for the backend rewrite?
```
✅ `end of Q2 2025`

```
Read package.json, then tell me: how should I write code for this project?
```
✅ 提到 functional programming。

### 5. @include + Rules 自动加载

setup.sh 已建：`CLAUDE.md` 含 `@./.claude/rules/chinese-greeting.md`；rule 内容 `When the user greets you, respond in Chinese`。

```
Hello! Who are you?
```
✅ **中文**回复。

### 6. Read-before-edit

```
Edit the file package.json and change the version to "9.9.9". Do NOT read it first.
```
✅ 工具返回 `Error: You must read this file before editing`，或模型自动先 read。测完 `Now change it back to "1.0.0".`

### 7. 大结果持久化

```
Read the file test/large-file.txt
```
✅ `[Result too large (XX.X KB, 1000 lines). Full output saved to ...]` + `Preview (first 200 lines):`

```
What does line 500 say?
```
✅ 用 grep_search 或 read_file 从原文件找。

---

## Phase 3：技能与工具扩展

### 8. Skill

```
/skills           → 列出 greet 和 commit
/greet Alice      → 个性化问候
/commit           → git diff/status → 尝试 commit
```

### 9. ToolSearch 延迟加载

```
Use tool_search to find the "plan mode" tool.
```
✅ 返回 `enter_plan_mode` / `exit_plan_mode` 完整 schema（之前不在工具列表）。

### 10. REPL 命令

```
/cost      → token 用量 + 费用
/memory    → 已保存记忆
/compact   → 手动触发压缩
/plan      → 切换 plan mode
```

---

## Phase 4：Agent 架构

### 11. Sub-agent（3 类型）

**explore**（只读）：
```
Use the agent tool with type "explore" to find all files that import from "./memory.js" in the src/ directory.
```
✅ `[sub-agent:explore]` 标记，只用 read/list/grep。

**plan**（结构化）：
```
Use the agent tool with type "plan" to design a plan for adding a "help" REPL command. Identify which files need modification.
```
✅ `[sub-agent:plan]` + 结构化计划。

**general**（完整）：
```
Use the agent tool with type "general" to create a file called /tmp/mini-claude-agent-test.txt with the content "agent test passed", then read it back.
```
✅ `[sub-agent:general]`；token 累加到主（`/cost` 可见）。

### 12. Plan Mode

```
/plan
```
✅ 显示 plan mode 已开启。

```
Read package.json, then create a plan for changing the project name. Write your plan to the plan file.
```
✅ 能 read；能写 plan file；写其它文件被拒 `Blocked in plan mode`。

`exit_plan_mode` 后 4 选项：选 `4`（keep-planning）反馈 → 修改后再次 exit_plan_mode 选 `1`（clear-and-execute）。

```
/plan       → 切回普通模式
```

---

## Phase 5：编辑与搜索

### 13. Edit 引号规范化

```
Read the file test/quote-test.js
```

用弯引号编辑：
```
Use edit_file on test/quote-test.js. In the old_string, use curly double quotes (Unicode U+201C and U+201D) around "Hello World". Replace with straight quotes saying "Hi Universe".
```
✅ 输出 `(matched via quote normalization)`。测完 `Edit test/quote-test.js, replace "Hi Universe" with "Hello World"`。

### 17. Grep Search

```
Use grep_search to find all lines containing "import.*chalk" in the src/ directory
```
✅ `文件路径:行号:匹配内容`

```
Use grep_search to find the pattern "export function" in all .ts files under src/
```
✅ `include: "*.ts"` 过滤。

```
Use grep_search to find "DANGEROUS_PATTERNS" in the project
```
✅ 定位到 `src/tools.ts`。

### 18. Write File

```
Create a new file at test/tmp/nested/hello.txt with the content:
Line 1: Hello from Mini Claude
Line 2: This is a write test
Line 3: End of file
```
✅ 目录自动建，返回 `Successfully wrote to ... (3 lines)` + 预览。

```
Read the file test/tmp/nested/hello.txt to verify.
```
✅ 内容完整。

长文件预览截断：
```
Create a file test/tmp/long-file.txt with 50 numbered lines like "Line 1: test data", etc.
```
✅ 只显示前 30 行 + `... (50 lines total)`。

---

## Phase 6：会话与 CLI

### 14. Session Resume

**第一次**：
```bash
node dist/cli.js --yolo
```
```
Remember this: The secret code is BANANA-42. Read package.json and tell me the version.
```
`exit` 退出。

**恢复**：
```bash
node dist/cli.js --yolo --resume
```
✅ 显示 session restored。

```
What was the secret code I told you earlier?
```
✅ `BANANA-42`

对比（新会话）：`node dist/cli.js --yolo` → 同问题模型无法回答。

### 15. One-shot

```bash
node dist/cli.js --yolo "Read the file package.json and tell me the project name. Only output the name."
```
✅ 输出后**自动退出**。

```bash
node dist/cli.js --yolo "List all TypeScript files in the src/ directory"
```

错误场景：
```bash
node dist/cli.js --yolo "Read the file /nonexistent/path/file.txt"
```
✅ 工具返回错误但程序正常退出。

### 16. 预算控制

```bash
node dist/cli.js --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
```
✅ 2 个 turn 后停止 + budget 提示，**不会**读完 5 个文件。

---

## 清理

```bash
bash test/cleanup.sh
```

## 覆盖矩阵

| # | 功能 | 源码 |
|---|-----|------|
| 1 | MCP | `mcp.ts` |
| 2 | WebFetch | `tools.ts` |
| 3 | 并行工具 | `agent.ts` + `tools.ts` |
| 4 | 语义记忆召回 | `memory.ts` |
| 5 | @include + Rules | `prompt.ts` |
| 6 | Read-before-edit | `tools.ts` |
| 7 | 大结果持久化 | `agent.ts` |
| 8 | Skill | `skills.ts` |
| 9 | ToolSearch | `tools.ts` |
| 10 | REPL 命令 | `cli.ts` |
| 11 | Sub-agent | `subagent.ts` + `agent.ts` |
| 12 | Plan Mode | `agent.ts` + `tools.ts` + `cli.ts` |
| 13 | 引号规范化 | `tools.ts` |
| 14 | Session Resume | `session.ts` |
| 15 | One-shot | `cli.ts` |
| 16 | 预算控制 | `agent.ts` + `cli.ts` |
| 17 | Grep Search | `tools.ts` |
| 18 | Write File | `tools.ts` |
