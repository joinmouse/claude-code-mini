# 4. CLI and Sessions

## Chapter Goals

Build the user interface layer: command-line argument parsing, interactive REPL, Ctrl+C interrupt handling, session persistence and recovery.

```mermaid
graph TB
    Entry[cli.ts Entry] --> Parse[parseArgs<br/>Argument Parsing]
    Parse --> |has prompt| OneShot[One-shot Mode<br/>agent.chat -> exit]
    Parse --> |no prompt| REPL[REPL Mode<br/>readline loop]
    Parse --> |--resume| Restore[Restore Session]
    Restore --> REPL
    REPL --> |user input| Cmd{Command?}
    Cmd -->|/clear| Clear[Clear History]
    Cmd -->|/cost| Cost[Show Cost]
    Cmd -->|/compact| Compact[Compact Context]
    Cmd -->|/plan| Plan[Toggle Plan Mode]
    Cmd -->|plain text| Chat[agent.chat]
    Chat --> Save[Auto-save Session]

    style Entry fill:#7c5cfc,color:#fff
    style REPL fill:#e8e0ff
```

## How Claude Code Does It

Claude Code's entry point is `src/entrypoints/cli.tsx` -- using React/Ink to bring the component model into the terminal, supporting streaming Markdown rendering, Vim mode, multi-tab, keyboard customization. Sessions use JSONL format with append-only writes, making them crash-safe.

### Terminal-Native vs GUI

This is a deliberate choice. Developers' workflows live in the terminal -- opening a browser means a context switch. Being terminal-native makes it just another command-line tool, embedded into existing workflows alongside `git`, `grep`, etc. Specific benefits: works over SSH, can accept pipes (`echo "fix" | claude`), supports tmux multi-instance parallelism, near-zero memory overhead.

React/Ink's role is to compensate for the terminal's interaction limitations -- with the component model, complex UIs like streaming output and diff views become maintainable.

### Observable Autonomy

The core UX principle of Claude Code: **the Agent acts freely, but lets the user see every step in real time**.

```
read_file src/app.ts
  1 | import express from ...
  ... (1234 chars total)

edit_file src/app.ts
  - const port = 3000
  + const port = process.env.PORT
```

The cost of interrupting is far lower than the cost of undoing. Users can hit Ctrl+C within 3 seconds of the Agent going in the wrong direction, rather than waiting 20 seconds for it to finish and then spending even more time undoing. Each tool has 4 rendering methods (start/complete/denied/error), long-running tools stream stdout in real time rather than waiting until completion to display.

### JSONL Session Storage

Whole-JSON overwrite has two problems: a crash mid-write corrupts the entire file; the longer the conversation, the slower each save.

JSONL appends one line per turn, O(1) writes, and a crash loses at most the last line. The filesystem's append operation is typically atomic. Recovery parses line by line, skipping any incomplete line at the end.

## Our Implementation

### Argument Parsing

#### **TypeScript**
```typescript
// cli.ts -- parseArgs

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
    if (args[i] === "--yolo" || args[i] === "-y") {
      permissionMode = "bypassPermissions";
    } else if (args[i] === "--plan") {
      permissionMode = "plan";
    } else if (args[i] === "--accept-edits") {
      permissionMode = "acceptEdits";
    } else if (args[i] === "--dont-ask") {
      permissionMode = "dontAsk";
    } else if (args[i] === "--thinking") {
      thinking = true;
    } else if (args[i] === "--model" || args[i] === "-m") {
      model = args[++i] || model;
    } else if (args[i] === "--resume") {
      resume = true;
    } else if (args[i] === "--max-cost") {
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    } else if (args[i] === "--max-turns") {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: mini-claude [options] [prompt] ...`);
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    permissionMode, model, resume, thinking, maxCost, maxTurns,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}
```

The TypeScript version uses a hand-written loop instead of commander.js, since there are only 11 arguments -- zero dependencies is lighter. It uses `for` instead of `forEach` because value-taking arguments (`--model claude-sonnet`) need `++i` to skip to the next element.

### Two Execution Modes

#### **TypeScript**
```typescript
// cli.ts -- main

async function main() {
  const { permissionMode, model, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  // API key from environment variables, not command-line (to avoid leaking into shell history)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    printError(`API key is required. Set ANTHROPIC_API_KEY env var.`);
    process.exit(1);
  }

  const agent = new Agent({ permissionMode, model, apiKey, thinking, maxCost, maxTurns });

  if (resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) {
      const session = loadSession(sessionId);
      if (session) agent.restoreSession(session);
    }
  }

  if (prompt) {
    await agent.chat(prompt);       // One-shot mode: execute then exit
  } else {
    await runRepl(agent);           // REPL mode: interactive loop
  }
}
```

### REPL Implementation

#### **TypeScript**
```typescript
// cli.ts -- runRepl

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

  // rl.once instead of rl.on: ensures strict serialization, prevents multiple chats from concurrently modifying message history
  const askQuestion = (): void => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) { askQuestion(); return; }
      if (input === "exit" || input === "quit") { console.log("\nBye!\n"); process.exit(0); }

      if (input === "/clear") { agent.clearHistory(); askQuestion(); return; }
      if (input === "/cost")  { agent.showCost(); askQuestion(); return; }
      if (input === "/compact") {
        try { await agent.compact(); } catch (e: any) { printError(e.message); }
        askQuestion(); return;
      }
      if (input === "/plan") { agent.togglePlanMode(); askQuestion(); return; }

      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
      }

      askQuestion();
    });
  };

  askQuestion();
}
```

**Dual semantics of Ctrl+C**: While processing, pressing it -> interrupts the current operation and returns to the input prompt; while idle, pressing it -> first time shows a reminder, second time exits. This avoids two undesirable scenarios: accidentally pressing Ctrl+C and losing the entire session, and watching helplessly while the Agent runs off track.

**`rl.once` vs `rl.on`**: A handler registered with `rl.on` responds to the next line of input without waiting for `await agent.chat()` to complete, causing multiple chats to concurrently modify message history. `rl.once` listens for only one line at a time, recursively re-registering after processing -- naturally serial.

### Session Persistence

#### **TypeScript**
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
```

Auto-saves after each `agent.chat()` completes; save failures are silently ignored (a full disk shouldn't crash the entire conversation). Recovery simply loads the message array back into the Agent:

#### **TypeScript**
```typescript
// agent.ts
private autoSave() {
  try {
    saveSession(this.sessionId, {
      metadata: { id: this.sessionId, model: this.model, cwd: process.cwd(),
                  startTime: this.sessionStartTime, messageCount: this.getMessageCount() },
      anthropicMessages: this.anthropicMessages,
    });
  } catch {}
}

restoreSession(data: { anthropicMessages?: any[] }) {
  if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
  printInfo(`Session restored (${this.getMessageCount()} messages).`);
}
```

### Terminal UI -- ui.ts

All output is uniformly formatted through `ui.ts`:

#### **TypeScript**
```typescript
// ui.ts (using chalk)

export function printToolCall(name: string, input: Record<string, any>) {
  const icon = getToolIcon(name);      // read_file -> book icon, run_shell -> computer icon
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

Tool results are truncated to 500 characters at the UI layer -- this display is for humans; the complete result is already in the message history.

> **Next chapter**: Making the Agent's output appear in real time -- streaming output.
