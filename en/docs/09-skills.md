# 9. Skills System

Reusable prompt modules: define once, call repeatedly.

```mermaid
graph TB
    subgraph Skills System
        Discover[Scan .claude/skills/] --> Parse[Parse SKILL.md<br/>frontmatter + template]
        Parse --> Inject[Inject into system prompt<br/>skills variable]
        Parse --> Invoke{Invocation}
        Invoke -->|User /name| REPL[CLI direct execution]
        Invoke -->|Model decides| Tool[skill tool call]
    end

    subgraph Shared Base
        FM[frontmatter.ts<br/>YAML parse/serialize]
    end

    Parse -.-> FM

    style FM fill:#7c5cfc,color:#fff
    style Inject fill:#e8e0ff
```

## SKILL.md Format

```markdown
---
name: commit
description: Create a git commit with a descriptive message
when_to_use: When the user asks to commit changes or says "commit"
allowed-tools: run_shell, read_file
user-invocable: true
---
Look at the current git diff and staged changes. Write a clear, concise
commit message following conventional commits format.

The user's request: $ARGUMENTS

Project skill directory: ${CLAUDE_SKILL_DIR}
```

- `when_to_use`: trigger condition for the model
- `allowed-tools`: safety boundary limiting the skill's tool access
- `user-invocable: false` skills can only be triggered by the model

## Discovery & Loading

```mermaid
flowchart LR
    U["~/.claude/skills/*"] -->|Low priority| Map["Map<name, Skill>"]
    P[".claude/skills/*"] -->|High priority overwrite| Map
    Map --> Cache["cachedSkills[]"]
```

```typescript
// skills.ts — discoverSkills
let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;
  const skills = new Map<string, SkillDefinition>();
  loadSkillsFromDir(join(homedir(), ".claude", "skills"), "user", skills);
  loadSkillsFromDir(join(process.cwd(), ".claude", "skills"), "project", skills);
  cachedSkills = Array.from(skills.values());
  return cachedSkills;
}
```

Map dedups naturally; loading user first then project lets project-level overwrite user-level.

## Skill Parsing

```typescript
// skills.ts — parseSkillFile
function parseSkillFile(
  filePath: string, source: "project" | "user", skillDir: string
): SkillDefinition | null {
  const raw = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);

  const name = meta.name || skillDir.split("/").pop() || "unknown";
  const userInvocable = meta["user-invocable"] !== "false";

  let allowedTools: string[] | undefined;
  if (meta["allowed-tools"]) {
    const raw = meta["allowed-tools"];
    if (raw.startsWith("[")) {
      try { allowedTools = JSON.parse(raw); } catch {
        allowedTools = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
      }
    } else {
      allowedTools = raw.split(",").map((s) => s.trim());
    }
  }

  return {
    name, description: meta.description || "",
    whenToUse: meta.when_to_use || meta["when-to-use"],
    allowedTools, userInvocable,
    promptTemplate: body, source, skillDir,
  };
}
```

`allowed-tools` accepts both comma-separated and JSON array forms; `when_to_use` accepts both underscore and hyphen keys.

## Prompt Template Substitution

```typescript
// skills.ts — resolveSkillPrompt
export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}
```

Claude Code also supports inline `` !`shell_command` `` execution — we don't (security risk, unnecessary for tutorial scope).

## Dual Invocation Paths

```mermaid
flowchart TD
    User["User input"] --> Check{Starts with /?}
    Check -->|"/commit fix types"| Parse["Parse: name=commit, args=fix types"]
    Check -->|"help me commit code"| Model["Model understands intent"]

    Parse --> Resolve["resolveSkillPrompt()"]
    Model --> SkillTool["Call skill tool"]
    SkillTool --> Execute["executeSkill()"]
    Execute --> Resolve

    Resolve --> Inject["Inject as user message"]
    Inject --> Chat["agent.chat()"]

    style Check fill:#7c5cfc,color:#fff
```

**Path 1: User manual invocation** (cli.ts)

```typescript
if (input.startsWith("/")) {
  const spaceIdx = input.indexOf(" ");
  const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
  const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
  const skill = getSkillByName(cmdName);
  if (skill && skill.userInvocable) {
    const resolved = resolveSkillPrompt(skill, cmdArgs);
    printInfo(`Invoking skill: ${skill.name}`);
    await agent.chat(resolved);
    return;
  }
}
```

**Path 2: Model programmatic invocation** (tools.ts)

```typescript
{
  name: "skill",
  description: "Invoke a registered skill by name...",
  input_schema: {
    properties: {
      skill_name: { type: "string" },
      args: { type: "string" },
    },
    required: ["skill_name"],
  },
}

function runSkillTool(input: { skill_name: string; args?: string }): string {
  const result = executeSkill(input.skill_name, input.args || "");
  if (!result) return `Unknown skill: ${input.skill_name}`;
  return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
}
```

The skill tool is a **meta-tool**: its return value isn't data, it's an instruction — the model executes according to this prompt in the next turn.

## Execution Modes: inline vs fork

```typescript
// agent.ts — executeSkillTool
private async executeSkillTool(input: Record<string, any>): Promise<string> {
  const result = executeSkill(input.skill_name, input.args || "");
  if (!result) return `Unknown skill: ${input.skill_name}`;

  if (result.context === "fork") {
    const tools = result.allowedTools
      ? this.tools.filter(t => result.allowedTools!.includes(t.name))
      : this.tools.filter(t => t.name !== "agent");
    const subAgent = new Agent({
      customSystemPrompt: result.prompt,
      customTools: tools,
      isSubAgent: true,
      permissionMode: "bypassPermissions",
    });
    const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
    return subResult.text;
  }

  return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
}
```

When forking without specified `allowedTools`, exclude the `agent` tool to prevent recursion. Skills involving multi-turn tool calls (code review etc.) use fork to keep the main conversation clean.

## System Prompt Description

```typescript
// skills.ts — buildSkillDescriptions
export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines = ["# Available Skills", ""];
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
  }

  lines.push("To invoke a skill programmatically, use the `skill` tool.");
  return lines.join("\n");
}
```

## Simplification Comparison

| Dimension | Claude Code | mini-claude |
|-----------|------------|-------------|
| **Skill sources** | 6 (managed/project/user/plugin/bundled/MCP) | 2 (project + user) |
| **Skill loading** | Lazy load + token budget control | Full load at startup + cache |
| **Prompt substitution** | `$ARGUMENTS` + `${CLAUDE_SKILL_DIR}` + `` !`shell` `` | `$ARGUMENTS` + `${CLAUDE_SKILL_DIR}` |
