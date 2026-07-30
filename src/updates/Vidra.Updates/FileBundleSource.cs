namespace Vidra.Updates;

/// <summary>
/// Reads a feed from a directory — a mounted share, a USB stick, a test fixture.
/// </summary>
public sealed class FileBundleSource : IBundleSource
{
    private readonly string _root;
    private readonly string _manifestPath;

    /// <param name="path">Either the directory holding <c>bundles.json</c>, or the file itself.</param>
    public FileBundleSource(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        var full = Path.GetFullPath(path);
        if (Directory.Exists(full))
        {
            _root = full;
            _manifestPath = Path.Combine(full, "bundles.json");
        }
        else
        {
            _manifestPath = full;
            _root = Path.GetDirectoryName(full)
                ?? throw new ArgumentException($"'{path}' has no containing directory", nameof(path));
        }
    }

    public string Description => _manifestPath;

    public Task<string> GetManifestAsync(CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        return File.ReadAllTextAsync(_manifestPath, ct);
    }

    public Task<Stream> OpenBundleAsync(string url, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(url);
        ct.ThrowIfCancellationRequested();

        var path = Path.IsPathRooted(url) ? url : Path.Combine(_root, url);
        var full = Path.GetFullPath(path);

        // A feed is untrusted input even on a local disk: "../../../etc/passwd"
        // as a url must not read outside the directory the feed lives in.
        if (!Path.IsPathRooted(url)
            && !full.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new BundleVerificationException($"bundle url '{url}' escapes the feed directory");
        }

        return Task.FromResult<Stream>(File.OpenRead(full));
    }
}
