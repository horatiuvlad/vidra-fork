// End-to-end proof for over-the-air bundle updates (macOS + Windows).
//
// Serves a real feed over HTTP and launches the packaged app repeatedly, because
// every interesting property of an update system is a property of a *sequence*
// of launches: an update applies on the next one, a rejected bundle never
// applies at all, and a bundle that cannot boot has to be undone after failing
// twice. Each launch writes a JSON proof (tests/smoke/ota-main-page.cs.in) saying
// what actually served — read out of the loaded page, not from a log line.
//
// Claims, one per phase:
//   staged     a newer compatible bundle is downloaded but does NOT hot-swap
//   promoted   the next launch serves it, and the bridge still works
//   mismatch   a bundle for a different contract is refused, however new
//   corrupt    a bundle whose sha256 does not match is refused
//   rollback   a bundle that never boots is undone after two attempts
//
// Usage:
//   node ota-e2e.mjs --bin <app binary> --project <scaffold root> --cli <cli.js>
//                    --work <scratch dir> [--port 8099]

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const bin = required("bin");
const project = required("project");
const cli = required("cli");
const work = required("work");
const port = Number(args.port ?? 8099);
const feed = path.join(work, "feed");

const MARKER = "ota-bundle-1-3-0";
let failures = 0;
let server;
let goodArchive;
let fingerprints;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(feed, { recursive: true });

try {
  publishGoodBundle();
  server = serveFeed();
  await waitForFeed();

  // ---- staged: the update is downloaded, and does not take effect yet --------
  // The first launch gets a longer window and one retry: the app's first HTTP
  // request of the run has been seen to take longer than every later one, and a
  // check that has not come back yet is not the same claim as a check that
  // refused something.
  let staged = launch("staged", { timeout: 90 });
  if (staged.pendingVersion === null) {
    console.log("==> the first check did not come back in time; retrying once");
    staged = launch("staged-retry", { timeout: 90 });
  }
  expect(staged.marker, "undefined", "the embedded bundle carries no marker");
  expect(staged.pendingVersion, "1.3.0", "bundle staged for the next launch");
  expect(staged.currentVersion, null, "nothing promoted mid-session");
  expectBridge(staged);

  // ---- promoted: the next launch serves it ---------------------------------
  const promoted = launch("promoted");
  expect(promoted.marker, MARKER, "the updated bundle served");
  expect(promoted.currentVersion, "1.3.0", "current version");
  expectBridge(promoted, "the bridge still works from an updated bundle");

  // ---- mismatch: newer, but built against a different contract --------------
  addEntry({
    version: "1.4.0",
    url: goodArchive.name,
    sha256: goodArchive.sha256,
    size: goodArchive.size,
    coreFingerprint: "0".repeat(64),
    appFingerprint: fingerprints.app,
  });
  const mismatch = launch("mismatch");
  expect(mismatch.pendingVersion, null, "a bundle for another core contract is refused");
  expect(mismatch.marker, MARKER, "still serving the last good bundle");

  // ---- corrupt: the manifest's hash does not describe the archive -----------
  addEntry({
    version: "1.5.0",
    url: goodArchive.name,
    sha256: "b".repeat(64),
    size: goodArchive.size,
    coreFingerprint: fingerprints.core,
    appFingerprint: fingerprints.app,
  });
  const corrupt = launch("corrupt");
  expect(corrupt.pendingVersion, null, "a bundle whose sha256 does not match is refused");
  expect(corrupt.marker, MARKER, "still serving the last good bundle");

  // ---- rollback: a bundle that cannot boot is undone ------------------------
  const broken = publishBrokenBundle("1.6.0");
  addEntry(broken);

  const stagedBroken = launch("rollback-download");
  expect(stagedBroken.pendingVersion, "1.6.0", "the broken bundle is staged like any other");

  // It is only "broken" at runtime — nothing about it is detectable before it
  // runs, which is exactly why probation exists.
  const attempt1 = launch("rollback-attempt-1", { timeout: 25 });
  expect(attempt1.currentVersion, "1.6.0", "promoted on probation");
  expect(attempt1.counter, null, "the broken bundle never reaches the bridge");

  const attempt2 = launch("rollback-attempt-2", { timeout: 25 });
  expect(attempt2.currentVersion, "1.6.0", "given a second launch before giving up");

  const rolledBack = launch("rolled-back");
  expect(rolledBack.currentVersion, "1.3.0", "rolled back to the last bundle that worked");
  expect(rolledBack.marker, MARKER, "and it is really serving it");
  expectBridge(rolledBack, "the app works again after a rollback");

  // A rolled-back bundle must never be reinstalled, or rollback is a loop.
  const afterRollback = launch("after-rollback");
  expect(afterRollback.pendingVersion, null, "the failed bundle is not downloaded again");
} catch (error) {
  failures++;
  console.log(`::error::${error.message}`);
} finally {
  if (server) server.kill();
}

console.log(`\n==> ${failures === 0 ? "PASS" : "FAIL"} — over-the-air updates`);
process.exit(failures === 0 ? 0 : 1);

// ------------------------------------------------------------------ helpers --

/**
 * Publishes the bundle under test with `vidra bundle` — the command a real
 * publisher runs — after marking `ui/dist` so the loaded page can be identified,
 * and bumping the version so it outranks what the app shipped with.
 */
function publishGoodBundle() {
  const dist = path.join(project, "ui", "dist");
  const indexPath = path.join(dist, "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  fs.writeFileSync(
    indexPath,
    html.replace("</head>", `  <script>window.__vidraBundleMarker = "${MARKER}";</script>\n  </head>`),
  );

  const pkgPath = path.join(project, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = "1.3.0";
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  run("node", [cli, "bundle", "--skip-build", "--out", feed], project);

  const manifest = readManifest();
  const entry = manifest.bundles.at(-1);
  if (!entry) throw new Error("vidra bundle wrote no manifest entry");

  goodArchive = { name: entry.url, sha256: entry.sha256, size: entry.size };
  fingerprints = { core: entry.coreFingerprint, app: entry.appFingerprint };
  console.log(
    `==> published ${entry.version} ${entry.url} ` +
      `(core=${entry.coreFingerprint.slice(0, 12)} app=${entry.appFingerprint.slice(0, 12)})`,
  );
}

/** A bundle that installs and serves, but whose page never boots the SDK. */
function publishBrokenBundle(version) {
  const name = `bundle-${version}-broken.zip`;
  const script = [
    "import zipfile, sys",
    "z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)",
    "z.writestr('index.html', '<!doctype html><html><body><h1>no sdk here</h1></body></html>')",
    "z.close()",
  ].join("\n");
  run("python3", ["-c", script, path.join(feed, name)], feed);

  const bytes = fs.readFileSync(path.join(feed, name));
  return {
    version,
    url: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    coreFingerprint: fingerprints.core,
    appFingerprint: fingerprints.app,
  };
}

function addEntry(entry) {
  const manifest = readManifest();
  manifest.bundles.push(entry);
  fs.writeFileSync(path.join(feed, "bundles.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`==> feed now offers ${entry.version}`);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(feed, "bundles.json"), "utf8"));
}

/** Blocks until the feed is actually answering, so launch 1 is not a race. */
async function waitForFeed() {
  const url = `http://127.0.0.1:${port}/bundles.json`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.text();
        console.log(`==> feed is answering at ${url}`);
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the feed never answered at ${url}`);
}

function serveFeed() {
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: feed,
    stdio: "ignore",
  });
  console.log(`==> serving ${feed} on http://127.0.0.1:${port}`);
  return child;
}

/** Runs the app once and returns the proof it wrote. */
function launch(name, { timeout = 60 } = {}) {
  const proofPath = path.join(work, `${name}.json`);
  fs.rmSync(proofPath, { force: true });

  console.log(`\n=================== launch: ${name} ===================`);
  const result = spawnSync(bin, [], {
    cwd: path.dirname(bin),
    env: {
      ...process.env,
      VIDRA_OTA_PROOF: proofPath,
      VIDRA_OTA_TIMEOUT: String(timeout),
    },
    timeout: (timeout + 45) * 1000,
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("[vidra]") || line.includes("error")) console.log(`    ${line}`);
  }

  if (!fs.existsSync(proofPath)) {
    throw new Error(`launch ${name} wrote no proof (exit=${result.status}, signal=${result.signal})`);
  }

  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  console.log(
    `    marker=${proof.marker} current=${proof.currentVersion} ` +
      `pending=${proof.pendingVersion} counter=${proof.counter}`,
  );
  return proof;
}

function expect(actual, expected, what) {
  const normalized = actual === "undefined" ? "undefined" : actual;
  if (normalized === expected) {
    console.log(`    ✓ ${what}`);
    return;
  }
  failures++;
  console.log(
    `::error::${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function expectBridge(proof, what = "the bridge completed a round-trip") {
  if (proof.counter === 1) {
    console.log(`    ✓ ${what}`);
    return;
  }
  failures++;
  console.log(`::error::${what}: counter=${JSON.stringify(proof.counter)} error=${proof.bridgeError}`);
}

function run(command, argv, cwd) {
  const result = spawnSync(command, argv, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} failed with ${result.status}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function required(name) {
  if (!args[name]) {
    console.log(`::error::missing --${name}`);
    process.exit(1);
  }
  return args[name];
}
