import fs from "fs-extra";
import path from "node:path";

/**
 * An app's version, resolved once and used everywhere it has to appear.
 *
 * A Vidra app has one version, and it lives in the app's `package.json` —
 * the file `npm version patch` already knows how to bump. Everything else is
 * derived from it at build time rather than maintained in parallel:
 *
 * - `semver` — the full string, including any prerelease. Names the artifact,
 *   and is what an updater compares.
 * - `display` — `major.minor.patch`, stamped into `ApplicationDisplayVersion`.
 *   Apple's `CFBundleShortVersionString` must be one to three integers, so a
 *   prerelease suffix cannot go here; it would make the bundle unshippable.
 * - `build` — `ApplicationVersion`, an integer that must increase with every
 *   release (`CFBundleVersion` on macOS, the file version on Windows).
 *   Derived from the semver rather than hand-maintained, so there is nothing
 *   extra to remember to bump.
 */
export interface AppVersion {
  semver: string;
  display: string;
  build: number;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

export class VersionError extends Error {}

/**
 * `major * 10000 + minor * 100 + patch`, so 1.2.3 → 10203 and any version
 * ordered after another produces a larger number, as long as minor and patch
 * stay below 100. That ceiling is the trade for a build number that needs no
 * state: a CI counter would be monotonic without limits but makes the same
 * commit build differently every time, which is worse for a desktop app that
 * ships the number to users.
 *
 * `VIDRA_BUILD_NUMBER` overrides it for anyone who has outgrown that.
 */
export const buildNumberFor = (
  major: number,
  minor: number,
  patch: number,
): number => major * 10000 + minor * 100 + patch;

const SEGMENT_CEILING = 100;

export const parseAppVersion = (raw: string, source: string): AppVersion => {
  const match = SEMVER.exec(raw.trim());
  if (!match) {
    throw new VersionError(
      `${source}: "${raw}" is not a valid version — expected semver like 1.2.3`,
    );
  }
  const [, major, minor, patch] = match.map((v) => v) as string[];
  const [maj, min, pat] = [Number(major), Number(minor), Number(patch)];

  const override = process.env.VIDRA_BUILD_NUMBER;
  if (override !== undefined && !/^\d+$/.test(override)) {
    throw new VersionError(
      `VIDRA_BUILD_NUMBER: "${override}" is not a positive integer`,
    );
  }

  // Only meaningful while the build number is derived: an explicit override is
  // the documented way out of the ceiling, so enforcing it after one is set
  // would reject exactly the projects the override exists for.
  if (override === undefined && (min >= SEGMENT_CEILING || pat >= SEGMENT_CEILING)) {
    throw new VersionError(
      `${source}: "${raw}" — minor and patch must stay below ${SEGMENT_CEILING} so the build number keeps increasing; set VIDRA_BUILD_NUMBER to override`,
    );
  }

  return {
    semver: raw.trim(),
    display: `${maj}.${min}.${pat}`,
    build: override !== undefined ? Number(override) : buildNumberFor(maj, min, pat),
  };
};

/**
 * Reads the app's version from its `package.json`. Apps scaffolded before
 * versioning existed have no `version` field, and their csproj still carries a
 * hardcoded one — fall back to it rather than failing a build that used to
 * work, and say where the number came from.
 */
export const resolveAppVersion = (
  projectRoot: string,
  csprojPath: string,
): AppVersion & { source: "package.json" | "csproj" } => {
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = fs.readJsonSync(pkgPath, { throws: false }) as
      | { version?: string }
      | undefined;
    if (pkg?.version) {
      return { ...parseAppVersion(pkg.version, "package.json"), source: "package.json" };
    }
  }

  const csproj = fs.readFileSync(csprojPath, "utf-8");
  const fromCsproj = csproj.match(
    /<ApplicationDisplayVersion>([^<]+)<\/ApplicationDisplayVersion>/,
  )?.[1];
  if (!fromCsproj) {
    throw new VersionError(
      'no version found — add a "version" to the app\'s package.json (npm version patch)',
    );
  }
  return { ...parseAppVersion(fromCsproj, "csproj"), source: "csproj" };
};

/**
 * MSBuild properties that put the resolved version into the built artifact.
 * Passed on the command line rather than written into the csproj so the file
 * keeps a sensible default for a plain `dotnet build`, and `package.json`
 * stays the thing you edit.
 */
export const versionPublishArgs = (version: AppVersion): string[] => [
  `-p:ApplicationDisplayVersion=${version.display}`,
  `-p:ApplicationVersion=${version.build}`,
];

/**
 * The lenient read, for everywhere that merely wants to *show* a version.
 * `vidra dev` must not refuse to start because an app has no version yet —
 * nothing is being shipped. Only `vidra build`, which stamps the number into an
 * artifact someone may later update from, insists on a real one.
 */
export const resolveAppVersionOrDefault = (
  projectRoot: string,
  csprojPath: string,
  fallback = "0.1.0",
): string => {
  try {
    return resolveAppVersion(projectRoot, csprojPath).semver;
  } catch {
    return fallback;
  }
};
