# CI harness scripts

Helpers used by the per-OS `smoke` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). They are not part
of any shipped package and are not run by `npm test`.

Together they answer a question the rest of the suite cannot: **does the thing we
just packaged actually work on a user's machine?** Before these existed, the
distribution path was verified only as "a file appeared in `dist/`" — nothing
ever launched the app.

| Script | Platform | What it does |
| --- | --- | --- |
| `macos-selfsigned-identity.sh` | macOS | Creates a throwaway code-signing identity in a temporary keychain and exports `VIDRA_MACOS_CODESIGN_KEY` |
| `windows-selfsigned-cert.ps1` | Windows | Creates a throwaway Authenticode certificate and exports `VIDRA_WINDOWS_CERT_THUMBPRINT` |
| `verify-macos-artifact.sh` | macOS | Asserts the signature, hardened runtime and entitlements of a built `.dmg` |
| `launch-macos-app.sh` | macOS | Mounts the `.dmg`, launches the app, and asserts a real bridge round-trip |
| `launch-windows-app.ps1` | Windows | Unzips, checks the Authenticode signature, launches, and asserts the same |
| `dev-loop-smoke.sh` | macOS | Starts `vidra dev` and asserts the session comes up: Vite serves, the host builds under `dotnet watch`, the watcher arms itself |
| `npm-publish.sh` | any | Publishes an npm package idempotently (used by `release-npm.yml`) |

## Why self-signed certificates work here

Apple's and Microsoft's trust chains matter for **notarization** and
**SmartScreen reputation** — not for producing or verifying a signature.
`codesign` and `signtool` will sign with any certificate that has a private key
and the code-signing EKU, and `codesign --verify --strict` checks the signature's
internal consistency rather than who issued it.

That means the entire signing path — inside-out signing, the hardened runtime
flag, embedded entitlements, Authenticode with timestamping — is fully testable
with **no paid certificate**. The only check that genuinely requires real
credentials is `spctl --assess`, which is therefore *reported* rather than
asserted: it is expected to reject a self-signed, un-notarized build, and is the
check that flips green the day a Developer ID certificate and notarization
credentials exist.

The macOS identity is deliberately named `Developer ID Application: Vidra CI …`
so that the CLI's real distribution-identity selection logic picks it, rather
than the test taking a shortcut around the code it is meant to exercise.

> **Neither certificate is installed as a trusted root.** Adding one raises an
> interactive confirmation dialog that a headless runner can never answer — it
> simply hangs until the job times out. Trust is not needed for any assertion
> these scripts make.

## The runtime end-to-end proof

`launch-*` are the only tests that run a packaged Vidra app. They rely on
[`../smoke/e2e-main-page.cs.in`](../smoke/e2e-main-page.cs.in), which CI copies
over the scaffolded app's `MainPage.cs` (substituting `__PROJECT_NAMESPACE__`)
before building.

That page calls into JavaScript over the typed contract and writes the returned
value to `$VIDRA_E2E_PROOF`. So a proof file containing `1` demonstrates, inside
a **production** build, that:

1. the bundled `wwwroot` assets loaded (the packaged asset path, never exercised in dev),
2. the SDK initialized and the protocol-v2 fingerprint handshake was accepted,
3. the JS handler registry was populated,
4. C# called into JavaScript and got a typed result back.

It also catches the failure mode signing changes are most likely to cause:
incorrect hardened-runtime entitlements kill .NET's JIT, and the process dies on
launch instead of producing a proof.

The app is launched as its inner binary (`Contents/MacOS/<exe>`, or the `.exe`
directly) rather than via `open`, so stdout is captured and the process can be
waited on.

## Reproducing locally

```bash
# macOS — from a source checkout, after `vidra build --target macos`
bash tests/ci/macos-selfsigned-identity.sh      # optional: gives a signable identity
bash tests/ci/verify-macos-artifact.sh dist/MyApp-0.1.0-macos.dmg \
  src/cli/create-vidra-app/dist/cli.js
bash tests/ci/launch-macos-app.sh   dist/MyApp-0.1.0-macos.dmg
```

```powershell
# Windows
./tests/ci/windows-selfsigned-cert.ps1
./tests/ci/launch-windows-app.ps1 -Zip dist\MyApp-0.1.0-windows.zip `
  -Cli src\cli\create-vidra-app\dist\cli.js
```

To run the E2E proof against your own app, install the harness page yourself:

```bash
sed 's/__PROJECT_NAMESPACE__/MyApp/' tests/smoke/e2e-main-page.cs.in \
  > src/MyApp.Host/MainPage.cs
```

Without `VIDRA_E2E_PROOF` set, that page behaves like the normal template page,
so it is harmless if left in place.

## The dev-loop smoke

`dev-loop-smoke.sh` covers `vidra dev` and C# hot reload, which previously had no
automated coverage at all — unit tests cover argument construction and log
classification, but nothing ever started a real session.

It hard-asserts what is genuinely verifiable today, all time-bounded: `vidra dev`
starts, Vite reports ready, the host project builds under `dotnet watch`, and the
watcher arms itself.

Two further signals are **reported as warnings rather than asserted**, because
the platform cannot currently deliver them and gating on them would pin a
known-broken behaviour as the spec:

1. the `[vidra] host ready` sentinel — `dotnet watch run` never launches the app
   on Mac Catalyst (`dotnet run` does not produce the `.app` bundle its
   `RunCommand` points at), so the session parks in "Waiting for a file to
   change before restarting";
2. the watcher's reaction to a C# edit — from that parked state no edit produces
   any output at all, verified with native *and* polling file watching
   (`DOTNET_USE_POLLING_FILE_WATCHER=1` plus an explicit `touch`).

Both appear in the log when they occur. The packaged app launches fine — the
runtime E2E step proves that separately — so this is specific to the watch path.

It runs before the E2E MainPage is installed, since that variant exits the
process on success and would end the session immediately. **macOS only:** the
teardown uses POSIX process groups, which git-bash on the Windows runner does not
provide.

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VIDRA_E2E_PROOF` | the harness page, `launch-*` | Path the proof value is written to |
| `VIDRA_E2E_TIMEOUT` | `launch-macos-app.sh` | Seconds to wait for the proof (default 120) |
| `VIDRA_CI_IDENTITY_CN` | `macos-selfsigned-identity.sh` | Common name of the generated identity |
| `VIDRA_CI_KEYCHAIN` / `VIDRA_CI_KEYCHAIN_PASSWORD` | `macos-selfsigned-identity.sh` | Temporary keychain name and password |
| `VIDRA_CI_CERT_SUBJECT` | `windows-selfsigned-cert.ps1` | Subject of the generated certificate |
| `VIDRA_DEV_READY_TIMEOUT` | `dev-loop-smoke.sh` | Seconds to wait for the watch session to build (default 300) |
| `VIDRA_DEV_RELOAD_TIMEOUT` | `dev-loop-smoke.sh` | Seconds to wait for the watcher to react before warning (default 45) |
| `PUSH` / `PROVENANCE` / `NODE_AUTH_TOKEN` | `npm-publish.sh` | Publish for real, attach provenance, npm auth |
