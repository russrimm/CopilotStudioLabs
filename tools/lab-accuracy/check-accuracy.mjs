// Monthly accuracy check for every lab.
//
// For each lab it:
//   1. Validates that all Microsoft Learn reference links still resolve (no 404/410).
//   2. Queries the Microsoft Learn MCP server for the lab's primary topic and
//      records whether current authoritative docs still cover it (drift signal).
//
// Writes out/accuracy.json. Exit code is 0 unless --strict is passed and there
// are critical findings (broken links), so the workflow stays informational by
// default and can still gate when desired.

import { loadAllLabs, writeReport } from "./lib/labs.mjs";
import { LearnMcpClient } from "./lib/mcp-client.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const skipMcp = args.includes("--no-mcp");
const LINK_TIMEOUT_MS = 15000;
const LINK_CONCURRENCY = 6;

async function checkLink(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // Some Learn endpoints reject HEAD, so use GET but discard the body.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "copilot-studio-lab-accuracy/1.0 (+monthly-link-check)" },
    });
    return { url, status: res.status, ok: res.ok, finalUrl: res.url };
  } catch (error) {
    return { url, status: 0, ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildSearchQuery(lab) {
  const product = lab.products[0] || "Microsoft Copilot Studio";
  const focus = lab.tags.slice(0, 3).join(", ");
  return focus ? `${product}: ${focus}` : `${product}: ${lab.title}`;
}

async function main() {
  const labs = loadAllLabs();
  const report = {
    generatedAt: new Date().toISOString(),
    mcpEndpoint: process.env.MS_LEARN_MCP_URL || "https://learn.microsoft.com/api/mcp",
    summary: { labs: labs.length, brokenLinks: 0, mcpDriftWarnings: 0, mcpUnavailable: false },
    labs: [],
  };

  let mcp = null;
  if (!skipMcp) {
    try {
      mcp = new LearnMcpClient();
      await mcp.initialize();
    } catch (error) {
      console.warn(`MS Learn MCP unavailable: ${error.message}`);
      report.summary.mcpUnavailable = true;
      mcp = null;
    }
  }

  for (const lab of labs) {
    const linkResults = await mapWithConcurrency(lab.learnLinks, LINK_CONCURRENCY, checkLink);
    // HTTP 4xx/5xx are definite breakages; status 0 means a transient network
    // error (timeout, DNS) that we surface as "unreachable" rather than broken.
    const broken = linkResults.filter((r) => r.status >= 400);
    const unreachable = linkResults.filter((r) => r.status === 0);
    report.summary.brokenLinks += broken.length;

    const labRecord = {
      name: lab.name,
      title: lab.title,
      indexPath: lab.indexPath,
      learnLinkCount: lab.learnLinks.length,
      brokenLinks: broken,
      unreachableLinks: unreachable,
      mcp: { query: null, topResults: [], coversReferencedDocs: null, note: null },
    };

    if (mcp) {
      const query = buildSearchQuery(lab);
      labRecord.mcp.query = query;
      try {
        const results = await mcp.search(query);
        labRecord.mcp.topResults = results.slice(0, 5);
        // Drift signal: do any current top docs share a host/path with the
        // lab's referenced Learn links? If the lab cites Learn docs but none
        // appear in fresh search results, flag for a human review.
        if (lab.learnLinks.length > 0) {
          const referenced = new Set(
            lab.learnLinks.map((u) => safePath(u)).filter(Boolean),
          );
          const overlap = results.some((r) => r.url && referenced.has(safePath(r.url)));
          labRecord.mcp.coversReferencedDocs = overlap;
          if (!overlap) {
            labRecord.mcp.note =
              "None of this lab's cited Learn pages appeared in current top search results — verify the docs have not moved or been deprecated.";
            report.summary.mcpDriftWarnings += 1;
          }
        }
      } catch (error) {
        labRecord.mcp.note = `MCP query failed: ${error.message}`;
      }
    }

    report.labs.push(labRecord);
    const status = broken.length ? `${broken.length} broken link(s)` : "links OK";
    console.log(`• ${lab.name}: ${status}${labRecord.mcp.note ? " | drift: yes" : ""}`);
  }

  const target = writeReport("accuracy.json", report);
  console.log(`\nAccuracy report written to ${target}`);
  console.log(
    `Summary: ${report.summary.brokenLinks} broken link(s), ${report.summary.mcpDriftWarnings} drift warning(s)` +
      (report.summary.mcpUnavailable ? " (MCP unavailable)" : ""),
  );

  if (strict && report.summary.brokenLinks > 0) process.exit(1);
}

function safePath(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
