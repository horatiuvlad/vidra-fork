import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { execSync } from "node:child_process";
import { parseArgs } from "../utils.js";
import { detectProject, type ProjectInfo } from "../project.js";
import { createZip, readDirectoryEntries } from "../zip.js";
import { readUpdateConfig } from "../update-config.js";
import {
  publicKeyFor,
  resolveSigningKey,
  signManifest,
  writeSignature,
} from "../manifest-signing.js";
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
 * `vidra bundle` — the publisher half of OTA updates.
 *
 * Produces the two things a feed needs and nobody can reasonably produce by
 * hand: a deterministic archive of `ui/dist`, and an entry describing it that
 * carries **both contract fingerprints**. Those fingerprints are the gate the
 * host applies before installing anything, and they are generated values — the
 * core one by the SDK's codegen, the app one by the project's — so asking a
 * developer to copy them into a manifest would be asking for the one mistake
 * that makes an update silently uninstallable.
 */

export interface BundleEntry {
  version: string;
  url: string;
  sha256: string;
  size: number;
  coreFingerprint: string;
  appFingerprint: string;
  channel?: string;
}

export interface BundleManifest {
  schema: number;
  bundles: BundleEntry[];
}

const SCHEMA = 1;

export interface BundleOptions {
  out: string;
  channel?: string;
  skipBuild: boolean;
  /** Path to the signing key; the environment is consulted when absent. */
  sign?: string;
}

/**
 * Reads the command's flags.
 *
 * The `["_", "_", ...]` padding is the house convention: `parseArgs` is written
 * for a raw `process.argv` and skips the first two entries, so a command that
 * passes its own already-sliced argv silently loses its first two flags.
 */
export const parseBundleOptions = (argv: string[]): BundleOptions => {
  const args = parseArgs(["_", "_", ...argv]);
  return {
    out: typeof args.out === "string" ? args.out : "dist",
    channel: typeof args.channel === "string" ? args.channel : undefined,
    skipBuild: !!args["skip-build"],
    sign: typeof args.sign === "string" ? args.sign : undefined,
  };
};

export const bundleCommand = async (argv: string[]): Promise<void> => {
  const options = parseBundleOptions(argv);
  const project = detectProject(process.cwd());
  const outDir = path.resolve(project.root, options.out);
  const channel = options.channel;

  console.log(header("bundle", `${project.projectName} ${project.displayVersion}`));

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
    ...(channel ? { channel } : {}),
  };

  const manifestPath = path.join(outDir, "bundles.json");
  const manifest = mergeManifest(readManifest(manifestPath), entry);
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

  console.log(
    footer(
      dim(
        `upload ${value(path.relative(project.root, outDir) || "dist")}/ to your feed host — ` +
          `every file, and bundles.json last`,
      ),
    ),
  );
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

  try {
    const parsed = fs.readJsonSync(file) as Partial<BundleManifest>;
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
  const supersedes = (existing: BundleEntry): boolean =>
    existing.version === entry.version &&
    (existing.channel ?? null) === (entry.channel ?? null) &&
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
