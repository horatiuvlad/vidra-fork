import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readUpdateBlockState,
  readUpdateConfig,
  resolveFeeds,
  stampedConfigFor,
  stampUpdateConfig,
  UPDATE_CONFIG_FILE,
  writeUpdateConfig,
} from "../update-config.js";

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

describe("readUpdateConfig", () => {
  it("reads one feed serving both tiers", () => {
    expect(readUpdateConfig(write({ updates: { feed: "https://cdn/notes/" } }))).toEqual({
      feed: "https://cdn/notes/",
    });
  });

  it("reads the split form", () => {
    const config = readUpdateConfig(
      write({ updates: { feed: { web: "https://cdn/notes/", app: "https://dl/notes/" } } }),
    );

    expect(config?.feed).toEqual({ web: "https://cdn/notes/", app: "https://dl/notes/" });
  });

  it("keeps a split that names only one tier", () => {
    expect(readUpdateConfig(write({ updates: { feed: { web: "https://cdn/" } } }))?.feed).toEqual({
      web: "https://cdn/",
    });
  });

  it("trims what a hand-edited config leaves behind", () => {
    expect(readUpdateConfig(write({ updates: { feed: "  https://cdn/  " } }))?.feed).toBe(
      "https://cdn/",
    );
  });

  /** The shape a fresh scaffold ships, and the shape a half-finished edit leaves. */
  it("treats a blank feed as no configuration", () => {
    expect(readUpdateConfig(write({ updates: { feed: "" } }))).toBeNull();
    expect(readUpdateConfig(write({ updates: { feed: { web: "", app: "" } } }))).toBeNull();
    expect(readUpdateConfig(write({ updates: {} }))).toBeNull();
    expect(readUpdateConfig(work)).toBeNull();
  });

  it("reads a single publicKey and a publicKeys array", () => {
    expect(
      readUpdateConfig(write({ updates: { feed: "https://cdn/", publicKey: "AAA" } }))?.publicKeys,
    ).toEqual(["AAA"]);
    expect(
      readUpdateConfig(write({ updates: { feed: "https://cdn/", publicKeys: ["A", "B"] } }))
        ?.publicKeys,
    ).toEqual(["A", "B"]);
  });
});

/**
 * The one rule the feature turns on. Everything else — the stamped file, the
 * builder calls, the entry points, the package reference — ships in every app
 * whatever this says.
 */
describe("resolveFeeds", () => {
  it("is off for an app with no config at all", () => {
    expect(resolveFeeds(null)).toEqual({ web: null, app: null, shared: false });
  });

  /** One string is one destination, which is what puts both tiers in one directory. */
  it("points both tiers at one place, and says they are shared", () => {
    const feeds = resolveFeeds({ feed: "https://cdn/notes/" });

    expect(feeds.web?.base).toBe("https://cdn/notes/");
    expect(feeds.app?.base).toBe("https://cdn/notes/");
    expect(feeds.shared).toBe(true);
  });

  it("keeps two destinations apart", () => {
    const feeds = resolveFeeds({ feed: { web: "https://cdn/notes/", app: "https://dl/notes/" } });

    expect(feeds.web?.base).toBe("https://cdn/notes/");
    expect(feeds.app?.base).toBe("https://dl/notes/");
    expect(feeds.shared).toBe(false);
  });

  it("turns on only the half that has a URL", () => {
    expect(resolveFeeds({ feed: { web: "https://cdn/" } }).app).toBeNull();
    expect(resolveFeeds({ feed: { app: "https://dl/" } }).web).toBeNull();
  });

  /**
   * A channel is a path segment, not a label. That is what gives each channel
   * its own `bundles.json` and its own `releases.{platform}.json`, so nothing
   * downstream needs matching rules or platform-suffixed channel names.
   */
  it("appends a channel as a path segment", () => {
    const feeds = resolveFeeds({ feed: "https://cdn/notes/" }, "beta");

    expect(feeds.web?.base).toBe("https://cdn/notes/beta/");
    expect(feeds.app?.base).toBe("https://cdn/notes/beta/");
  });

  it("resolves a github shorthand for both tiers", () => {
    const feeds = resolveFeeds({ feed: "github:acme/notes" }, "beta");

    expect(feeds.web?.base).toBe("https://github.com/acme/notes/releases/download/updates/beta/");
  });

  /** The master switch, kept beside the URL so a feed can be silenced without losing it. */
  it("reports nothing when updates are switched off", () => {
    expect(resolveFeeds({ feed: "https://cdn/", enabled: false })).toEqual({
      web: null,
      app: null,
      shared: false,
    });
  });

  it("reports what package.json said, unresolved, for the developer to recognise", () => {
    expect(resolveFeeds({ feed: "github:acme/notes" }).web?.uri).toBe("github:acme/notes");
  });
});

/**
 * `package.json` describes the app; this file describes one build of it. The
 * shapes differ on purpose: what is stamped is fully resolved, with the channel
 * already folded in and nothing the app has no business carrying.
 */
describe("stampedConfigFor", () => {
  it("writes absolute URLs the app can fetch without resolving anything", () => {
    const config = { feed: "github:acme/notes" };

    expect(stampedConfigFor(config, resolveFeeds(config, "beta"))).toEqual({
      feedUrl: "https://github.com/acme/notes/releases/download/updates/beta/bundles.json",
      native: { feedUrl: "https://github.com/acme/notes/releases/download/updates/beta/" },
    });
  });

  it("carries the trusted keys, since the app is what enforces them", () => {
    const config = { feed: "https://cdn/", publicKeys: ["AAA"] };

    expect(stampedConfigFor(config, resolveFeeds(config))?.publicKeys).toEqual(["AAA"]);
  });

  it("stamps only the tier that is on", () => {
    const config = { feed: { web: "https://cdn/" } };
    const stamped = stampedConfigFor(config, resolveFeeds(config));

    expect(stamped?.feedUrl).toBe("https://cdn/bundles.json");
    expect(stamped?.native).toBeUndefined();
  });

  /** Keys alone configure nothing: without a feed there is nothing to verify. */
  it("is null when no tier is on, so nothing is shipped", () => {
    const config = { publicKeys: ["AAA"] };
    expect(stampedConfigFor(config, resolveFeeds(config))).toBeNull();
  });
});

describe("stampUpdateConfig", () => {
  it("writes the document the host reads", () => {
    stampUpdateConfig(work, {
      feedUrl: "https://cdn/bundles.json",
      native: { feedUrl: "https://cdn/" },
    });

    const written = JSON.parse(
      nodeFs.readFileSync(path.join(work, "Resources", "Raw", UPDATE_CONFIG_FILE), "utf-8"),
    );

    expect(written.native).toEqual({ feedUrl: "https://cdn/" });
  });

  /**
   * An app that had a feed and no longer does must not keep shipping the old
   * one because the file happened to survive in `Resources/Raw`.
   */
  it("removes a stale config rather than leaving it behind", () => {
    const target = path.join(work, "Resources", "Raw", UPDATE_CONFIG_FILE);
    stampUpdateConfig(work, { feedUrl: "https://cdn/bundles.json" });
    expect(nodeFs.existsSync(target)).toBe(true);

    stampUpdateConfig(work, null);
    expect(nodeFs.existsSync(target)).toBe(false);
  });
});

/**
 * Every scaffolded app ships the block with the switch spelled correctly and
 * empty, so "there is a block" stopped being a signal — what somebody typed
 * into it is.
 */
describe("readUpdateBlockState", () => {
  it("is absent for an app with no block, or no package.json", () => {
    nodeFs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "notes" }));
    expect(readUpdateBlockState(work)).toBe("absent");
    expect(readUpdateBlockState(path.join(work, "nowhere"))).toBe("absent");
  });

  it("is untouched for exactly what the template ships", () => {
    expect(readUpdateBlockState(write({ updates: { feed: "" } }))).toBe("untouched");
    expect(readUpdateBlockState(write({ updates: { feed: { web: "", app: "" } } }))).toBe(
      "untouched",
    );
  });

  it("treats whitespace as untouched, since that is what a stray keystroke leaves", () => {
    expect(readUpdateBlockState(write({ updates: { feed: "   " } }))).toBe("untouched");
  });

  it("is edited as soon as a feed has a URL", () => {
    expect(readUpdateBlockState(write({ updates: { feed: "https://cdn/" } }))).toBe("edited");
  });

  /** The case the whole tri-state exists for: typed into, and still off. */
  it("is edited for a misspelled key, which is how doctor can see one", () => {
    expect(readUpdateBlockState(write({ updates: { feedUrl: "https://cdn/b.json" } }))).toBe(
      "edited",
    );
  });

  /** `false` is a decision, not an empty field. */
  it("is edited when updates were deliberately switched off", () => {
    expect(readUpdateBlockState(write({ updates: { enabled: false } }))).toBe("edited");
  });
});

describe("writeUpdateConfig", () => {
  const pkg = (contents: object): string => {
    nodeFs.writeFileSync(path.join(work, "package.json"), `${JSON.stringify(contents, null, 2)}\n`);
    return work;
  };

  const read = (): Record<string, unknown> =>
    JSON.parse(nodeFs.readFileSync(path.join(work, "package.json"), "utf-8"));

  const updates = (): Record<string, unknown> =>
    (read().vidra as { updates: Record<string, unknown> }).updates;

  it("fills in the blank field a scaffold ships", () => {
    writeUpdateConfig(pkg({ name: "notes", vidra: { updates: { feed: "" } } }), {
      feed: "https://cdn/notes/",
    });

    expect(updates()).toEqual({ feed: "https://cdn/notes/" });
  });

  /**
   * A merge, not a write: `publicKeys` may already be there from `keygen`, and
   * a command that adds a feed URL must not quietly drop the key that makes
   * the feed trustworthy.
   */
  it("keeps everything it was not asked to change", () => {
    writeUpdateConfig(pkg({ name: "notes", vidra: { updates: { publicKeys: ["k"] } } }), {
      feed: { web: "https://cdn/", app: "https://dl/" },
    });

    expect(updates()).toEqual({
      publicKeys: ["k"],
      feed: { web: "https://cdn/", app: "https://dl/" },
    });
  });

  it("leaves the rest of package.json alone", () => {
    writeUpdateConfig(pkg({ name: "notes", version: "2.1.0", scripts: { dev: "vidra dev" } }), {
      feed: "https://cdn/",
    });

    const after = read();
    expect(after.name).toBe("notes");
    expect(after.version).toBe("2.1.0");
    expect(after.scripts).toEqual({ dev: "vidra dev" });
  });

  it("removes a key set to null", () => {
    writeUpdateConfig(pkg({ name: "notes", vidra: { updates: { feed: "https://cdn/" } } }), {
      feed: null,
    });

    expect(updates()).toEqual({});
  });

  /** This edits a file the developer owns; a reformatting diff is a diff nobody reads. */
  it("writes back with the indentation the file already used", () => {
    nodeFs.writeFileSync(
      path.join(work, "package.json"),
      `${JSON.stringify({ name: "notes" }, null, 4)}\n`,
    );

    writeUpdateConfig(work, { feed: "https://cdn/" });

    const raw = nodeFs.readFileSync(path.join(work, "package.json"), "utf-8");
    expect(raw).toContain('\n    "vidra"');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("hands back the config the app will actually read", () => {
    expect(writeUpdateConfig(pkg({ name: "notes" }), { feed: "  https://cdn/  " })?.feed).toBe(
      "https://cdn/",
    );
  });
});
