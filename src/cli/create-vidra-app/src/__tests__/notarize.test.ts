import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

const {
  resolveNotaryCredentials,
  notaryCredentialArgs,
  notarizeAndStaple,
  parseSubmissionId,
} = await import("../notarize.js");

const NOTARY_ENV = [
  "VIDRA_NOTARY_PROFILE",
  "VIDRA_APPLE_ID",
  "VIDRA_TEAM_ID",
  "VIDRA_APP_PASSWORD",
];

const clearEnv = (): void => {
  for (const key of NOTARY_ENV) delete process.env[key];
};

describe("resolveNotaryCredentials", () => {
  beforeEach(() => {
    clearEnv();
  });

  it("returns null when nothing is configured", () => {
    expect(resolveNotaryCredentials()).toBeNull();
  });

  it("reads a keychain profile", () => {
    process.env.VIDRA_NOTARY_PROFILE = " vidra-notary ";
    expect(resolveNotaryCredentials()).toEqual({
      mode: "profile",
      profile: "vidra-notary",
    });
  });

  it("reads an Apple ID triple", () => {
    process.env.VIDRA_APPLE_ID = "dev@example.com";
    process.env.VIDRA_TEAM_ID = "ABCDE12345";
    process.env.VIDRA_APP_PASSWORD = "abcd-efgh-ijkl-mnop";
    expect(resolveNotaryCredentials()).toEqual({
      mode: "apple-id",
      appleId: "dev@example.com",
      teamId: "ABCDE12345",
      password: "abcd-efgh-ijkl-mnop",
    });
  });

  it("ignores an incomplete Apple ID triple", () => {
    process.env.VIDRA_APPLE_ID = "dev@example.com";
    process.env.VIDRA_TEAM_ID = "ABCDE12345";
    expect(resolveNotaryCredentials()).toBeNull();
  });

  // A stored profile keeps the secret out of the environment, so it wins.
  it("prefers a keychain profile over an Apple ID triple", () => {
    process.env.VIDRA_NOTARY_PROFILE = "vidra-notary";
    process.env.VIDRA_APPLE_ID = "dev@example.com";
    process.env.VIDRA_TEAM_ID = "ABCDE12345";
    process.env.VIDRA_APP_PASSWORD = "pw";
    expect(resolveNotaryCredentials()).toMatchObject({ mode: "profile" });
  });
});

describe("notaryCredentialArgs", () => {
  it("maps a profile to --keychain-profile", () => {
    expect(notaryCredentialArgs({ mode: "profile", profile: "p" })).toEqual([
      "--keychain-profile",
      "p",
    ]);
  });

  it("maps an Apple ID to its three flags", () => {
    expect(
      notaryCredentialArgs({
        mode: "apple-id",
        appleId: "a@b.c",
        teamId: "TEAM",
        password: "pw",
      }),
    ).toEqual([
      "--apple-id",
      "a@b.c",
      "--team-id",
      "TEAM",
      "--password",
      "pw",
    ]);
  });
});

describe("parseSubmissionId", () => {
  it("extracts the submission uuid", () => {
    const output = "  id: 8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f\n  status: Invalid";
    expect(parseSubmissionId(output)).toBe("8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f");
  });

  it("returns null when absent", () => {
    expect(parseSubmissionId("no id here")).toBeNull();
  });
});

describe("notarizeAndStaple", () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform): void => {
    Object.defineProperty(process, "platform", { value: p });
  };
  const log = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    execFileSyncMock.mockReset();
    log.mockReset();
    warn.mockReset();
    clearEnv();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("skips on non-darwin platforms", () => {
    setPlatform("linux");
    const result = notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });
    expect(result).toMatchObject({ status: "skipped" });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // Notarization must never become a surprise dependency of a local build.
  it("skips cleanly when no credentials are configured", () => {
    setPlatform("darwin");
    const result = notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });
    expect(result).toMatchObject({ status: "skipped" });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("submits, waits, and staples on acceptance", () => {
    setPlatform("darwin");
    process.env.VIDRA_NOTARY_PROFILE = "vidra-notary";
    execFileSyncMock.mockReturnValue(
      "  id: 8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f\n  status: Accepted\n",
    );

    const result = notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });

    expect(result).toEqual({ status: "ok" });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "xcrun",
      [
        "notarytool",
        "submit",
        "/out/App.dmg",
        "--keychain-profile",
        "vidra-notary",
        "--wait",
      ],
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "xcrun",
      ["stapler", "staple", "/out/App.dmg"],
      expect.any(Object),
    );
  });

  // `notarytool --wait` exits 0 even for a rejected submission, so the status
  // line is the only real signal — this is the regression that would otherwise
  // ship a build that fails on users' machines.
  it("fails when the verdict is not Accepted despite a zero exit code", () => {
    setPlatform("darwin");
    process.env.VIDRA_NOTARY_PROFILE = "vidra-notary";
    execFileSyncMock.mockReturnValue(
      "  id: 8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f\n  status: Invalid\n",
    );

    const result = notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });

    expect(result).toMatchObject({ status: "failed" });
    const stapled = execFileSyncMock.mock.calls.some((c) =>
      (c[1] as string[])?.includes("staple"),
    );
    expect(stapled).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("fetches the notary log when a submission is rejected", () => {
    setPlatform("darwin");
    process.env.VIDRA_NOTARY_PROFILE = "vidra-notary";
    execFileSyncMock.mockReturnValue(
      "  id: 8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f\n  status: Invalid\n",
    );

    notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "xcrun",
      [
        "notarytool",
        "log",
        "8f0e6e2a-1b3c-4d5e-9f70-1a2b3c4d5e6f",
        "--keychain-profile",
        "vidra-notary",
      ],
      expect.any(Object),
    );
  });

  it("reports failure when the submit call itself throws", () => {
    setPlatform("darwin");
    process.env.VIDRA_NOTARY_PROFILE = "vidra-notary";
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { stderr: "network unreachable" });
    });

    const result = notarizeAndStaple("/out/App.dmg", { verbose: false, log, warn });

    expect(result).toMatchObject({ status: "failed" });
    expect(warn).toHaveBeenCalled();
  });
});
