import type Anthropic from "@anthropic-ai/sdk";
import { printInfo } from "./ui.js";

// ─── Constants ──────────────────────────────────────────────

export const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
export const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;
const KEEP_RECENT_RESULTS = 3;

export interface CompressorConfig {
  messages: Anthropic.MessageParam[];
  effectiveWindow: number;
  getInputTokens: () => number;
  setInputTokens: (v: number) => void;
  getLastApiCallTime: () => number;
  client: Anthropic;
  model: string;
}

/**
 * 4-layer compression pipeline (mirrors Claude Code):
 * budget → snip → microcompact → auto-compact.
 * Tiers 1-3 are zero-API-cost; tier 4 calls the LLM to summarise.
 */
export class Compressor {
  constructor(private c: CompressorConfig) {}

  // Tiers 1-3 — run before every API call (zero-cost)
  runPipeline(): void {
    this.budgetToolResults();
    this.snipStaleResults();
    this.microcompact();
  }

  // Tier 4 — run at turn boundary when >85 % full
  async checkAndCompact(): Promise<void> {
    if (this.c.getInputTokens() > this.c.effectiveWindow * 0.85) {
      printInfo("Context window filling up, compacting conversation...");
      const lastMsg = this.c.messages[this.c.messages.length - 1];
      const summary = await this.summariseMessages();
      this.c.messages.length = 0;
      this.c.messages.push(
        { role: "user", content: `[Previous conversation summary]\n${summary}` },
        { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
      );
      if (lastMsg.role === "user") this.c.messages.push(lastMsg);
      this.c.setInputTokens(0);
      printInfo("Conversation compacted.");
    }
  }

  // ── private helpers ────────────────────────────────────────

  /** Truncate large tool results proportionally to context utilisation. */
  private budgetToolResults(): void {
    const utilization = this.c.getInputTokens() / this.c.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.c.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          block.content = block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  /** Replace old/duplicate results with a placeholder. */
  private snipStaleResults(): void {
    if (this.c.getInputTokens() / this.c.effectiveWindow < SNIP_THRESHOLD) return;
    const toolUseMap = this.buildToolUseLookup();

    const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
    for (let mi = 0; mi < this.c.messages.length; mi++) {
      const msg = this.c.messages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          const info = toolUseMap.get(block.tool_use_id);
          if (info && SNIPPABLE_TOOLS.has(info.name)) {
            results.push({ msgIdx: mi, blockIdx: bi, toolName: info.name, filePath: info.input?.file_path });
          }
        }
      }
    }
    if (results.length <= KEEP_RECENT_RESULTS) return;

    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>();
    for (let i = 0; i < results.length; i++) {
      if (results[i].toolName === "read_file" && results[i].filePath) {
        const arr = seenFiles.get(results[i].filePath!) || [];
        arr.push(i);
        seenFiles.set(results[i].filePath!, arr);
      }
    }
    for (const indices of seenFiles.values()) {
      for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
    }
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    for (const idx of toSnip) {
      const r = results[idx];
      (this.c.messages[r.msgIdx].content as any[])[r.blockIdx].content = SNIP_PLACEHOLDER;
    }
  }

  /** Clear old results when prompt cache is cold. */
  private microcompact(): void {
    if (!this.c.getLastApiCallTime() || (Date.now() - this.c.getLastApiCallTime()) < MICROCOMPACT_IDLE_MS) return;

    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.c.messages.length; mi++) {
      const msg = this.c.messages[mi];
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
      (this.c.messages[allResults[i].msgIdx].content as any[])[allResults[i].blockIdx].content = "[Old result cleared]";
    }
  }

  private buildToolUseLookup(): Map<string, { name: string; input: any }> {
    const map = new Map<string, { name: string; input: any }>();
    for (const msg of this.c.messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_use" && block.id) {
          map.set(block.id, { name: block.name, input: block.input });
        }
      }
    }
    return map;
  }

  private async summariseMessages(): Promise<string> {
    const summaryResp = await this.c.client.messages.create({
      model: this.c.model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        { role: "user", content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work." },
      ],
    });
    return summaryResp.content[0]?.type === "text" ? summaryResp.content[0].text : "No summary available.";
  }
}
