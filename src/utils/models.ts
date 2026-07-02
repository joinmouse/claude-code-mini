// ─── Model context windows ──────────────────────────────────

const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-20250514": 200000,
};

export function getContextWindow(model: string): number {
  return MODEL_CONTEXT[model] || 200000;
}

// ─── Thinking support detection ─────────────────────────────
// Mirrors Claude Code: adaptive for 4.6, enabled for older Claude 4, disabled for the rest.

export function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("claude-3-") || m.includes("3-5-") || m.includes("3-7-")) return false;
  if (m.includes("claude") && (m.includes("opus") || m.includes("sonnet") || m.includes("haiku"))) return true;
  return false;
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

// Max output tokens by model (mirrors Claude Code's context.ts)
export function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus-4-6")) return 64000;
  if (m.includes("sonnet-4-6")) return 32000;
  if (m.includes("opus-4") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32000;
  return 16384;
}
