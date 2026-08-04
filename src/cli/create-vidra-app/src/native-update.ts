import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import type { ResolvedFeed } from "./update-config.js";
import {
  downloadArgs,
  findMacMainExe,
  findVpkOutputs,
  packArgs,
  resolveVpk,
  runVpk,
  type VpkOutputs,
} from "./velopack.js";
import { resolveMacCodeSigningIdentity } from "./signing.js";
import { resolveWindowsSigningConfig, timestampUrl } from "./windows-signing.js";

/**
 * The Velopack half of `vidra build`.
 *
 * Vidra owns none of Velopack: `vpk` is a build-time tool the CLI shells out
 * to, and the app talks to `UpdateManager` directly. What lives here is the
 * plumbing that makes `vpk` part of a build: resolving what to pack, merging
 * from the live feed first, and handing the tool the identity `vidra build`
 * already resolved.
 */

/**
 * `vpk` rejects `--signEntitlements` unless the file name ends in
 * `.entitlements`, and the MacCatalyst SDK requires the file to be called
 * `Entitlements.plist`. Nothing can satisfy both, so the build copies.
 */
export const entitlementsCopyName = (packId: string): string => `${packId}.entitlements`;

export interface NativeUpdateSettings {
  packId: string;
  packTitle: string | null;
  packVersion: string;
  /** Never null: a feed URL is what turned this tier on in the first place. */
  feedUrl: string;
  /** Absolute directory this release is packed into, from the dist layout. */
  releaseDir: string;
}

/**
 * Settles what `vpk pack` is being asked to produce.
 *
 * Only ever called for a config whose app tier resolved to a feed, so the URL is
 * a given rather than a thing to check for: there is no half-configured state
 * left where a release is packed that no installed app can find.
 *
 * The pack id is the app id the developer already chose: it names Velopack's
 * install directory (`%LOCALAPPDATA%\<packId>\`) and keys its feed, so deriving
 * it from `<ApplicationId>` keeps one identity rather than introducing a second
 * one nobody would remember to keep in step.
 *
 * **Velopack is never handed a channel.** Each Vidra channel is a directory on
 * both sides, so every one gets its own `releases.{platform}.json` under
 * Velopack's default `win` / `osx` names. Overriding those is exactly what would
 * collapse two platforms into one index.
 */
export const resolveNativeUpdateSettings = (opts: {
  feed: ResolvedFeed;
  /** Absolute, from the dist layout. */
  releaseDir: string;
  csprojPath: string;
  projectName: string;
  version: string;
}): NativeUpdateSettings => ({
  packId: readApplicationId(opts.csprojPath) ?? opts.projectName,
  // Not cosmetic on macOS: `vpk pack` renames the bundle to
  // `<packTitle ?? packId>.app`, so without this the app a user drags to
  // /Applications is called `com.example.notes.app`.
  packTitle: readApplicationTitle(opts.csprojPath) ?? opts.projectName,
  packVersion: opts.version,
  feedUrl: opts.feed.base,
  releaseDir: opts.releaseDir,
});

/** `<ApplicationId>` out of the host csproj. */
export const readApplicationId = (csprojPath: string): string | null =>
  readCsprojProperty(csprojPath, "ApplicationId");

/** `<ApplicationTitle>` out of the host csproj: the app's display name. */
export const readApplicationTitle = (csprojPath: string): string | null =>
  readCsprojProperty(csprojPath, "ApplicationTitle");

const readCsprojProperty = (csprojPath: string, name: string): string | null => {
  if (!fs.existsSync(csprojPath)) return null;
  const xml = fs.readFileSync(csprojPath, "utf-8");
  return new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1]?.trim() || null;
};

/**
 * `--signParams` for `vpk pack` on Windows, mirroring what `vidra build` passes
 * to `signtool` directly.
 *
 * Velopack signs everything it packages with an embedded `signtool`: 63 files
 * on the probe, including its own `Setup.exe` and `Update.exe`, which are the
 * binaries SmartScreen actually judges. `vidra build` signs one file, so this
 * is a strict improvement wherever a certificate exists.
 */
export const windowsSignParams = (): string | null => {
  const config = resolveWindowsSigningConfig();
  if (!config) return null;

  const parts = ["/fd", "SHA256", "/tr", timestampUrl(), "/td", "SHA256"];
  if (config.mode === "pfx") {
    parts.push("/f", config.pfxPath);
    if (config.password) parts.push("/p", config.password);
  } else {
    parts.push("/sha1", config.thumbprint);
  }
  return parts.join(" ");
};

export interface NativeUpdateIo {
  verbose: boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface NativeUpdateOutcome {
  releaseDir: string;
  outputs: VpkOutputs;
  /** What `vpk download` did, for reporting. */
  merged: "merged" | "empty-feed";
  /**
   * `already-released` when this version is in the feed already, which `vpk`
   * refuses to overwrite (exit 255, nothing written).
   *
   * Not an error, because with a feed URL alone turning this tier on, rebuilding
   * at an unchanged version is the ordinary inner loop rather than a mistake.
   * The build simply stops publishing and goes back to packaging what it just
   * built — the one thing it must never do is hand back the *previous* pack's
   * archive as if it were this build's output.
   */
  status: "packed" | "already-released";
}

export class NativeUpdateError extends Error {
  constructor(message: string, readonly detail: string = "") {
    super(message);
  }
}

/**
 * Downloads the live feed, then packs this build into it.
 *
 * Order matters and is not a preference. `vpk pack` merges with whatever is
 * already in `--outputDir`: that is how a 191 KB delta against a 94 MB package
 * happens, and equally how packing into an empty directory publishes an index
 * containing only the newest release, stranding every older install.
 */
export const runNativeUpdate = (opts: {
  projectRoot: string;
  settings: NativeUpdateSettings;
  /** The `.app` on macOS, the publish directory on Windows. */
  packDir: string;
  target: "macos" | "windows";
  /** The `Entitlements.plist` the build signed with, if any. */
  entitlements: string | null;
  io: NativeUpdateIo;
}): NativeUpdateOutcome => {
  const vpk = resolveVpk();
  if (!vpk) {
    throw new NativeUpdateError(
      "vpk is not installed",
      "dotnet tool install -g vpk",
    );
  }

  const releaseDir = opts.settings.releaseDir;
  fs.ensureDirSync(releaseDir);

  const merged = mergeFromLiveFeed(vpk, opts.settings, releaseDir, opts.io);

  const mainExe =
    opts.target === "macos"
      ? findMacMainExe(opts.packDir)
      : findWindowsMainExe(opts.packDir);

  if (!mainExe) {
    throw new NativeUpdateError(
      `could not find the app executable inside ${opts.packDir}`,
    );
  }

  const args = packArgs({
    packId: opts.settings.packId,
    packVersion: opts.settings.packVersion,
    packTitle: opts.settings.packTitle,
    packDir: opts.packDir,
    mainExe,
    outputDir: releaseDir,
    ...(opts.target === "macos"
      ? {
          // Velopack has to own signing: it adds files to a sealed bundle
          // *after* the build signed it, which breaks the seal. Handing it the
          // same identity and entitlements puts the packed bundle back on the
          // baseline's row: Developer ID authority, hardened runtime, all
          // three JIT entitlements, strict and deep verification passing.
          signAppIdentity: resolveMacCodeSigningIdentity("distribution"),
          signEntitlements: opts.entitlements
            ? copyEntitlementsForVpk(opts.entitlements, opts.settings.packId)
            : null,
          keychain: process.env.VIDRA_MACOS_KEYCHAIN?.trim() || null,
        }
      : { signParams: windowsSignParams() }),
  });

  const result = runVpk(vpk, args, { cwd: opts.projectRoot, verbose: opts.io.verbose });

  if (!result.ok) {
    if (result.alreadyReleased) {
      // `vpk` wrote nothing at all — no overwrite, no second package under one
      // version, no damaged index. So the feed is exactly as it was, and the
      // build carries on without it. The outputs are reported as absent rather
      // than read off disk: whatever sits in the release directory belongs to
      // the *previous* pack of this version, and handing that back would ship
      // bits nobody just built.
      return {
        releaseDir,
        outputs: { portableZip: null, setupExe: null, setupPkg: null },
        merged,
        status: "already-released",
      };
    }
    throw new NativeUpdateError("vpk pack failed", result.output);
  }

  return { releaseDir, outputs: findVpkOutputs(releaseDir), merged, status: "packed" };
};

/**
 * A feed that is not there yet is the normal first release, not an error: but
 * a feed that exists and could not be read is a real risk of publishing an
 * index that drops every previous entry, so it stops the build.
 */
const mergeFromLiveFeed = (
  vpk: string,
  settings: NativeUpdateSettings,
  releaseDir: string,
  io: NativeUpdateIo,
): NativeUpdateOutcome["merged"] => {
  const result = runVpk(
    vpk,
    downloadArgs({ feedUrl: settings.feedUrl, outputDir: releaseDir }),
    { verbose: io.verbose },
  );

  if (result.ok) return "merged";

  // vpk reports an empty or absent feed the same way it reports a typo'd URL.
  // Distinguishing them from here is guesswork, so this warns loudly rather
  // than either failing a legitimate first release or staying quiet about a
  // feed the developer thinks is being merged.
  //
  // The tail only: an unreachable feed produces twenty frames of
  // HttpConnectionPool, and the line that says what happened is the last one.
  io.warn(lastLines(result.output, 4));
  return "empty-feed";
};

/** `vpk` demands a `*.entitlements` name; MAUI demands `Entitlements.plist`. */
const copyEntitlementsForVpk = (entitlements: string, packId: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-vpk-"));
  const target = path.join(dir, entitlementsCopyName(packId));
  fs.copySync(entitlements, target);
  return target;
};

const findWindowsMainExe = (publishDir: string): string | null => {
  const entries = fs
    .readdirSync(publishDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".exe"))
    .map((e) => e.name);

  // The host assembly's own exe, not a bundled tool. `createdump.exe` ships in
  // every self-contained .NET publish and sorts first alphabetically.
  return entries.find((e) => e.endsWith(".Host.exe")) ?? entries.find((e) => e !== "createdump.exe") ?? null;
};

/**
 * Takes the packed `.app` back out of the portable zip Velopack just wrote.
 *
 * `ditto -x -k` rather than `unzip`: it preserves extended attributes and
 * resource forks, which is why the probe could extract a packed bundle and
 * still read a valid Developer ID signature off it.
 */
export const extractPackedApp = (portableZip: string): string => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-packed-"));
  execFileSync("ditto", ["-x", "-k", portableZip, staging], { stdio: "pipe" });

  const found = findAppBundle(staging);
  if (!found) {
    throw new NativeUpdateError(`no .app inside ${path.basename(portableZip)}`);
  }
  return found;
};

const findAppBundle = (root: string, depth = 0): string | null => {
  if (depth > 2 || !fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name.endsWith(".app")) return full;
    const nested = findAppBundle(full, depth + 1);
    if (nested) return nested;
  }
  return null;
};

const lastLines = (text: string, count: number): string =>
  text.trim().split(/\r?\n/).slice(-count).join("\n");
