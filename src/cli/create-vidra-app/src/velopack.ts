import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { execFileSync } from "node:child_process";

/**
 * Every `vpk` invocation Vidra makes, in one place.
 *
 * Two rules hold throughout, and both were paid for:
 *
 * 1. **An argv array, never a shell string.** Signing identities contain spaces
 *    and parentheses (`Developer ID Application: Vidra CI (TESTTEAM01)`), and
 *    git-bash rewrites any argument that starts with `/` into a Windows path —
 *    which is how `--signParams "/sha1 … /fd SHA256"` once reached signtool
 *    mangled and it reported "no file digest algorithm specified" for a flag
 *    that was plainly in the command line.
 * 2. **The argument vectors are pure functions.** They are unit-tested on Linux,
 *    where `vpk` will never be asked to pack a `.app` — which is exactly the
 *    kind of thing that otherwise costs a fifteen-minute round trip on a
 *    platform runner to discover.
 */

/** `vpk pack`'s "this version already exists" refusal. */
const ALREADY_RELEASED =
  /There is a release in channel .*? which is equal or greater to the current version/i;

export interface VpkPackOptions {
  packId: string;
  packVersion: string;
  /** The `.app` on macOS, the publish directory on Windows. */
  packDir: string;
  /** File name, not path, of the executable that *is* the app. */
  mainExe: string;
  outputDir: string;
  /** Velopack's channel. Left out it defaults to `osx` / `win`. */
  channel?: string | null;
  /** macOS: a `Developer ID Application:` identity. */
  signAppIdentity?: string | null;
  /** macOS: a file whose name ends in `.entitlements` — vpk rejects any other suffix. */
  signEntitlements?: string | null;
  /** macOS: a non-default keychain to sign from. */
  keychain?: string | null;
  /** Windows: the `signtool sign` arguments after the file list. */
  signParams?: string | null;
}

export interface VpkDownloadOptions {
  /** Base URL of the directory `vpk pack` writes into — not `bundles.json`. */
  feedUrl: string;
  outputDir: string;
  channel?: string | null;
}

export interface VpkResult {
  ok: boolean;
  /** stdout and stderr combined: vpk writes its fatal errors to stdout. */
  output: string;
  /** True when the failure was "this version is already in the feed". */
  alreadyReleased: boolean;
}

/**
 * `vpk pack`'s argument vector.
 *
 * Signing is opt-in per platform and per option, because a build machine with
 * no certificate must still produce a working (unsigned) release rather than
 * failing — the same rule the rest of `vidra build` follows.
 */
export const packArgs = (options: VpkPackOptions): string[] => {
  const args = [
    "pack",
    "--packId",
    options.packId,
    "--packVersion",
    options.packVersion,
    "--packDir",
    options.packDir,
    "--mainExe",
    options.mainExe,
    "--outputDir",
    options.outputDir,
  ];

  if (options.channel) args.push("--channel", options.channel);
  if (options.signAppIdentity) args.push("--signAppIdentity", options.signAppIdentity);
  if (options.signEntitlements) args.push("--signEntitlements", options.signEntitlements);
  if (options.keychain) args.push("--keychain", options.keychain);
  if (options.signParams) args.push("--signParams", options.signParams);

  return args;
};

/**
 * `vpk download http`'s argument vector.
 *
 * This is the native tier's `--merge-from`, and it is not optional for the same
 * reason: `vpk pack` merges with whatever is already in `--outputDir`, so
 * packing into an empty directory publishes an index containing only the newest
 * release. Every older install then has nothing to delta against and nothing to
 * roll back to.
 */
export const downloadArgs = (options: VpkDownloadOptions): string[] => {
  const args = ["download", "http", "--url", options.feedUrl, "--outputDir", options.outputDir];
  if (options.channel) args.push("--channel", options.channel);
  return args;
};

/**
 * Locates `vpk`. On PATH first, then the .NET global tools directory — which is
 * where `dotnet tool install -g vpk` puts it and which is *not* on PATH in a
 * shell that was started before the install.
 */
export const resolveVpk = (): string | null => {
  const exe = process.platform === "win32" ? "vpk.exe" : "vpk";

  const onPath = which(exe);
  if (onPath) return onPath;

  const home = process.env.DOTNET_CLI_HOME?.trim() || os.homedir();
  const candidate = path.join(home, ".dotnet", "tools", exe);
  return fs.existsSync(candidate) ? candidate : null;
};

/**
 * The version of the installed `vpk`.
 *
 * There is no `--version`: it answers "Unrecognized command or argument". The
 * version is in the banner every command prints — `Velopack CLI 1.2.0, for
 * distributing applications.` — so ask for help and read that.
 */
export const parseVpkVersion = (helpOutput: string): string | null =>
  helpOutput.match(/Velopack CLI\s+([\d][\w.+-]*)/i)?.[1] ?? null;

export const vpkVersion = (vpk: string): string | null => {
  try {
    const output = execFileSync(vpk, ["--help"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseVpkVersion(output ?? "");
  } catch (error) {
    // `--help` exits non-zero on some shells; the banner is still in the output.
    return parseVpkVersion(combinedOutput(error));
  }
};

/**
 * Recognises `vpk pack` refusing to publish a version that is already in the
 * feed.
 *
 * **Measured** with vpk 1.2.0: packing a version equal to *or lower than* the
 * newest entry in the output directory's index fails with exit 255 and writes
 * nothing at all — the index, the packages and the installer are left exactly
 * as they were. So re-running a build at an already-published version is safe;
 * it is just not a no-op, and the developer deserves to be told which of the
 * two things they meant rather than being handed a stack trace.
 */
export const isVersionAlreadyReleased = (output: string): boolean =>
  ALREADY_RELEASED.test(output);

export const runVpk = (
  vpk: string,
  args: string[],
  options: { cwd?: string; verbose?: boolean } = {},
): VpkResult => {
  try {
    const output = execFileSync(vpk, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      // Never `shell: true`. See the header.
      stdio: options.verbose ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // git-bash's argument mangling again: it rewrites anything starting
        // with `/`, and Velopack's Windows signing arguments all do.
        MSYS2_ARG_CONV_EXCL: "*",
      },
    });
    return { ok: true, output: output ?? "", alreadyReleased: false };
  } catch (error) {
    const output = combinedOutput(error);
    return { ok: false, output, alreadyReleased: isVersionAlreadyReleased(output) };
  }
};

/**
 * The name of the executable inside a Mac Catalyst bundle that is actually the
 * app.
 *
 * After `vpk pack` there are three entries in `Contents/MacOS` — the app, the
 * updater, and a manifest — and taking the first one launches `UpdateMac`,
 * which starts, prints "No known subcommand was used", and exits. That is
 * indistinguishable from an app that never booted, and it cost a CI round trip
 * once already.
 */
export const findMacMainExe = (appBundle: string): string | null => {
  const macos = path.join(appBundle, "Contents", "MacOS");
  if (!fs.existsSync(macos)) return null;

  const declared = readMainExeFromSpec(appBundle);
  if (declared && fs.existsSync(path.join(macos, declared))) return declared;

  const candidates = fs
    .readdirSync(macos, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && e.name !== "UpdateMac" && e.name !== "sq.version")
    .map((e) => e.name);

  return candidates[0] ?? null;
};

/** `<mainExe>` out of the nuspec `vpk pack` leaves behind as `sq.version`. */
export const readMainExeFromSpec = (appBundle: string): string | null => {
  for (const dir of ["MacOS", "Resources"]) {
    const file = path.join(appBundle, "Contents", dir, "sq.version");
    if (!fs.existsSync(file)) continue;
    const match = /<mainExe>([^<]+)<\/mainExe>/.exec(fs.readFileSync(file, "utf-8"));
    if (match) return match[1].trim();
  }
  return null;
};

/**
 * The files `vpk pack` writes for one release, found by the naming scheme it
 * uses rather than by guessing.
 */
export interface VpkOutputs {
  portableZip: string | null;
  setupExe: string | null;
  setupPkg: string | null;
}

export const findVpkOutputs = (outputDir: string): VpkOutputs => {
  const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  const find = (suffix: string): string | null => {
    const match = files.find((f) => f.toLowerCase().endsWith(suffix.toLowerCase()));
    return match ? path.join(outputDir, match) : null;
  };

  return {
    portableZip: find("Portable.zip"),
    setupExe: find("Setup.exe"),
    setupPkg: find("Setup.pkg"),
  };
};

const combinedOutput = (error: unknown): string => {
  const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const text = (v: Buffer | string | undefined): string =>
    v == null ? "" : Buffer.isBuffer(v) ? v.toString() : v;
  const combined = [text(err.stdout), text(err.stderr)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return combined || err.message || String(error);
};

const which = (exe: string): string | null => {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(probe, [exe], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
};
