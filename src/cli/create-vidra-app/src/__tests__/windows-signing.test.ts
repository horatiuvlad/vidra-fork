import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  resolveWindowsSigningConfig,
  buildSignToolArgs,
  signWindowsBinariesIfPossible,
  verifyWindowsSignature,
  findPrimaryExecutable,
  timestampUrl,
  DEFAULT_TIMESTAMP_URL,
} = await import("../windows-signing.js");

const CERT_ENV = [
  "VIDRA_WINDOWS_CERT_THUMBPRINT",
  "VIDRA_WINDOWS_CERT_PATH",
  "VIDRA_WINDOWS_CERT_PASSWORD",
  "VIDRA_WINDOWS_TIMESTAMP_URL",
  "VIDRA_SIGNTOOL_PATH",
];

const clearEnv = (): void => {
  for (const key of CERT_ENV) delete process.env[key];
};

describe("resolveWindowsSigningConfig", () => {
  beforeEach(() => {
    clearEnv();
  });

  it("returns null when nothing is configured", () => {
    expect(resolveWindowsSigningConfig()).toBeNull();
  });

  it("reads a pfx path and password", () => {
    process.env.VIDRA_WINDOWS_CERT_PATH = "C:\\certs\\vidra.pfx";
    process.env.VIDRA_WINDOWS_CERT_PASSWORD = "hunter2";
    expect(resolveWindowsSigningConfig()).toEqual({
      mode: "pfx",
      pfxPath: "C:\\certs\\vidra.pfx",
      password: "hunter2",
    });
  });

  it("allows a pfx without a password", () => {
    process.env.VIDRA_WINDOWS_CERT_PATH = "C:\\certs\\vidra.pfx";
    expect(resolveWindowsSigningConfig()).toMatchObject({ password: null });
  });

  // A thumbprint points at a cert already in the store — typically a hardware
  // token, which can't be exported to a file — so it takes precedence.
  it("prefers a store thumbprint over a pfx", () => {
    process.env.VIDRA_WINDOWS_CERT_THUMBPRINT = "ABCD1234";
    process.env.VIDRA_WINDOWS_CERT_PATH = "C:\\certs\\vidra.pfx";
    expect(resolveWindowsSigningConfig()).toEqual({
      mode: "thumbprint",
      thumbprint: "ABCD1234",
    });
  });
});

describe("buildSignToolArgs", () => {
  beforeEach(() => {
    clearEnv();
  });

  // Without /tr the signature dies with the certificate; this is the assertion
  // that keeps timestamping from being dropped.
  it("always requests SHA-256 and a trusted timestamp", () => {
    const args = buildSignToolArgs(
      { mode: "thumbprint", thumbprint: "ABCD" },
      ["app.exe"],
    );
    expect(args.slice(0, 7)).toEqual([
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      DEFAULT_TIMESTAMP_URL,
      "/td",
      "SHA256",
    ]);
    expect(args).toEqual(expect.arrayContaining(["/sha1", "ABCD", "app.exe"]));
  });

  it("passes the pfx path and password", () => {
    const args = buildSignToolArgs(
      { mode: "pfx", pfxPath: "cert.pfx", password: "pw" },
      ["app.exe"],
    );
    expect(args).toEqual(expect.arrayContaining(["/f", "cert.pfx", "/p", "pw"]));
  });

  it("omits /p when there is no password", () => {
    const args = buildSignToolArgs(
      { mode: "pfx", pfxPath: "cert.pfx", password: null },
      ["app.exe"],
    );
    expect(args).not.toContain("/p");
  });

  it("honours a custom timestamp url", () => {
    process.env.VIDRA_WINDOWS_TIMESTAMP_URL = "http://ts.example.com";
    expect(timestampUrl()).toBe("http://ts.example.com");
    const args = buildSignToolArgs(
      { mode: "thumbprint", thumbprint: "A" },
      ["app.exe"],
    );
    expect(args).toContain("http://ts.example.com");
  });
});

describe("signWindowsBinariesIfPossible", () => {
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

  it("is a no-op off Windows", () => {
    setPlatform("darwin");
    expect(
      signWindowsBinariesIfPossible(["app.exe"], { verbose: false, log, warn }),
    ).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // Unsigned output is a warning, not a build failure — shipping unsigned is
  // still shipping.
  it("skips without a certificate and does not fail the build", () => {
    setPlatform("win32");
    expect(
      signWindowsBinariesIfPossible(["app.exe"], { verbose: false, log, warn }),
    ).toBe(false);
    expect(log).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("signs with the configured certificate", () => {
    setPlatform("win32");
    process.env.VIDRA_SIGNTOOL_PATH = "";
    process.env.VIDRA_WINDOWS_CERT_THUMBPRINT = "ABCD";
    execFileSyncMock.mockReturnValue("");

    const ok = signWindowsBinariesIfPossible(["app.exe"], {
      verbose: false,
      log,
      warn,
    });

    expect(ok).toBe(true);
    const signCall = execFileSyncMock.mock.calls.find((c) =>
      (c[1] as string[])?.[0] === "sign",
    );
    expect(signCall).toBeDefined();
    expect(signCall?.[1]).toEqual(expect.arrayContaining(["/sha1", "ABCD", "app.exe"]));
  });

  it("warns but does not throw when signing fails", () => {
    setPlatform("win32");
    process.env.VIDRA_WINDOWS_CERT_THUMBPRINT = "ABCD";
    let call = 0;
    execFileSyncMock.mockImplementation(() => {
      // First call is the signtool discovery probe; the sign itself fails.
      if (++call === 1) return "";
      throw Object.assign(new Error("nope"), { stderr: "cert not found" });
    });

    const ok = signWindowsBinariesIfPossible(["app.exe"], {
      verbose: false,
      log,
      warn,
    });

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("verifyWindowsSignature", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    clearEnv();
  });

  it("verifies with /pa", () => {
    execFileSyncMock.mockReturnValue("Successfully verified");
    const result = verifyWindowsSignature("app.exe");
    expect(result.ok).toBe(true);
    const verifyCall = execFileSyncMock.mock.calls.find((c) =>
      (c[1] as string[])?.[0] === "verify",
    );
    expect(verifyCall?.[1]).toEqual(["verify", "/pa", "/v", "app.exe"]);
  });
});

describe("findPrimaryExecutable", () => {
  it("prefers <Project>.Host.exe over other executables", () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-publish-"));
    try {
      nodeFs.writeFileSync(path.join(dir, "createdump.exe"), "");
      nodeFs.writeFileSync(path.join(dir, "VidraSmoke.Host.exe"), "");
      expect(findPrimaryExecutable(dir, "VidraSmoke")).toBe(
        path.join(dir, "VidraSmoke.Host.exe"),
      );
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the directory has no executables", () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-publish-"));
    try {
      expect(findPrimaryExecutable(dir, "VidraSmoke")).toBeNull();
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the directory does not exist", () => {
    expect(findPrimaryExecutable("/no/such/dir", "X")).toBeNull();
  });
});

describe("verifyWindowsSignature — untrusted roots", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    clearEnv();
  });

  // A self-signed certificate signs perfectly well; it just doesn't chain to a
  // CA. `signtool verify /pa` conflates "is it signed and intact" with "is the
  // issuer trusted", so an untrusted root must not read as an unsigned binary —
  // that would fail CI for a correctly signed build.
  it("treats CERT_E_UNTRUSTEDROOT as signed-but-untrusted, not unsigned", () => {
    // The first call is signtool discovery (`signtool /?`); only the verify
    // itself must fail, otherwise we'd be testing "signtool not found".
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] !== "verify") return "";
      throw Object.assign(new Error("x"), {
        stderr:
          "SignTool Error: A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider. (0x800B0109)",
      });
    });
    const result = verifyWindowsSignature("app.exe");
    expect(result.ok).toBe(true);
    expect(result.untrustedRoot).toBe(true);
  });

  it("still reports a genuinely unsigned binary as a failure", () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] !== "verify") return "";
      throw Object.assign(new Error("x"), {
        stderr: "SignTool Error: No signature found. (0x800B0100)",
      });
    });
    const result = verifyWindowsSignature("app.exe");
    expect(result.ok).toBe(false);
    expect(result.untrustedRoot).toBe(false);
  });
});
