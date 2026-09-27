// Run by lab-builder-offline.test.js under fixtures/no-npm-packages.mjs.
//
// A build that does read a vendor page, on a machine without sanitize-html.
// It must stop at the vendor-docs-unavailable blocker rather than crash.

import { generateLab } from "../../lib/lab-builder/generator.js";
import { createVendorFetcher } from "../../lib/lab-builder/vendor-docs.js";

const html =
  "<html><body><main><p>The Model Context Protocol lets an application expose tools that a language model " +
  "can discover and call, with each tool described by a name, a description, and a schema.</p></main></body></html>";

const session = {
  ok: true,
  endpoint: "https://learn.offline.test",
  async call(name) {
    if (name === "microsoft_docs_fetch") {
      return { content: [{ type: "text", text: "# Overview\n\nThis page explains the feature in prose only." }] };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              title: "Extend your agent with Model Context Protocol",
              url: "https://learn.microsoft.com/microsoft-copilot-studio/agent-extend-action-mcp",
              content: "A sufficiently long documentation excerpt to survive the minimum-length filter applied by searchDocs.",
            },
          ]),
        },
      ],
    };
  },
};

const result = await generateLab(
  { features: ["mcp-servers"], includeCore: false },
  {
    write: false,
    useLearnMcp: true,
    useLlm: false,
    connect: async () => session,
    fetchVendorDoc: createVendorFetcher({
      fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    }),
    decisions: { "steps-not-derived": "proceed-catalog" },
  },
);

const blocker = result.blockers[0];
console.log(
  JSON.stringify({
    status: result.status,
    code: blocker?.code || null,
    consequence: blocker?.consequence || "",
    kinds: (blocker?.detail?.pages || []).map((page) => page.errorKind),
  }),
);
