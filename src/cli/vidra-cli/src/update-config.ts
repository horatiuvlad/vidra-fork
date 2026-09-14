import path from "node:path";
import fs from "fs-extra";
import { manifestUrlFor, resolveFeedUri, withChannel } from "./feed-uri.js";

/**
 * Normalized update settings loaded from `vidra.config.ts`.
 *
 * `package.json` remains the source for the app version only.
 *
 * **A feed URL is the feature flag.** Every scaffolded app ships the whole
 * updater — both tiers wired, Velopack referenced, the entry points live — and
 * the switch sits in `vidra.config.ts` already, blank. Filling it in is the
 * entire opt-in.
 *
 * Three keys, and only the first is required. Everything that varies per
 * *artifact* rather than per app — the channel, above all — is a build input,
 * because the same commit must be able to produce a stable build and a beta one.
 */
export interface UpdateConfig {
  /**
   * A directory, not a file. One string serves both tiers; the object form
   * splits them when the payloads live on different hosts.
   *
   * The web tier appends `bundles.json`; whole-app releases use the directory
   * as-is. An empty string means that tier is off, which is the shape a fresh
   * scaffold ships.
   */
  feed?: string | FeedSplit;
  /**
   * Base64 SPKI public keys the app will accept a manifest from. More than one
   * so a key can be rotated: publish under the new key while installed apps
   * still trust the old one, then drop the old one a release later.
   *
   * Configuring any key makes signatures **required** — an app that trusts a key
   * refuses an unsigned feed, which is the whole point.
   */
  publicKeys?: string[];
  /** Master switch. Absent means on, since a feed URL is what turns anything on. */
  enabled?: boolean;
}

/** The two tiers, when their payloads do not share a host. */
export interface FeedSplit {
  /** Web bundles: your `ui/` build, applied on the next launch. */
  web?: string;
  /** Whole-app releases, via Velopack. */
  app?: string;
}

/** The name the host looks for, as a MAUI app-package asset. */
export const UPDATE_CONFIG_FILE = "vidra-updates.json";

/** One tier, resolved against a channel and ready to be written down. */
export interface ResolvedFeed {
  /** What `vidra.config.ts` said, unresolved. Reported, never fetched. */
  uri: string;
  /** The public base every payload of this tier sits under, channel included. */
  base: string;
}

export interface ResolvedFeeds {
  web: ResolvedFeed | null;
  app: ResolvedFeed | null;
  /** True when both tiers resolve to the same place, so one directory serves both. */
  shared: boolean;
}

/**
 * Settles where each tier publishes, for one build.
 *
 * The channel is a **path segment**, not a label: `<feed>/beta/`. That is what
 * lets each channel own its own `bundles.json` and its own
 * `releases.{platform}.json`, and it is why nothing here has to reason about
 * matching rules or platform-suffixed channel names.
 */
export const resolveFeeds = (
  config: UpdateConfig | null,
  channel: string | null = null,
): ResolvedFeeds => {
  if (!config || config.enabled === false) {
    return { web: null, app: null, shared: false };
  }

  const resolve = (uri: string | undefined): ResolvedFeed | null => {
    if (typeof uri !== "string" || uri.trim().length === 0) return null;
    return { uri: uri.trim(), base: withChannel(resolveFeedUri(uri), channel) };
  };

  const feed = config.feed;
  const web = resolve(typeof feed === "string" ? feed : feed?.web);
  const app = resolve(typeof feed === "string" ? feed : feed?.app);

  return { web, app, shared: !!web && !!app && web.base === app.base };
};

/**
 * The document `vidra build` stamps into the app, and the only update config
 * the running app ever sees.
 *
 * Deliberately a different shape from `vidra.config.ts`: this one describes one
 * build of the app — fully resolved URLs, the channel
 * already folded into them, and nothing the app has no business carrying.
 */
export interface StampedConfig {
  feedUrl?: string;
  publicKeys?: string[];
  native?: { feedUrl: string };
}

export const stampedConfigFor = (
  config: UpdateConfig | null,
  feeds: ResolvedFeeds,
): StampedConfig | null => {
  const stamped: StampedConfig = {};

  if (feeds.web) stamped.feedUrl = manifestUrlFor(feeds.web.base);
  if (feeds.app) stamped.native = { feedUrl: feeds.app.base };
  if (config?.publicKeys?.length) stamped.publicKeys = [...config.publicKeys];

  // Keys alone configure nothing: without a feed there is nothing to verify.
  return stamped.feedUrl || stamped.native ? stamped : null;
};

/**
 * Writes (or removes) the stamped config next to the web assets. Removal
 * matters: an app that had a feed and no longer does must not keep shipping the
 * old one because the file happened to survive in `Resources/Raw`.
 */
export const stampUpdateConfig = (
  hostDir: string,
  config: StampedConfig | null,
): string | null => {
  const target = path.join(hostDir, "Resources", "Raw", UPDATE_CONFIG_FILE);

  if (!config) {
    fs.removeSync(target);
    return null;
  }

  fs.ensureDirSync(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
};
