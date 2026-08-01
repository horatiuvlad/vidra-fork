using Microsoft.Maui.Hosting;

namespace Vidra.Hosting;

/// <summary>
/// Drives the updater at the only moment that works: while MAUI is still
/// building the app, before <c>Application</c> is constructed and long before
/// <c>VidraPage</c> asks what to load.
/// </summary>
internal sealed class VidraUpdateStartup(VidraUpdateService updates) : IMauiInitializeService
{
    public void Initialize(IServiceProvider services)
    {
        // `vidra dev` points the WebView at the Vite server, so there is no bundle
        // to promote and nothing an update could affect. Checking anyway would
        // just add noise to a dev session.
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("VIDRA_DEV_URL")))
        {
            Console.WriteLine("[vidra] update: skipped — this is a dev session");
            return;
        }

        updates.ApplyStartupTransition();
        updates.WatchForBoot();

        // Fire and forget on purpose: startup must not wait on the network, and
        // whatever this finds is for the next launch anyway.
        _ = updates.RunStartupCheckAsync();
    }
}
