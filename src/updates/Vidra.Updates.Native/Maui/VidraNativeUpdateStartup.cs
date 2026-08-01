using Microsoft.Maui.Hosting;

namespace Vidra.Hosting;

/// <summary>
/// Starts the background check once MAUI has finished building the app.
/// </summary>
/// <remarks>
/// Later than the OTA tier's equivalent has to be, and deliberately so: nothing
/// here changes what this launch serves. A native update is applied by a
/// separate process after this one exits, so the only thing that matters is
/// that the check happens, not when.
/// </remarks>
internal sealed class VidraNativeUpdateStartup(VidraNativeUpdateService updates) : IMauiInitializeService
{
    public void Initialize(IServiceProvider services)
    {
        // `vidra dev` runs an unpacked build against the Vite server. There is
        // no Velopack install to update and checking would only add noise.
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("VIDRA_DEV_URL")))
            return;

        // Fire and forget on purpose: startup must not wait on the network, and
        // whatever this finds applies to the next launch anyway.
        _ = updates.RunStartupCheckAsync();
    }
}
