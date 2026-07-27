import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { execFileSync } from "node:child_process";

/**
 * Knowledge about where things live inside a built artifact.
 *
 * This is the single home for bundle-layout facts — which `.app` is in a disk
 * image, where the executable sits inside it, which `.exe` is the app rather
 * than a bundled runtime helper. Before this existed the CLI knew it in
 * `commands/dev.ts` and the CI scripts re-derived it in bash and PowerShell,
 * which is pure drift risk with no upside.
 */

/** The first `.app` directly inside a directory (a publish dir or a mounted disk image). */
export const findAppBundle = (dir: string): string | null => {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".app") && entry.isDirectory()) {
      return path.join(dir, entry.name);
    }
  }
  return null;
};

/** Recursive variant, for build outputs that nest the bundle under RID folders. */
export const findAppBundleRecursive = (dir: string): string | null => {
  const direct = findAppBundle(dir);
  if (direct) return direct;
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findAppBundleRecursive(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
};

/**
 * The executable inside a `.app`. Launching this directly — rather than via
 * `open` — is what lets a caller capture stdout and wait on the process.
 */
export const findMacExecutable = (appBundle: string): string | null => {
  const macOsDir = path.join(appBundle, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) return null;
  const entries = fs
    .readdirSync(macOsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const preferred =
    entries.find((n) => n === path.basename(appBundle, ".app")) ?? entries[0];
  return preferred ? path.join(macOsDir, preferred) : null;
};

/**
 * The app executable in a published Windows folder. Named after the host
 * *assembly* (`<Name>.Host.exe`), alongside runtime helpers like
 * `createdump.exe` that must not be mistaken for it.
 */
export const findWindowsExecutable = (
  dir: string,
  projectName?: string,
): string | null => {
  if (!fs.existsSync(dir)) return null;
  const exes = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".exe"))
    .map((e) => e.name);

  const wanted = projectName?.toLowerCase();
  const preferred =
    (wanted && exes.find((n) => n.toLowerCase() === `${wanted}.host.exe`)) ||
    (wanted && exes.find((n) => n.toLowerCase().startsWith(wanted))) ||
    exes.find((n) => n.toLowerCase().endsWith(".host.exe")) ||
    exes.find((n) => n.toLowerCase() !== "createdump.exe");

  return preferred ? path.join(dir, preferred) : null;
};

/** Recursive variant, since `dotnet publish` nests output under a RID folder. */
export const findWindowsExecutableRecursive = (
  root: string,
  projectName?: string,
): string | null => {
  const direct = findWindowsExecutable(root, projectName);
  if (direct) return direct;
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findWindowsExecutableRecursive(path.join(root, entry.name), projectName);
    if (found) return found;
  }
  return null;
};

export interface ExtractedArchive {
  dir: string;
  release: () => void;
}

/**
 * Unpacks a `.zip` to a temporary directory and returns a release function.
 *
 * A Windows artifact is a zip, so anything inspecting one has to open it first —
 * there is no signature on the archive itself, only on the `.exe` inside. Node
 * ships no unzip, so shell out to whatever the platform already has, matching
 * how the rest of this module uses `hdiutil`.
 */
export const extractArchive = (zipPath: string): ExtractedArchive => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-zip-"));
  try {
    if (process.platform === "win32") {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path "${zipPath}" -DestinationPath "${dir}" -Force`,
        ],
        { stdio: "pipe" },
      );
    } else {
      execFileSync("unzip", ["-q", "-o", zipPath, "-d", dir], { stdio: "pipe" });
    }
  } catch (error) {
    fs.removeSync(dir);
    throw error;
  }
  return { dir, release: () => fs.removeSync(dir) };
};

export interface MountedImage {
  mountPoint: string;
  release: () => void;
}

/**
 * Mounts a `.dmg` read-only and returns a release function. Callers that need
 * the contents to outlive the mount should copy them out first — the mount is
 * read-only and disappears on release.
 */
export const mountDiskImage = (dmgPath: string): MountedImage => {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-dmg-mount-"));
  execFileSync(
    "hdiutil",
    ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-quiet"],
    { stdio: "pipe" },
  );
  return {
    mountPoint,
    release: () => {
      try {
        execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "pipe" });
      } catch {
        // Best effort — a busy image will be reclaimed when the runner exits.
      }
      fs.removeSync(mountPoint);
    },
  };
};
