#!/usr/bin/env node
// Serves the built site for local preview: node tools/feature-tour/serve.mjs [--port=8080] [--dir=_site]
// Binds to 127.0.0.1 only and never serves files outside the chosen folder.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DEFAULTS } from "./lib/build.mjs";

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const port = Number(value("--port") ?? 8080);
const root = path.resolve(value("--dir") ?? DEFAULTS.out);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error(`No site found in ${root}. Run: npm run feature-tour:build`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  let file = path.join(root, pathname);
  if (path.relative(root, file).startsWith("..")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => console.log(`Feature tour preview: http://127.0.0.1:${port}/`));
