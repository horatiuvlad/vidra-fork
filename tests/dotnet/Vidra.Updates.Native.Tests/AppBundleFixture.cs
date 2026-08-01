using Velopack.Locators;

namespace Vidra.Updates.Native.Tests;

/// <summary>
/// A throwaway <c>.app</c> shaped exactly like one <c>vpk pack</c> produces —
/// enough of one for a locator to read, which is all a locator ever does.
/// </summary>
/// <remarks>
/// Building it by hand rather than by running <c>vpk</c> is deliberate: this
/// has to work on the Linux leg, where <c>vpk</c> packs AppImages and there is
/// no macOS bundle to be had. The shape is pinned by the conformance test,
/// which reads the same tree with Velopack's own locator on the macOS leg — if
/// this fixture stopped resembling a real bundle, that test would say so.
/// </remarks>
internal sealed class AppBundleFixture : IDisposable
{
    private readonly string _work = Directory.CreateTempSubdirectory("vidra-native-").FullName;

    public string AppPath { get; private set; } = "";

    /// <summary>Absolute path of the app's own binary, as a process would report it.</summary>
    public string ExecutablePath => Path.Combine(AppPath, "Contents", "MacOS", MainExe);

    public string MainExe { get; private init; } = "Fixture";

    /// <summary>
    /// Writes a bundle. Each flag switches off one thing a real packed bundle
    /// has, so a test can ask what happens without it.
    /// </summary>
    public static AppBundleFixture Create(
        string appId = "com.vidra.fixture",
        string version = "1.2.3",
        string? channel = "osx",
        string mainExe = "Fixture",
        bool updateExe = true,
        bool manifestInMacOs = true,
        bool manifestInResources = true)
    {
        var fixture = new AppBundleFixture { MainExe = mainExe };
        fixture.AppPath = Path.Combine(fixture._work, "Fixture.app");

        var contents = Path.Combine(fixture.AppPath, "Contents");
        var macos = Path.Combine(contents, "MacOS");
        var resources = Path.Combine(contents, "Resources");
        Directory.CreateDirectory(macos);
        Directory.CreateDirectory(resources);

        File.WriteAllText(Path.Combine(macos, mainExe), "#!/bin/sh\n");
        if (updateExe) File.WriteAllText(Path.Combine(macos, "UpdateMac"), "#!/bin/sh\n");

        var nuspec = SpecVersion(appId, version, channel, mainExe);
        if (manifestInMacOs) File.WriteAllText(Path.Combine(macos, "sq.version"), nuspec);
        if (manifestInResources) File.WriteAllText(Path.Combine(resources, "sq.version"), nuspec);

        return fixture;
    }

    /// <summary>A file somewhere that is not a bundle at all.</summary>
    public string LooseExecutable(string name = "Loose")
    {
        var path = Path.Combine(_work, name);
        File.WriteAllText(path, "#!/bin/sh\n");
        return path;
    }

    /// <summary>Overwrites the manifest under <c>Contents/MacOS</c>.</summary>
    public void WriteMacOsManifest(string contents)
        => File.WriteAllText(Path.Combine(AppPath, "Contents", "MacOS", "sq.version"), contents);

    public void Dispose() => TryDelete(_work);

    /// <summary>
    /// Velopack writes its own nuspec into the bundle as <c>sq.version</c>.
    /// Only <c>id</c>, <c>version</c> and <c>channel</c> matter to a locator;
    /// the rest is here because a real one has it and a fixture that is too
    /// tidy stops resembling the thing it stands in for.
    /// </summary>
    private static string SpecVersion(string appId, string version, string? channel, string mainExe)
        => $"""
            <?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
              <metadata>
                <id>{appId}</id>
                <version>{version}</version>
                <title>{appId}</title>
                <description>{appId}</description>
                <authors>vidra</authors>
                <mainExe>{mainExe}</mainExe>
                <os>osx</os>{(channel is null ? "" : $"\n    <channel>{channel}</channel>")}
              </metadata>
            </package>
            """;

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>
/// Stands in for the running process, so a locator can be pointed at a fixture
/// on a machine that is not running it.
/// </summary>
/// <remarks>
/// Both locators under test take an <see cref="IProcessImpl"/>, which is what
/// makes the conformance comparison honest: the oracle and the copy are asked
/// about the same bundle, from the same claimed path, on the same machine.
/// </remarks>
internal sealed class FakeProcess(string processPath) : IProcessImpl
{
    public string GetCurrentProcessPath() => processPath;

    public uint GetCurrentProcessId() => 4242;

    public void Exit(int exitCode) => throw new NotSupportedException("a test never exits the process");

    public void StartProcess(string exePath, IEnumerable<string> args, string? workDir, bool showWindow)
        => throw new NotSupportedException("a test never starts a process");
}
