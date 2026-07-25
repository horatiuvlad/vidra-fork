import path from "node:path";
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import { dim, row, STEP_LABEL_WIDTH, value } from "./theme.js";
import { formatExecError } from "./signing.js";

/**
 * Authenticode signing config, resolved from the environment.
 *
 * - `pfx` — a certificate file plus password, which is what CI secrets provide.
 * - `thumbprint` — a certificate already installed in the machine/user store,
 *   which is how hardware-token (EV) certificates are typically used.
 *
 * Absent both, signing is skipped: an unsigned build still runs, it just draws a
 * SmartScreen warning, so this must never be a hard failure of `vidra build`.
 */
export type WindowsSigningConfig =
  | { mode: "pfx"; pfxPath: string; password: string | null }
  | { mode: "thumbprint"; thumbprint: string };

export interface WindowsSignOptions {
  verbose: boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Without a trusted timestamp the signature stops validating the moment the
 * certificate expires; with one it stays valid for the life of the timestamp.
 */
export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

export const resolveWindowsSigningConfig = (): WindowsSigningConfig | null => {
  const thumbprint = process.env.VIDRA_WINDOWS_CERT_THUMBPRINT?.trim();
  if (thumbprint) return { mode: "thumbprint", thumbprint };

  const pfxPath = process.env.VIDRA_WINDOWS_CERT_PATH?.trim();
  if (pfxPath) {
    const password = process.env.VIDRA_WINDOWS_CERT_PASSWORD?.trim() ?? null;
    return { mode: "pfx", pfxPath, password };
  }

  return null;
};

export const timestampUrl = (): string =>
  process.env.VIDRA_WINDOWS_TIMESTAMP_URL?.trim() || DEFAULT_TIMESTAMP_URL;

/** The `signtool sign` argument vector. Split out so tests can assert it without Windows. */
export const buildSignToolArgs = (
  config: WindowsSigningConfig,
  targets: string[],
): string[] => {
  const args = ["sign", "/fd", "SHA256", "/tr", timestampUrl(), "/td", "SHA256"];
  if (config.mode === "pfx") {
    args.push("/f", config.pfxPath);
    if (config.password) args.push("/p", config.password);
  } else {
    args.push("/sha1", config.thumbprint);
  }
  return [...args, ...targets];
};

export const signWindowsBinariesIfPossible = (
  targets: string[],
  options: WindowsSignOptions,
): boolean => {
  if (process.platform !== "win32") return false;
  if (targets.length === 0) return false;

  const config = resolveWindowsSigningConfig();
  if (!config) {
    options.log(
      row({
        glyph: "skip",
        label: "authenticode",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim(
          "no certificate configured — shipping unsigned (SmartScreen will warn)",
        ),
      }),
    );
    return false;
  }

  const signtool = resolveSignTool();
  if (!signtool) {
    options.warn(
      row({
        glyph: "manual",
        label: "authenticode",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("signtool.exe not found — install the Windows SDK"),
      }),
    );
    return false;
  }

  try {
    execFileSync(signtool, buildSignToolArgs(config, targets), {
      stdio: options.verbose ? "inherit" : "pipe",
    });
    options.log(
      row({
        glyph: "done",
        label: "authenticode",
        labelWidth: STEP_LABEL_WIDTH,
        detail: `${value(`${targets.length} file(s)`)} ${dim(`timestamped via ${timestampUrl()}`)}`,
      }),
    );
    return true;
  } catch (error) {
    options.warn(
      row({
        glyph: "manual",
        label: "authenticode",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("signing failed; shipping unsigned"),
      }),
    );
    options.warn(dim(formatExecError(error)));
    return false;
  }
};

export interface WindowsSignatureVerification {
  /** A signature is present and intact. */
  ok: boolean;
  /** The signature is valid but its chain does not reach a trusted root. */
  untrustedRoot: boolean;
  output: string;
}

/**
 * `signtool verify /pa` answers two different questions at once: *is the binary
 * signed and intact?* and *does the certificate chain to a trusted root?* It
 * fails on the second even when the first is perfectly satisfied — which is
 * always the case for a self-signed certificate.
 *
 * We treat signature presence and integrity as the pass criterion and chain
 * trust as advisory, mirroring how `spctl` is reported rather than asserted on
 * macOS. Trust is earned from a certificate authority, not from the build.
 */
export const verifyWindowsSignature = (
  target: string,
): WindowsSignatureVerification => {
  const signtool = resolveSignTool();
  if (!signtool) {
    return { ok: false, untrustedRoot: false, output: "signtool.exe not found" };
  }
  try {
    const output = execFileSync(signtool, ["verify", "/pa", "/v", target], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { ok: true, untrustedRoot: false, output: output ?? "" };
  } catch (error) {
    const output = formatExecError(error);
    // CERT_E_UNTRUSTEDROOT — signed correctly, just not by anyone Windows trusts.
    const untrustedRoot =
      /0x800B0109/i.test(output) ||
      /terminated in a root certificate which is not trusted/i.test(output);
    return { ok: untrustedRoot, untrustedRoot, output };
  }
};

/**
 * `signtool.exe` ships with the Windows SDK and is not on PATH by default, so
 * fall back to scanning the SDK's versioned `bin` directories, newest first.
 */
export const resolveSignTool = (): string | null => {
  const override = process.env.VIDRA_SIGNTOOL_PATH?.trim();
  if (override) return fs.existsSync(override) ? override : null;

  try {
    execFileSync("signtool", ["/?"], { stdio: "ignore" });
    return "signtool";
  } catch {
    // not on PATH — fall through to the SDK scan
  }

  const roots = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ].filter((r): r is string => !!r);

  for (const root of roots) {
    const binDir = path.join(root, "Windows Kits", "10", "bin");
    if (!fs.existsSync(binDir)) continue;
    const versions = fs
      .readdirSync(binDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const version of versions) {
      for (const arch of ["x64", "x86"]) {
        const candidate = path.join(binDir, version, arch, "signtool.exe");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  return null;
};

/**
 * The app executable is named after the host assembly (`<Name>.Host.exe`). We
 * sign only that: the bundled .NET runtime binaries arrive already signed by
 * Microsoft, and re-signing them adds minutes for no trust benefit.
 */
export const findPrimaryExecutable = (
  publishDir: string,
  projectName: string,
): string | null => {
  if (!fs.existsSync(publishDir)) return null;
  const exes = fs
    .readdirSync(publishDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".exe"))
    .map((e) => e.name);

  const preferred =
    exes.find((n) => n.toLowerCase() === `${projectName}.host.exe`.toLowerCase()) ??
    exes.find((n) => n.toLowerCase().startsWith(projectName.toLowerCase()));

  const chosen = preferred ?? exes[0];
  return chosen ? path.join(publishDir, chosen) : null;
};
