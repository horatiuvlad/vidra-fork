import path from "node:path";
import fs from "fs-extra";
import { manifestUrlFor, resolveFeedUri, withChannel } from "./feed-uri.js";

/**
 * The `vidra.updates` block of an app's own `package.json` — the single place a
 * developer configures updates, next to the version the same file already owns.
 *
 * ```json
 * { "vidra": { "updates": { "feed": "https://updates.example.com/notes/" } } }
 * ```
 *
 * **A feed URL is the feature flag.** Every scaffolded app ships the whole
 * updater — both tiers wired, Velopack referenced, the entry points live — and
 * both switches sit in `package.json` already, blank. Filling one in is the
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
  /** What `package.json` said, unresolved. Reported, never fetched. */
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

export const readUpdateConfig = (projectRoot: string): UpdateConfig | null => {
  const raw = readUpdateBlock(projectRoot);
  if (!raw) return null;

  const config: UpdateConfig = {};

  if (typeof raw.feed === "string" && raw.feed.trim().length > 0) {
    config.feed = raw.feed.trim();
  } else if (raw.feed && typeof raw.feed === "object") {
    const split = readFeedSplit(raw.feed as Record<string, unknown>);
    if (split) config.feed = split;
  }

  if (typeof raw.enabled === "boolean") {
    config.enabled = raw.enabled;
  }

  // `publicKey` (one) and `publicKeys` (several) both work; rotation needs the
  // plural, and a single key is the common case.
  const keys = [
    ...(typeof raw.publicKey === "string" ? [raw.publicKey] : []),
    ...(Array.isArray(raw.publicKeys) ? raw.publicKeys : []),
  ].filter((key): key is string => typeof key === "string" && key.trim().length > 0);

  if (keys.length > 0) {
    config.publicKeys = keys.map((key) => key.trim());
  }

  // A block with nothing usable in it is the same as no block: better to ship no
  // config file than one that configures nothing.
  return Object.keys(config).length > 0 ? config : null;
};

const readFeedSplit = (raw: Record<string, unknown>): FeedSplit | null => {
  const split: FeedSplit = {};
  for (const key of ["web", "app"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      split[key] = value.trim();
    }
  }
  return Object.keys(split).length > 0 ? split : null;
};

/**
 * What state the app's `vidra.updates` block is in, which is a different
 * question from what {@link readUpdateConfig} could make of it.
 *
 * - `absent` — no block. The app removed it, or predates the template.
 * - `untouched` — the block is there and every value in it is blank: the shape
 *   a fresh scaffold ships, waiting for a URL. Says nothing, wants nothing.
 * - `edited` — somebody put something in it.
 *
 * The distinction exists for one reason. `{ "feedUrl": "…" }` parses to nothing
 * usable, so `readUpdateConfig` returns null — indistinguishable from an app
 * that wants no updates, except that somebody clearly typed something. Only
 * `vidra doctor` is in a position to notice.
 */
export type UpdateBlockState = "absent" | "untouched" | "edited";

export const readUpdateBlockState = (projectRoot: string): UpdateBlockState => {
  const raw = readUpdateBlock(projectRoot);
  if (!raw) return "absent";
  return isBlank(raw) ? "untouched" : "edited";
};

/** The raw `vidra.updates` object, unvalidated, or null when there is none. */
const readUpdateBlock = (projectRoot: string): Record<string, unknown> | null => {
  try {
    const pkg = fs.readJsonSync(path.join(projectRoot, "package.json")) as {
      vidra?: { updates?: unknown };
    };
    const updates = pkg?.vidra?.updates;
    return updates && typeof updates === "object" ? (updates as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** True for `""`, `[]`, `{}`, and any nesting of those. `false` is not blank. */
const isBlank = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.every(isBlank);
  if (value && typeof value === "object") return Object.values(value).every(isBlank);
  return false;
};

/**
 * The document `vidra build` stamps into the app, and the only update config
 * the running app ever sees.
 *
 * Deliberately a different shape from `package.json`. **That file describes the
 * app; this one describes one build of it** — fully resolved URLs, the channel
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

/** What {@link writeUpdateConfig} may set. `null` removes a key. */
export interface UpdateConfigPatch {
  feed?: string | FeedSplit | null;
  publicKeys?: string[] | null;
}

/**
 * Merges a patch into the app's `vidra.updates` block, in place.
 *
 * A merge rather than a write: `publicKeys` may already be there from
 * `vidra keygen`, and a command that adds a feed URL must not quietly drop it.
 *
 * The file's own indentation and trailing newline are preserved, because this
 * edits a file the developer owns and a diff full of reformatting is a diff
 * nobody reads.
 */
export const writeUpdateConfig = (
  projectRoot: string,
  patch: UpdateConfigPatch,
): UpdateConfig | null => {
  const pkgPath = path.join(projectRoot, "package.json");
  const source = fs.readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(source) as Record<string, unknown>;

  const vidra = (pkg.vidra ??= {}) as Record<string, unknown>;
  const updates = (vidra.updates ??= {}) as Record<string, unknown>;

  const apply = (key: string, next: unknown): void => {
    if (next === undefined) return;
    if (next === null) delete updates[key];
    else updates[key] = next;
  };

  apply("feed", patch.feed);
  apply("publicKeys", patch.publicKeys);

  fs.writeFileSync(pkgPath, serializeLike(source, pkg));
  return readUpdateConfig(projectRoot);
};

/** Re-serializes JSON with the indentation and final newline the file already had. */
const serializeLike = (original: string, value: unknown): string => {
  const indent = /^[ \t]+/m.exec(original.split("\n")[1] ?? "")?.[0] ?? "  ";
  const json = JSON.stringify(value, null, indent);
  return original.endsWith("\n") ? `${json}\n` : json;
};
