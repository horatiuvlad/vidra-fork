import { describe, it, expect } from "vitest";

import {
  DEFAULT_GITHUB_TAG,
  FeedUriError,
  manifestUrlFor,
  resolveFeedUri,
  withChannel,
} from "../feed-uri.js";

/**
 * These rules are a permanent API: the resolved URL is stamped into every build
 * and lives in every install forever, so an app built today keeps fetching
 * whatever this returned today. Adding a shorthand is cheap; changing one is not.
 */
describe("resolveFeedUri", () => {
  it("takes an https URL as it is", () => {
    expect(resolveFeedUri("https://updates.acme.com/notes/")).toBe("https://updates.acme.com/notes/");
  });

  /** Always ends in a separator, so appending a file name is never ambiguous. */
  it("adds the trailing slash a base needs", () => {
    expect(resolveFeedUri("https://updates.acme.com/notes")).toBe("https://updates.acme.com/notes/");
  });

  it("expands the github shorthand to the pinned release", () => {
    expect(resolveFeedUri("github:acme/notes")).toBe(
      `https://github.com/acme/notes/releases/download/${DEFAULT_GITHUB_TAG}/`,
    );
  });

  it("lets the tag be named", () => {
    expect(resolveFeedUri("github:acme/notes@beta")).toBe(
      "https://github.com/acme/notes/releases/download/beta/",
    );
  });

  /** A directory is as legitimate a feed as a URL, and is how one gets tested. */
  it("accepts a local path", () => {
    expect(resolveFeedUri("/srv/feed")).toBe("/srv/feed/");
    expect(resolveFeedUri("./dist/feed/")).toBe("./dist/feed/");
  });

  it("does not mistake a Windows drive letter for a scheme", () => {
    expect(resolveFeedUri("C:/feeds/notes")).toBe("C:/feeds/notes/");
  });

  /**
   * Guessing at an unknown scheme would bake a wrong URL into every install.
   * `s3:` in particular has no derivable public URL for anyone behind a CDN or
   * a custom domain, which is most people.
   */
  it("refuses a scheme it does not ship", () => {
    expect(() => resolveFeedUri("s3://notes-updates/app/")).toThrow(FeedUriError);
    expect(() => resolveFeedUri("gitlab:acme/notes")).toThrow(/unknown feed scheme/);
  });

  it("refuses an empty feed", () => {
    expect(() => resolveFeedUri("   ")).toThrow(FeedUriError);
  });
});

describe("withChannel", () => {
  /** A channel is a path segment, which is what gives each one its own indexes. */
  it("appends a channel as a directory", () => {
    expect(withChannel("https://cdn/notes/", "beta")).toBe("https://cdn/notes/beta/");
  });

  it("leaves the default channel unnamed", () => {
    expect(withChannel("https://cdn/notes/", null)).toBe("https://cdn/notes/");
  });
});

describe("manifestUrlFor", () => {
  it("names the file the web tier reads", () => {
    expect(manifestUrlFor("https://cdn/notes/beta/")).toBe("https://cdn/notes/beta/bundles.json");
  });
});
