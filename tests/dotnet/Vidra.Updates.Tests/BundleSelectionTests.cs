namespace Vidra.Updates.Tests;

public class BundleSelectionTests
{
    private const string Core = "a4d6e4856749f06fd3c84be9bb5a468c5219e71797777a977a2d0772dc6214db";
    private const string App = "d3044812d17c42049962d730fced04a6ecd711e287cdd0da7b218b327ee6cd56";

    [Fact]
    public void Picks_the_newest_compatible_bundle()
    {
        var manifest = Manifest(
            Entry("1.1.0"),
            Entry("1.3.0"),
            Entry("1.2.0"));

        var chosen = BundleSelection.Choose(manifest, Core, App, "1.0.0");

        chosen!.Entry.Version.Should().Be("1.3.0");
    }

    [Fact]
    public void Ignores_a_bundle_built_against_a_different_core_contract()
    {
        var manifest = Manifest(Entry("2.0.0", core: "0000"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0").Should().BeNull(
            "a newer bundle that calls a bridge this host does not have is not an upgrade, it is a crash");
    }

    [Fact]
    public void Ignores_a_bundle_built_against_a_different_app_contract()
    {
        var manifest = Manifest(Entry("2.0.0", app: "0000"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0").Should().BeNull();
    }

    [Fact]
    public void Both_fingerprints_have_to_match()
    {
        var manifest = Manifest(
            Entry("2.0.0", core: "0000"),
            Entry("1.9.0"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0")!.Entry.Version.Should().Be("1.9.0");
    }

    [Fact]
    public void Does_not_reinstall_the_running_version()
    {
        var manifest = Manifest(Entry("1.2.0"));

        BundleSelection.Choose(manifest, Core, App, "1.2.0").Should().BeNull();
    }

    [Fact]
    public void Does_not_go_backwards()
    {
        var manifest = Manifest(Entry("1.1.0"));

        BundleSelection.Choose(manifest, Core, App, "1.2.0").Should().BeNull();
    }

    [Fact]
    public void With_nothing_installed_any_compatible_bundle_qualifies()
    {
        var manifest = Manifest(Entry("0.0.1"));

        BundleSelection.Choose(manifest, Core, App, currentVersion: null)!.Entry.Version.Should().Be("0.0.1");
    }

    [Fact]
    public void Entries_on_another_channel_are_ignored()
    {
        var manifest = Manifest(
            Entry("2.0.0", channel: "beta"),
            Entry("1.5.0", channel: "stable"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0", channel: "stable")!
            .Entry.Version.Should().Be("1.5.0");
    }

    [Fact]
    public void An_entry_without_a_channel_serves_every_channel()
    {
        var manifest = Manifest(Entry("2.0.0"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0", channel: "beta")!
            .Entry.Version.Should().Be("2.0.0");
    }

    [Fact]
    public void An_unparseable_version_is_skipped_rather_than_crashing_the_check()
    {
        var manifest = Manifest(Entry("not-a-version"), Entry("1.1.0"));

        BundleSelection.Choose(manifest, Core, App, "1.0.0")!.Entry.Version.Should().Be("1.1.0");
    }

    [Fact]
    public void Every_rejection_is_reportable()
    {
        var manifest = Manifest(
            Entry("2.0.0", core: "0000"),
            Entry("0.9.0"),
            Entry("1.5.0"));

        var evaluated = BundleSelection.Evaluate(manifest, Core, App, "1.0.0");

        evaluated.Select(candidate => candidate.Rejection).Should().BeEquivalentTo(
        [
            BundleRejection.IncompatibleCoreContract,
            BundleRejection.NotNewer,
            BundleRejection.None,
        ]);
    }

    private static BundleManifest Manifest(params BundleEntry[] entries)
        => new() { Bundles = entries };

    private static BundleEntry Entry(
        string version,
        string? core = null,
        string? app = null,
        string? channel = null)
        => new()
        {
            Version = version,
            Url = $"bundle-{version}.zip",
            Sha256 = new string('a', 64),
            CoreFingerprint = core ?? Core,
            AppFingerprint = app ?? App,
            Channel = channel,
        };
}
