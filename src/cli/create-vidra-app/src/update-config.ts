import path from "node:path";
import fs from "fs-extra";

/**
 * The `vidra.updates` block of an app's own `package.json` — the single place a
 * developer configures updates, next to the version the same file already owns.
 *
 * ```json
 * { "vidra": { "updates": {
 *     "feedUrl": "https://updates.example.com/bundles.json",
 *     "native": { "feedUrl": "https://updates.example.com/app/" }
 * } } }
 * ```
 *
 * **A feed URL is the feature flag.** Every scaffolded app ships the whole
 * updater — both tiers wired, Velopack referenced, the entry points live — and
 * every part of it resolves to nothing until a URL says otherwise. There is no
 * second switch to forget: `feedUrl` turns the web-bundle tier on, and
 * `native.feedUrl` turns the whole-app tier on, at build time and at runtime
 * alike.
 *
 * `vidra build` stamps this block into the app as `vidra-updates.json`, which
 * the host reads at startup. Write it with `vidra updates init`.
 */
/**
 * The `native` sub-block: Velopack's half of the same surface.
 *
 * One `vidra.updates` block configures both tiers, and one prefix can serve
 * both: `releases.{channel}.json` and `bundles.json` never collide. The two
 * feeds are separate fields anyway, because the OTA one names a file
 * (`.../bundles.json`) and Velopack's names the directory it writes into.
 */
export interface NativeUpdateConfig {
  /** Base URL of the directory `vpk pack` writes into. */
  feedUrl?: string;
  /**
   * Velopack's channel, not Vidra's. Unset means Velopack's own default for the
   * platform: `win` / `osx`, the names `vpk pack` puts in
   * `releases.{channel}.json`.
   */
  channel?: string;
  enabled?: boolean;
  /**
   * Velopack's application id: the name of its install directory and the key
   * its feed is written under. Defaults to the host project's
   * `<ApplicationId>`, which is the app id the developer already chose.
   */
  packId?: string;
}

export interface UpdateConfig {
  feedUrl?: string;
  channel?: string;
  enabled?: boolean;
  /** Native (whole-app) updates. Absent means this app ships them the usual way. */
  native?: NativeUpdateConfig;
  /**
   * Base64 SPKI public keys the app will accept a manifest from. More than one
   * so a key can be rotated: publish under the new key while installed apps
   * still trust the old one, then drop the old one a release later.
   *
   * Configuring any key makes signatures **required** — an app that trusts a key
   * refuses an unsigned feed, which is the whole point.
   */
  publicKeys?: string[];
}

/** The name the host looks for, as a MAUI app-package asset. */
export const UPDATE_CONFIG_FILE = "vidra-updates.json";

/** Which tiers a config turns on. Absent config means neither. */
export interface UpdateTiers {
  /** Web-bundle (OTA) updates: `vidra bundle` publishes them, the app checks. */
  ota: boolean;
  /** Whole-app updates: `vidra build` packs a release, the app checks. */
  native: boolean;
}

/**
 * The one rule the whole feature turns on: **a tier is on when it has a feed
 * URL, and off when it does not.**
 *
 * `enabled: false` is the explicit off switch, kept beside the URL so a feed can
 * be silenced for a release without losing it. Each tier owns its own — the
 * top-level one sits beside the top-level `feedUrl` and means that feed, and
 * `native.enabled` means the native one. Neither reaches across, because a
 * switch that turns off something in another block is a switch people misread.
 *
 * The same rule runs on the other side, in C#: `VidraUpdateService` refuses to
 * check without a feed, and `NativeUpdateConfig.Resolve` defaults `Enabled` to
 * true so presence is all that is ever needed. This function exists so the CLI
 * reaches the same verdict as the app, from the same fields.
 */
export const enabledTiers = (config: UpdateConfig | null): UpdateTiers => ({
  ota: !!config?.feedUrl && config.enabled !== false,
  native: !!config?.native?.feedUrl && config.native.enabled !== false,
});

/**
 * Whether the app has a `vidra.updates` block at all, whatever is in it.
 *
 * Not the same question as {@link readUpdateConfig} returning something:
 * `{ "feedURL": "…" }` is a block that parses to nothing usable, which is the
 * exact shape a typo produces and is otherwise indistinguishable from an app
 * that wants no updates. Somebody has to be able to tell those apart, and it is
 * `vidra doctor` — the runtime deliberately cannot.
 */
export const hasUpdateBlock = (projectRoot: string): boolean => {
  try {
    const pkg = fs.readJsonSync(path.join(projectRoot, "package.json")) as {
      vidra?: { updates?: unknown };
    };
    const updates = pkg?.vidra?.updates;
    return !!updates && typeof updates === "object";
  } catch {
    return false;
  }
};

export const readUpdateConfig = (projectRoot: string): UpdateConfig | null => {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: unknown;
  try {
    pkg = fs.readJsonSync(pkgPath);
  } catch {
    return null;
  }

  const updates = (pkg as { vidra?: { updates?: unknown } })?.vidra?.updates;
  if (!updates || typeof updates !== "object") return null;

  const raw = updates as Record<string, unknown>;
  const config: UpdateConfig = {};

  if (typeof raw.feedUrl === "string" && raw.feedUrl.trim().length > 0) {
    config.feedUrl = raw.feedUrl.trim();
  }
  if (typeof raw.channel === "string" && raw.channel.trim().length > 0) {
    config.channel = raw.channel.trim();
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

  const native = readNativeConfig(raw.native);
  if (native) {
    config.native = native;
  }

  // A block with nothing usable in it is the same as no block: better to ship no
  // config file than one that configures nothing.
  return Object.keys(config).length > 0 ? config : null;
};

const readNativeConfig = (raw: unknown): NativeUpdateConfig | null => {
  if (!raw || typeof raw !== "object") return null;

  const source = raw as Record<string, unknown>;
  const native: NativeUpdateConfig = {};

  const text = (key: keyof NativeUpdateConfig): void => {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      native[key] = value.trim() as never;
    }
  };

  text("feedUrl");
  text("channel");
  text("packId");
  if (typeof source.enabled === "boolean") native.enabled = source.enabled;

  return Object.keys(native).length > 0 ? native : null;
};

/**
 * Writes (or removes) the stamped config next to the web assets. Removal
 * matters: an app that had a feed and no longer does must not keep shipping the
 * old one because the file happened to survive in `Resources/Raw`.
 */
export const stampUpdateConfig = (
  hostDir: string,
  config: UpdateConfig | null,
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
  feedUrl?: string | null;
  channel?: string | null;
  publicKeys?: string[] | null;
  native?: Partial<NativeUpdateConfig> | null;
}

/**
 * Merges a patch into the app's `vidra.updates` block, in place.
 *
 * A merge rather than a write: `publicKeys` may already be there from
 * `vidra keygen`, the native block may already have a `packId`, and a command
 * that adds a feed URL must not quietly drop either. Keys set to `null` are
 * removed, which is how a tier is turned back off.
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

  const apply = (target: Record<string, unknown>, key: string, next: unknown): void => {
    if (next === undefined) return;
    if (next === null) delete target[key];
    else target[key] = next;
  };

  apply(updates, "feedUrl", patch.feedUrl);
  apply(updates, "channel", patch.channel);
  apply(updates, "publicKeys", patch.publicKeys);

  if (patch.native === null) {
    delete updates.native;
  } else if (patch.native) {
    const native = (updates.native ??= {}) as Record<string, unknown>;
    apply(native, "feedUrl", patch.native.feedUrl);
    apply(native, "channel", patch.native.channel);
    apply(native, "packId", patch.native.packId);
  }

  fs.writeFileSync(pkgPath, serializeLike(source, pkg));
  return readUpdateConfig(projectRoot);
};

/** Re-serializes JSON with the indentation and final newline the file already had. */
const serializeLike = (original: string, value: unknown): string => {
  const indent = /^[ \t]+/m.exec(original.split("\n")[1] ?? "")?.[0] ?? "  ";
  const json = JSON.stringify(value, null, indent);
  return original.endsWith("\n") ? `${json}\n` : json;
};
