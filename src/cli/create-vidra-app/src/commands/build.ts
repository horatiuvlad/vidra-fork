import path from "node:path";
import fs from "fs-extra";
import { execSync } from "node:child_process";
import { parseArgs } from "../utils.js";
import { formatBuildError, formatProcessError } from "../exec.js";
import { resolveAppVersion, versionPublishArgs } from "../version.js";
import {
  readUpdateConfig,
  resolveFeeds,
  stampedConfigFor,
  stampUpdateConfig,
  UPDATE_CONFIG_FILE,
  type ResolvedFeeds,
  type UpdateConfig,
} from "../update-config.js";
import { FeedUriError, manifestUrlFor } from "../feed-uri.js";
import { rejectUnknownFlags } from "../help.js";
import { BUILD } from "./specs.js";
import { distLayout, type DistLayout } from "../dist-layout.js";
import { runWebBundle } from "./bundle.js";
import {
  extractPackedApp,
  NativeUpdateError,
  resolveNativeUpdateSettings,
  runNativeUpdate,
  type NativeUpdateOutcome,
  type NativeUpdateSettings,
} from "../native-update.js";
import { resolveVpk } from "../velopack.js";
import {
  detectPlatform,
  detectProject,
  type ProjectInfo,
} from "../project.js";
import type { BuildTarget } from "../targets/types.js";
import { macosTarget } from "../targets/macos.js";
import {
  assessGatekeeper,
  hasDeveloperIdIdentity,
  inspectMacHardening,
  signMacAppBundleIfPossible,
  signMacDmgIfPossible,
  verifyMacSignature,
} from "../signing.js";
import { notarizeAndStaple, resolveNotaryCredentials } from "../notarize.js";
import {
  findPrimaryExecutable,
  resolveWindowsSigningConfig,
  signWindowsBinariesIfPossible,
  verifyWindowsSignature,
} from "../windows-signing.js";
import { windowsTarget } from "../targets/windows.js";
import {
  ensureMauiWorkload,
  looksLikeMissingWorkload,
  looksLikeMissingXcode,
  printWorkloadHint,
  printXcodeHint,
} from "../doctor.js";
import {
  dim,
  footer,
  header,
  kv,
  lime,
  planBadge,
  row,
  STEP_LABEL_WIDTH as LABEL_WIDTH,
  value,
} from "../theme.js";

const TARGETS: Record<string, BuildTarget> = {
  macos: macosTarget,
  windows: windowsTarget,
};

const packageLabel = (target: BuildTarget): string =>
  target.name === "macos" ? "package DMG" : "package ZIP";

const artifactName = (project: ProjectInfo, target: BuildTarget): string =>
  `${project.projectName}-${project.displayVersion}-${target.name}.${
    target.name === "macos" ? "dmg" : "zip"
  }`;

/**
 * What a build is asked to produce.
 *
 * `all` is the default and means "everything this app is configured for", the
 * same rule the rest of the surface follows: config decides what is on, and a
 * flag only ever asks for *less*. `--web` exists because shipping a UI fix must
 * not cost a compile; `--app` because a release job on each platform should not
 * republish a platform-agnostic bundle twice.
 */
export type BuildMode = "all" | "app" | "web";

export const parseBuildMode = (args: Record<string, unknown>): BuildMode =>
  args.app ? "app" : args.web ? "web" : "all";

/**
 * The channel this artifact belongs to, or null for the default one.
 *
 * A build input rather than configuration, because the same commit must be able
 * to produce a stable artifact and a beta one. `package.json` describes the app;
 * the stamped `vidra-updates.json` describes this build of it.
 */
export const resolveChannel = (
  flag: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const raw = typeof flag === "string" ? flag : env.VIDRA_CHANNEL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
};

export const buildCommand = async (argv: string[]): Promise<void> => {
  const args = parseArgs(["_", "_", ...argv]);
  if (rejectUnknownFlags(BUILD, args)) return process.exit(1);

  const verbose = !!args["verbose"];
  const plan = !!args["plan"] || !!args["dry-run"];
  const mode = parseBuildMode(args);
  const channel = resolveChannel(args["channel"]);

  const project = detectProject(process.cwd());
  const updateConfig = readUpdateConfig(project.root);

  let feeds: ResolvedFeeds;
  try {
    feeds = resolveFeeds(updateConfig, channel);
  } catch (error) {
    if (!(error instanceof FeedUriError)) throw error;
    console.error();
    console.error(
      row({ glyph: "error", label: "feed", labelWidth: LABEL_WIDTH, detail: dim(error.message) }),
    );
    console.error();
    return process.exit(1);
  }

  const layout = distLayout(project.root, feeds, channel);

  // `--web` needs no platform, no compiler and no MAUI workload, so it must not
  // fail on a machine that has none of them. Resolving a target at all is the
  // app half's business.
  if (mode === "web") {
    if (!feeds.web || !layout.web) {
      console.error();
      console.error(
        row({
          glyph: "error",
          label: "no web feed",
          labelWidth: LABEL_WIDTH,
          detail: dim(
            "nothing to publish — set vidra.updates.feed (npx vidra updates init --feed <url>)",
          ),
        }),
      );
      console.error();
      return process.exit(1);
    }

    console.log();
    console.log(
      header("build", `web bundle${channel ? ` \u00b7 ${channel}` : ""}${plan ? " \u00b7 plan" : ""}`),
    );
    console.log(kv("project", project.projectName));
    console.log(kv("version", project.displayVersion));
    console.log();

    if (plan) {
      printWebPlan(project, layout.web, feeds);
      console.log();
      console.log(
        footer(`${dim("nothing has run. re-run without")} ${lime("--plan")} ${dim("to apply.")}`),
      );
      console.log();
      return;
    }

    await stepWebBundle(project, layout.web, feeds, typeof args["sign"] === "string" ? args["sign"] : undefined);
    console.log();
    console.log(footer(`${dim("done \u2014")} ${value(path.relative(project.root, layout.web))}`));
    console.log();
    return;
  }

  const targetName = (args["target"] as string) || detectPlatform();
  const target = TARGETS[targetName];
  if (!target) {
    const supported = Object.keys(TARGETS).join(", ");
    console.error();
    console.error(
      row({
        glyph: "error",
        detail: dim(`unsupported target: ${targetName} \u2014 supported: ${supported}`),
      }),
    );
    process.exit(1);
  }

  console.log();
  console.log(
    header(
      "build",
      `${target.name} \u00b7 Release${channel ? ` \u00b7 ${channel}` : ""}${plan ? " \u00b7 plan" : ""}`,
    ),
  );
  console.log(kv("project", project.projectName));
  console.log(kv("target", target.framework));
  console.log();

  const nativeSettings: NativeUpdateSettings | null =
    feeds.app && layout.app
      ? resolveNativeUpdateSettings({
          feed: feeds.app,
          releaseDir: layout.app,
          csprojPath: project.csprojPath,
          projectName: project.projectName,
          version: project.displayVersion,
        })
      : null;

  // The plan view prints every step and artifact name without running anything
  // \u2014 the dim footer says how to commit. `--execute` is the default; `--plan`
  // (alias `--dry-run`) opts into the preview.
  if (plan) {
    printBuildPlan(project, target, layout, feeds, nativeSettings, mode);
    console.log();
    console.log(
      footer(`${dim("nothing has run. re-run without")} ${lime("--plan")} ${dim("to apply.")}`),
    );
    console.log();
    return;
  }

  // Verify the MAUI workload before the (slow) UI build so we fail fast.
  if (!(await ensureMauiWorkload({ csprojPath: project.csprojPath }))) {
    process.exit(1);
  }

  stepBuildUi(project, verbose);
  stepCopyAssets(project);
  stepStampUpdateConfig(project, updateConfig, feeds, layout);
  const publishDir = stepDotnetPublish(project, target, verbose);

  const bundlePath = target.findBundle(publishDir, project.projectName);
  if (!bundlePath) {
    console.error(
      row({
        glyph: "error",
        detail: dim(`could not find build artifact in ${publishDir}`),
      }),
    );
    process.exit(1);
  }

  const io = { verbose, log: console.log, warn: console.warn };
  const entitlements = target.name === "macos" ? entitlementsPath(project) : null;

  if (target.name === "macos") {
    signMacAppBundleIfPossible(bundlePath, {
      ...io,
      purpose: "distribution",
      entitlements,
    });
    reportMacVerification(bundlePath, entitlements);
  }

  // Windows binaries must be signed *before* zipping \u2014 the signature travels
  // inside the archive, and a zip itself can't carry one.
  let signedWindowsExe: string | null = null;
  if (target.name === "windows") {
    signedWindowsExe = findPrimaryExecutable(bundlePath, project.projectName);
    if (signedWindowsExe && signWindowsBinariesIfPossible([signedWindowsExe], io)) {
      const verified = verifyWindowsSignature(signedWindowsExe);
      console.log(
        row({
          glyph: verified.ok ? "done" : "manual",
          label: "verify sig",
          labelWidth: LABEL_WIDTH,
          detail: verified.untrustedRoot
            ? dim("signature intact; chain not trusted (expected for a self-signed certificate)")
            : verified.ok
              ? dim("authenticode signature verified and trusted")
              : dim("signature did not verify \u2014 see signtool output"),
        }),
      );
    }
  }

  // With native updates on, Velopack produces the release *and* the artifact:
  // the DMG wraps the packed `.app`, and the Windows ZIP is the one `vpk` wrote
  // rather than one we roll by hand. Both keep today's artifact name, so
  // nothing downstream of `vidra build` has to know which path ran.
  //
  // Unless this version is already published, in which case nothing was packed
  // and the build falls back to packaging what it just built. That path is the
  // ordinary one for a rebuild at an unchanged version, and it is the only
  // honest answer: the artifact has to contain the code from *this* publish.
  const packed = nativeSettings
    ? stepNativeUpdate(project, target, bundlePath, entitlements, nativeSettings, io)
    : null;
  const released = packed?.status === "packed" ? packed : null;

  const outputPath =
    released && target.name === "windows"
      ? stepPublishVelopackWindowsArtifacts(project, layout, target, released)
      : await stepPackage(
          project,
          layout,
          target,
          released ? extractPackedApp(released.outputs.portableZip!) : bundlePath,
        );

  if (target.name === "macos") {
    signMacDmgIfPossible(outputPath, io);
    const notarized = notarizeAndStaple(outputPath, io);
    if (notarized.status === "skipped") {
      console.log(
        row({
          glyph: "skip",
          label: "notarize",
          labelWidth: LABEL_WIDTH,
          detail: dim(notarized.reason),
        }),
      );
    } else if (notarized.status === "failed") {
      process.exit(1);
    }
    reportGatekeeper(outputPath);
  }

  // The web half last, and only in the default mode. It reuses the `ui/dist`
  // the app build already produced rather than running Vite twice.
  if (mode === "all" && feeds.web && layout.web) {
    console.log();
    await stepWebBundle(project, layout.web, feeds, typeof args["sign"] === "string" ? args["sign"] : undefined);
  }

  console.log();
  console.log(
    footer(
      `${dim("done \u2014")} ${value(path.relative(project.root, outputPath))}`,
    ),
  );
  console.log();
};

/**
 * Publishes the web bundle into its feed directory.
 *
 * `mergeFrom` is not a flag any more: the live index is wherever `package.json`
 * says this app publishes, so the "forgot `--merge-from` on a clean CI checkout
 * and published an index containing only the newest entry" failure cannot
 * happen. Passing it explicitly is what a publisher would have had to remember.
 */
const stepWebBundle = async (
  project: ProjectInfo,
  outDir: string,
  feeds: ResolvedFeeds,
  sign: string | undefined,
): Promise<void> => {
  await runWebBundle(project, {
    outDir,
    mergeFrom: feeds.web ? manifestUrlFor(feeds.web.base) : undefined,
    sign,
    // In `all` mode the app half already ran Vite into the same `ui/dist`.
    skipBuild: fs.existsSync(path.join(project.uiDir, "dist", "index.html")),
  });
};

const printWebPlan = (project: ProjectInfo, outDir: string, feeds: ResolvedFeeds): void => {
  console.log(
    row({
      glyph: "done",
      label: "build UI",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("vite \u2192")} ${value("ui/dist")}`,
    }),
  );
  console.log(
    row({
      glyph: "active",
      label: "merge feed",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("\u2190")} ${value(manifestUrlFor(feeds.web!.base))}`,
    }),
  );
  console.log(
    row({
      glyph: "active",
      label: "pack bundle",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("\u2192")} ${value(path.relative(project.root, outDir))}`,
    }),
  );
};

/**
 * The template ships `Entitlements.plist` next to the host csproj. It enables
 * the hardened runtime (required for notarization) while keeping .NET's JIT
 * alive, so its absence is a meaningful signal rather than a silent default.
 */
const entitlementsPath = (project: ProjectInfo): string | null => {
  const candidate = path.join(project.hostDir, "Entitlements.plist");
  return fs.existsSync(candidate) ? candidate : null;
};

const reportMacVerification = (
  bundlePath: string,
  entitlements: string | null,
): void => {
  const verified = verifyMacSignature(bundlePath);
  console.log(
    row({
      glyph: verified.ok ? "done" : "error",
      label: "verify sig",
      labelWidth: LABEL_WIDTH,
      detail: verified.ok
        ? dim("codesign --verify --strict passed")
        : dim("codesign --verify --strict FAILED"),
    }),
  );
  if (!verified.ok) console.error(dim(verified.output));

  // Read back what actually landed in the signature. Asking for the hardened
  // runtime is not the same as getting it, and the failure mode is nasty: the
  // app signs, notarizes, then dies the moment the .NET JIT runs. Only
  // meaningful when we attempted a hardened signature at all.
  if (!entitlements) return;

  const hardening = inspectMacHardening(bundlePath);
  console.log(
    row({
      glyph: hardening.ok ? "done" : "error",
      label: "hardening",
      labelWidth: LABEL_WIDTH,
      detail: hardening.ok
        ? dim("hardened runtime + JIT entitlements embedded")
        : dim(
            !hardening.hardened
              ? "hardened runtime NOT enabled — this cannot be notarized"
              : `missing entitlements: ${hardening.missing.join(", ")} — the app will be killed at launch`,
          ),
    }),
  );
  if (!hardening.ok) console.error(dim(hardening.output.trim()));
};

/**
 * Gatekeeper's verdict on the finished artifact. A rejection here is expected
 * until the build is both Developer ID signed and notarized, so it is reported
 * as guidance rather than treated as a build failure.
 */
const reportGatekeeper = (artifactPath: string): void => {
  const assessment = assessGatekeeper(artifactPath);
  if (assessment.ok) {
    console.log(
      row({
        glyph: "done",
        label: "gatekeeper",
        labelWidth: LABEL_WIDTH,
        detail: dim("spctl accepted \u2014 this will open on other Macs"),
      }),
    );
    return;
  }

  const missing = !hasDeveloperIdIdentity()
    ? "needs a Developer ID Application certificate"
    : !resolveNotaryCredentials()
      ? "needs notarization (set VIDRA_NOTARY_PROFILE or VIDRA_APPLE_ID/VIDRA_TEAM_ID/VIDRA_APP_PASSWORD)"
      : "see the spctl output above";

  console.log(
    row({
      glyph: "manual",
      label: "gatekeeper",
      labelWidth: LABEL_WIDTH,
      detail: dim(`spctl rejected \u2014 ${missing}`),
    }),
  );
};


/** Which tiers this build publishes to, for one-line reporting. */
const tierNames = (feeds: ResolvedFeeds): string[] =>
  [feeds.web ? "web bundle" : null, feeds.app ? "whole app" : null].filter(
    (name): name is string => name !== null,
  );

const printBuildPlan = (
  project: ProjectInfo,
  target: BuildTarget,
  layout: DistLayout,
  feeds: ResolvedFeeds,
  nativeSettings: NativeUpdateSettings | null,
  mode: BuildMode,
): void => {
  console.log(
    row({
      glyph: "done",
      label: "build UI",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("vite \u2192")} ${value("ui/dist")}`,
    }),
  );
  console.log(
    row({
      glyph: "done",
      label: "copy assets",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("\u2192")} ${value("Resources/Raw/wwwroot")}`,
    }),
  );
  const on = tierNames(feeds);
  if (on.length > 0) {
    console.log(
      row({
        glyph: "done",
        label: "stamp updates",
        labelWidth: LABEL_WIDTH,
        detail: `${dim("\u2192")} ${value(`Resources/Raw/${UPDATE_CONFIG_FILE}`)} ${dim(`(${on.join(" + ")})`)}`,
      }),
    );
  }

  console.log(
    row({
      glyph: "done",
      label: "publish .NET",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("Release \u00b7")} ${value(target.framework)}`,
    }),
  );

  if (nativeSettings) {
    const vpk = resolveVpk();
    console.log(
      row({
        glyph: vpk ? "done" : "error",
        label: "vpk pack",
        labelWidth: LABEL_WIDTH,
        detail: vpk
          ? `${value(`${nativeSettings.packId} ${nativeSettings.packVersion}`)} ${dim(
              `\u2192 ${path.relative(project.root, nativeSettings.releaseDir)}`,
            )}`
          : dim("vpk is not installed \u2014 dotnet tool install -g vpk"),
      }),
    );
    console.log(
      row({
        glyph: "active",
        label: "merge feed",
        labelWidth: LABEL_WIDTH,
        detail: `${dim("vpk download \u2190")} ${value(nativeSettings.feedUrl)}`,
      }),
    );
  }

  if (target.name === "macos") {
    const developerId = hasDeveloperIdIdentity();
    console.log(
      row({
        glyph: "done",
        label: "codesign .app",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          developerId
            ? "Developer ID Application \u00b7 hardened runtime"
            : "no Developer ID found \u2014 will fall back to development/ad-hoc",
        ),
      }),
    );
    console.log(
      row({
        glyph: "active",
        label: "package DMG",
        labelWidth: LABEL_WIDTH,
        detail: `${dim("hdiutil UDZO \u2192")} ${value(artifactName(project, target))}`,
      }),
    );
    console.log(
      row({
        glyph: developerId ? "done" : "skip",
        label: "codesign dmg",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          developerId ? "sign the disk image" : "skipped without a Developer ID",
        ),
      }),
    );

    // The notarize row stops being a promise and becomes a real step the moment
    // credentials exist \u2014 the badge is the honest signal of which one it is.
    const creds = resolveNotaryCredentials();
    console.log(
      row({
        glyph: creds ? "active" : "plan",
        label: "notarize",
        labelWidth: LABEL_WIDTH,
        detail: creds
          ? dim("notarytool submit --wait, then staple")
          : `${planBadge()} ${dim("no credentials configured")}`,
      }),
    );
    console.log(
      row({
        glyph: "active",
        label: "gatekeeper",
        labelWidth: LABEL_WIDTH,
        detail: dim("spctl --assess"),
      }),
    );
  } else {
    const winCert = resolveWindowsSigningConfig();
    console.log(
      row({
        glyph: winCert ? "done" : "skip",
        label: "authenticode",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          winCert
            ? `sign the .exe (${winCert.mode})`
            : "no certificate configured \u2014 will ship unsigned",
        ),
      }),
    );
    console.log(
      row({
        glyph: "active",
        label: "package ZIP",
        labelWidth: LABEL_WIDTH,
        detail: nativeSettings
          ? `${dim("vpk's portable zip \u2192")} ${value(artifactName(project, target))}`
          : `${dim("self-contained \u2192")} ${value(artifactName(project, target))}`,
      }),
    );
    if (nativeSettings) {
      console.log(
        row({
          glyph: "active",
          label: "installer",
          labelWidth: LABEL_WIDTH,
          detail: `${dim("\u2192")} ${value(`${project.projectName}-${project.displayVersion}-Setup.exe`)}`,
        }),
      );
    }
  }
};

const stepBuildUi = (project: ProjectInfo, verbose: boolean): void => {
  const start = Date.now();
  try {
    execSync("npm run build", {
      cwd: project.uiDir,
      stdio: verbose ? "inherit" : "pipe",
    });
  } catch (e: unknown) {
    console.error(
      row({
        glyph: "error",
        label: "build UI",
        labelWidth: LABEL_WIDTH,
        detail: dim("vite build failed"),
      }),
    );
    console.error(dim(formatBuildError(e)));
    process.exit(1);
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    row({
      glyph: "done",
      label: "build UI",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("vite \u2192")} ${value("ui/dist")} ${dim(`(${elapsed}s)`)}`,
    }),
  );
};

const stepCopyAssets = (project: ProjectInfo): void => {
  const viteDist = path.join(project.uiDir, "dist");
  if (!fs.existsSync(viteDist)) {
    console.error(
      row({
        glyph: "error",
        label: "copy assets",
        labelWidth: LABEL_WIDTH,
        detail: dim("ui/dist not found — vite build may have failed"),
      }),
    );
    process.exit(1);
  }

  const wwwroot = path.join(project.hostDir, "Resources", "Raw", "wwwroot");
  fs.removeSync(wwwroot);
  fs.copySync(viteDist, wwwroot);

  const fileCount = countFiles(wwwroot);
  console.log(
    row({
      glyph: "done",
      label: "copy assets",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("\u2192")} ${value("Resources/Raw/wwwroot")} ${dim(`(${fileCount} files)`)}`,
    }),
  );
};

/**
 * Stamps the app's `vidra.updates` config into the bundle, so the host can read a
 * feed URL at startup without the developer writing any C#. Runs after the asset
 * copy because it writes into the same `Resources/Raw` directory.
 */
const stepStampUpdateConfig = (
  project: ProjectInfo,
  config: UpdateConfig | null,
  feeds: ResolvedFeeds,
  layout: DistLayout,
): void => {
  const stamped = stampedConfigFor(config, feeds);
  stampUpdateConfig(project.hostDir, stamped);

  if (!stamped) {
    // Silent when there is nothing to say: an app that configured no feed wants
    // no updates, and a build log should not imply a feature is missing.
    return;
  }

  console.log(
    row({
      glyph: "done",
      label: "stamp updates",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("\u2192")} ${value(`Resources/Raw/${UPDATE_CONFIG_FILE}`)} ${dim(
        `(${tierNames(feeds).join(" + ")})`,
      )}`,
    }),
  );

  for (const [name, feed] of [["web", feeds.web], ["app", feeds.app]] as const) {
    if (!feed) continue;
    const dir = name === "web" ? layout.web : layout.app;
    console.log(
      row({
        glyph: "plan",
        label: `${name} feed`,
        labelWidth: LABEL_WIDTH,
        detail: `${value(path.relative(project.root, dir!))} ${dim("\u2192")} ${value(feed.base)}`,
      }),
    );
  }
};

const countFiles = (dir: string): number => {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
};

const stepDotnetPublish = (
  project: ProjectInfo,
  target: BuildTarget,
  verbose: boolean,
): string => {
  const start = Date.now();

  const extraArgs = target.extraPublishArgs ?? "-p:CreatePackage=false";
  // The app's package.json owns the version; stamp it into the bundle so the
  // artifact, its metadata and any future updater all agree on one number.
  const version = resolveAppVersion(project.root, project.csprojPath);
  const versionArgs = versionPublishArgs(version).join(" ");
  try {
    execSync(
      `dotnet publish "${project.csprojPath}" -c Release -f ${target.framework} ${extraArgs} ${versionArgs}`,
      {
        cwd: project.root,
        stdio: verbose ? "inherit" : "pipe",
      },
    );
  } catch (e: unknown) {
    const output = formatBuildError(e);
    console.error(
      row({
        glyph: "error",
        label: "publish .NET",
        labelWidth: LABEL_WIDTH,
        detail: dim("dotnet publish failed"),
      }),
    );
    console.error(dim(output));
    if (looksLikeMissingWorkload(output)) printWorkloadHint();
    else if (looksLikeMissingXcode(output)) printXcodeHint();
    if (!verbose) {
      console.error(footer(dim("re-run with --verbose for the full build log.")));
    }
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    row({
      glyph: "done",
      label: "publish .NET",
      labelWidth: LABEL_WIDTH,
      detail: `${dim("Release \u00b7")} ${value(target.framework)} ${dim(`(${elapsed}s)`)}`,
    }),
  );

  return path.join(project.hostDir, "bin", "Release", target.framework);
};

/**
 * Runs `vpk download` then `vpk pack`, and reports what came out.
 *
 * Everything Velopack needs is something the build already resolved: the signed
 * bundle, the identity, the entitlements, the version out of `package.json`.
 * That is the whole argument for `vpk` being a build step rather than a
 * separate publish command: there is no second place to keep any of it in step.
 */
const stepNativeUpdate = (
  project: ProjectInfo,
  target: BuildTarget,
  packDir: string,
  entitlements: string | null,
  settings: NativeUpdateSettings,
  io: { verbose: boolean; log: (m: string) => void; warn: (m: string) => void },
): NativeUpdateOutcome => {
  const start = Date.now();

  let outcome: NativeUpdateOutcome;
  try {
    outcome = runNativeUpdate({
      projectRoot: project.root,
      settings,
      packDir,
      target: target.name as "macos" | "windows",
      entitlements,
      io,
    });
  } catch (error) {
    if (!(error instanceof NativeUpdateError)) throw error;
    console.error(
      row({
        glyph: "error",
        label: "native update",
        labelWidth: LABEL_WIDTH,
        detail: dim(error.message),
      }),
    );
    if (error.detail) console.error(footer(dim(error.detail)));
    process.exit(1);
  }

  if (outcome.merged === "empty-feed") {
    console.log(
      row({
        glyph: "manual",
        label: "merge feed",
        labelWidth: LABEL_WIDTH,
        detail: dim("nothing downloaded: first release, or the feed is unreachable (see the warning above)"),
      }),
    );
  } else {
    console.log(
      row({
        glyph: "done",
        label: "merge feed",
        labelWidth: LABEL_WIDTH,
        detail: `${dim("vpk download →")} ${value(path.relative(project.root, settings.releaseDir))}`,
      }),
    );
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (outcome.status === "already-released") {
    // Not a failure. `vpk` wrote nothing, the feed is untouched, and the build
    // goes on to package what it just built — so a rebuild at an unchanged
    // version behaves exactly like a build with no native updates at all.
    console.log(
      row({
        glyph: "skip",
        label: "vpk pack",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          `${settings.packVersion} is already in the feed — nothing was released, and the artifact is this build`,
        ),
      }),
    );
    console.log(
      footer(dim(`bump the version to publish a new release: ${value("npm version patch")}`)),
    );
    return outcome;
  }

  console.log(
    row({
      glyph: "done",
      label: "vpk pack",
      labelWidth: LABEL_WIDTH,
      detail: `${value(`${settings.packId} ${settings.packVersion}`)} ${dim(
        `→ ${path.relative(project.root, settings.releaseDir)} (${elapsed}s)`,
      )}`,
    }),
  );

  if (!outcome.outputs.portableZip) {
    console.error(
      row({
        glyph: "error",
        label: "vpk pack",
        labelWidth: LABEL_WIDTH,
        detail: dim(`vpk wrote no portable archive to ${settings.releaseDir}`),
      }),
    );
    process.exit(1);
  }

  return outcome;
};

/**
 * Windows: republish Velopack's own artifacts under the names `vidra build`
 * already promises.
 *
 * The portable zip *is* the self-contained ZIP this target used to roll by
 * hand, so it takes that name. `Setup.exe` is versioned on the way out because
 * `vpk pack` overwrites it in the output directory on every release, so a
 * publisher who packs two versions into one prefix otherwise keeps only the
 * newest installer, which is how "install 1.0.0" once silently installed 1.0.1.
 */
const stepPublishVelopackWindowsArtifacts = (
  project: ProjectInfo,
  layout: DistLayout,
  target: BuildTarget,
  packed: NativeUpdateOutcome,
): string => {
  const outputDir = layout.root;
  fs.ensureDirSync(outputDir);

  const zipPath = path.join(outputDir, artifactName(project, target));
  fs.copySync(packed.outputs.portableZip!, zipPath, { overwrite: true });

  console.log(
    row({
      glyph: "done",
      label: packageLabel(target),
      labelWidth: LABEL_WIDTH,
      detail: `${value(path.basename(zipPath))} ${dim(
        `(${(fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1)} MB, from vpk)`,
      )}`,
    }),
  );

  if (packed.outputs.setupExe) {
    const setupName = `${project.projectName}-${project.displayVersion}-Setup.exe`;
    const setupPath = path.join(outputDir, setupName);
    fs.copySync(packed.outputs.setupExe, setupPath, { overwrite: true });
    console.log(
      row({
        glyph: "done",
        label: "installer",
        labelWidth: LABEL_WIDTH,
        detail: `${value(setupName)} ${dim("the recommended download; updates apply in place")}`,
      }),
    );
  }

  return zipPath;
};

const stepPackage = async (
  project: ProjectInfo,
  layout: DistLayout,
  target: BuildTarget,
  bundlePath: string,
): Promise<string> => {
  const outputDir = layout.root;
  fs.ensureDirSync(outputDir);

  const start = Date.now();
  let outputPath: string;
  try {
    outputPath = await target.package(bundlePath, outputDir, {
      projectName: project.projectName,
      displayVersion: project.displayVersion,
    });
  } catch (e: unknown) {
    console.error(
      row({
        glyph: "error",
        label: packageLabel(target),
        labelWidth: LABEL_WIDTH,
        detail: dim("packaging failed"),
      }),
    );
    console.error(dim(formatProcessError(e)));
    process.exit(1);
  }

  const pkgTime = ((Date.now() - start) / 1000).toFixed(1);
  const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
  console.log(
    row({
      glyph: "done",
      label: packageLabel(target),
      labelWidth: LABEL_WIDTH,
      detail: `${value(path.basename(outputPath))} ${dim(`(${sizeMB} MB, ${pkgTime}s)`)}`,
    }),
  );

  return outputPath;
};
