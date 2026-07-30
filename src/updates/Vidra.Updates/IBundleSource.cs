namespace Vidra.Updates;

/// <summary>
/// Where bundles come from.
/// </summary>
/// <remarks>
/// One method more than strictly necessary — fetch the index, fetch an archive —
/// and deliberately no notion of releases, channels or providers. Velopack needs
/// an adapter per host because its client discovers releases through someone
/// else's API; a Vidra feed is an index we publish ourselves at a URL we choose,
/// so every static host (S3, Blob, B2, a CDN, nginx, a file share) collapses into
/// the two implementations here.
/// </remarks>
public interface IBundleSource
{
    /// <summary>Human-readable origin, for logs and errors.</summary>
    string Description { get; }

    /// <summary>Fetches the raw <c>bundles.json</c> document.</summary>
    Task<string> GetManifestAsync(CancellationToken ct = default);

    /// <summary>
    /// Opens a bundle archive for reading. <paramref name="url"/> is the entry's
    /// <c>url</c>, which may be relative to the manifest.
    /// </summary>
    Task<Stream> OpenBundleAsync(string url, CancellationToken ct = default);
}
