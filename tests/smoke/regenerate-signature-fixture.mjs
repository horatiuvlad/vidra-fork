// Regenerates the cross-language signature fixture.
//
// The fixture exists so the Linux CI leg can prove the .NET host accepts a
// signature produced the way `vidra bundle` produces one — the boundary neither
// side's own tests can cover. Run this only if the signature format changes,
// which it should not: a format change means every installed app stops accepting
// new feeds until it is rebuilt.
//
//   node tests/smoke/regenerate-signature-fixture.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "tests", "dotnet", "Vidra.Updates.Tests", "fixtures");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = publicKey.export({ format: "der", type: "spki" });

// Shaped like a real feed, so the bytes being signed look like the bytes that
// will be signed in production.
const manifest = Buffer.from(
  `${JSON.stringify(
    {
      schema: 1,
      bundles: [
        {
          version: "1.3.0",
          url: "bundle-1.3.0-4ab2e68d.zip",
          sha256: "b34751ffc8072ffbab70ae7c609111fff302a1ad56db2b9b6f0d6a927945050d",
          size: 66780,
          coreFingerprint: "a4d6e4856749f06fd3c84be9bb5a468c5219e71797777a977a2d0772dc6214db",
          appFingerprint: "d3044812d17c42049962d730fced04a6ecd711e287cdd0da7b218b327ee6cd56",
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const signature = crypto.sign("sha256", manifest, privateKey);
const keyId = crypto.createHash("sha256").update(spki).digest("hex").slice(0, 8);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "bundles.json"), manifest);
fs.writeFileSync(
  path.join(out, "bundles.json.sig"),
  `${JSON.stringify({ algorithm: "ecdsa-p256-sha256", keyId, signature: signature.toString("base64") }, null, 2)}\n`,
);
fs.writeFileSync(path.join(out, "public-key.txt"), `${spki.toString("base64")}\n`);

// The private key is deliberately not written anywhere: the fixture only needs
// to be verifiable, never re-signable.
console.log(`fixture regenerated in ${path.relative(root, out)} (key ${keyId})`);
