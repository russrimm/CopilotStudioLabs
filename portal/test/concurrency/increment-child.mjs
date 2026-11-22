// Child process for the "50 increments across two processes" test: it adds one to a JSON counter `count` times, each
// time under the cross-process lock, so no update can be lost.
import fs from "node:fs";
import { writeJsonAtomic } from "../../lib/concurrency/atomic-file.js";
import { lockPathFor, withFileLockSync } from "../../lib/concurrency/file-lock.js";

const [file, countArg] = process.argv.slice(2);
for (let i = 0; i < Number(countArg); i += 1) {
  withFileLockSync(lockPathFor(file), () => {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    writeJsonAtomic(file, { count: current.count + 1 });
  }, { timeoutMs: 30000, retryMs: 2 });
}
