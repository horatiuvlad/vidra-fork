#!/usr/bin/env node
// Turn a scaffolded app into one that ships native updates, the way a developer
// would, and then set its payload marker for one release of the round-trip.
//
//   node native-update-setup.mjs --project <dir> --name <Namespace> --version 1.0.0
//                               [--feed <url>] [--main-page <file.cs.in>]
//
// There is one step, because there is one switch: a native feed URL in
// package.json. The package reference, the builder call and the `VelopackApp`
// line in both entry points all ship live in the template, so this script has
// nothing left to patch into the app's own source.
//
// It writes the config by hand rather than shelling out to `vidra updates init`
// on purpose: this is the *rig*, and it should not depend on the command whose
// output the round-trip is meant to validate. `updates.test.ts` covers the
// command.

import fs from "node:fs";
import path from "node:path";

const args = parse(process.argv.slice(2));
const projectDir = required("project");
const name = required("name");
const version = required("version");
const feedUrl = args.feed ?? "http://127.0.0.1:8098/";
const hostDir = path.join(projectDir, "src", `${name}.Host`);

// The one switch, plus the version this release carries.
edit(path.join(projectDir, "package.json"), (json) => {
  const pkg = JSON.parse(json);
  pkg.version = version;
  pkg.vidra ??= {};
  // `feed.app` rather than a bare feed string: this rig tests whole-app updates,
  // and one string would turn the web tier on too.
  pkg.vidra.updates = { ...(pkg.vidra.updates ?? {}), feed: { app: feedUrl } };
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

// The app has to already carry the updater, or a feed URL alone would not be
// enough and this whole design would be a lie. Asserted rather than assumed: if
// the template ever regresses to shipping any of this commented out, the
// round-trip would still pass while proving nothing.
for (const [file, needle] of [
  [`${name}.Host.csproj`, 'PackageReference Include="Vidra.Updates.Native"'],
  ["MauiProgram.cs", ".UseVidraNativeUpdates()"],
  [path.join("Platforms", "MacCatalyst", "Program.cs"), "VelopackApp.Build()"],
  [path.join("Platforms", "Windows", "Program.cs"), "VelopackApp.Build()"],
]) {
  const source = fs.readFileSync(path.join(hostDir, file), "utf8");
  const live = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (!live.includes(needle)) {
    console.error(`${file}: the scaffolded app does not carry ${needle}`);
    process.exit(1);
  }
}

// The payload marker: a file whose contents only this build carries, shipped as
// a MAUI asset so it travels wherever the app does. Version numbers are
// bookkeeping both sides could agree on while nothing was replaced.
const payload = path.join(hostDir, "Resources", "Raw", "native-payload.txt");
fs.mkdirSync(path.dirname(payload), { recursive: true });
fs.writeFileSync(payload, `payload-${version}\n`);

if (typeof args["main-page"] === "string") {
  const template = fs.readFileSync(args["main-page"], "utf8");
  fs.writeFileSync(
    path.join(hostDir, "MainPage.cs"),
    template.replaceAll("__PROJECT_NAMESPACE__", name),
  );
}

console.log(`native updates configured: ${name} ${version} -> ${feedUrl}`);

// ---------------------------------------------------------------------------

function edit(file, transform) {
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, transform(before));
}

function parse(argv) {
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

function required(key) {
  if (typeof args[key] !== "string") {
    console.error(`missing --${key}`);
    process.exit(2);
  }
  return args[key];
}
