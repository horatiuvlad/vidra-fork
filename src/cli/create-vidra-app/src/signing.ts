import path from "node:path";
import fs from "fs-extra";
import { execFileSync, spawnSync } from "node:child_process";
import { dim, footer, row, STEP_LABEL_WIDTH, value } from "./theme.js";

/**
 * What a signature is *for* decides which identity we want.
 *
 * - `development` — local `vidra dev` / `vidra run` launches. An
 *   `Apple Development:` certificate is the right (and freely obtainable)
 *   identity here; ad-hoc (`-`) is an acceptable last resort because the app
 *   never leaves the machine that built it.
 * - `distribution` — `vidra build`. Only a `Developer ID Application:`
 *   certificate can be notarized and pass Gatekeeper on someone else's Mac. A
 *   development certificate silently produces an app that works locally and is
 *   rejected everywhere else, so we prefer Developer ID and say so loudly when
 *   we have to fall back.
 */
export type SigningPurpose = "development" | "distribution";

export interface SignMacAppBundleOptions {
  verbose: boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
  /** Defaults to `development` to preserve the historical dev-launch behavior. */
  purpose?: SigningPurpose;
  /** Path to an `Entitlements.plist`; enables the hardened runtime when present. */
  entitlements?: string | null;
}

export interface MacSignatureVerification {
  ok: boolean;
  output: string;
}

const DEVELOPER_ID_PREFIX = "Developer ID Application:";
const APPLE_DEVELOPMENT_PREFIX = "Apple Development:";

export const signMacAppBundleIfPossible = (
  appBundle: string,
  options: SignMacAppBundleOptions,
): void => {
  if (process.platform !== "darwin") return;

  const purpose = options.purpose ?? "development";
  const { identity, expiredSkipped } = selectMacIdentity(purpose);
  warnAboutExpiredIdentities(expiredSkipped, options);
  const signWith = identity ?? "-";
  const label = path.basename(appBundle);

  // Notarization requires the hardened runtime, and the hardened runtime kills
  // .NET's JIT unless the matching entitlements are attached — so the two travel
  // together or not at all.
  const entitlements =
    options.entitlements && fs.existsSync(options.entitlements)
      ? options.entitlements
      : null;
  const hardened = purpose === "distribution" && entitlements !== null;

  if (purpose === "distribution") {
    warnAboutDistributionIdentity(identity, options);
    if (!entitlements) {
      options.warn(
        row({
          glyph: "manual",
          label: "codesign",
          labelWidth: STEP_LABEL_WIDTH,
          detail: dim(
            "no Entitlements.plist found — signing without the hardened runtime (cannot be notarized)",
          ),
        }),
      );
    }
  }

  try {
    // Sign inside-out: nested Mach-O payloads first, then the bundle itself.
    // `--deep` would do this in one shot but Apple explicitly discourages it for
    // distribution (it skips per-binary entitlements and is unsupported for
    // submission), so we walk the bundle ourselves.
    for (const nested of findNestedMachOPayloads(appBundle)) {
      runCodesign(nested, signWith, { hardened, entitlements: null }, options);
    }
    runCodesign(appBundle, signWith, { hardened, entitlements }, options);

    const detail = [
      value(label),
      dim(identity ? `with ${identity}` : "ad-hoc (-)"),
      hardened ? dim("· hardened runtime") : "",
    ]
      .filter(Boolean)
      .join(" ");

    options.log(
      row({
        glyph: "done",
        label: "codesign",
        labelWidth: STEP_LABEL_WIDTH,
        detail,
      }),
    );
  } catch (error) {
    options.warn(
      row({
        glyph: "manual",
        label: "codesign",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("could not sign the app bundle; it may fail to launch"),
      }),
    );
    options.warn(
      footer(
        dim(
          "install Xcode or the Command Line Tools (provides `codesign`), or set VIDRA_MACOS_CODESIGN_KEY.",
        ),
      ),
    );
    options.warn(dim(formatExecError(error)));
  }
};

/** Signs the packaged `.dmg` itself so the container carries a signature too. */
export const signMacDmgIfPossible = (
  dmgPath: string,
  options: SignMacAppBundleOptions,
): void => {
  if (process.platform !== "darwin") return;

  const purpose = options.purpose ?? "distribution";
  const { identity, expiredSkipped } = selectMacIdentity(purpose);
  warnAboutExpiredIdentities(expiredSkipped, options);
  if (!identity) {
    // Ad-hoc signing a disk image buys nothing — Gatekeeper judges the DMG by
    // its Developer ID signature or not at all — so skip rather than pretend.
    options.warn(
      row({
        glyph: "skip",
        label: "codesign dmg",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("no Developer ID identity — leaving the disk image unsigned"),
      }),
    );
    return;
  }

  try {
    // `--timestamp` is not optional here. Apple's notary service requires a
    // secure timestamp on every signature it is handed, and this disk image is
    // exactly what `vidra build` submits — without it the submission comes back
    // "The signature does not include a secure timestamp". It also keeps the
    // signature valid past the certificate's own expiry.
    execFileSync("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath], {
      stdio: options.verbose ? "inherit" : "pipe",
    });
    options.log(
      row({
        glyph: "done",
        label: "codesign dmg",
        labelWidth: STEP_LABEL_WIDTH,
        detail: `${value(path.basename(dmgPath))} ${dim(`with ${identity}`)}`,
      }),
    );
  } catch (error) {
    options.warn(
      row({
        glyph: "manual",
        label: "codesign dmg",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("could not sign the disk image"),
      }),
    );
    options.warn(dim(formatExecError(error)));
  }
};

/**
 * `codesign --verify --strict` — proves the signature is well-formed and the
 * bundle hasn't been mutated since signing. Passes for ad-hoc and self-signed
 * identities, which is what makes it usable as a CI gate without certificates.
 */
export const verifyMacSignature = (
  target: string,
): MacSignatureVerification => {
  try {
    const output = execFileSync(
      "codesign",
      ["--verify", "--strict", "--verbose=2", target],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    return { ok: true, output: output ?? "" };
  } catch (error) {
    return { ok: false, output: formatExecError(error) };
  }
};

/**
 * `spctl --assess` — the actual Gatekeeper verdict. Expected to FAIL until the
 * artifact is both Developer ID signed and notarized, so callers treat a
 * rejection as information rather than an error.
 */
export const assessGatekeeper = (
  target: string,
): MacSignatureVerification => {
  const type = target.endsWith(".dmg") ? "open" : "execute";
  const args = ["--assess", "--type", type, "--verbose=2"];
  if (type === "open") args.push("--context", "context:primary-signature");
  args.push(target);

  try {
    const output = execFileSync("spctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, output: output ?? "" };
  } catch (error) {
    return { ok: false, output: formatExecError(error) };
  }
};

/**
 * The entitlements .NET cannot run without once the hardened runtime is on.
 * Signing with `--options runtime` and *without* these produces a bundle that
 * signs, notarizes, and then dies the instant the JIT tries to work — so the
 * build verifies they actually landed rather than assuming.
 */
export const REQUIRED_MAC_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;

export interface MacHardeningReport {
  /** The bundle is signed with `--options runtime`. */
  hardened: boolean;
  /** Entitlement keys found embedded in the signature. */
  entitlements: string[];
  /** Required entitlements that are absent. */
  missing: string[];
  /** True when the signature is hardened and nothing required is missing. */
  ok: boolean;
  output: string;
}

/**
 * Reads back what was actually embedded in a signature, rather than what we
 * asked for. `codesign -d` reports the CodeDirectory flags (which include
 * `runtime` when the hardened runtime is enabled) and the entitlements blob.
 */
export const inspectMacHardening = (target: string): MacHardeningReport => {
  const flags = runCodesignRead(["-d", "--verbose=2", target]);
  const entitlementsXml = runCodesignRead(["-d", "--entitlements", "-", "--xml", target]) ||
    runCodesignRead(["-d", "--entitlements", "-", target]);

  const hardened = /CodeDirectory[^\n]*flags=[^\n]*runtime/.test(flags);
  const entitlements = [...entitlementsXml.matchAll(/<key>([^<]+)<\/key>/g)].map(
    (m) => m[1],
  );
  const missing = REQUIRED_MAC_ENTITLEMENTS.filter(
    (key) => !entitlementsXml.includes(key),
  );

  return {
    hardened,
    entitlements,
    missing,
    ok: hardened && missing.length === 0,
    output: `${flags}\n${entitlementsXml}`,
  };
};

/**
 * `codesign -d` writes its report to **stderr** even on success, which
 * `execFileSync` discards — so read both streams via `spawnSync`.
 */
const runCodesignRead = (args: string[]): string => {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

export interface MacIdentitySelection {
  /** The identity to sign with, or null when nothing usable was found. */
  identity: string | null;
  /** Identities that matched the purpose but were passed over as expired. */
  expiredSkipped: string[];
}

/**
 * Picks a signing identity, skipping expired certificates and reporting which
 * ones were skipped so the caller can say so rather than failing opaquely.
 */
export const selectMacIdentity = (
  purpose: SigningPurpose = "development",
): MacIdentitySelection => {
  const override = process.env.VIDRA_MACOS_CODESIGN_KEY?.trim();
  if (override) return { identity: override, expiredSkipped: [] };

  const all = listCodeSigningIdentities();
  const expired = new Set(listExpiredCodeSigningIdentities(all));
  const usable = all.filter((id) => !expired.has(id));

  const pick = (list: string[]): string | null =>
    (purpose === "distribution"
      ? list.find((id) => id.startsWith(DEVELOPER_ID_PREFIX)) ??
        list.find((id) => id.startsWith(APPLE_DEVELOPMENT_PREFIX))
      : list.find((id) => id.startsWith(APPLE_DEVELOPMENT_PREFIX)) ??
        list.find((id) => id.startsWith(DEVELOPER_ID_PREFIX))) ?? null;

  return {
    identity: pick(usable),
    // Only worth mentioning an expired certificate if it would otherwise have
    // been the one we chose.
    expiredSkipped: pick([...expired]) ? [pick([...expired]) as string] : [],
  };
};

export const resolveMacCodeSigningIdentity = (
  purpose: SigningPurpose = "development",
): string | null => selectMacIdentity(purpose).identity;

/**
 * Every code-signing identity in the keychain, **unfiltered**.
 *
 * Deliberately not `find-identity -v`: that lists only identities whose chain
 * validates, so a self-signed certificate reports `0 valid identities found`
 * while being present and perfectly usable — `codesign` does not require chain
 * trust to sign. Filtering here would silently hide the identity that CI and
 * anyone testing without a paid Apple membership actually signs with. Expiry is
 * handled separately, by date, so it stays distinguishable from "untrusted".
 */
export const listCodeSigningIdentities = (): string[] =>
  runFindIdentity(["find-identity", "-p", "codesigning"]);

/** The subset whose certificate chain validates — used only to narrow expiry checks. */
export const listValidCodeSigningIdentities = (): string[] =>
  runFindIdentity(["find-identity", "-v", "-p", "codesigning"]);

const runFindIdentity = (args: string[]): string[] => {
  try {
    const output = execFileSync("security", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    return output
      .split(/\r?\n/)
      .map((line) => line.match(/"([^"]+)"/)?.[1] ?? null)
      .filter((v): v is string => v !== null);
  } catch {
    return [];
  }
};

/**
 * Which of `identities` have already expired.
 *
 * Only identities that `find-identity -v` rejects are inspected: if the chain
 * validates, the certificate is by definition still in date, so the common case
 * (a real Apple-issued certificate) costs no extra work. For the rest we read
 * the certificate's own `notAfter` rather than inferring — "not chain-valid"
 * covers self-signed and expired alike, and telling a developer their
 * certificate expired is only useful if it's true.
 */
export const listExpiredCodeSigningIdentities = (
  identities: string[] = listCodeSigningIdentities(),
): string[] => {
  const chainValid = new Set(listValidCodeSigningIdentities());
  return identities.filter((id) => {
    if (chainValid.has(id)) return false;
    const notAfter = certificateNotAfter(id);
    return notAfter !== null && notAfter.getTime() < Date.now();
  });
};

/** A certificate's expiry date, or null if it can't be read. */
export const certificateNotAfter = (identity: string): Date | null => {
  const pem = spawnSync("security", ["find-certificate", "-c", identity, "-p"], {
    encoding: "utf8",
  });
  if (pem.status !== 0 || !pem.stdout) return null;

  const parsed = spawnSync("openssl", ["x509", "-noout", "-enddate"], {
    input: pem.stdout,
    encoding: "utf8",
  });
  const raw = parsed.stdout?.match(/notAfter=(.+)/)?.[1]?.trim();
  if (!raw) return null;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** True when a usable (non-expired) Developer ID Application certificate exists. */
export const hasDeveloperIdIdentity = (): boolean => {
  const all = listCodeSigningIdentities();
  const expired = new Set(listExpiredCodeSigningIdentities(all));
  return all.some((id) => id.startsWith(DEVELOPER_ID_PREFIX) && !expired.has(id));
};

/**
 * An expired certificate is still in the keychain and still selectable, so
 * without this the only symptom is `codesign` failing for no stated reason.
 */
const warnAboutExpiredIdentities = (
  expired: string[],
  options: SignMacAppBundleOptions,
): void => {
  for (const identity of expired) {
    options.warn(
      row({
        glyph: "manual",
        label: "codesign",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim(`skipping expired certificate: ${identity}`),
      }),
    );
  }
};

const warnAboutDistributionIdentity = (
  identity: string | null,
  options: SignMacAppBundleOptions,
): void => {
  if (identity === null) {
    options.warn(
      row({
        glyph: "manual",
        label: "codesign",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim(
          "no signing identity — the app will be ad-hoc signed and Gatekeeper will block it on other Macs",
        ),
      }),
    );
    return;
  }
  if (
    !identity.startsWith(DEVELOPER_ID_PREFIX) &&
    !process.env.VIDRA_MACOS_CODESIGN_KEY
  ) {
    options.warn(
      row({
        glyph: "manual",
        label: "codesign",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim(
          `using ${identity} — development certificates cannot be notarized; a "Developer ID Application" certificate is required to distribute`,
        ),
      }),
    );
  }
};

const runCodesign = (
  target: string,
  identity: string,
  opts: { hardened: boolean; entitlements: string | null },
  options: SignMacAppBundleOptions,
): void => {
  const args = ["--force", "--timestamp", "--sign", identity];
  if (opts.hardened) args.push("--options", "runtime");
  if (opts.entitlements) args.push("--entitlements", opts.entitlements);
  args.push(target);

  execFileSync("codesign", args, {
    stdio: options.verbose ? "inherit" : "pipe",
  });
};

/**
 * Dylibs and bundled frameworks must carry their own signature before the
 * enclosing bundle is sealed, otherwise `codesign --verify --strict` rejects the
 * result. Deepest paths first so nested frameworks are signed before parents.
 */
export const findNestedMachOPayloads = (appBundle: string): string[] => {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) {
          found.push(full);
          continue;
        }
        walk(full);
      } else if (entry.isFile() && /\.(dylib|so)$/.test(entry.name)) {
        found.push(full);
      }
    }
  };

  walk(appBundle);
  return found.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
};

export const formatExecError = (error: unknown): string => {
  const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString() : err.stderr;
  if (stderr) return stderr;
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString() : err.stdout;
  if (stdout) return stdout;
  return err.message ?? String(error);
};
