using Vidra.Updates;

namespace Vidra.Hosting;

/// <summary>
/// How an app finds its bundle feed.
/// </summary>
/// <remarks>
/// Settings arrive from three places, most specific first: what
/// <c>UseVidraUpdates(...)</c> sets in code, the <c>VIDRA_UPDATE_FEED_URL</c>
/// environment variable, and <c>vidra-update.json</c> — which <c>vidra build</c>
/// writes from the <c>vidra.update</c> block of the app's own
/// <c>package.json</c>, so the usual case needs no C# at all.
/// </remarks>
public sealed class VidraUpdateOptions
{
    public const string FeedUrlEnvironmentVariable = "VIDRA_UPDATE_FEED_URL";
    public const string ChannelEnvironmentVariable = "VIDRA_UPDATE_CHANNEL";

    /// <summary>Name of the stamped config file, as a MAUI app-package asset.</summary>
    public const string ConfigFileName = "vidra-update.json";

    /// <summary>Absolute URL of <c>bundles.json</c>. Without one, nothing is checked.</summary>
    public string? FeedUrl { get; set; }

    /// <summary>Optional channel; entries labelled with a different one are ignored.</summary>
    public string? Channel { get; set; }

    /// <summary>
    /// Master switch. Promotion and rollback of already-downloaded bundles still
    /// happen when this is off — turning updates off should not strand an app on
    /// a bundle it already staged.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Whether to check the feed shortly after launch.</summary>
    public bool CheckOnStartup { get; set; } = true;

    /// <summary>
    /// How long to wait before the startup check. The update is for the *next*
    /// launch, so there is nothing to gain by competing with the app's own
    /// startup for bandwidth.
    /// </summary>
    public TimeSpan StartupDelay { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>Extra request headers — an authorization token for a private feed, say.</summary>
    public IReadOnlyDictionary<string, string>? Headers { get; set; }

    /// <summary>
    /// Overrides where bundles come from. Set this to read a directory or a
    /// share instead of HTTP, or to inject a fake in tests.
    /// </summary>
    public IBundleSource? Source { get; set; }
}
