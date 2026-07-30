// Publishes the core contract manifest alongside the compiled SDK.
//
// The fingerprint in it is the value the host hands over at handshake time, and
// the one an OTA feed entry has to carry for a bundle to be installable. It is
// generated, never written by hand — so `vidra bundle` reads it from here rather
// than asking a developer to copy a hash. `tsc` does not emit JSON, hence this.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "src", "generated", "manifest.json");
const target = path.join(root, "dist", "manifest.json");

if (!fs.existsSync(source)) {
  console.error(`[vidra-sdk] missing ${path.relative(root, source)} — run codegen first`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);

const { fingerprint } = JSON.parse(fs.readFileSync(target, "utf8"));
console.log(`[vidra-sdk] core contract fingerprint ${String(fingerprint).slice(0, 12)} → dist/manifest.json`);
