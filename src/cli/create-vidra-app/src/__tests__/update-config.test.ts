import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readUpdateConfig, stampUpdateConfig, UPDATE_CONFIG_FILE } from "../update-config.js";

describe("readUpdateConfig", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-update-config-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  const write = (vidra: unknown): string => {
    nodeFs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "notes", vidra }));
    return work;
  };

  it("reads the native block beside the OTA one", () => {
    const config = readUpdateConfig(
      write({
        updates: {
          feedUrl: "https://cdn.example.com/app/bundles.json",
          native: { feedUrl: "https://cdn.example.com/app/", channel: "osx", packId: "com.example.notes" },
        },
      }),
    );

    expect(config?.feedUrl).toBe("https://cdn.example.com/app/bundles.json");
    expect(config?.native).toEqual({
      feedUrl: "https://cdn.example.com/app/",
      channel: "osx",
      packId: "com.example.notes",
    });
  });

  /**
   * Native updates without OTA is a legitimate configuration: an app that
   * ships whole releases and no JS bundles. The block still has to be stamped,
   * or the installed app has no feed to check.
   */
  it("keeps a config that only configures native updates", () => {
    const config = readUpdateConfig(write({ updates: { native: { feedUrl: "https://cdn/" } } }));

    expect(config).not.toBeNull();
    expect(config?.native?.feedUrl).toBe("https://cdn/");
    expect(config?.feedUrl).toBeUndefined();
  });

  it("reads an explicit off switch on the native block", () => {
    expect(readUpdateConfig(write({ updates: { native: { enabled: false } } }))?.native).toEqual({
      enabled: false,
    });
  });

  it("ignores a native block with nothing usable in it", () => {
    expect(readUpdateConfig(write({ updates: { native: { feedUrl: "   " } } }))).toBeNull();
    expect(readUpdateConfig(write({ updates: { native: "yes" } }))).toBeNull();
  });

  it("trims what a hand-edited config leaves behind", () => {
    const config = readUpdateConfig(write({ updates: { native: { feedUrl: "  https://cdn/  " } } }));

    expect(config?.native?.feedUrl).toBe("https://cdn/");
  });
});

describe("stampUpdateConfig", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-stamp-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  /**
   * One stamped file carries both tiers, which is why the C# side looks for
   * its settings under `native` rather than in a second file.
   */
  it("writes the native block into the file the host reads", () => {
    stampUpdateConfig(work, { feedUrl: "https://cdn/bundles.json", native: { feedUrl: "https://cdn/" } });

    const written = JSON.parse(
      nodeFs.readFileSync(path.join(work, "Resources", "Raw", UPDATE_CONFIG_FILE), "utf-8"),
    );

    expect(written.native).toEqual({ feedUrl: "https://cdn/" });
  });
});
