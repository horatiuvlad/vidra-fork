using Microsoft.Extensions.Logging;
using Vidra.Hosting;

namespace {{projectName}};

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();

        // Updates are wired up and doing nothing, which is the intended state
        // until this app has a feed to check. Both switches are already in
        // package.json, empty — filling one in is the whole opt-in:
        //
        //   "vidra": { "updates": {
        //       "feedUrl": "",           // web bundle: .../bundles.json
        //       "native": { "feedUrl": "" }  // whole app: the directory vpk writes
        //   } }
        //
        // Type a URL there, or run `npx vidra updates init --feed <url> [--native]`,
        // then publish with `npx vidra bundle` (web) or `npx vidra build` (whole app).
        //
        // Web bundle: your `ui/` build, applied on the next launch, no reinstall.
        // A bundle only installs when its contract fingerprints match this build,
        // so JS can never call a bridge the installed binary lacks.
        //
        // Whole app: native code included, via Velopack. Its other half is the
        // `VelopackApp` line in Platforms/*/Program.cs, which has to run before
        // the UI framework starts.
        builder
            .UseMauiApp<App>()
            .UseVidra()
            .UseVidraUpdates()
            .UseVidraNativeUpdates()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif

        return builder.Build();
    }
}
