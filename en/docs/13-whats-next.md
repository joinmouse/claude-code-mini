# 13. Architecture Comparison & What's Next

## Full Architecture Comparison

| Component | Claude Code | mini-claude |
|-----------|------------|-------------|
| **Agent Loop** | 7 continue reasons | Only checks tool_use |
| **Tool count** | 66+ | 13 |
| **Tool execution** | StreamingToolExecutor concurrency | Streaming early + read-only parallel |
| **System Prompt** | static/dynamic boundary + API cache | No cache |
| **Permission system** | 7 layers + AST + 8-source rules | 5 modes + rules + regex + confirm |
| **Context** | 5-tier compression | 4 tiers |
| **Memory** | 4 types + semantic + MEMORY.md | 4 types + semantic + MEMORY.md + prefetch |
| **Skills** | 6 sources + lazy load + inline/fork | 2 sources + preload + inline/fork |
| **Multi-Agent** | Sub + custom + Coordinator + Swarm | Sub (3 built-in + custom) |
| **MCP** | mcpClient.ts + dynamic discovery | McpManager + JSON-RPC over stdio |
| **Budget** | USD/turn/abort tri-dimensional | USD + turn |
| **Edit validation** | 14 steps | Quote fault-tolerance + uniqueness + diff + read-before-edit + mtime |

## File Mapping

| mini-claude | Claude Code |
|-------------|-------------|
| `src/agent.ts` | `src/query.ts` + `src/QueryEngine.ts` |
| `src/tools.ts` | `src/Tool.ts` + `src/tools/` (66 dirs) |
| `src/prompt.ts` | `src/constants/prompts.ts` + `src/utils/claudemd.ts` |
| `src/cli.ts` | `src/entrypoints/cli.tsx` + `src/commands/` |
| `src/ui.ts` | `src/components/` (React/Ink) |
| `src/session.ts` | `src/utils/sessionStorage.ts` + `src/history.ts` |
| `src/memory.ts` | `src/utils/memory.ts` |
| `src/skills.ts` | `src/utils/skills.ts` + `src/tools/SkillTool/` |
| `src/subagent.ts` | `src/tools/AgentTool/` |
| `src/mcp.ts` | `src/services/mcpClient.ts` |

## Not Implemented (+ Reason)

| Not Implemented | Reason | What Claude Code Does |
|-----------------|--------|-----------------------|
| **Hooks** | 500-800 lines discovery/loading/isolation/protocol, doesn't help agent understanding | 25 events × 6 types, custom logic before/after tools |
| **Coordinator / Swarm** | More prompt engineering than architecture | Split large tasks / peer-mailbox communication |
| **LSP integration** | 1000+ lines, needs deep LSP protocol knowledge | Millisecond-level type-error feedback after edits |
| **Prompt Caching** | 20-30 lines change but needs careful partitioning | Static parts prefixed + `cache_control: ephemeral`, input tokens -90% |
| **Bash AST** | tree-sitter is a native library, `node-gyp` environment barrier | 23 static checks, dangerous commands in pipe compositions |

## Incremental Upgrade Path

| Stage | Enhancement | Lines |
|-------|-------------|-------|
| **Performance** | Prompt Caching | ~30 |
| **Extensibility** | Hook system / Tool type system | ~300 / 200 |
| **Reliability** | 7 error recovery strategies / Bash AST | ~400 / 600 |
| **Advanced** | Coordinator / Swarm / LSP | ~500 / 600 / 1000 |

**Highest ROI**: Prompt Caching. Add `cache_control: { type: "ephemeral" }` to the static part of the system prompt; save 50%+ input tokens over multi-turn conversations.

**Second worthwhile**: Error self-recovery — feed tool errors back to the model as `tool_result`:

```typescript
try { result = await executeToolImpl(name, input); }
catch (e) { result = `Error: ${e.message}\n\nPlease try a different approach.`; }
```

~50-80 lines, significantly improves practical usability.

## Core Insights

1. **The essence of an Agent is a while loop** — permissions, context, memory, multi-Agent are all enhancements and safeguards around it.
2. **Prompts are the cheapest code** — a sentence in the prompt = an if statement, cost 0 lines.
3. **Tool design determines the capability ceiling** — let the model do what it's good at (understand intent/generate code), let tools do what it isn't (exact string matching/file operations).
4. **Context management is the Agent's "memory"** — provide the illusion of "infinite" with finite resources.
5. **Security is not a post-hoc patch** — permission check is one step in the loop, fail-closed by design.
6. **The gap from 3K → 500K lines lies in edge cases** — environment compatibility, network/API unreliability, enterprise-grade auditing.
7. **The LLM ↔ code collaboration boundary** — model decides "what to do", code ensures "doing it safely".

## Cross-References

| Topic | This project | how-claude-code-works |
|-------|--------------|----------------------|
| Agent loop | [Ch1](/en/docs/01-agent-loop.md) | [System main loop](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/02-agent-loop) |
| Tool system | [Ch2](/en/docs/02-tools.md) | [Tool system](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/04-tool-system) |
| Context | [Ch7](/en/docs/07-context.md) | [Context engineering](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/03-context-engineering) |
| Permissions | [Ch6](/en/docs/06-permissions.md) | [Permission & security](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/10-permission-security) |
| Memory | [Ch8](/en/docs/08-memory.md) | [Memory system](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/08-memory-system) |
| Skills | [Ch9](/en/docs/09-skills.md) | [Skills system](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/09-skills-system) |
| Multi-Agent | [Ch11](/en/docs/11-multi-agent.md) | [Multi-Agent](https://windy3f3f3f3f.github.io/how-claude-code-works/#/en/docs/07-multi-agent) |

---

## Conclusion

~3400 lines of code (TS), 12 files, covering the core components and advanced capabilities of a coding agent:

**Phase 1 -- Core Components:** Agent Loop, Tool System (13 tools + mtime protection + lazy loading + parallel execution), System Prompt (Markdown template + @include + environment injection), CLI / Session (REPL + JSON persistence), Streaming Output (Anthropic streaming + streaming tool execution), Permission Security (5 modes + declarative rules + regex + confirmation), Context Management (4-layer compression + large result persistence)

**Phase 2 -- Advanced Capabilities:** Memory System (semantic recall + async prefetch), Skills System (inline/fork dual mode), Plan Mode (read-only planning + 4-option approval), Multi-Agent (Sub-Agent + 3 built-in types + custom), MCP Integration (JSON-RPC over stdio), Budget Control

A huge amount of the code in Claude Code's 500,000 lines is edge case handling and enterprise-grade reliability. But the core agent capabilities -- understand user intent -> call tools to manipulate code -> iterate until complete -- are exactly what these ~3400 lines do.

Now you have a feature-rich coding agent, and you understand the design intent behind every line of code. Go extend it.
