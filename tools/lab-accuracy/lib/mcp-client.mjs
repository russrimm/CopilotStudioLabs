// Minimal client for the Microsoft Learn MCP server (Streamable HTTP transport).
// Docs: https://learn.microsoft.com/training/support/mcp  (endpoint: https://learn.microsoft.com/api/mcp)
//
// Implements just enough JSON-RPC 2.0 to initialize a session and call the
// `microsoft_docs_search` and `microsoft_docs_fetch` tools. Responses may be
// returned as application/json or as text/event-stream; both are handled.

const DEFAULT_ENDPOINT =
  process.env.MS_LEARN_MCP_URL || "https://learn.microsoft.com/api/mcp";
const PROTOCOL_VERSION = "2025-06-18";

function parseSsePayload(text) {
  // Concatenate all `data:` lines and return the last valid JSON-RPC object.
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  let last = null;
  for (const line of dataLines) {
    try {
      last = JSON.parse(line);
    } catch {
      /* ignore keep-alive / partial frames */
    }
  }
  return last;
}

export class LearnMcpClient {
  constructor(endpoint = DEFAULT_ENDPOINT) {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextId = 1;
  }

  async #post(body, { notification = false } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (notification) return null;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    const payload = contentType.includes("text/event-stream")
      ? parseSsePayload(text)
      : JSON.parse(text);

    if (payload && payload.error) {
      throw new Error(
        `MCP error ${payload.error.code}: ${payload.error.message}`,
      );
    }
    return payload ? payload.result : null;
  }

  async initialize() {
    const result = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "copilot-studio-lab-accuracy", version: "1.0.0" },
      },
    });
    await this.#post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { notification: true },
    );
    return result;
  }

  async callTool(name, args) {
    const result = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return result;
  }

  /** Run a docs search and return normalized result entries. */
  async search(query) {
    const result = await this.callTool("microsoft_docs_search", { query });
    return normalizeContent(result);
  }
}

/** Flatten MCP tool content blocks into an array of { title, url, snippet }. */
function normalizeContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const entries = [];
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    // The Learn MCP returns JSON-encoded arrays of results inside text blocks.
    try {
      const parsed = JSON.parse(block.text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        entries.push({
          title: item.title ?? item.name ?? null,
          url: item.contentUrl ?? item.url ?? null,
          snippet: (item.content ?? item.snippet ?? "").slice(0, 280),
        });
      }
    } catch {
      entries.push({ title: null, url: null, snippet: block.text.slice(0, 280) });
    }
  }
  return entries;
}
