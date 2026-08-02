#!/usr/bin/env node
// Turn a scaffolded app into one that ships native updates, the way a developer
// would, and then set its payload marker for one release of the round-trip.
//
//   node native-update-setup.mjs --project <dir> --name <Namespace> --version 1.0.0
//                               [--feed <url>] [--main-page <file.cs.in>]
//
// Every edit here is one of the four steps `vidra doctor` checks for, applied to
// the files the template already ships:
//
//   1. reference Vidra.Updates.Native
//   2. uncomment the Velopack line in both entry points
//   3. call .UseVidraNativeUpdates() in MauiProgram
//   4. put a vidra.updates.native block in package.json
//
// Doing it by patching the real template rather than by copying prepared files
// is the point: if the shipped comment markers ever drift, this fails.

import fs from "node:fs";
import path from "node:path";

const args = parse(process.argv.slice(2));
const projectDir = required("project");
const name = required("name");
const version = required("version");
const feedUrl = args.feed ?? "http://127.0.0.1:8098/";
const hostDir = path.join(projectDir, "src", `${name}.Host`);

// 1. The package reference the template deliberately does not ship.
edit(path.join(hostDir, `${name}.Host.csproj`), (xml) => {
  if (xml.includes("Vidra.Updates.Native")) return xml;
  // The same version as the host package: they ship together and a scaffolded
  // app pins exact versions, so a mismatch would restore a package that does
  // not exist in the local feed.
  const vidraVersion = /<PackageReference Include="Vidra\.Hosting\.Maui" Version="([^"]+)"/.exec(xml)?.[1];
  if (!vidraVersion) throw new Error("no Vidra.Hosting.Maui reference to copy the version from");
  return xml.replace(
    /(<PackageReference Include="Vidra\.Hosting\.Maui"[^>]*\/>)/,
    `$1\n    <PackageReference Include="Vidra.Updates.Native" Version="${vidraVersion}" />`,
  );
});

// 2. Both entry points. The template ships them with the call commented out
//    precisely so this is a one-line change rather than a migration.
for (const entry of [
  path.join(hostDir, "Platforms", "MacCatalyst", "Program.cs"),
  path.join(hostDir, "Platforms", "Windows", "Program.cs"),
]) {
  edit(entry, (cs) => {
    // Idempotent: the round-trip runs this once per release, and the second
    // release only needs the version and the payload changed.
    if (/^\s*VelopackApp\.Build\(\)/m.test(cs)) return cs;

    const uncommented = cs
      .replace("// using Velopack;", "using Velopack;")
      .replace("// using Vidra.Hosting;", "using Vidra.Hosting;")
      .replace(
        "// VelopackApp.Build().UseVidraLocator().Run();",
        "VelopackApp.Build().UseVidraLocator().Run();",
      );
    if (uncommented === cs) {
      throw new Error(`${entry}: nothing was uncommented, so the template's markers have drifted`);
    }
    return uncommented;
  });
}

// 3. The builder call.
edit(path.join(hostDir, "MauiProgram.cs"), (cs) => {
  // Comments first. The template explains how to turn native updates on, and
  // that explanation names the very call being looked for, so a plain
  // substring check reports the work as already done and silently skips it.
  const live = cs.replace(/\/\/[^\n]*/g, "");
  if (live.includes(".UseVidraNativeUpdates()")) return cs;
  if (!live.includes(".UseVidra()")) throw new Error("no UseVidra() call to extend");
  return cs.replace(".UseVidra()", ".UseVidra()\n            .UseVidraNativeUpdates()");
});

// 4. The config block, and the version this release carries.
edit(path.join(projectDir, "package.json"), (json) => {
  const pkg = JSON.parse(json);
  pkg.version = version;
  pkg.vidra ??= {};
  pkg.vidra.updates = { ...(pkg.vidra.updates ?? {}), native: { feedUrl } };
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

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
