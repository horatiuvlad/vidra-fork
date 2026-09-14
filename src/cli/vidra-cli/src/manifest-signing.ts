import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Manifest signing for OTA feeds. (Unrelated to `signing.ts`, which is macOS
 * code signing — this signs the update index, not the app.)
 *
 * The `sha256` on a bundle entry says an archive arrived intact: a statement
 * about the network. A signature says the holder of the signing key published
 * this manifest: a statement about the feed host, which is the one that matters.
 * A host that can serve a manifest can serve a matching archive too, so without
 * this, nothing stands between a compromised CDN and arbitrary code in the app.
 *
 * ECDSA P-256 / SHA-256, chosen over ed25519 because Node and .NET both verify
 * it with no third-party library. Ed25519 in the .NET BCL is api-approved but
 * milestoned for .NET 11 (dotnet/runtime#63174), and the alternative was a
 * crypto dependency in every Vidra app, updates enabled or not.
 */

export const SIGNATURE_ALGORITHM = "ecdsa-p256-sha256";

/** Name of the detached signature, alongside `bundles.json`. */
export const SIGNATURE_FILE = "bundles.json.sig";

export interface SignatureDocument {
  algorithm: string;
  keyId: string;
  signature: string;
}

export interface GeneratedKeyPair {
  /** PKCS#8 PEM. Secret — whoever holds it can publish code to your users. */
  privateKeyPem: string;
  /** Base64 SPKI DER, safe to publish; goes in the app's package.json. */
  publicKey: string;
  keyId: string;
}

export const generateKeyPair = (): GeneratedKeyPair => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;

  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: spki.toString("base64"),
    keyId: keyIdOf(spki),
  };
};

/**
 * Short, stable identifier for a public key — the first 8 hex characters of the
 * SHA-256 of its SPKI bytes. Only ever used in messages, so a mismatch can be
 * described without printing whole keys. The host computes it identically.
 */
export const keyIdOf = (spki: Buffer): string =>
  crypto.createHash("sha256").update(spki).digest("hex").slice(0, 8);

export const publicKeyFor = (privateKeyPem: string): { publicKey: string; keyId: string } => {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;

  return { publicKey: spki.toString("base64"), keyId: keyIdOf(spki) };
};

/**
 * Signs the exact bytes of the manifest.
 *
 * Detached, and over the bytes as written, on purpose: embedding a signature in
 * the document it signs forces both sides to agree on a canonical JSON
 * serialization, and any drift in that agreement is a signature that silently
 * stops verifying — or one that verifies a document the other side reads
 * differently.
 */
export const signManifest = (manifestBytes: Buffer, privateKeyPem: string): SignatureDocument => {
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  if (privateKey.asymmetricKeyType !== "ec") {
    throw new Error(
      `the signing key is ${privateKey.asymmetricKeyType ?? "of an unknown type"}; ` +
        "vidra signs with an ECDSA P-256 key — make one with `vidra keygen`",
    );
  }

  const curve = (privateKey.asymmetricKeyDetails as { namedCurve?: string } | undefined)
    ?.namedCurve;
  if (curve && curve !== "prime256v1") {
    throw new Error(`the signing key uses curve ${curve}; vidra signs with P-256 (prime256v1)`);
  }

  const signature = crypto.sign("sha256", manifestBytes, privateKey);
  const { keyId } = publicKeyFor(privateKeyPem);

  return {
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    signature: signature.toString("base64"),
  };
};

/** Verifies a signature the way the host does. Used by tests, and by the publish step of `vidra build`. */
export const verifyManifest = (
  manifestBytes: Buffer,
  document: SignatureDocument,
  publicKeyBase64: string,
): boolean => {
  if (document.algorithm !== SIGNATURE_ALGORITHM) return false;

  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      "sha256",
      manifestBytes,
      publicKey,
      Buffer.from(document.signature, "base64"),
    );
  } catch {
    return false;
  }
};

/**
 * Resolves the signing key: an explicit path first, then the environment — which
 * is how CI supplies it, as the PEM itself rather than a file on disk.
 */
export const resolveSigningKey = (keyPath?: string): string | null => {
  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`no signing key at ${keyPath}`);
    }
    return fs.readFileSync(keyPath, "utf8");
  }

  const fromEnvironment = process.env.VIDRA_UPDATE_SIGNING_KEY;
  if (fromEnvironment && fromEnvironment.includes("PRIVATE KEY")) {
    return fromEnvironment;
  }

  return null;
};

export const writeSignature = (outDir: string, document: SignatureDocument): string => {
  const target = path.join(outDir, SIGNATURE_FILE);
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  return target;
};
