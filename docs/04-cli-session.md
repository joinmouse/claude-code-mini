# 4. CLI 与会话

参数解析、REPL、Ctrl+C 中断、会话持久化。

```mermaid
graph TB
    Entry[cli.ts 入口] --> Parse[parseArgs]
    Parse --> |有 prompt| OneShot[单次模式]
    Parse --> |无 prompt| REPL[REPL]
    Parse --> |--resume| Restore[恢复会话]
    Restore --> REPL
    REPL --> |用户输入| Cmd{命令?}
    Cmd -->|/clear /cost /compact /plan| Handler[命令处理]
    Cmd -->|普通文本| Chat[agent.chat]
    Chat --> Save[自动保存会话]

    style Entry fill:#7c5cfc,color:#fff
    style REPL fill:#e8e0ff
```

## 参考：Claude Code 的做法

- **入口** `src/entrypoints/cli.tsx` — React/Ink 组件模型搬进终端，支持流式 Markdown、Vim 模式、多 Tab
- **可观察的自主性**：Agent 自由行动 + 用户实时看到每一步。中断成本 ≪ 撤销成本，让用户能在 3 秒内 Ctrl+C
- **JSONL 追加写**：O(1) 写入，崩溃最多丢最后一行；对比整体 JSON 覆盖写（长对话越写越慢 + 崩溃损坏）

我们简化：普通 readline REPL + 整体 JSON 保存（教程量级不需要 JSONL）。

## 参数解析

```typescript
// cli.ts
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let permissionMode: PermissionMode = "default";
  let thinking = false;
  let model = process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6";
  let resume = false;
  let maxCost: number | undefined;
  let maxTurns: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yolo" || args[i] === "-y")  permissionMode = "bypassPermissions";
    else if (args[i] === "--plan")                 permissionMode = "plan";
    else if (args[i] === "--accept-edits")         permissionMode = "acceptEdits";
    else if (args[i] === "--dont-ask")             permissionMode = "dontAsk";
    else if (args[i] === "--thinking")             thinking = true;
    else if (args[i] === "--model" || args[i] === "-m") model = args[++i] || model;
    else if (args[i] === "--resume")               resume = true;
    else if (args[i] === "--max-cost")  { const v = parseFloat(args[++i]); if (!isNaN(v)) maxCost = v; }
    else if (args[i] === "--max-turns") { const v = parseInt(args[++i], 10); if (!isNaN(v)) maxTurns = v; }
    else if (args[i] === "--help" || args[i] === "-h") { console.log("Usage: mini-claude ..."); process.exit(0); }
    else positional.push(args[i]);
  }

  return { permissionMode, model, resume, thinking, maxCost, maxTurns,
           prompt: positional.length > 0 ? positional.join(" ") : undefined };
}
```

10 个参数手写循环，零依赖。带值参数（`--model X`）用 `++i` 跳到下一个元素。

## main：单次 vs REPL

```typescript
// cli.ts
async function main() {
  const { permissionMode, model, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { printError("API key required. Set ANTHROPIC_API_KEY."); process.exit(1); }

  const agent = new Agent({
    permissionMode, model, thinking, maxCostUsd: maxCost, maxTurns, apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });

  if (resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) { const s = loadSession(sessionId); if (s) agent.restoreSession(s); }
  }

  if (prompt) await agent.chat(prompt);
  else        await runRepl(agent);
}
```

API key 只从 env 读，不支持 CLI 参数（避免泄露到 shell history）。

## REPL

```typescript
// cli.ts
async function runRepl(agent: Agent) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) { console.log("\nBye!\n"); process.exit(0); }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  printWelcome();

  // rl.once 保证严格串行：多个 chat 并发会破坏消息历史
  const askQuestion = (): void => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;
      if (!input) { askQuestion(); return; }
      if (input === "exit" || input === "quit") { console.log("\nBye!\n"); process.exit(0); }
      if (input === "/clear")   { agent.clearHistory(); askQuestion(); return; }
      if (input === "/cost")    { agent.showCost();     askQuestion(); return; }
      if (input === "/compact") { try { await agent.compact(); } catch (e: any) { printError(e.message); } askQuestion(); return; }
      if (input === "/plan")    { agent.togglePlanMode(); askQuestion(); return; }
      try { await agent.chat(input); }
      catch (e: any) { if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message); }
      askQuestion();
    });
  };
  askQuestion();
}
```

**Ctrl+C 双语义**：处理中 → 中断；空闲时第一次提醒，第二次退出。避免手滑丢会话 + Agent 跑偏无法打断这两种意外。

## 会话持久化

```typescript
// session.ts
const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

export function saveSession(id: string, data: SessionData): void {
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0].id;
}

// agent.ts
private autoSave() {
  try {
    saveSession(this.sessionId, {
      metadata: { id: this.sessionId, model: this.model, cwd: process.cwd(),
                  startTime: this.sessionStartTime, messageCount: this.getMessageCount() },
      anthropicMessages: this.anthropicMessages,
    });
  } catch {}  // 磁盘满不能让对话崩溃
}
```

## UI 输出

```typescript
// ui.ts
export function printToolCall(name: string, input: Record<string, any>) {
  const icon = getToolIcon(name);        // read_file → 📖, run_shell → 💻
  const summary = getToolSummary(name, input);
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printToolResult(name: string, result: string) {
  const maxLen = 500;
  const truncated = result.length > maxLen
    ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
    : result;
  console.log(chalk.dim(truncated.split("\n").map((l) => "  " + l).join("\n")));
}
```

UI 层截断到 500 字符（给人看），完整结果仍在消息历史中。
