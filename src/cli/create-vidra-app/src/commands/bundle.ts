import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { execSync } from "node:child_process";
import type { ProjectInfo } from "../project.js";
import { createZip, readDirectoryEntries } from "../zip.js";
import { readUpdateConfig } from "../update-config.js";
import {
  publicKeyFor,
  resolveSigningKey,
  signManifest,
  verifyManifest,
  writeSignature,
} from "../manifest-signing.js";
import {
  amber,
  dim,
  row,
  STEP_LABEL_WIDTH as LABEL_WIDTH,
  value,
} from "../theme.js";

/**
 * The web-bundle half of `vidra build`, reached as `vidra build --web`.
 *
 * Produces the two things a feed needs and nobody can reasonably produce by
 * hand: a deterministic archive of `ui/dist`, and an entry describing it that
 * carries **both contract fingerprints**. Those fingerprints are the gate the
 * host applies before installing anything, and they are generated values — the
 * core one by the SDK's codegen, the app one by the project's — so asking a
 * developer to copy them into a manifest would be asking for the one mistake
 * that makes an update silently uninstallable.
 *
 * It needs no platform, no compiler and no MAUI workload, which is the entire
 * point of the tier: shipping a UI fix should not cost a native build.
 */

export interface BundleEntry {
  version: string;
  url: string;
  sha256: string;
  size: number;
  coreFingerprint: string;
  appFingerprint: string;
}

export interface BundleManifest {
  schema: number;
  bundles: BundleEntry[];
}

const SCHEMA = 1;

export interface WebBundleOptions {
  /** Absolute directory this publishes into, decided by the dist layout. */
  outDir: string;
  /**
   * The live index this publish adds to. Resolved from `package.json` rather
   * than passed by hand: forgetting it on a clean CI checkout used to publish
   * an index containing only the newest entry, which strands every install that
   * can only run an older one.
   */
  mergeFrom?: string;
  /** Path to the signing key; the environment is consulted when absent. */
  sign?: string;
  /** Skip the Vite build, for when the caller already ran it. */
  skipBuild: boolean;
}

export const runWebBundle = async (
  project: ProjectInfo,
  options: WebBundleOptions,
): Promise<void> => {
  const outDir = options.outDir;

  if (!options.skipBuild) {
    stepBuildUi(project);
  }

  const dist = path.join(project.uiDir, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    console.error(
      row({
        glyph: "error",
        label: "read ui/dist",
        labelWidth: LABEL_WIDTH,
        detail: dim("no index.html — run the UI build first, or drop --skip-build"),
      }),
    );
    process.exit(1);
  }

  const fingerprints = readFingerprints(project);

  const entries = readDirectoryEntries(dist);
  const archive = createZip(entries);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const name = `bundle-${project.displayVersion}-${sha256.slice(0, 8)}.zip`;

  fs.ensureDirSync(outDir);
  fs.writeFileSync(path.join(outDir, name), archive);

  console.log(
    row({
      glyph: "done",
      label: "pack bundle",
      labelWidth: LABEL_WIDTH,
      detail: `${value(name)} ${dim(`(${entries.length} files, ${formatBytes(archive.length)})`)}`,
    }),
  );

  const entry: BundleEntry = {
    version: project.displayVersion,
    url: name,
    sha256,
    size: archive.length,
    coreFingerprint: fingerprints.core,
    appFingerprint: fingerprints.app,
  };

  const manifestPath = path.join(outDir, "bundles.json");
  const base = await loadBaseManifest(options, outDir, signingKeyFor(options));
  const manifest = mergeManifest(base, entry);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestPath, manifestBytes);

  console.log(
    row({
      glyph: "done",
      label: "write feed",
      labelWidth: LABEL_WIDTH,
      detail: `${value("bundles.json")} ${dim(`(${manifest.bundles.length} entries)`)}`,
    }),
  );

  stepSignManifest(project, outDir, manifestBytes, options.sign);
  console.log(
    row({
      glyph: "plan",
      label: "compatible",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("core")} ${value(fingerprints.core.slice(0, 12))} ${dim("app")} ${value(fingerprints.app.slice(0, 12))}`,
    }),
  );

};

/**
 * Reads the index this publish is adding to.
 *
 * Without `--merge-from` that is whatever `bundles.json` happens to be in the
 * out directory — fine locally, and silently wrong in CI, where a clean checkout
 * has none and the published index ends up containing only the newest entry.
 * That is not merely untidy: an app built against an older core contract can only
 * install a bundle whose fingerprints match it, so dropping older entries
 * strands exactly those users.
 */
export const loadBaseManifest = async (
  options: Pick<WebBundleOptions, "mergeFrom">,
  outDir: string,
  privateKeyPem: string | null,
): Promise<BundleManifest> => {
  if (!options.mergeFrom) {
    return readManifest(path.join(outDir, "bundles.json"));
  }

  let fetched: { manifest: string; signature: string | null } | null;
  try {
    fetched = await fetchFeed(options.mergeFrom);
  } catch (error) {
    // Never fall back to "start empty" on a failed fetch. A network blip would
    // otherwise publish an index that quietly drops every existing entry.
    return fail("merge feed", `could not read ${options.mergeFrom}: ${(error as Error).message}`);
  }

  if (!fetched) {
    console.log(
      row({
        glyph: "plan",
        label: "merge feed",
        labelWidth: LABEL_WIDTH,
        detail: dim(`no index at ${options.mergeFrom} yet — publishing the first one`),
      }),
    );
    return { schema: SCHEMA, bundles: [] };
  }

  // Signing what you just downloaded is how an attacker gets their entries into
  // your feed under your key: they inject, you merge, you sign, every app
  // installs it. So a signed publisher only merges an index its own key signed.
  if (privateKeyPem) {
    const { publicKey } = publicKeyFor(privateKeyPem);
    const ok =
      fetched.signature !== null &&
      verifyManifest(Buffer.from(fetched.manifest), safeParse(fetched.signature), publicKey);

    if (!ok) {
      fail(
        "merge feed",
        `the index at ${options.mergeFrom} is not signed by your key — refusing to merge and ` +
          "re-sign it, which would publish someone else's entries under your signature",
      );
    }
  }

  const base = parseManifest(fetched.manifest);
  console.log(
    row({
      glyph: "done",
      label: "merge feed",
      labelWidth: LABEL_WIDTH,
      detail: `${value(options.mergeFrom)} ${dim(`(${base.bundles.length} existing entries)`)}`,
    }),
  );
  return base;
};

/** Returns null when there is simply no index there yet — the first publish. */
const fetchFeed = async (
  source: string,
): Promise<{ manifest: string; signature: string | null } | null> => {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const manifest = await response.text();
    const signatureResponse = await fetch(`${source}.sig`);
    return {
      manifest,
      signature: signatureResponse.ok ? await signatureResponse.text() : null,
    };
  }

  const manifestPath = fs.existsSync(source) && fs.statSync(source).isDirectory()
    ? path.join(source, "bundles.json")
    : source;

  if (!fs.existsSync(manifestPath)) return null;

  const signaturePath = `${manifestPath}.sig`;
  return {
    manifest: fs.readFileSync(manifestPath, "utf8"),
    signature: fs.existsSync(signaturePath) ? fs.readFileSync(signaturePath, "utf8") : null,
  };
};

const safeParse = (text: string): { algorithm: string; keyId: string; signature: string } => {
  try {
    return JSON.parse(text);
  } catch {
    return { algorithm: "", keyId: "", signature: "" };
  }
};

/** The key this publish will sign with, or null when it will not sign. */
const signingKeyFor = (options: Pick<WebBundleOptions, "sign">): string | null => {
  try {
    return resolveSigningKey(options.sign);
  } catch {
    // A bad --sign path is reported by the signing step, which runs later and
    // owns that message.
    return null;
  }
};

/**
 * Signs the manifest, or explains why the feed will be rejected.
 *
 * The loud case is the mismatch: an app configured with public keys will refuse
 * an unsigned feed, so publishing one without a key produces a feed that looks
 * fine and silently reaches nobody. That has to be an error at publish time, not
 * a mystery later.
 */
const stepSignManifest = (
  project: ProjectInfo,
  outDir: string,
  manifestBytes: Buffer,
  keyPath?: string,
): void => {
  const configuredKeys = readUpdateConfig(project.root)?.publicKeys ?? [];

  let privateKeyPem: string | null = null;
  try {
    privateKeyPem = resolveSigningKey(keyPath);
  } catch (error) {
    fail("sign feed", (error as Error).message);
  }

  if (!privateKeyPem) {
    if (configuredKeys.length > 0) {
      fail(
        "sign feed",
        "this app trusts a signing key, so an unsigned feed would be refused by every " +
          "installed copy — pass --sign <key.pem> or set VIDRA_UPDATE_SIGNING_KEY",
      );
    }

    fs.removeSync(path.join(outDir, "bundles.json.sig"));
    console.log(
      row({
        glyph: "manual",
        label: "sign feed",
        labelWidth: LABEL_WIDTH,
        detail: amber(
          "unsigned — anyone who can write to your feed host can run code in your app",
        ),
      }),
    );
    return;
  }

  let document;
  let publicKey;
  try {
    document = signManifest(manifestBytes, privateKeyPem);
    publicKey = publicKeyFor(privateKeyPem).publicKey;
  } catch (error) {
    return fail("sign feed", (error as Error).message);
  }

  writeSignature(outDir, document);

  // Signing with a key the app does not trust produces a feed nobody can
  // install from, which is worth catching here rather than in a support thread.
  if (configuredKeys.length > 0 && !configuredKeys.includes(publicKey)) {
    fail(
      "sign feed",
      `signed with key ${document.keyId}, which is not among the ${configuredKeys.length} ` +
        "key(s) in package.json — installed apps would reject this feed",
    );
  }

  console.log(
    row({
      glyph: "done",
      label: "sign feed",
      labelWidth: LABEL_WIDTH,
      detail: `${value("bundles.json.sig")} ${dim(`(key ${document.keyId})`)}`,
    }),
  );
};

const stepBuildUi = (project: ProjectInfo): void => {
  try {
    execSync("npm run build", { cwd: project.uiDir, stdio: "pipe" });
  } catch {
    console.error(
      row({
        glyph: "error",
        label: "build UI",
        labelWidth: LABEL_WIDTH,
        detail: dim("vite build failed"),
      }),
    );
    process.exit(1);
  }

  console.log(
    row({
      glyph: "done",
      label: "build UI",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("vite →")} ${value("ui/dist")}`,
    }),
  );
};

/**
 * Reads the fingerprints the host will compare against: the app's from its own
 * generated manifest, the core one from the installed SDK's. Both are produced
 * by codegen, so they are always the values this build actually speaks — which
 * is the whole reason they are read rather than configured.
 */
export const readFingerprints = (
  project: ProjectInfo,
): { core: string; app: string } => {
  const appManifest = path.join(project.uiDir, "src", "generated", "manifest.json");
  const app = readFingerprintFile(appManifest);
  if (!app) {
    fail(
      "read fingerprints",
      `no app contract fingerprint in ${path.relative(project.root, appManifest)} — build the host once to generate it`,
    );
  }

  const sdkManifest = path.join(
    project.uiDir,
    "node_modules",
    "@vidra-dev",
    "sdk",
    "dist",
    "manifest.json",
  );
  const core = readFingerprintFile(sdkManifest);
  if (!core) {
    fail(
      "read fingerprints",
      "no core contract fingerprint from @vidra-dev/sdk — run npm install in ui/, and make sure the SDK is 0.4.0 or newer",
    );
  }

  return { core: core!, app: app! };
};

const readFingerprintFile = (file: string): string | null => {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = fs.readJsonSync(file) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === "string" && parsed.fingerprint.length > 0
      ? parsed.fingerprint
      : null;
  } catch {
    return null;
  }
};

export const readManifest = (file: string): BundleManifest => {
  if (!fs.existsSync(file)) return { schema: SCHEMA, bundles: [] };
  return parseManifest(fs.readFileSync(file, "utf8"));
};

export const parseManifest = (text: string): BundleManifest => {
  try {
    const parsed = JSON.parse(text) as Partial<BundleManifest>;
    if (parsed.schema !== SCHEMA || !Array.isArray(parsed.bundles)) {
      return { schema: SCHEMA, bundles: [] };
    }
    return { schema: SCHEMA, bundles: parsed.bundles };
  } catch {
    return { schema: SCHEMA, bundles: [] };
  }
};

/**
 * Adds an entry, replacing any existing one for the same version, channel and
 * compatibility. Republishing the same version has to overwrite rather than
 * accumulate: two entries claiming one version is a feed that behaves
 * differently depending on which the client happens to pick.
 */
export const mergeManifest = (
  manifest: BundleManifest,
  entry: BundleEntry,
): BundleManifest => {
  // No channel in the key: a channel is a directory now, so two channels are two
  // indexes and an entry never has to distinguish itself from its own twin
  // published elsewhere.
  const supersedes = (existing: BundleEntry): boolean =>
    existing.version === entry.version &&
    existing.coreFingerprint === entry.coreFingerprint &&
    existing.appFingerprint === entry.appFingerprint;

  return {
    schema: SCHEMA,
    bundles: [...manifest.bundles.filter((e) => !supersedes(e)), entry],
  };
};

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const fail = (label: string, detail: string): never => {
  console.error(row({ glyph: "error", label, labelWidth: LABEL_WIDTH, detail: dim(detail) }));
  process.exit(1);
};
