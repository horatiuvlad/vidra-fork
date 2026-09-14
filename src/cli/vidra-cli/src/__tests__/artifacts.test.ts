import { describe, it, expect, vi, beforeEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { inspectMacHardening, REQUIRED_MAC_ENTITLEMENTS } = await import(
  "../signing.js"
);
const {
  findAppBundle,
  findMacExecutable,
  findWindowsExecutable,
  findWindowsExecutableRecursive,
} = await import("../artifacts.js");

const ENTITLEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${REQUIRED_MAC_ENTITLEMENTS.map((k) => `<key>${k}</key><true/>`).join("\n")}
<key>com.apple.security.network.client</key><true/>
</dict></plist>`;

describe("inspectMacHardening", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  // `codesign -d` writes to stderr even on success; reading only stdout would
  // silently report "not hardened" for a perfectly good bundle.
  it("reads the report from stderr", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("--entitlements")
        ? { stdout: "", stderr: ENTITLEMENTS_XML }
        : { stdout: "", stderr: "CodeDirectory v=20500 flags=0x10000(runtime) size=100" },
    );

    const report = inspectMacHardening("/some/app.app");
    expect(report.hardened).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("detects a signature without the hardened runtime", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("--entitlements")
        ? { stdout: "", stderr: ENTITLEMENTS_XML }
        : { stdout: "", stderr: "CodeDirectory v=20400 flags=0x0(none) size=100" },
    );

    const report = inspectMacHardening("/some/app.app");
    expect(report.hardened).toBe(false);
    expect(report.ok).toBe(false);
  });

  // The failure this exists to catch: hardened runtime on, JIT entitlements
  // absent — signs and notarizes, then dies at launch.
  it("reports missing JIT entitlements", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("--entitlements")
        ? {
            stdout: "",
            stderr:
              '<plist><dict><key>com.apple.security.network.client</key><true/></dict></plist>',
          }
        : { stdout: "", stderr: "CodeDirectory flags=0x10000(runtime)" },
    );

    const report = inspectMacHardening("/some/app.app");
    expect(report.hardened).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([...REQUIRED_MAC_ENTITLEMENTS]);
  });

  it("collects the entitlement keys it found", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) =>
      args.includes("--entitlements")
        ? { stdout: "", stderr: ENTITLEMENTS_XML }
        : { stdout: "", stderr: "CodeDirectory flags=0x10000(runtime)" },
    );
    expect(inspectMacHardening("/x.app").entitlements).toContain(
      "com.apple.security.network.client",
    );
  });
});

describe("artifact layout helpers", () => {
  const tmp = (): string => nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-art-"));

  it("finds an .app bundle in a directory", () => {
    const dir = tmp();
    try {
      nodeFs.mkdirSync(path.join(dir, "MyApp.app"));
      nodeFs.writeFileSync(path.join(dir, "notes.txt"), "");
      expect(findAppBundle(dir)).toBe(path.join(dir, "MyApp.app"));
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the executable named after the bundle", () => {
    const dir = tmp();
    try {
      const app = path.join(dir, "MyApp.app");
      const macos = path.join(app, "Contents", "MacOS");
      nodeFs.mkdirSync(macos, { recursive: true });
      nodeFs.writeFileSync(path.join(macos, "helper"), "");
      nodeFs.writeFileSync(path.join(macos, "MyApp"), "");
      expect(findMacExecutable(app)).toBe(path.join(macos, "MyApp"));
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // `createdump.exe` ships with the .NET runtime and must never be mistaken for
  // the app — signing or launching it would be silently wrong.
  it("never picks createdump.exe as the app", () => {
    const dir = tmp();
    try {
      nodeFs.writeFileSync(path.join(dir, "createdump.exe"), "");
      nodeFs.writeFileSync(path.join(dir, "VidraSmoke.Host.exe"), "");
      expect(findWindowsExecutable(dir)).toBe(
        path.join(dir, "VidraSmoke.Host.exe"),
      );
      expect(findWindowsExecutable(dir, "VidraSmoke")).toBe(
        path.join(dir, "VidraSmoke.Host.exe"),
      );
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds an executable nested under a RID folder", () => {
    const dir = tmp();
    try {
      const publish = path.join(dir, "win-x64", "publish");
      nodeFs.mkdirSync(publish, { recursive: true });
      nodeFs.writeFileSync(path.join(publish, "MyApp.Host.exe"), "");
      expect(findWindowsExecutableRecursive(dir, "MyApp")).toBe(
        path.join(publish, "MyApp.Host.exe"),
      );
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for directories that do not exist", () => {
    expect(findAppBundle("/no/such/dir")).toBeNull();
    expect(findMacExecutable("/no/such.app")).toBeNull();
    expect(findWindowsExecutable("/no/such/dir")).toBeNull();
  });
});
