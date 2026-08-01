namespace Vidra.Updates.Tests;

public sealed class BundleStoreTests : IDisposable
{
    private readonly string _appData = Directory.CreateTempSubdirectory("vidra-store-").FullName;

    [Fact]
    public void Scopes_itself_under_vidra_inside_app_data()
    {
        // On Mac Catalyst AppDataDirectory is $HOME/Library itself, so an
        // unscoped bundles/ would land in the user's Library root.
        var store = new BundleStore(_appData);

        store.RootDirectory.Should().Be(Path.Combine(_appData, "vidra", "bundles"));
        store.StatePath.Should().Be(Path.Combine(_appData, "vidra", "bundles", "state.json"));
    }

    [Fact]
    public void A_bundle_name_that_is_not_a_hash_is_refused()
    {
        var store = new BundleStore(_appData);

        // The name comes from a manifest, so it is a path traversal waiting to
        // happen until it has been proved to be a digest.
        var resolve = () => store.BundleDirectory("../../../etc");

        resolve.Should().Throw<BundleVerificationException>();
    }

    [Fact]
    public void State_survives_a_round_trip()
    {
        var store = new BundleStore(_appData);
        var state = new UpdateState
        {
            Current = Sha('a'),
            CurrentVersion = "1.1.0",
            Previous = Sha('b'),
            PreviousVersion = "1.0.0",
            Pending = Sha('c'),
            PendingVersion = "1.2.0",
            Probation = new BundleProbation(Sha('a'), 2),
            Blocked = [Sha('d')],
        };

        store.SaveState(state);

        store.LoadState().Should().Be(state);
    }

    [Fact]
    public void Two_states_with_the_same_contents_are_equal()
    {
        // A record compares its list property by reference, so without explicit
        // equality a state written and read back would never equal itself.
        var left = new UpdateState { Current = Sha('a'), Blocked = [Sha('b'), Sha('c')] };
        var right = new UpdateState { Current = Sha('a'), Blocked = [Sha('b'), Sha('c')] };

        left.Should().Be(right);
        left.GetHashCode().Should().Be(right.GetHashCode());
        left.Should().NotBe(right with { Blocked = [Sha('b')] });
    }

    [Fact]
    public void An_empty_state_round_trips_as_the_embedded_bundle()
    {
        var store = new BundleStore(_appData);

        store.SaveState(UpdateState.Empty);

        store.LoadState().Should().Be(UpdateState.Empty);
        store.ResolveAssetRoot(store.LoadState()).Should().BeNull();
    }

    [Fact]
    public void A_damaged_state_file_falls_back_to_the_embedded_bundle()
    {
        var store = new BundleStore(_appData);
        store.EnsureCreated();
        File.WriteAllText(store.StatePath, "{ this is not json");

        // Refusing to start because update bookkeeping is unreadable would be a
        // far worse failure than missing an update.
        store.LoadState().Should().Be(UpdateState.Empty);
    }

    [Fact]
    public void A_state_file_from_a_newer_host_is_ignored_rather_than_misread()
    {
        var store = new BundleStore(_appData);
        store.EnsureCreated();
        File.WriteAllText(store.StatePath, """{ "schema": 99, "current": "whatever" }""");

        store.LoadState().Should().Be(UpdateState.Empty);
    }

    [Fact]
    public void Resolving_skips_a_bundle_whose_directory_went_missing()
    {
        var store = new BundleStore(_appData);
        var state = new UpdateState { Current = Sha('a') };

        store.ResolveAssetRoot(state).Should().BeNull("a referenced bundle that is not on disk is not servable");
    }

    [Fact]
    public void Resolving_skips_a_bundle_with_no_index_html()
    {
        var store = new BundleStore(_appData);
        Directory.CreateDirectory(store.BundleDirectory(Sha('a')));

        store.ResolveAssetRoot(new UpdateState { Current = Sha('a') }).Should().BeNull();
    }

    [Fact]
    public void Resolving_returns_the_directory_of_a_complete_bundle()
    {
        var store = new BundleStore(_appData);
        var directory = store.BundleDirectory(Sha('a'));
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "index.html"), "<h1>hi</h1>");

        store.ResolveAssetRoot(new UpdateState { Current = Sha('a') }).Should().Be(directory);
    }

    [Fact]
    public void Pruning_keeps_what_is_referenced_and_removes_the_rest()
    {
        var store = new BundleStore(_appData);
        foreach (var seed in "abcd")
            Directory.CreateDirectory(store.BundleDirectory(Sha(seed)));

        Directory.CreateDirectory(Path.Combine(store.RootDirectory, ".staging-interrupted"));
        File.WriteAllText(Path.Combine(store.RootDirectory, ".download-abandoned.zip"), "junk");

        var state = new UpdateState { Current = Sha('a'), Previous = Sha('b'), Pending = Sha('c') };
        var removed = store.Prune(state);

        removed.Should().BeEquivalentTo([Sha('d'), ".staging-interrupted"]);
        Directory.Exists(store.BundleDirectory(Sha('a'))).Should().BeTrue();
        Directory.Exists(store.BundleDirectory(Sha('b'))).Should().BeTrue("it is the rollback target");
        Directory.Exists(store.BundleDirectory(Sha('c'))).Should().BeTrue("it is staged for the next launch");
        Directory.GetFiles(store.RootDirectory, ".download-*.zip").Should().BeEmpty();
    }

    private static string Sha(char seed) => new(seed, 64);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_appData, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
