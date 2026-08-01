using Velopack;
using Velopack.Locators;
using Vidra.Updates.Native;

namespace Vidra.Hosting;

/// <summary>What the running app can say about its own native updates.</summary>
public interface IVidraNativeUpdates
{
    /// <summary>
    /// Whether this process is running from a Velopack install at all. False
    /// for a `dotnet run`, an unpacked build, or a bundle that was never packed
    /// — in which case nothing here does anything.
    /// </summary>
    bool IsInstalled { get; }

    /// <summary>The version Velopack believes is installed.</summary>
    string? CurrentVersion { get; }

    /// <summary>A downloaded release waiting for this process to exit.</summary>
    string? PendingVersion { get; }

    /// <summary>
    /// The most recent check, or <see langword="null"/> if none has finished.
    /// </summary>
    /// <remarks>
    /// "Nothing was staged" and "the check has not come back" look identical
    /// without this — to an app deciding whether to show a prompt, and to a test
    /// waiting for a verdict, which otherwise waits out its whole timeout on
    /// every negative case.
    /// </remarks>
    NativeUpdateCheckResult? LastCheck { get; }

    /// <summary>Checks the feed now. Never throws for a network failure.</summary>
    Task<NativeUpdateCheckResult> CheckNowAsync(CancellationToken ct = default);

    /// <summary>
    /// Hands the downloaded release to Velopack's updater, which waits for this
    /// process to exit and then swaps the app. Does nothing if no release has
    /// been downloaded.
    /// </summary>
    bool ApplyOnExit();
}

public enum NativeUpdateOutcome
{
    /// <summary>Nothing newer, or nothing to check.</summary>
    NoUpdate,

    /// <summary>A newer release was downloaded and is waiting.</summary>
    Downloaded,

    /// <summary>The check could not be completed.</summary>
    Failed,
}

/// <param name="Outcome">What happened.</param>
/// <param name="Reason">One line, safe to log.</param>
/// <param name="Version">The version that was found, when one was.</param>
public sealed record NativeUpdateCheckResult(NativeUpdateOutcome Outcome, string Reason, string? Version = null);

/// <summary>
/// Ties Velopack's <see cref="UpdateManager"/> to the app lifecycle: resolve the
/// feed, look for a newer release in the background, and let the updater apply
/// it when the app exits.
/// </summary>
/// <remarks>
/// Deliberately thin. Velopack owns the download, the delta, the staging and the
/// swap; Vidra owns none of it. What is here is the configuration precedence and
/// the rule that a failure to update must never be a failure to run.
/// </remarks>
internal sealed class VidraNativeUpdateService(VidraNativeUpdateOptions options) : IVidraNativeUpdates
{
    private NativeUpdateSettings? _resolved;
    private UpdateManager? _manager;
    private UpdateInfo? _downloaded;

    /// <remarks>
    /// Read off the locator rather than the <see cref="UpdateManager"/>: what is
    /// installed is a fact about this process's own directory, and asking it
    /// should not require a feed URL, a resolved config, or a network stack.
    /// </remarks>
    public bool IsInstalled => Locator?.CurrentlyInstalledVersion is not null;

    public string? CurrentVersion => Locator?.CurrentlyInstalledVersion?.ToString();

    public string? PendingVersion => _downloaded?.TargetFullRelease?.Version?.ToString()
        ?? _manager?.UpdatePendingRestart?.Version?.ToString();

    /// <summary>
    /// Vidra's locator where the platform needs one (Mac Catalyst), and the
    /// process-wide one <c>VelopackApp.Run()</c> installed otherwise.
    /// </summary>
    private static IVelopackLocator? Locator
        => VidraNativeUpdates.Locator ?? (VelopackLocator.IsCurrentSet ? VelopackLocator.Current : null);

    public NativeUpdateCheckResult? LastCheck { get; private set; }

    public async Task<NativeUpdateCheckResult> CheckNowAsync(CancellationToken ct = default)
    {
        var settings = await ResolveAsync().ConfigureAwait(false);

        if (settings.Enabled == false)
            return Record(new(NativeUpdateOutcome.NoUpdate, "native updates are disabled"));

        if (string.IsNullOrWhiteSpace(settings.FeedUrl))
            return Record(new(NativeUpdateOutcome.NoUpdate, "no native update feed is configured"));

        var manager = Manager();
        if (manager is null)
            return Record(new(NativeUpdateOutcome.Failed, _managerError ?? "no update manager"));

        if (!IsInstalled)
        {
            // The normal case for a development run, and for anyone who
            // unzipped the portable archive rather than installing. Not an
            // error, and not worth alarming anyone about.
            return Record(new(NativeUpdateOutcome.NoUpdate, "not running from an installed build"));
        }

        try
        {
            var update = await manager.CheckForUpdatesAsync().ConfigureAwait(false);
            if (update is null)
                return Record(new(NativeUpdateOutcome.NoUpdate, $"{manager.CurrentVersion} is the newest release"));

            var version = update.TargetFullRelease?.Version?.ToString();
            await manager.DownloadUpdatesAsync(update, cancelToken: ct).ConfigureAwait(false);
            _downloaded = update;

            if (options.ApplyOnExit)
                ApplyOnExit();

            return Record(new(NativeUpdateOutcome.Downloaded, $"downloaded {version}; it applies on the next launch", version));
        }
        catch (Exception ex)
        {
            return Record(new(NativeUpdateOutcome.Failed, $"{ex.GetType().Name}: {ex.Message}"));
        }
    }

    public bool ApplyOnExit()
    {
        var update = _downloaded;
        var manager = Manager();
        if (update?.TargetFullRelease is null || manager is null)
            return false;

        try
        {
            // `restart: false` on purpose: the app is still running and owns
            // its own shutdown. Velopack's updater waits for this process to
            // exit before it touches anything.
            manager.WaitExitThenApplyUpdates(update.TargetFullRelease, silent: true, restart: false);
            return true;
        }
        catch (Exception ex)
        {
            Log($"could not stage the update ({ex.Message}); this launch is unaffected");
            return false;
        }
    }

    /// <summary>
    /// Runs shortly after launch. Fire and forget: startup must not wait on the
    /// network, and whatever this finds is for the next launch anyway.
    /// </summary>
    public async Task RunStartupCheckAsync(CancellationToken ct = default)
    {
        if (!options.CheckOnStartup)
            return;

        var settings = await ResolveAsync().ConfigureAwait(false);

        // An app that never configured a feed says nothing at all. Logging "no
        // update feed" on every launch of every app would train people to
        // ignore the line that matters.
        if (settings.Enabled == false || string.IsNullOrWhiteSpace(settings.FeedUrl))
            return;

        try
        {
            await Task.Delay(StartupDelay(), ct).ConfigureAwait(false);
            var result = await CheckNowAsync(ct).ConfigureAwait(false);
            Log(result.Reason);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log($"startup check failed: {ex.Message}");
        }
    }

    private string? _managerError;

    /// <summary>
    /// Built once, lazily, and never allowed to throw out of a property.
    /// </summary>
    /// <remarks>
    /// The failure worth naming is the one an app hits by forgetting a single
    /// line: without <c>VelopackApp.Build().Run()</c> in <c>Main</c> there is no
    /// process-wide locator, and <see cref="UpdateManager"/>'s constructor says
    /// so in a message about interfaces rather than about the missing line.
    /// </remarks>
    private UpdateManager? Manager()
    {
        if (_manager is not null || _managerError is not null)
            return _manager;

        var settings = _resolved;
        if (settings is null || string.IsNullOrWhiteSpace(settings.FeedUrl))
            return null;

        try
        {
            _manager = new UpdateManager(
                settings.FeedUrl,
                new UpdateOptions { ExplicitChannel = settings.Channel },
                Locator);
        }
        catch (Exception ex)
        {
            _managerError = VelopackLocator.IsCurrentSet
                ? $"{ex.GetType().Name}: {ex.Message}"
                : "the app's Main never called VelopackApp.Build().UseVidraLocator().Run()";
            Log(_managerError);
        }

        return _manager;
    }

    /// <summary>
    /// Code, then environment, then the file <c>vidra build</c> stamped in.
    /// Resolved once — the answer cannot change while the process runs, and a
    /// per-check read would mean a package-file open on every timer tick.
    /// </summary>
    private async Task<NativeUpdateSettings> ResolveAsync()
    {
        if (_resolved is not null)
            return _resolved;

        _resolved = NativeUpdateConfig.Resolve(
            options.AsSettings(),
            NativeUpdateConfig.FromEnvironment(),
            NativeUpdateConfig.ParseStampedFile(await ReadStampedConfigAsync().ConfigureAwait(false)));

        return _resolved;
    }

    private static async Task<string?> ReadStampedConfigAsync()
    {
        try
        {
            if (!await FileSystem.AppPackageFileExistsAsync(NativeUpdateConfig.ConfigFileName).ConfigureAwait(false))
                return null;

            await using var stream = await FileSystem
                .OpenAppPackageFileAsync(NativeUpdateConfig.ConfigFileName)
                .ConfigureAwait(false);

            using var reader = new StreamReader(stream);
            return await reader.ReadToEndAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log($"could not read {NativeUpdateConfig.ConfigFileName} ({ex.Message}); using the options set in code");
            return null;
        }
    }

    private TimeSpan StartupDelay()
        => int.TryParse(
            Environment.GetEnvironmentVariable(VidraNativeUpdateOptions.StartupDelayEnvironmentVariable),
            out var seconds) && seconds >= 0
                ? TimeSpan.FromSeconds(seconds)
                : options.StartupDelay;

    private NativeUpdateCheckResult Record(NativeUpdateCheckResult result)
    {
        LastCheck = result;
        return result;
    }

    private static void Log(string message)
    {
        Console.WriteLine($"[vidra] native update: {message}");
        Console.Out.Flush();
    }
}
