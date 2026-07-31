using Microsoft.Extensions.Logging;
using Vidra.Hosting;

namespace {{projectName}};

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();

        // Over-the-air updates for the web bundle are opt-in: add
        // `.UseVidraUpdates()` below, and a `vidra.updates` block to package.json
        //
        //   "vidra": { "updates": { "feedUrl": "https://example.com/bundles.json" } }
        //
        // then publish with `npx vidra bundle`. Native code still ships the usual
        // way — a bundle only installs when its contract fingerprints match this
        // build, so JS can never call a bridge the installed binary lacks.
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
