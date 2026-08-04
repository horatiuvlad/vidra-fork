# Updates

Vidra apps update in two tiers. Use either, both, or neither.

| | ships | mechanism | turned on by |
|---|---|---|---|
| **Web bundle** | your `ui/` build | a new bundle, applied on the next launch | `vidra build --web` |
| **[Whole app](#whole-app-updates)** | the app, native code included | Velopack replaces the install in place | `vidra build --app` |

Both are turned on by one field, `vidra.updates.feed`, and the flags above only
narrow what a given build publishes.

Most of this document is about the first. It is the one you reach for weekly: a
bundle is small, needs no installer, and can never get ahead of the binary —
it installs only when its contract fingerprints match the running host. The
second is for the releases that change C#.

## Turning them on

**A feed URL is the only switch**, and it is already in your `package.json`, empty:

```json
{ "vidra": { "updates": { "feed": "" } } }
```

Fill it in and both tiers start:

```json
{ "vidra": { "updates": { "feed": "https://updates.acme.com/notes/" } } }
```

That is a **directory**. The web tier reads `bundles.json` inside it; whole-app
releases use it as-is. The two indexes never collide, which is why one URL can
serve both.

Nothing else: every scaffolded app already ships the whole updater. Both tiers
are wired into `MauiProgram`, `Vidra.Updates.Native` is referenced, and
`VelopackApp.Build()...Run()` is live in both entry points, all of it resolving
to nothing until that URL does not.

There is a command, for scripts and for wiring a signing key in one step:

```bash
npx vidra updates init --feed https://updates.acme.com/notes/ --keygen
npx vidra updates                                    # which tiers are on
```

### Splitting the two tiers

When the app packages want their own bucket:

```json
{ "vidra": { "updates": { "feed": {
    "web": "https://cdn.acme.com/notes/",
    "app": "https://downloads.acme.com/notes/"
} } } }
```

Either half may be empty, which turns that tier off while keeping the shape.

### Shorthands

`feed` accepts three forms, and every one resolves to a public HTTPS location:

| written | resolves to |
|---|---|
| `https://updates.acme.com/notes/` | itself |
| `github:acme/notes` | `https://github.com/acme/notes/releases/download/updates/` |
| `./dist/feed` or `/srv/feed` | a local directory, for testing |

`github:acme/notes@tag` names the release yourself. The default tag is
`updates`: one pinned release holds the indexes and payloads, while per-version
release pages stay for humans with the installers attached. GitHub's
`releases/latest/download/` alias is deliberately **not** supported, because
older archives live under their own tags and it would 404 for whoever is
furthest behind.

There is no `s3:`. A bucket's public URL is only derivable for AWS at its
default endpoint, so anyone behind CloudFront, R2 or a custom domain would have
a guess baked into every install. Write the `https://` you actually serve.

> **The resolved URL is stamped into every build and lives in every install
> forever.** That makes these rules permanent: adding a shorthand is cheap,
> changing one is not.

## Publishing

```bash
npm version patch      # bundles and releases are ordered by your app's version
npx vidra build        # everything this app is configured for
```

What lands, and where:

```
dist/
├── Notes-1.3.0-macos.dmg          what people download
├── Notes-1.3.0-Setup.exe
└── feed/                          what you upload
    ├── bundles.json + .sig
    ├── bundle-1.3.0-4f9a2c81.zip
    ├── releases.osx.json
    └── Notes-1.3.0-full.nupkg
```

**One rule: `dist/` is yours, `dist/feed/` is the server's.** A feed directory
mirrors exactly one remote prefix, so uploading is "sync this directory to the
URL it mirrors" rather than a rule about which files to include.

One directory per *destination*: two tiers sharing a URL get one `feed/`, and so
does a single tier on its own. Only genuinely separate destinations produce
`feed-web/` and `feed-app/`.

### Doing less than everything

```bash
npx vidra build --web    # the web bundle only: no compile, no platform, seconds
npx vidra build --app    # the installer and its release, no web bundle
```

`--web` is the one you reach for weekly. It needs no MAUI workload and no Mac,
which is the entire point of that tier. `--app` is what a per-platform release
job runs, so a platform-agnostic bundle is not republished from two runners.

`--app` is also the answer when your feed is temporarily unreachable. Publishing
merges from the live index and **fails closed** if it cannot read it, because a
network blip that quietly published an index containing only your newest entry
would strand every install that can only run an older one. The deliverable is
produced before that step, so it exists either way, but the command exits
non-zero. `--app` skips the publish entirely.

### Channels

A channel is a **path**, not a label, and it comes from the build rather than
from `package.json`:

```bash
npx vidra build --channel beta      # or VIDRA_CHANNEL=beta
```

Everything moves under `dist/beta/`, and `/beta/` is appended to the feed URL
stamped into that build. So a beta tester's app reads
`https://updates.acme.com/notes/beta/bundles.json` and never sees stable
entries, because they are in a different file entirely.

That is deliberate: the same commit must be able to produce a stable artifact
and a beta one, so the channel cannot live in a file the commit owns.
**`package.json` describes the app; the stamped `vidra-updates.json` describes
one build of it.**

Do not name your default channel. Absence is the default, and adding
`--channel stable` later creates a *third* namespace that no installed app is
reading, which stops updates silently.

### The live index is merged automatically

Each publish fetches the index you are actually serving and adds to it, because
the feed URL is in `package.json` and nothing has to be remembered. Without
that, the base would be whatever is on disk — which on a clean CI checkout is
nothing, so you would publish an index containing only the newest entry.

That is not just untidy. A bundle is only installable by an app whose contract
fingerprints match it, so if you have ever shipped a native release that changed
a contract, older entries are the only thing older installs can use. Dropping
them strands exactly those users, silently, with a feed that looks perfectly
healthy.

If the index is not there yet, the publish says so and writes the first one. If
it cannot be fetched, the publish **fails** rather than starting empty.

When you sign, it also verifies the index it is merging was signed by your key,
and refuses otherwise — merging a feed someone else has written to and then
signing the result would publish their entries under your signature.

### Uploading

Two rules, whatever the host:

1. **Archives first, `bundles.json` (and `.sig`) last.** A client that reads an
   index naming an archive you have not finished uploading gets a 404. This is
   why a bulk `sync` of `dist/` is wrong — it gives no ordering guarantee.
2. **Never delete on sync.** Old archives are still referenced by the entries
   older installs depend on.

**S3-compatible (R2, B2, Spaces, Wasabi, S3):**

```bash
aws s3 cp dist/feed/ s3://$BUCKET/notes/ --recursive --exclude "bundles.json*" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp dist/feed/bundles.json     s3://$BUCKET/notes/ --cache-control "no-cache"
aws s3 cp dist/feed/bundles.json.sig s3://$BUCKET/notes/ --cache-control "no-cache"
```

**Cloudflare R2 via wrangler:**

```bash
for f in dist/feed/bundle-*.zip; do wrangler r2 object put "$BUCKET/notes/$(basename "$f")" --file "$f"; done
wrangler r2 object put "$BUCKET/notes/bundles.json"     --file dist/feed/bundles.json     --cache-control "no-cache"
wrangler r2 object put "$BUCKET/notes/bundles.json.sig" --file dist/feed/bundles.json.sig --cache-control "no-cache"
```

**GitHub Releases** (use a fixed tag so the URL is stable):

```bash
gh release upload updates dist/feed/bundle-*.zip --clobber
gh release upload updates dist/feed/bundles.json dist/feed/bundles.json.sig --clobber
# and in package.json:  "feed": "github:<owner>/<repo>"
```

One pinned release holds the feed; per-version releases stay for humans, with
the DMG and the installer attached. Note that GitHub serves release assets
through a CDN and you cannot set `no-cache` on them, so a replaced index can be
briefly stale.

Cache headers matter more than they look: archive names contain the hash, so they
can cache forever, but an index cached for hours means your rollback does not
reach anyone.

### In CI

```yaml
- run: npm version ${{ inputs.bump }} --no-git-tag-version
- run: npx vidra build --web
  env:
    VIDRA_UPDATE_SIGNING_KEY: ${{ secrets.VIDRA_UPDATE_SIGNING_KEY }}
    VIDRA_CHANNEL: ${{ vars.CHANNEL }}   # unset for the default ring
- run: ./scripts/upload-feed.sh          # the two-step upload above
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
native release.** That is the intended behaviour, and the build prints the
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
skipped too, whatever its version says. The publish writes a deterministic
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
npx vidra updates init --keygen   # writes the key and trusts it, in one step
```

That writes `vidra-signing-key.pem` (+ `.pub`) and adds the public half to
`publicKeys`. `npx vidra keygen` does the same without touching `package.json`,
for when you are rotating a key by hand. Either way what lands is:

```json
{
  "vidra": {
    "updates": {
      "feed": "https://updates.example.com/notes/",
      "publicKeys": ["MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."]
    }
  }
}
```

Then publish signed:

```bash
npx vidra build --web --sign vidra-signing-key.pem
# or, in CI:  VIDRA_UPDATE_SIGNING_KEY="$(cat key.pem)" npx vidra build --web
```

That writes `bundles.json.sig` next to the manifest — upload both.

**Configuring any key makes signatures mandatory.** An app that trusts a key
refuses an unsigned feed, a feed signed by another key, and a manifest edited
after signing. That is the point: dropping the signature file is exactly what
someone who cannot forge one would try. An app with **no** keys configured
accepts an unsigned feed and says so in its log on every check.

The publish refuses to go out unsigned when your `package.json` trusts a key,
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

A directory is a valid feed. Point `feed` at a path, or serve one:

```bash
cd dist/feed && python3 -m http.server 8099
# "feed": "http://127.0.0.1:8099/"
```

`VIDRA_UPDATE_FEED_URL` overrides the stamped feed at runtime, which is the
easiest way to point a build at staging without rebuilding it.

## Whole-app updates

For the releases that change C#. Vidra drives [Velopack](https://velopack.io),
`vidra build` shells out to `vpk`, and the app talks to Velopack's client
directly. Vidra owns neither; what it adds is the plumbing, and a locator that
teaches Velopack what Mac Catalyst is.

Two things, and `npx vidra doctor` names whichever is missing.

**1. Install the tool** (once per machine):

```bash
dotnet tool install -g vpk
```

**2. Point it at a feed** — the same `vidra.updates.feed` that turns on web
bundles. One directory serves both, because `bundles.json` and
`releases.{platform}.json` never collide. Split them only if you want the app
packages somewhere else:

```json
"feed": { "web": "https://cdn.acme.com/notes/", "app": "https://dl.acme.com/notes/" }
```

Everything else is already in your app: the `Vidra.Updates.Native` reference,
`.UseVidraNativeUpdates()` in `MauiProgram`, and `VelopackApp.Build()...Run()`
at the top of both `Main`s. That last one has to be literally in `Main` — on
install, update and uninstall Velopack re-launches the app with a `--veloapp-*`
argument and expects it to do that work and exit without showing a window, and
`vpk pack` inspects the assembly and warns when it finds the call anywhere else.
It runs on every launch of every Vidra app and does nothing at all until the app
is installed from a Velopack release.

Then release:

```bash
npm version patch
npx vidra build --target windows --app
npx vidra build --target macos --app     # on a Mac
npx vidra build --web                    # once, from anywhere
```

Each build downloads the live feed into its feed directory first and packs into
it, which is what produces deltas and what keeps older entries alive. Upload the
whole directory, payloads first and the index last.

What comes out, beside the usual artifact:

| file | what it is |
|---|---|
| `dist/<App>-<version>-Setup.exe` | the Windows installer, and the recommended download |
| `dist/<App>-<version>-windows.zip` | Velopack's portable archive, under the name the ZIP target always used |
| `dist/<App>-<version>-macos.dmg` | the DMG, now wrapping the *packed* `.app` |
| `dist/feed/` | the feed: packages, deltas, `releases.{platform}.json`, and the web bundle beside them |

### Things worth knowing before you ship one

- **A version already in the feed is not re-published.** `vpk` refuses to pack
  over one, and writes nothing at all — no overwrite, no second package under
  one number. `vidra build` reports the skip and goes on to package what it just
  built, so rebuilding at an unchanged version behaves like an ordinary build
  and the artifact always contains the code from *this* publish. Bump the
  version to release again.
- **Every release keeps a full package in the feed**, not just a delta: older
  installs delta against them, so they cannot be pruned blindly.
- **Velopack signs everything it packages**, including its own `Setup.exe` and
  `Update.exe`, given a certificate, which are the binaries SmartScreen actually judges.
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
  it lands on. A native update cannot destroy OTA state: because app data lives outside
  the directory Velopack replaces, and a bundle chosen against the old contract
  is dropped at startup when the fingerprints stop matching.

## Reference

### Commands

| Command | Effect |
|---|---|
| `vidra build` | the app, plus every tier `package.json` configures |
| `vidra build --web` | the web bundle only: no compile, no platform |
| `vidra build --app` | the installer and its release, no web bundle |
| `vidra build --channel <name>` | publish to a ring; everything moves under `dist/<name>/` |
| `vidra build --plan` | print every step and artifact, run nothing |
| `vidra updates` | which tiers are on, and where they point |
| `vidra updates init --feed <url>` | write the feed both tiers use |
| `vidra updates init --web <url> --app <url>` | split them across two hosts |
| `vidra updates init --keygen` | also generate a signing key and trust it |
| `vidra <command> --help` | that command's own options and examples |

### Environment

| Variable | Effect |
|---|---|
| `VIDRA_UPDATE_FEED_URL` | Overrides the feed URL (or a local directory path) |
| `VIDRA_UPDATE_CHANNEL` | Overrides the channel |
| `VIDRA_ASSET_ROOT` | Serves the WebView from a directory, bypassing updates entirely |
| `VIDRA_UPDATE_SIGNING_KEY` | The signing key PEM, for publishing in CI |
| `VIDRA_CHANNEL` | The channel a build publishes to (same as `--channel`) |
| `VIDRA_NATIVE_UPDATE_FEED_URL` | Overrides the native feed directory |
| `VIDRA_NATIVE_UPDATE_CHANNEL` | Overrides the native channel (default: `win` / `osx`) |
| `VIDRA_NATIVE_UPDATE_ENABLED` | `0` turns native updates off for one run |
| `VIDRA_MACOS_KEYCHAIN` | A non-default keychain for `vpk` to sign from |

`vidra dev` never checks for updates — it serves the Vite dev server.

## Upgrading an app scaffolded before 0.6.0

Two things changed, and `npx vidra doctor` names whichever applies to you.

**The config is one field.** `feedUrl` and `native.feedUrl` became `feed`, which
is a *directory* rather than the `bundles.json` inside it:

```json
"feed": "https://updates.acme.com/notes/"
"feed": { "web": "https://cdn/notes/", "app": "https://dl/notes/" }
```

`channel`, `native.channel` and `native.packId` are gone. A channel is a build
input now (`--channel`, or `VIDRA_CHANNEL`), and the pack id derives from
`<ApplicationId>`.

**`vidra bundle` is `vidra build --web`**, and `vidra build --native-update` is
just `vidra build`. Neither flag exists any more. `--merge-from` and `--out` are
gone too: both are derived from `feed`, which is what stops a publish from
landing somewhere the app is not reading.

Feed payloads also moved from `dist/` and `dist/release/` into `dist/feed/`, so
any upload script pointing at the old paths needs one edit.

Apps scaffolded before **0.5.0** additionally need the updater itself, since it
used to be commented out: add the `Vidra.Updates.Native` package reference, call
`.UseVidraUpdates().UseVidraNativeUpdates()` after `.UseVidra()`, uncomment
`VelopackApp.Build().UseVidraLocator().Run();` and its two `using`s in both
`Platforms/*/Program.cs`, then `rm -rf bin obj` in that project once.

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
