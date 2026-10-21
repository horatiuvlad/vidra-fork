# Maestro flows

Device-level checks of the scaffolded template on Android, written for plain
[Maestro](https://maestro.dev) so they run against any emulator or phone adb
can reach. They are not part of CI: `ci.yml`'s Android job proves the bridge and
OTA updates with `tests/smoke/ota-e2e.mjs`, and these cover what a person does
with the app on a device.

## Running them

```bash
# Build the template app (com.vidra.smoke) as CI builds its Android smoke app,
# without CI's OTA page, so it is the template as a user gets it.
bash tests/ci/smoke-build.sh --target android   # prints the APK's path last

adb install -r <that apk>
maestro test tests/maestro/
```

The build needs .NET 10 with the `maui-android` workload, Node 22 or newer,
JDK 17 and an Android SDK; the script's header has the details. The flows were
written against API 34 (Android 14) and API 35 (Android 15) emulators,
`pixel_6`, 1080x2400.

## What `template-smoke.yaml` covers

| Step | What it proves |
| --- | --- |
| Launch with cleared data | The packaged web assets load and the page renders. |
| Live counter above 0 | C# to JS: the host's timer calls the page's counter handler through the bridge. |
| Get App Info, Read Clipboard | JS to C#: native modules answer (`app`, `clipboard`). |
| Window controls | `appWindow.getSupport()` offers only `getCurrent` on Android, so the template hides every desktop control, and `getCurrent` answers. |
| Send Notification | API 33+ asks for the permission on first use; after Allow the notification is posted. |
| Rotation | The WebView is not recreated: the counter keeps counting instead of starting again. |
| Home, then launch | Background and resume bring back the same page. |
| Back | With no page history, Back leaves the app, and it launches again cleanly. |

The UI is a WebView, which Android's accessibility tree does not expose, so
the flow sets `androidWebViewHierarchy: devtools`: Maestro reads the page
through Chrome DevTools, which a debuggable build turns on
(`VIDRA_ANDROID_DEBUGGABLE=1`, as `smoke-build.sh` builds it).

Not covered here, and still manual (`docs/testing.md`): picker files copied
into the app's cache (the template has no picker), web-bundle promotion and
rollback across an app upgrade (`ota-e2e.mjs` covers the bundle side), and
anything that needs a real phone.
