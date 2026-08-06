#!/usr/bin/env node
// One version for everything Vidra publishes.
//
// `version.json` is the source of truth; every other place a version appears is
// derived from it and checked in, so a commit is either consistent or CI says
// so. That matters beyond tidiness: an updater compares versions, and a release
// where the CLI says 0.4.0 while the SDK says 0.2.0 has no single answer to
// "which version am I running".
//
//   node scripts/version.mjs check          verify derived files match (CI gate)
//   node scripts/version.mjs sync           rewrite derived files
//   node scripts/version.mjs set 0.5.0      bump, then rewrite
//
// The app-side version — what a scaffolded app stamps into its bundle — is a
// different question, owned by the app's own package.json. See src/cli/…/src/version.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "version.json");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/** Both places an npm lockfile names its own package's version. */
const writeLockVersion = (source, version) => {
  const lock = JSON.parse(source);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
};

/** Files that carry a copy of the version, and how to read/write it. */
const derived = [
  {
    file: "src/cli/create-vidra-app/package.json",
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: "src/sdk/vidra-js/package.json",
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    // What `vidra --version` and the CLI banner print. It drifted once already
    // (0.3.1 while the package said 0.4.0), because nothing checked it: a
    // version the tool reports about itself has to be derived like every other.
    file: "src/cli/create-vidra-app/src/theme.ts",
    read: (s) => s.match(/CLI_VERSION = "([^"]+)"/)?.[1],
    write: (s, v) => s.replace(/(CLI_VERSION = ")[^"]+(")/, `$1${v}$2`),
  },
  {
    // A lockfile records the version of the package it locks, in two places.
    // `npm ci` does not mind if they disagree with package.json and the
    // published tarball takes its version from package.json either way — so
    // this drifts silently, which is the one thing version.json exists to stop.
    // Rewritten by round-trip because npm's own formatting is exactly
    // JSON.stringify(…, 2) plus a newline.
    file: "src/cli/create-vidra-app/package-lock.json",
    read: (s) => JSON.parse(s).version,
    write: (s, v) => writeLockVersion(s, v),
  },
  {
    file: "src/sdk/vidra-js/package-lock.json",
    read: (s) => JSON.parse(s).version,
    write: (s, v) => writeLockVersion(s, v),
  },
  {
    // Every packable csproj resolves <Version> through this property, so the
    // .NET side has exactly one number rather than nine.
    file: "Directory.Build.props",
    read: (s) => s.match(/<VidraVersion>([^<]+)<\/VidraVersion>/)?.[1],
    write: (s, v) =>
      s.replace(/(<VidraVersion>)[^<]+(<\/VidraVersion>)/, `$1${v}$2`),
  },
];

const readSource = () => {
  const version = JSON.parse(fs.readFileSync(SOURCE, "utf8")).version;
  if (!SEMVER.test(version ?? "")) {
    console.error(`version.json: "${version}" is not a semver`);
    process.exit(1);
  }
  return version;
};

const command = process.argv[2] ?? "check";

if (command === "set") {
  const next = process.argv[3];
  if (!SEMVER.test(next ?? "")) {
    console.error(`usage: version.mjs set <semver> (got "${next ?? ""}")`);
    process.exit(1);
  }
  const source = fs.readFileSync(SOURCE, "utf8");
  fs.writeFileSync(SOURCE, source.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
  console.log(`version.json -> ${next}`);
}

const version = readSource();

if (command === "check") {
  const drift = derived
    .map(({ file, read }) => ({ file, found: read(fs.readFileSync(path.join(ROOT, file), "utf8")) }))
    .filter(({ found }) => found !== version);

  if (drift.length) {
    console.error(`version drift — version.json says ${version}:`);
    for (const { file, found } of drift) console.error(`  ${file}: ${found ?? "<missing>"}`);
    console.error("\nfix with: node scripts/version.mjs sync");
    process.exit(1);
  }
  console.log(`all derived versions match ${version}`);
} else if (command === "sync" || command === "set") {
  for (const { file, write } of derived) {
    const full = path.join(ROOT, file);
    fs.writeFileSync(full, write(fs.readFileSync(full, "utf8"), version));
    console.log(`  ${file} -> ${version}`);
  }
} else {
  console.error(`unknown command "${command}" — expected check | sync | set`);
  process.exit(1);
}
