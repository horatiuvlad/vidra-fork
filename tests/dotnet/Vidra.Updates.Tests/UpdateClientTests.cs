using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Vidra.Updates.Tests;

/// <summary>
/// The whole check, end to end over a directory feed — the same code path the
/// HTTP feed takes, minus the socket.
/// </summary>
public sealed class UpdateClientTests : IDisposable
{
    private const string Core = "a4d6e4856749f06fd3c84be9bb5a468c5219e71797777a977a2d0772dc6214db";
    private const string App = "d3044812d17c42049962d730fced04a6ecd711e287cdd0da7b218b327ee6cd56";

    private readonly string _work = Directory.CreateTempSubdirectory("vidra-client-").FullName;

    [Fact]
    public async Task Downloads_a_newer_compatible_bundle_and_stages_it()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var store = Store();

        var result = await new UpdateClient(store).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.Downloaded);
        result.State!.Pending.Should().NotBeNull();
        result.State.PendingVersion.Should().Be("1.1.0");

        // Staged, not promoted: what serves this session is unchanged.
        result.State.Current.Should().BeNull();
        store.ResolveAssetRoot(result.State).Should().BeNull();

        // And it is really on disk, ready for the next launch.
        var directory = store.BundleDirectory(result.State.Pending!);
        File.ReadAllText(Path.Combine(directory, "index.html")).Should().Contain("1.1.0");
    }

    [Fact]
    public async Task Promoting_the_staged_bundle_is_what_makes_it_serve()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var store = Store();
        var staged = (await new UpdateClient(store).CheckAsync(new FileBundleSource(feed), Request())).State!;

        var transition = UpdateLifecycle.OnStartup(staged);
        store.SaveState(transition.State);

        transition.Outcome.Should().Be(StartupOutcome.Promoted);
        store.ResolveAssetRoot(store.LoadState()).Should().NotBeNull();
    }

    [Fact]
    public async Task Says_nothing_is_installable_when_every_entry_is_for_another_build()
    {
        var feed = PublishFeed(("2.0.0", "0000", App), ("3.0.0", Core, "0000"));

        var result = await new UpdateClient(Store()).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.NoUpdate);
        // "No update" and "two updates exist and neither fits" must not read the same.
        result.Reason.Should().Contain("different core contract").And.Contain("different app contract");
    }

    [Fact]
    public async Task A_corrupted_archive_fails_the_check_and_stages_nothing()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var archive = Directory.GetFiles(feed, "*.zip").Single();
        File.WriteAllBytes(archive, [.. File.ReadAllBytes(archive), 0x00]);
        var store = Store();

        var result = await new UpdateClient(store).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.Failed);
        // The appended byte can trip either guard — the mid-copy size cap or the
        // hash check — depending on where the stream ends. Both are refusals.
        result.Reason.Should().MatchRegex("verification|exceeds its declared size");
        store.LoadState().Pending.Should().BeNull();
    }

    [Fact]
    public async Task An_unreachable_feed_is_reported_not_thrown()
    {
        // A background check in a working app must not become an exception the
        // host has to catch, and being offline is the normal case, not an error.
        var result = await new UpdateClient(Store())
            .CheckAsync(new FileBundleSource(Path.Combine(_work, "nowhere")), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.Failed);
    }

    [Fact]
    public async Task A_manifest_from_a_newer_publisher_is_refused()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var manifestPath = Path.Combine(feed, "bundles.json");
        File.WriteAllText(manifestPath, File.ReadAllText(manifestPath).Replace("\"schema\": 1", "\"schema\": 2"));

        var result = await new UpdateClient(Store()).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.Failed);
        result.Reason.Should().Contain("schema");
    }

    [Fact]
    public async Task Checking_twice_does_not_download_twice()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var store = Store();
        var client = new UpdateClient(store);

        await client.CheckAsync(new FileBundleSource(feed), Request());
        var second = await client.CheckAsync(new FileBundleSource(feed), Request());

        second.Outcome.Should().Be(UpdateCheckOutcome.NoUpdate);
        second.Reason.Should().Contain("already staged");
    }

    [Fact]
    public async Task A_new_version_of_byte_identical_content_is_not_downloaded()
    {
        // What `npm version patch` with no source changes produces: the archive is
        // deterministic, so the sha is unchanged while the entry looks new.
        // Installing it would re-download what is already on disk and leave
        // Current and Previous on one sha — which LiveBundles dedupes, arming a
        // rollback with nowhere to roll back to.
        var feed = PublishFeed(("1.1.0", Core, App));
        var store = Store();
        var entry = BundleManifest.Parse(await new FileBundleSource(feed).GetManifestAsync()).Bundles.Single();

        store.SaveState(new UpdateState
        {
            Current = entry.Sha256,
            CurrentVersion = entry.Version,
            Installed = new Dictionary<string, BundleIdentity>(StringComparer.OrdinalIgnoreCase)
            {
                [entry.Sha256] = new(entry.Version, Core, App),
            },
        });

        // The same archive, republished a version later.
        File.WriteAllText(
            Path.Combine(feed, "bundles.json"),
            "{\n  \"schema\": 1,\n  \"bundles\": [\n"
            + "    { \"version\": \"1.2.0\", \"url\": \"" + entry.Url + "\""
            + ", \"sha256\": \"" + entry.Sha256 + "\", \"size\": " + entry.Size
            + ", \"coreFingerprint\": \"" + Core + "\", \"appFingerprint\": \"" + App + "\" }\n  ]\n}\n");

        var result = await new UpdateClient(store).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.NoUpdate);
        result.Reason.Should().Contain("byte-identical");
        store.LoadState().Pending.Should().BeNull();
    }

    [Fact]
    public async Task A_bundle_that_was_rolled_back_is_not_downloaded_again()
    {
        var feed = PublishFeed(("1.1.0", Core, App));
        var store = Store();
        var entry = BundleManifest.Parse(await new FileBundleSource(feed).GetManifestAsync()).Bundles.Single();
        store.SaveState(new UpdateState { Blocked = [entry.Sha256] });

        var result = await new UpdateClient(store).CheckAsync(new FileBundleSource(feed), Request());

        result.Outcome.Should().Be(UpdateCheckOutcome.NoUpdate);
        result.Reason.Should().Contain("already rejected");
    }

    private BundleStore Store() => new(Path.Combine(_work, "appdata"));

    private static UpdateCheckRequest Request(string embeddedVersion = "1.0.0")
        => new() { CoreFingerprint = Core, AppFingerprint = App, EmbeddedVersion = embeddedVersion };

    private string PublishFeed(params (string Version, string Core, string App)[] entries)
    {
        var feed = Path.Combine(_work, "feed");
        Directory.CreateDirectory(feed);

        var items = new List<string>();
        foreach (var (version, core, app) in entries)
        {
            var name = $"bundle-{version}.zip";
            var path = Path.Combine(feed, name);

            using (var file = File.Create(path))
            using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
            {
                var index = archive.CreateEntry("index.html");
                using var writer = new StreamWriter(index.Open());
                writer.Write($"<h1>bundle {version}</h1>");
            }

            string sha;
            using (var stream = File.OpenRead(path))
                sha = Convert.ToHexStringLower(SHA256.HashData(stream));

            items.Add(
                "    { \"version\": \"" + version + "\""
                + ", \"url\": \"" + name + "\""
                + ", \"sha256\": \"" + sha + "\""
                + ", \"size\": " + new FileInfo(path).Length
                + ", \"coreFingerprint\": \"" + core + "\""
                + ", \"appFingerprint\": \"" + app + "\" }");
        }

        var json = new StringBuilder()
            .Append("{\n  \"schema\": 1,\n  \"bundles\": [\n")
            .Append(string.Join(",\n", items))
            .Append("\n  ]\n}\n");

        File.WriteAllText(Path.Combine(feed, "bundles.json"), json.ToString());
        return feed;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_work, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
