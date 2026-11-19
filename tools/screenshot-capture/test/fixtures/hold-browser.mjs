// Test helper, started by profile-in-use.test.mjs. It starts a real headless browser through the companion's own launcher on a
// throwaway profile folder, prints its process number and debugging port, and then does what the test asks:
//   stay   keep running until the test ends this process by force (a companion that crashed hard, leaving its browser)
//   crash  throw an error nobody catches
//   exit   leave without closing the browser
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchAttached } from "../../attach.mjs";
import { loadPlaywrightModule } from "../../lab-runner.mjs";

const [, , dir, mode = "stay"] = process.argv;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const playwright = await loadPlaywrightModule(root);
const opened = await launchAttached({ playwright, kind: "chrome", dir, executable: playwright.chromium.executablePath(), headless: true });
console.log(JSON.stringify({ ready: true, pid: opened.context.companionPid, port: opened.port }));
if (mode === "crash") setTimeout(() => {
  throw new Error("simulated crash");
}, 200);
else if (mode === "exit") setTimeout(() => process.exit(0), 200);
else setInterval(() => {}, 1000);
