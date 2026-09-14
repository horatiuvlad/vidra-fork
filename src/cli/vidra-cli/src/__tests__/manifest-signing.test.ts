import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SIGNATURE_ALGORITHM,
  generateKeyPair,
  keyIdOf,
  publicKeyFor,
  resolveSigningKey,
  signManifest,
  verifyManifest,
  writeSignature,
} from "../manifest-signing.js";

const manifest = (version = "1.1.0"): Buffer =>
  Buffer.from(`${JSON.stringify({ schema: 1, bundles: [{ version }] }, null, 2)}\n`);

describe("update signing keys", () => {
  it("generates a P-256 key pair", () => {
    const { privateKeyPem, publicKey, keyId } = generateKeyPair();

    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    const parsed = crypto.createPrivateKey(privateKeyPem);
    expect(parsed.asymmetricKeyType).toBe("ec");
    expect((parsed.asymmetricKeyDetails as { namedCurve?: string }).namedCurve).toBe("prime256v1");
    expect(keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(Buffer.from(publicKey, "base64").length).toBeGreaterThan(64);
  });

  it("derives the same public key and id from the private key", () => {
    const generated = generateKeyPair();

    expect(publicKeyFor(generated.privateKeyPem)).toEqual({
      publicKey: generated.publicKey,
      keyId: generated.keyId,
    });
  });

  it("computes the key id the host computes", () => {
    // Both sides take the first 8 hex of SHA-256 over the SPKI bytes; if they
    // ever disagree, error messages point at the wrong key.
    const { publicKey, keyId } = generateKeyPair();
    const spki = Buffer.from(publicKey, "base64");

    expect(keyIdOf(spki)).toBe(keyId);
    expect(keyIdOf(spki)).toBe(crypto.createHash("sha256").update(spki).digest("hex").slice(0, 8));
  });

  it("refuses a key of the wrong type", () => {
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    expect(() => signManifest(manifest(), pem)).toThrow(/ECDSA P-256/);
  });

  it("refuses a key on the wrong curve", () => {
    const wrongCurve = crypto.generateKeyPairSync("ec", { namedCurve: "secp521r1" });
    const pem = wrongCurve.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    expect(() => signManifest(manifest(), pem)).toThrow(/P-256/);
  });
});

describe("manifest signatures", () => {
  it("signs and verifies", () => {
    const { privateKeyPem, publicKey, keyId } = generateKeyPair();
    const bytes = manifest();

    const document = signManifest(bytes, privateKeyPem);

    expect(document.algorithm).toBe(SIGNATURE_ALGORITHM);
    expect(document.keyId).toBe(keyId);
    expect(verifyManifest(bytes, document, publicKey)).toBe(true);
  });

  it("does not verify a manifest that changed after signing", () => {
    // The whole point: a feed host cannot swap the index for one of its own.
    const { privateKeyPem, publicKey } = generateKeyPair();
    const document = signManifest(manifest("1.1.0"), privateKeyPem);

    expect(verifyManifest(manifest("9.9.9"), document, publicKey)).toBe(false);
  });

  it("does not verify against a different key", () => {
    const publisher = generateKeyPair();
    const attacker = generateKeyPair();
    const bytes = manifest();

    expect(verifyManifest(bytes, signManifest(bytes, attacker.privateKeyPem), publisher.publicKey))
      .toBe(false);
  });

  it("rejects a document claiming another algorithm", () => {
    const { privateKeyPem, publicKey } = generateKeyPair();
    const bytes = manifest();
    const document = { ...signManifest(bytes, privateKeyPem), algorithm: "totally-legit" };

    expect(verifyManifest(bytes, document, publicKey)).toBe(false);
  });

  it("writes the detached signature next to the manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-sig-"));
    const { privateKeyPem } = generateKeyPair();

    const written = writeSignature(dir, signManifest(manifest(), privateKeyPem));

    expect(path.basename(written)).toBe("bundles.json.sig");
    const parsed = JSON.parse(fs.readFileSync(written, "utf8"));
    expect(parsed).toMatchObject({ algorithm: SIGNATURE_ALGORITHM });
    expect(parsed.keyId).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("resolving a signing key", () => {
  it("reads a key file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-key-"));
    const file = path.join(dir, "key.pem");
    const { privateKeyPem } = generateKeyPair();
    fs.writeFileSync(file, privateKeyPem);

    expect(resolveSigningKey(file)).toBe(privateKeyPem);
  });

  it("fails loudly on a missing key file rather than publishing unsigned", () => {
    expect(() => resolveSigningKey("/nope/does-not-exist.pem")).toThrow(/no signing key/);
  });

  it("falls back to the environment, which is how CI supplies it", () => {
    const { privateKeyPem } = generateKeyPair();
    const previous = process.env.VIDRA_UPDATE_SIGNING_KEY;
    process.env.VIDRA_UPDATE_SIGNING_KEY = privateKeyPem;

    try {
      expect(resolveSigningKey()).toBe(privateKeyPem);
    } finally {
      if (previous === undefined) delete process.env.VIDRA_UPDATE_SIGNING_KEY;
      else process.env.VIDRA_UPDATE_SIGNING_KEY = previous;
    }
  });

  it("ignores an environment value that is not a key", () => {
    const previous = process.env.VIDRA_UPDATE_SIGNING_KEY;
    process.env.VIDRA_UPDATE_SIGNING_KEY = "***";

    try {
      expect(resolveSigningKey()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.VIDRA_UPDATE_SIGNING_KEY;
      else process.env.VIDRA_UPDATE_SIGNING_KEY = previous;
    }
  });
});
