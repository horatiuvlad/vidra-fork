import path from "node:path";
import { parseArgs } from "../utils.js";
import { detectProject } from "../project.js";
import { enabledTiers, readUpdateConfig, writeUpdateConfig } from "../update-config.js";
import { writeSigningKeyPair } from "./keygen.js";
import { resolveVpk } from "../velopack.js";
import {
  amber,
  dim,
  footer,
  header,
  lime,
  row,
  STEP_LABEL_WIDTH as LABEL_WIDTH,
  value,
} from "../theme.js";

/**
 * `vidra updates` — reading and writing the only switch there is.
 *
 * Every scaffolded app already carries the whole updater *and* both feed URLs,
 * blank, in its own `package.json`. Typing one in is the entire opt-in, so this
 * command is a convenience rather than a gate: `init` writes the same fields a
 * hand-edit would (deriving the native URL from the OTA one, and wiring a
 * signing key if asked), and `vidra updates` with no arguments reads back which
 * tiers that left on.
 */
export const updatesCommand = async (argv: string[]): Promise<void> => {
  const args = parseArgs(["_", "_", ...argv]);
  const sub = (args._ as string[])[0] ?? "status";

  switch (sub) {
    case "status":
      printStatus();
      break;
    case "init":
      await initUpdates(args);
      break;
    default:
      console.error(
        row({ glyph: "error", detail: dim(`unknown subcommand: vidra updates ${sub}`) }),
      );
      console.error(footer(dim("try: vidra updates · vidra updates init --feed <url>")));
      process.exit(1);
  }
};

/**
 * Derives the native feed from the OTA one: the same directory, since the OTA
 * URL names a file inside it and Velopack's names the directory itself.
 *
 * They are allowed to share it — `bundles.json` and `releases.{channel}.json`
 * never collide — and sharing is what most people want, so `--native` with no
 * value means "the same place".
 */
export const deriveNativeFeedUrl = (otaFeedUrl: string): string => {
  const trimmed = otaFeedUrl.trim();
  const cut = trimmed.lastIndexOf("/");
  // No slash at all is a URL we do not understand well enough to rewrite; hand
  // it back and let the developer see what was written.
  if (cut < 0) return trimmed;
  return trimmed.slice(0, cut + 1);
};

const initUpdates = async (args: ReturnType<typeof parseArgs>): Promise<void> => {
  const project = detectProject(process.cwd());
  const existing = readUpdateConfig(project.root);
  const force = !!args.force;

  const feed = typeof args.feed === "string" ? args.feed.trim() : null;
  const nativeArg = args.native;
  const channel = typeof args.channel === "string" ? args.channel.trim() : null;

  if (!feed && nativeArg === undefined) {
    console.error(row({ glyph: "error", detail: dim("nothing to configure") }));
    console.error(
      footer(
        dim(
          `pass a feed: ${lime("vidra updates init --feed")} ${value("https://updates.example.com/bundles.json")}`,
        ),
      ),
    );
    process.exit(1);
  }

  if (nativeArg === true && !feed) {
    console.error(
      row({ glyph: "error", detail: dim("--native has nothing to derive from without --feed") }),
    );
    console.error(footer(dim("give it a URL of its own: --native https://updates.example.com/app/")));
    process.exit(1);
  }

  // `--native` alone means "same place as the web bundles"; `--native <url>`
  // names its own. Both are ordinary: one host for everything is the common
  // case, and a separate one is what you do when the app archives are big
  // enough to want their own bucket.
  const nativeFeed =
    typeof nativeArg === "string"
      ? nativeArg.trim()
      : nativeArg === true
        ? deriveNativeFeedUrl(feed!)
        : null;

  // Refusing to silently repoint a live feed is the same rule as `keygen`: apps
  // already installed are looking at the old URL, and nothing about that is
  // recoverable from the terminal after the fact.
  const clash =
    (feed && existing?.feedUrl && existing.feedUrl !== feed && "feedUrl") ||
    (nativeFeed &&
      existing?.native?.feedUrl &&
      existing.native.feedUrl !== nativeFeed &&
      "native.feedUrl") ||
    null;

  if (clash && !force) {
    console.error(
      row({
        glyph: "error",
        label: "already set",
        labelWidth: LABEL_WIDTH,
        detail: dim(
          `vidra.updates.${clash} already points somewhere else — installed apps are checking that URL`,
        ),
      }),
    );
    console.error(footer(dim("pass --force if you mean to move the feed")));
    process.exit(1);
  }

  console.log(header("updates", "init"));

  const written = writeUpdateConfig(project.root, {
    ...(feed ? { feedUrl: feed } : {}),
    ...(channel ? { channel } : {}),
    ...(nativeFeed ? { native: { feedUrl: nativeFeed } } : {}),
  });

  if (feed) {
    console.log(
      row({
        glyph: "done",
        label: "web bundle",
        labelWidth: LABEL_WIDTH,
        detail: `${value(feed)} ${dim("— npx vidra bundle publishes here")}`,
      }),
    );
  }

  if (nativeFeed) {
    console.log(
      row({
        glyph: "done",
        label: "whole app",
        labelWidth: LABEL_WIDTH,
        detail: `${value(nativeFeed)} ${dim("— npx vidra build packs a release here")}`,
      }),
    );
  }

  if (channel) {
    console.log(
      row({ glyph: "done", label: "channel", labelWidth: LABEL_WIDTH, detail: value(channel) }),
    );
  }

  if (args.keygen) {
    signWithNewKey(project.root, force);
  }

  console.log(
    row({
      glyph: "done",
      label: "package.json",
      labelWidth: LABEL_WIDTH,
      detail: dim("written — the app already carries the updater, so that is the whole setup"),
    }),
  );

  if (nativeFeed && !resolveVpk()) {
    console.log(
      row({
        glyph: "manual",
        label: "vpk",
        labelWidth: LABEL_WIDTH,
        detail: amber("not installed — `dotnet tool install -g vpk` before the next build"),
      }),
    );
  }

  if (!args.keygen && !(written?.publicKeys?.length ?? 0)) {
    console.log(
      row({
        glyph: "manual",
        label: "signing",
        labelWidth: LABEL_WIDTH,
        detail: dim("this feed is unsigned — anyone who can write to it can run code in your app"),
      }),
    );
    console.log(footer(dim(`sign it: ${lime("npx vidra updates init --keygen")}`)));
  }

  console.log();
  console.log(footer(dim(`next: ${lime("npm version patch")} ${dim("then")} ${lime("npx vidra bundle")}`)));
  console.log();
};

/** Generates a key, wires the public half, and says where the private half went. */
const signWithNewKey = (projectRoot: string, force: boolean): void => {
  const out = path.join(projectRoot, "vidra-signing-key.pem");
  const key = writeSigningKeyPair(out, force);

  if (!key) {
    console.log(
      row({
        glyph: "skip",
        label: "signing key",
        labelWidth: LABEL_WIDTH,
        detail: dim("vidra-signing-key.pem already exists — kept, and left trusted as it is"),
      }),
    );
    return;
  }

  // Appended, not replaced: `publicKeys` is a list precisely so a new key can
  // ship beside the old one for a release before the old one is dropped.
  const existing = readUpdateConfig(projectRoot)?.publicKeys ?? [];
  writeUpdateConfig(projectRoot, {
    publicKeys: [...existing.filter((k) => k !== key.publicKey), key.publicKey],
  });

  console.log(
    row({
      glyph: "done",
      label: "signing key",
      labelWidth: LABEL_WIDTH,
      detail: `${value("vidra-signing-key.pem")} ${dim(`(key ${key.keyId}) — trusted in package.json`)}`,
    }),
  );
  console.log(
    row({
      glyph: "manual",
      label: "keep it safe",
      labelWidth: LABEL_WIDTH,
      detail: amber("never commit it — it is the authority to run code in every installed copy"),
    }),
  );
};

const printStatus = (): void => {
  const project = detectProject(process.cwd());
  const config = readUpdateConfig(project.root);
  const tiers = enabledTiers(config);

  console.log(header("updates", project.projectName));

  tierRow("web bundle", tiers.ota, config?.feedUrl, config?.enabled, "vidra.updates.feedUrl");
  tierRow(
    "whole app",
    tiers.native,
    config?.native?.feedUrl,
    config?.native?.enabled,
    "vidra.updates.native.feedUrl",
  );

  const keys = config?.publicKeys?.length ?? 0;
  console.log(
    row({
      glyph: keys > 0 ? "done" : "manual",
      label: "signing",
      labelWidth: LABEL_WIDTH,
      detail:
        keys > 0
          ? dim(`${keys} trusted key${keys === 1 ? "" : "s"} — an unsigned feed is refused`)
          : dim("no trusted keys — this app accepts an unsigned feed"),
    }),
  );

  if (config?.channel) {
    console.log(
      row({ glyph: "done", label: "channel", labelWidth: LABEL_WIDTH, detail: value(config.channel) }),
    );
  }

  console.log();
  if (!tiers.ota && !tiers.native) {
    console.log(
      footer(
        dim(
          `the fields are in package.json waiting for a URL — fill one in, or: ${lime("npx vidra updates init --feed <url>")}`,
        ),
      ),
    );
  } else {
    console.log(footer(dim("read at build time and stamped into the app as vidra-updates.json")));
  }
  console.log();
};

const tierRow = (
  label: string,
  on: boolean,
  feedUrl: string | undefined,
  enabled: boolean | undefined,
  field: string,
): void => {
  console.log(
    row({
      glyph: on ? "done" : "skip",
      label,
      labelWidth: LABEL_WIDTH,
      detail: on
        ? value(feedUrl!)
        : feedUrl
          ? dim(`${feedUrl} ${amber("(enabled: false)")}`)
          : enabled === false
            ? dim(`off — ${field} is empty, and enabled is false`)
            : dim(`off — ${field} is empty`),
    }),
  );
};
