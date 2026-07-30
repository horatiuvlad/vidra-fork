import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../utils.js";
import { generateKeyPair } from "../manifest-signing.js";
import {
  amber,
  dim,
  footer,
  header,
  row,
  STEP_LABEL_WIDTH as LABEL_WIDTH,
  value,
} from "../theme.js";

/**
 * `vidra keygen` — makes the key pair that makes an OTA feed trustworthy.
 *
 * Split deliberately: the command writes the *private* key to a file and prints
 * only the *public* half, along with the exact snippet to paste into the app.
 * Printing a private key to a terminal puts it in scrollback, screenshots and CI
 * logs, and the one thing this key must never do is leak — it is the authority
 * to run code on every machine the app is installed on.
 */
export const keygenCommand = async (argv: string[]): Promise<void> => {
  const args = parseArgs(["_", "_", ...argv]);
  const out = path.resolve(
    typeof args.out === "string" ? args.out : "vidra-signing-key.pem",
  );
  const force = !!args.force;

  console.log(header("keygen", "update signing key"));

  if (fs.existsSync(out) && !force) {
    // Overwriting is how you lose the ability to publish to every app already
    // out there, so it takes an explicit --force.
    console.error(
      row({
        glyph: "error",
        label: "write key",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          `${path.basename(out)} already exists — apps trusting it could not install ` +
            "updates signed by a new key. Pass --force only if you mean to replace it.",
        ),
      }),
    );
    process.exit(1);
  }

  const { privateKeyPem, publicKey, keyId } = generateKeyPair();

  // 0600 before the bytes land, not after, so the key is never briefly readable.
  fs.writeFileSync(out, privateKeyPem, { mode: 0o600 });
  try {
    fs.chmodSync(out, 0o600);
  } catch {
    // Windows has no POSIX mode; the file inherits the directory's ACL.
  }

  console.log(
    row({
      glyph: "done",
      label: "private key",
      labelWidth: LABEL_WIDTH,
      detail: `${value(path.relative(process.cwd(), out) || out)} ${dim(`(key ${keyId})`)}`,
    }),
  );
  // Written next to the private key as well as printed: a release script needs
  // the public half in a file it can read, not in terminal output it has to
  // scrape.
  const publicKeyPath = `${out}.pub`;
  fs.writeFileSync(publicKeyPath, `${publicKey}\n`);

  console.log(
    row({
      glyph: "done",
      label: "public key",
      labelWidth: LABEL_WIDTH,
      detail: `${value(path.relative(process.cwd(), publicKeyPath) || publicKeyPath)} ${dim("— add it to your app's package.json:")}`,
    }),
  );

  console.log();
  console.log(
    value(
      JSON.stringify({ vidra: { update: { publicKeys: [publicKey] } } }, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    ),
  );
  console.log();

  console.log(
    row({
      glyph: "manual",
      label: "keep it safe",
      labelWidth: LABEL_WIDTH,
      detail: amber(
        "this key is the authority to run code in every installed copy of your app",
      ),
    }),
  );
  console.log(
    footer(
      dim(
        `never commit it · back it up · in CI pass it as ${value("VIDRA_UPDATE_SIGNING_KEY")} ` +
          `and sign with ${value("vidra bundle --sign")}`,
      ),
    ),
  );
};
