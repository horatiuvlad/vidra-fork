using System.IO.Compression;
using System.Security.Cryptography;

namespace Vidra.Updates.Tests;

/// <summary>
/// The installer treats a feed as hostile. These tests are the demonstration
/// that it does — each one is an archive a compromised or careless publisher
/// could serve.
/// </summary>
public sealed class BundleInstallerTests : IDisposable
{
    private readonly string _work = Directory.CreateTempSubdirectory("vidra-updates-").FullName;

    [Fact]
    public async Task Installs_a_good_bundle_into_a_directory_named_by_its_hash()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("index.html", "<h1>updated</h1>"), ("assets/app.js", "console.log(1)"));
        var store = Store();

        var directory = await new BundleInstaller(store).InstallAsync(new FileBundleSource(feed), entry);

        Path.GetFileName(directory).Should().Be(entry.Sha256);
        File.ReadAllText(Path.Combine(directory, "index.html")).Should().Be("<h1>updated</h1>");
        File.ReadAllText(Path.Combine(directory, "assets", "app.js")).Should().Be("console.log(1)");
    }

    [Fact]
    public async Task Refuses_an_archive_whose_hash_does_not_match()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("index.html", "<h1>good</h1>"));
        var tampered = entry with { Sha256 = new string('b', 64) };
        var store = Store();

        var install = async () => await new BundleInstaller(store).InstallAsync(new FileBundleSource(feed), tampered);

        await install.Should().ThrowAsync<BundleVerificationException>().WithMessage("*failed verification*");
        Directory.Exists(store.BundleDirectory(tampered.Sha256)).Should().BeFalse();
    }

    [Fact]
    public async Task Refuses_an_archive_whose_size_contradicts_the_manifest()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("index.html", "<h1>good</h1>"));
        var store = Store();

        var install = async () => await new BundleInstaller(store)
            .InstallAsync(new FileBundleSource(feed), entry with { Size = entry.Size + 100 });

        await install.Should().ThrowAsync<BundleVerificationException>().WithMessage("*bytes*");
    }

    [Fact]
    public async Task Refuses_an_archive_that_writes_outside_the_bundle()
    {
        // Zip-slip. Refused rather than sanitized: an entry named ../../ is not a
        // mistake to tidy up, it is an attempt.
        var feed = Feed();
        var entry = PublishRaw(feed, "1.1.0", archive =>
        {
            Write(archive, "index.html", "<h1>decoy</h1>");
            Write(archive, "../../escaped.txt", "pwned");
        });
        var store = Store();

        var install = async () => await new BundleInstaller(store).InstallAsync(new FileBundleSource(feed), entry);

        await install.Should().ThrowAsync<BundleVerificationException>().WithMessage("*outside the bundle*");
        File.Exists(Path.Combine(_work, "escaped.txt")).Should().BeFalse();
        File.Exists(Path.Combine(_work, "..", "escaped.txt")).Should().BeFalse();
    }

    [Fact]
    public async Task Refuses_an_archive_with_no_index_html()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("assets/app.js", "console.log(1)"));
        var store = Store();

        var install = async () => await new BundleInstaller(store).InstallAsync(new FileBundleSource(feed), entry);

        await install.Should().ThrowAsync<BundleVerificationException>().WithMessage("*no index.html*");
    }

    [Fact]
    public async Task Leaves_nothing_installed_when_it_refuses()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("assets/app.js", "console.log(1)"));
        var store = Store();

        try
        {
            await new BundleInstaller(store).InstallAsync(new FileBundleSource(feed), entry);
        }
        catch (BundleVerificationException)
        {
        }

        // No staging leftovers, no downloaded archive, nothing under the final name.
        Directory.GetFileSystemEntries(store.RootDirectory).Should().BeEmpty();
    }

    [Fact]
    public async Task Installing_an_already_installed_bundle_is_a_no_op()
    {
        var feed = Feed();
        var entry = Publish(feed, "1.1.0", ("index.html", "<h1>updated</h1>"));
        var store = Store();
        var installer = new BundleInstaller(store);

        var first = await installer.InstallAsync(new FileBundleSource(feed), entry);
        File.WriteAllText(Path.Combine(first, "marker.txt"), "still here");

        var second = await installer.InstallAsync(new FileBundleSource(feed), entry);

        second.Should().Be(first);
        File.Exists(Path.Combine(second, "marker.txt")).Should().BeTrue("re-extracting would have wiped it");
    }

    [Fact]
    public async Task A_feed_url_cannot_read_outside_the_feed_directory()
    {
        var feed = Feed();
        File.WriteAllText(Path.Combine(_work, "secret.txt"), "not a bundle");
        var entry = new BundleEntry
        {
            Version = "1.1.0",
            Url = "../secret.txt",
            Sha256 = new string('a', 64),
            CoreFingerprint = "core",
            AppFingerprint = "app",
        };

        var install = async () => await new BundleInstaller(Store()).InstallAsync(new FileBundleSource(feed), entry);

        await install.Should().ThrowAsync<BundleVerificationException>().WithMessage("*escapes the feed*");
    }

    private string Feed()
    {
        var feed = Path.Combine(_work, "feed");
        Directory.CreateDirectory(feed);
        return feed;
    }

    private BundleStore Store() => new(Path.Combine(_work, "appdata"));

    private static BundleEntry Publish(string feed, string version, params (string Path, string Content)[] files)
        => PublishRaw(feed, version, archive =>
        {
            foreach (var (path, content) in files)
                Write(archive, path, content);
        });

    private static BundleEntry PublishRaw(string feed, string version, Action<ZipArchive> build)
    {
        var name = $"bundle-{version}.zip";
        var path = Path.Combine(feed, name);

        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            build(archive);
        }

        using var stream = File.OpenRead(path);
        return new BundleEntry
        {
            Version = version,
            Url = name,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(stream)),
            Size = new FileInfo(path).Length,
            CoreFingerprint = "core",
            AppFingerprint = "app",
        };
    }

    private static void Write(ZipArchive archive, string path, string content)
    {
        var entry = archive.CreateEntry(path);
        using var writer = new StreamWriter(entry.Open());
        writer.Write(content);
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
