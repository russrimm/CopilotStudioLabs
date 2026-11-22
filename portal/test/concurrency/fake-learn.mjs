/**
 * A fake Microsoft Learn MCP server for the concurrency harness: just enough of the streamable-HTTP JSON-RPC protocol
 * (initialize, tools/call microsoft_docs_search and microsoft_docs_fetch) to let "add a Learn topic by link" and "add a
 * product" run without any network. It answers only on 127.0.0.1 and counts every call so a run can show how many times
 * the portal reached "Learn".
 */

import http from "node:http";

function titleFromUrl(url) {
  const slug = String(url || "").split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "documentation";
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pageMarkdown(url) {
  const title = titleFromUrl(url);
  return [
    `# ${title}`,
    "",
    `${title} helps a Contoso team set up a working example from start to finish, using only sample data from Fabrikam.`,
    "",
    "## Before you begin",
    "",
    "Make sure you have a trial environment and permission to create resources in it.",
    "",
    "## Set it up",
    "",
    "1. Open the maker portal and select **Create**.",
    "2. Name the item and choose **Save**.",
    "3. Select **Test** to confirm it works.",
    "",
    "## Next steps",
    "",
    `- Learn more about ${title.toLowerCase()} in the documentation hub.`,
    "",
  ].join("\n");
}

function searchResults(query) {
  return JSON.stringify(
    [1, 2, 3].map((n) => ({
      title: `${query} sample ${n}`,
      contentUrl: `https://learn.microsoft.com/microsoft-copilot-studio/sample-${n}`,
      content: `Sample ${n} explains ${query} with a Contoso walkthrough that is long enough to be kept as an excerpt.`,
    })),
  );
}

/** @returns {Promise<{url: string, stats: {initialize: number, search: number, fetch: number}, close: () => Promise<void>}>} */
export async function startFakeLearn({ latencyMs = 0 } = {}) {
  const stats = { initialize: 0, search: 0, fetch: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let message = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* an empty or malformed body is answered as an error below */
      }
      const reply = () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "fake-session");
        if (message.method === "initialize") {
          stats.initialize += 1;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-learn", version: "1.0.0" } } }));
          return;
        }
        if (message.method === "tools/call") {
          const name = message.params?.name;
          const args = message.params?.arguments || {};
          let text = "";
          if (name === "microsoft_docs_search") {
            stats.search += 1;
            text = searchResults(String(args.query || "topic"));
          } else if (name === "microsoft_docs_fetch") {
            stats.fetch += 1;
            text = pageMarkdown(args.url);
          }
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Method not found" } }));
      };
      if (latencyMs > 0) setTimeout(reply, latencyMs);
      else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/mcp`,
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
