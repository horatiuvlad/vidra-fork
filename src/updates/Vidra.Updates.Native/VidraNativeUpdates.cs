using Velopack;
using Velopack.Locators;
using Velopack.Sources;
using Vidra.Updates.Native;

namespace Vidra.Hosting;

/// <summary>
/// The part of native updates an app's <c>Main</c> touches.
/// </summary>
/// <remarks>
/// <c>VelopackApp.Build()…Run()</c> has to appear literally in the entry point:
/// <c>vpk pack</c> inspects the assembly statically and warns when it finds the
/// call anywhere else, and a hook launch (<c>--veloapp-install</c> and friends)
/// that lands after the UI framework has started is a hook that spins up a
/// whole app to do a few seconds of file work. So Vidra contributes the locator
/// and leaves the call where it belongs.
/// </remarks>
public static class VidraNativeUpdates
{
    private static readonly Lazy<IVelopackLocator?> LazyLocator = new(CreateLocator);

    private static readonly Lazy<IFileDownloader?> LazyDownloader = new(CreateDownloader);

    /// <summary>
    /// The locator this platform needs, or <see langword="null"/> where
    /// Velopack's own detection already works.
    /// </summary>
    /// <remarks>
    /// Non-null only on Mac Catalyst, which Velopack does not enumerate — see
    /// <see cref="VidraCatalystLocator"/>. On Windows this is
    /// <see langword="null"/> and Velopack picks
    /// <c>WindowsVelopackLocator</c> itself, which is measured working.
    /// </remarks>
    public static IVelopackLocator? Locator => LazyLocator.Value;

    /// <summary>
    /// The downloader this platform needs, or <see langword="null"/> where
    /// Velopack's own is fine.
    /// </summary>
    /// <remarks>
    /// Non-null only on Mac Catalyst, and for the same reason as
    /// <see cref="Locator"/>: their default lowers
    /// <c>MaxAutomaticRedirections</c>, which Catalyst's <c>NSUrlSessionHandler</c>
    /// refuses. See <see cref="VidraCatalystDownloader"/>.
    /// </remarks>
    public static IFileDownloader? FileDownloader => LazyDownloader.Value;

    /// <summary>
    /// Installs Vidra's locator, if this platform needs one, and hands the
    /// builder back so <c>Run()</c> stays at the call site.
    /// </summary>
    /// <example>
    /// <code>
    /// static void Main(string[] args)
    /// {
    ///     VelopackApp.Build().UseVidraLocator().Run();
    ///     UIApplication.Main(args, null, typeof(AppDelegate));
    /// }
    /// </code>
    /// </example>
    public static VelopackApp UseVidraLocator(this VelopackApp app)
    {
        var locator = Locator;
        return locator is null ? app : app.SetLocator(locator);
    }

    private static IVelopackLocator? CreateLocator()
    {
#if MACCATALYST
        return new VidraCatalystLocator();
#else
        return null;
#endif
    }

    private static IFileDownloader? CreateDownloader()
    {
#if MACCATALYST
        return new VidraCatalystDownloader();
#else
        return null;
#endif
    }
}
