# Handoff — release-path PRs, the dependency sweep, and an OTA failure worth chasing

**Date:** 2026-08-07, updated 2026-08-10. **Base:** upstream `rzamfiriu/vidra` `main` @
`e83a27b` (was `a38ec4a` until #20 merged).
**Where the work lives:** this fork, `horatiuvlad/vidra-fork`.

This branch exists only to carry this file. It is deliberately not on `main` and not
on any PR branch, so it cannot end up in a diff proposed upstream.

---

## 1. What is open, and where

| PR | Branch | Base | State |
|---|---|---|---|
| [vidra-fork#13](https://github.com/horatiuvlad/vidra-fork/pull/13) | `pr/release-path` | fork `main` (`e83a27b`) | green on `a38ec4a`, rerunning after the rebase |
| [vidra-fork#9](https://github.com/horatiuvlad/vidra-fork/pull/9) | `pr/dependency-sweep` | fork `main` (`e83a27b`) | green on `a38ec4a`, rerunning after the rebase |
| [vidra-fork#11](https://github.com/horatiuvlad/vidra-fork/pull/11) | `pr/counter-failure-visible` | fork `main` (`e83a27b`) | green on `a38ec4a`, rerunning after the rebase |
| [vidra-fork#14](https://github.com/horatiuvlad/vidra-fork/pull/14) | `fix/ota-boot-confirmation` | fork `main` (`e83a27b`) | green on `a38ec4a`, rerunning after the rebase |

**Nothing of ours is open upstream.** All four are staged on the fork on purpose (owner
directive, 2026-08-07): they settle here first and get promoted later.

Merged upstream, done:

- [rzamfiriu/vidra#20](https://github.com/rzamfiriu/vidra/pull/20)
  (`fix/ota-smoke-server-timeout`) — approved by `rzamfiriu` and squash-merged
  2026-08-10 as `e83a27b`. Fork `main` is fast-forwarded to it and the branch is
  deleted on both sides.

Closed and superseded, do not reopen:

- upstream #16/#17/#18/#19 — withdrawn, moved to the fork as #8/#9/#10/#11.
- fork #8 and #10 — folded into #13.
- fork #12 — promoted upstream as #20, which is now merged.

## 2. What changed versus the original four PRs

The original split was four PRs (`27 §8` in the KB). It is three now, and several
claims in that document turned out to be wrong. Both are covered below.

### Restructure

- **#8 + #10 → #13.** The lockfile derivation is three lines and belongs with the
  guards: same theme, and both have to be right before 0.5.0.
- **The Xcode change was dropped from #13.** `release-nuget.yml` still pins Xcode
  26.3 and `--skip-manifest-update`, and the divergence from `ci.yml` is real, but it
  only takes effect on a pack run that no PR exercises. The file now carries a
  comment saying so. **It belongs with the 0.5.0 release, where the run that depends
  on it can prove it.** This is the single most important deferred item here.

  The branch that carried it (`fix/release-guards`) was deleted on 2026-08-10 with the
  rest of the stale branches — it survives as the tag `archive/fix/release-guards`
  (`99391c6`) — and the change is written out here so it needs no archaeology. In
  `.github/workflows/release-nuget.yml`, replace the pinning step and drop the manifest
  flag:

  ```yaml
  # No Xcode pin and no manifest pin, for the reasons ci.yml gives at length: both
  # were written when the image topped out below the SDK the maccatalyst manifest
  # wanted, and both inverted once the image shipped 26.6. ci.yml dropped them; this
  # job kept them, so the packages nuget.org gets were built on a toolchain CI had
  # already proved does not build them.
  - name: Log Xcode version (macOS)
    if: runner.os == 'macOS'
    run: |
      xcode-select -p
      xcodebuild -version

  - name: Install MAUI workload (${{ matrix.maui-workload }})
    shell: bash
    run: dotnet workload install ${{ matrix.maui-workload }}
  ```

  It replaces the `maxim-lobanov/setup-xcode@v1` step pinned to `26.3` and removes
  `--skip-manifest-update`. Do it in the 0.5.0 release PR, where a real pack run proves it.

### Corrections to the original work

These were found by exercising the code rather than reading it, and each is now
fixed on the branch it belongs to.

1. **`tag-release.sh`'s idempotent path was unreachable.** `git ls-remote --tags
   origin refs/tags/<tag>` reports an *annotated* tag by its tag-object sha and
   filters out the peeled `^{}` entry that carries the commit, so the comparison
   against `git rev-parse HEAD` could never match. The second release workflow to run
   would have failed on a tag it was written to accept, **after publishing**. It now
   reads the peeled entry and treats losing the tag push race to a concurrent
   workflow as the ordinary outcome. Verified against a real remote for all three
   cases: fresh tag, tag already on this commit, tag on a different commit.
2. **The bump guard failed open.** `npm view` and `curl -sf` both exit non-zero when
   they cannot reach the registry, which the guard could not tell from "that version
   is free" — the same weakness as the tag lookup it replaced. Each registry is now
   reached first and asked second.
3. **The npm "nothing to publish" guard applied to dry runs**, and checked only
   `Vidra.Hosting.Maui` when the template pins `Vidra.Updates.Native` at
   `{{vidraVersion}}` too. Both fixed.
4. **PR #18 was red on its own gate.** `src/cli/create-vidra-app/package-lock.json`
   said **0.3.1** while its `package.json` said 0.4.0, and the PR added the check
   without syncing the file. Synced. `check` now reads both copies, so a lockfile
   whose halves disagree with each other cannot pass either.
5. **`Trace` does not do what PR #19 claimed.** Measured on a Release build: `TRACE`
   is defined and `DEBUG` is not, so `Trace.TraceError` compiles in and then emits
   **nothing** — `DefaultTraceListener` writes through `Debugger.Log`, a no-op with no
   debugger, and the template registers no listener. Switched to `Console`, which is
   what `Vidra.Hosting` itself logs through (`WebAssetRoot`, `VidraUpdateService`,
   `VidraPage`) and what the CI smoke legs capture.
6. **The SDK's Node floor came from a devDependency.** `engines: ">=22.22.2"` was
   derived from jsdom, which never installs for a consumer, and jsdom's real
   constraint is a disjunction (`^22.22.2 || ^24.15.0 || >=26.0.0`) that `>=22.22.2`
   does not express. Both packages now say `>=22`, from chalk, the one runtime
   dependency involved. `@types/node` went to 26 while the floor is 22 and CI runs
   24; now `^22.20.0`, matching the floor. CLI typechecks clean.

## 3. What was verified, and how

Everything below is measured, not inferred. Re-derive rather than trust it if it
matters.

- **0.4.0 is published on both registries.** npm `create-vidra-app` and
  `@vidra-dev/sdk` at **16:31:40Z**, every `Vidra.*` id at **16:33:58Z**, both on
  2026-08-02 from `main` @ `6b65a8c`. **npm went first**, so the ordering defect in
  #13 is not hypothetical — it already happened, with a 2m18s window.
- **Zero tags, zero releases** upstream. The old bump guard could never fire.
- **`ci.yml` had no Xcode pin at `6b65a8c` either**, so the packages nuget.org
  received for 0.4.0 were built on a toolchain the suite that gated them did not use.
- **FluentAssertions 7.2.2 is the last free version.** Read from the nuspecs:
  7.2.2 declares `<license type="expression">Apache-2.0`; 8.0.0 switches to
  `<license type="file">` with an Xceed copyright. 7.2.2 ends the 7.x line.
- **Roslyn 4.8.0 is a genuine analyzer floor**, not a stale pin:
  `Vidra.CodeGen.Generator` is `netstandard2.0` + `IsRoslynComponent` +
  `PrivateAssets="all"`, shipped inside `Vidra.Bridge`.
- **Every other bumped version is the current stable**: Test.Sdk 18.8.1, coverlet
  10.0.1, xunit.runner.visualstudio 3.1.5 (4.0.0 is prerelease only), xunit 2.9.3,
  MetadataLoadContext and Logging.Debug 10.0.10, Velopack 1.2.0.
- **Removing `inlineDynamicImports` is safe**, including in the way a byte-identical
  hash would not reveal: with a dynamic `import()` added to the template, Vite 8
  still emits one file with the same hash, because `codeSplitting: false` does the
  work that option used to.
- **Lockfile round-trip identity holds.** `JSON.stringify(lock, null, 2) + "\n"` is
  byte-identical to npm's own output on all four lockfiles, and stays so after a real
  `npm install` under npm 10.9.8 and npm 11.
- **The nupkg id/version regex in `release-nuget.yml` has no reachable breaker.**
  Greedy `.+` handles ids ending in digits correctly. It mis-splits 4-segment versions
  and rejects `+build` metadata, but `version.mjs`'s SEMVER gate and NuGet's filename
  normalisation make neither reachable.

## 4. Findings not addressed by any open PR

Ordered by how much they matter.

1. **Issue [#13](https://github.com/rzamfiriu/vidra/issues/13) reproduced in CI with a
   full log.** See §5. This is a real defect in shipped 0.4.0 and is more valuable
   than anything in the three open PRs.
2. **`merge-nupkgs.py` silently merges a package into itself** when it appears in only
   one OS artifact. Nothing checks the merged set against an expected list of ids, or
   that each package carries both platforms' `lib/` folders. You can publish a
   `Vidra.*` that restores on Windows and not on macOS and no guard notices. This is
   the biggest remaining silent-success path in the release.
3. **Neither release workflow checks the commit is on `main`.** `workflow_dispatch`
   from any branch publishes, and the new tag step will tag whatever it was
   dispatched from.
4. **`launch-windows-app.ps1` gives the packaged app 120s** to write its bridge proof
   and lost that race once on 2026-08-07. Deliberately not raised: 120s is generous
   enough that a bump would hide a genuine hang. Watch it.
5. **A version literal that is not derived**: `src/cli/create-vidra-app/src/commands/bundle.ts:399`
   says "make sure the SDK is 0.4.0 or newer". The KB's "no version literals anywhere"
   claim is not quite true.
6. **`version-bump.yml` checks only `create-vidra-app` and `Vidra.Bridge`.** A
   half-finished release that took `@vidra-dev/sdk@0.5.0` would not block a 0.5.0 bump.

## 5. Issue #13: the first real evidence

`Smoke (windows-latest)`, run
[31192162593](https://github.com/horatiuvlad/vidra-fork/actions/runs/31192162593),
2026-08-07 15:32 UTC, on `pr/release-path` — a branch that touches only workflows,
`scripts/version.mjs`, `tests/ci/tag-release.sh` and two lockfile version fields, so
**nothing it changes can reach the running app**. The same commit passed on re-run.

The failing sequence, from `tests/smoke/ota-e2e.mjs`:

```
==> feed now offers 1.5.0                       # deliberately corrupt: sha256 = "bbbb..."
    [vidra] update: BundleVerificationException: bundle 1.5.0 failed verification:
            expected sha256 bbbb…, got a72cec65…
    ✓ a bundle whose sha256 does not match is refused
##[error]still serving the last good bundle: expected "ota-bundle-1-3-0", got "undefined"
```

Rejection works. What follows it does not: the app comes back with **`marker:
undefined` and `currentVersion: null`** instead of continuing to serve the 1.3.0
bundle it already had installed. Every later phase then fails as a consequence —
rollback reports `null` rather than `1.3.0`, and both signature phases report the
same.

**The hypothesis this suggests, and which nobody has tested: rejecting a bad bundle
discards the good one that was already installed.** That is a sharper claim than "the
rollback is intermittent", and it is testable without a Windows box for at least part
of the path.

Not proven, and the alternative explanations are open: it could be that the rejection
path deletes or truncates shared state, that the install directory is left
half-written, or that the app simply failed to start and reported nothing (the proof
file distinguishes "started and served the embedded bundle" from "never started", and
that distinction was not checked).

## 6. Reproducing the local verification

No dotnet in apt on the fleet box, and no sudo. Install to user space:

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$HOME/.dotnet"
export PATH="$HOME/.dotnet:$PATH"
```

All seven test projects build and run on Linux without the MAUI workload. The MAUI
half — packing, the Mac Catalyst and Windows launch legs, and the OTA e2e — needs the
CI matrix. Dispatch it on this fork with:

```bash
gh workflow run ci.yml --ref <branch> -R horatiuvlad/vidra-fork
```

You have admin on the fork, so `gh run rerun <id> --failed` works here. You do **not**
have it on `rzamfiriu/vidra`.

## 7. Corrections to `.knowledge/27`

That document is the author's account of this work and predates all of the above.
Where it disagrees with this file, this file is later.

- `version.mjs set` moves **5** files upstream (`version.json` plus four derived), not
  6, and 7 with the lockfiles, not 8.
- "A bump would have left both lockfiles claiming 0.4.0" is wrong for the CLI's, which
  claimed **0.3.1**.
- "No version literals anywhere" is wrong — see §4.5.
- `db9cbd8`'s commit message says 7.2.0 is the last free FluentAssertions. It is
  **7.2.2**, as its own follow-up commit says.
- §8's four-PR table is superseded by §1 here.
- §8a's "Chromium is the same engine WebView2 uses, therefore the answer transfers"
  is overstated. The layout result does transfer and the template CSS is genuinely
  ruled out, but Chromium always hands the page a finite viewport height, and an
  unconstrained-height WebView2 is the leading remaining explanation for "will not
  scroll". That is the one hypothesis the repro cannot test.
