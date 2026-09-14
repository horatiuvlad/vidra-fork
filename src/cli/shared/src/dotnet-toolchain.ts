import { execFileSync } from "node:child_process";
import prompts from "prompts";
import { run } from "./exec.js";
import { dim, fixLine, footer, row, value } from "./theme.js";
import { isInteractive, splitLines } from "./utils.js";

// The .NET toolchain probes (SDK, MAUI workload) and the gate that offers to
// install the workload. Separate from doctor.ts because the scaffolder runs the
// gate too, and doctor.ts reaches the config loader, signing and Velopack.

export const DOTNET = process.platform === "win32" ? "dotnet.exe" : "dotnet";
const MAUI_DOCS =
  "https://learn.microsoft.com/dotnet/maui/get-started/installation";

/** Fix shown whenever a suitable .NET SDK is absent (reused across checks). */
const INSTALL_NET_10_FIX =
  "Install the .NET 10 SDK — https://dotnet.microsoft.com/download";

export type RequirementStatus = "ok" | "missing" | "unknown";

export interface Requirement {
  name: string;
  status: RequirementStatus;
  detail?: string;
  /** Command or URL that resolves a `missing` requirement. */
  fix?: string;
}

/** A 10.x version at the start of a `dotnet --list-sdks` line. */
const NET_10_VERSION = /^10\./;

/** A MAUI workload row in `dotnet workload list`. */
const MAUI_WORKLOAD = /\bmaui\b/i;

/** True when `dotnet --list-sdks` reports at least one 10.x SDK. */
export const hasNet10Sdk = (listSdksOutput: string): boolean =>
  splitLines(listSdksOutput).some((line) => NET_10_VERSION.test(line.trim()));

/** Newest 10.x SDK version string from `dotnet --list-sdks`, if any. */
export const newestNet10Sdk = (listSdksOutput: string): string | undefined =>
  splitLines(listSdksOutput)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((version) => NET_10_VERSION.test(version))
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    )
    .pop();

/** True when `dotnet workload list` output contains a MAUI workload row. */
export const outputMentionsMaui = (workloadListOutput: string): boolean =>
  MAUI_WORKLOAD.test(workloadListOutput);

export const checkDotnetSdk = (): Requirement => {
  const name = ".NET SDK";
  const res = run(DOTNET, ["--list-sdks"]);

  if (!res.found) {
    return {
      name,
      status: "missing",
      detail: "`dotnet` was not found on your PATH",
      fix: INSTALL_NET_10_FIX,
    };
  }
  if (!res.ok && !res.stdout) {
    return { name, status: "unknown", detail: "could not run `dotnet --list-sdks`" };
  }
  if (hasNet10Sdk(res.stdout)) {
    const newest = newestNet10Sdk(res.stdout);
    return { name, status: "ok", detail: newest ? `found ${newest}` : "found 10.x" };
  }
  return {
    name,
    status: "missing",
    detail: "no 10.x SDK installed",
    fix: INSTALL_NET_10_FIX,
  };
};

export const isMauiWorkloadInstalled = (): boolean =>
  outputMentionsMaui(run(DOTNET, ["workload", "list"]).stdout);

// --- Workload gate -----------------------------------------------------------

const installWorkload = (csprojPath?: string): boolean => {
  // `workload restore <csproj>` installs only the workloads the project's
  // target frameworks need (e.g. just maccatalyst on macOS); the umbrella
  // `install maui` is the documented fallback when no project is in scope.
  const args = csprojPath
    ? ["workload", "restore", csprojPath]
    : ["workload", "install", "maui"];

  console.log();
  console.log(
    row({
      glyph: "active",
      detail: `${dim("running")} ${value(`${DOTNET} ${args.join(" ")}`)}`,
    }),
  );
  console.log(
    footer(
      dim("this can download several hundred MB and take a few minutes."),
    ),
  );
  console.log();

  try {
    execFileSync(DOTNET, args, { stdio: "inherit" });
    return true;
  } catch {
    console.error();
    console.error(row({ glyph: "error", label: "workload install failed" }));
    console.error(
      footer(
        dim(
          "if this is a permissions error, your SDK is in a system location and needs elevation:",
        ),
      ),
    );
    console.error(fixLine("sudo dotnet workload install maui"));
    console.error();
    return false;
  }
};

/**
 * Verifies the .NET MAUI workload is available, offering to install it when the
 * session is interactive. Returns true if the workload is present (or was just
 * installed). Callers that require the workload should exit when this is false;
 * the scaffolder calls it advisorily and ignores the result.
 */
export const ensureMauiWorkload = async (opts: {
  csprojPath?: string;
  interactive?: boolean;
} = {}): Promise<boolean> => {
  const dotnet = checkDotnetSdk();
  if (dotnet.status === "missing") {
    console.log();
    console.log(
      row({
        glyph: "error",
        label: dotnet.name,
        detail: dotnet.detail ? dim(dotnet.detail) : undefined,
      }),
    );
    if (dotnet.fix) {
      console.log(fixLine(dotnet.fix));
    }
    return false;
  }
  // SDK present but unverifiable — let the real build surface any error.
  if (dotnet.status === "unknown") return true;

  if (isMauiWorkloadInstalled()) return true;

  console.log();
  console.log(
    row({
      glyph: "error",
      label: ".NET MAUI workload",
      detail: dim("required but not installed"),
    }),
  );

  const interactive = opts.interactive ?? isInteractive();
  if (interactive) {
    let install = false;
    try {
      const res = await prompts({
        type: "confirm",
        name: "install",
        message: "Install the .NET MAUI workload now?",
        initial: true,
      });
      install = Boolean(res.install);
    } catch {
      install = false;
    }
    if (install) {
      if (installWorkload(opts.csprojPath) && isMauiWorkloadInstalled()) {
        console.log(
          row({
            glyph: "done",
            label: ".NET MAUI workload",
            detail: dim("installed"),
          }),
        );
        return true;
      }
      return false;
    }
  }

  console.log(fixLine("dotnet workload install maui", "run:"));
  console.log(fixLine(MAUI_DOCS, "docs:"));
  return false;
};
