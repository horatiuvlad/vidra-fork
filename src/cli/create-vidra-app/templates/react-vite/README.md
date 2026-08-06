# {{appTitle}}

A cross-platform application built with [Vidra](https://vidra.build) — React UI + .NET MAUI native host.

## Getting Started

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- The .NET MAUI workload: `dotnet workload install maui`
- [Node.js](https://nodejs.org/) 22+
- macOS targets require Xcode; Windows targets must be built on Windows

Not sure if you're set up? Run:

```bash
npm run doctor
```

It checks your .NET SDK, the MAUI workload, and (on macOS) Xcode, and prints the
exact command to fix anything that's missing.

> The `vidra` CLI ships as a local dev dependency of this project, so run it
> through npm (`npm run dev`, `npm run doctor`) or with `npx vidra <command>` —
> there is no global `vidra` command to install.

### Development

```bash
npm run dev
```

This starts the Vite dev server and launches the native host for the current OS
under `dotnet watch`. Both sides of the app pick up your edits:

- **UI**: edit anything in `ui/src` — Vite HMR updates the WebView instantly.
- **C#**: edit the host (for example `OnTickAsync` in `MainPage.cs`) and save —
  the session puts the change in front of you in seconds. *How* depends on the
  platform:
  - **Windows**: supported edits apply to the *running* app and the UI flashes a
    "C# reloaded" badge. Edits hot reload can't express (new fields, changed
    signatures, …) trigger an automatic rebuild and relaunch.
  - **macOS**: the same, when the toolchain cooperates. Mac Catalyst's
    hot-reload agent often drops its connection mid-session (dotnet/sdk#55488);
    a dropped agent applies nothing while `dotnet watch` still reports success,
    so `vidra dev` watches for it and switches the session to rebuild +
    relaunch on save. You'll see it say so — after that, edits arrive with a
    restart and no badge.
    `npm run doctor` says which loop you get.

To skip `dotnet watch` entirely and do a single build and launch:

```bash
npx vidra dev --no-hot-reload
```

To target a specific desktop platform explicitly:

```bash
npx vidra dev --target macos
npx vidra dev --target windows
```

If you want to run the pieces separately:

```bash
npm run dev:ui
npm run dev:host:macos
npm run dev:host:windows
```

### Production Build

```bash
npm run build
```

### Updates

This app already ships the updater, wired up and checking nothing. The switch is
in `package.json`, empty:

```json
"vidra": {
  "updates": {
    "feed": ""
  }
}
```

Fill it in with the directory your feed is served from and both tiers start:

```json
"feed": "https://updates.example.com/notes/"
```

Web-bundle updates ship a new `ui/` build that applies on the next launch.
Whole-app updates replace the installed app, native code included. One directory
serves both, since their indexes never collide. To put them on different hosts:

```json
"feed": { "web": "https://cdn.example.com/notes/", "app": "https://dl.example.com/notes/" }
```

`github:owner/repo` works too, and expands to that repo's `updates` release.

There is a command for it, which also writes a signing key if you ask:

```bash
npx vidra updates init --feed https://updates.example.com/notes/ --keygen
npx vidra updates                  # which tiers are on, and where they point
```

Then publish:

```bash
npx vidra build          # the app, plus every tier you configured
npx vidra build --web    # just a new UI, no compile
```

`npx vidra <command> --help` lists what each one takes.

## Project Structure

```
{{projectNameKebab}}/
├── src/
│   └── {{projectName}}.Host/     # .NET MAUI native host
│       ├── MauiProgram.cs         # App configuration + Vidra setup
│       ├── MainPage.cs            # Main page (extends VidraPage)
│       └── Platforms/             # Platform-specific code
└── ui/                            # React frontend
    ├── src/
    │   ├── App.tsx                # Main React component
    │   └── main.tsx               # Entry point
    ├── vite.config.ts
    └── package.json
```

---

Built with [Vidra](https://vidra.build) — a C#/.NET native core with a web UI.
