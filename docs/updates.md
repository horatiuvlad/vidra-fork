# Updates

Vidra apps update in two tiers. Use either, both, or neither.

| | ships | mechanism | needs |
|---|---|---|---|
| **Over-the-air** | your `ui/` build | a new bundle, applied on the next launch | nothing extra |
| **[Native](#native-whole-app-updates)** | the whole app, native code included | Velopack replaces the install in place | `Vidra.Updates.Native` + `vpk` |

Most of this document is about the first. It is the one you reach for weekly: a
bundle is small, needs no installer, and can never get ahead of the binary —
it installs only when its contract fingerprints match the running host. The
second is for the releases that change C#.

Both are **off** until you ask for them, and both read one `vidra.updates` block.

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
    "updates": {
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
npx vidra bundle --merge-from https://updates.example.com/bundles.json
```

That builds `ui/`, writes `dist/bundle-<version>-<hash>.zip`, and produces a
`dist/bundles.json` containing your new entry **plus everything already
published**. Then upload — see the recipes below.

`vidra bundle` writes both **contract fingerprints** into each entry, read from
generated files rather than configured. That matters — see below.

### Always merge into the live index

`--merge-from` fetches the index you are actually serving and adds to it. Without
it, the base is whatever `dist/bundles.json` happens to be on disk — which on a
clean CI checkout is nothing, so you would publish an index containing only the
newest entry.

That is not just untidy. A bundle is only installable by an app whose contract
fingerprints match it, so if you have ever shipped a native release that changed
a contract, older entries are the only thing older installs can use. Dropping
them strands exactly those users, silently, with a feed that looks perfectly
healthy.

If the index is not there yet, `--merge-from` says so and publishes the first
one. If it cannot be fetched, the publish **fails** rather than starting empty.

When you sign, `vidra bundle` also verifies that the index it is merging was
signed by your key, and refuses otherwise — merging a feed someone else has
written to and then signing the result would publish their entries under your
signature.

### Uploading

Two rules, whatever the host:

1. **Archives first, `bundles.json` (and `.sig`) last.** A client that reads an
   index naming an archive you have not finished uploading gets a 404. This is
   why a bulk `sync` of `dist/` is wrong — it gives no ordering guarantee.
2. **Never delete on sync.** Old archives are still referenced by the entries
   older installs depend on.

**S3-compatible (R2, B2, Spaces, Wasabi, S3):**

```bash
aws s3 cp dist/ s3://$BUCKET/stable/ --recursive --exclude "bundles.json*" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp dist/bundles.json s3://$BUCKET/stable/ --cache-control "no-cache"
aws s3 cp dist/bundles.json.sig s3://$BUCKET/stable/ --cache-control "no-cache"
```

**Cloudflare R2 via wrangler:**

```bash
for f in dist/bundle-*.zip; do wrangler r2 object put "$BUCKET/stable/$(basename "$f")" --file "$f"; done
wrangler r2 object put "$BUCKET/stable/bundles.json"     --file dist/bundles.json     --cache-control "no-cache"
wrangler r2 object put "$BUCKET/stable/bundles.json.sig" --file dist/bundles.json.sig --cache-control "no-cache"
```

**GitHub Releases** (use a fixed tag so the URL is stable):

```bash
gh release upload updates dist/bundle-*.zip --clobber
gh release upload updates dist/bundles.json dist/bundles.json.sig --clobber
# feedUrl: https://github.com/<owner>/<repo>/releases/download/updates/bundles.json
```

Cache headers matter more than they look: archive names contain the hash, so they
can cache forever, but an index cached for hours means your rollback does not
reach anyone.

### In CI

```yaml
- run: npm version ${{ inputs.bump }} --no-git-tag-version
- run: npx vidra bundle --merge-from https://updates.example.com/bundles.json
  env:
    VIDRA_UPDATE_SIGNING_KEY: ${{ secrets.VIDRA_UPDATE_SIGNING_KEY }}
- run: ./scripts/upload-feed.sh        # the two-step upload above
```

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

### …and whether the bundle already installed still applies

Both questions are asked when a bundle is chosen from the feed — which answers
them against whichever binary was running at the time. Ship a native release that
changes a contract, and the bundle a user already has was chosen against the
*old* one: the same mismatch the fingerprints exist to prevent, arriving from the
other direction.

So the app records what each installed bundle was chosen against and rechecks it
on every launch, before anything is promoted. A bundle whose fingerprints no
longer match the running binary — or that is older than the one your native
release shipped with — is set aside, and the embedded copy serves until a check
finds a bundle built for the new contracts.

Set aside, not blocked: nothing is wrong with that bundle, and rolling the native
release back makes it installable again.

A bundle whose contents are **byte-identical** to the one already serving is
skipped too, whatever its version says. `vidra bundle` writes a deterministic
archive, so an unchanged `ui/` republished under a new version has the same
`sha256` — and downloading it again would gain nothing.

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
    "updates": {
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

## Native (whole-app) updates

For the releases that change C#. Vidra drives [Velopack](https://velopack.io) —
`vidra build` shells out to `vpk`, and the app talks to Velopack's client
directly. Vidra owns neither; what it adds is the plumbing, and a locator that
teaches Velopack what Mac Catalyst is.

Four steps, and `npx vidra doctor` names whichever one is missing.

**1. Install the tool** (once per machine):

```bash
dotnet tool install -g vpk
```

**2. Reference the package** in your host `.csproj`:

```xml
<PackageReference Include="Vidra.Updates.Native" Version="…" />
```

**3. Uncomment the two lines** the template already shipped in
`Platforms/MacCatalyst/Program.cs` and `Platforms/Windows/Program.cs`, and add
the builder call:

```csharp
// Platforms/*/Program.cs — before anything else runs
VelopackApp.Build().UseVidraLocator().Run();
```

```csharp
builder.UseVidra().UseVidraNativeUpdates();
```

That call has to be literally in `Main`: on install, update and uninstall
Velopack re-launches the app with a `--veloapp-*` argument and expects it to do
that work and exit without showing a window, and `vpk pack` inspects the
assembly and warns when it finds the call anywhere else. Every scaffolded app
already has the entry points, because entry-point shape is the one thing a
package reference cannot retrofit.

**4. Point it at a feed:**

```json
{
  "vidra": {
    "updates": {
      "feedUrl": "https://updates.example.com/bundles.json",
      "native": { "feedUrl": "https://updates.example.com/app/" }
    }
  }
}
```

The two `feedUrl`s differ in kind: the OTA one names a *file*, the native one
names the *directory* `vpk` writes into. They can be the same prefix —
`releases.{channel}.json` and `bundles.json` never collide.

Then release:

```bash
npm version patch
npx vidra build --target windows --native-update
npx vidra build --target macos   --native-update   # on a Mac
```

Each build downloads the live feed into `dist/release/` first and packs into it,
which is what produces deltas and what keeps older entries alive. Upload the
whole of `dist/release/`, payloads first and the index last. `vidra bundle --out
dist/release` puts both tiers under one prefix.

What comes out, beside the usual artifact:

| file | what it is |
|---|---|
| `dist/<App>-<version>-Setup.exe` | the Windows installer — the recommended download |
| `dist/<App>-<version>-windows.zip` | Velopack's portable archive, under the name the ZIP target always used |
| `dist/<App>-<version>-macos.dmg` | the DMG, now wrapping the *packed* `.app` |
| `dist/release/` | the feed: packages, deltas, `releases.{channel}.json` |

### Things worth knowing before you ship one

- **`vpk` refuses to re-publish a version.** Packing a version equal to or lower
  than the newest in the feed fails and writes nothing — no overwrite, no second
  package under one number. Bump the version.
- **Every release keeps a full package in the feed**, not just a delta: older
  installs delta against them, so they cannot be pruned blindly.
- **Velopack signs everything it packages**, including its own `Setup.exe` and
  `Update.exe`, given a certificate — the binaries SmartScreen actually judges.
  It uses the same identity `vidra build` resolved.
- **On macOS `vpk` re-signs with `--deep`**, which Vidra's own signing avoids.
  The result verifies strictly, and whether it *notarizes* has never been
  tested: that needs a paid Apple Developer membership, and no CI here has one.
- **Mac Catalyst is not a platform Velopack advertises.** Its client picks a
  locator from `RuntimeInformation.IsOSPlatform`, which answers false for OSX on
  Catalyst. `UseVidraLocator()` supplies the missing one; without it,
  `VelopackApp.Run()` throws before any update logic executes.
- **The two tiers do not coordinate, and do not need to.** Both check in the
  background, both apply on the next launch, and the native one wins the launch
  it lands on. A native update cannot destroy OTA state — app data lives outside
  the directory Velopack replaces — and a bundle chosen against the old contract
  is dropped at startup when the fingerprints stop matching.

## Reference

| Variable | Effect |
|---|---|
| `VIDRA_UPDATE_FEED_URL` | Overrides the feed URL (or a local directory path) |
| `VIDRA_UPDATE_CHANNEL` | Overrides the channel |
| `VIDRA_ASSET_ROOT` | Serves the WebView from a directory, bypassing updates entirely |
| `VIDRA_UPDATE_SIGNING_KEY` | The signing key PEM, for `vidra bundle` in CI |
| `VIDRA_NATIVE_UPDATE_FEED_URL` | Overrides the native feed directory |
| `VIDRA_NATIVE_UPDATE_CHANNEL` | Overrides the native channel (default: `win` / `osx`) |
| `VIDRA_NATIVE_UPDATE_ENABLED` | `0` turns native updates off for one run |
| `VIDRA_MACOS_KEYCHAIN` | A non-default keychain for `vpk` to sign from |

`vidra dev` never checks for updates — it serves the Vite dev server.

## Upgrading an existing Windows app

On Windows the web assets are served from `https://vidra.invalid/` rather than
MAUI's default `https://appdir/`, so that an updated bundle keeps the same origin
as the one it replaces. Origin-scoped storage — `localStorage`, IndexedDB,
cookies, caches — is **reset once** when an existing app upgrades to this version
of Vidra, and is stable from then on. Apps that store nothing in the WebView are
unaffected. macOS is unchanged.

## Limits worth knowing

- A bundle counts as "booted" once its JavaScript has run far enough to
  construct the Vidra client. An app whose own code throws *after* that still
  counts as booted and will not roll back.
- No delta bundles, no staged rollouts, no in-app update UI. The version that is
  running is available to native code through `IVidraUpdates`.
