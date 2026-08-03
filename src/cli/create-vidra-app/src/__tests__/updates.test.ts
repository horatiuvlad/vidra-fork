import { describe, it, expect } from "vitest";

import { deriveNativeFeedUrl } from "../commands/updates.js";

/**
 * `--native` with no URL means "the same place as the web bundles". The two
 * feeds differ in kind — the OTA one names a file, Velopack's names the
 * directory it writes into — so sharing a host means dropping the file name,
 * and nothing else.
 */
describe("deriveNativeFeedUrl", () => {
  it("takes the directory the bundles.json lives in", () => {
    expect(deriveNativeFeedUrl("https://updates.example.com/app/bundles.json")).toBe(
      "https://updates.example.com/app/",
    );
  });

  it("keeps a trailing slash where the URL already is a directory", () => {
    expect(deriveNativeFeedUrl("https://updates.example.com/app/")).toBe(
      "https://updates.example.com/app/",
    );
  });

  it("handles a feed served from the root", () => {
    expect(deriveNativeFeedUrl("https://updates.example.com/bundles.json")).toBe(
      "https://updates.example.com/",
    );
  });

  it("trims what a copy-paste leaves behind", () => {
    expect(deriveNativeFeedUrl("  https://cdn/app/bundles.json  ")).toBe("https://cdn/app/");
  });

  /**
   * A local directory is a valid feed, which is how one gets tested before it
   * is public.
   */
  it("works on a path as well as a URL", () => {
    expect(deriveNativeFeedUrl("/srv/feed/bundles.json")).toBe("/srv/feed/");
  });

  /** Nothing to cut is not an error: hand it back and let the output show it. */
  it("returns a URL with no path unchanged", () => {
    expect(deriveNativeFeedUrl("bundles.json")).toBe("bundles.json");
  });
});
