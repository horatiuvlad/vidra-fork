import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  buildNumberFor,
  parseAppVersion,
  resolveAppVersion,
  versionPublishArgs,
  VersionError,
} from "../version.js";

const tmpdirs: string[] = [];
const scaffold = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidra-version-"));
  tmpdirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.outputFileSync(path.join(dir, name), contents);
  }
  return dir;
};

afterEach(() => {
  delete process.env.VIDRA_BUILD_NUMBER;
  while (tmpdirs.length) fs.removeSync(tmpdirs.pop()!);
});

describe("parseAppVersion", () => {
  it("keeps the full semver, and strips the prerelease for the display version", () => {
    // CFBundleShortVersionString must be one to three integers — a bundle
    // carrying "1.2.3-beta.1" there is rejected, so the suffix survives only in
    // the artifact name and whatever an updater compares.
    const v = parseAppVersion("1.2.3-beta.1", "package.json");
    expect(v.semver).toBe("1.2.3-beta.1");
    expect(v.display).toBe("1.2.3");
  });

  it("ignores build metadata the same way", () => {
    expect(parseAppVersion("1.2.3+20260729", "package.json").display).toBe("1.2.3");
  });

  it.each(["1.2", "v1.2.3", "1.2.3.4", "latest", ""])(
    "rejects %o with a message naming the source",
    (raw) => {
      expect(() => parseAppVersion(raw, "package.json")).toThrow(VersionError);
      expect(() => parseAppVersion(raw, "package.json")).toThrow(/package\.json/);
    },
  );
});

describe("build number", () => {
  it("increases with the version, which is the only property that matters", () => {
    const ascending = ["0.1.0", "0.1.1", "0.2.0", "1.0.0", "1.0.1", "2.10.99"];
    const numbers = ascending.map((v) => parseAppVersion(v, "t").build);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("is stable for the same version — the same commit builds the same number", () => {
    expect(parseAppVersion("1.2.3", "t").build).toBe(parseAppVersion("1.2.3", "t").build);
    expect(buildNumberFor(1, 2, 3)).toBe(10203);
  });

  it("treats a prerelease as its release version", () => {
    // 1.2.3-beta and 1.2.3 are the same build number: the suffix cannot be
    // encoded in an integer, and shipping both is a release-process question,
    // not something to paper over here.
    expect(parseAppVersion("1.2.3-beta.1", "t").build).toBe(
      parseAppVersion("1.2.3", "t").build,
    );
  });

  it("refuses a version whose segments would break monotonicity", () => {
    expect(() => parseAppVersion("1.100.0", "package.json")).toThrow(/below 100/);
    expect(() => parseAppVersion("1.0.100", "package.json")).toThrow(/below 100/);
  });

  it("can be overridden for projects that outgrew the encoding", () => {
    process.env.VIDRA_BUILD_NUMBER = "20260729";
    expect(parseAppVersion("1.100.0", "t").build).toBe(20260729);
  });

  it("rejects a non-numeric override rather than silently ignoring it", () => {
    process.env.VIDRA_BUILD_NUMBER = "nightly";
    expect(() => parseAppVersion("1.2.3", "t")).toThrow(/VIDRA_BUILD_NUMBER/);
  });
});

describe("resolveAppVersion", () => {
  const csproj = (version: string): string =>
    `<Project><PropertyGroup><ApplicationDisplayVersion>${version}</ApplicationDisplayVersion></PropertyGroup></Project>`;

  it("reads the app's package.json first", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "app", version: "2.3.4" }),
      "src/App.Host/App.Host.csproj": csproj("0.1.0"),
    });
    const v = resolveAppVersion(dir, path.join(dir, "src/App.Host/App.Host.csproj"));
    expect(v.semver).toBe("2.3.4");
    expect(v.source).toBe("package.json");
  });

  it("falls back to the csproj for apps scaffolded before versioning existed", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "app" }),
      "src/App.Host/App.Host.csproj": csproj("0.9.1"),
    });
    const v = resolveAppVersion(dir, path.join(dir, "src/App.Host/App.Host.csproj"));
    expect(v.semver).toBe("0.9.1");
    expect(v.source).toBe("csproj");
  });

  it("explains what to do when neither carries a version", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "app" }),
      "src/App.Host/App.Host.csproj": "<Project></Project>",
    });
    expect(() =>
      resolveAppVersion(dir, path.join(dir, "src/App.Host/App.Host.csproj")),
    ).toThrow(/npm version patch/);
  });
});

describe("versionPublishArgs", () => {
  it("stamps both properties the bundle needs", () => {
    expect(versionPublishArgs(parseAppVersion("1.2.3-rc.1", "t"))).toEqual([
      "-p:ApplicationDisplayVersion=1.2.3",
      "-p:ApplicationVersion=10203",
    ]);
  });
});
