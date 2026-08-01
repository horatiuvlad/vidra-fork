import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  downloadArgs,
  findMacMainExe,
  findVpkOutputs,
  isVersionAlreadyReleased,
  packArgs,
  parseVpkVersion,
  readBundleExecutable,
  readMainExeFromSpec,
} from "../velopack.js";

describe("packArgs", () => {
  const base = {
    packId: "com.example.notes",
    packVersion: "1.2.3",
    packDir: "/tmp/Notes.app",
    mainExe: "Notes",
    outputDir: "/tmp/dist/release",
  };

  it("passes the required arguments", () => {
    expect(packArgs(base)).toEqual([
      "pack",
      "--packId", "com.example.notes",
      "--packVersion", "1.2.3",
      "--packDir", "/tmp/Notes.app",
      "--mainExe", "Notes",
      "--outputDir", "/tmp/dist/release",
    ]);
  });

  /**
   * macOS renames the bundle to `<packTitle ?? packId>.app`. Passing the title
   * is the difference between shipping `Notes.app` and `com.example.notes.app`.
   */
  it("passes the display name that becomes the .app's name", () => {
    const args = packArgs({ ...base, packTitle: "Notes" });

    expect(args[args.indexOf("--packTitle") + 1]).toBe("Notes");
    expect(packArgs(base)).not.toContain("--packTitle");
  });

  it("leaves the channel out so Velopack's own default applies", () => {
    expect(packArgs({ ...base, channel: null })).not.toContain("--channel");
    expect(packArgs({ ...base, channel: "osx" })).toEqual(
      expect.arrayContaining(["--channel", "osx"]),
    );
  });

  /**
   * The reason every one of these is an argv array rather than a command
   * string: a Developer ID identity contains spaces and parentheses, and a
   * shell would split it into four arguments.
   */
  it("keeps a signing identity in one argument", () => {
    const identity = "Developer ID Application: Vidra CI (TESTTEAM01)";
    const args = packArgs({ ...base, signAppIdentity: identity });

    expect(args[args.indexOf("--signAppIdentity") + 1]).toBe(identity);
  });

  it("keeps signtool parameters in one argument", () => {
    const params = "/fd SHA256 /sha1 ABCDEF";
    const args = packArgs({ ...base, signParams: params });

    expect(args[args.indexOf("--signParams") + 1]).toBe(params);
  });

  it("omits every signing option that was not supplied", () => {
    const args = packArgs({ ...base, signAppIdentity: null, signEntitlements: null, keychain: null });

    expect(args.join(" ")).not.toMatch(/--sign|--keychain/);
  });
});

describe("downloadArgs", () => {
  it("downloads over http into the release directory", () => {
    expect(downloadArgs({ feedUrl: "https://cdn.example.com/app/", outputDir: "/tmp/release" })).toEqual([
      "download", "http",
      "--url", "https://cdn.example.com/app/",
      "--outputDir", "/tmp/release",
    ]);
  });

  it("passes a channel when one is configured", () => {
    expect(downloadArgs({ feedUrl: "https://x/", outputDir: "/o", channel: "win" })).toEqual(
      expect.arrayContaining(["--channel", "win"]),
    );
  });
});

describe("isVersionAlreadyReleased", () => {
  /**
   * Measured with vpk 1.2.0: packing a version equal to or lower than the
   * newest in the output directory's index exits 255 and writes nothing —
   * no overwrite, no second package under one version, no damaged index.
   * Recognising it is what turns a stack trace into "bump the version".
   */
  it("recognises vpk refusing to re-publish a version", () => {
    const output =
      "[00:11:18 FTL] There is a release in channel linux which is equal or greater " +
      "to the current version 1.0.0. Please increase the current package version or remove that release.";

    expect(isVersionAlreadyReleased(output)).toBe(true);
  });

  it("does not claim every failure is that one", () => {
    expect(isVersionAlreadyReleased("Could not find a part of the path .../Contents/Resources/sq.version")).toBe(false);
    expect(isVersionAlreadyReleased("")).toBe(false);
  });
});

describe("parseVpkVersion", () => {
  /**
   * `vpk --version` answers "Unrecognized command or argument". The version
   * only appears in the banner every command prints, so that is what gets read.
   */
  it("reads the version out of the help banner", () => {
    const help = ["Description:", "  Velopack CLI 1.2.0, for distributing applications.  ", ""].join("\n");

    expect(parseVpkVersion(help)).toBe("1.2.0");
  });

  it("is null when the banner is not there", () => {
    expect(parseVpkVersion("Unrecognized command or argument '--version'.")).toBeNull();
  });
});

describe("finding the app inside a packed bundle", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-velopack-test-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  const bundle = (files: Record<string, string>, dir = "MacOS"): string => {
    const app = path.join(work, "Notes.app");
    const target = path.join(app, "Contents", dir);
    nodeFs.mkdirSync(target, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      nodeFs.writeFileSync(path.join(target, name), contents);
    }
    return app;
  };

  /**
   * `Contents/MacOS` holds three things after a pack, and taking the first
   * directory entry once picked `UpdateMac` — which starts, prints "No known
   * subcommand was used", and exits, exactly like an app that never booted.
   */
  it("reads the app's own binary out of sq.version", () => {
    const app = bundle({
      UpdateMac: "",
      "sq.version": "<package><metadata><mainExe>Notes</mainExe></metadata></package>",
      Notes: "",
    });

    expect(findMacMainExe(app)).toBe("Notes");
  });

  it("falls back to the one entry that is neither the updater nor the manifest", () => {
    const app = bundle({ UpdateMac: "", "sq.version": "<package/>", Notes: "" });

    expect(findMacMainExe(app)).toBe("Notes");
  });

  it("reads the manifest under Resources when MacOS has none", () => {
    const app = bundle({ "sq.version": "<mainExe>Notes</mainExe>" }, "Resources");

    expect(readMainExeFromSpec(app)).toBe("Notes");
  });

  /**
   * On a freshly built `.app` there is no `sq.version` yet — Velopack has not
   * been near it. `CFBundleExecutable` is macOS's own answer and is already
   * there, which is what makes it the first thing to ask.
   */
  it("prefers CFBundleExecutable, which exists before any pack", () => {
    const app = bundle({ Notes: "", Helper: "" });
    nodeFs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>Notes</string></dict></plist>",
    );

    expect(readBundleExecutable(app)).toBe("Notes");
    expect(findMacMainExe(app)).toBe("Notes");
  });

  it("says nothing rather than guessing when there is no bundle", () => {
    expect(findMacMainExe(path.join(work, "Missing.app"))).toBeNull();
  });
});

describe("findVpkOutputs", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-vpk-out-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  it("finds what vpk pack wrote, by the names it uses", () => {
    for (const name of [
      "com.example.notes-1.2.3-win-full.nupkg",
      "com.example.notes-win-Portable.zip",
      "com.example.notes-win-Setup.exe",
      "releases.win.json",
    ]) {
      nodeFs.writeFileSync(path.join(work, name), "x");
    }

    const outputs = findVpkOutputs(work);

    expect(path.basename(outputs.portableZip!)).toBe("com.example.notes-win-Portable.zip");
    expect(path.basename(outputs.setupExe!)).toBe("com.example.notes-win-Setup.exe");
    expect(outputs.setupPkg).toBeNull();
  });

  it("returns nulls for a directory that does not exist", () => {
    expect(findVpkOutputs(path.join(work, "nope"))).toEqual({
      portableZip: null,
      setupExe: null,
      setupPkg: null,
    });
  });
});
