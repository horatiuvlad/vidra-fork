namespace Vidra.Updates.Tests;

/// <summary>
/// The promote / probation / rollback rules. These are the cases a CI end-to-end
/// test can only reach one at a time and slowly, so they are exhausted here.
/// </summary>
public class UpdateLifecycleTests
{
    [Fact]
    public void Nothing_pending_serves_what_is_current()
    {
        var state = new UpdateState { Current = Sha('a'), CurrentVersion = "1.1.0" };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.Unchanged);
        transition.State.Should().Be(state);
    }

    [Fact]
    public void A_pending_bundle_is_promoted_on_probation()
    {
        var state = new UpdateState
        {
            Current = Sha('a'),
            CurrentVersion = "1.0.0",
            Pending = Sha('b'),
            PendingVersion = "1.1.0",
        };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.Promoted);
        transition.State.Current.Should().Be(Sha('b'));
        transition.State.CurrentVersion.Should().Be("1.1.0");
        transition.State.Pending.Should().BeNull();
        transition.State.Probation.Should().Be(new BundleProbation(Sha('b'), 1));

        // The bundle it replaced is what a failed boot falls back to.
        transition.State.Previous.Should().Be(Sha('a'));
        transition.State.PreviousVersion.Should().Be("1.0.0");
    }

    [Fact]
    public void Promotion_from_the_embedded_bundle_leaves_no_previous()
    {
        var state = new UpdateState { Pending = Sha('b'), PendingVersion = "1.1.0" };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.State.Current.Should().Be(Sha('b'));
        transition.State.Previous.Should().BeNull("the embedded copy is the floor, not a bundle");
    }

    [Fact]
    public void A_confirmed_boot_clears_probation()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            Probation = new BundleProbation(Sha('b'), 1),
        };

        var confirmed = UpdateLifecycle.OnBootConfirmed(state);

        confirmed.Probation.Should().BeNull();
        confirmed.Current.Should().Be(Sha('b'));
    }

    [Fact]
    public void Confirming_twice_is_harmless()
    {
        var state = new UpdateState { Current = Sha('b'), Probation = new BundleProbation(Sha('b'), 1) };

        var once = UpdateLifecycle.OnBootConfirmed(state);
        var twice = UpdateLifecycle.OnBootConfirmed(once);

        twice.Should().Be(once);
    }

    [Fact]
    public void An_unconfirmed_bundle_gets_a_second_launch()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            Previous = Sha('a'),
            Probation = new BundleProbation(Sha('b'), 1),
        };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.Retried);
        transition.State.Current.Should().Be(Sha('b'), "one failure could be anything");
        transition.State.Probation!.Attempts.Should().Be(2);
    }

    [Fact]
    public void Two_failed_boots_roll_back_to_the_previous_bundle()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            CurrentVersion = "1.1.0",
            Previous = Sha('a'),
            PreviousVersion = "1.0.0",
            Probation = new BundleProbation(Sha('b'), 2),
        };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.RolledBack);
        transition.State.Current.Should().Be(Sha('a'));
        transition.State.CurrentVersion.Should().Be("1.0.0");
        transition.State.Probation.Should().BeNull();
    }

    [Fact]
    public void Rolling_back_from_the_first_ever_bundle_lands_on_the_embedded_copy()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            CurrentVersion = "1.1.0",
            Probation = new BundleProbation(Sha('b'), 2),
        };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.RolledBack);
        transition.State.Current.Should().BeNull("null means the embedded copy, which always works");
    }

    [Fact]
    public void A_rolled_back_bundle_is_never_installed_again()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            Previous = Sha('a'),
            Probation = new BundleProbation(Sha('b'), 2),
        };

        var rolledBack = UpdateLifecycle.OnStartup(state).State;

        rolledBack.Blocked.Should().Contain(Sha('b'));

        // Without this the next check re-downloads it, promotes it, and the app
        // fails twice again — a rollback loop rather than a rollback.
        var manifest = ManifestWith(("1.1.0", Sha('b')), ("1.0.0", Sha('a')));
        var chosen = BundleSelection.Choose(manifest, "core", "app", "1.0.0", blocked: rolledBack.Blocked);

        chosen.Should().BeNull();
    }

    [Fact]
    public void Blocking_the_same_bundle_twice_does_not_duplicate_it()
    {
        var state = new UpdateState
        {
            Current = Sha('b'),
            Probation = new BundleProbation(Sha('b'), 2),
            Blocked = [Sha('b')],
        };

        var rolledBack = UpdateLifecycle.OnStartup(state).State;

        rolledBack.Blocked.Should().ContainSingle();
    }

    [Fact]
    public void Rollback_wins_over_a_waiting_promotion()
    {
        // Promoting first would clear the probation that was about to fail and
        // start the countdown over, so a broken bundle could serve indefinitely
        // as long as the feed kept publishing.
        var state = new UpdateState
        {
            Current = Sha('b'),
            Previous = Sha('a'),
            Pending = Sha('c'),
            PendingVersion = "1.2.0",
            Probation = new BundleProbation(Sha('b'), 2),
        };

        var transition = UpdateLifecycle.OnStartup(state);

        transition.Outcome.Should().Be(StartupOutcome.RolledBack);
        transition.State.Current.Should().Be(Sha('a'));
        transition.State.Pending.Should().Be(Sha('c'), "the newer bundle is still worth trying next launch");
    }

    [Fact]
    public void Live_bundles_are_the_ones_worth_keeping_on_disk()
    {
        var state = new UpdateState { Current = Sha('b'), Previous = Sha('a'), Pending = Sha('c') };

        UpdateLifecycle.LiveBundles(state).Should().BeEquivalentTo([Sha('a'), Sha('b'), Sha('c')]);
    }

    private static BundleManifest ManifestWith(params (string Version, string Sha)[] entries)
        => new()
        {
            Bundles = entries
                .Select(entry => new BundleEntry
                {
                    Version = entry.Version,
                    Url = $"bundle-{entry.Version}.zip",
                    Sha256 = entry.Sha,
                    CoreFingerprint = "core",
                    AppFingerprint = "app",
                })
                .ToArray(),
        };

    private static string Sha(char seed) => new(seed, 64);
}
