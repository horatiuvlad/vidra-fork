import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  entitlementsCopyName,
  NativeUpdateConfigError,
  readApplicationId,
  resolveNativeUpdateSettings,
  windowsSignParams,
} from "../native-update.js";

const CERT_ENV = [
  "VIDRA_WINDOWS_CERT_THUMBPRINT",
  "VIDRA_WINDOWS_CERT_PATH",
  "VIDRA_WINDOWS_CERT_PASSWORD",
  "VIDRA_WINDOWS_TIMESTAMP_URL",
];

describe("resolveNativeUpdateSettings", () => {
  let work: string;
  let csproj: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-native-"));
    csproj = path.join(work, "Notes.Host.csproj");
    nodeFs.writeFileSync(
      csproj,
      "<Project><PropertyGroup><ApplicationId>com.example.notes</ApplicationId>" +
        "<ApplicationTitle>Notes</ApplicationTitle></PropertyGroup></Project>",
    );
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  const resolve = (config: Parameters<typeof resolveNativeUpdateSettings>[0]["config"]) =>
    resolveNativeUpdateSettings({ config, csprojPath: csproj, projectName: "Notes", version: "1.2.3" });

  /**
   * Velopack's pack id names its install directory and keys its feed. Deriving
   * it from the app id the developer already chose keeps one identity rather
   * than a second one nobody would remember to keep in step.
   */
  it("takes the pack id from the app's <ApplicationId>", () => {
    expect(resolve({ feedUrl: "https://cdn/" }).packId).toBe("com.example.notes");
  });

  it("lets a project override the pack id", () => {
    expect(resolve({ feedUrl: "https://cdn/", packId: "notes" }).packId).toBe("notes");
  });

  it("falls back to the project name when the csproj has no ApplicationId", () => {
    nodeFs.writeFileSync(csproj, "<Project />");
    expect(resolve({ feedUrl: "https://cdn/" }).packId).toBe("Notes");
  });

  /**
   * Not cosmetic. `vpk pack` renames the bundle to `<packTitle ?? packId>.app`,
   * so leaving the title out ships an app called `com.example.notes.app`: and
   * that is the name a user sees in /Applications forever after.
   */
  it("takes the pack title from <ApplicationTitle>", () => {
    expect(resolve({ feedUrl: "https://cdn/" }).packTitle).toBe("Notes");
  });

  it("falls back to the project name for the title too", () => {
    nodeFs.writeFileSync(csproj, "<Project />");
    expect(resolve({ feedUrl: "https://cdn/" }).packTitle).toBe("Notes");
  });

  it("packs the version the app already carries", () => {
    expect(resolve({ feedUrl: "https://cdn/" }).packVersion).toBe("1.2.3");
  });

  /**
   * Not fatal: a release can be packed and uploaded by hand. But the installed
   * app has nowhere to look, which is a half-configured state worth surfacing
   * rather than a build to refuse.
   */
  it("allows a missing feed URL and reports it as missing", () => {
    expect(resolve({}).feedUrl).toBeNull();
    expect(resolve(undefined).feedUrl).toBeNull();
  });

  it("refuses to pack when the config says native updates are off", () => {
    expect(() => resolve({ feedUrl: "https://cdn/", enabled: false })).toThrow(NativeUpdateConfigError);
  });

  it("leaves the channel unset so vpk uses win/osx", () => {
    expect(resolve({ feedUrl: "https://cdn/" }).channel).toBeNull();
    expect(resolve({ feedUrl: "https://cdn/", channel: "beta" }).channel).toBe("beta");
  });
});

describe("readApplicationId", () => {
  it("returns null for a file that is not there", () => {
    expect(readApplicationId("/nowhere/Notes.Host.csproj")).toBeNull();
  });
});

describe("entitlementsCopyName", () => {
  /**
   * `vpk` rejects `--signEntitlements` unless the name ends in
   * `.entitlements`; the MacCatalyst SDK requires `Entitlements.plist`.
   * Nothing satisfies both, so the build copies, and the copy has to carry
   * the suffix vpk insists on.
   */
  it("ends in .entitlements, which is the only thing vpk accepts", () => {
    expect(entitlementsCopyName("com.example.notes")).toBe("com.example.notes.entitlements");
    expect(entitlementsCopyName("x").endsWith(".entitlements")).toBe(true);
  });
});

describe("windowsSignParams", () => {
  beforeEach(() => {
    for (const key of CERT_ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const key of CERT_ENV) delete process.env[key];
  });

  it("is null without a certificate, so an unsigned build still packs", () => {
    expect(windowsSignParams()).toBeNull();
  });

  it("mirrors what vidra build hands signtool for a store certificate", () => {
    process.env.VIDRA_WINDOWS_CERT_THUMBPRINT = "ABC123";

    expect(windowsSignParams()).toBe(
      "/fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 ABC123",
    );
  });

  it("passes a pfx and its password", () => {
    process.env.VIDRA_WINDOWS_CERT_PATH = "C:\\certs\\vidra.pfx";
    process.env.VIDRA_WINDOWS_CERT_PASSWORD = "hunter2";

    expect(windowsSignParams()).toContain("/f C:\\certs\\vidra.pfx /p hunter2");
  });
});
