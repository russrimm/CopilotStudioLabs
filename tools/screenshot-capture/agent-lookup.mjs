// Finding the practice agent that was just created, or that an earlier run started to create.
//
// After the one click that creates the agent, the product leaves the new-agent page for the new agent's OWN page, and its address holds the agent's id. That address
// is the answer: it names exactly one agent, whatever it is called. Only when the page stays where it was (the agent is made and the page says Saved) is the Agents
// list searched, by the agent's exact name, and the list can lag behind a new agent (it is read again, for a bounded time, never forever).
// A name that two rows have is never guessed: the caller is told so and nothing is opened.

import { findAgentSteps } from "./scratch-recipes.mjs";
import { sanitizeSteps } from "./setup-steps.mjs";
import { parseCopilotStudioAddress } from "./targets.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long the new agent's own address is waited for after the create click, and how long the Agents list is read again for an agent it does not show yet. */
export const NEW_AGENT_ADDRESS_WAIT_MS = 20_000;
export const AGENT_LIST_WAIT_MS = 45_000;

/** The parsed address of the page when it is an agent's own page (it holds an agent id), else null. */
export function agentAddressOf(page) {
  const parsed = parseCopilotStudioAddress(typeof page?.url === "function" ? page.url() : "");
  return parsed.ok && AGENT_ID.test(parsed.botId || "") ? parsed : null;
}

/** Wait, for a bounded time, until the page is an agent's own page (the new agent's page after Save). Returns the parsed address, or null. */
export async function waitForAgentAddress({ page, sleep = sleepDefault, waitMs = NEW_AGENT_ADDRESS_WAIT_MS, stepMs = 500 }) {
  let waited = 0;
  for (;;) {
    const found = agentAddressOf(page);
    if (found) return found;
    if (waited >= waitMs) return null;
    await sleep(stepMs);
    waited += stepMs;
  }
}

/**
 * Open the practice agent's row in the Agents list by its exact name, and read the agent's address from where the page lands. The list is opened again for every
 * try (a list that lags is waited for), for at most `waitMs`. `executorFor(practice)` makes the executor that runs the steps.
 * @returns {Promise<{signIn?: object, parsed?: object, failed?: object, ambiguous?: number}>} `ambiguous` is how many rows have the name (nothing was opened)
 */
export async function findAgentByName({ page, go, env, name, executorFor, practice, sleep = sleepDefault, waitMs = AGENT_LIST_WAIT_MS, trace = null }) {
  const perTryMs = Math.min(15_000, Math.max(500, waitMs));
  const started = Date.now();
  let waited = 0;
  let last = null;
  for (let attempt = 0; ; attempt += 1) {
    const list = await go(`${env.envBase}/agents`, "the list of agents");
    if (list?.signIn) return { signIn: list.signIn };
    // The row is the agent's "Open <name>" button; the older list has the name itself as the link.
    for (const by of ["open-button", "name"]) {
      const found = await executorFor(practice).run(sanitizeSteps(findAgentSteps(name, { by, waitMs: perTryMs }), { product: "copilot-studio" }));
      last = found;
      if (found.failed?.ambiguous) {
        trace?.event("find-agent", { found: false, ambiguous: found.failed.ambiguous });
        return { failed: found, ambiguous: found.failed.ambiguous };
      }
      if (found.ok) {
        const parsed = await waitForAgentAddress({ page, sleep, waitMs: 5000 });
        if (parsed) return { parsed };
      }
    }
    waited += perTryMs;
    const spent = Math.max(Date.now() - started, waited);
    trace?.event("find-agent", { found: false, attempt: attempt + 1, waitedMs: spent });
    if (spent >= waitMs) return { failed: last };
    await sleep(1000);
  }
}
