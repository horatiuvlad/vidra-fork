using System.Text.Json;

namespace Vidra.Updates.Native;

/// <summary>
/// What an app knows about its native update feed, from one of the three
/// places it can come from.
/// </summary>
/// <remarks>
/// Every member is nullable on purpose: "not configured here" and "configured
/// to nothing" are different answers, and only the first should let a
/// lower-priority source fill the gap.
/// </remarks>
/// <param name="FeedUrl">Base URL of the directory <c>vpk pack</c> writes into.</param>
/// <param name="Channel">
/// Velopack's channel, not Vidra's. Left unset it means Velopack's own default
/// for the platform (<c>win</c> / <c>osx</c>) — the names <c>vpk pack</c> puts
/// in <c>releases.{channel}.json</c>.
/// </param>
/// <param name="Enabled">Master switch.</param>
public sealed record NativeUpdateSettings(string? FeedUrl = null, string? Channel = null, bool? Enabled = null);

/// <summary>
/// Reads the <c>native</c> sub-block of the <c>vidra-updates.json</c> that
/// <c>vidra build</c> stamps into the app, and settles which of the three
/// configuration sources wins.
/// </summary>
/// <remarks>
/// Deliberately plain .NET, and deliberately not part of the MAUI half: an app
/// that never updates should not pay for this, and a rule about precedence is
/// exactly the kind of thing that should be provable on the Linux leg in
/// milliseconds rather than by launching a packaged app.
/// </remarks>
public static class NativeUpdateConfig
{
    /// <summary>The stamped file, shared with the OTA tier — one config surface.</summary>
    public const string ConfigFileName = "vidra-updates.json";

    public const string FeedUrlEnvironmentVariable = "VIDRA_NATIVE_UPDATE_FEED_URL";
    public const string ChannelEnvironmentVariable = "VIDRA_NATIVE_UPDATE_CHANNEL";

    /// <summary>Set to <c>0</c> or <c>false</c> to switch native updates off for one run.</summary>
    public const string EnabledEnvironmentVariable = "VIDRA_NATIVE_UPDATE_ENABLED";

    /// <summary>
    /// Pulls the <c>native</c> block out of a stamped config document. A file
    /// that is missing, malformed, or has no <c>native</c> block all mean the
    /// same thing — nothing configured — because an updater that throws on
    /// startup is worse than one that does nothing.
    /// </summary>
    public static NativeUpdateSettings ParseStampedFile(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return new NativeUpdateSettings();

        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("native", out var native)
                || native.ValueKind != JsonValueKind.Object)
            {
                return new NativeUpdateSettings();
            }

            return new NativeUpdateSettings(
                String(native, "feedUrl"),
                String(native, "channel"),
                Bool(native, "enabled"));
        }
        catch (JsonException)
        {
            return new NativeUpdateSettings();
        }
    }

    /// <summary>
    /// Reads the same settings out of an environment map. Taking the map as an
    /// argument rather than calling <see cref="Environment"/> keeps this a pure
    /// function — the precedence rules are then testable without a test
    /// mutating process state that another test can see.
    /// </summary>
    public static NativeUpdateSettings FromEnvironment(Func<string, string?> read)
        => new(
            Trimmed(read(FeedUrlEnvironmentVariable)),
            Trimmed(read(ChannelEnvironmentVariable)),
            ParseBool(read(EnabledEnvironmentVariable)));

    /// <summary>Reads the settings out of the real process environment.</summary>
    public static NativeUpdateSettings FromEnvironment()
        => FromEnvironment(Environment.GetEnvironmentVariable);

    /// <summary>
    /// Settles the three sources, most specific first: what the app set in
    /// code, then the environment, then the stamped file. Per field, not per
    /// source — setting a channel in code must not discard the feed URL the
    /// build stamped in.
    /// </summary>
    /// <remarks>
    /// The order matches the OTA tier's exactly. It is the environment that
    /// makes a staging build or a CI round-trip possible without editing the
    /// app, so it has to outrank the file the build wrote.
    /// </remarks>
    public static NativeUpdateSettings Resolve(
        NativeUpdateSettings fromCode,
        NativeUpdateSettings fromEnvironment,
        NativeUpdateSettings fromFile)
        => new(
            First(fromCode.FeedUrl, fromEnvironment.FeedUrl, fromFile.FeedUrl),
            First(fromCode.Channel, fromEnvironment.Channel, fromFile.Channel),
            fromCode.Enabled ?? fromEnvironment.Enabled ?? fromFile.Enabled ?? true);

    private static string? First(params string?[] candidates)
        => candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c))?.Trim();

    private static string? Trimmed(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? String(JsonElement parent, string name)
        => parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? Trimmed(value.GetString())
            : null;

    private static bool? Bool(JsonElement parent, string name)
        => parent.TryGetProperty(name, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            }
            : null;

    /// <summary>
    /// Environment variables are strings, and the ones people actually type for
    /// "off" are <c>0</c> and <c>false</c>. Anything unrecognised is treated as
    /// unset so a typo falls through to the next source rather than silently
    /// disabling updates.
    /// </summary>
    private static bool? ParseBool(string? value)
        => Trimmed(value)?.ToLowerInvariant() switch
        {
            "1" or "true" or "yes" or "on" => true,
            "0" or "false" or "no" or "off" => false,
            _ => null,
        };
}
