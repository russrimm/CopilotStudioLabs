/**
 * Preloaded into the portal process by the concurrency harness (node --import). It measures what the portal cannot say
 * about itself: how long the event loop stalls (a stalled loop is what every other person feels) and how much memory the
 * process holds. The harness asks for a snapshot over the IPC channel, so no route and no server code is needed, and the
 * same preload measures an older checkout for a before/after comparison.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

if (typeof process.send === "function") {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  let peakRss = 0;
  let startRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 200);
  sampler.unref();

  const ms = (nanos) => Math.round((Number(nanos) / 1e6) * 100) / 100;

  process.on("message", (message) => {
    if (message?.type === "reset") {
      histogram.reset();
      startRss = process.memoryUsage().rss;
      peakRss = startRss;
      process.send({ type: "reset", id: message.id });
    } else if (message?.type === "snapshot") {
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      process.send({
        type: "snapshot",
        id: message.id,
        lag: { meanMs: ms(histogram.mean), p50Ms: ms(histogram.percentile(50)), p95Ms: ms(histogram.percentile(95)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) },
        memory: { startRssMb: Math.round(startRss / 1048576), endRssMb: Math.round(usage.rss / 1048576), peakRssMb: Math.round(peakRss / 1048576), heapUsedMb: Math.round(usage.heapUsed / 1048576) },
      });
    }
  });
}
