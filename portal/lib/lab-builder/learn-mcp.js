/**
 * Microsoft Learn MCP client.
 *
 * Minimal streamable-HTTP JSON-RPC client for the public Microsoft Learn MCP
 * server (https://learn.microsoft.com/api/mcp). No authentication is required.
 *
 * The server responds with `text/event-stream` framing even for single
 * request/response pairs, so responses are parsed out of SSE `data:` lines.
 *
 * Every call degrades gracefully: if the server is unreachable, slow, or
 * changes shape, the functions return an empty result set and the lab
 * generator falls back to the curated `docUrls` in the feature catalog.
 */

const DEFAULT_ENDPOINT = process.env.LEARN_MCP_URL || "https://learn.microsoft.com/api/mcp";
const DEFAULT_TIMEOUT_MS = Number(process.env.LEARN_MCP_TIMEOUT_MS || 30000);
const PROTOCOL_VERSION = "2025-06-18";

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

/** Pull JSON-RPC payloads out of an SSE or plain-JSON response body. */
function parseRpcBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  const messages = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* ignore malformed frames */
    }
  }
  return messages;
}

async function rpc(endpoint, sessionId, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Learn MCP responded ${res.status}: ${text.slice(0, 200)}`);
    }
    return {
      sessionId: res.headers.get("mcp-session-id") || sessionId || null,
      messages: parseRpcBody(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

function firstResult(messages, id) {
  const match = messages.find((m) => m && m.id === id);
  if (!match) return null;
  if (match.error) throw new Error(match.error.message || "Learn MCP returned an error");
  return match.result ?? null;
}

/**
 * Open an MCP session and return a `call(toolName, args)` helper.
 * Returns null when the handshake fails.
 */
export async function connect({ endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let sessionId = null;
  let nextId = 1;

  try {
    const init = await rpc(
      endpoint,
      null,
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "copilot-studio-labs-lab-builder", version: "1.0.0" },
        },
      },
      timeoutMs,
    );
    sessionId = init.sessionId;
    firstResult(init.messages, 1);
  } catch (err) {
    return { ok: false, error: err.message, endpoint, call: async () => null };
  }

  return {
    ok: true,
    endpoint,
    sessionId,
    async call(name, args) {
      const id = nextId++;
      const res = await rpc(
        endpoint,
        sessionId,
        { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
        timeoutMs,
      );
      return firstResult(res.messages, id);
    },
  };
}

/** Normalize an MCP tool result into plain text chunks. */
function toTextChunks(result) {
  if (!result) return [];
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
}

const URL_RE = /https?:\/\/[^\s)"'\]}<>]+/g;

/**
 * Turn a Learn search text chunk into { title, url, excerpt } records.
 * The server returns either a JSON array or markdown-ish text depending on
 * the query, so both shapes are handled.
 */
function parseSearchChunk(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.value)
        ? parsed.value
        : [parsed];
      return items
        .map((item) => ({
          title: String(item.title || item.name || "").trim(),
          url: String(item.contentUrl || item.url || item.link || "").trim(),
          excerpt: String(item.content || item.excerpt || item.snippet || "").trim(),
        }))
        .filter((item) => item.url || item.excerpt);
    } catch {
      /* fall through to text parsing */
    }
  }

  const urls = trimmed.match(URL_RE) || [];
  const titleMatch = trimmed.match(/^#{0,6}\s*(.+)$/m);
  return [
    {
      title: titleMatch ? titleMatch[1].trim().slice(0, 160) : "",
      url: urls[0] || "",
      excerpt: trimmed,
    },
  ].filter((item) => item.url || item.excerpt);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.url || item.title || item.excerpt).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Search Microsoft Learn for a single query.
 * @returns {Promise<Array<{title:string,url:string,excerpt:string}>>}
 */
export async function searchDocs(session, query, { limit = 6 } = {}) {
  if (!session?.ok) return [];

  const cacheKey = `search:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached.slice(0, limit);

  try {
    const result = await session.call("microsoft_docs_search", { query });
    const items = dedupeByUrl(toTextChunks(result).flatMap(parseSearchChunk))
      .filter((item) => item.excerpt && item.excerpt.length > 40);
    cacheSet(cacheKey, items);
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fetch a full Learn page as markdown.
 * @returns {Promise<string>} markdown, or "" on failure
 */
export async function fetchDoc(session, url) {
  if (!session?.ok || !url) return "";

  const cacheKey = `fetch:${url}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const result = await session.call("microsoft_docs_fetch", { url });
    const markdown = toTextChunks(result).join("\n\n");
    cacheSet(cacheKey, markdown);
    return markdown;
  } catch {
    cacheSet(cacheKey, "");
    return "";
  }
}

/**
 * Gather grounding material for one catalog feature.
 * Always resolves; falls back to the feature's curated docUrls.
 *
 * @returns {Promise<{featureId:string, results:Array, sources:Array, grounded:boolean}>}
 */
export async function groundFeature(session, feature, { perQuery = 4 } = {}) {
  const queries = feature.learnQueries?.length ? feature.learnQueries : [`Copilot Studio ${feature.name}`];
  const collected = [];

  for (const query of queries) {
    const items = await searchDocs(session, query, { limit: perQuery });
    collected.push(...items);
  }

  const results = dedupeByUrl(collected);
  const learnSources = results
    .filter((item) => item.url)
    .map((item) => ({ title: item.title || item.url, url: item.url }));

  const fallbackSources = (feature.docUrls || []).map((url) => ({ title: url, url }));
  const sources = dedupeByUrl([...learnSources, ...fallbackSources]).slice(0, 6);

  return {
    featureId: feature.id,
    results: results.slice(0, 8),
    sources,
    grounded: results.length > 0,
  };
}

export const LEARN_MCP_ENDPOINT = DEFAULT_ENDPOINT;
