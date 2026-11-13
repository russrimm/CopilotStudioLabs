import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/step-validation.js", import.meta.url), "utf8");

function loadUi(handler) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: false,
        disabled: false,
        innerHTML: "",
        textContent: "",
        style: {},
        children: [],
        firstElementChild: { style: {} },
        toggleAttribute() {},
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {} },
        get innerText() {
          return this.textContent;
        },
      });
    }
    return elements.get(id);
  };
  const calls = [];
  const window = { toast() {} };
  const context = {
    window,
    document: { getElementById: element, createElement: () => element(`new-${calls.length}`), querySelectorAll: () => [] },
    fetch: async (url, init = {}) => {
      const call = { method: init.method || "GET", url };
      calls.push(call);
      return handler(call);
    },
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { StepValidation: window.StepValidation, element, calls };
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const canceledJob = {
  jobId: "job-1",
  status: "canceled",
  progress: { labTotal: 40, labsDone: 0 },
  completedLabs: [],
  currentLab: null,
  report: { canceled: true, summary: { claimStatus: { verified: 0, unverified: 0, stale: 0, unable: 0 } }, labs: [] },
};

test("pressing Cancel while the run is still starting is not dropped: the run is canceled as soon as it has an id", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => (releaseStart = resolve));
  const { StepValidation, element, calls } = loadUi(async (call) => {
    if (call.method === "POST") {
      await startGate;
      return json(202, { jobId: "job-1", status: "running" });
    }
    return json(200, canceledJob);
  });

  const starting = StepValidation.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(element("step-validation-run").disabled, true);

  await StepValidation.cancel();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "nothing to cancel on the server yet");
  assert.match(element("step-validation-status").textContent, /Canceling/);

  releaseStart();
  await starting;
  await new Promise((r) => setTimeout(r, 20));

  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "the cancel reaches the server once the job exists");
  assert.match(deletes[0].url, /job-1$/);
  assert.equal(element("step-validation-run").disabled, false, "the run button is usable again");
  assert.equal(element("step-validation-cancel").hidden, true);
  assert.match(element("step-validation-status").textContent, /canceled/i);
});

test("Cancel after the run has an id still sends the cancel immediately", async () => {
  const { StepValidation, calls } = loadUi(async (call) => {
    if (call.method === "POST") return json(202, { jobId: "job-1", status: "running" });
    if (call.method === "DELETE") return json(200, { cancelled: true });
    return calls.some((c) => c.method === "DELETE") ? json(200, canceledJob) : json(200, { ...canceledJob, status: "running", report: null });
  });
  await StepValidation.start();
  await new Promise((r) => setTimeout(r, 20));
  await StepValidation.cancel();
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
});
