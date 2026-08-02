using Microsoft.Extensions.Logging;
using Vidra.Hosting;

namespace {{projectName}};

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();

        // Updates come in two tiers. Both are opt-in and both read one
        // `vidra.updates` block in package.json.
        //
        // Web bundle: fast, no reinstall. Add `.UseVidraUpdates()` below and
        //
        //   "vidra": { "updates": { "feedUrl": "https://example.com/bundles.json" } }
        //
        // then publish with `npx vidra bundle`. A bundle only installs when its
        // contract fingerprints match this build, so JS can never call a bridge
        // the installed binary lacks.
        //
        // Whole app: native code included. Reference Vidra.Updates.Native, add
        // `.UseVidraNativeUpdates()`, uncomment the line in Platforms/*/Program.cs,
        // and add
        //
        //   "vidra": { "updates": { "native": { "feedUrl": "https://example.com/app/" } } }
        //
        // then build with `npx vidra build --target <target> --native-update`.
        // `npx vidra doctor` names whichever half is missing.
        builder
            .UseMauiApp<App>()
            .UseVidra()
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
