import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import { toolDefinitions, executeTool, checkPermission, CONCURRENCY_SAFE_TOOLS, getActiveToolDefinitions, getDeferredToolNames, type ToolDef, type PermissionMode } from "./tools.js";
import {
  printAssistantText,
  printToolCall,
  printToolResult,
  printError,
  printConfirmation,
  printDivider,
  printCost,
  printRetry,
  printInfo,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import { saveSession } from "./session.js";
import { buildSystemPrompt } from "./prompt.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import {
  startMemoryPrefetch, formatMemoriesForInjection,
  type MemoryPrefetch, type RelevantMemory, type SideQueryFn,
} from "./memory.js";
import { McpManager } from "./mcp.js";
import * as readline from "readline";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Retry with exponential backoff ──────────────────────────

function isRetryable(error: any): boolean {
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
  if (error?.message?.includes("overloaded")) return true;
  return false;
}

async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(signal);
    } catch (error: any) {
      if (signal?.aborted) throw error;
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      const reason = error?.status ? `HTTP ${error.status}` : error?.code || "network error";
      printRetry(attempt + 1, maxRetries, reason);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Model context windows ──────────────────────────────────

const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-20250514": 200000,
};

function getContextWindow(model: string): number {
  return MODEL_CONTEXT[model] || 200000;
}

// ─── Thinking support detection ─────────────────────────────
// Mirrors Claude Code: adaptive for 4.6, enabled for older Claude 4, disabled for the rest.

function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Claude 4+ models support thinking (not Claude 3.x)
  if (m.includes("claude-3-") || m.includes("3-5-") || m.includes("3-7-")) return false;
  if (m.includes("claude") && (m.includes("opus") || m.includes("sonnet") || m.includes("haiku"))) return true;
  return false; // non-Claude models (GPT, etc.) — no thinking
}

function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

// Max output tokens by model (mirrors Claude Code's context.ts)
function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus-4-6")) return 64000;
  if (m.includes("sonnet-4-6")) return 32000;
  if (m.includes("opus-4") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32000;
  return 16384; // safe default for unknown models
}


// ─── Multi-tier compression constants ────────────────────────
// Mirrors Claude Code's 4-layer compression: budget → snip → microcompact → auto-compact

const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const KEEP_RECENT_RESULTS = 3;

// ─── Agent ───────────────────────────────────────────────────

interface AgentOptions {
  permissionMode?: PermissionMode;
  yolo?: boolean;             // Legacy alias for bypassPermissions
  model?: string;
  baseURL?: string;           // Anthropic base URL (e.g. proxy)
  apiKey?: string;
  thinking?: boolean;
  maxCostUsd?: number;        // Budget: max USD spend
  maxTurns?: number;          // Budget: max agentic turns
  confirmFn?: (message: string) => Promise<boolean>; // External confirmation callback
  // Sub-agent options
  customSystemPrompt?: string;
  customTools?: ToolDef[];
  isSubAgent?: boolean;
}

export class Agent {
  private anthropicClient: Anthropic;
  private permissionMode: PermissionMode;
  private thinkingMode: "adaptive" | "enabled" | "disabled";
  private model: string;
  private systemPrompt: string;
  private tools: ToolDef[];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private lastInputTokenCount = 0;
  private effectiveWindow: number;
  private sessionId: string;
  private sessionStartTime: string;
  private isSubAgent: boolean;

  // MCP integration
  private mcpManager = new McpManager();
  private mcpInitialized = false;

  // Budget control
  private maxCostUsd?: number;
  private maxTurns?: number;
  private currentTurns = 0;

  // Multi-tier compression state
  private lastApiCallTime = 0;

  // Abort support
  private abortController: AbortController | null = null;

  // Permission whitelist: paths confirmed in this session
  private confirmedPaths: Set<string> = new Set();

  // Plan mode state
  private prePlanMode: PermissionMode | null = null;
  private planFilePath: string | null = null;
  private baseSystemPrompt: string = "";
  private contextCleared: boolean = false; // Set when plan approval clears context

  // External confirmation callback (avoids creating a second readline on stdin)
  private confirmFn?: (message: string) => Promise<boolean>;

  // Plan approval callback: returns { choice, feedback? }
  private planApprovalFn?: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>;

  // Sub-agent output buffer (captures text instead of printing)
  private outputBuffer: string[] | null = null;

  // Read-before-edit: track file read timestamps (absolutePath → mtimeMs)
  private readFileState: Map<string, number> = new Map();

  // Memory recall state — semantic prefetch per user turn
  private alreadySurfacedMemories: Set<string> = new Set();
  private sessionMemoryBytes = 0;

  // Separate message history
  private anthropicMessages: Anthropic.MessageParam[] = [];

  constructor(options: AgentOptions = {}) {
    // Permission mode: explicit mode > yolo legacy > default
    this.permissionMode = options.permissionMode
      || (options.yolo ? "bypassPermissions" : "default");
    this.model = options.model || "claude-opus-4-6";
    this.thinkingMode = this.resolveThinkingMode(options.thinking || false);
    this.isSubAgent = options.isSubAgent || false;
    this.tools = options.customTools || toolDefinitions;
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.confirmFn = options.confirmFn;
    this.effectiveWindow = getContextWindow(this.model) - 20000;
    this.sessionId = randomUUID().slice(0, 8);
    this.sessionStartTime = new Date().toISOString();

    // Build system prompt (with plan mode injection if needed)
    this.baseSystemPrompt = options.customSystemPrompt || buildSystemPrompt();
    if (this.permissionMode === "plan") {
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
    } else {
      this.systemPrompt = this.baseSystemPrompt;
    }

    this.anthropicClient = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  private resolveThinkingMode(thinking: boolean): "adaptive" | "enabled" | "disabled" {
    if (!thinking) return "disabled";
    if (!modelSupportsThinking(this.model)) return "disabled";
    if (modelSupportsAdaptiveThinking(this.model)) return "adaptive";
    return "enabled";
  }

  /** Build a sideQuery function for memory recall. */
  private buildSideQuery(): SideQueryFn {
    const client = this.anthropicClient;
    const model = this.model;
    return async (system, userMessage, signal) => {
      const resp = await client.messages.create({
        model, max_tokens: 256, system,
        messages: [{ role: "user", content: userMessage }],
      }, { signal });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("");
    };
  }

  abort() {
    this.abortController?.abort();
  }

  get isProcessing(): boolean {
    return this.abortController !== null;
  }

  setConfirmFn(fn: (message: string) => Promise<boolean>) {
    this.confirmFn = fn;
  }

  setPlanApprovalFn(fn: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>) {
    this.planApprovalFn = fn;
  }

  /** Toggle plan mode from the REPL. Returns the new mode description. */
  togglePlanMode(): string {
    if (this.permissionMode === "plan") {
      // Exit plan mode
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      // Enter plan mode
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
      return "plan";
    }
  }

  getPermissionMode(): string {
    return this.permissionMode;
  }

  getTokenUsage() {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  async chat(userMessage: string): Promise<void> {
    // Lazily connect to MCP servers on first chat (main agent only)
    if (!this.mcpInitialized && !this.isSubAgent) {
      this.mcpInitialized = true;
      try {
        await this.mcpManager.loadAndConnect();
        const mcpDefs = this.mcpManager.getToolDefinitions();
        if (mcpDefs.length > 0) {
          this.tools = [...this.tools, ...mcpDefs as ToolDef[]];
        }
      } catch (err: any) {
        console.error(`[mcp] Init failed: ${err.message}`);
      }
    }
    this.abortController = new AbortController();
    try {
      await this.chatAnthropic(userMessage);
    } finally {
      this.abortController = null;
    }
    if (!this.isSubAgent) {
      printDivider();
      this.autoSave();
    }
  }

  // ─── Sub-agent entry point ────────────────────────────────

  async runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }> {
    this.outputBuffer = [];
    const prevInput = this.totalInputTokens;
    const prevOutput = this.totalOutputTokens;
    await this.chat(prompt);
    const text = this.outputBuffer.join("");
    this.outputBuffer = null;
    return {
      text,
      tokens: {
        input: this.totalInputTokens - prevInput,
        output: this.totalOutputTokens - prevOutput,
      },
    };
  }

  // ─── Output helper (captures if sub-agent) ────────────────

  private emitText(text: string): void {
    if (this.outputBuffer) {
      this.outputBuffer.push(text);
    } else {
      printAssistantText(text);
    }
  }

  // ─── REPL commands ──────────────────────────────────────────

  clearHistory() {
    this.anthropicMessages = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.lastInputTokenCount = 0;
    printInfo("Conversation cleared.");
  }

  showCost() {
    const total = this.getCurrentCostUsd();
    const budgetInfo = this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : "";
    const turnInfo = this.maxTurns ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
    printInfo(
      `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
    );
  }

  // ─── Budget control ────────────────────────────────────────

  private getCurrentCostUsd(): number {
    const costIn = (this.totalInputTokens / 1_000_000) * 3;
    const costOut = (this.totalOutputTokens / 1_000_000) * 15;
    return costIn + costOut;
  }

  private checkBudget(): { exceeded: boolean; reason?: string } {
    if (this.maxCostUsd !== undefined) {
      const cost = this.getCurrentCostUsd();
      if (cost >= this.maxCostUsd) {
        return { exceeded: true, reason: `Cost limit reached ($${cost.toFixed(4)} >= $${this.maxCostUsd})` };
      }
    }
    if (this.maxTurns !== undefined && this.currentTurns >= this.maxTurns) {
      return { exceeded: true, reason: `Turn limit reached (${this.currentTurns} >= ${this.maxTurns})` };
    }
    return { exceeded: false };
  }

  async compact() {
    await this.compactConversation();
  }

  // ─── Session restore ───────────────────────────────────────

  restoreSession(data: { anthropicMessages?: any[] }) {
    if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
    printInfo(`Session restored (${this.anthropicMessages.length} messages).`);
  }

  private getMessageCount(): number {
    return this.anthropicMessages.length;
  }

  private autoSave() {
    try {
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.anthropicMessages.length,
        },
        anthropicMessages: this.anthropicMessages,
      });
    } catch {}
  }

  // ─── Autocompact ───────────────────────────────────────────

  private async checkAndCompact(): Promise<void> {
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      printInfo("Context window filling up, compacting conversation...");
      await this.compactConversation();
    }
  }

  private async compactConversation(): Promise<void> {
    await this.compactAnthropic();
    printInfo("Conversation compacted.");
  }

  private async compactAnthropic(): Promise<void> {
    // Invariant: caller must ensure the last message is a plain user-text
    // message (not a tool_result). We slice it off below; if it were a
    // tool_result, the preceding assistant's tool_use would be orphaned and
    // the API would reject the summarize call.
    if (this.anthropicMessages.length < 4) return;
    const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];
    const summaryReq: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
      },
    ];
    const summaryResp = await this.anthropicClient.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        ...this.anthropicMessages.slice(0, -1),
        ...summaryReq,
      ],
    });
    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";
    this.anthropicMessages = [
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    if (lastUserMsg.role === "user") this.anthropicMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  // ─── Multi-tier compression pipeline ──────────────────────
  // Mirrors Claude Code's 4-layer: budget → snip → microcompact → auto-compact
  // Tiers 1-3 are zero-API-cost, operating on the local message array.

  private runCompressionPipeline(): void {
    this.budgetToolResults();
    this.snipStaleResults();
    this.microcompact();
  }

  // Tier 1: Budget tool results — dynamically shrink large results as context fills
  private budgetToolResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.anthropicMessages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          block.content = block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }



  // Tier 2: Snip stale results — replace old/duplicate tool results with placeholder
  private snipStaleResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < SNIP_THRESHOLD) return;

    // Collect all tool_result blocks with metadata
    const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          // Find the corresponding tool_use to get tool name and input
          const toolUseId = block.tool_use_id;
          const toolInfo = this.findToolUseById(toolUseId);
          if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
            results.push({ msgIdx: mi, blockIdx: bi, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
          }
        }
      }
    }

    if (results.length <= KEEP_RECENT_RESULTS) return;

    // Strategy: snip duplicates and old results, keep recent N
    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>(); // filePath → indices

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.toolName === "read_file" && r.filePath) {
        const existing = seenFiles.get(r.filePath) || [];
        existing.push(i);
        seenFiles.set(r.filePath, existing);
      }
    }

    // Snip earlier reads of same file
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
      }
    }

    // Snip oldest results beyond keep-recent threshold
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    for (const idx of toSnip) {
      const r = results[idx];
      const block = (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx];
      block.content = SNIP_PLACEHOLDER;
    }
  }



  // Tier 3: Microcompact — aggressively clear old results when prompt cache is cold
  private microcompact(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    // Collect ALL tool_results across messages, clear all but recent N
    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" &&
            block.content !== SNIP_PLACEHOLDER && block.content !== "[Old result cleared]") {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    const clearCount = allResults.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < allResults.length; i++) {
      const r = allResults[i];
      (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx].content = "[Old result cleared]";
    }
  }



  // Helper: find a tool_use block by its ID in assistant messages
  private findToolUseById(toolUseId: string): { name: string; input: any } | null {
    for (const msg of this.anthropicMessages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return { name: block.name, input: block.input };
        }
      }
    }
    return null;
  }

  // ─── Execute tool (handles agent tool internally) ─────────

  // ─── Large result persistence ───────────────────────────────
  // When a tool result exceeds 30 KB, write it to disk and replace the
  // context entry with a short preview + file path.  The model can use
  // read_file to retrieve the full output later — no information is lost.

  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024; // 30 KB
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    const dir = join(homedir(), ".mini-claude", "tool-results");
    mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${toolName}.txt`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    const preview = lines.slice(0, 200).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
  }

  private async executeToolCall(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
    if (name === "agent") return this.executeAgentTool(input);
    if (name === "skill") return this.executeSkillTool(input);
    // Route MCP tool calls to the MCP manager
    if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input);
    return executeTool(name, input, this.readFileState);
  }

  // ─── Skill fork mode ─────────────────────────────────────

  private async executeSkillTool(input: Record<string, any>): Promise<string> {
    const { executeSkill } = await import("./skills.js");
    const result = executeSkill(input.skill_name, input.args || "");
    if (!result) return `Unknown skill: ${input.skill_name}`;

    if (result.context === "fork") {
      // Fork mode: run in isolated sub-agent
      const tools = result.allowedTools
        ? this.tools.filter(t => result.allowedTools!.includes(t.name))
        : this.tools.filter(t => t.name !== "agent");

      printSubAgentStart("skill-fork", input.skill_name);
      const subAgent = new Agent({
        model: this.model,
        customSystemPrompt: result.prompt,
        customTools: tools,
        isSubAgent: true,
        permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
      });

      try {
        const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
        this.totalInputTokens += subResult.tokens.input;
        this.totalOutputTokens += subResult.tokens.output;
        printSubAgentEnd("skill-fork", input.skill_name);
        return subResult.text || "(Skill produced no output)";
      } catch (e: any) {
        printSubAgentEnd("skill-fork", input.skill_name);
        return `Skill fork error: ${e.message}`;
      }
    }

    // Inline mode: return prompt for injection into conversation
    return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
  }

  // ─── Plan mode helpers ──────────────────────────────────────

  private generatePlanFilePath(): string {
    const dir = join(homedir(), ".claude", "plans");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  private buildPlanModePrompt(): string {
    return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }

  private async executePlanModeTool(name: string): Promise<string> {
    if (name === "enter_plan_mode") {
      if (this.permissionMode === "plan") {
        return "Already in plan mode.";
      }
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      printInfo("Entered plan mode (read-only). Plan file: " + this.planFilePath);
      return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      if (this.permissionMode !== "plan") {
        return "Not in plan mode.";
      }
      // Read plan file content
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, "utf-8");
      }

      // Interactive approval flow
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        if (result.choice === "keep-planning") {
          // User rejected — stay in plan mode, return feedback to model
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }

        // User approved — determine the target mode
        let targetMode: PermissionMode;
        if (result.choice === "clear-and-execute") {
          targetMode = "acceptEdits";
        } else if (result.choice === "execute") {
          targetMode = "acceptEdits";
        } else {
          // manual-execute
          targetMode = this.prePlanMode || "default";
        }

        // Exit plan mode
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;
        this.systemPrompt = this.baseSystemPrompt;
        if (result.choice === "clear-and-execute") {
          this.clearHistoryKeepSystem();
          this.contextCleared = true; // Signal the agent loop to inject plan as user message
          printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
        }

        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }

      // Fallback: no approval function, just exit directly (e.g. sub-agents)
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      printInfo("Exited plan mode. Restored to " + this.permissionMode + " mode.");
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n## Your Plan:\n${planContent}`;
    }

    return `Unknown plan mode tool: ${name}`;
  }

  /** Clear history but keep system prompt intact (used for clear-context plan approval) */
  private clearHistoryKeepSystem() {
    this.anthropicMessages = [];
    this.lastInputTokenCount = 0;
  }

  private async executeAgentTool(input: Record<string, any>): Promise<string> {
    const type = (input.type || "general") as SubAgentType;
    const description = input.description || "sub-agent task";
    const prompt = input.prompt || "";

    printSubAgentStart(type, description);

    const config = getSubAgentConfig(type);
    const subAgent = new Agent({
      model: this.model,
      customSystemPrompt: config.systemPrompt,
      customTools: config.tools,
      isSubAgent: true,
      permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
    });

    try {
      const result = await subAgent.runOnce(prompt);
      // Add sub-agent token usage to parent
      this.totalInputTokens += result.tokens.input;
      this.totalOutputTokens += result.tokens.output;
      printSubAgentEnd(type, description);
      return result.text || "(Sub-agent produced no output)";
    } catch (e: any) {
      printSubAgentEnd(type, description);
      return `Sub-agent error: ${e.message}`;
    }
  }

  // ─── Anthropic backend ───────────────────────────────────────

  private async chatAnthropic(userMessage: string): Promise<void> {
    this.anthropicMessages.push({ role: "user", content: userMessage });
    // Auto-compact at turn boundary only — the last message is now plain
    // user text, so the slice in compactAnthropic won't sever a
    // tool_use ↔ tool_result pair from the previous turn's tool execution.
    await this.checkAndCompact();

    // Start async memory prefetch (non-blocking, fires once per user turn)
    let memoryPrefetch: MemoryPrefetch | null = null;
    if (!this.isSubAgent) {
      const sq = this.buildSideQuery();
      memoryPrefetch = startMemoryPrefetch(
        userMessage, sq,
        this.alreadySurfacedMemories, this.sessionMemoryBytes,
        this.abortController?.signal,
      );
    }

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call (tiers 1-3 are zero-cost)
      this.runCompressionPipeline();

      // Consume memory prefetch if settled (non-blocking poll, zero-wait).
      // Checked every iteration so the model sees recalled memories ASAP.
      // Memories are appended to the last user message (or added as a new one)
      // to avoid consecutive user messages which violate the API's alternation rule.
      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        try {
          const memories = await memoryPrefetch.promise;
          if (memories.length > 0) {
            const injectionText = formatMemoriesForInjection(memories);
            const last = this.anthropicMessages[this.anthropicMessages.length - 1];
            if (last && last.role === "user") {
              // Append to existing user message to maintain alternation
              if (typeof last.content === "string") {
                last.content = last.content + "\n\n" + injectionText;
              } else if (Array.isArray(last.content)) {
                (last.content as any[]).push({ type: "text", text: injectionText });
              }
            } else {
              this.anthropicMessages.push({ role: "user", content: injectionText });
            }
            for (const m of memories) {
              this.alreadySurfacedMemories.add(m.path);
              this.sessionMemoryBytes += Buffer.byteLength(m.content);
            }
          }
        } catch { /* prefetch errors already logged */ }
      }

      if (!this.isSubAgent) startSpinner();

      // ── Streaming tool execution ──────────────────────────────
      // As each tool_use content block completes during streaming, check
      // if it's concurrency-safe and auto-allowed. If so, start execution
      // immediately — the tool runs while the model still generates.
      const earlyExecutions = new Map<string, Promise<string>>();

      const response = await this.callAnthropicStream((block) => {
        const input = block.input as Record<string, any>;
        if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
          const perm = checkPermission(block.name, input, this.permissionMode, this.planFilePath || undefined);
          if (perm.action === "allow") {
            earlyExecutions.set(block.id, this.executeToolCall(block.name, input));
          }
        }
      });
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();
      this.totalInputTokens += response.usage.input_tokens;
      this.totalOutputTokens += response.usage.output_tokens;
      this.lastInputTokenCount = response.usage.input_tokens;

      const toolUses: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      this.anthropicMessages.push({
        role: "assistant",
        content: response.content,
      });

      if (toolUses.length === 0) {
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens);
        }
        break;
      }

      // Budget check after each turn
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Process tools: early-started ones (from streaming) just await their
      // result; others go through permission check + execution as before.
      let contextBreak = false;
      for (const toolUse of toolUses) {
        if (contextBreak || this.abortController?.signal.aborted) break;
        const input = toolUse.input as Record<string, any>;
        printToolCall(toolUse.name, input);

        // Was this tool already started during streaming?
        const earlyPromise = earlyExecutions.get(toolUse.id);
        if (earlyPromise) {
          const raw = await earlyPromise;
          const res = this.persistLargeResult(toolUse.name, raw);
          printToolResult(toolUse.name, res);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
          continue;
        }

        // Permission check for tools not started early
        const perm = checkPermission(toolUse.name, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
          const confirmed = await this.confirmDangerous(perm.message);
          if (!confirmed) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User denied this action." });
            continue;
          }
          this.confirmedPaths.add(perm.message);
        }

        const raw = await this.executeToolCall(toolUse.name, input);
        const res = this.persistLargeResult(toolUse.name, raw);
        printToolResult(toolUse.name, res);

        if (this.contextCleared) {
          this.contextCleared = false;
          this.anthropicMessages.push({ role: "user", content: res });
          contextBreak = true;
          break;
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
      }

      if (!contextBreak && !this.contextCleared && toolResults.length > 0) {
        this.anthropicMessages.push({ role: "user", content: toolResults });
      }
      this.contextCleared = false;
    }
  }

  /**
   * Stream an Anthropic API call. When a tool_use content block finishes
   * during streaming, `onToolBlockComplete` fires immediately so the caller
   * can start execution before the full response arrives (streaming tool
   * execution — mirrors Claude Code's content_block_stop approach).
   */
  private async callAnthropicStream(
    onToolBlockComplete?: (block: Anthropic.ToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      const maxOutput = getMaxOutputTokens(this.model);
      const createParams: any = {
        model: this.model,
        max_tokens: this.thinkingMode !== "disabled" ? maxOutput : 16384,
        system: this.systemPrompt,
        tools: getActiveToolDefinitions(this.tools),
        messages: this.anthropicMessages,
      };

      if (this.thinkingMode === "adaptive") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      } else if (this.thinkingMode === "enabled") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      }

      const stream = this.anthropicClient.messages.stream(createParams, { signal });

      // Stream text content (SDK high-level event)
      let firstText = true;
      stream.on("text", (text: string) => {
        if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
        this.emitText(text);
      });

      // ── Unified streamEvent handler for thinking + tool tracking ──
      // Track in-flight tool_use blocks by index. When content_block_stop
      // fires for a tool_use, parse accumulated JSON and notify caller
      // so it can start execution while later blocks still stream.
      const toolBlocksByIndex = new Map<number, { id: string; name: string; inputJson: string }>();
      let inThinking = false;

      stream.on("streamEvent" as any, (event: any) => {
        // Thinking passthrough
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          if (this.thinkingMode !== "disabled") {
            inThinking = true;
            stopSpinner();
            this.emitText("\n" + chalk.dim("  [thinking] "));
          }
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && inThinking) {
          this.emitText(chalk.dim(event.delta.thinking));
        }

        // Tool block tracking: accumulate input JSON as it streams
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolBlocksByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const tb = toolBlocksByIndex.get(event.index);
          if (tb) tb.inputJson += event.delta.partial_json;
        }

        // content_block_stop: finalize thinking or fire tool callback
        if (event.type === "content_block_stop") {
          if (inThinking) { this.emitText("\n"); inThinking = false; }
          const tb = toolBlocksByIndex.get(event.index);
          if (tb && onToolBlockComplete) {
            let parsedInput: Record<string, any> = {};
            try { parsedInput = JSON.parse(tb.inputJson || "{}"); } catch {}
            onToolBlockComplete({ type: "tool_use", id: tb.id, name: tb.name, input: parsedInput });
            toolBlocksByIndex.delete(event.index);
          }
        }
      });

      const finalMessage = await stream.finalMessage();

      // Filter out thinking blocks from stored history
      finalMessage.content = finalMessage.content.filter(
        (block: any) => block.type !== "thinking"
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── Shared ──────────────────────────────────────────────────

  private async confirmDangerous(command: string): Promise<boolean> {
    printConfirmation(command);
    // Use external confirmFn if provided (REPL mode passes one that reuses
    // the existing readline, avoiding the classic Node.js bug where a second
    // readline.createInterface on the same stdin kills the first one on close).
    if (this.confirmFn) {
      return this.confirmFn(command);
    }
    // Fallback for one-shot / non-REPL usage: create a temporary readline
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  }
}
