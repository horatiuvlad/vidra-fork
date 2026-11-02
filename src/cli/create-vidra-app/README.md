# create-vidra-app

Scaffold a [Vidra](https://vidra.build) desktop app with a web UI and a
C#/.NET native host.

> **Alpha:** APIs and templates may change between 0.x releases.

## Create an app

```bash
npm create vidra-app@latest
# or
npx create-vidra-app my-app

cd my-app
npm run dev
```

The generated project depends on [`vidra-cli`](https://www.npmjs.com/package/vidra-cli),
which provides the `vidra` command. This package is only needed to create the
app; nothing depends on it afterwards. Use the provided npm scripts or run
`vidra` through `npx`; no global install is required.

## Requirements

- .NET 10 SDK
- .NET MAUI workload: `dotnet workload install maui`
- Node.js 22 or newer
- Xcode for macOS builds

Windows targets must be built on Windows.

## Common commands

```bash
npm run dev
npm run build
npm run doctor
npx vidra --help
```

See the [getting started guide](https://vidra.build/docs/getting-started/) for
project structure, development, and build options.

## License

MIT
