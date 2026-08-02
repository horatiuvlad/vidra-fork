using Microsoft.Extensions.DependencyInjection;
using Microsoft.Maui.Hosting;

namespace Vidra.Hosting;

public static class VidraNativeUpdatesExtensions
{
    /// <summary>
    /// Turns on native (whole-app) updates via Velopack. Call after
    /// <c>UseVidra()</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// With no arguments the app is configured by the <c>native</c> block of the
    /// <c>vidra.updates</c> section in its own <c>package.json</c>, which
    /// <c>vidra build</c> stamps into the bundle: no feed URL there means
    /// nothing is ever checked.
    /// </para>
    /// <para>
    /// This lives in its own package rather than in <c>Vidra.Hosting.Maui</c>
    /// so an app that never asks for native updates carries no Velopack: the
    /// same reasoning that keeps the OTA tier's dependencies out of apps that
    /// do not use it.
    /// </para>
    /// <para>
    /// One thing this cannot do for you: <c>VelopackApp.Build().Run()</c> has to
    /// appear literally in the app's <c>Main</c>. <c>vpk pack</c> inspects the
    /// assembly and warns when it is anywhere else, and a hook launch that lands
    /// after the UI framework has started is a hook that spins up a whole app to
    /// do a few seconds of file work. The scaffolded template ships both entry
    /// points with the line commented out for exactly this reason.
    /// </para>
    /// </remarks>
    public static MauiAppBuilder UseVidraNativeUpdates(
        this MauiAppBuilder builder,
        Action<VidraNativeUpdateOptions>? configure = null)
    {
        var options = new VidraNativeUpdateOptions();
        configure?.Invoke(options);

        builder.Services.AddSingleton(options);
        builder.Services.AddSingleton<VidraNativeUpdateService>();
        builder.Services.AddSingleton<IVidraNativeUpdates>(sp => sp.GetRequiredService<VidraNativeUpdateService>());
        builder.Services.AddSingleton<IMauiInitializeService, VidraNativeUpdateStartup>();

        return builder;
    }
}
