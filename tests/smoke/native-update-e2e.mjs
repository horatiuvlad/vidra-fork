#!/usr/bin/env node
// Drive a Velopack-packaged Vidra app through a real native update round-trip.
//
//   node native-update-e2e.mjs --exe <binary|.app> --feed <dir> --work <dir> [--port 8098]
//
// Three launches, because the claim under test is a claim about a sequence:
//
//   1. report  — the app knows it is installed, at 1.0.0
//   2. update  — the feed offers 1.0.1, it downloads, and staging succeeds
//   3. report  — the binary on disk is now 1.0.1, and its payload file changed
//
// The payload file is the load-bearing part: version numbers are bookkeeping
// that both sides could agree on while nothing was replaced. A file whose
// contents only the 1.0.1 build carries says the bytes actually moved.
//
// `--exe` is re-resolved before every launch: applying an update replaces the
// app directory, so a handle captured once would point at a directory that no
// longer exists.
//
// Adapted from the throwaway `probe/velopack` rig, which proved the same
// sequence against raw Velopack. What is under test here is Vidra's glue.

import { spawn, spawnSync } from "node:child_process";
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
  const first = await launch("1-report-before", { VIDRA_NATIVE_MODE: "report" });
  expect(first.error === null, "the app raised nothing at startup", first.error);
  expect(first.isInstalled === "True", "the app knows it is a Velopack install", first.isInstalled);
  expect(first.currentVersion === "1.0.0", "reports version 1.0.0", first.currentVersion);
  expect(first.payload === "payload-1.0.0", "carries the 1.0.0 payload", first.payload);
  // On Mac Catalyst this must be Vidra's locator; anywhere else Velopack's own
  // detection is what works, and a Vidra locator would be the surprise.
  expect(
    process.platform === "darwin"
      ? first.locator === "VidraCatalystLocator"
      : first.locator === "velopack-default",
    "the expected locator answered",
    first.locator,
  );

  const applied = await launch("2-update", { VIDRA_NATIVE_MODE: "update" });
  expect(applied.error === null, "the update path raised nothing", applied.error);
  expect(applied.checkOutcome === "Downloaded", "the check downloaded a release", applied.checkReason);
  expect(applied.checkVersion === "1.0.1", "the feed offered 1.0.1", applied.checkVersion);
  expect(applied.pendingVersion === "1.0.1", "1.0.1 is staged for the next launch", applied.pendingVersion);

  await waitFor(() => readPayloadOnDisk() === "payload-1.0.1", 120_000,
    "the updater replaced the app on disk");

  // The payload file appearing means the swap *started*, not that the updater
  // is done — it still has shortcuts, the old package and its own exit to get
  // through. Launching into that window starts an app whose directory is being
  // rewritten underneath it, and produces no output at all.
  await waitForUpdaterToExit(120_000);

  const after = await launch("3-report-after", { VIDRA_NATIVE_MODE: "report" });
  expect(after.currentVersion === "1.0.1", "the updated app reports 1.0.1", after.currentVersion);
  expect(after.payload === "payload-1.0.1", "the updated app carries the 1.0.1 payload", after.payload);
  expect(after.isInstalled === "True", "the updated app is still a Velopack install", after.isInstalled);
  // Q5's only empirical part. If MAUI put app data inside the install root, a
  // native update would delete every OTA bundle with it.
  expect(
    !!after.appDataDirectory && !insideInstallRoot(after.appDataDirectory),
    "OTA state lives outside the directory Velopack replaces",
    after.appDataDirectory,
  );
} finally {
  server.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nPASS — a Vidra app applied a 1.0.0 -> 1.0.1 native update and the bytes moved");

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
 * resolve it fresh. `--exe` may name the binary or, on macOS, the `.app`.
 *
 * Inside a packed `.app`, `Contents/MacOS` holds three things: the app's own
 * binary, Velopack's `UpdateMac`, and a `sq.version`. Taking the first
 * directory entry launches whichever the filesystem lists first — once that
 * was `UpdateMac`, which starts, finds no `--veloapp-*` subcommand, exits, and
 * looks exactly like an app that failed to boot.
 */
function resolveExe() {
  if (!exe.endsWith(".app")) return exe;

  const macos = path.join(exe, "Contents", "MacOS");
  const declared = readMainExe(exe);
  if (declared && fs.existsSync(path.join(macos, declared))) {
    return path.join(macos, declared);
  }
  const entry = fs
    .readdirSync(macos)
    .find((f) => !f.startsWith(".") && f !== "UpdateMac" && f !== "sq.version");
  return path.join(macos, entry);
}

/** `<mainExe>` out of the nuspec Velopack drops in as `sq.version`. */
function readMainExe(appBundle) {
  for (const dir of ["MacOS", "Resources"]) {
    const file = path.join(appBundle, "Contents", dir, "sq.version");
    if (!fs.existsSync(file)) continue;
    const match = /<mainExe>([^<]+)<\/mainExe>/.exec(fs.readFileSync(file, "utf8"));
    if (match) return match[1].trim();
  }
  return null;
}

/** Wait until no Velopack updater process is left running. */
async function waitForUpdaterToExit(timeoutMs) {
  const name = process.platform === "win32" ? "Update.exe" : "UpdateMac";
  const running = () => {
    const probe =
      process.platform === "win32"
        ? spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}`], { encoding: "utf8" })
        : spawnSync("pgrep", ["-x", name], { encoding: "utf8" });
    return (probe.stdout ?? "").includes(name);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && running()) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  // A short settle even once the process is gone: the last thing it does is
  // exit, and the directory swap completes a beat before that.
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`  ok   the updater (${name}) finished`);
}

/**
 * On Windows the path passed as `--exe` is Velopack's shim at the install root;
 * the app that actually runs — and the one an update replaces — lives in
 * `current/`. Reading the payload next to the shim reports the first install's
 * file forever and makes a successful update look like a timeout.
 */
function readPayloadOnDisk() {
  const candidates = exe.endsWith(".app")
    ? [path.join(exe, "Contents", "Resources", "native-payload.txt")]
    : [
        path.join(path.dirname(exe), "current", "native-payload.txt"),
        path.join(path.dirname(exe), "native-payload.txt"),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8").trim();
  }
  return null;
}

/** Is a path inside the directory Velopack replaces on every update? */
function insideInstallRoot(appData) {
  const root = exe.endsWith(".app") ? exe : path.dirname(exe);
  return path.resolve(appData).startsWith(path.resolve(root) + path.sep);
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
      VIDRA_NATIVE_PROOF: proof,
      // The environment outranks the stamped config, which is exactly what
      // makes a local feed testable without rebuilding the app.
      VIDRA_NATIVE_UPDATE_FEED_URL: feedUrl,
      VIDRA_NATIVE_UPDATE_STARTUP_DELAY: "0",
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
