namespace Vidra.Updates.Native.Tests;

/// <summary>
/// What the Catalyst locator reads out of a packed bundle.
/// </summary>
/// <remarks>
/// These run on the Linux leg in milliseconds because the locator is a pure
/// function of a process path and the files under it, with no MAUI, no UIKit, no
/// packaged app. The macOS leg then checks the same class against Velopack's
/// own implementation (<see cref="LocatorConformanceTests"/>); this file is
/// about behaviour we chose, that one is about behaviour we copied.
/// </remarks>
public sealed class VidraCatalystLocatorTests
{
    [Fact]
    public void Reads_the_app_identity_out_of_sq_version()
    {
        using var app = AppBundleFixture.Create(appId: "com.example.notes", version: "2.4.1", channel: "osx");

        var locator = Locate(app);

        locator.AppId.Should().Be("com.example.notes");
        locator.CurrentlyInstalledVersion!.ToString().Should().Be("2.4.1");
        locator.Channel.Should().Be("osx");
    }

    [Fact]
    public void Points_at_the_bundle_the_process_is_running_from()
    {
        using var app = AppBundleFixture.Create();

        var locator = Locate(app);

        locator.RootAppDir.Should().Be(app.AppPath);
        locator.AppContentDir.Should().Be(Path.Combine(app.AppPath, "Contents", "MacOS"));
        locator.UpdateExePath.Should().Be(Path.Combine(app.AppPath, "Contents", "MacOS", "UpdateMac"));
        locator.ThisExeRelativePath.Should().Be("Fixture");
    }

    /// <summary>
    /// A packed <c>.app</c> updates itself wherever the user dragged it, which
    /// is what Velopack calls portable on macOS. Getting this wrong would make
    /// <c>UpdateManager</c> look for an installer that is not there.
    /// </summary>
    [Fact]
    public void Is_portable_like_a_mac_app_is()
    {
        using var app = AppBundleFixture.Create();

        Locate(app).IsPortable.Should().BeTrue();
    }

    /// <summary>
    /// <c>vpk pack</c> writes the manifest twice. Only the copy under
    /// <c>Contents/Resources</c> survives some bundle-rewriting tools, so the
    /// fallback is not theoretical.
    /// </summary>
    [Fact]
    public void Falls_back_to_the_manifest_under_Resources()
    {
        using var app = AppBundleFixture.Create(appId: "com.example.fallback", manifestInMacOs: false);

        Locate(app).AppId.Should().Be("com.example.fallback");
    }

    [Fact]
    public void Prefers_the_manifest_under_MacOS()
    {
        using var app = AppBundleFixture.Create(appId: "com.example.resources");
        app.WriteMacOsManifest("""
            <?xml version="1.0" encoding="utf-8"?>
            <package><metadata><id>com.example.macos</id><version>9.9.9</version></metadata></package>
            """);

        Locate(app).AppId.Should().Be("com.example.macos");
    }

    /// <summary>
    /// No <c>UpdateMac</c> means this bundle was never packed, most likely a plain
    /// <c>vidra build</c> output, most likely. Answering "nothing installed"
    /// makes <c>UpdateManager.IsInstalled</c> false, which is the honest
    /// answer; throwing here would take the app down at launch.
    /// </summary>
    [Fact]
    public void Reports_nothing_when_the_bundle_was_never_packed()
    {
        using var app = AppBundleFixture.Create(updateExe: false);

        var locator = Locate(app);

        locator.AppId.Should().BeNull();
        locator.RootAppDir.Should().BeNull();
        locator.CurrentlyInstalledVersion.Should().BeNull();
    }

    [Fact]
    public void Reports_nothing_when_both_manifests_are_missing()
    {
        using var app = AppBundleFixture.Create(manifestInMacOs: false, manifestInResources: false);

        Locate(app).AppId.Should().BeNull();
    }

    [Fact]
    public void Reports_nothing_when_the_manifest_is_not_valid_xml()
    {
        using var app = AppBundleFixture.Create(manifestInResources: false);
        app.WriteMacOsManifest("this is not a nuspec");

        Locate(app).AppId.Should().BeNull();
    }

    /// <summary>
    /// A `dotnet run` of the same code is not inside a <c>.app</c> at all. That
    /// is the normal development case, so it has to be quiet rather than fatal.
    /// </summary>
    [Fact]
    public void Survives_a_process_that_is_not_inside_a_bundle()
    {
        using var app = AppBundleFixture.Create();

        var locator = new VidraCatalystLocator(new FakeProcess(app.LooseExecutable()));

        locator.AppId.Should().BeNull();
        locator.RootAppDir.Should().BeNull();
        locator.ThisExeRelativePath.Should().BeNull();
    }

    /// <summary>
    /// The one path Velopack stages downloads into. It lives outside the
    /// bundle on purpose, because the bundle is what gets replaced.
    /// </summary>
    [Fact]
    public void Stages_packages_under_the_user_caches_directory()
    {
        using var home = new TemporaryHome();
        using var app = AppBundleFixture.Create(appId: "com.example.caches");

        var packages = Locate(app).PackagesDir;

        packages.Should().Be(Path.Combine(home.Path, "Library", "Caches", "velopack", "com.example.caches", "packages"));
        Directory.Exists(packages).Should().BeTrue();
    }

    /// <summary>
    /// A bundle carrying no channel means Velopack's own default for the
    /// platform, which <c>UpdateManager</c> resolves, not the empty string,
    /// which would look for <c>releases..json</c>.
    /// </summary>
    [Fact]
    public void Leaves_the_channel_unset_when_the_manifest_has_none()
    {
        using var app = AppBundleFixture.Create(channel: null);

        Locate(app).Channel.Should().BeNull();
    }

    private static VidraCatalystLocator Locate(AppBundleFixture app)
        => new(new FakeProcess(app.ExecutablePath));
}

/// <summary>
/// Redirects <c>$HOME</c> so a test can assert the real path a locator builds
/// without writing into the developer's own <c>Library/Caches</c>.
/// </summary>
/// <remarks>
/// Process-global state, which is why the assembly runs its tests serially
/// (see <c>AssemblyInfo.cs</c>).
/// </remarks>
internal sealed class TemporaryHome : IDisposable
{
    private const string HomeVariable = "HOME";

    private readonly string? _previous = Environment.GetEnvironmentVariable(HomeVariable);

    public string Path { get; } = Directory.CreateTempSubdirectory("vidra-home-").FullName;

    public TemporaryHome() => Environment.SetEnvironmentVariable(HomeVariable, Path);

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(HomeVariable, _previous);
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
