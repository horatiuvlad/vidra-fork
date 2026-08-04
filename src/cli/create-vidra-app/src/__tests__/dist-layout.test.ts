import { describe, it, expect } from "vitest";
import path from "node:path";

import { APP_FEED_DIR, distLayout, FEED_DIR, WEB_FEED_DIR } from "../dist-layout.js";
import { parseBuildMode, resolveChannel } from "../commands/build.js";
import { resolveFeeds } from "../update-config.js";

const ROOT = path.join(path.sep, "app");
const rel = (dir: string | null): string | null =>
  dir === null ? null : path.relative(ROOT, dir);

/**
 * One rule, no exceptions: `dist/[channel]` is yours, and the feed directory
 * inside it is the server's. Before this they shared `dist/` root, so the DMG
 * sat beside the archives you upload.
 */
describe("distLayout", () => {
  it("puts deliverables at dist/ and one shared feed beside them", () => {
    const layout = distLayout(ROOT, resolveFeeds({ feed: "https://cdn/notes/" }));

    expect(rel(layout.root)).toBe("dist");
    expect(rel(layout.web)).toBe(path.join("dist", FEED_DIR));
    expect(layout.app).toBe(layout.web);
    expect(layout.shared).toBe(true);
  });

  /** Two destinations means two directories, each mirroring one remote prefix. */
  it("splits the feeds when they publish to different places", () => {
    const layout = distLayout(
      ROOT,
      resolveFeeds({ feed: { web: "https://cdn/notes/", app: "https://dl/notes/" } }),
    );

    expect(rel(layout.web)).toBe(path.join("dist", WEB_FEED_DIR));
    expect(rel(layout.app)).toBe(path.join("dist", APP_FEED_DIR));
    expect(layout.shared).toBe(false);
  });

  /**
   * One tier on its own is still one destination, so it gets the plain name.
   * The split names exist to tell two remote prefixes apart.
   */
  it("uses the plain feed directory when only one tier is on", () => {
    const layout = distLayout(ROOT, resolveFeeds({ feed: { web: "https://cdn/notes/" } }));

    expect(rel(layout.web)).toBe(path.join("dist", FEED_DIR));
    expect(layout.app).toBeNull();
  });

  it("has no feed directory at all for an app that configured none", () => {
    const layout = distLayout(ROOT, resolveFeeds(null));

    expect(rel(layout.root)).toBe("dist");
    expect(layout.web).toBeNull();
    expect(layout.app).toBeNull();
  });

  /**
   * A beta build is a different binary — the channel is folded into the URL
   * stamped inside it — so its deliverable belongs under the channel too.
   */
  it("moves everything under the channel, deliverables included", () => {
    const layout = distLayout(ROOT, resolveFeeds({ feed: "https://cdn/notes/" }, "beta"), "beta");

    expect(rel(layout.root)).toBe(path.join("dist", "beta"));
    expect(rel(layout.web)).toBe(path.join("dist", "beta", FEED_DIR));
  });

  /** Absence is the default channel, so the common case stays flat. */
  it("adds no layer for the default channel", () => {
    expect(rel(distLayout(ROOT, resolveFeeds({ feed: "https://cdn/" }), null).root)).toBe("dist");
  });
});

describe("parseBuildMode", () => {
  /** Config decides what is on; a flag only ever asks for less. */
  it("defaults to everything package.json configures", () => {
    expect(parseBuildMode({})).toBe("all");
  });

  it("reads the two narrowing flags", () => {
    expect(parseBuildMode({ app: true })).toBe("app");
    expect(parseBuildMode({ web: true })).toBe("web");
  });

  it("prefers --app when both are passed, rather than doing neither", () => {
    expect(parseBuildMode({ app: true, web: true })).toBe("app");
  });
});

/**
 * A build input rather than configuration: the same commit must be able to
 * produce a stable artifact and a beta one, so `package.json` cannot hold this.
 */
describe("resolveChannel", () => {
  it("is null when nothing asks for one", () => {
    expect(resolveChannel(undefined, {})).toBeNull();
  });

  it("takes the flag", () => {
    expect(resolveChannel("beta", {})).toBe("beta");
  });

  /** So a CI environment can supply it without the workflow growing arguments. */
  it("falls back to the environment", () => {
    expect(resolveChannel(undefined, { VIDRA_CHANNEL: "beta" })).toBe("beta");
  });

  it("lets the flag win over the environment", () => {
    expect(resolveChannel("rc", { VIDRA_CHANNEL: "beta" })).toBe("rc");
  });

  it("treats a blank value as no channel", () => {
    expect(resolveChannel("   ", { VIDRA_CHANNEL: "beta" })).toBeNull();
    expect(resolveChannel(undefined, { VIDRA_CHANNEL: "  " })).toBeNull();
  });
});
