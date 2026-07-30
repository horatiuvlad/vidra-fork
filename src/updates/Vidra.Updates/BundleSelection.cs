namespace Vidra.Updates;

/// <summary>Why a manifest entry was not chosen. Every rejection is reportable.</summary>
public enum BundleRejection
{
    None,
    WrongChannel,
    IncompatibleCoreContract,
    IncompatibleAppContract,
    UnreadableVersion,
    NotNewer,
    PreviouslyFailed,
}

public sealed record BundleCandidate(BundleEntry Entry, BundleRejection Rejection)
{
    public bool IsInstallable => Rejection == BundleRejection.None;
}

/// <summary>
/// Picks the bundle to install, if any.
/// </summary>
/// <remarks>
/// The two questions are kept separate on purpose: the fingerprints answer
/// <i>may I</i> — a bundle built against a different bridge contract cannot run
/// here, whatever its version — and the version answers <i>should I</i>. Both
/// fingerprints have to match; <c>core</c> moves when Vidra's own contracts move,
/// <c>app</c> when the developer's do.
/// </remarks>
public static class BundleSelection
{
    public static BundleCandidate? Choose(
        BundleManifest manifest,
        string hostCoreFingerprint,
        string hostAppFingerprint,
        string? currentVersion,
        string? channel = null,
        IReadOnlyCollection<string>? blocked = null)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var haveInstalled = BundleVersion.TryParse(currentVersion, out var installed);

        BundleCandidate? best = null;
        BundleVersion bestVersion = default;

        foreach (var entry in manifest.Bundles)
        {
            var rejection = Evaluate(
                entry,
                hostCoreFingerprint,
                hostAppFingerprint,
                haveInstalled ? installed : null,
                channel,
                blocked,
                out var entryVersion);

            if (rejection != BundleRejection.None)
                continue;

            if (best is null || entryVersion > bestVersion)
            {
                best = new BundleCandidate(entry, BundleRejection.None);
                bestVersion = entryVersion;
            }
        }

        return best;
    }

    /// <summary>
    /// Evaluates every entry and says why each one lost. Used for diagnostics —
    /// "no update available" and "seven updates exist and none of them fit this
    /// build" need to be distinguishable in a log.
    /// </summary>
    public static IReadOnlyList<BundleCandidate> Evaluate(
        BundleManifest manifest,
        string hostCoreFingerprint,
        string hostAppFingerprint,
        string? currentVersion,
        string? channel = null,
        IReadOnlyCollection<string>? blocked = null)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var haveInstalled = BundleVersion.TryParse(currentVersion, out var installed);

        return manifest.Bundles
            .Select(entry => new BundleCandidate(
                entry,
                Evaluate(
                    entry,
                    hostCoreFingerprint,
                    hostAppFingerprint,
                    haveInstalled ? installed : null,
                    channel,
                    blocked,
                    out _)))
            .ToArray();
    }

    private static BundleRejection Evaluate(
        BundleEntry entry,
        string hostCoreFingerprint,
        string hostAppFingerprint,
        BundleVersion? installed,
        string? channel,
        IReadOnlyCollection<string>? blocked,
        out BundleVersion version)
    {
        version = default;

        if (!string.IsNullOrEmpty(channel)
            && !string.IsNullOrEmpty(entry.Channel)
            && !string.Equals(entry.Channel, channel, StringComparison.OrdinalIgnoreCase))
        {
            return BundleRejection.WrongChannel;
        }

        if (!string.Equals(entry.CoreFingerprint, hostCoreFingerprint, StringComparison.OrdinalIgnoreCase))
            return BundleRejection.IncompatibleCoreContract;

        if (!string.Equals(entry.AppFingerprint, hostAppFingerprint, StringComparison.OrdinalIgnoreCase))
            return BundleRejection.IncompatibleAppContract;

        if (blocked is not null && blocked.Contains(entry.Sha256, StringComparer.OrdinalIgnoreCase))
            return BundleRejection.PreviouslyFailed;

        if (!BundleVersion.TryParse(entry.Version, out version))
            return BundleRejection.UnreadableVersion;

        if (installed is { } current && version <= current)
            return BundleRejection.NotNewer;

        return BundleRejection.None;
    }
}
