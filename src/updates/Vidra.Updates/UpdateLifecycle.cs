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
    public static UpdateState OnDownloaded(UpdateState state, string sha256, string version)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentException.ThrowIfNullOrWhiteSpace(sha256);

        return state with { Pending = sha256, PendingVersion = version };
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

    private static string Short(string sha256)
        => sha256.Length <= 8 ? sha256 : sha256[..8];

    private static string Describe(string? sha256)
        => sha256 is null ? "the embedded bundle" : $"bundle {Short(sha256)}";
}
