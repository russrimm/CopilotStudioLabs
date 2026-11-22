import { parentPort } from "node:worker_threads";

// A tiny worker for the worker pool tests: it answers a few named tasks the tests ask for.
parentPort.on("message", async ({ id, fn, args }) => {
  if (fn === "echo") parentPort.postMessage({ id, result: args[0] });
  else if (fn === "pid") parentPort.postMessage({ id, result: `${process.pid}:${Math.random()}` });
  else if (fn === "fail") parentPort.postMessage({ id, error: { message: "That did not work.", status: 422, code: "nope" } });
  else if (fn === "crash") process.exit(3);
  else if (fn === "hang") {
    /* never answers: the pool's timeout has to stop it */
  } else parentPort.postMessage({ id, error: { message: "unknown", status: 500, code: "unknown" } });
});
