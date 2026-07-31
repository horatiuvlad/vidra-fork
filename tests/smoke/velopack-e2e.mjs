#!/usr/bin/env node
// Drive a Velopack-packaged Vidra app through a real update round-trip.
//
//   node velopack-e2e.mjs --exe <binary> --feed <dir> --work <dir> [--port 8098]
//
// Three launches, because the claim under test is a claim about a sequence:
//
//   1. report  — Velopack recognises the app as installed, at 1.0.0
//   2. update  — the feed offers 1.0.1, it downloads, and staging succeeds
//   3. report  — the binary on disk is now 1.0.1, and its payload file changed
//
// The payload file is the load-bearing part: version numbers are bookkeeping
// that both sides could agree on while nothing was replaced. A file whose
// contents only the 1.0.1 build carries says the bytes actually moved.
//
// `--exe` is re-resolved before every launch: applying an update replaces the
// app directory, so a handle captured once would be to a directory that no
// longer exists.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const exe = required("exe");
const feedDir = required("feed");
const workDir = required("work");
const port = Number(args.port ?? 8098);
const launchTimeoutMs = Number(args["launch-timeout"] ?? 180) * 1000;

fs.mkdirSync(workDir, { recursive: true });

const server = await serve(feedDir, port);
const feedUrl = `http://127.0.0.1:${port}/`;
let failures = 0;

try {
  const first = await launch("1-report-before", { VIDRA_VELO_MODE: "report" });
  expect(first.isInstalled === "True", "Velopack recognises the app as installed", first.isInstalled);
  expect(first.currentVersion === "1.0.0", "reports version 1.0.0", first.currentVersion);
  expect(first.payload === "payload-1.0.0", "carries the 1.0.0 payload", first.payload);

  const applied = await launch("2-update", { VIDRA_VELO_MODE: "update" });
  expect(applied.error === null, "the update path raised nothing", applied.error);
  expect(applied.availableVersion === "1.0.1", "the feed offered 1.0.1", applied.availableVersion);
  expect(applied.downloaded === true, "the release downloaded", applied.downloaded);
  expect(applied.staged === true, "the update was handed to the updater", applied.staged);

  // The updater runs after the app exits; give it room, then re-resolve.
  await waitFor(() => readPayloadOnDisk() === "payload-1.0.1", 120_000,
    "the updater replaced the app on disk");

  const after = await launch("3-report-after", { VIDRA_VELO_MODE: "report" });
  expect(after.currentVersion === "1.0.1", "the updated app reports 1.0.1", after.currentVersion);
  expect(after.payload === "payload-1.0.1", "the updated app carries the 1.0.1 payload", after.payload);
  expect(after.isInstalled === "True", "the updated app is still a Velopack install", after.isInstalled);
} finally {
  server.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nPASS — Velopack applied a 1.0.0 -> 1.0.1 update and the bytes moved");

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function required(name) {
  const value = args[name];
  if (typeof value !== "string") {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

function expect(condition, what, actual) {
  if (condition) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what} (got ${JSON.stringify(actual)})`);
}

/** Static file server over the release directory — this is a Velopack feed. */
function serve(root, port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
      const file = path.join(root, rel);
      if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        console.log(`  feed 404 ${rel}`);
        return;
      }
      console.log(`  feed 200 ${rel}`);
      res.writeHead(200, { "content-length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

/**
 * The executable moves with the app directory when an update is applied, so
 * resolve it fresh. `--exe` may name the binary or, on macOS, the .app.
 */
function resolveExe() {
  if (exe.endsWith(".app")) {
    const macos = path.join(exe, "Contents", "MacOS");
    const entry = fs.readdirSync(macos).find((f) => !f.startsWith("."));
    return path.join(macos, entry);
  }
  return exe;
}

/**
 * On Windows the path passed as `--exe` is Velopack's shim at the install root;
 * the app that actually runs — and the one an update replaces — lives in
 * `current/`. Reading the payload next to the shim reports the *first*
 * install's file forever and makes a successful update look like a timeout.
 */
function readPayloadOnDisk() {
  const candidates = exe.endsWith(".app")
    ? [path.join(exe, "Contents", "Resources", "vidra-probe-payload.txt")]
    : [
        path.join(path.dirname(exe), "current", "vidra-probe-payload.txt"),
        path.join(path.dirname(exe), "vidra-probe-payload.txt"),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8").trim();
  }
  return null;
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { console.log(`  ok   ${what}`); return true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  failures++;
  console.error(`  FAIL ${what} (timed out after ${timeoutMs}ms)`);
  return false;
}

async function launch(label, env) {
  const proof = path.join(workDir, `${label}.json`);
  const log = path.join(workDir, `${label}.log`);
  fs.rmSync(proof, { force: true });

  const bin = resolveExe();
  console.log(`\n== launch ${label}: ${bin}`);
  const stream = fs.createWriteStream(log);
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      VIDRA_VELO_PROOF: proof,
      VIDRA_VELO_FEED: feedUrl,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline && !fs.existsSync(proof)) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!fs.existsSync(proof)) {
    child.kill("SIGKILL");
    await exited;
    failures++;
    console.error(`  FAIL ${label} produced no proof within ${launchTimeoutMs}ms`);
    console.error(tail(log));
    return {};
  }

  await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
  child.kill("SIGKILL");

  const parsed = JSON.parse(fs.readFileSync(proof, "utf8"));
  console.log(`  proof ${JSON.stringify(parsed)}`);
  return parsed;
}

function tail(file) {
  if (!fs.existsSync(file)) return "(no output captured)";
  return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-60).join("\n");
}
