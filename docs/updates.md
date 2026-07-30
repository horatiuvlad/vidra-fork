# Over-the-air updates

Vidra can ship a new **web bundle** — your `ui/` build — to installed apps without
reinstalling anything. Native code is not updated this way; that still travels
through a normal release.

Updates are **off** until you ask for them.

## Turning them on

Two changes to a scaffolded app.

**1. Opt in, in `MauiProgram.cs`:**

```csharp
builder
    .UseMauiApp<App>()
    .UseVidra()
    .UseVidraUpdates();
```

**2. Point it at a feed, in your app's `package.json`:**

```json
{
  "vidra": {
    "update": {
      "feedUrl": "https://updates.example.com/bundles.json"
    }
  }
}
```

`vidra build` stamps that block into the app, so the feed URL lives next to the
version in the file that already owns it. Optional keys: `channel` (only entries
labelled with the same one are considered) and `enabled: false` (a kill switch
that still lets an already-downloaded bundle finish promoting).

## Publishing

```bash
npm version patch          # bundles are ordered by your app's version
npx vidra bundle           # builds ui/, writes dist/bundle-<version>-<hash>.zip + dist/bundles.json
```

Then upload everything in `dist/` to your host — **`bundles.json` last**, so no
client ever reads an index that points at an archive you have not finished
uploading. Any static host works: S3, Blob, B2, a CDN, nginx, a file share. The
index is yours, so there is nothing to adapt per provider.

`vidra bundle` writes both **contract fingerprints** into each entry, read from
generated files rather than configured. That matters — see below.

## What decides whether an update installs

Two independent questions:

| Question | Answered by |
|---|---|
| *May I?* | both contract fingerprints matching the running app |
| *Should I?* | the bundle's version being greater than what is running |

The fingerprints are SHA-256 over the canonical bridge contract manifest — one
for Vidra's own contracts (`core`), one for yours (`app`). A native rebuild that
changes no API keeps the same fingerprint; any API change alters it. So a bundle
can never call a bridge member the installed binary does not have: it simply is
not installable there, and the app keeps running what it has.

Practically: **if you change a `[BridgeModule]`, `[BridgeEventContract]` or
`[JsContract]`, existing installs stop accepting new bundles until you ship a
native release.** That is the intended behaviour, and `vidra bundle` prints the
fingerprints so you can see when they move.

## What happens at runtime

- **On launch**, before the WebView loads, the host promotes anything downloaded
  earlier and decides which directory serves. The bundle that shipped inside the
  app is always present and is what serves when nothing else can.
- **In the background**, a few seconds after launch, it fetches the feed, picks
  the newest installable entry, downloads it, verifies its `sha256`, extracts it,
  and stages it. **Nothing swaps mid-session.**
- **On the next launch** the staged bundle is promoted *on probation*.
- **Probation clears** when the bundle proves it runs. If it does not, after two
  launches the app rolls back to the previous bundle — or to the one it shipped
  with — and never installs that bundle again.

State lives in `<app data>/vidra/bundles/`, one directory per bundle plus a
`state.json`. Bundles that nothing references are pruned.

## Security

The `sha256` in the feed is mandatory and verified before an archive is
unpacked; archives that try to write outside their own directory are refused
outright. That protects against a corrupted or truncated download.

It does **not** protect against a compromised feed host, which could publish a
valid archive with a matching hash. No store review sits between your CDN and
code execution on your users' machines. **Manifest signing (ed25519, public key
baked into the app) is not implemented yet** — treat OTA as suitable for feeds
you control tightly until it is.

## Testing a feed locally

A directory is a valid feed. Point `feedUrl` at a path, or serve it:

```bash
cd dist && python3 -m http.server 8099
# "feedUrl": "http://127.0.0.1:8099/bundles.json"
```

`VIDRA_UPDATE_FEED_URL` overrides the stamped feed at runtime, which is the
easiest way to point a build at staging without rebuilding it.

## Reference

| Variable | Effect |
|---|---|
| `VIDRA_UPDATE_FEED_URL` | Overrides the feed URL (or a local directory path) |
| `VIDRA_UPDATE_CHANNEL` | Overrides the channel |
| `VIDRA_ASSET_ROOT` | Serves the WebView from a directory, bypassing updates entirely |

`vidra dev` never checks for updates — it serves the Vite dev server.

## Limits worth knowing

- A bundle counts as "booted" once its JavaScript has run far enough to
  construct the Vidra client. An app whose own code throws *after* that still
  counts as booted and will not roll back.
- The feed is not signed (above).
- No delta bundles, no staged rollouts, no in-app update UI. The version that is
  running is available to native code through `IVidraUpdates`.
