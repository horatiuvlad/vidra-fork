import { beforeEach, describe, expect, it } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveFeeds,
  stampedConfigFor,
  stampUpdateConfig,
  UPDATE_CONFIG_FILE,
} from "../update-config.js";

let work: string;

beforeEach(() => {
  work = nodeFs.mkdtempSync(path.join(os.tmpdir(), "vidra-update-config-"));
});

describe("resolveFeeds", () => {
  it("is off for an app with no config", () => {
    expect(resolveFeeds(null)).toEqual({
      web: null,
      app: null,
      shared: false,
    });
  });

  it("points both tiers at one shared destination", () => {
    const feeds = resolveFeeds({ feed: "https://cdn/notes/" });

    expect(feeds.web?.base).toBe("https://cdn/notes/");
    expect(feeds.app?.base).toBe("https://cdn/notes/");
    expect(feeds.shared).toBe(true);
  });

  it("keeps split destinations apart", () => {
    const feeds = resolveFeeds({
      feed: {
        web: "https://cdn/notes/",
        app: "https://dl/notes/",
      },
    });

    expect(feeds.web?.base).toBe("https://cdn/notes/");
    expect(feeds.app?.base).toBe("https://dl/notes/");
    expect(feeds.shared).toBe(false);
  });

  it("turns on only the tier with a URL", () => {
    expect(resolveFeeds({ feed: { web: "https://cdn/" } }).app).toBeNull();
    expect(resolveFeeds({ feed: { app: "https://dl/" } }).web).toBeNull();
  });

  it("appends a channel as a path segment", () => {
    const feeds = resolveFeeds({ feed: "https://cdn/notes/" }, "beta");

    expect(feeds.web?.base).toBe("https://cdn/notes/beta/");
    expect(feeds.app?.base).toBe("https://cdn/notes/beta/");
  });

  it("resolves a GitHub shorthand", () => {
    const feeds = resolveFeeds({ feed: "github:acme/notes" }, "beta");

    expect(feeds.web?.base).toBe(
      "https://github.com/acme/notes/releases/download/updates/beta/",
    );
  });

  it("reports nothing when updates are switched off", () => {
    expect(resolveFeeds({ feed: "https://cdn/", enabled: false })).toEqual({
      web: null,
      app: null,
      shared: false,
    });
  });

  it("retains the unresolved configured URI for diagnostics", () => {
    expect(resolveFeeds({ feed: "github:acme/notes" }).web?.uri).toBe(
      "github:acme/notes",
    );
  });
});

describe("stampedConfigFor", () => {
  it("writes absolute URLs for the host", () => {
    const config = { feed: "github:acme/notes" };

    expect(stampedConfigFor(config, resolveFeeds(config, "beta"))).toEqual({
      feedUrl:
        "https://github.com/acme/notes/releases/download/updates/beta/bundles.json",
      native: {
        feedUrl:
          "https://github.com/acme/notes/releases/download/updates/beta/",
      },
    });
  });

  it("carries trusted keys", () => {
    const config = { feed: "https://cdn/", publicKeys: ["AAA"] };

    expect(stampedConfigFor(config, resolveFeeds(config))?.publicKeys).toEqual([
      "AAA",
    ]);
  });

  it("stamps only enabled tiers", () => {
    const config = { feed: { web: "https://cdn/" } };
    const stamped = stampedConfigFor(config, resolveFeeds(config));

    expect(stamped?.feedUrl).toBe("https://cdn/bundles.json");
    expect(stamped?.native).toBeUndefined();
  });

  it("is null when no tier is enabled", () => {
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
      nodeFs.readFileSync(
        path.join(work, "Resources", "Raw", UPDATE_CONFIG_FILE),
        "utf8",
      ),
    );
    expect(written.native).toEqual({ feedUrl: "https://cdn/" });
  });

  it("removes stale stamped configuration", () => {
    const target = path.join(work, "Resources", "Raw", UPDATE_CONFIG_FILE);
    stampUpdateConfig(work, { feedUrl: "https://cdn/bundles.json" });
    expect(nodeFs.existsSync(target)).toBe(true);

    stampUpdateConfig(work, null);
    expect(nodeFs.existsSync(target)).toBe(false);
  });
});
