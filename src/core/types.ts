import type Anthropic from "@anthropic-ai/sdk";

// Permission modes — mirrors Claude Code's 5 external permission modes
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

// Tool definition type for Claude API (with optional deferred flag)
export type ToolDef = Anthropic.Tool & { deferred?: boolean };
