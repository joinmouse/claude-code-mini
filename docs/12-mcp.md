# 12. MCP 集成

动态加载外部工具。**spawn 子进程 → JSON-RPC 握手 → 发现工具 → 前缀注册 → 透明路由**。

```mermaid
graph TB
    Config["settings.json / .mcp.json"] --> Manager[McpManager]
    Manager -->|spawn + stdio| S1[MCP Server A]
    Manager -->|spawn + stdio| S2[MCP Server B]
    S1 -->|JSON-RPC| Tools1["mcp__A__tool1<br/>mcp__A__tool2"]
    S2 -->|JSON-RPC| Tools2["mcp__B__tool3"]
    Tools1 --> Agent[Agent Loop]
    Tools2 --> Agent

    Agent -->|tool_use: mcp__A__tool1| Manager
    Manager -->|路由到 Server A| S1

    style Manager fill:#7c5cfc,color:#fff
    style Agent fill:#e8e0ff
```

## 参考：Claude Code 的做法

- **配置**：`settings.json`（用户/项目级）+ `.mcp.json` + 企业 MDM 策略；后读覆盖先读
- **传输**：stdio（主流）+ SSE（远程）
- **命名**：`mcp__serverName__toolName` 三段式，同时解决冲突 + 路由
- **生命周期**：spawn → `initialize` → `notifications/initialized` → `tools/list` → 就绪；两次调用各 15s 超时
- **动态刷新**：服务器可通知客户端工具列表变更
- **依赖 `@anthropic-ai/sdk`** 内置 MCP 客户端

## 配置格式

```json
// ~/.claude/settings.json 或 .claude/settings.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    }
  }
}
```

`.mcp.json` 格式相同。三处合并，同名后读覆盖。

## 简化对比

| Claude Code | mini-claude | 简化原因 |
|-------------|-------------|---------|
| SDK 内置客户端 | 原始 JSON-RPC（~100 行） | 无 SDK 依赖，看到协议细节 |
| stdio + SSE | 仅 stdio | 覆盖 95% 场景 |
| 动态刷新 | 一次性发现 | 教程无需热更新 |
| 3 源 + 企业策略 | settings.json + .mcp.json | 去企业级 |
| 重试 + 降级 | 静默跳过失败 | 简化错误处理 |

## McpConnection

```typescript
// mcp.ts
class McpConnection {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private rl: Interface | null = null;

  constructor(private serverName: string, private config: McpServerConfig) {}

  async connect(): Promise<void> {
    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"], env,
    });

    // 按行解析 stdout 的 JSON-RPC
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          else           resolve(msg.result);
        }
      } catch { /* 忽略非 JSON 行（服务器日志） */ }
    });
  }

  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable)
        return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mini-claude", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest("tools/list");
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t: any) => ({
      name: t.name, description: t.description || "",
      inputSchema: t.inputSchema, serverName: this.serverName,
    }));
  }

  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if (result?.content && Array.isArray(result.content)) {
      return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    }
    return JSON.stringify(result);
  }
}
```

要点：
- **JSON-RPC 请求 vs 通知**：有无 `id` 字段。请求写入 `pending` 等配对；通知发后不管。
- **`initialize` 后必须发 `notifications/initialized`** 确认就绪。
- MCP 返回 `{ content: [{ type: "text", text: "..." }] }`；只提取 text 拼接（图片等其它类型暂不处理）。

## McpManager

```typescript
// mcp.ts
export class McpManager {
  private connections = new Map<string, McpConnection>();
  private tools: McpToolInfo[] = [];
  private connected = false;

  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    this.mergeConfigFile(join(homedir(), ".claude", "settings.json"), merged);
    this.mergeConfigFile(join(process.cwd(), ".claude", "settings.json"), merged);
    this.mergeConfigFile(join(process.cwd(), ".mcp.json"), merged);
    return merged;
  }

  private mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const servers = raw.mcpServers || raw;   // 兼容嵌套/扁平
      for (const [name, config] of Object.entries(servers)) {
        if (this.isValidConfig(config)) target[name] = config as McpServerConfig;
      }
    } catch { /* 静默跳过格式错误 */ }
  }

  async loadAndConnect(): Promise<void> {
    if (this.connected) return;              // 幂等
    this.connected = true;
    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) return;

    const TIMEOUT_MS = 15_000;
    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();
        await Promise.race([
          conn.initialize(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
        ]);
        const serverTools = await Promise.race([
          conn.listTools(),
          new Promise<McpToolInfo[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
        ]);
        this.connections.set(name, conn);
        this.tools.push(...serverTools);
        console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
      } catch (err: any) {
        console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
        conn.close();
      }
    }
  }

  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
    return this.tools.map((t) => ({
      name: `mcp__${t.serverName}__${t.name}`,
      description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  isMcpTool(name: string): boolean { return name.startsWith("mcp__"); }

  async callTool(prefixedName: string, args: any): Promise<string> {
    const parts = prefixedName.split("__");
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1];
    const toolName = parts.slice(2).join("__");   // 工具名可能含 __
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args);
  }
}
```

15s 超时：`npx` 首次下载常需 3-8s，15s 覆盖多数场景，超时静默跳过不影响其它服务器。

## Agent 集成（两处改动）

```typescript
// agent.ts — chat() 开头，懒加载
if (!this.mcpInitialized && !this.isSubAgent) {
  this.mcpInitialized = true;
  try {
    await this.mcpManager.loadAndConnect();
    const mcpDefs = this.mcpManager.getToolDefinitions();
    if (mcpDefs.length > 0) this.tools = [...this.tools, ...mcpDefs as ToolDef[]];
  } catch (err: any) { console.error(`[mcp] Init failed: ${err.message}`); }
}

// agent.ts — executeToolCall() 路由
private async executeToolCall(name: string, input: Record<string, any>): Promise<string> {
  if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
  if (name === "agent") return this.executeAgentTool(input);
  if (name === "skill") return this.executeSkillTool(input);
  if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input);
  return executeTool(name, input, this.readFileState);
}
```

三个决策：**懒加载**（首次 chat 才连接，短问题零开销）、**只主 Agent 连**（子继承）、**失败不崩溃**（只输出日志继续用内置）。

## 简化对比

| 维度 | Claude Code | mini-claude |
|------|------------|-------------|
| MCP SDK | `@anthropic-ai/sdk` 内置 | 原始 JSON-RPC 无依赖 |
| 传输 | stdio + SSE | 仅 stdio |
| 工具发现 | 动态刷新 | 一次性 |
| 配置来源 | settings + .mcp.json + 企业 | settings + .mcp.json |
| 错误处理 | 重试 + 降级 | 静默跳过 |
| 子 Agent | 独立连接 | 继承主 Agent 工具 |
