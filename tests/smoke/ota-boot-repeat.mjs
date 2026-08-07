// Flake probe for issue #13: how often does a promoted bundle fail to clear
// probation?
//
// The full OTA e2e exercises the promote/confirm cycle exactly once per CI run,
// which makes a ~1-in-6 flake take a day to characterise. This runs only the two
// launches that matter — stage, then promote — with the app's update state wiped
// between cycles, and reports how many cycles confirmed the boot.
//
// Usage:
//   node ota-boot-repeat.mjs --bin <app binary> --project <scaffold root>
//                            --cli <cli.js> --work <scratch dir>
//                            [--cycles 20] [--port 8098] [--signing-key <pem>]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const bin = required("bin");
const project = required("project");
const cli = required("cli");
const work = required("work");
const cycles = Number(args.cycles ?? 20);
const port = Number(args.port ?? 8098);
const signingKey = args["signing-key"] ?? null;
const feed = path.join(work, "feed");

const MARKER = "ota-bundle-1-3-0";
let server;
let appDataRoot = null;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(feed, { recursive: true });

const results = [];

try {
  server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: feed,
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${port}/`);
  publishGoodBundle();
  await waitFor(`http://127.0.0.1:${port}/bundles.json`);

  for (let cycle = 1; cycle <= cycles; cycle++) {
    wipeUpdateState();

    const staged = launch(`c${cycle}-staged`, 60);
    if (staged.proof?.pendingVersion !== "1.3.0") {
      results.push({ cycle, outcome: "stage-failed", detail: staged.proof?.lastCheck ?? "no proof" });
      console.log(`cycle ${cycle}: STAGE FAILED (${staged.proof?.lastCheck ?? "no proof"})`);
      continue;
    }

    const promoted = launch(`c${cycle}-promoted`, 60);
    const cleared = promoted.output.includes("probation cleared");
    const served = promoted.proof?.marker === MARKER;
    results.push({
      cycle,
      outcome: cleared ? "cleared" : "not-cleared",
      served,
      ms: promoted.ms,
      trace: promoted.output
        .split(/\r?\n/)
        .filter((line) => line.includes("boot-trace") || line.includes("[vidra] update:"))
        .join("\n      "),
    });
    console.log(
      `cycle ${cycle}: ${cleared ? "cleared" : "NOT CLEARED"} ` +
        `(served=${served} ${promoted.ms}ms)`,
    );
    if (!cleared) console.log(`      ${results.at(-1).trace}`);
  }
  wipeUpdateState();
} finally {
  if (server) server.kill();
}

const cleared = results.filter((r) => r.outcome === "cleared").length;
const missed = results.filter((r) => r.outcome === "not-cleared").length;
const broken = results.filter((r) => r.outcome === "stage-failed").length;

console.log(
  `\n==> RESULT cycles=${results.length} cleared=${cleared} not-cleared=${missed} ` +
    `stage-failed=${broken} rate=${((missed / Math.max(1, cleared + missed)) * 100).toFixed(1)}%`,
);

fs.writeFileSync(path.join(work, "boot-repeat.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);

// ------------------------------------------------------------------ helpers --

/** Removes everything the updater persists, so the next launch starts clean. */
function wipeUpdateState() {
  if (appDataRoot === null) return;
  fs.rmSync(path.join(appDataRoot, "vidra"), { recursive: true, force: true });
}

function launch(name, timeout) {
  const proofPath = path.join(work, `${name}.json`);
  fs.rmSync(proofPath, { force: true });

  const started = Date.now();
  const result = spawnSync(bin, [], {
    cwd: path.dirname(bin),
    env: {
      ...process.env,
      VIDRA_OTA_PROOF: proofPath,
      VIDRA_OTA_TIMEOUT: String(timeout),
      VIDRA_UPDATE_STARTUP_DELAY: "1",
      VIDRA_BOOT_TRACE: "1",
    },
    timeout: (timeout + 45) * 1000,
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const proof = fs.existsSync(proofPath)
    ? JSON.parse(fs.readFileSync(proofPath, "utf8"))
    : null;

  if (proof?.appData && appDataRoot === null) appDataRoot = proof.appData;

  return { proof, output, ms: Date.now() - started };
}

function publishGoodBundle() {
  const indexPath = path.join(project, "ui", "dist", "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  if (!html.includes(MARKER)) {
    fs.writeFileSync(
      indexPath,
      html.replace("</head>", `  <script>window.__vidraBundleMarker = "${MARKER}";</script>\n  </head>`),
    );
  }

  const pkgPath = path.join(project, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = "1.3.0";
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const built = spawnSync(
    "node",
    [cli, "build", "--web", ...(signingKey ? ["--sign", signingKey] : [])],
    { cwd: project, stdio: "inherit" },
  );
  if (built.status !== 0) throw new Error(`vidra build --web failed with ${built.status}`);

  fs.cpSync(path.join(project, "dist", "feed"), feed, { recursive: true });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok || url.endsWith("/")) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`nothing answered at ${url}`);
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
