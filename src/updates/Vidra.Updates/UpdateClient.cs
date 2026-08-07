namespace Vidra.Updates;

/// <summary>What a background check did.</summary>
public enum UpdateCheckOutcome
{
    /// <summary>The feed had nothing this host can install.</summary>
    NoUpdate,

    /// <summary>A newer compatible bundle was downloaded and is staged for the next launch.</summary>
    Downloaded,

    /// <summary>The check could not complete — offline, a bad feed, a failed verification.</summary>
    Failed,
}

public sealed record UpdateCheckResult(
    UpdateCheckOutcome Outcome,
    string Reason,
    BundleEntry? Entry = null,
    UpdateState? State = null);

/// <summary>
/// Runs one update check: read the feed, pick what fits, install it, record it as
/// pending. Promotion is a separate act that happens on the next launch.
/// </summary>
public sealed class UpdateClient(BundleStore store, BundleInstaller? installer = null)
{
    private readonly BundleStore _store = store ?? throw new ArgumentNullException(nameof(store));
    private readonly BundleInstaller _installer = installer ?? new BundleInstaller(store);

    /// <summary>
    /// Never throws for an expected failure — an update check runs in the
    /// background of a working app, and being offline, or pointed at a feed that
    /// 404s, must not surface as anything more than a log line.
    /// </summary>
    public async Task<UpdateCheckResult> CheckAsync(
        IBundleSource source,
        UpdateCheckRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(request);

        try
        {
            var state = _store.LoadState();
            var json = await source.GetManifestAsync(ct).ConfigureAwait(false);

            // Verified before the document is even parsed: everything downstream
            // — which bundle to fetch, which hash to trust — comes out of these
            // bytes, so believing any of it before knowing who wrote them would
            // be backwards.
            var signature = request.TrustedPublicKeys.Count > 0
                ? await source.GetManifestSignatureAsync(ct).ConfigureAwait(false)
                : null;
            ManifestVerifier.Verify(
                System.Text.Encoding.UTF8.GetBytes(json),
                signature,
                request.TrustedPublicKeys);

            var manifest = BundleManifest.Parse(json);

            var installedVersion = state.CurrentVersion ?? request.EmbeddedVersion;
            var candidate = BundleSelection.Choose(
                manifest,
                request.CoreFingerprint,
                request.AppFingerprint,
                installedVersion,
                request.Channel,
                state.Blocked);

            if (candidate is null)
            {
                return new UpdateCheckResult(
                    UpdateCheckOutcome.NoUpdate,
                    Explain(manifest, request, installedVersion, state));
            }

            var entry = candidate.Entry;

            // Already staged: re-downloading the same archive on every check would
            // be the kind of bug that only shows up on someone's metered connection.
            if (string.Equals(state.Pending, entry.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return new UpdateCheckResult(
                    UpdateCheckOutcome.NoUpdate,
                    $"bundle {entry.Version} is already staged for the next launch",
                    entry,
                    state);
            }

            // Same bytes, newer version number. A publisher who bumps the version
            // without touching `ui/dist` produces exactly this: the archive is
            // deterministic, so the sha is unchanged while the entry looks new.
            // Installing it would re-download what is already on disk and leave
            // Current and Previous on one sha — which LiveBundles dedupes, arming
            // a rollback with nowhere to roll back to.
            if (string.Equals(state.Current, entry.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return new UpdateCheckResult(
                    UpdateCheckOutcome.NoUpdate,
                    $"bundle {entry.Version} is byte-identical to the one already serving",
                    entry,
                    state);
            }

            await _installer.InstallAsync(source, entry, ct).ConfigureAwait(false);

            var identity = new BundleIdentity(
                entry.Version, request.CoreFingerprint, request.AppFingerprint);

            // Re-read rather than write back the snapshot this check started
            // from. A download takes as long as the network takes, and the
            // running app is deciding things about the same file the whole time
            // — clearing the probation on a bundle that has just proved it
            // boots, most of all. Writing the pre-download copy would put that
            // probation back, and a resurrected probation is how a working
            // bundle gets rolled back.
            var updated = UpdateLifecycle.ForgetUnreferenced(
                UpdateLifecycle.OnDownloaded(_store.LoadState(), entry.Sha256, identity));
            _store.SaveState(updated);
            _store.Prune(updated);

            return new UpdateCheckResult(
                UpdateCheckOutcome.Downloaded,
                $"bundle {entry.Version} staged for the next launch",
                entry,
                updated);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new UpdateCheckResult(UpdateCheckOutcome.Failed, $"{ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// Says why nothing was chosen. "No update" and "three updates exist, all
    /// built against a bridge contract this app does not have" are very different
    /// situations to debug, and they look identical without this.
    /// </summary>
    private static string Explain(
        BundleManifest manifest,
        UpdateCheckRequest request,
        string? installedVersion,
        UpdateState state)
    {
        if (manifest.Bundles.Count == 0)
            return "the feed lists no bundles";

        var evaluated = BundleSelection.Evaluate(
            manifest,
            request.CoreFingerprint,
            request.AppFingerprint,
            installedVersion,
            request.Channel,
            state.Blocked);

        var counts = evaluated
            .GroupBy(candidate => candidate.Rejection)
            .OrderByDescending(group => group.Count())
            .Select(group => $"{group.Count()} {Describe(group.Key)}");

        return $"nothing installable in {manifest.Bundles.Count} entries "
            + $"(running {installedVersion ?? "an unknown version"}): {string.Join(", ", counts)}";
    }

    private static string Describe(BundleRejection rejection)
        => rejection switch
        {
            BundleRejection.None => "installable",
            BundleRejection.WrongChannel => "on another channel",
            BundleRejection.IncompatibleCoreContract => "built against a different core contract",
            BundleRejection.IncompatibleAppContract => "built against a different app contract",
            BundleRejection.UnreadableVersion => "with an unreadable version",
            BundleRejection.NotNewer => "not newer than what is running",
            BundleRejection.PreviouslyFailed => "already rejected after failing to boot",
            _ => rejection.ToString(),
        };
}

/// <summary>What the host knows about itself when it asks for updates.</summary>
public sealed record UpdateCheckRequest
{
    /// <summary><c>BridgeContractRegistry.Fingerprint(Core)</c> — read after the bridge exists.</summary>
    public required string CoreFingerprint { get; init; }

    /// <summary><c>BridgeContractRegistry.Fingerprint(App)</c>.</summary>
    public required string AppFingerprint { get; init; }

    /// <summary>The version of the bundle the app shipped with, used when nothing is installed yet.</summary>
    public string? EmbeddedVersion { get; init; }

    public string? Channel { get; init; }

    /// <summary>
    /// Base64 SPKI public keys this app will accept a manifest from. Empty means
    /// the feed is trusted without a signature — appropriate for a local
    /// directory or a private feed, and not for anything public.
    /// </summary>
    public IReadOnlyList<string> TrustedPublicKeys { get; init; } = [];
}
