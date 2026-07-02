# 14. Feature Test Guide

19 manual tests, all with `--yolo`. Agent behavior depends on non-deterministic LLM responses — Claude Code itself follows the same pattern: unit tests for core tools + manual QA for Agent behavior.

```mermaid
graph LR
    Setup["bash test/setup.sh"] --> Build["npm run build"]
    Build --> Test["Run tests one by one"]
    Test --> Cleanup["bash test/cleanup.sh"]

    style Setup fill:#7c5cfc,color:#fff
    style Test fill:#e8e0ff
```

## Prep

```bash
cd claude-code-from-scratch
bash test/setup.sh   # MCP, Skills, CLAUDE.md, large file, quote test, custom Agent
npm run build

# .env
# ANTHROPIC_API_KEY=sk-xxx
# ANTHROPIC_BASE_URL=https://aihubmix.com
```

## Launch

```bash
node dist/cli.js --yolo                # REPL
node dist/cli.js --yolo "prompt"       # one-shot
```

---

## Phase 1: Basic Tools

### 1. MCP

On startup you should see `[mcp] Connected to 'test' — 3 tools`.

```
Use the MCP 'add' tool to compute 17+25, then use the 'echo' tool to echo "hello MCP", then use the 'timestamp' tool.
```

✅ add=42, echo=hello MCP, timestamp=Unix; tool names prefixed with `mcp__test__`.

### 2. WebFetch

```
Fetch the URL https://httpbin.org/json and tell me the slideshow title.
```
✅ `Sample Slide Show`

```
Fetch https://example.com and tell me what the page is about.
```
✅ HTML converted to plain text.

### 3. Parallel Tool Execution

```
Read the files src/frontmatter.ts, src/session.ts, and src/skills.ts at the same time, then tell me each file's line count.
```
✅ Multiple `read_file` in parallel (not serial). `CONCURRENCY_SAFE_TOOLS` (read/list/grep/web_fetch) execute early via streaming.

---

## Phase 2: Memory & Context

### 4. Semantic Memory Recall

**Save**:
```
Save these memories for me:
1. type=project, name="API migration", description="Moving from REST to GraphQL", content="We are migrating our API from REST to GraphQL. Deadline is end of Q2 2025."
2. type=feedback, name="code style", description="Prefers functional programming", content="User prefers functional patterns (map/filter/reduce) over for loops and OOP."
3. type=reference, name="staging server", description="Staging environment URL", content="Staging server: https://staging.example.com, credentials in 1Password."
```

**After exit and restart** (async prefetch takes a few seconds; the test triggers a tool call to give prefetch time to inject on the second iteration):

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
✅ Mentions functional programming.

### 5. @include + Rules Auto-load

setup.sh has already created: `CLAUDE.md` contains `@./.claude/rules/chinese-greeting.md`; rule content is `When the user greets you, respond in Chinese`.

```
Hello! Who are you?
```
✅ Reply **in Chinese**.

### 6. Read-before-edit

```
Edit the file package.json and change the version to "9.9.9". Do NOT read it first.
```
✅ Tool returns `Error: You must read this file before editing`, or the model reads first automatically. When done: `Now change it back to "1.0.0".`

### 7. Large-result Persistence

```
Read the file test/large-file.txt
```
✅ `[Result too large (XX.X KB, 1000 lines). Full output saved to ...]` + `Preview (first 200 lines):`

```
What does line 500 say?
```
✅ Uses grep_search or read_file to find from the original file.

---

## Phase 3: Skills & Tool Extension

### 8. Skill

```
/skills           → Lists greet and commit
/greet Alice      → Personalized greeting
/commit           → git diff/status → attempts commit
```

### 9. ToolSearch Deferred Loading

```
Use tool_search to find the "plan mode" tool.
```
✅ Returns full schema of `enter_plan_mode` / `exit_plan_mode` (previously not in tool list).

### 10. REPL Commands

```
/cost      → Token usage + cost
/memory    → Saved memories
/compact   → Manually trigger compression
/plan      → Toggle plan mode
```

---

## Phase 4: Agent Architecture

### 11. Sub-agent (3 types)

**explore** (read-only):
```
Use the agent tool with type "explore" to find all files that import from "./memory.js" in the src/ directory.
```
✅ `[sub-agent:explore]` marker, uses only read/list/grep.

**plan** (structured):
```
Use the agent tool with type "plan" to design a plan for adding a "help" REPL command. Identify which files need modification.
```
✅ `[sub-agent:plan]` + structured plan.

**general** (full):
```
Use the agent tool with type "general" to create a file called /tmp/mini-claude-agent-test.txt with the content "agent test passed", then read it back.
```
✅ `[sub-agent:general]`; tokens accumulated to parent (visible via `/cost`).

### 12. Plan Mode

```
/plan
```
✅ Shows plan mode enabled.

```
Read package.json, then create a plan for changing the project name. Write your plan to the plan file.
```
✅ Can read; can write plan file; writing other files gets `Blocked in plan mode`.

After `exit_plan_mode`, 4 options: choose `4` (keep-planning) with feedback → after revision, exit_plan_mode again and choose `1` (clear-and-execute).

```
/plan       → Toggle back to normal
```

---

## Phase 5: Editing & Search

### 13. Edit Quote Normalization

```
Read the file test/quote-test.js
```

Edit with curly quotes:
```
Use edit_file on test/quote-test.js. In the old_string, use curly double quotes (Unicode U+201C and U+201D) around "Hello World". Replace with straight quotes saying "Hi Universe".
```
✅ Output shows `(matched via quote normalization)`. When done: `Edit test/quote-test.js, replace "Hi Universe" with "Hello World"`.

### 17. Grep Search

```
Use grep_search to find all lines containing "import.*chalk" in the src/ directory
```
✅ `filepath:linenum:matched-content`

```
Use grep_search to find the pattern "export function" in all .ts files under src/
```
✅ `include: "*.ts"` filter works.

```
Use grep_search to find "DANGEROUS_PATTERNS" in the project
```
✅ Locates `src/tools.ts`.

### 18. Write File

```
Create a new file at test/tmp/nested/hello.txt with the content:
Line 1: Hello from Mini Claude
Line 2: This is a write test
Line 3: End of file
```
✅ Directory auto-created; returns `Successfully wrote to ... (3 lines)` + preview.

```
Read the file test/tmp/nested/hello.txt to verify.
```
✅ Content intact.

Long-file preview truncation:
```
Create a file test/tmp/long-file.txt with 50 numbered lines like "Line 1: test data", etc.
```
✅ Shows only first 30 lines + `... (50 lines total)`.

---

## Phase 6: Session & CLI

### 14. Session Resume

**First time**:
```bash
node dist/cli.js --yolo
```
```
Remember this: The secret code is BANANA-42. Read package.json and tell me the version.
```
`exit` to quit.

**Resume**:
```bash
node dist/cli.js --yolo --resume
```
✅ Shows session restored.

```
What was the secret code I told you earlier?
```
✅ `BANANA-42`

Contrast (fresh session): `node dist/cli.js --yolo` → same question, model can't answer.

### 15. One-shot

```bash
node dist/cli.js --yolo "Read the file package.json and tell me the project name. Only output the name."
```
✅ Prints and **auto-exits**.

```bash
node dist/cli.js --yolo "List all TypeScript files in the src/ directory"
```

Error case:
```bash
node dist/cli.js --yolo "Read the file /nonexistent/path/file.txt"
```
✅ Tool returns error but program exits normally.

### 16. Budget Control

```bash
node dist/cli.js --yolo --max-turns 2 "Read these files one by one: package.json, tsconfig.json, src/cli.ts, src/agent.ts, src/tools.ts. Tell me the line count of each."
```
✅ Stops after 2 turns with a budget notice; **won't** read all 5 files.

---

## Cleanup

```bash
bash test/cleanup.sh
```

## Coverage Matrix

| # | Feature | Source |
|---|---------|--------|
| 1 | MCP | `mcp.ts` |
| 2 | WebFetch | `tools.ts` |
| 3 | Parallel tools | `agent.ts` + `tools.ts` |
| 4 | Semantic memory recall | `memory.ts` |
| 5 | @include + Rules | `prompt.ts` |
| 6 | Read-before-edit | `tools.ts` |
| 7 | Large-result persistence | `agent.ts` |
| 8 | Skill | `skills.ts` |
| 9 | ToolSearch | `tools.ts` |
| 10 | REPL commands | `cli.ts` |
| 11 | Sub-agent | `subagent.ts` + `agent.ts` |
| 12 | Plan Mode | `agent.ts` + `tools.ts` + `cli.ts` |
| 13 | Quote normalization | `tools.ts` |
| 14 | Session Resume | `session.ts` |
| 15 | One-shot | `cli.ts` |
| 16 | Budget control | `agent.ts` + `cli.ts` |
| 17 | Grep Search | `tools.ts` |
| 18 | Write File | `tools.ts` |
