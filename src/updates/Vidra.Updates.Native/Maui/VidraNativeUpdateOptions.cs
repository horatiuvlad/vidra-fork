using Vidra.Updates.Native;

namespace Vidra.Hosting;

/// <summary>
/// How an app finds its native update feed.
/// </summary>
/// <remarks>
/// Settings arrive from three places, most specific first, exactly as the OTA
/// tier's do: what <c>UseVidraNativeUpdates(...)</c> sets in code, the
/// <c>VIDRA_NATIVE_UPDATE_*</c> environment variables, and the <c>native</c>
/// block of <c>vidra-updates.json</c>, which <c>vidra build</c> writes from the
/// app's own <c>package.json</c>, so the usual case needs no C# at all.
/// </remarks>
public sealed class VidraNativeUpdateOptions
{
    /// <summary>
    /// Base URL of the directory <c>vpk pack</c> writes into: the directory,
    /// not a file. The OTA tier's <c>feedUrl</c> names <c>bundles.json</c>; this
    /// one names the prefix that holds <c>releases.{channel}.json</c>. They can
    /// be the same prefix: the two indexes never collide.
    /// </summary>
    public string? FeedUrl { get; set; }

    /// <summary>
    /// Velopack's channel, not Vidra's. Left unset it means Velopack's own
    /// default for the platform: <c>win</c> / <c>osx</c>, the names
    /// <c>vpk pack</c> writes.
    /// </summary>
    public string? Channel { get; set; }

    /// <summary>Master switch.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Whether to check the feed shortly after launch.</summary>
    public bool CheckOnStartup { get; set; } = true;

    /// <summary>
    /// How long to wait before the startup check. The update is for the *next*
    /// launch, so there is nothing to gain by competing with the app's own
    /// startup for bandwidth.
    /// </summary>
    public TimeSpan StartupDelay { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Whether a downloaded update is handed to Velopack's updater immediately,
    /// so it applies when this process exits.
    /// </summary>
    /// <remarks>
    /// On by default, and consistent with the OTA tier: both check in the
    /// background, both apply on the next launch, and the native one simply
    /// wins the launch it lands on. Turn it off to prompt first, then call
    /// <see cref="IVidraNativeUpdates.ApplyOnExit"/> yourself.
    /// </remarks>
    public bool ApplyOnExit { get; set; } = true;

    /// <summary>Overrides <see cref="StartupDelay"/>, in seconds. Test and staging aid.</summary>
    public const string StartupDelayEnvironmentVariable = "VIDRA_NATIVE_UPDATE_STARTUP_DELAY";

    /// <summary>The settings this object carries, in the shape the resolver speaks.</summary>
    /// <remarks>
    /// <see cref="Enabled"/> is a <c>bool</c>, so "left at the default" and
    /// "deliberately set to true" are the same value. Only <c>false</c> is
    /// therefore treated as an answer; <c>true</c> defers to the environment and
    /// the stamped file, which is what lets a build turn updates off for one app
    /// without every app having to opt in again in code.
    /// </remarks>
    internal NativeUpdateSettings AsSettings()
        => new(FeedUrl, Channel, Enabled ? null : false);
}
