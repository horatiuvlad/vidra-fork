import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createZip, readDirectoryEntries, crc32 } from "../zip.js";
import {
  loadBaseManifest,
  mergeManifest,
  parseBundleOptions,
  readManifest,
  type BundleManifest,
} from "../commands/bundle.js";
import { generateKeyPair, signManifest } from "../manifest-signing.js";
import { readUpdateConfig, stampUpdateConfig, UPDATE_CONFIG_FILE } from "../update-config.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vidra-bundle-"));

describe("zip writer", () => {
  it("produces an archive a real zip reader accepts", () => {
    const dir = tmp();
    const file = path.join(dir, "bundle.zip");
    fs.writeFileSync(
      file,
      createZip([
        { name: "index.html", content: Buffer.from("<h1>hi</h1>") },
        { name: "assets/app.js", content: Buffer.from("console.log(1)") },
      ]),
    );

    // Checked with an independent implementation on purpose — a hand-written
    // archiver that only satisfies its own reader has proved nothing.
    const listing = execFileSync("python3", [
      "-c",
      [
        "import zipfile,sys",
        "z=zipfile.ZipFile(sys.argv[1])",
        "assert z.testzip() is None",
        "print(':'.join(sorted(z.namelist())))",
        "print(z.read('index.html').decode())",
      ].join("\n"),
      file,
    ])
      .toString()
      .trim()
      .split("\n");

    expect(listing[0]).toBe("assets/app.js:index.html");
    expect(listing[1]).toBe("<h1>hi</h1>");
  });

  it("is deterministic, so republishing an unchanged bundle is a no-op", () => {
    const entries = [
      { name: "b.js", content: Buffer.from("second") },
      { name: "a.js", content: Buffer.from("first") },
    ];
    const reversed = [...entries].reverse();

    // Same content in a different order, built at a different moment, must give
    // the same bytes — otherwise every publish is a new sha256 for users to
    // download.
    expect(createZip(entries).equals(createZip(reversed))).toBe(true);
  });

  it("computes the CRC32 the format specifies", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("reads a directory tree with forward-slash paths", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");

    expect(readDirectoryEntries(dir).map((e) => e.name).sort()).toEqual([
      "assets/app.js",
      "index.html",
    ]);
  });
});

describe("bundle options", () => {
  it("reads the flags a publisher actually passes", () => {
    // The first two flags are the ones a mis-padded parseArgs drops, which is
    // how this shipped once: `vidra bundle` rebuilt the UI and wrote to the
    // default directory while reporting success.
    expect(parseBundleOptions(["--skip-build", "--out", "/tmp/feed", "--channel", "beta"])).toEqual({
      out: "/tmp/feed",
      channel: "beta",
      skipBuild: true,
    });
  });

  it("accepts --key=value too", () => {
    expect(parseBundleOptions(["--out=feed", "--channel=stable"])).toMatchObject({
      out: "feed",
      channel: "stable",
    });
  });

  it("defaults to dist/ and a real build", () => {
    expect(parseBundleOptions([])).toEqual({
      out: "dist",
      channel: undefined,
      skipBuild: false,
      sign: undefined,
      mergeFrom: undefined,
    });
  });

  it("reads --merge-from and --sign", () => {
    expect(parseBundleOptions(["--merge-from", "https://e.com/bundles.json", "--sign", "k.pem"]))
      .toMatchObject({ mergeFrom: "https://e.com/bundles.json", sign: "k.pem" });
  });
});

describe("feed manifest", () => {
  const entry = (version: string, sha: string, channel?: string) => ({
    version,
    url: `bundle-${version}.zip`,
    sha256: sha,
    size: 100,
    coreFingerprint: "core",
    appFingerprint: "app",
    ...(channel ? { channel } : {}),
  });

  it("appends a new version", () => {
    const manifest = mergeManifest({ schema: 1, bundles: [entry("1.0.0", "aaa")] }, entry("1.1.0", "bbb"));

    expect(manifest.bundles.map((b) => b.version)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("replaces a republished version instead of duplicating it", () => {
    // Two entries claiming one version is a feed that behaves differently
    // depending on which the client happens to pick.
    const manifest = mergeManifest({ schema: 1, bundles: [entry("1.0.0", "aaa")] }, entry("1.0.0", "ccc"));

    expect(manifest.bundles).toHaveLength(1);
    expect(manifest.bundles[0]!.sha256).toBe("ccc");
  });

  it("keeps the same version on a different channel", () => {
    const manifest = mergeManifest(
      { schema: 1, bundles: [entry("1.0.0", "aaa")] },
      entry("1.0.0", "ccc", "beta"),
    );

    expect(manifest.bundles).toHaveLength(2);
  });

  it("starts fresh rather than trusting a manifest from a newer schema", () => {
    const dir = tmp();
    const file = path.join(dir, "bundles.json");
    fs.writeFileSync(file, JSON.stringify({ schema: 99, bundles: [entry("9.9.9", "zzz")] }));

    expect(readManifest(file)).toEqual({ schema: 1, bundles: [] } satisfies BundleManifest);
  });

  it("survives a corrupt manifest", () => {
    const dir = tmp();
    const file = path.join(dir, "bundles.json");
    fs.writeFileSync(file, "{ not json");

    expect(readManifest(file).bundles).toEqual([]);
  });
});

describe("vidra.update config", () => {
  const project = (pkg: unknown): string => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    return dir;
  };

  it("reads the block from the app's package.json", () => {
    const root = project({
      name: "app",
      version: "1.0.0",
      vidra: { update: { feedUrl: "https://example.com/bundles.json", channel: "beta" } },
    });

    expect(readUpdateConfig(root)).toEqual({
      feedUrl: "https://example.com/bundles.json",
      channel: "beta",
    });
  });

  it("treats a missing or empty block as no configuration", () => {
    expect(readUpdateConfig(project({ name: "app" }))).toBeNull();
    expect(readUpdateConfig(project({ name: "app", vidra: { update: {} } }))).toBeNull();
    expect(readUpdateConfig(project({ name: "app", vidra: { update: { feedUrl: "  " } } }))).toBeNull();
  });

  it("reads a single publicKey and a publicKeys array", () => {
    const single = project({
      name: "app",
      vidra: { update: { feedUrl: "https://e.com/b.json", publicKey: "AAA" } },
    });
    const many = project({
      name: "app",
      vidra: { update: { feedUrl: "https://e.com/b.json", publicKeys: ["AAA", "BBB"] } },
    });

    expect(readUpdateConfig(single)?.publicKeys).toEqual(["AAA"]);
    // Several so a key can be rotated: publish under the new one while
    // installed apps still trust the old one.
    expect(readUpdateConfig(many)?.publicKeys).toEqual(["AAA", "BBB"]);
  });

  it("has no keys when none are configured, which is what allows an unsigned feed", () => {
    const root = project({ name: "app", vidra: { update: { feedUrl: "https://e.com/b.json" } } });

    expect(readUpdateConfig(root)?.publicKeys).toBeUndefined();
  });

  it("stamps the keys so the host can require a signature", () => {
    const hostDir = tmp();
    stampUpdateConfig(hostDir, { feedUrl: "https://e.com/b.json", publicKeys: ["AAA"] });

    const stamped = path.join(hostDir, "Resources", "Raw", UPDATE_CONFIG_FILE);
    expect(JSON.parse(fs.readFileSync(stamped, "utf8")).publicKeys).toEqual(["AAA"]);
  });

  it("keeps an explicit enabled:false", () => {
    const root = project({
      name: "app",
      vidra: { update: { feedUrl: "https://example.com/bundles.json", enabled: false } },
    });

    expect(readUpdateConfig(root)?.enabled).toBe(false);
  });

  it("stamps the config into Resources/Raw", () => {
    const hostDir = tmp();
    stampUpdateConfig(hostDir, { feedUrl: "https://example.com/bundles.json" });

    const stamped = path.join(hostDir, "Resources", "Raw", UPDATE_CONFIG_FILE);
    expect(JSON.parse(fs.readFileSync(stamped, "utf8"))).toEqual({
      feedUrl: "https://example.com/bundles.json",
    });
  });

  it("removes a stale config when the block is gone", () => {
    // Otherwise an app that dropped its feed keeps shipping the old one, and
    // keeps updating from a host the developer thinks they disconnected.
    const hostDir = tmp();
    stampUpdateConfig(hostDir, { feedUrl: "https://example.com/bundles.json" });
    stampUpdateConfig(hostDir, null);

    expect(fs.existsSync(path.join(hostDir, "Resources", "Raw", UPDATE_CONFIG_FILE))).toBe(false);
  });
});

describe("merging into a feed that already exists", () => {
  const existing = {
    schema: 1,
    bundles: [
      {
        version: "1.0.0",
        url: "bundle-1.0.0.zip",
        sha256: "aaa",
        size: 10,
        // An app built against this older contract can install nothing else, so
        // dropping this entry strands it.
        coreFingerprint: "old-core",
        appFingerprint: "old-app",
      },
    ],
  };

  const feedDir = (contents?: unknown): string => {
    const dir = tmp();
    if (contents) fs.writeFileSync(path.join(dir, "bundles.json"), JSON.stringify(contents, null, 2));
    return dir;
  };

  it("keeps the entries already published", async () => {
    const base = await loadBaseManifest(
      { out: "dist", skipBuild: true, mergeFrom: feedDir(existing) },
      tmp(),
      null,
    );

    expect(base.bundles.map((b) => b.version)).toEqual(["1.0.0"]);
  });

  it("starts empty when the feed does not exist yet", async () => {
    const base = await loadBaseManifest(
      { out: "dist", skipBuild: true, mergeFrom: path.join(tmp(), "nothing-here") },
      tmp(),
      null,
    );

    expect(base.bundles).toEqual([]);
  });

  it("falls back to the out directory when no source is given", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "bundles.json"), JSON.stringify(existing));

    const base = await loadBaseManifest({ out, skipBuild: true }, out, null);

    expect(base.bundles).toHaveLength(1);
  });

  it("refuses to re-sign an index its own key did not sign", async () => {
    // Otherwise: an attacker injects entries into your feed, your next publish
    // merges them, signs them, and every installed app trusts them.
    const { privateKeyPem } = generateKeyPair();
    const attacker = generateKeyPair();
    const dir = feedDir(existing);
    fs.writeFileSync(
      path.join(dir, "bundles.json.sig"),
      JSON.stringify(
        signManifest(fs.readFileSync(path.join(dir, "bundles.json")), attacker.privateKeyPem),
      ),
    );

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exited");
    }) as never);

    try {
      await expect(
        loadBaseManifest({ out: "dist", skipBuild: true, mergeFrom: dir }, tmp(), privateKeyPem),
      ).rejects.toThrow("exited");
    } finally {
      exit.mockRestore();
    }
  });

  it("merges an index signed by its own key", async () => {
    const { privateKeyPem } = generateKeyPair();
    const dir = feedDir(existing);
    fs.writeFileSync(
      path.join(dir, "bundles.json.sig"),
      JSON.stringify(
        signManifest(fs.readFileSync(path.join(dir, "bundles.json")), privateKeyPem),
      ),
    );

    const base = await loadBaseManifest(
      { out: "dist", skipBuild: true, mergeFrom: dir },
      tmp(),
      privateKeyPem,
    );

    expect(base.bundles).toHaveLength(1);
  });
});
