# Distribution: signing, notarization, and packaging

`vidra build` turns a project into something you can hand to someone else: a
macOS `.dmg` or a self-contained Windows `.zip`. Producing that file is the easy
half. The other half is convincing the operating system to run it.

An app that arrives over the internet is treated differently from one you built
locally. macOS attaches a quarantine flag to downloaded files and asks Gatekeeper
for a verdict; Windows shows a SmartScreen warning for unrecognized binaries.
Neither cares that the app works on your machine — they care whether it carries a
signature they trust.

This page covers how to satisfy both, and what Vidra does automatically.

> **Nothing here is mandatory to build.** With no signing configured, `vidra
> build` still produces a working artifact — it warns about what's missing and
> carries on. Everything below is opt-in by environment variable.

---

## What gets produced

| Target | Artifact | Runs without extra installs? |
| --- | --- | --- |
| macOS | `dist/<App>-<version>-macos.dmg` (contains the `.app` and an `/Applications` symlink) | Yes |
| Windows | `dist/<App>-<version>-windows.zip` (self-contained, unpackaged) | Yes — except the WebView2 runtime, see [below](#the-webview2-runtime) |

Preview every step, and the exact artifact name, without running anything:

```bash
npx vidra build --target macos --plan
```

The plan reflects your actual environment: it reports whether a Developer ID
certificate is present and whether notarization credentials are configured, so
it tells you what *would* happen rather than what could happen in principle.

---

## macOS

### Choosing a signing identity

Vidra picks a certificate based on what the signature is *for*:

| Context | Preferred certificate | Why |
| --- | --- | --- |
| `vidra dev` / `vidra run` | `Apple Development:` | Local launches only. Free with any Apple ID. |
| `vidra build` | `Developer ID Application:` | The only kind that can be notarized. |

If `vidra build` can only find a development certificate it will use it and warn
loudly — the result runs locally and will be **rejected on every other Mac**.
With no certificate at all it falls back to ad-hoc signing (`-`).

Override the choice entirely with `VIDRA_MACOS_CODESIGN_KEY`:

```bash
export VIDRA_MACOS_CODESIGN_KEY="Developer ID Application: Your Name (TEAMID)"
```

List what you have with `security find-identity -v -p codesigning`, or just run
`npx vidra doctor`, which reports it.

### The hardened runtime and entitlements

Notarization requires the **hardened runtime** (`codesign --options runtime`).
The hardened runtime, by default, forbids exactly the things .NET needs — so
enabling it without the matching entitlements produces an app that signs,
notarizes, and then dies the moment it launches.

Scaffolded projects therefore ship `src/<App>.Host/Entitlements.plist`:

| Entitlement | Why it's needed |
| --- | --- |
| `com.apple.security.cs.allow-jit` | .NET's JIT compiles into executable memory |
| `com.apple.security.cs.allow-unsigned-executable-memory` | the runtime writes then executes that memory |
| `com.apple.security.cs.disable-library-validation` | it loads dylibs signed by a different team |
| `com.apple.security.network.client` | the WebView reaches the Vite dev server |
| `com.apple.security.files.user-selected.read-write` | `filePicker` returns paths the app then reads |
| `com.apple.security.app-sandbox` = `false` | Vidra's `filesystem` module exposes unrestricted paths; Developer ID distribution, unlike the App Store, does not require the sandbox |

Both `vidra build` and MAUI's own signing pass use this file (the csproj sets
`<CodesignEntitlements>`), so the two stay consistent.

> **Do not add XML comments to `Entitlements.plist`.** The MacCatalyst SDK parses
> it with its own PList reader, which rejects comments in the document body and
> fails the build with `Failed to parse PList data type:`. The rationale for each
> key lives in the host `.csproj` instead.

**Upgrading an older project?** `Entitlements.plist` is a template file, so
projects scaffolded before it existed won't have one. `vidra build` warns and
signs without the hardened runtime — meaning the result can't be notarized. Copy
the file and the `<CodesignEntitlements>` property from a freshly scaffolded app.

### How the bundle is signed

Signing runs **inside-out**: nested `.dylib`/`.so` files and `.framework`
bundles are signed first, deepest path first, then the `.app` itself. Vidra
deliberately does not use `codesign --deep`, which Apple does not support for
submission. Every signature is timestamped.

The `.dmg` is signed too, once a real identity exists — an ad-hoc signature on a
disk image conveys no trust, so that step is skipped rather than faked.

### Notarization

Notarization uploads the artifact to Apple, waits for a verdict, and staples the
resulting ticket so it validates offline. It requires a paid **Apple Developer
Program** membership.

Store credentials once:

```bash
xcrun notarytool store-credentials vidra-notary \
  --apple-id you@example.com --team-id ABCDE12345 --password <app-specific-password>

export VIDRA_NOTARY_PROFILE=vidra-notary
npx vidra build --target macos
```

Or supply them directly — useful for CI secrets:

```bash
export VIDRA_APPLE_ID=you@example.com
export VIDRA_TEAM_ID=ABCDE12345
export VIDRA_APP_PASSWORD=abcd-efgh-ijkl-mnop
```

With no credentials configured the step is skipped and the build succeeds.

Two behaviours worth knowing:

- **A rejected submission fails the build.** `notarytool` exits 0 even when the
  verdict is `Invalid`, so Vidra checks the status itself rather than trusting
  the exit code.
- **The rejection reason is fetched automatically.** The verdict alone never
  explains anything; Vidra runs `notarytool log` for the submission and prints it.

### Verifying the result

After signing, `vidra build` reports two checks:

- **`codesign --verify --strict`** — the signature is well-formed and the bundle
  hasn't been modified since. This must pass.
- **`spctl --assess`** — Gatekeeper's actual verdict. Expect this to be
  *rejected* until the build is both Developer ID signed and notarized. It is
  reported as guidance, not treated as a failure.

To confirm the real end-user experience, apply the quarantine flag yourself and
open the result:

```bash
xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" dist/*.dmg
open dist/*.dmg
```

Before notarization this is blocked; after, it opens cleanly. That transition is
the whole point of signing.

---

## Windows

### Authenticode

`vidra build --target windows` signs the app executable **before** zipping — a
zip cannot itself carry a signature, so the signature has to be on the `.exe`
inside it.

Point Vidra at a certificate, either as a file:

```powershell
$env:VIDRA_WINDOWS_CERT_PATH = "C:\certs\vidra.pfx"
$env:VIDRA_WINDOWS_CERT_PASSWORD = "..."
```

…or one already in the certificate store, which is how hardware-token (EV)
certificates are used:

```powershell
$env:VIDRA_WINDOWS_CERT_THUMBPRINT = "4FB0491E0F13CDBDAE24BF16F09E4989F038471B"
```

Signatures are always **timestamped** (`/tr`, SHA-256). Without a timestamp a
signature stops validating the moment the certificate expires; with one it
remains valid for the life of the timestamp. Override the server with
`VIDRA_WINDOWS_TIMESTAMP_URL` if you prefer a different authority.

`signtool.exe` ships with the Windows SDK and is not on `PATH` by default —
Vidra finds it automatically, newest SDK first, or you can set
`VIDRA_SIGNTOOL_PATH`.

With nothing configured the build is unsigned. It still runs; SmartScreen simply
warns the first users who download it. Note that SmartScreen reputation
accumulates over time even for correctly signed binaries.

### The WebView2 runtime

The ZIP bundles the .NET runtime and the WindowsAppSDK, so the app needs no
installs — with one exception. **WebView2 is a machine-wide runtime, not
something an app can bundle.** It ships with Windows 11 and alongside Edge on
Windows 10, so it is almost always present, but on a stripped image (Windows
Server, some VDI builds) a Vidra app launches to a blank window.

`npx vidra doctor` reports whether it's installed. If you distribute widely,
consider chaining Microsoft's WebView2 bootstrapper from an installer.

---

## Environment variable reference

| Variable | Platform | Effect |
| --- | --- | --- |
| `VIDRA_MACOS_CODESIGN_KEY` | macOS | Use this exact signing identity, overriding automatic selection |
| `VIDRA_NOTARY_PROFILE` | macOS | `notarytool` keychain profile; enables notarization |
| `VIDRA_APPLE_ID` | macOS | Apple ID for notarization (with `VIDRA_TEAM_ID` + `VIDRA_APP_PASSWORD`) |
| `VIDRA_TEAM_ID` | macOS | Apple Developer team identifier |
| `VIDRA_APP_PASSWORD` | macOS | App-specific password for notarization |
| `VIDRA_WINDOWS_CERT_PATH` | Windows | Path to a `.pfx` code-signing certificate |
| `VIDRA_WINDOWS_CERT_PASSWORD` | Windows | Password for that `.pfx` |
| `VIDRA_WINDOWS_CERT_THUMBPRINT` | Windows | Thumbprint of a certificate in the Windows store |
| `VIDRA_WINDOWS_TIMESTAMP_URL` | Windows | Timestamp authority (default: DigiCert) |
| `VIDRA_SIGNTOOL_PATH` | Windows | Explicit path to `signtool.exe` |

`VIDRA_NOTARY_PROFILE` takes precedence over the Apple ID triple. All of these
are reported by `npx vidra doctor`.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `"App" cannot be opened because the developer cannot be verified` | Not notarized, or not signed with a Developer ID certificate |
| App is killed immediately on launch after signing | Hardened runtime without the JIT entitlements — check `codesign -d --entitlements - <App>.app` |
| `Failed to parse PList data type:` | An XML comment inside `Entitlements.plist` |
| `no Entitlements.plist found` warning | Project predates the template file; copy it in (see above) |
| Notarization rejected | Read the `notarytool log` output Vidra prints; usually a missing hardened runtime or an unsigned nested binary |
| Blank window on Windows | WebView2 runtime missing |
| Signature stops validating later | The signature wasn't timestamped |

---

## Releasing Vidra itself

Vidra's own packages are published by two manual workflows, both **dry-run by
default** and both gated on the full CI suite — a published version can never be
re-uploaded to nuget.org or npm, so verification runs first.

| Workflow | Publishes | Secret required |
| --- | --- | --- |
| `release-nuget.yml` | `Vidra.Bridge`, `Vidra.Hosting.Maui`, `Vidra.Modules.*` | `NUGET_API_KEY` |
| `release-npm.yml` | `@vidra-dev/sdk`, `create-vidra-app` | `NPM_TOKEN` |

Run either from the Actions tab, leaving `push` unchecked first to inspect what
would be published. Both skip versions already present on the registry, so
re-running after bumping a single package is safe.

The npm workflow attaches [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
by default, which links a published tarball to the commit and workflow that
built it. Turn it off if publishing from a fork, where the repository won't match
the one named in `package.json`.
