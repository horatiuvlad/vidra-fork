namespace Vidra.Updates;

public enum StartupOutcome
{
    /// <summary>Nothing was waiting; whatever was current stays current.</summary>
    Unchanged,

    /// <summary>A downloaded bundle became current, on probation until it boots.</summary>
    Promoted,

    /// <summary>A bundle on probation ran out of attempts and was rolled back.</summary>
    RolledBack,

    /// <summary>A bundle on probation is being given another launch.</summary>
    Retried,
}

public sealed record StartupTransition(UpdateState State, StartupOutcome Outcome, string Reason);

/// <summary>
/// The promote / probation / rollback rules, as pure functions over
/// <see cref="UpdateState"/>.
/// </summary>
/// <remarks>
/// Kept free of the filesystem and the WebView on purpose. This is the part with
/// the interesting edge cases — a bundle that boots on the second try, a rollback
/// that must not re-download what it just rejected — and it is the part CI can
/// exercise exhaustively on any runner in milliseconds.
/// </remarks>
public static class UpdateLifecycle
{
    /// <summary>
    /// Launches a promoted bundle is allowed before it is rolled back. Two: the
    /// first failure could be anything (a killed process, a laptop lid), the
    /// second is a pattern.
    /// </summary>
    public const int MaxBootAttempts = 2;

    /// <summary>
    /// Drops any bundle the running binary can no longer serve. Call before
    /// <see cref="OnStartup"/>.
    /// </summary>
    /// <remarks>
    /// Fingerprints are checked when an entry is selected from the feed and never
    /// again — safe only while the binary that did the selecting is the binary
    /// running. A native update breaks exactly that: it replaces the executable,
    /// and with it possibly the core contract, underneath a bundle chosen for the
    /// old one. The old JS then serves against a new bridge, which is the failure
    /// fingerprints exist to prevent, arriving through the other door.
    ///
    /// <c>Pending</c> is revalidated too, not just <c>Current</c>: it was selected
    /// against the same old binary, so promoting it would reintroduce the problem
    /// one launch later.
    ///
    /// Dropped bundles are deliberately <b>not</b> added to <c>Blocked</c>. They
    /// did nothing wrong, and a native rollback can make them installable again —
    /// blocking them would surface months later as "this app stopped updating".
    /// </remarks>
    public static (UpdateState State, IReadOnlyList<string> Dropped) Revalidate(
        UpdateState state,
        HostContracts host)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(host);

        var dropped = new List<string>();

        bool Keep(string? sha)
        {
            if (sha is null) return true;

            // No recorded identity means nothing can vouch for it. Only reachable
            // from a hand-edited or partially written state file, and the safe
            // answer there is the embedded copy.
            if (!state.Installed.TryGetValue(sha, out var identity))
            {
                dropped.Add(sha);
                return false;
            }

            if (!string.Equals(identity.CoreFingerprint, host.CoreFingerprint, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(identity.AppFingerprint, host.AppFingerprint, StringComparison.OrdinalIgnoreCase))
            {
                dropped.Add(sha);
                return false;
            }

            // A native update ships its own bundle. One older than it is not wrong,
            // only superseded — and serving it would silently undo the update's UI.
            // An unparseable version on either side is left alone: "cannot compare"
            // is not "is older".
            if (host.EmbeddedVersion is { } embedded
                && BundleVersion.TryParse(identity.Version, out var installed)
                && BundleVersion.TryParse(embedded, out var shipped)
                && installed < shipped)
            {
                dropped.Add(sha);
                return false;
            }

            return true;
        }

        var keepCurrent = Keep(state.Current);
        var keepPrevious = Keep(state.Previous);
        var keepPending = Keep(state.Pending);

        if (keepCurrent && keepPrevious && keepPending)
            return (state, []);

        var probation = state.Probation is { } p
            && dropped.Contains(p.Sha256, StringComparer.OrdinalIgnoreCase)
                ? null
                : state.Probation;

        return (
            state with
            {
                Current = keepCurrent ? state.Current : null,
                CurrentVersion = keepCurrent ? state.CurrentVersion : null,
                Previous = keepPrevious ? state.Previous : null,
                PreviousVersion = keepPrevious ? state.PreviousVersion : null,
                Pending = keepPending ? state.Pending : null,
                PendingVersion = keepPending ? state.PendingVersion : null,
                Probation = probation,
            },
            dropped);
    }

    /// <summary>
    /// Decides what serves this launch. Call before the WebView is created — the
    /// result is what the asset resolver reads.
    /// </summary>
    public static StartupTransition OnStartup(UpdateState state, int maxBootAttempts = MaxBootAttempts)
    {
        ArgumentNullException.ThrowIfNull(state);

        // Rollback outranks promotion: a bundle that has burned its attempts must
        // go, even if a newer one is already waiting behind it. Promoting the new
        // one first would hide the failure and start the same countdown again.
        if (state.Probation is { } probation && probation.Attempts >= maxBootAttempts)
        {
            var blocked = state.Blocked.Contains(probation.Sha256)
                ? state.Blocked
                : [.. state.Blocked, probation.Sha256];

            return new StartupTransition(
                state with
                {
                    Current = state.Previous,
                    CurrentVersion = state.PreviousVersion,
                    Previous = null,
                    PreviousVersion = null,
                    Probation = null,
                    Blocked = blocked,
                },
                StartupOutcome.RolledBack,
                $"bundle {Short(probation.Sha256)} failed to boot {probation.Attempts} times; "
                    + $"rolling back to {Describe(state.Previous)}");
        }

        if (state.Pending is { } pending)
        {
            return new StartupTransition(
                state with
                {
                    Current = pending,
                    CurrentVersion = state.PendingVersion,
                    Previous = state.Current,
                    PreviousVersion = state.CurrentVersion,
                    Pending = null,
                    PendingVersion = null,
                    Probation = new BundleProbation(pending, 1),
                },
                StartupOutcome.Promoted,
                $"promoting bundle {Short(pending)} ({state.PendingVersion ?? "unknown version"}) on probation");
        }

        if (state.Probation is { } retry)
        {
            return new StartupTransition(
                state with { Probation = retry with { Attempts = retry.Attempts + 1 } },
                StartupOutcome.Retried,
                $"bundle {Short(retry.Sha256)} has not confirmed a boot yet; attempt {retry.Attempts + 1}");
        }

        return new StartupTransition(state, StartupOutcome.Unchanged, $"serving {Describe(state.Current)}");
    }

    /// <summary>
    /// Clears probation once the running bundle has proved it boots. Idempotent,
    /// because the signal that triggers it can arrive more than once.
    /// </summary>
    public static UpdateState OnBootConfirmed(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        return state.Probation is null
            ? state
            : state with { Probation = null };
    }

    /// <summary>Records a freshly downloaded bundle as the one to promote next launch.</summary>
    /// <remarks>
    /// The identity is recorded here because this is the only moment it is known
    /// for certain: the entry was just accepted by a check running in this
    /// process, against this binary's fingerprints.
    /// </remarks>
    public static UpdateState OnDownloaded(UpdateState state, string sha256, BundleIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentException.ThrowIfNullOrWhiteSpace(sha256);

        var installed = new Dictionary<string, BundleIdentity>(state.Installed, StringComparer.OrdinalIgnoreCase)
        {
            [sha256] = identity,
        };

        return state with { Pending = sha256, PendingVersion = identity.Version, Installed = installed };
    }

    /// <summary>
    /// Bundle directories worth keeping: what serves now, what it would roll back
    /// to, and what is waiting. Anything else on disk is garbage from an
    /// interrupted download or a superseded update.
    /// </summary>
    public static IReadOnlyList<string> LiveBundles(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        return new[] { state.Current, state.Previous, state.Pending }
            .Where(sha => !string.IsNullOrEmpty(sha))
            .Select(sha => sha!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    /// <summary>
    /// Drops identities for bundles that are no longer referenced, so the state
    /// file does not grow by one entry per release forever.
    /// </summary>
    /// <remarks>
    /// Keyed to <see cref="LiveBundles"/> rather than to what is on disk: a
    /// blocked bundle needs no identity, because it is rejected by sha before
    /// anything asks what it was built against.
    /// </remarks>
    public static UpdateState ForgetUnreferenced(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        var live = LiveBundles(state);
        if (state.Installed.Count == live.Count)
            return state;

        var kept = state.Installed
            .Where(pair => live.Contains(pair.Key, StringComparer.OrdinalIgnoreCase))
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);

        return kept.Count == state.Installed.Count ? state : state with { Installed = kept };
    }

    private static string Short(string sha256)
        => sha256.Length <= 8 ? sha256 : sha256[..8];

    private static string Describe(string? sha256)
        => sha256 is null ? "the embedded bundle" : $"bundle {Short(sha256)}";
}
