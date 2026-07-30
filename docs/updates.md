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

## Signing the feed

Two different questions, and you want both answered:

| Question | Answered by |
|---|---|
| did this archive arrive intact? | the `sha256` on each entry |
| did *I* publish this index? | the signature over `bundles.json` |

Only the second one protects you from your own feed host. A host that can serve
a manifest can serve a matching archive too, and there is no store review between
your CDN and code running on your users' machines. **Sign the feed before it is
public.**

```bash
npx vidra keygen                  # writes vidra-signing-key.pem (+ .pub)
```

Add the public half to your app's `package.json` and rebuild:

```json
{
  "vidra": {
    "update": {
      "feedUrl": "https://updates.example.com/bundles.json",
      "publicKeys": ["MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."]
    }
  }
}
```

Then publish signed:

```bash
npx vidra bundle --sign vidra-signing-key.pem
# or, in CI:  VIDRA_UPDATE_SIGNING_KEY="$(cat key.pem)" npx vidra bundle
```

That writes `bundles.json.sig` next to the manifest — upload both.

**Configuring any key makes signatures mandatory.** An app that trusts a key
refuses an unsigned feed, a feed signed by another key, and a manifest edited
after signing. That is the point: dropping the signature file is exactly what
someone who cannot forge one would try. An app with **no** keys configured
accepts an unsigned feed and says so in its log on every check.

`vidra bundle` refuses to publish unsigned when your `package.json` trusts a key,
and refuses to publish signed by a key your app does not trust — either would
produce a feed that looks fine and reaches nobody.

### Rotating a key

`publicKeys` is a list. Add the new key alongside the old one and ship a release;
once installed apps have it, start signing with the new key; drop the old one a
release later. Skipping the overlap strands everyone who has not updated the
binary.

### Keeping the key

Whoever holds `vidra-signing-key.pem` can run code on every machine your app is
installed on. Never commit it; back it up somewhere you would back up a
production credential; in CI pass it as a secret in `VIDRA_UPDATE_SIGNING_KEY`.
Losing it means shipping a new binary with a new key before you can publish
again.

### Algorithm

ECDSA P-256 with SHA-256, DER-encoded, over the exact bytes of `bundles.json`.
The signature is detached (`bundles.json.sig`) rather than embedded, so neither
side has to agree on a canonical JSON serialization — a disagreement there is a
signature that silently stops verifying.

Not ed25519, which the design originally called for: .NET's built-in Ed25519 is
approved but not shipping until .NET 11 (`dotnet/runtime#63174`), and the
alternative was a crypto dependency inside every Vidra app whether or not it uses
updates. Node and .NET both do P-256 natively.

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
| `VIDRA_UPDATE_SIGNING_KEY` | The signing key PEM, for `vidra bundle` in CI |

`vidra dev` never checks for updates — it serves the Vite dev server.

## Limits worth knowing

- A bundle counts as "booted" once its JavaScript has run far enough to
  construct the Vidra client. An app whose own code throws *after* that still
  counts as booted and will not roll back.
- No delta bundles, no staged rollouts, no in-app update UI. The version that is
  running is available to native code through `IVidraUpdates`.
