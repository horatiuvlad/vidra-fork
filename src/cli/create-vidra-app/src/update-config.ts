import path from "node:path";
import fs from "fs-extra";

/**
 * The `vidra.update` block of an app's own `package.json` — the single place a
 * developer configures updates, next to the version the same file already owns.
 *
 * ```json
 * { "vidra": { "update": { "feedUrl": "https://updates.example.com/bundles.json" } } }
 * ```
 *
 * `vidra build` stamps it into the app bundle as `vidra-update.json`, which the
 * host reads at startup. No block means no feed, which means the updater does
 * nothing at all.
 */
export interface UpdateConfig {
  feedUrl?: string;
  channel?: string;
  enabled?: boolean;
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
export const UPDATE_CONFIG_FILE = "vidra-update.json";

export const readUpdateConfig = (projectRoot: string): UpdateConfig | null => {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: unknown;
  try {
    pkg = fs.readJsonSync(pkgPath);
  } catch {
    return null;
  }

  const update = (pkg as { vidra?: { update?: unknown } })?.vidra?.update;
  if (!update || typeof update !== "object") return null;

  const raw = update as Record<string, unknown>;
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

  // A block with nothing usable in it is the same as no block: better to ship no
  // config file than one that configures nothing.
  return Object.keys(config).length > 0 ? config : null;
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
