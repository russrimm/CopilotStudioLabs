/**
 * AI writing: how many prompts a lab will use, estimated before the build.
 *
 * Every prompt counts against the person's Copilot allowance and the SDK does not report what a prompt costs, so the picker
 * shows this number instead. It comes from counting what the engine would ask for real labs of 2, 6 and 9 modules (the plan-only
 * mode of tools/lab-builder/ai-measure.mjs, which calls no model): requests grow in a straight line with the number of modules.
 * `retryShare` leaves room for the retries and halved requests a slow service causes.
 *
 * ai-writing.js (the wizard) carries the same formula, fed with these numbers from /api/ai/status, so the page and the server
 * agree. portal/test/ai-estimate.test.js checks both against the engine's own count.
 */

export const ESTIMATE_PARAMS = Object.freeze({
  // Prompts for the lab text, which also covers the concept points the lab-day decks use.
  lab: Object.freeze({ base: 1, perModule: 0.55 }),
  // Prompts when only the lab-day decks are chosen: the concept points alone.
  labday: Object.freeze({ base: 0.5, perModule: 0.3 }),
  // Prompts for the training decks (the foundations deck, a deck for each module and the complete deck).
  training: Object.freeze({ base: 3, perModule: 3.5 }),
  retryShare: 0.1,
});

/**
 * @param {{modules: number, scope: string[]}} input  modules counts every module in the lab, refreshers included
 * @returns {{prompts: number, byPart: {lab: number, training: number, labday: number}}}
 */
export function estimatePrompts({ modules, scope }, params = ESTIMATE_PARAMS) {
  const count = Math.max(1, Math.floor(Number(modules) || 0));
  const chosen = new Set(Array.isArray(scope) ? scope : []);
  const part = ({ base, perModule }) => base + perModule * count;
  const byPart = {
    lab: chosen.has("lab") ? part(params.lab) : 0,
    // The lab text already carries the concept points, so the lab-day decks add requests only when the lab text is not chosen.
    labday: chosen.has("labday") && !chosen.has("lab") ? part(params.labday) : 0,
    training: chosen.has("training") ? part(params.training) : 0,
  };
  const raw = byPart.lab + byPart.labday + byPart.training;
  return {
    prompts: raw ? Math.ceil(raw * (1 + params.retryShare)) : 0,
    byPart: { lab: Math.ceil(byPart.lab), training: Math.ceil(byPart.training), labday: Math.ceil(byPart.labday) },
  };
}
