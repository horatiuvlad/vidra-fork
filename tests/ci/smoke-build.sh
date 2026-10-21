#!/usr/bin/env bash
# Build the smoke app the way CI does: the SDK, the CLI and the local NuGet
# feed from this checkout, a scaffolded app on top of them, and the packaged
# artifact `vidra build` makes for the target.
#
# Usage:
#   bash tests/ci/smoke-build.sh [--target android|macos|windows] [--work DIR] [--ota-feed URL]
#
#   --target T       android (default): a signed release APK and AAB, as the
#                    android-emulator job builds them. macos: the .dmg. windows:
#                    the self-contained .zip. Desktop targets build on their own
#                    OS (on Windows, from Git Bash, as pack-local.sh needs).
#   --work DIR       where the app is scaffolded (default: $TMPDIR/vidra-smoke-<target>).
#                    The app is DIR/vidra-smoke; it is scaffolded anew on every run.
#   --ota-feed URL   android: swap in tests/smoke/ota-main-page.cs.in and point
#                    the web update feed at URL, as CI does for ota-e2e.mjs.
#                    Without it the app is the template as a user gets it (the
#                    live counter and all), which is what tests/maestro/ drives.
#
# Needs .NET 10 with the MAUI workloads (on macOS and Windows the Android one
# too: pack-local.sh packs every library's Android half), Node 22+, and for
# Android JDK 17 (JAVA_HOME or keytool on PATH) and an Android SDK (ANDROID_HOME
# or ANDROID_SDK_ROOT). The Android keystore is VIDRA_ANDROID_KEYSTORE when set,
# else a throwaway one created in DIR on first use. Prints the artifact's path
# as the last line of its output.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
target=android
work=""
ota_feed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    --ota-feed) ota_feed=$2; shift 2 ;;
    *) sed -n '6,25p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
  esac
done
case "$target" in
  android) artifact=apk ;;
  macos) artifact=dmg ;;
  windows) artifact=zip ;;
  *) echo "--target is android, macos or windows, not '$target'" >&2; exit 2 ;;
esac
if [ -n "$ota_feed" ] && [ "$target" != android ]; then
  echo "--ota-feed is for --target android" >&2; exit 2
fi
work="${work:-${TMPDIR:-/tmp}/vidra-smoke-$target}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"
app="$work/vidra-smoke"
cli="$repo/src/cli/vidra-cli/dist/cli.js"

step() { printf '\n==> %s\n' "$1"; }

step "Build SDK, CLI, and local packages"
npm ci --prefix "$repo/src/sdk/vidra-js" || npm install --prefix "$repo/src/sdk/vidra-js"
npm run build --prefix "$repo/src/sdk/vidra-js"
npm ci --prefix "$repo/src/cli" || npm install --prefix "$repo/src/cli"
npm run build --prefix "$repo/src/cli" --workspaces --if-present
"$repo/pack-local.sh"

step "Scaffold the smoke app in $app"
rm -rf "$app"
(cd "$work" && node "$repo/src/cli/create-vidra-app/dist/index.js" vidra-smoke --app-id=com.vidra.smoke)
if [ -n "$ota_feed" ]; then
  sed 's/__PROJECT_NAMESPACE__/VidraSmoke/' "$repo/tests/smoke/ota-main-page.cs.in" \
    > "$app/src/VidraSmoke.Host/MainPage.cs"
  # shellcheck disable=SC2016 # JavaScript, not shell: the template literal is node's.
  OTA_FEED="$ota_feed" node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const config = fs.readFileSync(file, "utf8");
    const next = config.replace(
      /updates:\s*\{\s*feed:\s*""\s*,?\s*\}/,
      `updates: { feed: { web: ${JSON.stringify(process.env.OTA_FEED)} } }`,
    );
    if (next === config) throw new Error("no empty updates feed in " + file);
    fs.writeFileSync(file, next);
  ' "$app/vidra.config.ts"
fi
npm ci --prefix "$app"
npm ci --prefix "$app/ui"

if [ "$target" = android ]; then
  keystore="${VIDRA_ANDROID_KEYSTORE:-$work/vidra-release.jks}"
  if [ ! -f "$keystore" ]; then
    step "Create a throwaway release keystore"
    keytool="keytool"; [ -n "${JAVA_HOME:-}" ] && keytool="$JAVA_HOME/bin/keytool"
    "$keytool" -genkeypair -v \
      -keystore "$keystore" \
      -storepass android -keypass android -alias release \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Vidra CI,O=Vidra,C=US"
  fi
  export VIDRA_ANDROID_KEYSTORE="$keystore"
  export VIDRA_ANDROID_KEY_ALIAS="${VIDRA_ANDROID_KEY_ALIAS:-release}"
  export VIDRA_ANDROID_KEY_PASSWORD="${VIDRA_ANDROID_KEY_PASSWORD:-android}"
  export VIDRA_ANDROID_STORE_PASSWORD="${VIDRA_ANDROID_STORE_PASSWORD:-android}"
  # Intent-extra controls stay gated by the manifest debuggable flag; this
  # release-shaped smoke opts in explicitly.
  export VIDRA_ANDROID_DEBUGGABLE=1
fi

step "Package it (vidra build --target $target)"
(cd "$app" && node "$cli" build --target "$target" --app)
shopt -s nullglob
built=("$app"/dist/*-"$target"."$artifact")
[ "${#built[@]}" -eq 1 ] || { echo "expected one $target .$artifact in $app/dist, found ${#built[@]}" >&2; exit 1; }
if [ "$target" = android ]; then
  aab=("$app"/dist/*-android.aab)
  [ "${#aab[@]}" -eq 1 ] || { echo "expected one .aab in $app/dist" >&2; exit 1; }
fi
echo "${built[0]}"
