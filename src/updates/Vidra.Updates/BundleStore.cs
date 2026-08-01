namespace Vidra.Updates;

/// <summary>
/// The on-disk layout: where bundles live, and how state is read and written.
/// </summary>
/// <remarks>
/// Everything sits under a <c>vidra/</c> directory inside app data, which is not
/// decoration: on Mac Catalyst <c>FileSystem.AppDataDirectory</c> is
/// <c>$HOME/Library</c> itself — the Developer ID build is unsandboxed — so an
/// unscoped <c>bundles/</c> would litter the user's Library root. On Windows app
/// data is already per-app.
/// </remarks>
public sealed class BundleStore
{
    public BundleStore(string appDataDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(appDataDirectory);

        RootDirectory = Path.Combine(Path.GetFullPath(appDataDirectory), "vidra", "bundles");
        StatePath = Path.Combine(RootDirectory, "state.json");
    }

    /// <summary><c>&lt;app data&gt;/vidra/bundles</c>.</summary>
    public string RootDirectory { get; }

    public string StatePath { get; }

    public string BundleDirectory(string sha256)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sha256);

        // The name comes from a manifest, so it is untrusted until proven to be
        // a hash. Anything else could be a path.
        if (!IsSha256(sha256))
            throw new BundleVerificationException($"'{sha256}' is not a sha256 digest");

        return Path.Combine(RootDirectory, sha256.ToLowerInvariant());
    }

    public static bool IsSha256(string value)
    {
        if (value.Length != 64) return false;

        foreach (var c in value)
        {
            var isHex = c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';
            if (!isHex) return false;
        }

        return true;
    }

    public void EnsureCreated() => Directory.CreateDirectory(RootDirectory);

    public UpdateState LoadState()
    {
        try
        {
            return File.Exists(StatePath) ? UpdateState.Parse(File.ReadAllText(StatePath)) : UpdateState.Empty;
        }
        catch (IOException)
        {
            return UpdateState.Empty;
        }
        catch (UnauthorizedAccessException)
        {
            return UpdateState.Empty;
        }
    }

    /// <summary>
    /// Writes state through a temporary file and a rename, so a process that dies
    /// mid-write leaves the previous state intact rather than a truncated file.
    /// </summary>
    public void SaveState(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        EnsureCreated();
        var temporary = StatePath + ".tmp";
        File.WriteAllText(temporary, state.ToJson());
        File.Move(temporary, StatePath, overwrite: true);
    }

    /// <summary>
    /// Resolves the directory that should serve, or <see langword="null"/> for the
    /// embedded copy. A referenced bundle that is missing or incomplete resolves
    /// to <see langword="null"/> too — the embedded copy is always installable,
    /// so there is never a reason to show a blank window.
    /// </summary>
    public string? ResolveAssetRoot(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        if (state.Current is not { } sha)
            return null;

        try
        {
            var directory = BundleDirectory(sha);
            return File.Exists(Path.Combine(directory, "index.html")) ? directory : null;
        }
        catch (BundleVerificationException)
        {
            return null;
        }
    }

    /// <summary>
    /// Removes bundle directories and download leftovers that no state field
    /// references. Returns what it deleted.
    /// </summary>
    public IReadOnlyList<string> Prune(UpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);

        if (!Directory.Exists(RootDirectory))
            return [];

        var live = UpdateLifecycle.LiveBundles(state);
        var removed = new List<string>();

        foreach (var directory in Directory.GetDirectories(RootDirectory))
        {
            var name = Path.GetFileName(directory);
            var isLeftover = name.StartsWith(".staging-", StringComparison.Ordinal);

            if (!isLeftover && live.Contains(name, StringComparer.OrdinalIgnoreCase))
                continue;

            // Anything else in here is either a superseded bundle or debris from
            // an interrupted install; neither is referenced, so neither is served.
            try
            {
                Directory.Delete(directory, recursive: true);
                removed.Add(name);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        foreach (var file in Directory.GetFiles(RootDirectory, ".download-*.zip"))
        {
            try
            {
                File.Delete(file);
            }
            catch (IOException)
            {
            }
        }

        return removed;
    }
}
