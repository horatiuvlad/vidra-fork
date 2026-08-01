using System.Net;
using Velopack.Sources;

namespace Vidra.Updates.Native;

/// <summary>
/// Velopack's downloader, minus the one setting Mac Catalyst refuses.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="HttpClientFileDownloader"/> builds its handler with
/// <c>MaxAutomaticRedirections = 10</c>. On Catalyst <see cref="HttpClientHandler"/>
/// is backed by <c>NSUrlSessionHandler</c>, whose limit is effectively unbounded
/// and which refuses to have it lowered:
/// </para>
/// <code>
/// ArgumentOutOfRangeException: It's not possible to lower the max number of
/// automatic redirections.
/// </code>
/// <para>
/// Measured in a packaged Catalyst app: the locator worked, the app reported
/// itself installed at the right version, and then the very first request to
/// the feed threw before a byte moved. This is the second thing Velopack does
/// that assumes a platform it never claimed to support, and — like the locator
/// — it is fixed through an extension point they made <c>virtual</c> on purpose.
/// </para>
/// <para>
/// Everything else about the handler is theirs, deliberately: redirects are
/// still followed, and the same decompression is still negotiated. Only the
/// cap is dropped, and dropping it is what Catalyst does anyway.
/// </para>
/// </remarks>
public sealed class VidraCatalystDownloader : HttpClientFileDownloader
{
    /// <inheritdoc />
    protected override HttpClientHandler CreateHttpClientHandler() => CreateHandler();

    /// <summary>
    /// The handler this downloader uses. Public so a test can assert the one
    /// thing that matters about it — that nothing touches
    /// <see cref="HttpClientHandler.MaxAutomaticRedirections"/>.
    /// </summary>
    public static HttpClientHandler CreateHandler()
        => new()
        {
            AllowAutoRedirect = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        };
}
