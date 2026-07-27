import path from "node:path";
import { execFileSync } from "node:child_process";
import { dim, footer, row, STEP_LABEL_WIDTH, value } from "./theme.js";
import { formatExecError } from "./signing.js";

/**
 * Notarization credentials, resolved from the environment.
 *
 * Two shapes are supported, mirroring `notarytool`:
 * - a stored keychain profile (`xcrun notarytool store-credentials`), which is
 *   the recommended local setup because no secret lands in the environment;
 * - an explicit Apple ID + team + app-specific password, which is what CI
 *   secrets can provide.
 */
export type NotaryCredentials =
  | { mode: "profile"; profile: string }
  | { mode: "apple-id"; appleId: string; teamId: string; password: string };

export type NotarizeResult =
  | { status: "skipped"; reason: string }
  | { status: "ok" }
  | { status: "failed"; reason: string };

export interface NotarizeOptions {
  verbose: boolean;
  log: (message: string) => void;
  warn: (message: string) => void;
}

export const resolveNotaryCredentials = (): NotaryCredentials | null => {
  const profile = process.env.VIDRA_NOTARY_PROFILE?.trim();
  if (profile) return { mode: "profile", profile };

  const appleId = process.env.VIDRA_APPLE_ID?.trim();
  const teamId = process.env.VIDRA_TEAM_ID?.trim();
  const password = process.env.VIDRA_APP_PASSWORD?.trim();
  if (appleId && teamId && password) {
    return { mode: "apple-id", appleId, teamId, password };
  }

  return null;
};

/** The credential flags for a `notarytool` invocation. Kept separate so tests can assert them without a real submission. */
export const notaryCredentialArgs = (creds: NotaryCredentials): string[] =>
  creds.mode === "profile"
    ? ["--keychain-profile", creds.profile]
    : [
        "--apple-id",
        creds.appleId,
        "--team-id",
        creds.teamId,
        "--password",
        creds.password,
      ];

/**
 * Submit an artifact to Apple's notary service, wait for the verdict, and staple
 * the resulting ticket so the app validates offline.
 *
 * Notarization is *opt-in by credentials*: with none configured this is a clean
 * no-op, so local and CI builds stay fast and offline-friendly instead of
 * suddenly blocking for minutes on a network round-trip.
 */
export const notarizeAndStaple = (
  artifactPath: string,
  options: NotarizeOptions,
): NotarizeResult => {
  if (process.platform !== "darwin") {
    return { status: "skipped", reason: "not macOS" };
  }

  const creds = resolveNotaryCredentials();
  if (!creds) {
    return {
      status: "skipped",
      reason:
        "no notary credentials (set VIDRA_NOTARY_PROFILE, or VIDRA_APPLE_ID + VIDRA_TEAM_ID + VIDRA_APP_PASSWORD)",
    };
  }

  const label = path.basename(artifactPath);
  let submitOutput: string;
  try {
    submitOutput = execFileSync(
      "xcrun",
      ["notarytool", "submit", artifactPath, ...notaryCredentialArgs(creds), "--wait"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
  } catch (error) {
    const output = formatExecError(error);
    reportNotaryFailure(output, creds, options);
    return { status: "failed", reason: output };
  }

  if (options.verbose) options.log(dim(submitOutput.trim()));

  // `notarytool --wait` exits 0 even when the verdict is Invalid, so the status
  // line is the real signal — without this check a rejected build would sail
  // through and only fail on a user's machine.
  if (!/status:\s*Accepted/i.test(submitOutput)) {
    reportNotaryFailure(submitOutput, creds, options);
    return { status: "failed", reason: "notary service did not accept the submission" };
  }

  try {
    execFileSync("xcrun", ["stapler", "staple", artifactPath], {
      stdio: options.verbose ? "inherit" : "pipe",
    });
  } catch (error) {
    const output = formatExecError(error);
    options.warn(
      row({
        glyph: "error",
        label: "staple",
        labelWidth: STEP_LABEL_WIDTH,
        detail: dim("notarized, but the ticket could not be stapled"),
      }),
    );
    options.warn(dim(output));
    return { status: "failed", reason: output };
  }

  options.log(
    row({
      glyph: "done",
      label: "notarize",
      labelWidth: STEP_LABEL_WIDTH,
      detail: `${value(label)} ${dim("accepted · ticket stapled")}`,
    }),
  );
  return { status: "ok" };
};

/**
 * A rejection's reason lives only in the submission log, so fetch and print it —
 * otherwise "Invalid" is undebuggable.
 */
const reportNotaryFailure = (
  output: string,
  creds: NotaryCredentials,
  options: NotarizeOptions,
): void => {
  options.warn(
    row({
      glyph: "error",
      label: "notarize",
      labelWidth: STEP_LABEL_WIDTH,
      detail: dim("the notary service rejected this build"),
    }),
  );
  options.warn(dim(output.trim()));

  const submissionId = parseSubmissionId(output);
  if (!submissionId) return;

  try {
    const log = execFileSync(
      "xcrun",
      ["notarytool", "log", submissionId, ...notaryCredentialArgs(creds)],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    options.warn(footer(dim("notary log:")));
    options.warn(dim(log.trim()));
  } catch {
    options.warn(
      footer(
        dim(`fetch the details with: xcrun notarytool log ${submissionId} ...`),
      ),
    );
  }
};

export const parseSubmissionId = (output: string): string | null =>
  output.match(/\bid:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
