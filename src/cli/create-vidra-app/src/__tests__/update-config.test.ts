import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  enabledTiers,
  readUpdateBlockState,
  readUpdateConfig,
  stampUpdateConfig,
  UPDATE_CONFIG_FILE,
  writeUpdateConfig,
} from "../update-config.js";

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

/**
 * The one rule the feature turns on. Everything else — the stamped file, the
 * builder calls, the entry points, the package reference — ships in every app
 * whatever this says; these two booleans are the difference between an app that
 * checks and an app that does not.
 */
describe("enabledTiers", () => {
  it("is off for an app with no config at all", () => {
    expect(enabledTiers(null)).toEqual({ ota: false, native: false });
  });

  it("turns each tier on with its own feed URL", () => {
    expect(enabledTiers({ feedUrl: "https://cdn/bundles.json" })).toEqual({
      ota: true,
      native: false,
    });
    expect(enabledTiers({ native: { feedUrl: "https://cdn/" } })).toEqual({
      ota: false,
      native: true,
    });
  });

  it("is on for both when both are configured", () => {
    expect(
      enabledTiers({ feedUrl: "https://cdn/bundles.json", native: { feedUrl: "https://cdn/" } }),
    ).toEqual({ ota: true, native: true });
  });

  /**
   * A block with everything but the URL is the shape a typo produces, and it
   * has to read as off — otherwise `vidra build` would pack a release nobody
   * could find.
   */
  it("is off when the block exists but names no feed", () => {
    expect(enabledTiers({ channel: "stable", native: { channel: "osx" } })).toEqual({
      ota: false,
      native: false,
    });
  });

  /** `enabled: false` silences a feed without losing the URL. */
  it("respects each tier's own off switch", () => {
    expect(
      enabledTiers({
        feedUrl: "https://cdn/bundles.json",
        enabled: false,
        native: { feedUrl: "https://cdn/" },
      }),
    ).toEqual({ ota: false, native: true });

    expect(
      enabledTiers({
        feedUrl: "https://cdn/bundles.json",
        native: { feedUrl: "https://cdn/", enabled: false },
      }),
    ).toEqual({ ota: true, native: false });
  });
});

describe("writeUpdateConfig", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-write-config-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  const pkg = (contents: object): string => {
    nodeFs.writeFileSync(path.join(work, "package.json"), `${JSON.stringify(contents, null, 2)}\n`);
    return work;
  };

  const read = (): Record<string, any> =>
    JSON.parse(nodeFs.readFileSync(path.join(work, "package.json"), "utf-8"));

  it("creates the block in an app that has never configured updates", () => {
    writeUpdateConfig(pkg({ name: "notes", version: "1.0.0" }), {
      feedUrl: "https://cdn/bundles.json",
    });

    expect(read().vidra.updates).toEqual({ feedUrl: "https://cdn/bundles.json" });
  });

  /**
   * A merge, not a write: `publicKeys` may already be there from `keygen`, and
   * a command that adds a feed URL must not quietly drop the key that makes
   * the feed trustworthy.
   */
  it("keeps everything it was not asked to change", () => {
    writeUpdateConfig(
      pkg({
        name: "notes",
        vidra: { updates: { publicKeys: ["k"], native: { packId: "com.example.notes" } } },
      }),
      { feedUrl: "https://cdn/bundles.json", native: { feedUrl: "https://cdn/" } },
    );

    expect(read().vidra.updates).toEqual({
      publicKeys: ["k"],
      native: { packId: "com.example.notes", feedUrl: "https://cdn/" },
      feedUrl: "https://cdn/bundles.json",
    });
  });

  it("leaves the rest of package.json alone", () => {
    writeUpdateConfig(pkg({ name: "notes", version: "2.1.0", scripts: { dev: "vidra dev" } }), {
      feedUrl: "https://cdn/bundles.json",
    });

    const after = read();
    expect(after.name).toBe("notes");
    expect(after.version).toBe("2.1.0");
    expect(after.scripts).toEqual({ dev: "vidra dev" });
  });

  /** Turning a tier back off, without hand-editing JSON. */
  it("removes a key set to null", () => {
    const root = pkg({
      name: "notes",
      vidra: { updates: { feedUrl: "https://cdn/b.json", native: { feedUrl: "https://cdn/" } } },
    });

    writeUpdateConfig(root, { native: null });

    expect(read().vidra.updates).toEqual({ feedUrl: "https://cdn/b.json" });
  });

  /** This edits a file the developer owns; a reformatting diff is a diff nobody reads. */
  it("writes back with the indentation the file already used", () => {
    nodeFs.writeFileSync(
      path.join(work, "package.json"),
      `${JSON.stringify({ name: "notes" }, null, 4)}\n`,
    );

    writeUpdateConfig(work, { feedUrl: "https://cdn/bundles.json" });

    const raw = nodeFs.readFileSync(path.join(work, "package.json"), "utf-8");
    expect(raw).toContain('\n    "vidra"');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("hands back the config the app will actually read", () => {
    const config = writeUpdateConfig(pkg({ name: "notes" }), {
      feedUrl: "  https://cdn/bundles.json  ",
    });

    expect(config?.feedUrl).toBe("https://cdn/bundles.json");
  });
});

/**
 * Every scaffolded app ships the block with both switches spelled correctly and
 * empty, so "there is a block" stopped being a signal — what somebody typed
 * into it is.
 */
describe("readUpdateBlockState", () => {
  let work: string;

  beforeEach(() => {
    work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-block-state-"));
  });

  afterEach(() => {
    nodeFs.rmSync(work, { recursive: true, force: true });
  });

  const write = (contents: object): string => {
    nodeFs.writeFileSync(path.join(work, "package.json"), JSON.stringify(contents, null, 2));
    return work;
  };

  it("is absent for an app with no block", () => {
    expect(readUpdateBlockState(write({ name: "notes" }))).toBe("absent");
  });

  it("is absent when there is no package.json to read", () => {
    expect(readUpdateBlockState(path.join(work, "nowhere"))).toBe("absent");
  });

  it("is untouched for exactly what the template ships", () => {
    expect(
      readUpdateBlockState(write({ vidra: { updates: { feedUrl: "", native: { feedUrl: "" } } } })),
    ).toBe("untouched");
  });

  it("treats whitespace as untouched, since that is what a stray keystroke leaves", () => {
    expect(readUpdateBlockState(write({ vidra: { updates: { feedUrl: "   " } } }))).toBe(
      "untouched",
    );
  });

  it("is edited as soon as either switch has a URL", () => {
    expect(
      readUpdateBlockState(write({ vidra: { updates: { feedUrl: "https://cdn/b.json" } } })),
    ).toBe("edited");
    expect(
      readUpdateBlockState(write({ vidra: { updates: { native: { feedUrl: "https://cdn/" } } } })),
    ).toBe("edited");
  });

  /** The case the whole tri-state exists for: typed into, and still off. */
  it("is edited for a misspelled key, which is how doctor can see one", () => {
    expect(
      readUpdateBlockState(write({ vidra: { updates: { feedURL: "https://cdn/b.json" } } })),
    ).toBe("edited");
  });

  /** `false` is a decision, not an empty field. */
  it("is edited when a tier was deliberately switched off", () => {
    expect(readUpdateBlockState(write({ vidra: { updates: { enabled: false } } }))).toBe("edited");
  });
});
