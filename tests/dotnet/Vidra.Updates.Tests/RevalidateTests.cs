namespace Vidra.Updates.Tests;

/// <summary>
/// Revalidation: can the binary running right now still serve the bundles this
/// install already has?
/// </summary>
/// <remarks>
/// The feed's fingerprints are checked when an entry is selected and never again,
/// which is safe only while the binary that did the selecting is the one running.
/// A native update replaces the executable — and possibly the core contract —
/// underneath a bundle chosen for the old one, so the old JS would serve against
/// a new bridge. These cases are the whole reason the state file records what each
/// bundle was chosen against.
/// </remarks>
public class RevalidateTests
{
    private const string Core = "core-fingerprint";
    private const string App = "app-fingerprint";

    [Fact]
    public void A_matching_bundle_survives_untouched()
    {
        var state = Installed(Sha('a'), "1.2.0", Core, App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
        };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().BeEmpty();
        result.Should().BeSameAs(state);
    }

    [Fact]
    public void A_bundle_built_against_a_different_core_contract_is_dropped()
    {
        var state = Installed(Sha('a'), "1.2.0", "older-core", App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
        };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().ContainSingle().Which.Should().Be(Sha('a'));
        result.Current.Should().BeNull("the embedded copy is the floor");
        result.CurrentVersion.Should().BeNull();
    }

    [Fact]
    public void A_bundle_built_against_a_different_app_contract_is_dropped()
    {
        var state = Installed(Sha('a'), "1.2.0", Core, "older-app") with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
        };

        var (_, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().ContainSingle();
    }

    [Fact]
    public void A_bundle_older_than_the_embedded_one_is_dropped()
    {
        // The native update shipped 2.0.0's UI; serving the 1.9.0 bundle it
        // superseded would silently undo the update the user just installed.
        var state = Installed(Sha('a'), "1.9.0", Core, App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.9.0",
        };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("2.0.0"));

        dropped.Should().ContainSingle();
        result.Current.Should().BeNull();
    }

    [Fact]
    public void An_unparseable_version_is_not_treated_as_older()
    {
        var state = Installed(Sha('a'), "not-a-version", Core, App) with
        {
            Current = Sha('a'),
            CurrentVersion = "not-a-version",
        };

        var (_, dropped) = UpdateLifecycle.Revalidate(state, Host("2.0.0"));

        dropped.Should().BeEmpty("\"cannot compare\" is not \"is older\"");
    }

    [Fact]
    public void A_pending_bundle_is_revalidated_too()
    {
        // Pending was selected against the same old binary. Promoting it would
        // reintroduce the mismatch one launch later.
        var state = Installed(Sha('b'), "1.3.0", "older-core", App) with
        {
            Pending = Sha('b'),
            PendingVersion = "1.3.0",
        };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().ContainSingle().Which.Should().Be(Sha('b'));
        result.Pending.Should().BeNull();
        UpdateLifecycle.OnStartup(result).Outcome.Should().Be(StartupOutcome.Unchanged);
    }

    [Fact]
    public void A_dropped_bundle_is_not_blocked()
    {
        // It did nothing wrong, and a native rollback can make it installable
        // again. Blocking it would surface months later as "this app stopped
        // taking updates".
        var state = Installed(Sha('a'), "1.2.0", "older-core", App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
        };

        var (result, _) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        result.Blocked.Should().BeEmpty();
    }

    [Fact]
    public void Probation_is_cleared_when_the_bundle_it_watches_is_dropped()
    {
        var state = Installed(Sha('a'), "1.2.0", "older-core", App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
            Probation = new BundleProbation(Sha('a'), 1),
        };

        var (result, _) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        result.Probation.Should().BeNull("a bundle that no longer serves cannot fail to boot");
    }

    [Fact]
    public void A_bundle_with_no_recorded_identity_is_dropped()
    {
        // Only reachable from a hand-edited or partially written state file.
        // Nothing can vouch for it, and the safe answer is the embedded copy.
        var state = new UpdateState { Current = Sha('a'), CurrentVersion = "1.2.0" };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().ContainSingle();
        result.Current.Should().BeNull();
    }

    [Fact]
    public void Only_the_incompatible_slot_is_dropped()
    {
        var state = new UpdateState
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
            Previous = Sha('b'),
            PreviousVersion = "1.1.0",
            Installed = new Dictionary<string, BundleIdentity>
            {
                [Sha('a')] = new("1.2.0", Core, App),
                [Sha('b')] = new("1.1.0", "older-core", App),
            },
        };

        var (result, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));

        dropped.Should().ContainSingle().Which.Should().Be(Sha('b'));
        result.Current.Should().Be(Sha('a'));
        result.Previous.Should().BeNull();
    }

    [Fact]
    public void Rollback_still_outranks_promotion_after_a_revalidation()
    {
        // Both survive revalidation, so the existing ordering rule must still
        // apply: a bundle that has burned its attempts goes before a newer one
        // is promoted, or the failure is hidden and the countdown restarts.
        var state = new UpdateState
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
            Previous = Sha('b'),
            PreviousVersion = "1.1.0",
            Pending = Sha('c'),
            PendingVersion = "1.3.0",
            Probation = new BundleProbation(Sha('a'), UpdateLifecycle.MaxBootAttempts),
            Installed = new Dictionary<string, BundleIdentity>
            {
                [Sha('a')] = new("1.2.0", Core, App),
                [Sha('b')] = new("1.1.0", Core, App),
                [Sha('c')] = new("1.3.0", Core, App),
            },
        };

        var (revalidated, dropped) = UpdateLifecycle.Revalidate(state, Host("1.0.0"));
        dropped.Should().BeEmpty();

        UpdateLifecycle.OnStartup(revalidated).Outcome.Should().Be(StartupOutcome.RolledBack);
    }

    [Fact]
    public void Identities_for_unreferenced_bundles_are_forgotten()
    {
        // Otherwise the state file grows by one entry per release, forever.
        var state = new UpdateState
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
            Installed = new Dictionary<string, BundleIdentity>
            {
                [Sha('a')] = new("1.2.0", Core, App),
                [Sha('z')] = new("0.9.0", Core, App),
            },
        };

        var trimmed = UpdateLifecycle.ForgetUnreferenced(state);

        trimmed.Installed.Should().ContainKey(Sha('a')).And.NotContainKey(Sha('z'));
    }

    [Fact]
    public void A_state_document_from_the_previous_schema_resolves_to_the_embedded_copy()
    {
        // Schema 1 carried no identities, so nothing can vouch for the bundle it
        // names. Parse already treats anything unreadable as Empty, which serves
        // the embedded copy.
        var schemaOne = """
            { "schema": 1, "current": "aaaa", "currentVersion": "1.2.0" }
            """;

        UpdateState.Parse(schemaOne).Should().Be(UpdateState.Empty);
    }

    [Fact]
    public void Identities_survive_a_write_and_read_round_trip()
    {
        var state = Installed(Sha('a'), "1.2.0", Core, App) with
        {
            Current = Sha('a'),
            CurrentVersion = "1.2.0",
        };

        UpdateState.Parse(state.ToJson()).Should().Be(state);
    }

    private static UpdateState Installed(string sha, string version, string core, string app)
        => new()
        {
            Installed = new Dictionary<string, BundleIdentity>(StringComparer.OrdinalIgnoreCase)
            {
                [sha] = new(version, core, app),
            },
        };

    private static HostContracts Host(string embeddedVersion) => new(Core, App, embeddedVersion);

    private static string Sha(char seed) => new(seed, 64);
}
