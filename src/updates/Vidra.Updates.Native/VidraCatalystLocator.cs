using System.Runtime.InteropServices;
using Velopack;
using Velopack.Locators;
using Velopack.Logging;
using Velopack.NuGet;

namespace Vidra.Updates.Native;

/// <summary>
/// Teaches Velopack's client what a Mac Catalyst app is.
/// </summary>
/// <remarks>
/// <para>
/// Velopack advertises Windows, OSX and Linux. On Mac Catalyst
/// <c>RuntimeInformation.IsOSPlatform(OSPlatform.OSX)</c> is <b>false</b>. That
/// was measured in a packaged app rather than read out of their source. So
/// <c>VelopackRuntimeInfo.SystemOs</c> stays <c>Unknown</c>,
/// <c>VelopackLocator.CreateDefaultForPlatform</c> has no branch to take, and
/// <c>VelopackApp.Run()</c> throws <c>PlatformNotSupportedException</c> before
/// any update logic runs. Their own <see cref="OsxVelopackLocator"/> cannot be
/// borrowed either: its constructor refuses a non-osx system.
/// </para>
/// <para>
/// That is an unsupported platform, not a defect, and Velopack's own error
/// message names the way out: <c>provide IVelopackLocator as a method
/// parameter</c>. This is that locator. Everything else about a Catalyst
/// install is a macOS install: <c>vpk pack</c> writes the same
/// <c>sq.version</c>, ships the same <c>UpdateMac</c>, and stages packages in
/// the same place, so this mirrors <see cref="OsxVelopackLocator"/> property
/// for property rather than inventing a layout.
/// </para>
/// <para>
/// It deliberately does <b>not</b> guard on the running OS. Every value it
/// produces is a function of the process path and the files under it, so it
/// constructs anywhere, which is what lets the Linux leg exercise it over a
/// fixture <c>.app</c> tree in milliseconds, and what lets the macOS leg
/// construct it alongside Velopack's own locator and compare the two
/// (<c>Vidra.Updates.Native.Tests</c>). Their implementation is the oracle: the
/// day they move <c>packages/</c>, that test fails on us before a user does.
/// </para>
/// </remarks>
public sealed class VidraCatalystLocator : VelopackLocator
{
    /// <summary>The nuspec Velopack drops into a packed bundle.</summary>
    internal const string SpecVersionFileName = "sq.version";

    private readonly IVelopackLogger _log;

    /// <inheritdoc />
    public override string? AppId { get; }

    /// <inheritdoc />
    public override string? RootAppDir { get; }

    /// <inheritdoc />
    public override string? AppContentDir { get; }

    /// <inheritdoc />
    public override string? UpdateExePath { get; }

    /// <inheritdoc />
    public override SemanticVersion? CurrentlyInstalledVersion { get; }

    /// <inheritdoc />
    public override string? Channel { get; }

    /// <inheritdoc />
    public override IProcessImpl Process { get; }

    /// <inheritdoc />
    public override IVelopackLogger Log => _log;

    /// <summary>
    /// A packed <c>.app</c> updates in place, in whatever directory the user
    /// dragged it to, which is the same thing Velopack means by portable on macOS.
    /// </summary>
    public override bool IsPortable => true;

    /// <inheritdoc />
    public override string? PackagesDir => CreateSubDirIfDoesNotExist(CachesAppDir, "packages");

    /// <inheritdoc />
    public override string? AppTempDir => CreateSubDirIfDoesNotExist(DefaultTempBaseDirectory(), AppId);

    private string? CachesAppDir => CreateSubDirIfDoesNotExist(CachesVelopackDir, AppId);
    private string? CachesVelopackDir => CreateSubDirIfDoesNotExist(CachesDir, "velopack");
    private string? CachesDir => CreateSubDirIfDoesNotExist(LibraryDir, "Caches");
    private string? LibraryDir => CreateSubDirIfDoesNotExist(HomeDir, "Library");
    private static string? HomeDir => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>
    /// Reads the app's identity out of the <c>.app</c> the running process
    /// lives in. Everything stays <see langword="null"/> when it is not in one
    /// (an unpacked development build, say) which is the same answer
    /// Velopack's own locators give, and it makes
    /// <c>UpdateManager.IsInstalled</c> false rather than throwing.
    /// </summary>
    /// <param name="processImpl">
    /// How the locator learns where it is running. Tests pass a fake pointing
    /// into a fixture; the app passes <see langword="null"/> for the default.
    /// </param>
    /// <param name="customLog">An extra logger to fan out to, or <see langword="null"/>.</param>
    public VidraCatalystLocator(IProcessImpl? processImpl = null, IVelopackLogger? customLog = null)
    {
        var log = new FanOutVelopackLogger(customLog);
        _log = log;
        Process = processImpl ?? new DefaultProcessImpl(log);

        var ourPath = Process.GetCurrentProcessPath();

        // Same test as OsxVelopackLocator's, character for character: the
        // bundle root is the first path component ending in `.app`.
        var ix = ourPath.IndexOf(".app/", StringComparison.InvariantCultureIgnoreCase);
        if (ix > 0)
        {
            var appPath = ourPath[..(ix + 4)];
            var contentsDir = Path.Combine(appPath, "Contents");
            var macosDir = Path.Combine(contentsDir, "MacOS");
            var updateExe = Path.Combine(macosDir, "UpdateMac");
            var metadataPath = Path.Combine(macosDir, SpecVersionFileName);
            var resourcesMetadataPath = Path.Combine(contentsDir, "Resources", SpecVersionFileName);

            // Both locations, in this order: `vpk pack` writes the manifest
            // twice and the copy under `Contents/MacOS` is the canonical one.
            if (File.Exists(updateExe)
                && (PackageManifest.TryParseFromFile(metadataPath, out var manifest)
                    || PackageManifest.TryParseFromFile(resourcesMetadataPath, out manifest)))
            {
                AppId = manifest.Id;
                RootAppDir = appPath;
                AppContentDir = macosDir;
                UpdateExePath = updateExe;
                CurrentlyInstalledVersion = manifest.Version;
                Channel = manifest.Channel;
            }
        }

        log.Attach(OpenLogFile());

        if (AppId is null)
        {
            _log.Warn($"{nameof(VidraCatalystLocator)}: '{ourPath}' is not inside a packed .app; native updates are unavailable.");
        }
        else
        {
            _log.Info($"{nameof(VidraCatalystLocator)}: {AppId} v{CurrentlyInstalledVersion} (channel {Channel ?? "<default>"})");
        }
    }

    /// <summary>
    /// Where a Catalyst app writes its Velopack log. Mirrors
    /// <see cref="OsxVelopackLocator"/>: the user's <c>Library/Logs</c> when it
    /// exists, the temp directory otherwise.
    /// </summary>
    private IVelopackLogger? OpenLogFile()
    {
        try
        {
            var home = HomeDir;
            var userLogs = string.IsNullOrEmpty(home) ? null : Path.Combine(home, "Library", "Logs");
            var folder = userLogs is not null && Directory.Exists(userLogs) ? userLogs : Path.GetTempPath();
            var name = AppId is null ? "velopack.log" : $"velopack_{AppId}.log";
            return new FileVelopackLogger(Path.Combine(folder, name), Process.GetCurrentProcessId());
        }
        catch
        {
            // A locator that cannot open its log file is still a working
            // locator. Failing construction here would turn a read-only home
            // directory into "this app cannot update".
            return null;
        }
    }

    /// <summary>
    /// Velopack's <c>TempUtil.GetDefaultTempBaseDirectory()</c>, which is
    /// internal, reproduced here so <see cref="AppTempDir"/> matches theirs.
    /// </summary>
    /// <remarks>
    /// Their last branch throws <c>PlatformNotSupportedException</c> on any OS
    /// that is not Windows, OSX or Linux, which is Catalyst, the one platform
    /// this class exists for. In practice macOS always sets <c>TMPDIR</c>, so
    /// the environment branch above it wins and the two agree; the fallback
    /// here is <c>Path.GetTempPath()</c> rather than a throw, because a
    /// scratch directory is not worth taking the process down for.
    /// </remarks>
    private static string? DefaultTempBaseDirectory()
    {
        try
        {
            var velopackTemp = Environment.GetEnvironmentVariable("VELOPACK_TEMP");
            var envTempDir = new[] { "TMPDIR", "TEMP", "TMP" }
                .Select(Environment.GetEnvironmentVariable)
                .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));

            var tempDir = !string.IsNullOrWhiteSpace(velopackTemp)
                ? velopackTemp!
                : !string.IsNullOrWhiteSpace(envTempDir)
                    ? Path.Combine(envTempDir!, "velopack")
                    : RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                        ? Path.Combine(Path.GetTempPath(), "velopack")
                        : "/tmp/velopack";

            var di = new DirectoryInfo(tempDir);
            if (!di.Exists) di.Create();
            return di.FullName;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// A logger that writes to zero or more others.
    /// </summary>
    /// <remarks>
    /// Velopack's own <c>CombinedVelopackLogger</c> does this, but it and the
    /// <c>CombinedLogger</c> property that feeds <c>VelopackLocator.Log</c> are
    /// both <c>internal</c>, so a locator outside their assembly has to bring
    /// its own. One consequence worth knowing: the base class's
    /// <c>AddLogger</c> writes to that internal field and is not virtual, so
    /// <c>VelopackApp.Build().SetLogger(...)</c> does not reach this locator.
    /// Pass the logger to the constructor instead.
    /// </remarks>
    private sealed class FanOutVelopackLogger(IVelopackLogger? first) : IVelopackLogger
    {
        private readonly List<IVelopackLogger> _targets = first is null ? [] : [first];

        public void Attach(IVelopackLogger? logger)
        {
            if (logger is not null) _targets.Add(logger);
        }

        public void Log(VelopackLogLevel logLevel, string? message, Exception? exception)
        {
            foreach (var target in _targets)
            {
                try
                {
                    target.Log(logLevel, message, exception);
                }
                catch
                {
                    // Logging must never be the reason an update fails.
                }
            }
        }
    }
}
