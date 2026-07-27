import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileSyncMock = vi.fn();
// Expiry is read via spawnSync (security | openssl). Default to "unreadable",
// which is the same answer a machine with no keychain gives.
const spawnSyncMock = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    spawnSync: spawnSyncMock,
  };
});

const {
  resolveMacCodeSigningIdentity,
  selectMacIdentity,
  listExpiredCodeSigningIdentities,
  signMacAppBundleIfPossible,
  signMacDmgIfPossible,
  verifyMacSignature,
  assessGatekeeper,
  hasDeveloperIdIdentity,
  findNestedMachOPayloads,
} = await import("../signing.js");

const findIdentityOutput = (identities: string[]): string =>
  identities
    .map((name, i) => `  ${i + 1}) ${"A".repeat(40)} "${name}"`)
    .join("\n");

const DEVELOPER_ID = "Developer ID Application: Acme Corp (ZZZZZZZZZZ)";
const APPLE_DEV = "Apple Development: Jane Doe (XXXXXXXXXX)";

describe("resolveMacCodeSigningIdentity", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    delete process.env.VIDRA_MACOS_CODESIGN_KEY;
  });

  it("honours VIDRA_MACOS_CODESIGN_KEY override", () => {
    process.env.VIDRA_MACOS_CODESIGN_KEY = "  Apple Development: Override (ABC) ";
    expect(resolveMacCodeSigningIdentity()).toBe(
      "Apple Development: Override (ABC)",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("prefers 'Apple Development:' for local development", () => {
    execFileSyncMock.mockReturnValue(findIdentityOutput([DEVELOPER_ID, APPLE_DEV]));
    expect(resolveMacCodeSigningIdentity("development")).toBe(APPLE_DEV);
  });

  it("defaults to the development preference when no purpose is given", () => {
    execFileSyncMock.mockReturnValue(findIdentityOutput([DEVELOPER_ID, APPLE_DEV]));
    expect(resolveMacCodeSigningIdentity()).toBe(APPLE_DEV);
  });

  // The distribution flip is the whole point: a development certificate can
  // never be notarized, so shipping must reach for Developer ID first.
  it("prefers 'Developer ID Application:' for distribution", () => {
    execFileSyncMock.mockReturnValue(findIdentityOutput([APPLE_DEV, DEVELOPER_ID]));
    expect(resolveMacCodeSigningIdentity("distribution")).toBe(DEVELOPER_ID);
  });

  it("falls back to a development certificate for distribution when no Developer ID exists", () => {
    execFileSyncMock.mockReturnValue(findIdentityOutput([APPLE_DEV]));
    expect(resolveMacCodeSigningIdentity("distribution")).toBe(APPLE_DEV);
  });

  it("returns null when no suitable identity is present", () => {
    execFileSyncMock.mockReturnValue(
      findIdentityOutput(["Mac Developer: Not Useful"]),
    );
    expect(resolveMacCodeSigningIdentity()).toBeNull();
  });

  it("returns null when the security tool throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not available");
    });
    expect(resolveMacCodeSigningIdentity()).toBeNull();
  });
});

describe("hasDeveloperIdIdentity", () => {
  // Block body on purpose: an arrow that *returns* the mock makes Vitest treat
  // it as a teardown callback and invoke it after the test.
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("is true only when a Developer ID Application certificate exists", () => {
    execFileSyncMock.mockReturnValue(findIdentityOutput([DEVELOPER_ID]));
    expect(hasDeveloperIdIdentity()).toBe(true);
    execFileSyncMock.mockReturnValue(findIdentityOutput([APPLE_DEV]));
    expect(hasDeveloperIdIdentity()).toBe(false);
  });
});

describe("signMacAppBundleIfPossible", () => {
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
    delete process.env.VIDRA_MACOS_CODESIGN_KEY;
  });

  afterEach(() => setPlatform(originalPlatform));

  it("is a no-op on non-darwin platforms", () => {
    setPlatform("linux");
    signMacAppBundleIfPossible("/some/app.app", { verbose: false, log, warn });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("ad-hoc signs when no developer identity is discovered", () => {
    setPlatform("darwin");
    execFileSyncMock.mockReturnValue(
      findIdentityOutput(["Mac Developer: None Useful"]),
    );

    signMacAppBundleIfPossible("/some/app.app", { verbose: false, log, warn });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codesign",
      ["--force", "--timestamp", "--sign", "-", "/some/app.app"],
      expect.any(Object),
    );
    expect(log).toHaveBeenCalled();
  });

  it("codesigns using the resolved identity on darwin", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = "Apple Development: Test";

    signMacAppBundleIfPossible("/some/app.app", { verbose: false, log, warn });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codesign",
      ["--force", "--timestamp", "--sign", "Apple Development: Test", "/some/app.app"],
      expect.any(Object),
    );
    expect(log).toHaveBeenCalled();
  });

  // `--deep` is explicitly unsupported by Apple for submission; regressing to it
  // would produce bundles the notary service rejects.
  it("never passes --deep", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = "Apple Development: Test";
    signMacAppBundleIfPossible("/some/app.app", { verbose: false, log, warn });
    for (const call of execFileSyncMock.mock.calls) {
      expect(call[1]).not.toContain("--deep");
    }
  });

  it("enables the hardened runtime and entitlements for distribution", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = DEVELOPER_ID;
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-ent-"));
    const entitlements = path.join(dir, "Entitlements.plist");
    nodeFs.writeFileSync(entitlements, "<plist/>");

    try {
      signMacAppBundleIfPossible("/some/app.app", {
        verbose: false,
        log,
        warn,
        purpose: "distribution",
        entitlements,
      });

      expect(execFileSyncMock).toHaveBeenCalledWith(
        "codesign",
        [
          "--force",
          "--timestamp",
          "--sign",
          DEVELOPER_ID,
          "--options",
          "runtime",
          "--entitlements",
          entitlements,
          "/some/app.app",
        ],
        expect.any(Object),
      );
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and skips the hardened runtime when entitlements are missing", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = DEVELOPER_ID;

    signMacAppBundleIfPossible("/some/app.app", {
      verbose: false,
      log,
      warn,
      purpose: "distribution",
      entitlements: "/nope/Entitlements.plist",
    });

    expect(warn).toHaveBeenCalled();
    const args = execFileSyncMock.mock.calls.at(-1)?.[1] as string[];
    expect(args).not.toContain("runtime");
  });

  it("warns when a development certificate is used for distribution", () => {
    setPlatform("darwin");
    execFileSyncMock.mockReturnValue(findIdentityOutput([APPLE_DEV]));

    signMacAppBundleIfPossible("/some/app.app", {
      verbose: false,
      log,
      warn,
      purpose: "distribution",
    });

    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.flat().join(" ");
    expect(warned).toMatch(/Developer ID/i);
  });

  it("logs a warning if codesign fails", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = "Apple Development: Test";
    execFileSyncMock.mockImplementation(() => {
      throw new Error("codesign exploded");
    });

    signMacAppBundleIfPossible("/some/app.app", { verbose: false, log, warn });

    expect(warn).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * The keychain is listed *unfiltered*, because `find-identity -v` hides
 * self-signed certificates — which is what CI and anyone without a paid Apple
 * membership signs with. That means expired certificates become visible too, so
 * they have to be excluded by date rather than by the `-v` filter, and named
 * when they are.
 */
describe("expired identities", () => {
  const EXPIRED = "Developer ID Application: Stale Corp (YYYYYYYYYY)";

  // `-v` lists only chain-validating identities; everything else is either
  // self-signed or expired, and only the certificate's date separates them.
  const keychain = (unfiltered: string[], chainValid: string[]) => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      findIdentityOutput(args.includes("-v") ? chainValid : unfiltered),
    );
  };
  const certExpiring = (when: string) => {
    spawnSyncMock.mockImplementation(((cmd: string) =>
      cmd === "security"
        ? { status: 0, stdout: "-----BEGIN CERTIFICATE-----", stderr: "" }
        : { status: 0, stdout: `notAfter=${when}\n`, stderr: "" }) as never);
  };

  beforeEach(() => {
    execFileSyncMock.mockReset();
    spawnSyncMock.mockReset();
    delete process.env.VIDRA_MACOS_CODESIGN_KEY;
  });

  it("does not report a chain-valid identity as expired", () => {
    keychain([DEVELOPER_ID], [DEVELOPER_ID]);
    expect(listExpiredCodeSigningIdentities()).toEqual([]);
    // A validating chain already proves it is in date — no certificate read.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  // A self-signed certificate never validates but is perfectly usable, so it
  // must not be mistaken for an expired one.
  it("keeps a self-signed identity whose certificate is still in date", () => {
    keychain([DEVELOPER_ID], []);
    certExpiring("Jan 1 00:00:00 2999 GMT");
    expect(listExpiredCodeSigningIdentities()).toEqual([]);
    expect(selectMacIdentity("distribution").identity).toBe(DEVELOPER_ID);
  });

  it("skips an expired certificate and reports which one", () => {
    keychain([EXPIRED], []);
    certExpiring("Jan 1 00:00:00 2001 GMT");

    const selection = selectMacIdentity("distribution");
    expect(selection.identity).toBeNull();
    expect(selection.expiredSkipped).toEqual([EXPIRED]);
    expect(hasDeveloperIdIdentity()).toBe(false);
  });

  it("prefers a usable certificate over an expired one of the same kind", () => {
    keychain([EXPIRED, DEVELOPER_ID], [DEVELOPER_ID]);
    certExpiring("Jan 1 00:00:00 2001 GMT");
    expect(selectMacIdentity("distribution").identity).toBe(DEVELOPER_ID);
  });
});

describe("signMacDmgIfPossible", () => {
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
    delete process.env.VIDRA_MACOS_CODESIGN_KEY;
  });
  afterEach(() => setPlatform(originalPlatform));

  it("signs the disk image with a real identity", () => {
    setPlatform("darwin");
    process.env.VIDRA_MACOS_CODESIGN_KEY = DEVELOPER_ID;

    signMacDmgIfPossible("/out/App.dmg", { verbose: false, log, warn });

    // `--timestamp` is load-bearing: this disk image is what gets submitted to
    // the notary service, which rejects any signature lacking a secure
    // timestamp.
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codesign",
      ["--force", "--timestamp", "--sign", DEVELOPER_ID, "/out/App.dmg"],
      expect.any(Object),
    );
  });

  // Ad-hoc signing a DMG conveys no trust, so we skip loudly rather than
  // produce something that looks signed but isn't.
  it("skips when no identity is available", () => {
    setPlatform("darwin");
    execFileSyncMock.mockReturnValue(findIdentityOutput([]));

    signMacDmgIfPossible("/out/App.dmg", { verbose: false, log, warn });

    const codesignCalls = execFileSyncMock.mock.calls.filter(
      (c) => c[0] === "codesign",
    );
    expect(codesignCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe("verifyMacSignature / assessGatekeeper", () => {
  // Block body on purpose: an arrow that *returns* the mock makes Vitest treat
  // it as a teardown callback and invoke it after the test.
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("reports success when codesign --verify passes", () => {
    execFileSyncMock.mockReturnValue("valid on disk");
    const result = verifyMacSignature("/some/app.app");
    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "codesign",
      ["--verify", "--strict", "--verbose=2", "/some/app.app"],
      expect.any(Object),
    );
  });

  it("reports failure without throwing", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("bad"), { stderr: "code object is not signed" });
    });
    const result = verifyMacSignature("/some/app.app");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not signed");
  });

  it("assesses a .dmg with the primary-signature context", () => {
    execFileSyncMock.mockReturnValue("accepted");
    assessGatekeeper("/out/App.dmg");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "spctl",
      [
        "--assess",
        "--type",
        "open",
        "--verbose=2",
        "--context",
        "context:primary-signature",
        "/out/App.dmg",
      ],
      expect.any(Object),
    );
  });

  it("assesses an .app as an executable", () => {
    execFileSyncMock.mockReturnValue("accepted");
    assessGatekeeper("/some/app.app");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "spctl",
      ["--assess", "--type", "execute", "--verbose=2", "/some/app.app"],
      expect.any(Object),
    );
  });
});

describe("findNestedMachOPayloads", () => {
  it("finds dylibs and frameworks, deepest first", () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-bundle-"));
    const deep = path.join(root, "Contents", "MonoBundle");
    nodeFs.mkdirSync(deep, { recursive: true });
    nodeFs.writeFileSync(path.join(deep, "libSystem.Native.dylib"), "");
    nodeFs.writeFileSync(path.join(root, "Contents", "shallow.dylib"), "");
    nodeFs.mkdirSync(path.join(root, "Contents", "Frameworks", "Foo.framework"), {
      recursive: true,
    });

    try {
      const found = findNestedMachOPayloads(root);
      expect(found).toHaveLength(3);
      // Deepest paths sort first so nested code is sealed before its parent —
      // the shallow dylib must therefore come last.
      expect(found.at(-1)).toContain("shallow.dylib");
      expect(found.some((f) => f.includes("MonoBundle"))).toBe(true);
      expect(found.some((f) => f.endsWith("Foo.framework"))).toBe(true);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a bundle that does not exist", () => {
    expect(findNestedMachOPayloads("/definitely/not/here.app")).toEqual([]);
  });
});
