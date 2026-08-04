import path from "node:path";
import type { ResolvedFeeds } from "./update-config.js";

/**
 * Where a build puts what it makes.
 *
 * One rule, no exceptions: **`dist/[channel]` is yours, and the `feed` directory
 * inside it is the server's.** Deliverables are what a person downloads once; a
 * feed directory is what a server serves to apps already installed. Before this
 * they shared `dist/` root, so the DMG sat beside the archives you upload and
 * there was no way to tell by looking.
 *
 * The channel is a directory because it is a directory *remotely* too. Each
 * channel owns its own `bundles.json` and its own `releases.{platform}.json`,
 * which is what removes any need for channel labels inside an index, matching
 * rules, or platform-suffixed channel names.
 *
 * A feed directory mirrors exactly one remote prefix, so publishing is "sync
 * this directory to that URL" rather than a rule about which files to include.
 */
export interface DistLayout {
  /** `dist`, or `dist/<channel>`. Deliverables land here. */
  root: string;
  /** Where web-bundle payloads go, or null when that tier is off. */
  web: string | null;
  /** Where whole-app payloads go, or null when that tier is off. */
  app: string | null;
  /** True when both tiers write into one directory, because they share a destination. */
  shared: boolean;
}

/** The directory name used when both tiers publish to the same place. */
export const FEED_DIR = "feed";

/** Names used when they do not, so `ls` shows which case an app is in. */
export const WEB_FEED_DIR = "feed-web";
export const APP_FEED_DIR = "feed-app";

export const distLayout = (
  projectRoot: string,
  feeds: ResolvedFeeds,
  channel: string | null = null,
): DistLayout => {
  const root = channel
    ? path.join(projectRoot, "dist", channel)
    : path.join(projectRoot, "dist");

  if (feeds.shared) {
    const feed = path.join(root, FEED_DIR);
    return { root, web: feed, app: feed, shared: true };
  }

  return {
    root,
    web: feeds.web ? path.join(root, WEB_FEED_DIR) : null,
    app: feeds.app ? path.join(root, APP_FEED_DIR) : null,
    shared: false,
  };
};

/** Every feed directory this build writes, deduplicated, for reporting. */
export const feedDirectories = (layout: DistLayout): string[] =>
  [...new Set([layout.web, layout.app].filter((dir): dir is string => dir !== null))];
